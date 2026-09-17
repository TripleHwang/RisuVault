# BardWiki Creature and Duplicate Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class creature canon type and detect copied canonical prose without increasing retrieval budgets or mutating user content.

**Architecture:** Extend the existing closed document-type unions, schemas, routes, folders, UI, receipts, and writer contract with `creature`. Add a deterministic, bounded health diagnostic that reports exact normalized prose shared by multiple active documents; it only warns and never merges, deletes, or rewrites documents. Strengthen the memory-writer contract so events own historical detail while entity canon owns durable current state and links.

**Tech Stack:** TypeScript, Svelte 5, Node.js, Vitest, Obsidian-compatible Markdown.

---

### Task 1: First-class creature documents

**Files:**
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-memory-writer.test.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: closed type unions and validators under `server/node/` and `src/ts/risubard/`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`

- [x] **Step 1: Write failing tests**

Add tests proving a manual `creature` saves under `creatures/`, a memory-writer candidate accepts `type: "creature"`, and the editor exposes `종족·생물`.

- [x] **Step 2: Verify RED**

Run the three affected Vitest files and confirm failures are caused by the unsupported type.

- [x] **Step 3: Implement the minimum type plumbing**

Add `creature` to every canonical type union, runtime enum, receipt parser, route validator, directory map, command template, editor option, and canonical writer boundary. Read and write it under `creatures/` with `context: auto`.

- [x] **Step 4: Verify GREEN**

Run the same three test files and confirm they pass.

### Task 2: Non-mutating duplicate passage diagnostics

**Files:**
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `src/ts/risubard/memoryWiki.test.ts`
- Modify: `src/ts/risubard/memoryWiki.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`

- [x] **Step 1: Write failing tests**

Add tests for a bounded `duplicatePassages` health result containing stable document-ID pairs when two active documents share the same normalized prose block of at least 80 characters. Prove headings, short boilerplate, link-only paragraphs, and repeated text within one document do not report a pair. Add parser and UI badge/highlight assertions.

- [x] **Step 2: Verify RED**

Run the server, client parser, and editor tests and confirm the new health field is absent.

- [x] **Step 3: Implement deterministic diagnosis**

Extract paragraphs, normalize Unicode and whitespace, ignore headings and link-only blocks, index qualifying blocks by document ID, emit each sorted pair once, and cap output at 64 pairs. Extend the client parser and show `본문 중복 N` plus a non-repairing file-row indication.

- [x] **Step 4: Verify GREEN**

Run the same tests and confirm they pass.

### Task 3: Canon ownership and granularity rules

**Files:**
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/SKILL.md`
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/references/english-contract.md`
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Modify: `../project_wiki/markdown_narrative_wiki.md`

- [x] **Step 1: Write failing contract assertions**

Assert that the locked writer policy names creature registration, independent-location promotion, investigation continuity, and the rule that event detail is linked instead of copied into canon.

- [x] **Step 2: Verify RED**

Run the focused settings and memory-writer contract tests and confirm the required policy text is missing.

- [x] **Step 3: Add concise ownership rules**

Define one canon owner per durable fact: events retain exact historical observations; locations retain durable place state; creatures retain reusable kind rules; variants get separate pages only for durable distinct rules; unresolved cross-event investigations use one compact `other` note with event links. Require named sublocations with independent persistent state or repeated scene use to receive their own location page, while parent pages keep a link summary.

- [x] **Step 4: Verify GREEN**

Run the focused tests and confirm they pass.

### Task 4: Verification and delivery

**Files:**
- Review all modified files.

- [x] **Step 1: Run targeted BardWiki verification**

Run `npm run verify:risubard-memory-wiki` and require zero failures.

- [x] **Step 2: Run static validation**

Run `npm run check` and `git diff --check`; report any pre-existing unrelated failure explicitly.

- [x] **Step 3: Review the diff**

Confirm no retrieval constants changed, no automatic merge/delete was introduced, and all new document paths stay under `creatures/`.

- [ ] **Step 4: Commit and push**

Commit the verified improvement as `feat: add creature canon and duplicate safety` and push `main` with the GitHub account-cycle script.
