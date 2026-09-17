# Grimoire–BardWiki Entity Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Grimoire or legacy character-scope lore selects model-visible character identity information, retrieve that character's unique BardWiki canonical page in the same response request so static identity and current story state arrive together.

**Architecture:** The lore prompt loader returns bounded typed entity hints containing only names and aliases from model-visible character-scope lore, never lore body or Grimoire summary text. The existing BardWiki inquiry request resolves each hint against active character document titles and aliases, accepts only unique matches, and ranks those documents as direct candidates inside existing document and token budgets.

**Tech Stack:** TypeScript, Svelte, Node HTTP routes, Vitest

---

### Task 1: Reproduce the disconnected retrieval

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `src/ts/risubard/HistoricalSourceRecallConnections.test.ts`

- [x] Add a test where `currentInput` contains no character name, an entity hint contains `Haania`, `Hania`, `하니아`, and `Hanya`, and the unique `characters/하니아.md` page is selected.
- [x] Add a test proving an ambiguous shared alias does not select either character page.
- [x] Add client and connection assertions proving bounded `entityHints` are serialized from the selected Grimoire result into the inquiry request.
- [x] Run the three targeted test files and confirm failure because `entityHints` is not implemented.

### Task 2: Add the bounded entity handoff

**Files:**
- Modify: `src/ts/process/lorebook.svelte.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `server/node/risubard-markdown-inquiry.ts`

- [x] Return `bardWikiEntityHints` from model-visible character-scope lore: typed Grimoire `character` entries use name and Bard aliases; legacy entries use comment and activation keys. Deduplicate and bound both paths.
- [x] Pass at most 12 hints to `loadNarrativeInquiry` without changing `currentInput` or historical-source matching.
- [x] Validate each hint as `{ kind: 'character', names: string[] }`, with at most 12 hints, 16 names per hint, and 128 characters per name.
- [x] Resolve hints only against eligible character document titles and aliases; add a document only when exactly one active page matches any supplied exact normalized name.
- [x] Merge resolved pages into direct candidates with deterministic scoring while retaining current document-count and token budgets.
- [x] Re-run the targeted tests and confirm they pass.

### Task 3: Record the contract and verify

**Files:**
- Modify: `project_wiki/bard_lore_architecture.md`
- Modify: `project_wiki/inquiry_context_compiler.md`
- Modify: `project_wiki/context_pipeline_architecture.md`

- [x] Document that model-visible Grimoire character selection supplies bounded metadata-only BardWiki hints, while lore body and summary never become inquiry text.
- [x] Document unique title/alias resolution, ambiguity rejection, and existing budget enforcement.
- [x] Run targeted Grimoire, narrative-context, inquiry, route, and connection tests.
- [x] Run `git diff --check` and inspect the final diff for unrelated changes.
