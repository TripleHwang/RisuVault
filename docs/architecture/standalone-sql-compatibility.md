# Standalone SQL and compatibility contract

## Product boundary

This repository is an independent, standalone Risu-family application derived
from the upstream application through RisuBard 0.8.11. It has its own SQL file
and can run without a separate upstream or RisuBard installation. Source and license
attribution remain intact.

The public compatibility boundary is the existing RisuBard `Database` object,
card/package formats, plugin APIs, model request modes, and export formats.
SQL is an internal persistence replacement, not a new format that plugins or
prompt code must understand.

## Canonical storage transition

1. Bootstrap reads an existing `database/database.bin` using the unchanged
   Risu decoder.
2. When the standalone SQL database is empty, the original bytes are copied to
   `database/pre-sql-migration-v1.bin`.
3. The decoded graph is imported in one transaction and then reloaded from SQL.
4. SQL becomes the read source only after that reload succeeds.
5. If initialization, import, or verification fails, the original graph remains
   active and recoverable.
6. `database.bin` remains a compatibility projection for existing backup,
   import/export, and rollback workflows while the SQL migration matures.

The browser backend uses SQLite WASM with OPFS and a dedicated
`/risu-standalone.sqlite3` database. Native desktop and server implementations
must implement the same `ISqlStorage` contract.

## Relational layout

Settings, characters, chats, messages, cold archives, tags, and extension data
use typed relational rows. Nested values use an adjacency-list codec that
round-trips `undefined`, non-finite numbers, embedded NULs, unpaired UTF-16
surrogates, arrays, and objects without JSON coercion.

Two bounded compatibility exceptions intentionally retain JSON payloads:

- bot presets, because third-party providers add unregistered fields;
- plugin custom storage, because plugin-owned values have no stable shared
  schema.

Normal saves compare the last committed graph with the current graph and write
only changed rows. Character, chat, and message manifests perform ordered
deletion without serializing the whole database into a blob.

## PageFold

PageFold 0.2.5 is loaded as a hidden, trusted built-in API v3 transport. It is
not a selectable model. Each ModelPreset exposes an opt-in PageFold switch in
Advanced settings; the shared ModelPreset dispatcher applies it consistently to
main, sub/auxiliary, memory, emotion, translation and other model-bound requests.

The PDF request uses that preset's resolved model ID, endpoint and credential.
Google AI Studio, Vertex Gemini Native, OpenRouter and LLM Gateway profiles are
supported; incompatible profiles cannot enable the switch. Vertex service-account
JSON is exchanged by the host and only the short-lived access token crosses the
built-in plugin boundary. The ephemeral route is never written to PageFold
storage or request logs. Save-backed PageFold storage holds PageFold's own
settings (packaging options, model profiles and their keys); request logs,
statistics and the per-device toast/logging switches stay in local storage.

It is opt-in and defaults off, so imported Risu presets and existing requests are
unchanged. PageFold requests intentionally disable streaming, tools, image input,
provider-native context caching and server-side job routing; structured auxiliary
outputs use the existing schema-as-system-message fallback.

## Release gates

A standalone release is blocked by any known regression in:

- legacy save import and compatibility export;
- character cards, packages, assets, presets, modules, lorebooks, or personas;
- API v2/v3 plugins and custom providers;
- prompt assembly, regex/scripts, model-mode routing, streaming, or swipes;
- ordered characters/chats/messages and unknown extension fields;
- migration rollback or interrupted-write recovery.

Every schema change must be paired with a migration and round-trip fixtures.
Lazy loading may replace full graph loading only after those fixtures and the
existing Risu compatibility suite pass against the lazy implementation.
