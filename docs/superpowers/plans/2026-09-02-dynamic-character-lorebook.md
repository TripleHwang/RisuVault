# Dynamic Character Lorebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore character canon as durable, dynamic lorebook pages and use compact turning-point maps plus a dedicated event-recall token lane for detailed historical answers.

**Architecture:** Character pages prefer a current snapshot and durable reference sections, but exact headings are not persistence gates. Story history becomes an optional 3–6 item route map; detailed chronology remains in immutable event notes. Inquiry keeps its absolute cap while reserving a configurable event lane for historical/detail requests. Structured canonical rewrites use JSON when available and fall back to safe single-document H3 Markdown patches.

**Tech Stack:** TypeScript, Svelte, Node routes, Markdown files, Vitest, Ollama JS.

---

### Task 1: Character lorebook contract

**Files:**
- Modify: `src/ts/risubard/risuBardSettings.test.ts`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/SKILL.md`
- Modify: `server/node/risubard-memory-analysis.ts`

- [ ] **Step 1: Write failing policy tests**

Assert that the canonical policy recommends `현재 상태`, describes durable reference sections, makes `작중 행적` optional, limits it to 3–6 major turning points, and sends routine action detail to event documents.

- [ ] **Step 2: Write a failing persistence regression**

Return a valid new character section patch without `현재 상태`; assert the document is saved and no structure-repair retry is issued. Load an old character without that heading during additional analysis; assert absence alone does not create a canonical update candidate.

- [ ] **Step 3: Run focused tests and verify RED**

Run `node_modules/.bin/vitest.cmd run src/ts/risubard/risuBardSettings.test.ts --config vitest.config.ts` and `node_modules/.bin/vitest.cmd run server/node/risubard-memory-analysis.test.ts --config vitest.config.server.ts`. Expect assertions based on the old mandatory contract to fail.

- [ ] **Step 4: Implement the soft contract**

Remove the current-state persistence rejection and missing-section repair candidate. Keep current-state normalization only as best-effort for a new document whose model returned an overview. Rewrite the model policies so stable identity, traits, abilities, relationships, knowledge, goals, possessions, constraints, and open continuity are the main content; history is an optional concise route map.

- [ ] **Step 5: Re-run focused tests and verify GREEN**

Expect all updated policy and memory-analysis tests to pass.

### Task 2: Safe Markdown fallback for canonical rewrites

**Files:**
- Modify: `server/node/risubard-markdown-section-patch.test.ts`
- Modify: `server/node/risubard-markdown-section-patch.ts`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts`

- [ ] **Step 1: Write failing parser tests**

Specify `parseCanonicalSectionPatchMarkdown(text)` so only direct H3 sections outside fences become `upsert` patches. Reject frontmatter, H1/H2 titles, prose before the first H3, duplicate headings, and empty output.

- [ ] **Step 2: Verify RED**

Run the section-patch test and expect the missing export to fail.

- [ ] **Step 3: Implement the minimal safe parser**

Reuse the existing fence-aware heading scanner. Preserve each H3 body verbatim after trimming and reject peer/title headings inside a section.

- [ ] **Step 4: Add and verify canonical fallback RED**

Make a single-target JSON response fail validation, then return H3 Markdown on retry. Assert the saved document contains the patch and the retry request has `format: 'markdown'` with no response schema.

- [ ] **Step 5: Implement and verify GREEN**

Keep JSON Schema for the first batch request. On a single-target validation retry, request Markdown and parse it through the safe parser. Multi-target failures continue splitting before any writes.

### Task 3: Dedicated event-recall token lane

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Modify: `src/ts/risubard/risuBardSettings.test.ts`
- Modify: `src/ts/risubard/risuBardSettings.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `src/ts/process/index.svelte.ts`

- [ ] **Step 1: Write failing inquiry tests**

Given a character turning-point map linked to several event notes, a chronology/detail query must select the character map plus relevant events until the event lane is full, never exceed the absolute maximum, never select unrelated events, and report selected event tokens. A present-state query must not activate the lane.

- [ ] **Step 2: Verify RED**

Run the inquiry test; expect chronology to return only the character summary under the current code.

- [ ] **Step 3: Implement lane selection**

Add an `events` member to the normalized inquiry budget, defaulting to 2,000 tokens and clamped to the absolute maximum. For historical, causal, detail, or chronology intent, select non-event map anchors under the normal target, then linked/scored events under the dedicated event budget while keeping total selected tokens within `maximum`. Remove the fixed two-event reservation and the chronology event exclusion.

- [ ] **Step 4: Propagate and validate the budget**

Carry `{ target, maximum, events }` through chat settings, browser inquiry, route validation, service input, analysis/reboot inputs, and metrics. Reject malformed values at the HTTP boundary.

- [ ] **Step 5: Verify GREEN**

Run inquiry, narrative-context, settings, and memory-route tests.

### Task 4: Legacy Ollama structured request contract

**Files:**
- Create: `src/ts/process/request/ollamaRequest.test.ts`
- Create: `src/ts/process/request/ollamaRequest.ts`
- Modify: `src/ts/process/request/request.ts`

- [ ] **Step 1: Write failing request-builder tests**

Assert that an internal non-streaming request forwards JSON Schema as `format`, `maxTokens` as `options.num_predict`, temperature, and `stream: false`; an ordinary streaming request remains streaming.

- [ ] **Step 2: Verify RED**

Run the new test and expect the missing helper to fail.

- [ ] **Step 3: Implement the pure builder and adapter branch**

Build the Ollama request from the existing request arguments. For `stream: false`, return a normal success result with content and finish reason; for streaming, preserve the current stream wrapper. Forward the abort signal through the supported Ollama client request option or abort the client when the signal fires.

- [ ] **Step 4: Verify GREEN**

Run the new test and affected request tests.

### Task 5: Settings, documentation, and quality gate

**Files:**
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Others/RisuBardCurrentChatSettings.svelte`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/help.ko.ts`
- Modify: `src/lang/help.en.ts`
- Modify: `docs/ko/memory-wiki.md`
- Modify: `../project_wiki/markdown_narrative_wiki.md`
- Modify: `../project_wiki/inquiry_context_compiler.md`
- Modify: `../project_wiki/bounded_context_architecture.md`
- Modify: `../project_wiki/context_pipeline_architecture.md`

- [ ] **Step 1: Add the event-budget setting**

Expose the shared `위키 사건 조회 토큰` value with a 256-token step and document that it activates only for history/detail intent inside the absolute inquiry cap.

- [ ] **Step 2: Update canonical documentation**

Replace the mandatory current-state/history contract with the dynamic-lorebook contract and describe arc/turning-point maps routing into separately budgeted event evidence.

- [ ] **Step 3: Run affected test modules**

Run settings, inquiry, routes, section patches, memory analysis, narrative context, request/Ollama, and relevant source-excerpt tests.

- [ ] **Step 4: Run static and diff checks**

Run `pnpm check` if focused tests pass, then `git diff --check`, inspect only task-related files, and perform an adversarial review of budget edges, malformed Markdown, multi-target retries, and legacy-provider behavior.

- [ ] **Step 5: Update issue #3**

Post test results and completed acceptance criteria. Do not commit or push unless explicitly requested.
