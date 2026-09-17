# Structured Output Recovery Runtime Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make structured model responses recover consistently through native schema, one corrected native attempt, and one prompt-schema fallback while keeping the same local parser as the final storage gate.

**Architecture:** Add one strict recovery state machine to `risubard-core`. A request adapter explicitly receives either `native` or `prompt` mode; native-schema transport rejection is represented by a typed fallback signal, while malformed successful output is converted to `ModelOutputError` by the existing validator. BardWiki analysis delegates both cases to the shared runtime. Prompt fallback remains single-shot, and all writes remain downstream of the unchanged domain parser.

**Tech Stack:** TypeScript, Vitest, SvelteKit repository tooling.

---

### Task 1: Specify the common recovery state machine

**Files:**
- Modify: `packages/risubard-core/src/modelResponse.test.ts`
- Modify: `packages/risubard-core/src/modelResponse.ts`

1. Add failing tests for native success, corrected-native success, native validation exhaustion followed by prompt fallback, immediate native-schema rejection, terminal prompt failure, and non-replayable failures.
2. Run the focused core test and confirm the new API is absent/failing.
3. Implement `NativeStructuredOutputUnavailableError`, `StructuredOutputMode`, and `runStructuredModelRequest` as a small wrapper around `runValidatedModelRequest`.
4. Re-run the focused core test.

### Task 2: Migrate BardWiki analysis to the common runtime

**Files:**
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.test.ts`

1. Change the model request contract from an ad-hoc boolean to an explicit structured-output mode.
2. Make the client attach native schema only in native mode and throw the typed fallback signal when the provider rejects it.
3. Replace the manual server-side catch/fallback block with `runStructuredModelRequest`.
4. Preserve existing prompt-schema fallback behavior for native provider rejection and the newly added fallback after two semantically invalid native responses.
5. Run focused client and server tests.

### Task 3: Regression verification

**Files:**
- Verify only; no unrelated edits.

1. Run the core model-response tests, BardWiki client tests, and server memory-analysis tests.
2. Run the repository type/Svelte check.
3. Inspect the final diff and confirm unrelated dirty-worktree files were untouched.

