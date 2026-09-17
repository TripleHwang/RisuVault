# Toggle Preset Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the earlier toggle divergence feedback while preserving RisuBard's isolated per-chat toggle values, and add named preset reset behavior.

**Architecture:** Keep `Chat.GLGlobalVariables` as the live per-chat values and add a separate immutable baseline snapshot containing the applied preset name and values. Direct pinning creates an unnamed/manual baseline; applying a toggle preset creates a named baseline and pins the chat. Difference calculation remains pure and UI formatting resolves raw select indices to visible option labels.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Tailwind theme tokens, tippy.js.

---

### Task 1: Baseline model and comparison

**Files:**
- Create: `src/ts/storage/togglePresetBaseline.ts`
- Create: `src/ts/storage/togglePresetBaseline.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/storage/toggleBinding.test.ts`

- [ ] **Step 1: Write failing pure comparison tests**

Cover cloned baseline snapshots, normalized missing/empty values, changed-key ordering, and current values in differences.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run src/ts/storage/togglePresetBaseline.test.ts`

- [ ] **Step 3: Implement the pure model**

```ts
export interface TogglePresetBaseline {
    name?: string
    values: Record<string, string>
}

export interface ToggleValueDifference {
    key: string
    currentValue: string
    baselineValue: string
}
```

Add `createTogglePresetBaseline()` and `getToggleValueDifferences()` without accessing global state.

- [ ] **Step 4: Write failing storage behavior tests**

Test manual pin baseline creation, named preset application, exact reset, unpin cleanup, and legacy/current pinned-chat normalization.

- [ ] **Step 5: Implement minimal storage operations**

Add `Chat.togglePresetBaseline`, `applyTogglePresetToChat()`, `resetPinnedToggleValues()`, and baseline updates in pin/unpin/migration paths.

- [ ] **Step 6: Run storage tests and verify GREEN**

Run: `pnpm vitest run src/ts/storage/togglePresetBaseline.test.ts src/ts/storage/toggleBinding.test.ts`

### Task 2: Preset provenance wiring

**Files:**
- Modify: `src/lib/Others/AlertComp.svelte`
- Modify: `src/lib/SideBars/TogglePresetManager.svelte` only if its generic callback contract needs provenance support
- Test: `src/ts/storage/toggleBinding.test.ts`

- [ ] **Step 1: Write a failing preset-application test**

Assert that applying a preset pins the chat, replaces live local values, stores the preset name and snapshot, and leaves global values unchanged.

- [ ] **Step 2: Route the character-sidebar preset picker through `applyTogglePresetToChat()`**

The regular row application creates the named baseline. Overwriting a preset from the current pinned chat refreshes that chat's named baseline because both values are now identical.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run: `pnpm vitest run src/ts/storage/toggleBinding.test.ts`

### Task 3: Sidebar reset and divergence UI

**Files:**
- Modify: `src/lib/SideBars/Toggles.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/zh-Hant.ts`
- Modify: `src/styles/tooltip-theme.css`
- Modify: `src/lib/SideBars/CharConfigNavigation.test.ts`

- [ ] **Step 1: Write failing UI contract tests**

Assert the reset icon, baseline name, difference count, multiline tooltip construction, and dirty-row class contract exist.

- [ ] **Step 2: Implement the compact control row**

Pinned layout: `[pin + baseline name + Δcount] [reset] [preset folder]`. Manual baselines display `직접 설정`; reset is disabled when unchanged.

- [ ] **Step 3: Format human-readable differences**

Flatten grouped toggles into key metadata. Show each tooltip line as `[label] = "current value"`; resolve select indices to option labels and fall back to raw keys for unavailable options.

- [ ] **Step 4: Mark dirty rows**

Apply the theme danger color to every text-bearing descendant of a changed toggle row without changing switch-track semantics.

- [ ] **Step 5: Run UI tests and verify GREEN**

Run: `pnpm vitest run src/lib/SideBars/CharConfigNavigation.test.ts src/ts/storage/togglePresetBaseline.test.ts src/ts/storage/toggleBinding.test.ts`

### Task 4: Verification

**Files:**
- Verify only the files above; preserve unrelated working-tree changes.

- [ ] **Step 1: Run related tests**

Run: `pnpm vitest run src/lib/SideBars/CharConfigNavigation.test.ts src/ts/storage/togglePresetBaseline.test.ts src/ts/storage/toggleBinding.test.ts src/ts/parser/tests/chatVar.svelte.test.ts`

- [ ] **Step 2: Run Svelte diagnostics**

Run: `pnpm check`

- [ ] **Step 3: Inspect final diff**

Run: `git diff --check` and inspect only the requested files for accidental edits.
