# Grimoire Shared Lore Source Implementation Plan

**Goal:** Make character `globalLore` the single owner of ordinary lore fields while Grimoire persists only metadata overlays and AI-derived entries.

**Architecture:** Persist Grimoire schema v2 as `metadata[] + derivedEntries[]`. Materialize editor/runtime entries by overlaying metadata onto current `globalLore`. Commit ordinary Grimoire edits back to `globalLore`; keep entries with `derivedFromId` in `derivedEntries`. Normalize schema v1 copied entries into schema v2 on load.

## Tasks

1. Add model tests for immediate source reflection, two-way editor commits, derived ownership, deletion cleanup, and schema-v1 migration.
2. Implement schema-v2 normalization, materialization, and commit helpers in `src/ts/lorebook/bardLore.ts`.
3. Update portable metadata import/export to materialize against the current legacy lorebook.
4. Wire `LoreBookSetting.svelte` and runtime retrieval to the materialized view.
5. Update affected fixtures and the official `project_wiki/bard_lore_architecture.md` contract.
6. Run focused Vitest suites, Svelte checks, and diff validation.
