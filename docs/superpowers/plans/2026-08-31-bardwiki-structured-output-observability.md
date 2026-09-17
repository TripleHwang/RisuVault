# BardWiki Structured Output and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PageFold-backed BardWiki canonical rewrites reliably satisfy the required document contract and record any workflow-level validation failure with its real reason.

**Architecture:** PageFold will validate successful structured-output text against the host-provided JSON Schema before reporting success, so malformed provider output becomes an explicit provider failure. RisuBard will retain its semantic Markdown checks, add a deterministic evidence-preserving recovery for a missing required character current-state section, and publish workflow outcomes separately from LLM transport outcomes.

**Tech Stack:** JavaScript PageFold plugin, TypeScript, Svelte stores, Vitest.

---

### Task 1: Enforce PageFold structured output

**Files:**
- Modify: `<workspace>/pagefold-0.2.2.js`
- Create: `<workspace>/pagefold-0.2.2.test.cjs`

- [ ] **Step 1: Write the failing test**

  Execute the plugin in a VM with mocked Risu APIs and assert that a structured request whose upstream response violates `response_schema.schema` returns `success: false` with a bounded schema path, while valid JSON is returned byte-for-byte.

- [ ] **Step 2: Run test to verify it fails**

  Run `node <workspace>/pagefold-0.2.2.test.cjs` and expect the invalid response assertion to fail because PageFold currently trusts any non-empty structured text.

- [ ] **Step 3: Write minimal implementation**

  Add a local JSON parser/schema validator supporting the schema keywords emitted by RisuBard (`type`, `required`, `properties`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minimum`, `maximum`, `enum`, and string length bounds). Validate `result.text` only when `args.response_schema?.schema` exists; return an explicit failed provider response on malformed JSON or schema mismatch.

- [ ] **Step 4: Run test to verify it passes**

  Run `node <workspace>/pagefold-0.2.2.test.cjs` and expect all assertions to pass.

### Task 2: Recover safe canonical character output

**Files:**
- Modify: `server/node/risubard-memory-analysis.ts`
- Test: `server/node/risubard-memory-analysis.test.ts`

- [ ] **Step 1: Write the failing test**

  Add a regression where a new character rewrite returns verified sections without `현재 상태` twice. Expect the runner to construct `현재 상태` from an evidence-backed non-history section instead of discarding the entire turn; if no safe section exists, expect a precise validation warning.

- [ ] **Step 2: Run test to verify it fails**

  Run `pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts` and expect no canonical document to be saved.

- [ ] **Step 3: Write minimal implementation**

  Add a pure recovery helper that only reuses model-returned content from a non-history upsert section for a new character document. Do not synthesize facts, weaken existing-document hash checks, or bypass schema parsing.

- [ ] **Step 4: Run test to verify it passes**

  Re-run the focused server test and expect the recovered document to contain a direct `### 현재 상태` section.

### Task 3: Record workflow-level failures and reasons

**Files:**
- Modify: `src/ts/risubard/canonicalTurnReceipt.ts`
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/risubard/memoryActivity.ts`
- Test: `src/ts/risubard/canonicalTurnReceipt.test.ts`
- Test: `src/ts/risubard/memoryActivity.test.ts`
- Test: `server/node/risubard-memory-analysis.test.ts`

- [ ] **Step 1: Write failing tests**

  Assert that semantic validation is categorized as `응답 형식 오류`, the bounded validation reason is retained in the receipt, and a receipt with a canonical failure publishes a BardWiki error activity even though the underlying LLM requests completed successfully.

- [ ] **Step 2: Run tests to verify they fail**

  Run the three focused test files and expect the old generic `공급자 응답 오류` warning and missing activity event assertions to fail.

- [ ] **Step 3: Write minimal implementation**

  Preserve a sanitized bounded error reason in the receipt warning, distinguish output validation from transport/provider errors, and publish a workflow error activity from the returned receipt before clearing confirmation state. Keep request activity entries as transport-level records.

- [ ] **Step 4: Run tests to verify they pass**

  Re-run the focused tests and expect all assertions to pass.

### Task 4: Verify the affected slice

- [ ] Run the PageFold VM test.
- [ ] Run focused plugin structured-output, canonical receipt, memory activity, memory analysis, and request status tests.
- [ ] Run `pnpm check` if focused tests pass.
- [ ] Run `git diff --check` and inspect only task-related diffs. Do not commit because the working tree contains unrelated user changes.
