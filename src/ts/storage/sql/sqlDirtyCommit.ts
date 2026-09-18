import type { Chat, Database, Message, character } from "../database.svelte";
import { isRootKeyDeferred, refuseDeferredRootDelete } from "./deferredRootKeys";
import { readPluginStorageOverlay } from "./pluginStorageOverlay";
import { measureRelationalValue } from "./relationalNodeCodec";
import type { DirtySnapshot } from "./dirtyRegistry";
import {
  getSqlPosition,
  getSqlWindow,
  isSqlWindowPartial,
  setSqlPosition,
  setSqlWindow,
} from "./sqlRuntimeWindow";
import {
  createEmptySqlCommit,
  sqlCharacterData,
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "./sqlCommit";

const ROOT_EXCLUSIONS = new Set([
  "characters",
  "pluginCustomStorage",
  "botPresets",
  "botPresetsId",
]);

type RuntimeChat = Chat & {
  messagesLoaded?: boolean;
  messagesFullyLoaded?: boolean;
};
type PositionedMessage = Message;
type MessageLookup = { message: PositionedMessage; localPosition: number };

function findCharacter(database: Database, characterId: string): [character, number] | undefined {
  const position = (database.characters ?? []).findIndex((item) => item.chaId === characterId);
  return position < 0 ? undefined : [database.characters[position], position];
}

function findChat(database: Database, chatId: string): [character, Chat, number, number] | undefined {
  for (const [characterPosition, currentCharacter] of (database.characters ?? []).entries()) {
    const chatPosition = (currentCharacter.chats ?? []).findIndex((chat) => chat.id === chatId);
    if (chatPosition >= 0) return [currentCharacter, currentCharacter.chats[chatPosition], characterPosition, chatPosition];
  }
  return undefined;
}

function messageWindowIsIncomplete(chat: RuntimeChat): boolean {
  return chat.messagesLoaded === false ||
    chat.messagesFullyLoaded === false ||
    isSqlWindowPartial(chat);
}

function canonicalMessagePosition(
  chat: RuntimeChat,
  message: PositionedMessage,
  localPosition: number,
): number {
  if (!messageWindowIsIncomplete(chat)) return localPosition;
  const canonical = getSqlPosition(message);
  if (Number.isSafeInteger(canonical) && canonical! >= 0) return canonical!;
  throw new Error(`Dirty message ${message.chatId ?? "(missing id)"} is missing its canonical SQL position`);
}

function messageLookup(chat: RuntimeChat, requested: ReadonlySet<string>): Map<string, MessageLookup> {
  const lookup = new Map<string, MessageLookup>();
  for (const [localPosition, message] of (chat.message ?? []).entries()) {
    if (message.chatId && requested.has(message.chatId)) lookup.set(message.chatId, { message, localPosition });
  }
  return lookup;
}

function allocateAppendedPositions(chat: RuntimeChat): void {
  if (!messageWindowIsIncomplete(chat)) return;
  const messages = chat.message ?? [];
  let firstUnpositioned = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (!Number.isSafeInteger(getSqlPosition(messages[index]))) {
      firstUnpositioned = index;
      break;
    }
  }
  if (firstUnpositioned < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    if (Number.isSafeInteger(getSqlPosition(messages[index]))) return;
  }
  const window = getSqlWindow(chat);
  const nextPosition = window?.nextPosition;
  if (!Number.isSafeInteger(nextPosition) || nextPosition! < 0) return;
  for (let index = firstUnpositioned; index < messages.length; index += 1) {
    setSqlPosition(messages[index], nextPosition! + index - firstUnpositioned);
  }
  // Replace the window rather than mutating the stored one in place. The chat
  // is a live `$state` object, so the window read back through it is a proxy of
  // what hydration stored; writing a whole new window keeps the advance atomic
  // and keeps every reader on a consistent snapshot.
  if (window) setSqlWindow(chat, { ...window, nextPosition: nextPosition! + messages.length - firstUnpositioned });
}

/**
 * Builds a transaction from only the scopes explicitly marked dirty. It never
 * compares the complete legacy graph; incomplete hydrated message windows use
 * the non-enumerable canonical position attached by SQL page hydration.
 */
export function buildSqlDirtyCommit(
  database: Database,
  dirty: DirtySnapshot,
  baseRevision: number,
  /**
   * Called instead of throwing when one dirty message cannot be given a
   * canonical position. Omit it and the throw stands; pass it and the row is
   * left out of this commit and reported, so it cannot take the rest of the
   * transaction -- every other chat included -- down with it.
   */
  onRefusedMessage?: (chatId: string, messageId: string, error: unknown) => void,
  /**
   * Called when a dirty chat is refused because it is still a bootstrap
   * summary. The row is left out of this commit; the caller keeps it dirty and
   * loads the chat's own fields so the next flush can write the whole record
   * instead of a stub.
   *
   * Without it the refusal is final: `acknowledge` clears the mark and an edit
   * made to an unopened chat -- a rename from the chat list is the easy one --
   * would be dropped rather than deferred.
   */
  onRefusedChat?: (characterId: string, chatId: string) => void,
  /**
   * Called when a dirty root key's value cannot be encoded at all. The key is
   * left out of this commit and named to the caller, which keeps it dirty and
   * tells the user which setting could not be stored.
   *
   * This exists because the encode does not happen here -- it happens later, in
   * `applySqliteCommit` while the commit is being turned into statements, which
   * is INSIDE `storage.commit()` and therefore inside the one call
   * `commitDirtyScopes` cannot contain. So a single unencodable key threw past
   * every other scope in the flush, the registry kept all of its marks, the 5s
   * retry rebuilt the same snapshot and threw again, and the application never
   * persisted anything again for the rest of the session. That is what the
   * second module import did.
   *
   * Checking here rather than there is deliberate: the decision to drop a key
   * belongs with the dirty-mark bookkeeping that has to retain it, and the
   * three storage backends must not each grow their own refusal policy.
   */
  onRefusedRootKey?: (key: string, error: unknown) => void,
  /**
   * Called when a dirty character is refused because it is still a bootstrap
   * summary -- the exact contract `onRefusedChat` has had, on the scope that
   * never got one.
   *
   * The refusal below is right; what was missing was the retain. `acknowledge`
   * cleared the mark and the edit was gone for the session with only a
   * `console.error`, and the reachable paths all edit characters the user has
   * by definition never opened: `removeChar(..., 'normal')` sets `trashTime`
   * (characters.ts), the Character Vault trashes many at once
   * (characterVault.ts), and restore-from-trash clears `trashTime`
   * (GridCatalog.svelte). So "delete a character you never opened" wrote the
   * character order -- an ordinary root key, which persists -- but not the
   * `trashTime`, and the next `checkCharOrder()` saw a character with no
   * `trashTime` missing from the order and put it straight back.
   */
  onRefusedCharacter?: (characterId: string) => void,
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, "dirty-sync");

  for (const key of dirty.rootKeys) {
    if (ROOT_EXCLUSIONS.has(key)) continue;
    const value = (database as unknown as Record<string, unknown>)[key];
    const missing = value === undefined || typeof value === "function";
    // "not loaded" and "not present" are different states. Only the second may
    // become a DELETE; a deferred key that got this far was marked dirty by a
    // diff that mistook partial knowledge for a deletion.
    if (missing && isRootKeyDeferred(key)) {
      refuseDeferredRootDelete(key, "buildSqlDirtyCommit");
      continue;
    }
    if (missing) {
      commit.root.deletes.push(key);
      continue;
    }
    // `measureRelationalValue` validates precisely what the encoder validates --
    // same traversal, same depth, cycle and type rules -- while allocating
    // nothing, so asking it here cannot disagree with what statement building
    // will do, and cannot be a meaningful cost on the ordinary keys.
    //
    // Without a callback the throw still stands and still escapes: a caller
    // with nowhere to record a refusal must not be told a commit is complete
    // when a key was silently dropped from it.
    if (onRefusedRootKey) {
      try {
        measureRelationalValue(value);
      } catch (error) {
        onRefusedRootKey(key, error);
        continue;
      }
    }
    commit.root.upserts.push({ key, value });
  }

  for (const characterId of dirty.characterIds) {
    const found = findCharacter(database, characterId);
    if (!found) {
      commit.characterDeletes!.push(characterId);
      continue;
    }
    const [currentCharacter, position] = found;
    // A character that has not been hydrated is a bootstrap summary: name,
    // image, chat list, timestamps -- and no description, no first message, no
    // lorebook, no scripts. Writing one back replaces the real record with it.
    //
    // Reachable on any ordinary launch, because auditSqlCompatibilityDatabase
    // marks EVERY character dirty when the character order changes
    // (sqlPersistenceRuntime.ts:352), summaries included. The user opens the
    // app, something reorders, and each character that had not been opened yet
    // loses everything but its name.
    //
    // Skipped rather than thrown: this builder runs inside a retry loop, so
    // throwing would stop characters, chats and messages from ever persisting.
    if ((currentCharacter as { detailsLoaded?: boolean }).detailsLoaded === false) {
      console.error(
        `[SQL dirty commit] refusing to write character ${characterId} from a bootstrap summary: ` +
        "its description, first message, lorebook and scripts are not loaded, so this write " +
        "would replace the stored record with a stub. The character stays as storage has it.",
      );
      onRefusedCharacter?.(characterId);
      continue;
    }
    commit.characters.push({ id: characterId, position, data: sqlCharacterData(currentCharacter) });
  }

  for (const dirtyChat of dirty.chats) {
    const found = findChat(database, dirtyChat.chatId);
    // A dirty chat that is nowhere in memory was deleted here, and only that
    // chat is deleted in storage. This used to be a manifest of the parent's
    // remaining chat ids -- "delete every chat of this character not in my
    // list" -- and the list was only ever what THIS tab had loaded. A chat
    // created on another device is not in it, so the manifest deleted that
    // chat and, through the cascade, every message in it. Rows this tab never
    // saw cannot be its to remove.
    if (!found) {
      commit.chatDeletes!.push({ characterId: dirtyChat.characterId, id: dirtyChat.chatId });
      continue;
    }
    // Found under another character: the chat moved. Its new pairing is dirty
    // too and writes the row with the new `character_id`; nothing is deleted.
    if (found[0].chaId !== dirtyChat.characterId) continue;
    const [, chat, , position] = found;
    // The same refusal as the character loop above, for the same reason, and
    // for a longer list of fields.
    //
    // A chat that has not been hydrated is a bootstrap summary: `name`, `note`,
    // `folderId` and `lastDate` -- the four real columns on the `chats` table --
    // and nothing else. Everything else on the `Chat` shape lives in
    // `chat_extension_nodes`: the per-chat lorebook, which alternate greeting
    // this chat uses, the bound persona, prompt preset and model preset, the
    // memory data, the bookmarks, the script state, the per-chat variables.
    //
    // `replaceNodes` DELETEs a chat's whole node set before inserting what it is
    // given, so writing a summary does not merely fail to update those fields --
    // it destroys them. And the write is easy to reach: `auditSqlCompatibilityDatabase`
    // marks chats dirty from a whole-database diff, so a chat the user never
    // opened is written back the first time anything about it looks changed.
    // That is why the reported bindings were gone after the FIRST refresh.
    //
    // Skipped rather than thrown for the same reason as the character guard:
    // this builder runs inside a retry loop, and throwing would stop every other
    // chat and message from ever persisting.
    if ((chat as { detailsLoaded?: boolean }).detailsLoaded === false) {
      console.error(
        `[SQL dirty commit] refusing to write chat ${dirtyChat.chatId} from a bootstrap summary: ` +
        "its lorebook, greeting index, persona/preset bindings, memory data and script state are " +
        "not loaded, so this write would replace the stored settings with a stub. The chat stays " +
        "as storage has it.",
      );
      onRefusedChat?.(dirtyChat.characterId, dirtyChat.chatId);
      continue;
    }
    commit.chats.push({
      id: dirtyChat.chatId,
      characterId: dirtyChat.characterId,
      position,
      data: sqlChatData(chat),
    });
  }

  for (const group of dirty.messages) {
    const found = findChat(database, group.chatId);
    if (!found) continue;
    const [, chat] = found;
    const runtimeChat = chat as RuntimeChat;
    allocateAppendedPositions(runtimeChat);
    const lookup = messageLookup(runtimeChat, new Set(group.messageIds));
    for (const messageId of group.messageIds) {
      const current = lookup.get(messageId);
      if (!current) continue;
      const { message, localPosition } = current;
      let position: number;
      try {
        position = canonicalMessagePosition(runtimeChat, message, localPosition);
      } catch (error) {
        // Without `onRefusedMessage` this still throws, and the throw is right:
        // a dirty row in a partial window with no canonical position must never
        // be written at a guessed one. What was wrong was where the throw
        // landed. `commitDirtyScopes` builds outside its try, so one such row
        // aborted the ENTIRE commit -- every other chat's pending edits with
        // it -- and the 5s retry rebuilt the same snapshot and threw again,
        // every five seconds, forever, with nothing but console output. One
        // un-positionable message meant nothing in the application ever
        // persisted again.
        //
        // Refusing just this row keeps that invariant and costs it only itself:
        // the caller leaves it dirty so it retries, and everything else in the
        // flush gets written.
        if (!onRefusedMessage) throw error;
        onRefusedMessage(group.chatId, messageId, error);
        continue;
      }
      commit.messages.push({
        id: messageId,
        chatId: group.chatId,
        position,
        data: sqlMessageData(message),
      });
    }
  }

  // Removals travel only as the ids below. There is no message manifest on
  // this path any more, for the reason given at the chat loop: every caller
  // that removed a message already named it with `markSqlMessageDeleted`, so
  // the manifest's "delete what is not in my array" added nothing except the
  // deletion of rows another device wrote after this tab loaded the chat.
  for (const deletion of dirty.messageDeletes) {
    if (deletion.messageIds.length)
      commit.messageDeletes!.push({ chatId: deletion.chatId, ids: [...deletion.messageIds] });
  }

  if (dirty.pluginStorageKeys.length) {
    // `pluginCustomStorage` never travels as a root key (see ROOT_EXCLUSIONS);
    // its rows are their own scope, and a dirty key that is not in the map
    // becomes a row DELETE. While the map is deferred it is not in memory at
    // all, so every dirty key would look absent -- partial knowledge read as a
    // definite negative, on the exact scope that lost a user's plugin list.
    const pluginStorageDeferred = isRootKeyDeferred("pluginCustomStorage");
    const storage = database.pluginCustomStorage ?? {};
    const upserts: Array<{ key: string; value: unknown }> = [];
    const deletes: string[] = [];
    for (const key of dirty.pluginStorageKeys) {
      // A value we can actually see is committed either way: a write that
      // landed while the map was deferred is still the user's own edit.
      //
      // `undefined` is NOT such a value, and the own-key check alone does not
      // exclude it. `pluginStorage.removeItem` does `delete
      // db.pluginCustomStorage[key]`, and `db` is a Svelte `$state` proxy whose
      // `deleteProperty` leaves the own key in place holding `undefined`. The
      // row column is `TEXT NOT NULL CHECK (json_valid(value))`, and
      // `JSON.stringify(undefined)` is `undefined`, so this bound SQL NULL and
      // the whole commit failed the constraint -- taking every unrelated change
      // batched with it. Falling through to the branches below instead is what
      // a removal means: a DELETE when the map is known, and a refusal when it
      // is not, which is the same answer they give for a key that is simply
      // not there.
      if (Object.prototype.hasOwnProperty.call(storage, key) && storage[key] !== undefined) {
        upserts.push({ key, value: storage[key] });
        continue;
      }
      if (pluginStorageDeferred) {
        // Per-key mode never populates the map, so the overlay is where a v3
        // plugin's write actually lives. Consulting it BEFORE the deferral
        // refusal is what makes those writes persist at all: without this the
        // guard below would refuse every one of them as "absence from a
        // deferred map", and the plugin's data would never leave the tab. A
        // removal is a definite `present: false` recorded by the plugin calling
        // `removeItem`/`clear`, which is a real deletion and not an inference
        // from partial knowledge -- so it becomes a DELETE even while deferred.
        //
        // Scoped to the deferred case ON PURPOSE. The overlay is meaningful
        // only while the map is not resident: once `ensureRootKeyHydrated`
        // folds it into the map and clears the mark, the map is the truth, and
        // an entry left in the overlay is stale by definition. A per-key read
        // that was in flight across that hydrate lands afterwards and caches
        // its answer into an overlay nobody drains again -- consulting that
        // here turned a later `removeItem` into an upsert of the pre-removal
        // value, silently resurrecting a row the plugin had been told was gone.
        const overlaid = readPluginStorageOverlay(key);
        if (overlaid) {
          if (overlaid.present) upserts.push({ key, value: overlaid.value });
          else deletes.push(key);
          continue;
        }
        refuseDeferredRootDelete(`pluginCustomStorage[${key}]`, "buildSqlDirtyCommit:pluginStorage");
        continue;
      }
      deletes.push(key);
    }
    commit.pluginStorage = { upserts, deletes };
  }

  const presetListDirty = dirty.rootKeys.includes("botPresets");
  const presetActiveDirty = dirty.rootKeys.includes("botPresetsId");
  if (dirty.presetIds.length || presetListDirty || presetActiveDirty) {
    const presets = database.botPresets ?? [];
    const upsertIds = presetListDirty
      ? presets.map((preset) => preset.id).filter((id): id is string => Boolean(id))
      : dirty.presetIds;
    const upserts = upsertIds.flatMap((id) => {
      const position = presets.findIndex((preset) => preset.id === id);
      return position < 0 ? [] : [{ id, position, data: presets[position] }];
    });
    const deletes = dirty.presetIds.filter((id) => !presets.some((preset) => preset.id === id));
    const ids = presets.map((preset) => preset.id).filter((id): id is string => Boolean(id));
    const activeIndex = Math.max(0, Math.min(Number(database.botPresetsId) || 0, ids.length - 1));
    const activeSelectionChanged = deletes.length > 0;
    // A dirty list travels as its order, never as a manifest: the audit marks
    // every preset that left the list as dirty, so removals are already in
    // `deletes` above, and "delete what is not in my order" would only add the
    // presets another device saved that this tab has not loaded.
    commit.presets = {
      upserts,
      deletes,
      ...(presetListDirty ? { order: ids } : {}),
      ...(presetListDirty || presetActiveDirty || activeSelectionChanged
        ? { activeId: ids[activeIndex] ?? null }
        : {}),
    };
  }

  return commit;
}
