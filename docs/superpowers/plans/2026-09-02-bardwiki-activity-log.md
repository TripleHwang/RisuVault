# BardWiki Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BardWiki activity logs describe normal generations, persisted results, stable request IDs, Wiki evidence, and prompt composition without misleading retry or fragmented range labels.

**Architecture:** Keep the existing append-only request rows and canonical receipts unchanged. Add a deterministic presentation projection shared by the UI and Markdown exporter, merge request rows and receipts only at the UI timeline boundary, and enrich new Wiki evidence names at prompt-source construction time while retaining legacy path fallback.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Node JSONL request-log storage.

---

### Task 1: Lock the presentation contract with failing tests

**Files:**
- Modify: `src/ts/risubard/chatRequestEvidence.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryActivity.test.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`

- [ ] Add an exporter test whose newest row has ID 73 and assert the heading is `요청 #73`, not report-local `요청 1`.
- [ ] Add a manifest projection test with adjacent chat ranges `1~4`, `5~5`, `6~6` and multiple instruction rows; assert one instruction group and one `채팅 기록 6개 (1~6)` group with summed tokens.
- [ ] Change the activity test to assert repeated successful same-purpose rows never contain `응답 시도`.
- [ ] Change the activity test to assert receipt and request cards form one descending timestamp sequence without `확정 작업 결과`.
- [ ] Add a source-label test that expects `사건 · 제목 · <event-id>` for a selected Wiki event.
- [ ] Run `npx vitest run src/ts/risubard/chatRequestEvidence.test.ts src/lib/Others/RisuBardMemoryActivity.test.ts src/ts/risubard/narrativeContext.test.ts` and verify the new assertions fail for the intended missing behavior.

### Task 2: Add the shared injection-manifest presentation projection

**Files:**
- Modify: `src/ts/risubard/chatRequestEvidence.ts`
- Modify: `src/lib/Others/RisuBardMemoryActivity.svelte`

- [ ] Export a pure `groupInjectionManifestItems()` helper that groups instructions, parses chat names shaped like `N개 (A~B)`, unions adjacent ranges, renders singleton positions without `~`, and preserves unparseable legacy names as detail rows.
- [ ] Use the helper for the collapsed token chips, expanded input details, and Markdown table so all three surfaces share the same deterministic labels and totals.
- [ ] Keep raw `RequestInjectionManifest.items` unchanged so token attribution and stored evidence remain backward compatible.
- [ ] Run the two evidence/activity test files and verify the projection tests pass.

### Task 3: Fix request identity and activity chronology

**Files:**
- Modify: `src/ts/risubard/chatRequestEvidence.ts`
- Modify: `src/lib/Others/RisuBardMemoryActivity.svelte`

- [ ] Remove adjacency-based `requestAttempt()` inference and label ordinary cards only by their request purpose.
- [ ] Format Markdown headings with the persisted request row ID: ``## 요청 #${request.id} · ${requestPurposeLabel(...)}``.
- [ ] Build a derived union of canonical receipts and stored request rows, sort it by timestamp descending with stable tie-breaking, and render it in one loop.
- [ ] Retain distinct `AI 요청` and `정본 처리` badges/outcomes while removing the separate all-receipts-first section.
- [ ] Run `npx vitest run src/ts/risubard/chatRequestEvidence.test.ts src/lib/Others/RisuBardMemoryActivity.test.ts` and verify chronology and labeling tests pass.

### Task 4: Include Wiki event title and stable ID in new logs

**Files:**
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/risubard/narrativeContext.test.ts`

- [ ] Extend `narrativeSourceDisplayName()` so a Wiki event with `displayName: '사건 · 네 처녀의 실종'` and source ID ending in `events/turn-4.md` becomes `사건 · 네 처녀의 실종 · turn-4`.
- [ ] Keep non-event Wiki documents and legacy sources without `displayName` on their current fallback labels.
- [ ] Run the narrative-context test and the affected activity test.

### Task 5: Update the canonical observation contract and verify

**Files:**
- Modify: `../project_wiki/context_pipeline_architecture.md`
- Modify: `docs/ko/memory-wiki.md` only where the current dirty documentation already describes the activity log.

- [ ] Replace the old contract that requires inferred response-attempt numbering and a separate result section with stable log IDs and one chronological activity stream.
- [ ] Document grouped instruction/chat presentation and Wiki event title-plus-ID labels without changing provider input or stored prompt bodies.
- [ ] Run the three targeted Vitest files.
- [ ] Run `npx svelte-check --tsconfig ./tsconfig.json` if targeted tests expose no type errors.
- [ ] Inspect `git diff --check` and the exact target-file diff; preserve every unrelated dirty change.
