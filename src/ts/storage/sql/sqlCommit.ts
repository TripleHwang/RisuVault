import { v4 as uuidv4 } from "uuid";

import type {
  botPreset,
  character,
  Chat,
  Database,
  Message,
} from "../database.svelte";
import { isRootKeyDeferred } from "./deferredRootKeys";
import { stripSqlRuntimeFields } from "./sqlRuntimeWindow";

export interface SqlSettingUpsert {
  key: string;
  value: unknown;
}

export interface SqlEntityUpsert {
  id: string;
  position: number;
  data: unknown;
}

export interface SqlChatUpsert extends SqlEntityUpsert {
  characterId: string;
}

export interface SqlMessageUpsert extends SqlEntityUpsert {
  chatId: string;
}

export interface SqlPresetUpsert {
  id: string;
  position: number;
  data: botPreset;
}

/**
 * A bounded transaction produced at the mutation boundary. Normal commits
 * touch only changed rows; `replaceAll` is reserved for import and migration.
 */
export interface SqlCommit {
  baseRevision: number;
  idempotencyKey?: string;
  replaceAll?: boolean;
  action?: string;
  root: { upserts: SqlSettingUpsert[]; deletes: string[] };
  pluginStorage?: {
    upserts: SqlSettingUpsert[];
    deletes: string[];
    clear?: boolean;
  };
  presets?: {
    upserts: SqlPresetUpsert[];
    deletes: string[];
    /**
     * Positions for the listed ids only. Rows the list does not mention keep
     * their row and sort after it -- there is no manifest for presets, for the
     * same reason there is none for chats (see `chatDeletes`).
     */
    order?: string[];
    activeId?: string | null;
  };
  characters: SqlEntityUpsert[];
  characterDeletes?: string[];
  characterIds?: string[];
  chats: SqlChatUpsert[];
  /**
   * Chats deleted by id. The dirty path records a removal this way and never as
   * a manifest: a manifest is "delete every chat of this character that is
   * not in MY list", and the list is only what this tab has in memory. Another
   * device's new chat is absent from that list, so the manifest wiped it --
   * and its messages with it, through the cascade. An explicit id can only
   * remove a row this tab actually saw.
   */
  chatDeletes?: { characterId: string; id: string }[];
  /** Whole-list reconciliation; only import and migration build these. */
  chatManifests: { characterId: string; ids: string[] }[];
  messages: SqlMessageUpsert[];
  /**
   * Same rule as `chatManifests`: replace-all and the whole-database diff
   * build these, the dirty path does not. A removal made in this tab is
   * always an explicit `messageDeletes` entry.
   */
  messageManifests: { chatId: string; ids: string[] }[];
  messageDeletes?: { chatId: string; ids: string[] }[];
}

export interface SqlCommitResult {
  revision: number;
}

export class SqlRevisionConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`SQL revision conflict: current revision is ${currentRevision}`);
    this.name = "SqlRevisionConflictError";
  }
}

export function createEmptySqlCommit(
  baseRevision: number,
  action?: string,
): SqlCommit {
  return {
    baseRevision,
    action,
    root: { upserts: [], deletes: [] },
    characters: [],
    characterDeletes: [],
    chats: [],
    chatDeletes: [],
    chatManifests: [],
    messages: [],
    messageManifests: [],
    messageDeletes: [],
  };
}

export function hasSqlCommitChanges(commit: SqlCommit): boolean {
  return Boolean(
    commit.root.upserts.length ||
      commit.root.deletes.length ||
      commit.pluginStorage?.upserts.length ||
      commit.pluginStorage?.deletes.length ||
      commit.pluginStorage?.clear ||
      commit.presets?.upserts.length ||
      commit.presets?.deletes.length ||
      commit.presets?.order ||
      commit.presets?.activeId !== undefined ||
      commit.characters.length ||
      commit.characterDeletes?.length ||
      commit.characterIds ||
      commit.chats.length ||
      commit.chatDeletes?.length ||
      commit.chatManifests.length ||
      commit.messages.length ||
      commit.messageManifests.length ||
      commit.messageDeletes?.length
  );
}

export function sqlCharacterData(value: character): unknown {
  const data = { ...value } as Record<string, unknown>;
  delete data.chats;
  delete data.chaId;
  delete data.detailsLoaded;
  return data;
}

export function sqlChatData(value: Chat): unknown {
  const data = { ...value } as Record<string, unknown>;
  delete data.message;
  delete data.id;
  delete data._placeholder;
  delete data.messagesLoaded;
  delete data.messagesFullyLoaded;
  delete data.messageOffset;
  delete data.messageTotal;
  delete data.detailsLoaded;
  // A chat built from a `database.bin` stub still carries the flag that says
  // "this is a stub". Writing it into the chat row would make every chat read
  // back out of SQL look like one.
  delete data._stub;
  // Object spread copies own enumerable *symbol* keys, so the runtime
  // hydration window rides along on the copy unless it is stripped here.
  return stripSqlRuntimeFields(data);
}

export function sqlMessageData(value: Message): unknown {
  // Rest destructuring copies symbol keys for the same reason as the spread
  // above; the canonical SQL position is runtime bookkeeping, never row data.
  const { chatId: _messageId, ...data } = value;
  return stripSqlRuntimeFields(data);
}

function ensureId(value: { id?: string }): string {
  value.id ||= uuidv4();
  return value.id;
}

function ensureMessageId(message: Message): string {
  message.chatId ||= uuidv4();
  return message.chatId;
}

/**
 * Whether this chat object is holding its own history, or only standing in for
 * one that lives somewhere else.
 *
 * The database the client downloads from `GET /api/read` has every chat reduced
 * to a stub -- `{ id, name, _stub: true }`, with no `message` key at all -- and
 * the histories are served per chat from `/api/chat-content`. The runtime has
 * two more shapes with the same meaning: a placeholder chat built from such a
 * stub, and a SQL-backed chat whose message window has not been filled.
 *
 * A "hybrid" carrying both `_stub: true` and a real `message` array is NOT
 * unloaded: `isChatStub` deliberately excludes it, and it flows through the
 * normal Chat paths so the corrupt flag self-heals.
 */
export function chatHistoryIsUnloaded(chat: Chat): boolean {
  const runtime = chat as Chat & { messagesLoaded?: boolean };
  if (!Array.isArray(chat.message)) return true;
  if (chat._placeholder === true) return true;
  return runtime.messagesLoaded === false;
}

/** Every chat in the database whose history is not in the object. */
export function unloadedChatHistories(
  database: Database,
): { characterId: string; chatIndex: number; chatId: string; chatName: string }[] {
  const unloaded: { characterId: string; chatIndex: number; chatId: string; chatName: string }[] = [];
  for (const currentCharacter of database.characters ?? []) {
    (currentCharacter.chats ?? []).forEach((chat, chatIndex) => {
      if (!chatHistoryIsUnloaded(chat)) return;
      unloaded.push({
        characterId: currentCharacter.chaId,
        chatIndex,
        chatId: chat.id ?? "",
        chatName: chat.name ?? "",
      });
    });
  }
  return unloaded;
}

export interface SqlReplaceCommitOptions {
  /**
   * Leave every chat row and every message out of the commit; the caller
   * writes them, one chat at a time.
   *
   * Set by the migration when any chat's history has to be fetched. The commit
   * then carries the settings, the characters and the chat manifests, and each
   * chat arrives afterwards as its own small run of statements, so a 50 MB
   * database's histories are never all resident at once.
   *
   * The chat ROWS are streamed too, not only the messages. A stripped
   * `database.bin` describes a chat as `{ id, name, _stub: true, lastDate }`;
   * everything else about it -- the note, the persona binding, the first-message
   * index -- comes back with its content from `/api/chat-content`. Writing the
   * chat row from the stub would migrate the history and silently drop the rest
   * of the chat.
   *
   * The message manifests go with them: a `replaceAll` opens with
   * `DELETE FROM characters`, which cascades through `chats` to `messages`, so
   * there is nothing left for a manifest to prune.
   */
  streamChats?: boolean;
}

/** Build the one-time full replacement used by legacy import. */
export function buildSqlReplaceCommit(
  database: Database,
  baseRevision: number,
  options: SqlReplaceCommitOptions = {},
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, "replace-all");
  commit.replaceAll = true;
  commit.characterIds = [];

  // A replace-all clears `plugin_custom_storage` and rewrites it from this map.
  // Building it from a map that was never loaded would delete every row and
  // replace them with nothing. Throwing keeps the caller on its old source:
  // `selectCanonicalDatabase` catches this and preserves the legacy database.
  if (isRootKeyDeferred("pluginCustomStorage")) {
    throw new Error(
      "Refusing to build a replace-all SQL commit while pluginCustomStorage is deferred: " +
      "its rows exist in storage but are not loaded, so this commit would clear them. " +
      "Load the key first (ensureRootKeyHydrated) and retry.",
    );
  }
  database.pluginCustomStorage ??= {};
  commit.pluginStorage = {
    upserts: Object.entries(database.pluginCustomStorage).map(([key, value]) => ({
      key,
      value,
    })),
    deletes: [],
    clear: true,
  };

  const presets = Array.isArray(database.botPresets) ? database.botPresets : [];
  const presetIds = presets.map((preset) => {
    preset.id ||= uuidv4();
    return preset.id;
  });
  if (presets.length) {
    const activeIndex = Math.max(
      0,
      Math.min(Number(database.botPresetsId) || 0, presets.length - 1),
    );
    commit.presets = {
      upserts: presets.map((data, position) => ({
        id: presetIds[position],
        position,
        data,
      })),
      deletes: [],
      order: presetIds,
      activeId: presetIds[activeIndex],
    };
  }

  for (const [key, value] of Object.entries(database)) {
    if (
      key !== "characters" &&
      key !== "pluginCustomStorage" &&
      key !== "botPresets" &&
      key !== "botPresetsId" &&
      value !== undefined &&
      typeof value !== "function"
    ) {
      commit.root.upserts.push({ key, value });
    }
  }

  database.characters.forEach((currentCharacter, characterPosition) => {
    currentCharacter.chaId ||= uuidv4();
    commit.characterIds!.push(currentCharacter.chaId);
    commit.characters.push({
      id: currentCharacter.chaId,
      position: characterPosition,
      data: sqlCharacterData(currentCharacter),
    });

    const chats = currentCharacter.chats ?? [];
    const chatIds = chats.map(ensureId);
    commit.chatManifests.push({
      characterId: currentCharacter.chaId,
      ids: chatIds,
    });

    chats.forEach((chat, chatPosition) => {
      const chatId = chatIds[chatPosition];
      // The caller is writing this chat -- row and history alike -- from the
      // server's copy of it. See `streamChats`.
      if (options.streamChats) return;
      commit.chats.push({
        id: chatId,
        characterId: currentCharacter.chaId,
        position: chatPosition,
        data: sqlChatData(chat),
      });
      // Emitting `chat.message ?? []` for a chat whose history is not in the
      // object is precisely the defect this guard exists for: it turned a stub
      // into a finished, empty history and then marked SQL canonical.
      if (chatHistoryIsUnloaded(chat)) {
        throw new Error(
          `Refusing to migrate chat "${chat.name ?? chatId}" (${chatId}) into SQL with no ` +
          "messages: this chat object is a stub or an unfilled window, so its history is not " +
          "loaded here. Not loaded is not the same as not present -- the messages live on the " +
          "server and must be fetched before the chat is written.",
        );
      }
      const messages = chat.message ?? [];
      const messageIds = messages.map(ensureMessageId);
      commit.messageManifests.push({ chatId, ids: messageIds });
      messages.forEach((message, position) => {
        commit.messages.push({
          id: messageIds[position],
          chatId,
          position,
          data: sqlMessageData(message),
        });
      });
    });
  });

  return commit;
}

/**
 * One chat's messages, positioned from `startPosition`, as a commit of their
 * own.
 *
 * Used by the streaming migration (one page of one chat at a time) and by the
 * repair that backfills a chat an earlier broken migration left empty. There is
 * no manifest: a manifest deletes the rows an id list does not mention, which
 * is exactly wrong for a commit that carries only part of a history.
 */
export function buildSqlChatMessagesCommit(
  chatId: string,
  messages: readonly Message[],
  startPosition: number,
  baseRevision: number,
  action = "chat-messages",
): SqlCommit {
  const commit = createEmptySqlCommit(baseRevision, action);
  messages.forEach((message, index) => {
    commit.messages.push({
      id: ensureMessageId(message),
      chatId,
      position: startPosition + index,
      data: sqlMessageData(message),
    });
  });
  return commit;
}
