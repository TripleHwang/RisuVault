# Lore Builder Implementation Plan

> Execute this plan in the current `RisuBard-public` checkout. Preserve unrelated working-tree changes.

**Goal:** Add a lore-entry-scoped AI authoring dialog, based on Persona Builder, that lets the user choose injected context and lore-specific prompt presets, then explicitly applies the generated Markdown only to the entry that opened it.

**Architecture:** `LoreBookWorkspace` owns the target entry and opens a child-tier `LoreBuilder`. The builder snapshots only selected system, character, related character-lore, and module-lore sources, excluding the target entry, and sends a non-streaming `lore-builder` request. Lore prompt presets use a separate optional database field so existing Persona Builder presets remain untouched.

**Tech Stack:** Svelte 5, TypeScript, Vitest/happy-dom, existing ShDialog/ShButton components and request pipeline.

---

### Task 1: Lock the authoring contract with failing tests

**Files:**
- Create: `src/ts/loreBuilder.test.ts`
- Create: `src/lib/Others/LoreBuilder.test.ts`
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts`
- Modify: `src/lib/UI/GUI/DialogLayering.test.ts`

- [x] Test that the default prompt requires structured Markdown, factual prose, public/private separation, and output-only behavior.
- [x] Test that unchecked context is omitted and the target lore entry is excluded from related lore sources.
- [x] Test builder controls, loading/error/undo/apply states, scrollable dialog body, and child-tier stacking.
- [x] Test the workspace button opens the builder for a normal lore entry and applying a draft changes only that entry content.
- [x] Run `pnpm vitest run src/ts/loreBuilder.test.ts src/lib/Others/LoreBuilder.test.ts src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts src/lib/UI/GUI/DialogLayering.test.ts` and confirm the new assertions fail for the missing feature.

### Task 2: Add lore-specific prompts, source selection, and presets

**Files:**
- Create: `src/ts/loreBuilder.ts`
- Modify: `src/ts/storage/database.svelte.ts`
- Modify: `src/ts/requestPurpose.ts`

- [x] Define Korean/English lore-writing built-ins modeled on the current structured Grimoire template.
- [x] Collect source snapshots while excluding `targetEntryId` from character and module lore.
- [x] Build tagged system/user messages from selected sources, the current entry draft, and the latest OOC instruction.
- [x] Add CRUD helpers and an optional `loreBuilderPromptPresets` database field.
- [x] Register `lore-builder` as a visible request purpose.
- [x] Run the TypeScript unit test and confirm it passes.

### Task 3: Build the accessible Lore Builder dialog

**Files:**
- Create: `src/lib/Others/LoreBuilder.svelte`
- Create: `src/lib/Others/LorePromptPresetEditor.svelte`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [x] Add task/style preset selection and editing using the lore-only preset store.
- [x] Add explicit context checkboxes; unavailable sources stay disabled and labeled.
- [x] Add instruction, send/stop-state feedback, reset, editable draft, undo, and one clear “apply to current entry” action.
- [x] Use an opaque 90vh child-tier dialog with a scrollable body, visible focus, Escape close, and no outside-click data loss.
- [x] Run the builder and layering tests.

### Task 4: Connect each editable lore entry

**Files:**
- Modify: `src/lib/SideBars/LoreBook/LoreBookWorkspace.svelte`

- [x] Add a “Lore Builder” button beside the content view toggle for normal entries only.
- [x] Commit the current content draft before opening and capture the entry ID/name/content.
- [x] On apply, verify the captured entry still exists and update only its `content`; keep the active draft synchronized.
- [x] Render the builder outside the workspace section so its portal and focus lifecycle remain stable.
- [x] Run the workspace tests.

### Task 5: Focused validation

**Files:**
- Verify only changed files.

- [x] Run the focused Vitest suite from Task 1.
- [x] Run `pnpm check` and `pnpm check:theme-tokens`.
- [x] Use a real Svelte mount interaction test to verify button → child dialog → edit → apply and source contracts for Escape/focus/scroll behavior; Playwright is not installed, so do not add a dependency solely for validation.
- [x] Review `git diff --check` and the scoped diff; do not alter unrelated changes.
