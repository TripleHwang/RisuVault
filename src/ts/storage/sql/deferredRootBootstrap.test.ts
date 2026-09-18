import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NodeSqliteStorage,
  DEFERRED_BOOTSTRAP_ROOT_KEYS,
  SQL_CHAT_HISTORY_AUDIT_KEY,
} from "./nodeSqliteStorage";
import {
  clearDeferredRootKey,
  deferredRootDeleteRefusals,
  deferredRootKeySnapshot,
  isRootKeyDeferred,
  markRootKeyDeferred,
  resetDeferredRootKeys,
} from "./deferredRootKeys";
import { buildSqlDirtyCommit } from "./sqlDirtyCommit";
import type { DirtySnapshot } from "./dirtyRegistry";
import type { Database } from "../database.svelte";

/**
 * These tests drive the real NodeSqliteStorage against a scripted transport.
 * Nothing here reads source text; every assertion is about what the client
 * actually put into the Database and into the deferral registry.
 */

type BootstrapOverrides = Partial<{
  status: "ready" | "empty";
  revision: number;
  settings: Record<string, unknown>;
  deferredRootKeys: unknown;
  absentDeferredRootKeys: unknown;
  unreadableRootKeys: unknown;
}>;

function bootstrapBody(overrides: BootstrapOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: overrides.status ?? "ready",
    revision: overrides.revision ?? 4,
    // Every fixture here is a database migrated by a build that carried the chat
    // histories. Without the stamp the client refuses to treat it as ready and
    // re-migrates, which is the point of the stamp -- these tests are about
    // deferral, not about that.
    settings: {
      [SQL_CHAT_HISTORY_AUDIT_KEY]: "test-fixture",
      ...(overrides.settings ?? { username: "risu", plugins: [{ name: "kept" }] }),
    },
    pluginCustomStorage: {},
    botPresets: [],
    characters: [],
    selectedCharacterId: null,
    selectedChatId: null,
  };
  for (const field of ["deferredRootKeys", "absentDeferredRootKeys", "unreadableRootKeys"] as const) {
    if (field in overrides) body[field] = overrides[field];
  }
  return body;
}

type Scripted = {
  bootstrap?: Record<string, unknown>;
  rootKeys?: Record<string, { status?: number; body?: unknown }>;
  snapshot?: Record<string, unknown>;
};

function createClient(scripted: Scripted, deferRootKeys?: readonly string[]) {
  const paths: string[] = [];
  const request = async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.startsWith("/api/sql/bootstrap")) {
      return Response.json(scripted.bootstrap ?? bootstrapBody());
    }
    if (path === "/api/sql/snapshot") {
      return Response.json(scripted.snapshot ?? { status: "ready", revision: 4, tables: {} });
    }
    if (path.startsWith("/api/sql/root-keys/")) {
      const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
      const scriptedKey = scripted.rootKeys?.[key];
      if (!scriptedKey) return Response.json({}, { status: 404 });
      return Response.json(
        scriptedKey.body === undefined ? {} : scriptedKey.body as Record<string, unknown>,
        { status: scriptedKey.status ?? 200 },
      );
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const client = deferRootKeys
    ? new NodeSqliteStorage(request, deferRootKeys)
    : new NodeSqliteStorage(request);
  return { client, paths };
}

function emptyDirty(overrides: Partial<DirtySnapshot> = {}): DirtySnapshot {
  return {
    rootKeys: [],
    characterIds: [],
    chats: [],
    messages: [],
    messageDeletes: [],
    pluginStorageKeys: [],
    presetIds: [],
    ...overrides,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetDeferredRootKeys();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  resetDeferredRootKeys();
});

describe("bootstrap deferral wiring", () => {
  it("asks the server to withhold exactly the configured default defer set", async () => {
    const { client, paths } = createClient({});

    const loaded = await client.loadDatabase();

    expect([...DEFERRED_BOOTSTRAP_ROOT_KEYS]).toEqual(["pluginCustomStorage"]);
    expect(paths[0]).toBe("/api/sql/bootstrap?defer=pluginCustomStorage");
    // This scripted payload reports nothing as deferred, so nothing is: a key
    // is only protected when the server confirms it withheld it.
    expect(deferredRootKeySnapshot()).toEqual([]);
    expect((loaded?.database as any).plugins).toEqual([{ name: "kept" }]);
  });

  it("asks for nothing to be withheld when the defer set is empty", async () => {
    const { client, paths } = createClient({}, []);

    await client.loadDatabase();

    expect(paths[0]).toBe("/api/sql/bootstrap");
    expect(deferredRootKeySnapshot()).toEqual([]);
  });

  it("sends the requested defer set to the server when one is configured", async () => {
    const { client, paths } = createClient(
      { bootstrap: bootstrapBody({ settings: { username: "risu" }, deferredRootKeys: ["plugins"] }) },
      ["plugins"],
    );

    await client.loadDatabase();

    expect(paths[0]).toBe("/api/sql/bootstrap?defer=plugins");
  });

  it("registers a withheld key as deferred and leaves it OFF the database object", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({ settings: { username: "risu" }, deferredRootKeys: ["plugins"] }),
    });

    const database = (await client.loadDatabase())?.database as any;

    expect(isRootKeyDeferred("plugins")).toBe(true);
    // Not `[]`, not `undefined` as an own property: absent entirely, so nothing
    // downstream can read it as "the user has no plugins".
    expect(Object.prototype.hasOwnProperty.call(database, "plugins")).toBe(false);
    expect(database.username).toBe("risu");
    expect(isRootKeyDeferred("username")).toBe(false);
  });

  it("keeps a dirty deferred root key from becoming a DELETE end to end", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({ settings: { username: "risu" }, deferredRootKeys: ["plugins"] }),
    });
    const database = (await client.loadDatabase())?.database as Database;

    // Exactly the audit-loop behaviour that caused the incident: the key looks
    // "changed" because it is absent, so it lands in the dirty root set.
    const commit = buildSqlDirtyCommit(
      database,
      emptyDirty({ rootKeys: ["plugins", "username"] }),
      4,
    );

    expect(commit.root.deletes).toEqual([]);
    expect(commit.root.upserts).toEqual([{ key: "username", value: "risu" }]);
    expect(deferredRootDeleteRefusals()).toEqual([
      { key: "plugins", origin: "buildSqlDirtyCommit" },
    ]);
    expect(isRootKeyDeferred("plugins")).toBe(true);
  });

  it("drops the value when the payload both defers a key and sends it", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({
        settings: { username: "risu", plugins: [] },
        deferredRootKeys: ["plugins"],
      }),
    });

    const database = (await client.loadDatabase())?.database as any;

    expect(Object.prototype.hasOwnProperty.call(database, "plugins")).toBe(false);
    expect(isRootKeyDeferred("plugins")).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[SQL deferred bootstrap]"),
    );
  });

  it("refuses to defer a structural key the client always rebuilds itself", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({ deferredRootKeys: ["botPresets"] }),
    });

    const database = (await client.loadDatabase())?.database as any;

    expect(isRootKeyDeferred("botPresets")).toBe(false);
    expect(database.botPresets).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[SQL deferred bootstrap]"),
    );
  });

  it("never asks the server to withhold a key it rebuilds from a dedicated field", async () => {
    const { client, paths } = createClient(
      { bootstrap: bootstrapBody({ deferredRootKeys: [] }) },
      ["botPresets", "plugins"],
    );

    await client.loadDatabase();

    expect(paths[0]).toBe("/api/sql/bootstrap?defer=plugins");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[SQL deferred bootstrap]"),
    );
  });

  it("treats a stored-but-unreadable key as deferred, not as a deletable absence", async () => {
    // The server registered `plugins` but could not rebuild its value, so it
    // arrives with no entry in `settings` at all -- `undefined` does not survive
    // JSON. Without the unreadable report it is indistinguishable from a key
    // that was never stored, and a dirty mark would delete a row that exists.
    const { client } = createClient({
      bootstrap: bootstrapBody({ settings: { username: "risu" }, unreadableRootKeys: ["plugins"] }),
    });
    const database = (await client.loadDatabase())?.database as Database;

    expect(isRootKeyDeferred("plugins")).toBe(true);
    const commit = buildSqlDirtyCommit(database, emptyDirty({ rootKeys: ["plugins"] }), 4);
    expect(commit.root.deletes).toEqual([]);
    expect(deferredRootDeleteRefusals()).toEqual([
      { key: "plugins", origin: "buildSqlDirtyCommit" },
    ]);
  });

  it("does not defer a requested key the server reports as genuinely absent", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({
        settings: { username: "risu" },
        deferredRootKeys: [],
        absentDeferredRootKeys: ["plugins"],
      }),
    }, ["plugins"]);

    const database = (await client.loadDatabase())?.database as Database;

    // Not stored is a definite negative the server is entitled to make, so the
    // key is deletable like any other absent key.
    expect(isRootKeyDeferred("plugins")).toBe(false);
    const commit = buildSqlDirtyCommit(database, emptyDirty({ rootKeys: ["plugins"] }), 4);
    expect(commit.root.deletes).toEqual(["plugins"]);
  });

  it("rejects a malformed defer report instead of degrading to 'nothing deferred'", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({ deferredRootKeys: ["plugins", 7] }),
    });

    await expect(client.loadDatabase()).rejects.toThrow(/deferred root key report/);
    expect(deferredRootKeySnapshot()).toEqual([]);
  });

  it("clears a stale deferred mark when a later bootstrap ships the key", async () => {
    markRootKeyDeferred("plugins");
    const { client } = createClient({
      bootstrap: bootstrapBody({ settings: { plugins: [{ name: "back" }] } }),
    });

    const database = (await client.loadDatabase())?.database as any;

    expect(isRootKeyDeferred("plugins")).toBe(false);
    expect(database.plugins).toEqual([{ name: "back" }]);
  });

  it("does not re-defer a key already hydrated when the payload is refetched", async () => {
    const { client } = createClient({
      bootstrap: bootstrapBody({ settings: { username: "risu" }, deferredRootKeys: ["plugins"] }),
      rootKeys: { plugins: { body: { revision: 4, key: "plugins", present: true, value: [{ name: "real" }] } } },
    });
    const database = (await client.loadDatabase())?.database as any;
    expect(isRootKeyDeferred("plugins")).toBe(true);

    // What ensureRootKeyHydrated does: fetch, install, then release the mark.
    database.plugins = await client.loadRootKeyHydration("plugins");
    clearDeferredRootKey("plugins");

    // Any later read (`current()`, or a refetch after a commit invalidated the
    // cached payload) rebuilds from a bootstrap that still reports the key as
    // withheld. The live database already holds the real value; re-marking it
    // deferred would hide the user's later edits from the compatibility audit
    // and silently stop persisting them.
    await client.loadDatabase();

    expect(isRootKeyDeferred("plugins")).toBe(false);
    expect(database.plugins).toEqual([{ name: "real" }]);
  });

  it("clears deferred marks when a complete recovery dump is rebuilt", async () => {
    markRootKeyDeferred("plugins");
    const { client } = createClient({ snapshot: { status: "ready", revision: 9, tables: {} } });

    await client.loadRecoverySnapshot();

    expect(deferredRootKeySnapshot()).toEqual([]);
  });
});

describe("loadRootKeyHydration transport", () => {
  it("returns the server's value for one root key", async () => {
    const { client, paths } = createClient({
      rootKeys: { plugins: { body: { revision: 4, key: "plugins", present: true, value: [{ name: "real" }] } } },
    });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).resolves.toEqual([{ name: "real" }]);
    expect(paths).toContain("/api/sql/root-keys/plugins");
  });

  it("rejects on 404 rather than reporting the key as empty", async () => {
    const { client } = createClient({ rootKeys: {} });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).rejects.toThrow(/stays deferred/);
  });

  it("rejects a payload with no value property", async () => {
    const { client } = createClient({
      rootKeys: { plugins: { body: { revision: 4, key: "plugins", present: true } } },
    });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).rejects.toThrow(/Invalid SQL root key payload/);
  });

  it("rejects a payload whose value is explicitly undefined", async () => {
    const { client } = createClient({
      rootKeys: { plugins: { body: { revision: 4, key: "plugins", present: true, value: undefined } } },
    });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).rejects.toThrow(/Invalid SQL root key payload/);
  });

  it("rejects a payload for a different key", async () => {
    const { client } = createClient({
      rootKeys: { plugins: { body: { revision: 4, key: "modules", present: true, value: [] } } },
    });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).rejects.toThrow(/Invalid SQL root key payload/);
  });

  it("accepts a legitimately empty array as a value once the server actually says so", async () => {
    const { client } = createClient({
      rootKeys: { plugins: { body: { revision: 4, key: "plugins", present: true, value: [] } } },
    });
    await client.init();

    await expect(client.loadRootKeyHydration("plugins")).resolves.toEqual([]);
  });
});

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

/**
 * Contract check against the REAL server module rather than a scripted double.
 * The transport shim encodes assumptions about the server's wire format; these
 * tests are what catch the two sides drifting apart.
 */
describe("deferral against the real relational SQLite server", () => {
  const roots: string[] = [];
  const servers: { close(): void }[] = [];
  afterEach(() => {
    // Windows keeps the SQLite file locked until the handle is closed, so the
    // temp directory cannot be removed before that.
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createRealClient(deferRootKeys: readonly string[]) {
    const root = mkdtempSync(join(tmpdir(), "risu-deferred-root-"));
    roots.push(root);
    const server = createRelationalSqlite({ dataRoot: root });
    servers.push(server);
    const request = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/sql/bootstrap")) {
        const url = new URL(path, "https://risu.invalid");
        const defer = url.searchParams.get("defer");
        return Response.json(server.bootstrap({
          deferRootKeys: defer ? defer.split(",") : [],
        }));
      }
      if (path.startsWith("/api/sql/root-keys/")) {
        const key = decodeURIComponent(path.slice("/api/sql/root-keys/".length));
        const result = server.loadRootKey(key);
        return result.present
          ? Response.json(result)
          : Response.json({ error: "Root key not found", key, present: false }, { status: 404 });
      }
      if (path === "/api/sql/commit") return Response.json(server.commit(JSON.parse(String(init?.body))));
      throw new Error(`unexpected request: ${path}`);
    };
    return { client: new NodeSqliteStorage(request, deferRootKeys), server };
  }

  it("round-trips a real deferred key: withheld at bootstrap, undeletable, then loaded", async () => {
    const { client } = createRealClient(["plugins"]);
    await client.init();
    await client.replaceDatabase({
      username: "standalone",
      plugins: [{ name: "installed-plugin" }],
      botPresets: [],
      botPresetsId: 0,
      characters: [],
    } as any);

    const database = (await client.loadDatabase())?.database as Database;

    // The server confirmed the key exists and withheld its value.
    expect(isRootKeyDeferred("plugins")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(database, "plugins")).toBe(false);
    expect((database as any).username).toBe("standalone");

    // While withheld, the incident's dirty-root path cannot delete it.
    const refused = buildSqlDirtyCommit(database, emptyDirty({ rootKeys: ["plugins"] }), 0);
    expect(refused.root.deletes).toEqual([]);

    // On demand it comes back intact, and only then does it become deletable.
    const value = await client.loadRootKeyHydration("plugins");
    expect(value).toEqual([{ name: "installed-plugin" }]);
    (database as any).plugins = value;
    clearDeferredRootKey("plugins");
    const upserted = buildSqlDirtyCommit(database, emptyDirty({ rootKeys: ["plugins"] }), 0);
    expect(upserted.root.upserts).toEqual([
      { key: "plugins", value: [{ name: "installed-plugin" }] },
    ]);
  });

  it("reports a requested key that is not stored as absent rather than deferred", async () => {
    const { client } = createRealClient(["neverStoredKey"]);
    await client.init();
    await client.replaceDatabase({
      username: "standalone", botPresets: [], botPresetsId: 0, characters: [],
    } as any);

    await client.loadDatabase();

    expect(isRootKeyDeferred("neverStoredKey")).toBe(false);
    await expect(client.loadRootKeyHydration("neverStoredKey")).rejects.toThrow(/404/);
  });
});
