# One-click orphan cleanup implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one confirmed action in System settings that safely removes unreferenced media, unused HypaMemory vectors, and unreachable file-store objects.

**Architecture:** A pure server helper computes live asset references and live Hypa summary text. The authenticated cleanup route flushes pending saves, fails closed if plugin storage cannot be scanned, bulk-removes only planned KV keys, then runs existing object GC. The dashboard presents one primary CTA with category counts, confirmation, loading feedback, and a result toast.

**Tech Stack:** Node.js CommonJS, Svelte 5, TypeScript, Vitest, Tailwind theme tokens.

---

### Task 1: Bulk KV deletion

**Files:**
- Modify: `server/node/file-kv.test.ts`
- Modify: `server/node/file-kv.cjs`

- [x] **Step 1: Write the failing test**

Add a test that writes `assets/a`, `assets/b`, and `settings/c`, calls `kvDelMany(['assets/a', 'assets/b', 'missing'])`, and expects `{ count: 2, bytes: 7 }`, only `settings/c` in a reopened store, and seven reclaimable bytes.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.config.server.ts server/node/file-kv.test.ts`

Expected: FAIL because `kvDelMany` is not defined.

- [x] **Step 3: Write minimal implementation**

Add `kvDelMany(keys)` to delete unique existing manifest entries, total their logical bytes, save the manifest once, and return `{ count, bytes }`. Export it from `createFileKv()`.

- [x] **Step 4: Run test to verify it passes**

Run the Task 1 command and expect all `file-kv` tests to pass.

### Task 2: Safe orphan planner and server route

**Files:**
- Create: `server/node/orphan-cleanup.cjs`
- Create: `server/node/orphan-cleanup.test.ts`
- Modify: `server/node/server.cjs`

- [x] **Step 1: Write the failing tests**

Test that the planner preserves assets referenced by global settings, characters, nested personas, modules, image-generation settings, database plugin storage, and separately loaded plugin payloads. Test that it marks only absent asset basenames and Hypa vector payloads whose `value.content` is not equal to or contained in any current summary. Add a source-wiring assertion for authenticated `POST /api/db/orphans/cleanup`, `kvDelMany`, and `gcChunks`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --config vitest.config.server.ts server/node/orphan-cleanup.test.ts`

Expected: FAIL because the helper and route do not exist.

- [x] **Step 3: Write minimal implementation**

Export `collectDatabaseAssetReferences`, `collectNestedAssetReferences`, `collectHypaSummaryTexts`, `findUnreferencedAssets`, and `findUnusedHypaVectors` from the new helper. Register the route so it flushes pending DB writes, initializes the complete chat store, decodes the active database, validates every persistent plugin-storage JSON payload, computes both plans, deletes planned keys in one manifest write, runs physical object GC, and returns category counts and bytes.

- [x] **Step 4: Run tests to verify they pass**

Run the Task 2 command and expect all orphan-cleanup tests to pass.

### Task 3: One-click System settings UI

**Files:**
- Create: `src/lib/Setting/Pages/SystemDashboardCleanup.test.ts`
- Modify: `src/lib/Setting/Pages/SystemDashboard.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [x] **Step 1: Write the failing test**

Assert that the dashboard posts to `/api/db/orphans/cleanup`, uses one `cleanupAllOrphans` handler and one loading state, renders category copy for orphan media, Hypa vectors, and unreachable objects, and does not retain the 50 MiB-only enablement threshold.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/Setting/Pages/SystemDashboardCleanup.test.ts`

Expected: FAIL because the consolidated control is absent.

- [x] **Step 3: Write minimal implementation**

Replace the narrow optimize action with a single primary `고아 데이터 모두 정리` / `Clean up all orphaned data` action. Keep the existing themed panel, show the three cleanup categories in a responsive grid with text labels rather than color alone, confirm before deletion, disable during the request, show the shared loading dialog, display a result toast with each reclaimed category, and reload stats after success.

- [x] **Step 4: Run tests and checks**

Run: `npx vitest run src/lib/Setting/Pages/SystemDashboardCleanup.test.ts`

Run: `npm run check`

Expected: both commands exit 0.

### Task 4: Focused verification

**Files:**
- Verify all files above.

- [x] **Step 1: Run focused suites**

Run: `npx vitest run src/lib/Setting/Pages/SystemDashboardCleanup.test.ts && npx vitest run --config vitest.config.server.ts server/node/file-kv.test.ts server/node/orphan-cleanup.test.ts server/node/no-sqlite-runtime.test.ts`

Expected: all tests pass.

- [x] **Step 2: Verify source quality**

Run: `npm run check:theme-tokens && git diff --check`

Expected: both commands exit 0 with no invalid theme tokens or whitespace errors.
