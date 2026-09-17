# Overlay Layer System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion. Work directly in the current checkout because this repository explicitly forbids creating a worktree unless the user requests one.

**Goal:** Replace conflicting million/max-int z-index values with one bounded, owner-aware overlay layer contract.

**Architecture:** Keep local component stacking contexts local. Global modal groups use small tier bands (`base`, `alert`, `top`) and are reordered dynamically inside each band; portaled floating surfaces derive their layer from their owning trigger or the current top modal. Notifications and drag previews use small reserved layers.

**Tech Stack:** Svelte 5, TypeScript, Bits UI, Tippy.js, Vitest, happy-dom.

---

### Task 1: Lock the bounded layer contract

**Files:**
- Modify: `src/lib/UI/GUI/modalLayerStack.test.ts`
- Modify: `src/lib/UI/GUI/DialogLayering.test.ts`

- [ ] Add failing behavior tests proving `base < alert < top`, reopening only reorders within a tier, floating surfaces sit above their owner, and managed runtime layers stay below 1000.
- [ ] Run `pnpm vitest run src/lib/UI/GUI/modalLayerStack.test.ts src/lib/UI/GUI/DialogLayering.test.ts` and confirm failures expose the current `1_000_000`/max-int scheme.

### Task 2: Implement the central bounded stack

**Files:**
- Modify: `src/lib/UI/GUI/modalLayerStack.ts`
- Modify: `src/App.svelte`

- [ ] Define the shared contract:

```ts
export const OVERLAY_LAYERS = {
    floating: 90,
    base: 100,
    alert: 300,
    notification: 600,
    top: 700,
    drag: 900,
} as const
```

- [ ] Recompute connected modal groups with a stride of 10 inside their tier instead of incrementing an unbounded global counter.
- [ ] Observe `[data-risu-floating-layer]` and assign it immediately above its owner/current modal.
- [ ] Run the two layer tests and confirm they pass.

### Task 3: Migrate shared portals and remove extreme fallbacks

**Files:**
- Modify: `src/lib/UI/GUI/ShDialog.svelte`
- Modify: `src/lib/UI/GUI/ShAlertDialog.svelte`
- Modify: `src/lib/UI/GUI/ShLoadingDialog.svelte`
- Modify: `src/lib/UI/GUI/ShDropdownMenuContent.svelte`
- Modify: `src/lib/UI/GUI/ShSelect.svelte`
- Modify: `src/lib/UI/GUI/Toaster.svelte`
- Modify: `src/ts/gui/tooltip.ts`
- Modify: `src/ts/gui/tooltipTheme.test.ts`
- Modify: `src/lib/UI/GUI/RequestStatusInjectionManifest.test.ts`

- [ ] Mark modal tiers and floating portal content with semantic data attributes.
- [ ] Replace `2147483xxx`, `1_000_000`, and Tippy `9999` fallbacks with the shared bounded layers.
- [ ] Run the shared dialog, select, tooltip, and request-status tests.

### Task 4: Migrate unmanaged global surfaces and add the audit guard

**Files:**
- Modify only runtime files identified by the z-index audit under `src/`.
- Modify: `src/lib/UI/GUI/DialogLayering.test.ts`

- [ ] Mark full-screen viewers, plugin full-screen iframe, popup/context-menu surfaces, and body-appended edit controls as managed modal or floating layers.
- [ ] Replace remaining runtime z-index values at or above 1000 with bounded semantic fallbacks while preserving local ordering.
- [ ] Add a recursive static test rejecting runtime z-index literals at or above 1000 and max-int layer workarounds.
- [ ] Run the layer tests and confirm the guard passes.

### Task 5: Verify the affected UI contract

**Files:**
- Test only.

- [ ] Run:

```powershell
pnpm vitest run src/lib/UI/GUI/modalLayerStack.test.ts src/lib/UI/GUI/DialogLayering.test.ts src/lib/UI/GUI/ShSelect.test.ts src/ts/gui/tooltipTheme.test.ts src/lib/UI/GUI/RequestStatusInjectionManifest.test.ts src/lib/UI/GUI/ModalSurfaceContract.test.ts
pnpm check
git diff --check
```

- [ ] Inspect the final diff and confirm unrelated port/documentation edits remain untouched.
