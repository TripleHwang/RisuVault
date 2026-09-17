# Extension Manager Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let module and plugin managers select multiple cards, drag the selected group to reorder or move folders, clear selection beside search, and delete the selection in one action.

**Architecture:** Keep selection ephemeral inside `CollectionOrganizerList`; persisted collection metadata remains unchanged. Add one pure helper that reorders the visible selected IDs as a stable block, and let each manager own its domain-specific deletion cleanup through a callback.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Tailwind/theme tokens

---

### Task 1: Stable multi-item drag ordering

**Files:**
- Modify: `src/ts/collectionOrganizer.ts`
- Test: `src/ts/collectionOrganizer.test.ts`

- [x] Add failing tests proving that selected visible items move as one stable block before/after the drop target, hidden IDs stay untouched, and dropping on the selected group is a no-op.
- [x] Run `pnpm vitest run src/ts/collectionOrganizer.test.ts` and confirm the missing helper causes the expected failure.
- [x] Implement `reorderCollectionItemDragGroup(visibleItemIds, draggedItemIds, primaryItemId, targetItemId)` by filtering to known visible IDs, preserving visible order, removing the group, then inserting it before an upward target or after a downward target.
- [x] Run the same targeted test and confirm it passes.

### Task 2: Manager selection, card drag handles, and bulk deletion

**Files:**
- Modify: `src/lib/UI/CollectionOrganizerList.svelte`
- Modify: `src/lib/Setting/Pages/Module/ModuleSettings.svelte`
- Modify: `src/lib/Setting/Pages/PluginSettings.svelte`
- Modify: `src/ts/plugins/plugins.svelte.ts`
- Modify: `src/ts/plugins/apiV3/v3.svelte.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`
- Test: `src/lib/UI/CollectionOrganizerList.test.ts`
- Test: `src/lib/Setting/Pages/CollectionManagerItems.test.ts`
- Test: `src/ts/plugins/pluginRequestStatusContract.test.ts`

- [x] Add failing source-contract tests for a selection toggle in place of manager up/down controls, draggable card content, `선택 해제` before search, grouped reorder, and module/plugin deletion callbacks.
- [x] Run `pnpm vitest run src/lib/UI/CollectionOrganizerList.test.ts src/lib/Setting/Pages/CollectionManagerItems.test.ts` and confirm the new expectations fail.
- [x] Add an optional async `onDeleteItems` prop, a disabled-until-selected clear button before search, selected count and delete action, and a pressed/checked selection button in the manager rail.
- [x] Make manager card content the drag source while rejecting drag starts from nested interactive controls; use the Task 1 helper when dropping for reorder.
- [x] In module deletion, remove all selected IDs from modules, global enablement, and persona assignments after one confirmation. In plugin deletion, remove all selected names, clear a selected current provider, reload plugins, and save after one confirmation.
- [x] Track provider ownership in both plugin APIs so deleting a plugin removes its differently named providers without racing asynchronous V3 registration.
- [x] Add English/Korean labels for deleting selected items and its confirmation.
- [x] Run the targeted UI tests and type check.

### Task 3: User-facing release note and verification

**Files:**
- Modify: `patchnote/0.9.22.md`

- [x] Add one `[편의성]` bullet describing multi-select, clear-selection, group drag/drop, and bulk delete as one workflow.
- [x] Run the affected Vitest files, `pnpm check`, `pnpm check:theme-tokens`, and `git diff --check`.
- [x] Review the final diff against every requested behavior and leave the current branch uncommitted unless the user asks for a commit.
