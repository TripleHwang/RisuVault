<p align="center">
  <strong>English</strong> · <a href="README.md">한국어</a>
</p>

<h1 align="center">RisuVault</h1>

<p align="center">
  A self-hosted AI character chat frontend that does not fall over as the conversation grows
</p>

<p align="center">
  <a href="https://github.com/TripleHwang/RisuVault/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/TripleHwang/RisuVault?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0-only" src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/TripleHwang/RisuVault/releases">Download</a></strong> ·
  <a href="docs/en/install.md">Install</a> ·
  <a href="docs/en/migration.md">Migrate from RisuAI</a> ·
  <a href="https://github.com/TripleHwang/RisuVault/issues">Issues</a>
</p>

---

## What it is

RisuVault runs the RisuAI ecosystem — characters, CHARX cards, lorebooks, modules, prompt presets, model providers, plugins — with one goal on top: **conversations of many thousands of messages that actually work**.

It does not include or host any model. You connect a local model or a remote provider you control.

## Why it exists

Character chat runs into two different walls.

**The model's context window.** As a conversation grows the model stops seeing its beginning. [RisuBard](https://github.com/rpaddict/RisuBard) addresses that one: the raw conversation is kept as evidence, long-term narrative state is written to Obsidian-compatible Markdown (BardWiki), and each request carries only the relevant memories, within an explicit budget.

**The app's own wall.** This is a separate problem. An architecture that holds the whole conversation in memory, scans all of it on every save, and renders all of it to the screen does not merely slow down as messages accumulate — saves start failing and the browser dies.

RisuVault is the fork of RisuBard that goes after **the second problem**. The conversation lives spread across files and a relational database, and only what is needed right now is brought into the screen and the prompt.

## What changed

Measured numbers, all under real conditions.

| | Before | Now |
|---|---|---|
| 1,200-message chat, preparing to send | 740 loaded · 7 requests | **40 · 0 requests** |
| Character with 4,000 assets, 20-message screen | 1,248ms | **41ms** |
| 293MB plugin storage, app start | 482ms · 586MB | **1.9ms per key** |
| Forced layouts per render | 62 | **0** |
| Worst frame while scrolling | 99ms | **19ms** |
| Portable install size | 750MB | **46MB** |

The size reduction was ported from [PocketRisu](https://github.com/PocketRisu/PocketRisu). Both projects are GPL-3.0-only.

## How it works

**Files are canonical.** Your data lives as ordinary JSON, JSONL, Markdown and content-addressed files. SQLite and `database.bin` are derived, not canonical, and can be rebuilt from the files at any time — they exist for older clients and RisuAI exports.

**Saves are atomic.** Written to a temp file on the same filesystem, then fsync, checksum and schema validation, atomic rename, and an fsync of the parent directory. A `.bak` revision and a recoverable journal are kept, and deletions move to `trash/` rather than being erased. A user message is fsynced *before* the model request goes out, so an interrupted turn can be recovered down to the assistant's streaming draft.

**Only what is needed is loaded.** The screen mounts the messages around where you are reading and slides that window as you scroll. How many go into the prompt is decided by reading ahead: the response message count, the recent-memory count, and each lorebook entry's scan depth. The settings decide the number, not the size of the conversation.

**Memory stays readable.** BardWiki is Obsidian-compatible Markdown. It opens without the app, and edits made outside it are picked up.

## Features

- Compatible with RisuAI characters, CHARX cards, lorebooks, modules and prompt presets
- Fixed-budget narrative memory (BardWiki) — section-level updates, authoring control, cancellable jobs
- File-canonical storage with a relational SQLite layer, coordinated across tabs and devices
- Windowed loading for long conversations — thousands of messages still open and still save
- Rate limits (429) are waited out and retried, with the remaining time shown and cancellation honoured immediately
- Plugin API v1, v2, v2.1 and v3; where every enabled plugin is v3, storage is read one key at a time
- Remote access, and running under Termux on Android
- Portable builds for Windows, macOS (Apple Silicon) and Linux (x64/ARM), plus a Docker image

## Quick start

The portable package is the simplest route and needs no Node.js.

Download the file for your OS from [Releases](https://github.com/TripleHwang/RisuVault/releases), extract, and run.

| OS | File |
|---|---|
| Windows (x64) | `RisuVault-vX.X.X-win-x64.zip` |
| macOS (Apple Silicon) | `RisuVault-vX.X.X-macos-arm64.tar.gz` |
| Linux (x64) | `RisuVault-vX.X.X-linux-x64.tar.gz` |
| Linux (ARM64) | `RisuVault-vX.X.X-linux-arm64.tar.gz` |

For Docker, the install script, or building from source, see the [install guide](docs/en/install.md). Building from source needs Node.js 22.12 or newer.

The data location can be set before the server starts.

```bash
RISUBARD_DATA_ROOT=/your/path node server/node/server.cjs
```

## Migration and compatibility

RisuAI's `database.bin`, save folders, and an old `risuai.db` can all be imported, with an explicit choice between merge and replace. An old `risuai.db` is copied into `migration-backups/` and read exactly once; normal operation afterwards does not depend on SQLite.

Characters, CHARX cards, lorebooks, modules and presets carry over unchanged. See the [migration guide](docs/en/migration.md).

## Data and privacy

Everything stays in the directory you point it at. RisuVault sends your data nowhere and carries no telemetry. The only outbound requests go to the model providers you configure yourself.

## Documentation

- [Install](docs/en/install.md)
- [Migrate from RisuAI](docs/en/migration.md)
- [File-canonical storage](docs/en/file-native-storage.md)
- [BardWiki memory](docs/ko/memory-wiki.md) (Korean only)
- [Remote access](docs/en/remote.md)
- [Termux (Android)](docs/en/termux.md)
- [Plugin and provider compatibility](docs/ko/plugin-provider-compatibility.md) (Korean only)

## Project status

Under active development. The 0.3.x line is concentrated on save reliability and long-conversation performance; 0.4.0 is planned as an LTS once that work has settled.

Bug reports and reproduction steps are welcome in [Issues](https://github.com/TripleHwang/RisuVault/issues). For performance problems, saying what the situation was — conversation length, asset count, whether plugins were enabled — helps a great deal.

## Lineage and license

```
RisuAI
  └─ PocketRisu
       └─ RisuBard
            └─ RisuVault
```

On top of that line, the relational SQL storage design came from [HaejeokRisuai](https://github.com/nevaeh5379/HaejeokRisuai) and the portable dependency reduction from [PocketRisu](https://github.com/PocketRisu/PocketRisu), both reworked to fit this repository's structure.

All of it is GPL-3.0-only. The upstream projects' license obligations and attributions are preserved, and ported code records its origin in the file header and in [NOTICE.md](NOTICE.md).

This repository is distributed under the **GNU General Public License v3.0 only**. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
