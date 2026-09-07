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

`src/ts/builtin/pagefold-0.1.1-fix.js` is the user-supplied PageFold 0.1.1
provider bundle. The built-in wrapper preserves its version metadata and runs
it through the existing Risu plugin API v3 sandbox.

## Third-party icons

The workspace mode switch, character configuration navigation, and lorebook workspace use Solar Icons in the Bold style,
created by [480 Design](https://www.figma.com/community/file/1166831539721848736).
The icons are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Their fill color and Svelte wrapper were adapted for this project's theming.
