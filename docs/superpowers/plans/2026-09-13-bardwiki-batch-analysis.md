# BardWiki Batch Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BardWiki tool flyout whose Batch analysis action processes every active unconfirmed assistant turn in one semantic-analysis request, while renaming the context settings as turn counts and respecting analysis user-message inclusion.

**Architecture:** Reuse the existing multi-turn reboot draft and recovery checkpoint path against the current chat workspace. A pure projection helper fixes the target assistant IDs at invocation time, adds the configured number of preceding turns as context, and removes user messages when analysis inclusion is disabled. Event documents remain turn-scoped; shared semantic fields drive the existing canonical rewrite batches.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Node filesystem services.

---

### Task 1: Turn-based context projection

**Files:**
- Modify: `src/ts/risubard/narrativeContext.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.ts`
- Test: `src/ts/risubard/narrativeContext.test.ts`
- Test: `src/ts/risubard/memoryAnalysisClient.test.ts`

- [ ] Write failing tests showing a limit of two selects two assistant turns plus their user messages, and that excluding users retains only the required current response user input in response generation while analysis projection removes users.
- [ ] Run the two targeted test files and confirm the new assertions fail under message-count slicing.
- [ ] Change the selectors to count assistant turns instead of raw messages, preserving the first-message boundary.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 2: Pending Batch analysis projection and execution

**Files:**
- Create: `src/ts/risubard/wikiBatchAnalysis.ts`
- Create: `src/ts/risubard/wikiBatchAnalysis.test.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`

- [ ] Write failing projection tests for all active unconfirmed assistant turns, chronological source groups, preceding context turns, de-duplication, and analysis user-message exclusion.
- [ ] Run the new test file and confirm it fails because the helper is missing.
- [ ] Implement `projectPendingWikiBatch` and connect `batchCurrentNarrativeWikiUpdate` to the existing analysis runner, checkpoint recovery, chat receipt persistence, and checkpoint cleanup. If there are no unconfirmed turns, retain the old latest-turn missing-candidate analysis behavior.
- [ ] Re-run the projection and process connection tests.

### Task 3: Generalize the existing multi-turn schema and recovery boundary

**Files:**
- Modify: `server/node/risubard-memory-writer.ts`
- Modify: `server/node/risubard-memory-writer.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-markdown-wiki.test.ts`

- [ ] Write failing tests for a three-turn structured response and recovery checkpoint.
- [ ] Run the targeted server tests and confirm the two-turn limits cause the expected failures.
- [ ] Make the runtime-provided turn count exact in the JSON schema/parser and allow a bounded chat-sized list of recovery source groups. Add a prompt requirement that shared state represents the chronological final state after the last target turn.
- [ ] Re-run the targeted server tests.

### Task 4: Tool flyout and settings wording

**Files:**
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryWikiForceUpdate.test.ts`
- Modify: `src/lib/Others/RisuBardCurrentChatSettings.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/zh-Hant.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`
- Modify: `src/lang/help.zh-Hant.ts`

- [ ] Write failing UI tests for one `도구 모음` trigger, click/hover opening, outside-click closing, and the three large actions ordered Batch analysis, Wiki reboot, Find/replace.
- [ ] Write failing wording assertions for `분석할 턴 수`, `응답용 턴 수`, `응답 사용자 메시지`, and `분석 사용자 메시지`.
- [ ] Run the targeted component/settings tests and confirm the failures.
- [ ] Implement the accessible downward flyout with existing theme tokens and move the three actions into it. Update localized labels and help text without renaming persisted setting keys.
- [ ] Re-run the targeted UI/settings tests.

### Task 5: Canonical documentation and release note

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/bounded_context_architecture.md`
- Modify: `project_wiki/settings_workspace_architecture.md`
- Modify: `project_wiki/context_pipeline_architecture.md`
- Modify: `project_wiki/decision_log.md`
- Modify: `patchnote/0.9.31.md`

- [ ] Record the approved Batch analysis, turn-count, user-message, event separation, cumulative final-state, and explicit token-limit failure contracts.
- [ ] Add one user-facing patch-note entry without duplicating existing changes.

### Task 6: Focused verification

**Files:**
- Verify only.

- [ ] Run the affected client and server Vitest files.
- [ ] Run `pnpm check` and `pnpm check:theme-tokens`.
- [ ] Run `git diff --check` and inspect the scoped diff, preserving unrelated worktree changes.
