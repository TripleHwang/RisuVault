# Startup and Character Loading Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce time to the usable app shell and character chat display without changing the persisted data format.

**Architecture:** Keep the compatibility database contract for this phase, but remove redundant whole-database work, keep default cleanup scans prefix-bounded, lazy-load the settings workspace, skip already-satisfied character migrations, and fetch remaining chat pages concurrently after the first page establishes the total. Preserve correctness by keeping plugin initialization blocking until a later guarded-shell change can explicitly disable plugin-dependent actions.

**Tech Stack:** Svelte 5, TypeScript, Node.js, Vitest.

---

### Task 1: Remove redundant bootstrap work

**Files:**
- Create: `src/ts/bootstrapPerformance.test.ts`
- Modify: `src/ts/bootstrap.ts`

- [x] **Step 1: Write the failing source-contract test**

Assert that bootstrap passes decoded data directly to `setPatchSyncBaseline`, does not log the decoded database, and does not request an unprefixed storage key list when automatic asset cleanup is disabled.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ts/bootstrapPerformance.test.ts`
Expected: FAIL on the nested clone, decoded-object log, and unprefixed `keys()` call.

- [x] **Step 3: Implement the minimum change**

Replace `setPatchSyncBaseline(safeStructuredClone(decoded))` with `setPatchSyncBaseline(decoded)`, remove `console.log(decoded)`, and make `cleanChunks()` request `remotes/` only by default. When automatic asset cleanup is enabled, additionally request `assets/` and `cache/plugin-storage/` and combine those bounded lists.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ts/bootstrapPerformance.test.ts`
Expected: PASS.

### Task 2: Skip character migrations when data is already normalized

**Files:**
- Create: `src/ts/characterRuntime.ts`
- Create: `src/ts/characterRuntime.test.ts`
- Modify: `src/ts/characters.ts`

- [x] **Step 1: Write failing behavior tests**

Define `needsCharacterRuntimeNormalization(character)` tests showing that a fully normalized character returns `false`, while missing active chat data, chat IDs, lore versions, or required runtime collections return `true`.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ts/characterRuntime.test.ts`
Expected: FAIL because the helper does not exist.

- [x] **Step 3: Implement and wire the helper**

Add the pure predicate and update `changeChar()` to call `characterFormatUpdate()` only when it returns `true`; otherwise update only `lastInteraction`. This preserves legacy repair while avoiding repeated lore rewriting and whole-chat normalization for current data.

- [x] **Step 4: Run focused tests**

Run: `npx vitest run src/ts/characterRuntime.test.ts src/ts/characterCards.test.ts`
Expected: PASS.

### Task 3: Fetch chat pages with bounded concurrency

**Files:**
- Modify: `src/ts/storage/chatContentPage.ts`
- Modify: `src/ts/storage/chatContentPage.test.ts`
- Modify: `src/ts/storage/nodeStorage.ts`

- [x] **Step 1: Write failing page-plan tests**

Add tests for `remainingChatContentPageOffsets(total, firstPageCount, pageSize)` covering one-page, partial-final-page, and invalid-size inputs.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ts/storage/chatContentPage.test.ts`
Expected: FAIL because the helper does not exist.

- [x] **Step 3: Implement bounded parallel fetching**

Fetch offset zero first, calculate remaining offsets, then load them through a small worker pool (maximum four concurrent local requests), sort pages by offset, and assemble exactly as before.

- [x] **Step 4: Run storage tests**

Run: `npx vitest run src/ts/storage/chatContentPage.test.ts`
Expected: PASS.

### Task 4: Lazy-load the settings workspace

**Files:**
- Create: `src/App.performance.test.ts`
- Modify: `src/App.svelte`

- [x] **Step 1: Write the failing source-contract test**

Assert that `App.svelte` no longer statically imports `Settings.svelte` and instead loads it with `import('./lib/Setting/Settings.svelte')` only when `settingsOpen` becomes true.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/App.performance.test.ts`
Expected: FAIL because Settings is statically imported.

- [x] **Step 3: Implement the lazy component boundary**

Track a nullable settings component constructor, start one cached dynamic import from an effect when settings opens, and render the loaded component or the existing lightweight loading state.

- [x] **Step 4: Run the test and build**

Run: `npx vitest run src/App.performance.test.ts`
Run: `npm run check`
Run: `npm run build`
Expected: all commands exit 0 and the production build emits Settings as a separate chunk.

### Task 5: Focused verification

**Files:**
- Verify all files above.

- [x] **Step 1: Run focused suites**

Run: `npx vitest run src/ts/bootstrapPerformance.test.ts src/ts/characterRuntime.test.ts src/ts/characterCards.test.ts src/ts/storage/chatContentPage.test.ts src/App.performance.test.ts`
Expected: PASS.

- [x] **Step 2: Verify source quality**

Run: `git diff --check`
Expected: exit 0.
