# Grimoire Analysis Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global Grimoire metadata language setting, expose the exact active analysis instruction, apply it to every analysis request and bilingualize the Cheongwon High School tags.

**Architecture:** A focused lorebook language module owns normalization, BardWiki fallback resolution and the code-owned language instruction. The common RisuBard settings page stores the global selection and renders a read-only instruction viewer from the same function used by the request path. Existing per-character analysis limits remain unchanged.

**Tech Stack:** TypeScript, Svelte 5, Vitest, JSON character storage.

---

### Task 1: Define and persist the language contract

**Files:**
- Create: `src/ts/lorebook/bardLoreLanguage.ts`
- Create: `src/ts/lorebook/bardLoreLanguage.test.ts`
- Modify: `src/ts/storage/database.svelte.ts`

- [ ] **Step 1: Write the failing normalization and instruction tests**

Test that `follow-bardwiki` is the default, that invalid stored values normalize safely, that BardWiki fallback resolves to Korean or English, and that English, Korean and bilingual modes produce distinct metadata instructions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ts/lorebook/bardLoreLanguage.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal language module and DB field**

Define `BardLoreAnalysisLanguage = 'follow-bardwiki' | 'en' | 'ko' | 'bilingual'`, `normalizeBardLoreAnalysisLanguage`, `resolveBardLoreAnalysisLanguage`, and `buildBardLoreAnalysisLanguageInstruction`. Add `risuBardGrimoireLanguage` to `Database` and normalize it in `setDatabase`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm vitest run src/ts/lorebook/bardLoreLanguage.test.ts`
Expected: PASS.

### Task 2: Apply the contract to analysis planning and requests

**Files:**
- Modify: `src/ts/lorebook/bardLoreAnalysis.test.ts`
- Modify: `src/ts/lorebook/bardLoreAnalysis.ts`
- Modify: `src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.svelte`

- [ ] **Step 1: Write failing prompt tests**

Assert that prompt construction accepts the selected mode and BardWiki language, includes only the resolved language instruction, and that batch token planning measures the same prompt variant.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ts/lorebook/bardLoreAnalysis.test.ts`
Expected: FAIL because prompt and planner do not accept language arguments.

- [ ] **Step 3: Implement prompt and panel wiring**

Add optional language arguments to `buildBardLoreAnalysisPrompt` and `planBardLoreAnalysisBatches`. In the analysis panel, read `DBState.db.risuBardGrimoireLanguage` and `DBState.db.risuBardWikiWritingLanguage`, then pass both to planning and actual request construction.

- [ ] **Step 4: Run the focused test**

Run: `pnpm vitest run src/ts/lorebook/bardLoreAnalysis.test.ts`
Expected: PASS.

### Task 3: Add the Grimoire settings section and readable instruction

**Files:**
- Create: `src/lib/Setting/Pages/RisuBardGrimoireLanguageSettings.svelte`
- Modify: `src/ts/setting/customComponents.ts`
- Modify: `src/ts/setting/risuBardCommonSettingsData.ts`
- Modify: `src/lib/Setting/RisuBardModeSettings.test.ts`
- Modify: `src/lang/en.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/help.en.ts`
- Modify: `src/lang/help.ko.ts`

- [ ] **Step 1: Write the failing settings integration test**

Assert that the Grimoire header appears between Wiki writing and save/load, the four choices are registered, the DB field is present, and the custom component renders the shared instruction in a read-only resizable textarea.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/Setting/RisuBardModeSettings.test.ts`
Expected: FAIL because the section and component do not exist.

- [ ] **Step 3: Implement the settings UI and translations**

Register a custom component that renders a localized label, a select bound to the global field, and `TextAreaInput` using `buildBardLoreAnalysisInstruction` with `readonly`, `resizable`, and no edit action bar. Add Korean and English labels/help text.

- [ ] **Step 4: Run the settings test**

Run: `pnpm vitest run src/lib/Setting/RisuBardModeSettings.test.ts`
Expected: PASS.

### Task 4: Add Korean equivalents to Cheongwon High School tags

**Files:**
- Modify: `../RisuBard-userdata/characters/32d7ac62-47eb-4a9f-bfbe-71b96b255823/metadata.json`

- [ ] **Step 1: Patch English-only tag values**

For every Grimoire entry, retain the current English tags and add deduplicated natural Korean equivalents next to them. Preserve already bilingual entries, source content, aliases, summaries, fingerprints and links.

- [ ] **Step 2: Validate the JSON and tag coverage**

Run a read-only PowerShell JSON parse and report any English tag without a Korean counterpart in the same entry.
Expected: valid JSON and no untranslated English-only tags among non-folder entries.

### Task 5: Verify the integrated change

**Files:**
- Verify all files above.

- [ ] **Step 1: Run targeted tests**

Run: `pnpm vitest run src/ts/lorebook/bardLoreLanguage.test.ts src/ts/lorebook/bardLoreAnalysis.test.ts src/lib/Setting/RisuBardModeSettings.test.ts`
Expected: PASS.

- [ ] **Step 2: Run type and help checks**

Run: `pnpm check` and `pnpm check:help`.
Expected: both exit 0.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check` and targeted `git diff` for the changed source files. Confirm no unrelated user changes were overwritten.
