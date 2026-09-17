# BARDCHAT Compact Toolbar and Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact BARDCHAT into one toolbar row, prefill command targets from the selected wiki page, expose one-step restore, and keep plugin floating buttons inside the chat pane.

**Architecture:** Keep transient UI state in the existing Svelte dock. Store one process-lifetime BARDCHAT undo snapshot in the Markdown wiki service, verify that the post-command workspace has not changed before restoration, and expose it through the existing authenticated memory routes. Continue using the current theme tokens and plugin FAB placement model.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Node filesystem service, Express-style memory routes.

---

### Task 1: Compact terminal behavior

**Files:**
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.test.ts`
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.svelte`

- [x] Add failing component tests asserting one toolbar row, a one-column context flyout that closes on outside click, a right-aligned run button, an undo icon with tooltip, and selected-document target substitution.
- [x] Run `npx vitest run src/lib/Others/RisuBardWikiCommandTerminal.test.ts` and confirm the new assertions fail for the missing controls.
- [x] Implement the smallest Svelte state, props, markup, and themed styles needed for those assertions.
- [x] Re-run the targeted test and confirm it passes.

### Task 2: One safe BARDCHAT snapshot and New markers

**Files:**
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-memory-runtime.cjs`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `src/ts/risubard/memoryWiki.test.ts`
- Modify: `src/ts/risubard/memoryWiki.ts`
- Modify: `src/ts/risubard/directWikiCommand.test.ts`
- Modify: `src/ts/risubard/directWikiCommand.ts`
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`

- [x] Add failing service tests proving begin/finalize/restore returns the canonical files to their exact prior contents, replaces the single snapshot only after a real change, and rejects restoration after later edits.
- [x] Add failing route/client tests for authenticated begin, finalize, status, and restore calls.
- [x] Add a failing direct-command test proving the snapshot hook runs after model validation and before the first write.
- [x] Add failing dock/editor tests proving applied document IDs replace the previous `New` set and undo survives dock close state.
- [x] Implement the process-lifetime snapshot, HTTP adapters, execution hooks, dock restore action, selected title prop, and explicit badge override.
- [x] Run the affected Vitest files and confirm they pass.

### Task 3: Keep plugin actions out of BardWiki

**Files:**
- Modify: `src/lib/Others/PluginFloatingActionButtons.test.ts`
- Modify: `src/lib/Others/PluginFloatingActionButtons.svelte`

- [x] Add a failing test asserting the floating-button boundary is an absolute overlay owned by the chat pane.
- [x] Run `npx vitest run src/lib/Others/PluginFloatingActionButtons.test.ts` and confirm failure.
- [x] Resolve saved/default/dragged positions against the chat-pane overlay and observe its size.
- [x] Re-run the targeted test, then run `npx svelte-check --tsconfig ./tsconfig.json` for changed Svelte/TypeScript boundaries.
