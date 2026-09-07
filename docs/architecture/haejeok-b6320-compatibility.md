# HaejeokRisuAI b6320 compatibility baseline

RisuVault tracks HaejeokRisuAI `b6320` (`1260c9be`, 2026-08-25) as the current compatibility reference. The projects do not share Git history and their storage/runtime layers have diverged, so Haejeok commits are ported by behavior and regression test instead of being merged or used as binary updates.

## Integrated compatibility surface

- The local SQL schema remains `relational-schema-v3` / schema version 3. Unknown extension nodes are preserved instead of forcing a destructive migration.
- `.risu` loadout blocks and the latest root, character, module, and chat fields survive import, export, and SQL round trips.
- Module folders, additional-asset folder metadata, custom sidebar/loadout metadata, and per-chat global variable overrides are represented by the compatibility types.
- Sidebar toggle values can be scoped to the active chat while preserving valid empty-string and `0` values and falling back to the global value only when a local key is absent.
- The model selector supports search and persistent favorites without mutating the canonical model catalog. Gemini Flash 3.7 and both NovelAI Diffusion 5 variants are included.
- API v3 inlay access requires periodically reconfirmed permission. Already-installed API 2.1 plugins retain the legacy adapter for backward compatibility.
- RisuVault's existing durable model jobs, OPFS SQL backend, settings search, chat paging, and module organizer remain the canonical implementations where they already cover the corresponding Haejeok feature.

## Deliberate boundaries

Haejeok's Tauri installers, PostgreSQL deployment scripts, settings/persona visual redesign, and binary release channel are not copied wholesale. RisuVault is a standalone Node portable application with its own SQL lifecycle, branding, PageFold integration, release artifacts, and verified patch channel. UI changes are adopted only where they do not replace this project's own workspaces or break existing save/plugin compatibility.
