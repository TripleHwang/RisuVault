# Notices

RisuVault incorporates inherited GPLv3 code derived from RisuAI, by way of PocketRisu and RisuBard. Applicable original notices, copyright statements, repository history, and license terms remain preserved.

Inherited RisuBard changes and independently authored code:

Copyright (C) 2026 rpaddict

The repository is distributed under the GNU General Public License, version 3. See `LICENSE`.

## SQL storage lineage

The relational schema, typed adjacency-list value codec, SQLite commit model,
and browser OPFS backend are adapted from the user-supplied
`HaejeokRisuai-b6251` source tree. They have been reshaped around this repository's
PocketRisu-compatible `Database` contract and remain covered by this
repository's GPLv3 terms.

## Portable server dependency manifest

`scripts/portable/gen-server-deps.cjs` is adapted from the file of the same
name in PocketRisu (https://github.com/PocketRisu/PocketRisu), itself a fork of
RisuAI. PocketRisu is licensed GPL-3.0-only, as is this repository, so the port
is carried under this repository's GPLv3 terms. The file's own header records
the origin and the changes made for this tree.

## Bundled PageFold provider

`src/ts/builtin/pagefold-0.2.5-fix.js` is the user-supplied PageFold 0.2.5
provider bundle. The built-in wrapper preserves its version metadata and runs
it through the existing Risu plugin API v3 sandbox. The blocks marked
"RisuVault:" in that file are RisuVault's patch, not upstream code: the fixed
"PageFold" provider registration, the per-request `pagefold_route` preset hook
(`applyPresetRoute`), the Vertex `baseUrl`/`headers` pass-through it needs, and
the migration of the config the bundled 0.1.1 build stored in save-backed
plugin storage (which also removes the font cache blobs that build left there).

## Bundled Persona Binder

`src/ts/builtin/persona_binder-1.28-fix.js` is the user-supplied Persona
Binder 1.28 plugin (API v3), shipped as a built-in the same way PageFold is:
the wrapper in `src/ts/builtin/personaBinder.ts` preserves its version
metadata and runs it through the Risu plugin API v3 sandbox. It is off until
the user turns it on under Settings > Plugins > Built-in plugins.

The file's own header, kept verbatim, states CC BY-NC-SA 4.0 and asks that the
original author and source be named when it is shared outside the Arca.live AI
chat channel, that it not be used commercially, and that derivatives carry the
same license. This repository's maintainer distributes it under the
[GNU General Public License v3.0](LICENSE) instead, on the position that a
RisuAI plugin is a derivative of RisuAI's GPL-licensed plugin API and is
therefore GPL-licensed regardless of the header. The attribution above is
preserved in any case. The blocks marked "RisuVault:" in that file are
RisuVault's patch, not upstream code.

## Third-party icons

The workspace mode switch, character configuration navigation, and lorebook workspace use Solar Icons in the Bold style,
created by [480 Design](https://www.figma.com/community/file/1166831539721848736).
The icons are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Their fill color and Svelte wrapper were adapted for this project's theming.
