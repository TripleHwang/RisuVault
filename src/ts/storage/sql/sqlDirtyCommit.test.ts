import { describe, expect, it, vi } from "vitest";

import type { DirtySnapshot } from "./dirtyRegistry";
import { buildSqlDirtyCommit } from "./sqlDirtyCommit";
import { applySqliteCommit } from "./sqliteCommit";
import { getSqlPosition, setSqlPosition, setSqlWindow } from "./sqlRuntimeWindow";

const cleanDirty = (): DirtySnapshot => ({
  rootKeys: [], characterIds: [], chats: [], messages: [],
  messageDeletes: [], pluginStorageKeys: [], presetIds: [],
});

function fixtureDatabaseWithMessages(count: number) {
  return {
    characters: [{ chaId: "character-a", chats: [{ id: "chat-a", message: Array.from({ length: count }, (_, position) => ({
      chatId: `m-${position}`, role: "char", data: `message-${position}`,
    })) }] }],
    botPresets: [], pluginCustomStorage: {},
  } as any;
}

describe("row-scoped SQL dirty commits", () => {
  it("serializes only a dirty message row in a 20,000-message chat", () => {
    const db = fixtureDatabaseWithMessages(20_000);
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-19999"] }];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.messages).toEqual([expect.objectContaining({ id: "m-19999", chatId: "chat-a", position: 19_999 })]);
    expect(commit.messageManifests).toEqual([]);
  });

  it("indexes a touched chat once for multiple dirty message IDs", () => {
    const db = fixtureDatabaseWithMessages(20_000);
    const messages = db.characters[0].chats[0].message;
    messages.findIndex = () => { throw new Error("per-message linear lookup is forbidden"); };
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-19998", "m-19999"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: "m-19998", position: 19_998 },
      { id: "m-19999", position: 19_999 },
    ]);
  });

  it("uses a delete list without sending siblings or a manifest", () => {
    const db = fixtureDatabaseWithMessages(3);
    const dirty = cleanDirty();
    dirty.messageDeletes = [{ chatId: "chat-a", messageIds: ["m-2"] }];
    db.characters[0].chats[0].message.pop();

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.messageDeletes).toEqual([{ chatId: "chat-a", ids: ["m-2"] }]);
    expect(commit.messageManifests).toEqual([]);
    expect(commit.messages).toEqual([]);
  });

  it("uses transient canonical positions for the hydrated tail instead of local indexes", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    setSqlPosition(chat.message[0], 3);
    setSqlPosition(chat.message[1], 4);
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-4"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-4", position: 4 }),
    ]);
  });

  it("uses canonical positions after prepending an older page", () => {
    const db = fixtureDatabaseWithMessages(6);
    const chat = db.characters[0].chats[0];
    chat.message = [chat.message[1], chat.message[2], chat.message[3], chat.message[4], chat.message[5]];
    chat.messagesFullyLoaded = false;
    for (const [index, message] of chat.message.entries()) {
      setSqlPosition(message, index + 1);
    }
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-1"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-1", position: 1 }),
    ]);
  });

  it("allocates a canonical position for a newly appended tail message", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    setSqlWindow(chat, { before: null, nextBefore: 4, total: 5, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 9 });
    setSqlPosition(chat.message[0], 4);
    setSqlPosition(chat.message[1], 8);
    chat.message.push({ chatId: "m-new", role: "char", data: "new" });
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-new"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messages).toEqual([
      expect.objectContaining({ id: "m-new", position: 9 }),
    ]);
    expect(getSqlPosition(chat.message[2])).toBe(9);
  });

  it("deletes a dirty chat that is no longer in memory by its own id, never by manifest", () => {
    const db = fixtureDatabaseWithMessages(1);
    db.characters[0].chats = [];
    const dirty = cleanDirty();
    dirty.chats = [{ characterId: "character-a", chatId: "chat-a" }];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.chatDeletes).toEqual([{ characterId: "character-a", id: "chat-a" }]);
    expect(commit.chatManifests).toEqual([]);
  });

  it("deletes nothing for a dirty chat that now lives under another character", () => {
    const db = fixtureDatabaseWithMessages(1);
    const [moved] = db.characters[0].chats.splice(0, 1);
    db.characters.push({ chaId: "character-b", chats: [moved] });
    const dirty = cleanDirty();
    dirty.chats = [
      { characterId: "character-a", chatId: "chat-a" },
      { characterId: "character-b", chatId: "chat-a" },
    ];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.chatDeletes).toEqual([]);
    expect(commit.chats).toEqual([expect.objectContaining({ id: "chat-a", characterId: "character-b" })]);
  });

  it("emits explicit character deletions instead of dropping a missing dirty character", () => {
    const db = fixtureDatabaseWithMessages(1);
    db.characters = [];
    const dirty = cleanDirty();
    dirty.characterIds = ["character-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).characterDeletes).toEqual(["character-a"]);
  });

  it("keeps a per-ID preset update row-scoped", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [{ id: "preset-a", position: 1, data: db.botPresets[1] }],
      deletes: [],
    });
  });

  it("reconciles the complete preset list only when the list root is dirty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresets"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [
        { id: "preset-b", position: 0, data: db.botPresets[0] },
        { id: "preset-a", position: 1, data: db.botPresets[1] },
      ],
      deletes: [],
      order: ["preset-b", "preset-a"],
      activeId: "preset-a",
    });
  });

  it("clears the preset order and active selection when the list is replaced with empty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [];
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresets"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: [], order: [], activeId: null,
    });
  });

  it("writes only the selected preset when the active preset root is dirty", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-a", name: "A" }, { id: "preset-b", name: "B" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresetsId"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: [], activeId: "preset-b",
    });
  });

  it("moves active selection while deleting a marked preset without rewriting order", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-b", name: "B" }];
    db.botPresetsId = 0;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-a"], activeId: "preset-b",
    });
  });

  it("clears active selection while deleting the last marked preset", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [];
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-a"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-a"], activeId: null,
    });
  });

  it("preserves the current active selection while deleting a non-active marked preset", () => {
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-a", name: "A" }];
    db.botPresetsId = 0;
    const dirty = cleanDirty();
    dirty.presetIds = ["preset-b"];

    expect(buildSqlDirtyCommit(db, dirty, 7).presets).toEqual({
      upserts: [], deletes: ["preset-b"], activeId: "preset-a",
    });
  });

  it("never emits a deletion manifest after residency trimming released the newest end", () => {
    // What trimming actually leaves behind: nothing older to load, the newest
    // end released. `messagesFullyLoaded` is left true on purpose so the
    // resident slice looks complete to anything that only checks the flag:
    // every released message would become a DELETE against a row still on
    // disk if a manifest were ever rewritten from it.
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(0, 2);
    chat.messagesLoaded = true;
    chat.messagesFullyLoaded = true;
    setSqlWindow(chat, {
      before: null, nextBefore: null, total: 5, hasOlder: false, hasNewer: true, nextAfter: 1, nextPosition: 5,
    });
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-0", "m-1"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messageManifests).toEqual([]);
  });

  it("never emits a deletion manifest for an incomplete message window", () => {
    const db = fixtureDatabaseWithMessages(5);
    const chat = db.characters[0].chats[0];
    chat.message = chat.message.slice(3);
    chat.messagesFullyLoaded = false;
    setSqlPosition(chat.message[0], 3);
    setSqlPosition(chat.message[1], 4);
    const dirty = cleanDirty();
    dirty.messages = [{ chatId: "chat-a", messageIds: ["m-3", "m-4"] }];

    expect(buildSqlDirtyCommit(db, dirty, 7).messageManifests).toEqual([]);
  });
});

describe("a tab whose in-memory copy is older than storage", () => {
  // The scenario behind the lost messages: the user chats on a phone, then
  // opens a PC tab that loaded the chat earlier. The PC tab's `chat.message`
  // lacks everything the phone wrote, and its parent character's chat list
  // lacks any chat the phone created. Whatever that tab commits must not be
  // able to delete a row it never saw. A manifest ("delete what is not in my
  // list") is exactly such a statement, so none may be built here, and no
  // explicit delete may name an id this tab did not mark itself.
  //
  // Asserted on the SQL the executor emits, not only on the commit object:
  // the executor is where a "NOT IN" would come back, and a builder-only
  // check would keep passing while it did.
  const unseenMessageId = "m-written-on-phone";
  const unseenChatId = "chat-created-on-phone";
  const unseenPresetId = "preset-made-on-phone";

  const deletesNaming = (commit: ReturnType<typeof buildSqlDirtyCommit>, id: string) => [
    ...(commit.messageDeletes ?? []).flatMap((entry) => entry.ids),
    ...(commit.chatDeletes ?? []).map((entry) => entry.id),
    ...commit.characterDeletes ?? [],
  ].filter((deleted) => deleted === id);

  const statementsOf = async (commit: ReturnType<typeof buildSqlDirtyCommit>) => {
    const statements: { sql: string; bind: unknown[] }[] = [];
    await applySqliteCommit(commit, (sql, bind = []) => { statements.push({ sql, bind }); });
    return statements;
  };

  // Every DELETE against a row table must name the rows it removes, one id
  // at a time or as an explicit IN list, and none of those ids may be one
  // this tab has not seen. Anything else -- NOT IN, a bare table wipe, a
  // delete scoped by parent only -- can reach the other device's rows.
  const expectRowDeletesName = (statements: { sql: string; bind: unknown[] }[], unseenId: string) => {
    expect(statements.filter(({ sql }) => /NOT IN/i.test(sql))).toEqual([]);
    const rowDeletes = statements.filter(({ sql }) => /^DELETE FROM (messages|chats|characters|bot_presets)\b/.test(sql.trim()));
    for (const { sql, bind } of rowDeletes) {
      expect(sql).toMatch(/\b(id|preset_id) (= \?|IN \()/);
      expect(bind).not.toContain(unseenId);
    }
    return rowDeletes;
  };

  it("emits no statement that can delete a message it never loaded", async () => {
    const db = fixtureDatabaseWithMessages(3);
    const chat = db.characters[0].chats[0];
    // Every edit that used to request a manifest: an append, a removal, a
    // reorder of the resident rows.
    chat.message.push({ chatId: "m-local", role: "user", data: "typed on the pc" });
    chat.message.splice(1, 1);
    chat.message.reverse();
    const dirty = cleanDirty();
    dirty.chats = [{ characterId: "character-a", chatId: "chat-a" }];
    dirty.messages = [{ chatId: "chat-a", messageIds: chat.message.map((message: any) => message.chatId) }];
    dirty.messageDeletes = [{ chatId: "chat-a", messageIds: ["m-1"] }];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.messageManifests).toEqual([]);
    expect(commit.chatManifests).toEqual([]);
    expect(commit.characterIds).toBeUndefined();
    expect(deletesNaming(commit, unseenMessageId)).toEqual([]);
    expect(commit.messageDeletes).toEqual([{ chatId: "chat-a", ids: ["m-1"] }]);

    const rowDeletes = expectRowDeletesName(await statementsOf(commit), unseenMessageId);
    expect(rowDeletes).toEqual([{ sql: "DELETE FROM messages WHERE chat_id = ? AND id IN (?)", bind: ["chat-a", "m-1"] }]);
  });

  it("emits no statement that can delete a chat it never loaded", async () => {
    const db = fixtureDatabaseWithMessages(1);
    // A chat created here and a chat deleted here, with the parent marked too.
    db.characters[0].chats.push({ id: "chat-local", message: [] });
    db.characters[0].chats.splice(0, 1);
    const dirty = cleanDirty();
    dirty.characterIds = ["character-a"];
    dirty.chats = [
      { characterId: "character-a", chatId: "chat-a" },
      { characterId: "character-a", chatId: "chat-local" },
    ];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.chatManifests).toEqual([]);
    expect(commit.characterIds).toBeUndefined();
    expect(deletesNaming(commit, unseenChatId)).toEqual([]);
    expect(commit.chatDeletes).toEqual([{ characterId: "character-a", id: "chat-a" }]);

    const rowDeletes = expectRowDeletesName(await statementsOf(commit), unseenChatId);
    expect(rowDeletes).toEqual([{ sql: "DELETE FROM chats WHERE id = ? AND character_id = ?", bind: ["chat-a", "character-a"] }]);
  });

  it("emits no statement that can delete a preset it never loaded", async () => {
    // The same hole through the preset list: adding, removing or reordering a
    // preset marks the list root dirty, and the list is only what this tab
    // holds. The removed preset is dirty by id (the audit marks every preset
    // that left the list), so the explicit delete is all a removal needs.
    const db = fixtureDatabaseWithMessages(0);
    db.botPresets = [{ id: "preset-d", name: "D" }, { id: "preset-a", name: "A" }];
    db.botPresetsId = 1;
    const dirty = cleanDirty();
    dirty.rootKeys = ["botPresets"];
    dirty.presetIds = ["preset-b", "preset-d"];

    const commit = buildSqlDirtyCommit(db, dirty, 7);

    expect(commit.presets).toEqual({
      upserts: [
        { id: "preset-d", position: 0, data: db.botPresets[0] },
        { id: "preset-a", position: 1, data: db.botPresets[1] },
      ],
      deletes: ["preset-b"],
      order: ["preset-d", "preset-a"],
      activeId: "preset-a",
    });
    const rowDeletes = expectRowDeletesName(await statementsOf(commit), unseenPresetId);
    expect(rowDeletes).toEqual([{ sql: "DELETE FROM bot_presets WHERE preset_id = ?", bind: ["preset-b"] }]);
  });
});

describe("a character that is still a bootstrap summary", () => {
  // The summary carries name, image, chat list and timestamps -- and no
  // description, first message, lorebook or scripts. Writing one back replaces
  // the stored record with it. This is reachable on an ordinary launch:
  // auditSqlCompatibilityDatabase marks EVERY character dirty when the
  // character order changes, summaries included, so a user who reorders loses
  // everything but the name of each character they had not opened yet.
  const summaryDatabase = () => ({
    characters: [{
      chaId: "character-1",
      name: "Alice",
      image: "assets/alice.png",
      detailsLoaded: false,
      chats: [],
      chatPage: 0,
    }],
    botPresets: [],
    pluginCustomStorage: {},
  }) as any;

  it("is never written back over the stored record", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const commit = buildSqlDirtyCommit(summaryDatabase(), {
      ...cleanDirty(), characterIds: ["character-1"],
    }, 1);

    expect(commit.characters).toEqual([]);
    expect(commit.characterDeletes ?? []).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is written normally once it has been hydrated", () => {
    const database = summaryDatabase();
    database.characters[0].detailsLoaded = true;
    database.characters[0].desc = "the description the summary does not carry";

    const commit = buildSqlDirtyCommit(database, {
      ...cleanDirty(), characterIds: ["character-1"],
    }, 1);

    expect(commit.characters).toHaveLength(1);
    expect((commit.characters[0].data as any).desc).toBe("the description the summary does not carry");
  });
});

describe("a chat that is still a bootstrap summary", () => {
  // The summary carries name, note, folder and last message time -- the four
  // real columns on `chats` -- and none of the per-chat settings, which all
  // live in `chat_extension_nodes`. `replaceNodes` DELETEs a chat's whole node
  // set before inserting what it is given, so writing a summary does not fail
  // to update those fields, it destroys them: the lorebook, the alternate
  // greeting index, the persona/preset bindings, the memory data, the script
  // state. Reachable without the user opening the chat at all, because the idle
  // compatibility audit marks chats dirty from a whole-database diff.
  const summaryDatabase = () => ({
    characters: [{
      chaId: "character-1",
      name: "Alice",
      chatPage: 0,
      chats: [{
        id: "chat-1",
        name: "Chat 0",
        note: "",
        message: [],
        messagesLoaded: false,
        detailsLoaded: false,
      }],
    }],
    botPresets: [],
    pluginCustomStorage: {},
  }) as any;

  const dirtyChat = () => ({
    ...cleanDirty(),
    chats: [{ characterId: "character-1", chatId: "chat-1" }],
  });

  it("is never written back over the stored settings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const commit = buildSqlDirtyCommit(summaryDatabase(), dirtyChat(), 1);

    expect(commit.chats).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("is reported to the caller so the mark can be retained and the chat loaded", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused: Array<[string, string]> = [];

    buildSqlDirtyCommit(summaryDatabase(), dirtyChat(), 1, undefined,
      (characterId, chatId) => { refused.push([characterId, chatId]); });

    expect(refused).toEqual([["character-1", "chat-1"]]);
    consoleError.mockRestore();
  });

  it("is neither deleted nor replaced by a manifest of its siblings", () => {
    // The refusal used to push the parent's chat manifest so a creation or
    // deletion in the same flush was still recorded. That manifest deleted
    // every chat of the character this tab did not know about, so it is not
    // an acceptable stand-in; a deletion is its own dirty mark now.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const commit = buildSqlDirtyCommit(summaryDatabase(), dirtyChat(), 1);

    expect(commit.chats).toEqual([]);
    expect(commit.chatDeletes).toEqual([]);
    expect(commit.chatManifests).toEqual([]);
    consoleError.mockRestore();
  });

  it("is written normally once its own fields have been hydrated", () => {
    const database = summaryDatabase();
    database.characters[0].chats[0].detailsLoaded = true;
    database.characters[0].chats[0].bindedPersona = "the persona a summary does not carry";
    database.characters[0].chats[0].localLore = [{ key: "per-chat-lore" }];

    const commit = buildSqlDirtyCommit(database, dirtyChat(), 1);

    expect(commit.chats).toHaveLength(1);
    expect((commit.chats[0].data as any).bindedPersona).toBe("the persona a summary does not carry");
    expect((commit.chats[0].data as any).localLore).toEqual([{ key: "per-chat-lore" }]);
    // The marker itself is never stored; the server synthesises it per read.
    expect((commit.chats[0].data as any).detailsLoaded).toBeUndefined();
  });
});
