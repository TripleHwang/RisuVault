/**
 * A first launch must end in SQL mode.
 *
 * Every migration test in this directory starts from a database somebody
 * wrote: a fixture with characters, presets and chats. None of them started
 * from what a fresh install actually has, which is no save file at all. On that
 * launch `bootstrap.ts` builds the legacy save itself, writes it to the server,
 * decodes it back and hands the result to `openStandaloneSql`, and only after
 * the migration returns does `setDatabase` fill in defaults. So the object the
 * replace-all encoder walks is exactly what the fresh save decodes to. When the
 * fresh save was `encodeRisuSaveLegacy({})`, that object was `{}`,
 * `database.characters.forEach` threw inside `buildSqlReplaceCommit`,
 * `selectCanonicalDatabase` caught it and fell back to legacy mode, and every
 * new user's first screen carried the migration-failure banner. Observed on a
 * built app against a fresh data root and reproduced here without a browser;
 * `git log -S` dates it to the commit that introduced standalone SQL.
 *
 * The suite reproduces the first launch step by step -- the same fresh-save
 * constructor, the same codec, the same `openExistingStandaloneSql` /
 * `openStandaloneSql` pair with the same real `NodeSqliteStorage` -- against a
 * real server on a fresh data root, and asserts what bootstrap asserts nothing
 * about: that the result is SQL mode, and that the next launch finds it.
 *
 * Only the HTTP hop is replaced. happy-dom is required here because
 * `database.svelte` reaches `stores.svelte`, which touches `window` at module
 * scope; and happy-dom's own `fetch` enforces the same-origin policy, so it
 * cannot reach `http://127.0.0.1:<port>`. A `node:http` client wrapped in a
 * `Response` is the whole substitution.
 */
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFreshDatabase } from "../database.svelte";
import { decodeRisuSave, encodeRisuSaveLegacy } from "../risuSave";
import { resetDeferredRootKeys } from "./deferredRootKeys";
import {
  onSqlMigrationFailure,
  resetSqlMigrationListeners,
  type SqlMigrationFailure,
} from "./migrationReporting";
import { NodeSqliteStorage } from "./nodeSqliteStorage";
import {
  openExistingStandaloneSql,
  openStandaloneSql,
  setActiveSqlStorageForTesting,
} from "./sqlBootstrap";
import { resetSqlPersistenceRuntimeForTesting } from "./sqlPersistenceRuntime";
import { spawnServer } from "../../../../test/compat/helpers/spawnServer";

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `fetch` over `node:http`, because happy-dom's refuses to leave its origin. */
function httpFetch(base: string, token?: string): FetchLike {
  return (input, init) => new Promise((resolveResponse, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, base);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    if (token) headers["risu-auth"] = token;
    const outgoing = request(url, { method: init?.method ?? "GET", headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") responseHeaders[key] = value;
        }
        resolveResponse(new Response(Buffer.concat(chunks).toString("utf8"), {
          status: incoming.statusCode ?? 0,
          headers: responseHeaders,
        }));
      });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    const body = init?.body;
    if (typeof body === "string") outgoing.write(body);
    else if (body instanceof Uint8Array) outgoing.write(body);
    else if (body instanceof ArrayBuffer) outgoing.write(new Uint8Array(body));
    else if (body != null) throw new Error(`unsupported request body: ${Object.prototype.toString.call(body)}`);
    outgoing.end();
  });
}

async function login(base: string, password: string): Promise<string> {
  const response = await httpFetch(base)("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status}): ${await response.text()}`);
  const { token } = await response.json() as { token?: string };
  if (!token) throw new Error("login returned no token");
  return token;
}

let server: ServerHandle;
let fetchImpl: FetchLike;
const failures: SqlMigrationFailure[] = [];

describe("first launch on a fresh data root", () => {
  beforeAll(async () => {
    server = await spawnServer();
    fetchImpl = httpFetch(`http://127.0.0.1:${server.port}`, await login(`http://127.0.0.1:${server.port}`, server.password));
    onSqlMigrationFailure((failure) => { failures.push(failure); });
  }, 60_000);

  afterAll(async () => {
    resetSqlMigrationListeners();
    resetSqlPersistenceRuntimeForTesting();
    setActiveSqlStorageForTesting(null);
    resetDeferredRootKeys();
    await server.cleanup();
  });

  it("migrates the fresh save into SQL and stays there", async () => {
    // bootstrap.ts, first-launch branch: no `database/database.bin`, so the
    // save is built, encoded, and decoded straight back.
    const source = encodeRisuSaveLegacy(createFreshDatabase());
    const decoded = await decodeRisuSave(source);

    // bootstrap.ts: `openExistingStandaloneSql` runs first and, finding the SQL
    // store empty, parks the storage for `openStandaloneSql` to migrate into.
    const storage = new NodeSqliteStorage(fetchImpl);
    expect(await openExistingStandaloneSql(storage)).toBeNull();

    const result = await openStandaloneSql(decoded);

    // The failure listener is what puts the banner on screen, so it is checked
    // first: when the migration threw, this is where the exception is.
    expect(failures).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ usingSql: true, migrated: true });
    expect(result.storage).toBe(storage);
    expect(Array.isArray(result.database.characters)).toBe(true);
    // The property the replace-all encoder walks unguarded, on the DECODED
    // object: the codec sits between the constructor and the migration, and a
    // default the codec dropped would be no default at all.
    expect(Array.isArray(decoded.characters)).toBe(true);
    expect(Array.isArray(decoded.characterOrder)).toBe(true);
  }, 60_000);

  it("is found by the next launch as an existing SQL database", async () => {
    // A new storage object is what a reload constructs; the parked one above
    // was consumed by the migration.
    const nextLaunch = await openExistingStandaloneSql(new NodeSqliteStorage(fetchImpl));
    expect(nextLaunch).toMatchObject({ usingSql: true, migrated: false, mode: "metadata-first" });
    expect(Array.isArray(nextLaunch?.database.characters)).toBe(true);
    // Read before `setDatabase` has had a chance to default it: this is the
    // SQL store's own root, and a metadata-first launch skips the bootstrap
    // format check that used to be the only place this got a value.
    expect(Array.isArray(nextLaunch?.database.characterOrder)).toBe(true);
  }, 60_000);
});

/**
 * The live test above migrates whatever `createFreshDatabase` returns. This pins
 * that bootstrap encodes the same thing, so the suite cannot pass against a
 * bootstrap that has gone back to `{}`.
 */
describe("bootstrap builds the fresh save from the same constructor", () => {
  const bootstrap = readFileSync(resolve(process.cwd(), "src/ts/bootstrap.ts"), "utf8");

  it("encodes createFreshDatabase(), never a bare object", () => {
    expect(bootstrap).toContain("encodeRisuSaveLegacy(createFreshDatabase())");
    expect(bootstrap).not.toMatch(/encodeRisuSaveLegacy\(\{\}\)/);
  });
});
