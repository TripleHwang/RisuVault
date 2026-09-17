# Commonplace Profile Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extracted commonplace profiles safely renameable, deletable, and fully editable at block level without breaking their stable profile references.

**Architecture:** Keep `PromptBlockOverlayProfile.id` stable and expose pure immutable profile-editing helpers in `promptBlockOverlay.ts`. The existing workspace mutates the global profile list only through those helpers; block reorder keeps existing rule signatures resolvable, duplication assigns a unique display name, and deletion removes the selected profile without cascading into unrelated saved application presets.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest, existing RisuBard theme and resize primitives.

---

### Task 1: Immutable profile editing helpers

**Files:**
- Modify: `src/ts/promptBlockOverlay.ts`
- Test: `src/ts/promptBlockOverlay.test.ts`

- [x] **Step 1: Write failing helper tests**

Add tests that rename a profile while preserving its ID, edit the correct text-bearing field, duplicate a block with an independent copy, delete one block, and move blocks without mutating the input profile.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `.\node_modules\.bin\vitest.cmd run src/ts/promptBlockOverlay.test.ts`

Expected: failures for missing profile editing helpers.

- [x] **Step 3: Implement immutable helpers**

Add `renamePromptBlockOverlayProfile`, `updatePromptBlockOverlayProfileBlockText`, `duplicatePromptBlockOverlayProfileBlock`, `deletePromptBlockOverlayProfileBlock`, and `movePromptBlockOverlayProfileBlock`. Use the existing prompt text field precedence (`text`, `innerFormat`, `defaultText`) and clone every changed item.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run the same Vitest command and require all tests to pass.

### Task 2: Profile and block editor UI

**Files:**
- Modify: `src/lib/Setting/Pages/PromptPreset/PromptBlockOverlayWorkspace.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`
- Test: `src/lib/Setting/Pages/PromptPreset/PromptBlockOverlayWorkspace.test.ts`

- [x] **Step 1: Write failing workspace contract assertions**

Assert that the workspace exposes profile rename/delete, block edit/duplicate/delete/move handlers, editable textareas, and source-rule lookup through `resolvePromptBlockOverlayReference`.

- [x] **Step 2: Run the workspace test and confirm RED**

Run: `.\node_modules\.bin\vitest.cmd run src/lib/Setting/Pages/PromptPreset/PromptBlockOverlayWorkspace.test.ts`

Expected: failure for missing editor controls.

- [x] **Step 3: Implement the editor**

Add a compact profile toolbar to the mapping panel, per-block action buttons, a foldable textarea editor, and responsive action wrapping. Keep destructive profile/block deletion explicit and preserve unrelated saved application presets.

- [x] **Step 4: Run workspace tests and Svelte diagnostics**

Run the focused Vitest test, then `.\node_modules\.bin\svelte-check.cmd --tsconfig ./tsconfig.json`.

### Task 3: Release note and focused verification

**Files:**
- Modify: `patchnote/0.9.31.md`

- [x] **Step 1: Document user-visible profile editing**

Add one concise bullet covering profile rename/delete and block content, duplication, deletion, and ordering.

- [x] **Step 2: Run focused regression and theme tests**

Run the prompt overlay, storage, runtime, workspace, Prompt V2, and theme contract Vitest files.

- [x] **Step 3: Check the final diff**

Run `git diff --check` against only the files changed for this feature and report any remaining manual UI validation.
