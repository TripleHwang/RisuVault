# BardWiki Retrieval Reliability Implementation Plan

> **For Codex:** Execute this plan in the current checkout. Preserve all pre-existing uncommitted changes and do not commit them.

**Goal:** Make historical-source candidate count and per-source inquiry token limits configurable, restore direct evidence recall without phrase-specific prompting, and simplify the generation-time continuity instruction.

**Architecture:** Keep the existing local lexical source matcher and inquiry compiler. Pass normalized settings through the current chat request, use source-message provenance to reserve directly linked event evidence, then apply a real tokenizer-based cap to each selected source. Keep hard safety ceilings only at validation boundaries.

**Tech Stack:** TypeScript, Svelte settings UI, Node inquiry server, Vitest/Jest-compatible project tests.

---

### Task 1: Lock regression coverage

**Files:**
- Modify: `src/ts/risubard/historicalSourceRecall.test.ts`
- Modify: `src/ts/risubard/risuBardSettings.test.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-memory-routes.test.ts`

- Add failing tests for candidate-count normalization and forwarding.
- Add a regression where an ordinary question about abducted women must retrieve the directly linked early event despite recent distractors.
- Add a tokenizer assertion that every selected source respects the configured per-source token ceiling.

### Task 2: Add configurable retrieval limits

**Files:**
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Modify: `src/ts/risubard/historicalSourceRecall.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Others/RisuBardCurrentChatSettings.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`
- Modify: `server/node/risubard-memory-routes.cjs`

- Add `historical source candidate count` with a bounded normalization range.
- Add `per-source inquiry token budget` and forward it in the existing token-budget object.
- Preserve backward-compatible defaults for saved chats.

### Task 3: Restore direct historical evidence routing

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Modify: `src/ts/risubard/historicalSourceRecall.ts`

- Remove generic Korean filler terms from lexical scoring and normalize suffixes repeatedly.
- Treat source-message provenance linked to a candidate event as historical evidence even without an explicit “remember” phrase.
- Reserve directly linked evidence before generic recency/context candidates.
- Apply the configured per-source token cap with the inquiry tokenizer.

### Task 4: Reduce prompt micromanagement

**Files:**
- Modify: `src/ts/risubard/narrativeContext.ts`
- Test: `src/ts/risubard/narrativeContext.test.ts`

- Replace the multi-case evidence checklist with a compact general continuity principle.
- Retain only the authority order needed to prevent supported facts from being contradicted.

### Task 5: Validate and document the contract

**Files:**
- Modify: `project_wiki/bounded_context_architecture.md`
- Modify: `project_wiki/inquiry_context_compiler.md`
- Modify: `project_wiki/markdown_narrative_wiki.md`

- Update fixed-limit wording to describe user-configurable limits and safety ceilings.
- Run only affected unit tests, type checks if needed, and `git diff --check`.
