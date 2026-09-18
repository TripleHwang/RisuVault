import { describe, expect, it } from "vitest";

import { applySqliteCommit } from "./sqliteCommit";
import {
  buildSqlReplaceCommit,
  createEmptySqlCommit,
  hasSqlCommitChanges,
} from "./sqlCommit";
import { getSqlPosition, getSqlWindow, setSqlPosition, setSqlWindow } from "./sqlRuntimeWindow";

describe("RisuVault SQL row commits", () => {
  it("splits legacy snapshots into character, chat and message rows", () => {
    const database = {
      username: "User",
      pluginCustomStorage: { pagefold: { packagingMode: "maximum" } },
      botPresets: [],
      botPresetsId: 0,
      characters: [
        {
          chaId: "character-1",
          type: "character",
          name: "Character",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: [{ chatId: "message-1", role: "user", data: "hello" }],
            },
          ],
        },
      ],
    } as any;

    const commit = buildSqlReplaceCommit(database, 7);

    expect(commit.baseRevision).toBe(7);
    expect(commit.replaceAll).toBe(true);
    expect(commit.root.upserts).toEqual([{ key: "username", value: "User" }]);
    expect(commit.pluginStorage?.upserts).toEqual([
      { key: "pagefold", value: { packagingMode: "maximum" } },
    ]);
    expect(commit.characters[0].data).not.toHaveProperty("chats");
    expect(commit.chats[0].data).not.toHaveProperty("message");
    expect(commit.chats[0].data).not.toHaveProperty("messagesLoaded");
    expect(getSqlWindow(commit.chats[0].data as object)).toBeUndefined();
    expect(commit.chats[0].data).not.toHaveProperty("_sqlWindow");
    expect(commit.messages).toEqual([
      {
        id: "message-1",
        chatId: "chat-1",
        position: 0,
        data: { role: "user", data: "hello" },
      },
    ]);
  });

  it("does not serialize runtime SQL hydration marks", () => {
    // Build the marks the way hydration does. They are symbol-keyed, and a
    // spread or rest-destructure -- which is how the commit builders copy a
    // chat and a message -- carries own enumerable symbols across. Asserting
    // only on the old property name would pass on a payload that still had
    // them.
    const chat: any = { id: "chat-1", message: [{ chatId: "message-1", role: "user", data: "hello" }] };
    setSqlWindow(chat, { before: null, nextBefore: 8, total: 10, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 10 });
    setSqlPosition(chat.message[0], 9);
    const database = {
      characters: [{ chaId: "character-1", chats: [chat] }],
      botPresets: [], botPresetsId: 0,
    } as any;

    const commit = buildSqlReplaceCommit(database, 0);

    expect(getSqlWindow(commit.chats[0].data as object)).toBeUndefined();
    expect(getSqlPosition(commit.messages[0].data as object)).toBeUndefined();
    // The live chat keeps its marks: stripping happens on the copy.
    expect(getSqlWindow(chat)).toMatchObject({ hasOlder: true, total: 10 });
    expect(getSqlPosition(chat.message[0])).toBe(9);
  });

  it("does not serialize hydration marks left as plain properties by an older build", () => {
    const database = {
      characters: [{ chaId: "character-1", chats: [{ id: "chat-1", message: [], _sqlWindow: { total: 10 } }] }],
      botPresets: [], botPresetsId: 0,
    } as any;
    expect(buildSqlReplaceCommit(database, 0).chats[0].data).not.toHaveProperty("_sqlWindow");
  });

  it("keeps normal commits bounded to the changed rows", async () => {
    const commit = createEmptySqlCommit(2, "message");
    expect(hasSqlCommitChanges(commit)).toBe(false);

    commit.root.upserts.push({ key: "temperature", value: 80 });
    commit.messages.push({
      id: "message-1",
      chatId: "chat-1",
      position: 4,
      data: { role: "char", data: "answer" },
    });
    expect(hasSqlCommitChanges(commit)).toBe(true);

    const statements: { sql: string; bind: unknown[] }[] = [];
    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements.some(({ sql }) => sql.includes("system_settings"))).toBe(
      true,
    );
    expect(statements.some(({ sql }) => sql.includes("messages"))).toBe(true);
    expect(
      statements.every(({ sql }) => !sql.includes("DELETE FROM characters")),
    ).toBe(true);
  });

  it("writes plugin state only through the explicit JSON exception", async () => {
    const commit = createEmptySqlCommit(1);
    commit.pluginStorage = {
      upserts: [{ key: "pagefold.config.v1", value: { activeProvider: "google" } }],
      deletes: [],
    };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const statement = statements.find(({ sql }) =>
      sql.includes("INSERT INTO plugin_custom_storage"),
    );
    expect(statement?.bind).toEqual([
      "pagefold.config.v1",
      JSON.stringify({ activeProvider: "google" }),
    ]);
  });

  it("deletes only explicitly named character rows", async () => {
    const commit = createEmptySqlCommit(1);
    commit.characterDeletes = ["character-removed"];
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toContainEqual({
      sql: "DELETE FROM characters WHERE id IN (?)",
      bind: ["character-removed"],
    });
  });

  it("deletes only the named chat row, guarded by its character", async () => {
    const commit = createEmptySqlCommit(1);
    commit.chatDeletes = [{ characterId: "character-1", id: "chat-removed" }];
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    expect(statements).toEqual([{
      sql: "DELETE FROM chats WHERE id = ? AND character_id = ?",
      bind: ["chat-removed", "character-1"],
    }]);
    expect(statements.some(({ sql }) => sql.includes("NOT IN"))).toBe(false);
  });

  it("runs chat deletes after chat upserts so a moved chat keeps its row", async () => {
    // The delete is guarded by `character_id`. That guard only protects a chat
    // that moved between characters if the upsert has already rewritten the
    // column; run first, the delete would match the old pairing and the
    // cascade would take the chat's messages with it.
    const commit = createEmptySqlCommit(1);
    commit.chats.push({ id: "chat-moved", characterId: "character-2", position: 0, data: { name: "moved" } });
    commit.chatDeletes = [{ characterId: "character-1", id: "chat-moved" }];
    const statements: string[] = [];

    await applySqliteCommit(commit, (sql) => { statements.push(sql); });

    const upsert = statements.findIndex((sql) => sql.includes("INSERT INTO chats"));
    const deletion = statements.findIndex((sql) => sql.startsWith("DELETE FROM chats WHERE id = ?"));
    expect(upsert).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(upsert);
  });

  it("reorders presets without deleting the ones the order does not mention", async () => {
    // The order is what this tab has in memory; a preset saved by another
    // device is not in it and must keep its row.
    const commit = createEmptySqlCommit(1);
    commit.presets = { upserts: [], deletes: ["preset-removed"], order: ["preset-b", "preset-a"], activeId: null };
    const statements: { sql: string; bind: unknown[] }[] = [];

    await applySqliteCommit(commit, (sql, bind = []) => {
      statements.push({ sql, bind });
    });

    const presetDeletes = statements.filter(({ sql }) => sql.startsWith("DELETE FROM bot_presets"));
    expect(presetDeletes).toEqual([{ sql: "DELETE FROM bot_presets WHERE preset_id = ?", bind: ["preset-removed"] }]);
    expect(statements.some(({ sql }) => /NOT IN/.test(sql))).toBe(false);
    expect(statements).toContainEqual({ sql: "UPDATE bot_presets SET position = ? WHERE preset_id = ?", bind: [0, "preset-b"] });
    expect(statements).toContainEqual({ sql: "DELETE FROM system_settings WHERE key = ?", bind: ["activeBotPresetId"] });
  });

  it("generates stable ids for legacy chats and messages that lack them", () => {
    const database = {
      characters: [{ chaId: "character-1", name: "C", chats: [{ message: [{ role: "char", data: "A" }] }] }],
      botPresets: [],
      botPresetsId: 0,
    } as any;
    const commit = buildSqlReplaceCommit(database, 0);
    expect(commit.chats[0].id).toBeTruthy();
    expect(commit.messages[0].id).toBeTruthy();
    expect(database.characters[0].chats[0].id).toBe(commit.chats[0].id);
    expect(database.characters[0].chats[0].message[0].chatId).toBe(
      commit.messages[0].id,
    );
  });
});
