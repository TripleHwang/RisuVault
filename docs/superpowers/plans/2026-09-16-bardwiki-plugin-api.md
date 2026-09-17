# BardWiki Plugin API Implementation Plan

> **For Codex:** Execute this plan in the current checkout. Do not create a worktree. Preserve unrelated user changes.

**Goal:** Make BardWiki context available to legacy long-term-memory plugins and expose a documented, current-chat-scoped BardWiki read/write API.

**Architecture:** Add a BardWiki plugin bridge that compiles retrieved wiki context and the configured recent-message window into one virtual memory payload. Decorate only Plugin API snapshots, remove the virtual payload from every write path, and expose explicit BardWiki functions through API v3 aliases. Reuse the existing inquiry, view, manual-save, context-mode, and trash endpoints.

**Tech Stack:** TypeScript, Svelte plugin API v3, Vitest, existing RisuBard memory endpoints.

---

### Task 1: Lock virtual-memory behavior with tests

**Files:**
- Create: `src/ts/risubard/pluginBardWiki.test.ts`
- Create: `src/ts/risubard/pluginBardWiki.ts`

- [x] Test that one identical virtual payload is projected into `hypaV3Data.summaries`, `hypaV2Data.mainChunks`, and `supaMemoryData` without mutating the source chat.
- [x] Test that projection markers are removed before plugin data is persisted while genuine memory remains intact.
- [x] Test that recent messages follow BardWiki response settings, including keeping the latest user message when historical user messages are excluded.
- [x] Implement the smallest pure helpers needed to pass these tests.

### Task 2: Build the BardWiki context and document service

**Files:**
- Modify: `src/ts/risubard/pluginBardWiki.ts`
- Modify: `src/ts/risubard/pluginBardWiki.test.ts`

- [x] Test context retrieval with injected inquiry dependencies and the no-document fallback.
- [x] Test document listing and write operations with mocked fetch/auth dependencies.
- [x] Implement current-chat-scoped `getContext`, `getDocuments`, `saveDocument`, `setContextMode`, and `trashDocument` services by reusing existing clients.
- [x] Make compatibility retrieval fail open so a BardWiki server error never breaks a plugin's normal character or chat access.

### Task 3: Wire compatibility and the public API into Plugin API v3

**Files:**
- Modify: `src/ts/plugins/apiV3/v3.svelte.ts`
- Modify: `src/ts/plugins/plugins.svelte.ts` only if a shared type boundary requires it
- Modify: `src/ts/plugins/risuai.d.ts`
- Modify: `src/ts/plugins/apiV3/pluginPermissionQueue.test.ts`
- Create: `src/ts/plugins/pluginBardWikiApiContract.test.ts`
- Modify: relevant language files under `src/lang/`

- [x] Add contract tests for BardWiki aliases, public typings, virtualized getters, sanitized setters, and write permission.
- [x] Decorate `getChar`, `getCharacter`, indexed character/chat getters, and selected-character database snapshots.
- [x] Sanitize all corresponding setter paths so virtual memory cannot enter persisted chat state.
- [x] Add the nested `Risuai.bardWiki` API and require a dedicated permission only for write operations.
- [x] Add Korean and supported fallback consent text.

### Task 4: Publish the developer reference and verify

**Files:**
- Create: `docs/ko/bardwiki-plugin-api.md`
- Modify: `README.md`
- Modify: `patchnote/0.9.36.md`

- [x] Document compatibility behavior, the recent-message policy, every API method, examples, permissions, errors, and persistence guarantees.
- [x] Link the reference from the README documentation table.
- [x] Add one user-facing patch note entry without duplicating earlier changes.
- [x] Run focused Vitest files, TypeScript checking if available for the affected package, and `git diff --check`.
- [x] Review the final diff and preserve all unrelated working-tree changes.
