import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { isPluginChatComplete } from "./plugins.svelte";
import {
  isPluginCharacterDetailsLoaded,
  isPluginChatSettingsLoaded,
  markPluginChatSnapshot,
  pinPluginChatIdentity,
  PLUGIN_CHAT_IDENTITY_ERROR,
  PLUGIN_PARTIAL_HISTORY_WRITE_ERROR,
  writePluginChatToSlot,
} from "./pluginChatAccess";
import {
  getSqlPosition,
  getSqlWindow,
  setSqlPosition,
  setSqlWindow,
  type SqlHydrationWindow,
} from "../storage/sql/sqlRuntimeWindow";

/**
 * `isPluginChatComplete` decides whether a plugin may replace a chat's message
 * array; `isPluginChatSettingsLoaded` decides whether it is handed the chat at
 * all.
 *
 * The stakes are the reason the first consults the hydration window: a plugin
 * handed a partially resident chat, that then writes the chat back wholesale,
 * replaces the persisted history with the resident window. The rest is gone.
 * `writePluginChatToSlot` is what keeps that from happening without also
 * refusing the lorebook or binding write the plugin actually came for.
 *
 * The window is symbol-keyed runtime state, so this asserts against the real
 * accessor and the real predicate. A test that hand-built a `_sqlWindow`
 * property would pass while production answered "complete" for every partially
 * loaded chat.
 *
 * `.svelte.test.ts` so the runes compile: the chat is a real `$state` proxy.
 */

const partialWindow: SqlHydrationWindow = {
  before: null, nextBefore: 360, total: 400, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 400,
};

describe("chats offered to plugins", () => {
  test("a chat whose older messages are still in storage is refused", () => {
    const resident = $state({
      id: "chat-1", message: [{ chatId: "m-360" }],
      messagesLoaded: true, messagesFullyLoaded: true,
    });

    expect(isPluginChatComplete(resident)).toBe(true);

    setSqlWindow(resident, partialWindow);
    expect(isPluginChatComplete(resident)).toBe(false);

    setSqlWindow(resident, { ...partialWindow, hasOlder: false });
    expect(isPluginChatComplete(resident)).toBe(true);
  });

  test("a chat whose newest messages were released is refused too", () => {
    // Residency trimming releases the newest end once the user has paged far
    // enough back, and by then nothing is older. The flags are left saying
    // "loaded" on purpose: this pins the window predicate rather than passing
    // on `messagesFullyLoaded === false`, which trimming also clears. A plugin
    // handed this slice and writing it back replaces the persisted history with
    // a window missing the end of the conversation.
    const trimmed = $state({
      id: "chat-1", message: [{ chatId: "m-100" }],
      messagesLoaded: true, messagesFullyLoaded: true,
    });
    setSqlWindow(trimmed, {
      before: null, nextBefore: null, total: 400, hasOlder: false, hasNewer: true,
      nextAfter: 279, nextPosition: 400,
    });

    expect(isPluginChatComplete(trimmed)).toBe(false);
  });

  test("the checks for a chat that was never hydrated still stand on their own", () => {
    // No window is "no evidence", not "nothing older". These are the flags
    // that catch a slot which never held messages in the first place.
    expect(isPluginChatComplete(null)).toBe(false);
    expect(isPluginChatComplete({ _stub: true })).toBe(false);
    expect(isPluginChatComplete({ message: [], _placeholder: true })).toBe(false);
    expect(isPluginChatComplete({ message: [], messagesLoaded: false })).toBe(false);
    expect(isPluginChatComplete({ message: [], messagesFullyLoaded: false })).toBe(false);
    expect(isPluginChatComplete({ message: [] })).toBe(true);
  });
});

describe("a chat whose own settings have not been read", () => {
  test("is refused even when its whole history is resident", () => {
    // The bootstrap summary shape: the four real columns on `chats`, a fully
    // loaded message list, and none of `localLore`, `fmIndex`, the
    // persona/preset bindings, the memory data or the script state -- all of
    // which live in `chat_extension_nodes` and arrive only on hydration. A
    // plugin handed this reads an empty lorebook and no bindings on a chat that
    // has both.
    const summary = $state({
      id: "chat-1", name: "Chat 0", note: "", message: [{ chatId: "m-0" }],
      messagesLoaded: true, messagesFullyLoaded: true,
      detailsLoaded: false,
    });

    expect(isPluginChatComplete(summary)).toBe(false);
    expect(isPluginChatSettingsLoaded(summary)).toBe(false);

    summary.detailsLoaded = true;
    expect(isPluginChatComplete(summary)).toBe(true);
    expect(isPluginChatSettingsLoaded(summary)).toBe(true);
  });

  test("a chat created in this session, which never had the flag, is allowed", () => {
    const fresh = $state({
      id: "chat-2", name: "New chat", note: "", localLore: [], message: [],
      messagesLoaded: true, messagesFullyLoaded: true,
    });

    expect(isPluginChatComplete(fresh)).toBe(true);
  });
});

describe("a chat whose messages are a window", () => {
  // The shape a long conversation has after it opens on its newest page: the
  // settings are here, the resident array holds 40 of 400 messages, and the
  // window says so.
  const windowedChat = () => {
    const chat = $state({
      id: "chat-1", name: "Long chat", note: "", localLore: [] as any[], bindedPersona: "",
      message: [{ chatId: "m-360", role: "user", data: "older" }, { chatId: "m-361", role: "char", data: "newest" }],
      messagesLoaded: true, messagesFullyLoaded: true, detailsLoaded: true,
    });
    setSqlWindow(chat, partialWindow);
    setSqlPosition(chat.message[0], 360);
    setSqlPosition(chat.message[1], 361);
    return chat;
  };

  test("is offered, and the snapshot says its messages are a window", () => {
    const chat = windowedChat();
    expect(isPluginChatSettingsLoaded(chat)).toBe(true);
    expect(isPluginChatComplete(chat)).toBe(false);

    // `$state.snapshot` drops the symbol-keyed window, which is why the
    // marking has to read the live chat: on the snapshot alone the window
    // looks whole.
    const snapshot = markPluginChatSnapshot(chat, $state.snapshot(chat)) as any;
    expect(getSqlWindow(snapshot)).toBeUndefined();
    expect(snapshot.messagesFullyLoaded).toBe(false);
    expect(snapshot.messageTotal).toBe(400);
    expect(snapshot.message).toHaveLength(2);
    expect(snapshot._pluginReadTail).toBe("m-361");
    // The live chat is not touched by the marking.
    expect(chat.messagesFullyLoaded).toBe(true);
    expect("_pluginReadTail" in chat).toBe(false);
  });

  test("a snapshot of a whole chat only learns where its history ended", () => {
    const whole = $state({ id: "chat-2", message: [{ chatId: "m-0" }], messagesFullyLoaded: true });
    const snapshot = markPluginChatSnapshot(whole, $state.snapshot(whole)) as any;
    expect(snapshot.messagesFullyLoaded).toBe(true);
    expect("messageTotal" in snapshot).toBe(false);
    expect(snapshot._pluginReadTail).toBe("m-0");

    const empty = $state({ id: "chat-3", message: [] as any[] });
    expect((markPluginChatSnapshot(empty, $state.snapshot(empty)) as any)._pluginReadTail).toBe("");
  });

  test("writing it back with its messages untouched applies the settings and keeps the window", () => {
    const chats = $state([windowedChat()]);
    const before = chats[0];
    const originalMessages = before.message;

    // What a plugin does: snapshot, edit a binding and the lorebook, write
    // back. The message array is the copy it was handed, echoed unchanged,
    // and so are the runtime flags it could not know were the host's.
    const incoming = markPluginChatSnapshot(before, $state.snapshot(before)) as any;
    incoming.bindedPersona = "persona-binder-temp-persona";
    incoming.localLore = [{ key: "", comment: "[PersonaBinder]", content: "{\"version\":1}", mode: "normal", insertorder: 100, alwaysActive: true, secondkey: "", selective: false }];
    incoming.note = "edited by plugin";

    const live = writePluginChatToSlot(chats, 0, incoming);

    expect(live).toBe(chats[0]);
    expect(live.bindedPersona).toBe("persona-binder-temp-persona");
    expect(live.localLore).toHaveLength(1);
    expect(live.localLore[0].comment).toBe("[PersonaBinder]");
    expect(live.note).toBe("edited by plugin");
    // The window, the resident array and the message positions survive: the
    // slice is still a slice, and the appended-reply path still has its
    // `nextPosition`.
    expect(getSqlWindow(live)).toEqual(partialWindow);
    expect(getSqlWindow(live)?.hasOlder).toBe(true);
    expect(live.message).toBe(originalMessages);
    expect(getSqlPosition(live.message[0])).toBe(360);
    expect(getSqlPosition(live.message[1])).toBe(361);
    expect(live.messagesFullyLoaded).toBe(true);
    expect(live.messagesLoaded).toBe(true);
    expect(live.detailsLoaded).toBe(true);
    // The snapshot-only fields never land on the live chat.
    expect("messageTotal" in live).toBe(false);
    expect("_pluginReadTail" in live).toBe(false);
    expect(isPluginChatComplete(live)).toBe(false);
  });

  test("a copy of the window still lands after the host paged or replied around it", () => {
    // Between the read and the write the user scrolled up (an older page was
    // prepended) and a reply arrived (appended). The copy is the window as it
    // was, one contiguous run of the live ids, and the settings write it
    // carries is the one the plugin came for.
    const chats = $state([windowedChat()]);
    const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
    copy.localLore = [{ key: "", comment: "[PersonaBinder]", content: "{}", mode: "normal", insertorder: 100, alwaysActive: true, secondkey: "", selective: false }];

    chats[0].message.unshift({ chatId: "m-359", role: "char", data: "paged in" });
    chats[0].message.push({ chatId: "m-362", role: "char", data: "replied" });
    const liveMessages = chats[0].message;

    const live = writePluginChatToSlot(chats, 0, copy);
    expect(live.localLore).toHaveLength(1);
    expect(live.message).toBe(liveMessages);
    expect(live.message.map((m) => m.chatId)).toEqual(["m-359", "m-360", "m-361", "m-362"]);
    expect(getSqlWindow(live)).toEqual(partialWindow);
  });

  test("a copy that was a window is merged even once the live chat has become whole", () => {
    // The user scrolled to the top while the plugin was busy: the older page
    // arrived and the window closed. The plugin's copy still says it was a
    // window, so it is not installed over the now-resident history -- which
    // would have left 40 of 80 messages and a window that says nothing is
    // older.
    const chats = $state([windowedChat()]);
    const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
    expect(copy.messagesFullyLoaded).toBe(false);
    copy.bindedPersona = "persona-binder-temp-persona";

    chats[0].message.unshift({ chatId: "m-0", role: "user", data: "the first message" });
    setSqlWindow(chats[0], { ...partialWindow, hasOlder: false, nextBefore: null, before: null });
    expect(isPluginChatComplete(chats[0])).toBe(true);
    const liveMessages = chats[0].message;

    const live = writePluginChatToSlot(chats, 0, copy);
    expect(live.bindedPersona).toBe("persona-binder-temp-persona");
    expect(live.message).toBe(liveMessages);
    expect(live.message).toHaveLength(3);
    expect(live.messagesFullyLoaded).toBe(true);
    expect(getSqlWindow(live)?.hasOlder).toBe(false);
    expect(isPluginChatComplete(live)).toBe(true);
  });

  test("a message array that no longer matches the window is refused and nothing changes", () => {
    const chats = $state([windowedChat()]);
    const before = chats[0];
    const originalMessages = before.message;

    // A window is never edited through a plugin, so the test is whether the
    // copy's ids are one run of the live ones: a message removed from the
    // middle, a reorder, an addition, or an id the window does not hold.
    before.message.push({ chatId: "m-362", role: "user", data: "third" });
    const holed = $state.snapshot(before) as any;
    holed.bindedPersona = "should-not-land";
    holed.message.splice(1, 1);
    expect(() => writePluginChatToSlot(chats, 0, holed)).toThrow(PLUGIN_PARTIAL_HISTORY_WRITE_ERROR);

    const foreign = $state.snapshot(before) as any;
    foreign.bindedPersona = "should-not-land";
    foreign.message[0] = { ...foreign.message[0], chatId: "m-elsewhere" };
    expect(() => writePluginChatToSlot(chats, 0, foreign)).toThrow(PLUGIN_PARTIAL_HISTORY_WRITE_ERROR);

    const reordered = $state.snapshot(before) as any;
    reordered.bindedPersona = "should-not-land";
    reordered.message.reverse();
    expect(() => writePluginChatToSlot(chats, 0, reordered)).toThrow(PLUGIN_PARTIAL_HISTORY_WRITE_ERROR);

    const appended = $state.snapshot(before) as any;
    appended.bindedPersona = "should-not-land";
    appended.message.push({ chatId: "m-new", role: "char", data: "from plugin" });
    expect(() => writePluginChatToSlot(chats, 0, appended)).toThrow(PLUGIN_PARTIAL_HISTORY_WRITE_ERROR);

    expect(chats[0]).toBe(before);
    expect(chats[0].bindedPersona).toBe("");
    expect(chats[0].message).toBe(originalMessages);
    expect(chats[0].message).toHaveLength(3);
    expect(getSqlWindow(chats[0])).toEqual(partialWindow);
  });

  test("a whole chat is still replaced wholesale, carrying its runtime marks", () => {
    const chat = $state({
      id: "chat-3", name: "", note: "", localLore: [] as any[],
      message: [{ chatId: "m-0", role: "user", data: "hi" }],
      messagesLoaded: true, messagesFullyLoaded: true,
    });
    setSqlWindow(chat, { ...partialWindow, hasOlder: false, total: 1, nextBefore: null, nextPosition: 1 });
    setSqlPosition(chat.message[0], 0);
    const chats = $state([chat]);

    const incoming = $state.snapshot(chat) as any;
    incoming.message[0].data = "edited";
    incoming.message.push({ chatId: "m-1", role: "char", data: "added" });

    const live = writePluginChatToSlot(chats, 0, incoming);
    expect(live.message).toHaveLength(2);
    expect(live.message[0].data).toBe("edited");
    expect(getSqlPosition(live.message[0])).toBe(0);
    // A message the plugin added is left for `allocateAppendedPositions`.
    expect(getSqlPosition(live.message[1])).toBeUndefined();
    expect(getSqlWindow(live)?.nextPosition).toBe(1);
  });

  describe("a whole chat the user sent to while the plugin held a copy", () => {
    const wholeChat = () => {
      const chat = $state({
        id: "chat-5", name: "", note: "", localLore: [] as any[], bindedPersona: "",
        message: [{ chatId: "m-0", role: "user", data: "hi" }, { chatId: "m-1", role: "char", data: "hello" }],
        messagesLoaded: true, messagesFullyLoaded: true,
      });
      setSqlWindow(chat, { ...partialWindow, hasOlder: false, total: 2, nextBefore: null, nextPosition: 2 });
      setSqlPosition(chat.message[0], 0);
      setSqlPosition(chat.message[1], 1);
      return chat;
    };

    test("keeps the message the user typed and applies the rest", () => {
      // The bundled plugin's write sits behind a model call. The user hits
      // send meanwhile; the UI pushes the message and nothing has persisted
      // it yet. A stale copy installed over the slot would remove it from
      // memory, and the dirty mark for it would then find nothing to write.
      const chats = $state([wholeChat()]);
      const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      expect(copy._pluginReadTail).toBe("m-1");
      copy.bindedPersona = "persona-binder-temp-persona";
      copy.localLore = [{ key: "", comment: "[PersonaBinder]", content: "{}", mode: "normal", insertorder: 100, alwaysActive: true, secondkey: "", selective: false }];

      chats[0].message.push({ chatId: "m-2", role: "user", data: "typed meanwhile" });
      const liveMessages = chats[0].message;

      const live = writePluginChatToSlot(chats, 0, copy);
      expect(live.bindedPersona).toBe("persona-binder-temp-persona");
      expect(live.localLore).toHaveLength(1);
      expect(live.message).toBe(liveMessages);
      expect(live.message.map((m) => m.chatId)).toEqual(["m-0", "m-1", "m-2"]);
      expect(getSqlPosition(live.message[0])).toBe(0);
      expect(getSqlWindow(live)?.nextPosition).toBe(2);
      expect("_pluginReadTail" in live).toBe(false);
    });

    test("an empty chat the user started meanwhile is the same case", () => {
      const chat = $state({ id: "chat-6", name: "", note: "", localLore: [] as any[], message: [] as any[], messagesLoaded: true, messagesFullyLoaded: true });
      const chats = $state([chat]);
      const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      copy.note = "bound";
      chats[0].message.push({ chatId: "m-0", role: "user", data: "first" });

      const live = writePluginChatToSlot(chats, 0, copy);
      expect(live.note).toBe("bound");
      expect(live.message.map((m) => m.chatId)).toEqual(["m-0"]);
    });

    test("a plugin that edited the tail on purpose still gets its wholesale write", () => {
      // The tail mark is what tells the two apart: this copy ends somewhere
      // other than where the read did, so it is the plugin's rewrite (a
      // regenerate-style plugin popping the last reply) and it lands as
      // plugins have always expected -- even though it is shorter.
      const chats = $state([wholeChat()]);
      const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      copy.message.pop();
      const live = writePluginChatToSlot(chats, 0, copy);
      expect(live.message.map((m) => m.chatId)).toEqual(["m-0"]);

      // And a copy that never came from the host (no mark) is trusted as
      // before.
      const chats2 = $state([wholeChat()]);
      const rebuilt = { ...$state.snapshot(chats2[0]), message: [{ chatId: "m-0", role: "user", data: "only" }] } as any;
      chats2[0].message.push({ chatId: "m-2", role: "user", data: "typed" });
      expect(writePluginChatToSlot(chats2, 0, rebuilt).message.map((m) => m.chatId)).toEqual(["m-0"]);
    });
  });

  describe("the identity of the chat in the slot", () => {
    test("is pinned onto the copy, so a copy that dropped its id does not become a new chat", () => {
      // `normalizeChat` mints an id for a copy without one; the original id
      // would vanish from the character, the audit would read that as a
      // deletion and cascade the chat's persisted messages away.
      const chats = $state([windowedChat()]);
      const copy = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      delete copy.id;
      expect(pinPluginChatIdentity(chats[0], copy).id).toBe("chat-1");
      expect(writePluginChatToSlot(chats, 0, copy).id).toBe("chat-1");

      const again = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      delete again.id;
      expect(writePluginChatToSlot(chats, 0, again).id).toBe("chat-1");
    });

    test("a copy of another chat is refused before anything is written", () => {
      // The index shifted under the plugin: it read chat X at 0, the user
      // created a chat, and X's copy comes back to a slot that now holds Y.
      const x = windowedChat();
      const chats = $state([x]);
      const copyOfX = markPluginChatSnapshot(chats[0], $state.snapshot(chats[0])) as any;
      copyOfX.bindedPersona = "should-not-land";

      const y = $state({ id: "chat-y", name: "New chat", note: "", localLore: [] as any[], bindedPersona: "", message: [] as any[], messagesLoaded: true, messagesFullyLoaded: true, detailsLoaded: true });
      chats.unshift(y);

      expect(() => pinPluginChatIdentity(chats[0], copyOfX)).toThrow(PLUGIN_CHAT_IDENTITY_ERROR);
      expect(() => writePluginChatToSlot(chats, 0, copyOfX)).toThrow(PLUGIN_CHAT_IDENTITY_ERROR);
      expect(chats[0].id).toBe("chat-y");
      expect(chats[0].bindedPersona).toBe("");
      expect(chats[1].id).toBe("chat-1");
      expect(chats[1].bindedPersona).toBe("");
    });
  });

  test("a chat whose settings are not here is refused before anything is read", () => {
    const chats = $state([{ id: "chat-4", name: "Chat", note: "", message: [], detailsLoaded: false }]);
    expect(() => writePluginChatToSlot(chats, 0, { ...chats[0], detailsLoaded: true, note: "x" } as any)).toThrow("Chat history is still loading");
    expect(chats[0].note).toBe("");
  });
});

describe("the current chat index with an unhydrated sibling", () => {
  test("is a fact about the character, not about its siblings' history", () => {
    // The character record is here; chat 0 is the open one with a window and
    // chat 1 is a bootstrap summary that was never hydrated. The old gate
    // required every chat to be whole, so on any long conversation
    // `getCurrentChatIndex` answered -1 and the plugin reported "no chat".
    const character = $state({
      chaId: "char-1", detailsLoaded: true, chatPage: 0,
      chats: [
        { id: "chat-0", message: [{ chatId: "m-1" }], messagesLoaded: true, messagesFullyLoaded: true, detailsLoaded: true },
        { id: "chat-1", name: "Chat 1", note: "", message: [], _placeholder: true, messagesLoaded: false, messagesFullyLoaded: false, detailsLoaded: false },
      ],
    });
    setSqlWindow(character.chats[0], partialWindow);

    expect(isPluginCharacterDetailsLoaded(character)).toBe(true);
    expect(character.chats.every(isPluginChatComplete)).toBe(false);
    expect(isPluginCharacterDetailsLoaded({ ...character, detailsLoaded: false })).toBe(false);
    expect(isPluginCharacterDetailsLoaded({ chaId: "x", detailsLoaded: true })).toBe(false);

    const source = readFileSync("src/ts/plugins/apiV3/v3.svelte.ts", "utf8");
    expect(source).toMatch(/getCurrentChatIndex: \(\) => \{[\s\S]*?isPluginCharacterDetailsLoaded\(db\.characters\[charId\]\)\) return -1/);
    expect(source).toMatch(/getChatFromIndex:[\s\S]*?isPluginChatSettingsLoaded\(chats\[chatIndex\]\)\) return null/);
    expect(source).toMatch(/setChatToIndex:[\s\S]*?writePluginChatToSlot\(chats, chatIndex, normalizeChat\(\s*pinPluginChatIdentity\(chats\[chatIndex\],[\s\S]*?markSqlChatDirty\(character\.chaId, live\.id\)/);
    // Writing a character back still replaces every chat wholesale, so that
    // gate keeps asking for whole histories.
    expect(source).toMatch(/setCharacterToIndex:[\s\S]*?isPluginCharacterComplete\(db\.characters\[charId\]\)\) throw/);
  });
});
