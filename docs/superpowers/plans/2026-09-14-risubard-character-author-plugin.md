# RisuBard Character Author Plugin Implementation Plan

> **Execution:** Implement inline in the current session. Do not create a worktree. Never write to the configured live save while RisuBard's server lock exists.

**Goal:** Create and install a personal Codex plugin that can author a complete RisuBard character draft from any working directory, validate it, and safely publish it to a configured RisuBard save root with lorebooks, assets, renderer regex, and CSS.

**Architecture:** Keep the AI-authored content in a portable JSON draft. A dependency-free Node.js CLI validates and compiles that draft into RisuBard's file-native character, sidebar, and content-addressed KV formats. Publishing is transactional and refuses a live save lock. The Codex skill teaches the authoring workflow and the exact asset-output contract.

**Tech Stack:** Codex plugin/skill, Node.js ESM, `node:test`, filesystem-native JSON and SHA-256.

---

## Task 1: Scaffold the plugin package

**Files:**
- Create: `E:\Risuwork\JellyBard\risubard-character-author\.codex-plugin\plugin.json`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\SKILL.md`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\risubard-character.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\config.example.json`

1. Use the official plugin scaffold helper with skills, scripts, and assets enabled.
2. Set a concise manifest name and description.
3. Keep runtime dependencies at zero.

## Task 2: Define and validate the portable draft format

**Files:**
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\lib\draft.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\tests\draft.test.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\references\draft-format.md`

1. Write failing tests for required character fields, lore defaults, unique asset aliases, absolute/relative asset paths, and renderer defaults.
2. Run `node --test scripts/tests/draft.test.mjs` and confirm the expected module/test failure.
3. Implement normalization and actionable validation errors.
4. Re-run the targeted test and confirm it passes.

## Task 3: Compile assets and RisuBard character metadata

**Files:**
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\lib\compiler.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\tests\compiler.test.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\assets\templates\character-draft.example.json`

1. Write failing tests for byte-signature format detection, content hashes, `additionalAssets`, lorebook entries, and the generated `editdisplay` regex/CSS.
2. Verify failure before implementation.
3. Implement format detection for PNG, JPEG, WebP, and GIF; reject mismatched unsupported files.
4. Compile exact asset aliases to `[alias, logicalKey, extension]` and generate `<img="alias">` rendering through `{{raw::$1}}`.
5. Re-run the targeted test and confirm it passes.

## Task 4: Implement safe file-native publishing

**Files:**
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\lib\publisher.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\tests\publisher.test.mjs`

1. Write failing tests against a temporary synthetic save for active-lock refusal, KV object/manifest writes, character metadata/checksum/backup behavior, sidebar registration, and journal cleanup.
2. Verify failure before implementation.
3. Implement staged atomic publication compatible with RisuBard's `.journal`, `.bak`, and `.sha256` conventions.
4. Never mutate the supplied live sample save in tests.
5. Re-run the targeted test and confirm it passes.

## Task 5: Expose CLI commands and read-only inspection

**Files:**
- Modify: `E:\Risuwork\JellyBard\risubard-character-author\scripts\risubard-character.mjs`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\scripts\tests\cli.test.mjs`

1. Write failing CLI tests for `inspect`, `validate`, `plan`, and guarded `publish --yes`.
2. Implement config lookup from the plugin root and command-line `--save-root` override.
3. Make `inspect` summarize representative characters without loading asset blobs.
4. Ensure `plan` is read-only and `publish` requires both `--yes` and an absent server lock.
5. Run all Node tests.

## Task 6: Write the Codex skill and install personally

**Files:**
- Modify: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\SKILL.md`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\references\character-contract.md`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\references\asset-rendering.md`
- Create: `E:\Risuwork\JellyBard\risubard-character-author\skills\risubard-character-author\references\storage-safety.md`
- Install: `C:\Users\jsthe\plugins\risubard-character-author\`
- Update: `C:\Users\jsthe\.agents\plugins\marketplace.json`

1. Document the end-to-end authoring workflow, content questions, draft generation, validation, dry run, and guarded publishing.
2. Document exact asset aliases, `<img="alias">`, parser order, `{{raw::alias}}`, and why CSS belongs in `backgroundHTML`.
3. Validate the skill and plugin with the official validators.
4. Test inspection against the supplied save root, and test publishing only against a temporary copy/synthetic fixture.
5. Copy the validated plugin into the personal plugin directory and register it in the personal marketplace.
6. Re-run plugin validation on the installed copy and report the Codex install/share links.
