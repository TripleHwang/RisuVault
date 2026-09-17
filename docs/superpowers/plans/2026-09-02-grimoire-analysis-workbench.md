# Grimoire Analysis Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Grimoire AI-analysis dialog into a two-pane settings and target-selection workbench with reusable defaults, adaptive recommendations, help, filtering, hierarchy, and run status.

**Architecture:** Keep analysis settings on each `BardLoreState`, store only the five reusable analysis defaults in the app database, and apply those defaults when a Grimoire is first created. Put recommendation and settings-copy rules in a small pure module so the UI remains testable. Preserve the existing analysis planner/run pipeline; the dialog only chooses which eligible entries are passed into it.

**Tech Stack:** Svelte 5, TypeScript, Vitest, happy-dom, existing RisuBard theme tokens and Solar SVG assets.

---

### Task 1: Analysis defaults and recommendations

**Files:**
- Create: `src/ts/lorebook/bardLoreAnalysisSettings.ts`
- Create: `src/ts/lorebook/bardLoreAnalysisSettings.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/lib/SideBars/LoreBook/LoreBookSetting.svelte`

- [ ] Write tests proving that only the five analysis fields are copied, recommendations react to target count and estimated input, and temperature/depth recommendations are `0.2`/`1`.
- [ ] Run `pnpm vitest run src/ts/lorebook/bardLoreAnalysisSettings.test.ts` and confirm the missing-module failure.
- [ ] Implement `pickBardLoreAnalysisSettings`, `applyBardLoreAnalysisSettings`, `normalizeBardLoreAnalysisDefaults`, and `recommendBardLoreAnalysisSettings`.
- [ ] Add `risuBardGrimoireAnalysisDefaults` to `Database`, normalize it during database loading, save it from the dialog, and use it when creating a new Grimoire.
- [ ] Re-run the targeted test and confirm it passes.

### Task 2: Target selection model and status

**Files:**
- Modify: `src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.test.ts`
- Modify: `src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.svelte`

- [ ] Add component tests for type filtering, folder/child display order, select-all/select-none, row click, drag painting, and selected-only planning.
- [ ] Run `pnpm vitest run src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.test.ts` and confirm the new tests fail for missing controls.
- [ ] Track available targets separately from selected target IDs, replan from selected targets, and render folder rows plus eligible items in the same display order as the main Grimoire.
- [ ] Derive pending/running/completed/failed entry status from the persisted run batches; render text as well as semantic name color.
- [ ] Re-run the component tests and confirm they pass.

### Task 3: Two-pane dialog and field help

**Files:**
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.svelte`
- Create: `src/assets/solar-bold/magic-wand-bold.svg`

- [ ] Add Korean and English labels/help for every analysis setting, actions, table columns, filters, and statuses; rename the section to “AI 분석 설정” and remove the old hint from the rendered UI.
- [ ] Add accessible header actions using the existing diskette asset and Solar magic-wand asset, with visible labels and tooltips.
- [ ] Move settings, scope, estimates, notices, and request controls into a scrollable left pane; place the filterable hierarchical target table in the right pane.
- [ ] Add clickable `?` help controls and the same tooltip text on each setting label.
- [ ] Add a responsive one-column fallback without hiding controls or introducing horizontal page scroll.

### Task 4: Verification

**Files:**
- Verify only the files above.

- [ ] Run the pure settings test and the analysis-panel test.
- [ ] Run `pnpm check` and `pnpm check:theme-tokens`.
- [ ] Run `git diff --check` and inspect the scoped diff for unrelated edits.
