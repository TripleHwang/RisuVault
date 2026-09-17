# Standalone automatic updater

## Update channel

This fork never inherits the upstream update channel. Official builds default to `TripleHwang/RisuVault`; downstream distributions can override it with `RISU_UPDATE_REPOSITORY=owner/repository` or `RISU_UPDATE_URL`. `RISU_UPDATE_CHECK=false` disables checks entirely.

`RISU_UPDATE_REPOSITORY` selects the GitHub Release repository used by both the server and portable updater. `RISU_UPDATE_URL` may point to a compatible GitHub Release API response for update checks; it does not enable portable self-update without a repository.

- Release-check API: `https://api.github.com/repos/TripleHwang/RisuVault/releases/latest`
- Release download repository: `https://github.com/TripleHwang/RisuVault`

A `404` from GitHub means no public release exists yet. The server treats that as "no update" and does not show a failure popup.

## Artifact contract

Portable artifacts use `RisuVault` by default:

| Platform | Artifact |
| --- | --- |
| Windows x64 | `RisuVault-vX.Y.Z-win-x64.zip` |
| Linux x64 | `RisuVault-vX.Y.Z-linux-x64.tar.gz` |
| Linux ARM64 | `RisuVault-vX.Y.Z-linux-arm64.tar.gz` |
| macOS ARM64 | `RisuVault-vX.Y.Z-macos-arm64.tar.gz` |

The release workflow and `getSelfUpdateAssetInfo()` in `server/node/server.cjs` share this naming rule. Set `RISU_RELEASE_ARTIFACT_PREFIX` only when the server, updater, and release workflow are configured to use the same value. The release workflow produces a draft release and requires a tag exactly matching `v` plus `package.json`'s version.

Every self-updatable release must also contain `update-manifest.json`. The release workflow generates it after packaging (`scripts/generate-update-manifest.mjs`) and records the exact product ID (`risuvault`), channel, version, platform, architecture, byte size, GitHub Release URL, and SHA-256 for each portable archive. A release without this manifest remains visible in the app, but can only be installed manually.

The server and bundled updater fail closed (`server/node/update-manifest.cjs`). They reject another product or repository, a downgrade, a mismatched tag/channel/platform/architecture, non-HTTPS artifact URLs, oversized or truncated downloads, and a SHA-256 mismatch. HaejeokRisuAI release packages are source references only and are never installed over RisuVault.

## Release requirements

A release is exposed to the automatic updater only when all of the following hold.

- The tag uses the `vX.Y.Z` form, for example `v0.4.0`.
- The release is published, not a draft.
- It is a normal release, not a prerelease; only those are returned by `releases/latest`. (`RISU_UPDATE_CHANNEL=beta` opts an install into prereleases.)
- The tag version is higher than the running `package.json` version.
- Portable self-install additionally needs a portable archive matching the running platform and architecture, and a valid `update-manifest.json` that describes it.

## How an update runs

1. The client calls the server's `GET /api/update-check`.
2. The server fetches the latest public release from the configured repository, strips the leading `v` from the tag and compares it with the current `package.json` version (`server/node/release-update.cjs`).
3. A higher release is reported as an optional update. The response also carries the deployment type and whether the server can install it itself (`canSelfUpdate`); a release without a trusted manifest is reported as manual-only.
4. On a portable deployment, `POST /api/self-update` downloads the platform archive, verifies it against the manifest, extracts it, and installs it as described in the next section, streaming NDJSON progress to the client.
5. The portable `update.bat` (Windows) and `update.sh` (Linux/macOS) run the standalone updater `scripts/updater.cjs`, which performs the same check, verification and install without a running server.
6. The repository-root `update.sh` used by source installs fetches the latest tagged source from the same repository and rebuilds.

Users can run a manual check from **Settings → System → Updates**. Portable builds can then back up and apply the verified package from the existing update dialog; Git, Docker, and unknown deployments receive the release link instead.

### Package validation

Before and after installing, the updater validates the package instead of trusting the archive contents (`validatePackage` in `server/node/portable-update.cjs`, also used by `scripts/updater.cjs`). It checks that `dist/index.html`, `server/node/server.cjs`, `package.json` and `node_modules` exist, that the server's runtime dependencies resolve inside the package rather than from a parent folder, and that the core server modules (`express` and the other shipped server dependencies) actually load under the bundled Node. The check must be expressed against the server dependency closure the portable ships, not the full app `package.json`, because the portable deliberately contains only that closure. The closure manifest is looked up as `scripts/server-deps.json` (the copy `release.yml` places in a portable), then `scripts/portable/server-deps/package.json` (a source checkout), and only a tree with neither falls back to the app `package.json`. The portable copy is a flat file directly under `scripts/` rather than a subdirectory because Phase 3 of the standalone updater — in every released portable, not only the current one — copies `scripts/` with `fs.copyFileSync` over each directory entry, which throws on a directory (`EPERM` on Windows, `EISDIR` on Linux); that loop runs after `server/`, `dist/`, `node_modules/` and `package.json` are already swapped and outside the backup-restoring `try/catch`, so a subdirectory under `scripts/` would crash `update.bat` / `update.sh` mid-update on every existing installation. `release.yml` fails the build if any directory exists under `portable/scripts/`. The standalone updater re-downloads and reinstalls a package of the same version when the installed copy is incomplete.

## Recoverable portable update

Since upstream 0.9.35 a portable update never leaves an installation half-replaced without a way back. The installation folder owns all update state under `.update-tmp/`, and every step of the Windows post-processing is appended to `update.log` in the installation root.

### Windows: staged install by a detached helper

The running server cannot replace `bin/node.exe` or the files its own launcher holds open, so on Windows the in-app update only *stages*:

1. The verified package is copied to `.update-tmp/staged`. The user's HTTPS certificate (`server/node/ssl/certificate`) is copied into the staged package. The staged package is validated with its own bundled Node.
2. A copy of Node and `server/node/portable-update.cjs` is placed outside the installation folder (a temp directory) and started detached as a helper. Once the helper reports ready, the server flushes pending writes and exits.
3. The helper waits for the server PID to exit, then installs: each staged entry is moved into place after the existing entry is moved to `.update-tmp/backup`, with progress written to `.update-tmp/install-state.json` after every move. User data and configuration are never touched (`save`, `backups`, `.env`, `.npmrc`, `.portable`, `.installed-version`, `.update-tmp`, `update.log`). The portable launcher executable (`RisuVault.exe`) is kept as well; it waits for its child process and its launch contract does not change with an app update.
4. The installed tree is validated again with the new `bin/node.exe`, and the new server is started. Only after the new server has actually finished listening is the version finalised (`.installed-version`) and the backup removed.
5. If validation or start-up fails, the helper removes the new entries that had no predecessor, restores every backed-up entry, and marks the state `rolled-back`. Files whose restore fails are left in `.update-tmp/backup` together with the journal for diagnosis; they are never deleted automatically. Once a healthy server owns the files, a failure to write metadata or clean up must never roll it back — the backup is simply kept.

`.update-tmp` is created exclusively: a previous interrupted installation or its backup is never discarded by a new update attempt; recovery has to complete first.

### Standalone `update.bat`

`scripts/portable/update.bat` runs `scripts/updater.cjs` with the bundled Node. Before replacing anything the updater checks that no other `node.exe`, `cloudflared.exe` or launcher process from the same portable folder is still running; if one is, it exits without changing the installation and asks the user to close every RisuVault console and remote-access tunnel first. Because `bin/` cannot be replaced by the Node process running from it, the new `bin/` is staged in `.update-tmp/new-bin` and copied into place by the batch file after the updater exits, followed by a validation run of `portable-update.cjs --validate` and finalisation of `.installed-version`. If copying or validation fails, `updater.cjs --rollback` (`scripts/updater-recovery.cjs`) restores `.update-tmp/backup` immediately. The running `update.bat` itself is never overwritten during rollback, and if rollback fails the user is told to keep `.update-tmp` because it holds the previous installation.

### Linux and macOS

Unix portables replace files in-process: existing entries are renamed into `.update-tmp/backup`, the new entries are moved in, the tree is validated, `scripts/` is refreshed from the release, and `.installed-version` is written. Any failure during the move restores the backup before the error is reported. A leftover backup from an interrupted run is restored before a new update begins. The server then restarts through a small helper that first confirms the port is free, so it never fights a process manager.

### Upgrading from an updater that predates this design

An install still running an older updater performs the *next* update with that older code. For that first transition the safe path is: stop the server, extract the new archive into a fresh folder, and copy `save/` (plus any custom data root, `.env`, user certificate or backup folder) across. Keep the old folder and its `.update-tmp` until the new installation has been verified with real data; the new design does not repair an installation that was already damaged by an older updater.

## Deployment types

| Deployment | Update notice | Web self-update |
| --- | --- | --- |
| Portable (`.portable` marker present) | Yes | Yes |
| Git checkout | Yes | No |
| Docker | Yes | No |
| Termux and other environments | Yes | No |

Non-portable deployments can be told about a new version, but their installation methods differ, so the server never replaces their files.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RISU_UPDATE_CHECK=false` | Disables update checks even when a channel is configured. |
| `RISU_UPDATE_REPOSITORY` | Overrides the default `TripleHwang/RisuVault` release repository. |
| `RISU_UPDATE_URL` | Overrides the release-check API with a GitHub Release-compatible endpoint. |
| `RISU_RELEASE_ARTIFACT_PREFIX` | Overrides the portable artifact prefix; defaults to `RisuVault`. |
| `RISU_UPDATE_PRODUCT_ID` | Overrides the manifest product ID expected by a downstream distribution. |
| `RISU_UPDATE_CHANNEL` | Selects `stable` or `beta`; defaults from the installed version (`beta` for prereleases). |
| `RISU_UPDATE_MANIFEST_ASSET` | Overrides the manifest asset name; defaults to `update-manifest.json`. |

## Release-owner responsibilities

The product identity is `RisuVault`, the release repository is `TripleHwang/RisuVault`, and the macOS identifier is `io.github.triplehwang.risuvault`. Code-signing and notarization remain release-owner policies.

`.github/workflows/release.yml` is started by `workflow_dispatch` with the version to publish. It first checks that the requested version matches `package.json` and `patchnote/X.Y.Z.md`, runs `pnpm check:standalone-release` and `pnpm test:compat`, and only after full verification and all four platform packages succeed does it create the tag and a `draft: true` release. Each final archive is then extracted into a separate folder and smoke-tested with its bundled Node — dependency check and server start — with the test data kept outside the packaged tree. Review the workflow's commit, the draft body, the four artifacts and their hashes, then press **Publish release**; user installs only discover the version after that.

The Cloudflared build bundled with the portable is pinned in the release workflow, so an ordinary app release does not pull in a different external `latest` and force an unrelated Windows executable replacement. Bumping it is an explicit release change.

Push the release-preparation commit to `main`, then start the workflow. The full verification runs once in CI before the tag is created, so it is not repeated locally for the release; if CI fails no tag or draft is produced. Verification done while implementing code changes is separate from this procedure and is not skipped.

```powershell
gh workflow run release.yml --ref main -f version=X.Y.Z
```

## Related code

- Update check and in-app self-update: `server/node/server.cjs`
- Release tag normalisation and version comparison: `server/node/release-update.cjs`
- Manifest validation, repository/URL allow-list, version rules: `server/node/update-manifest.cjs`
- Manifest generation at release time: `scripts/generate-update-manifest.mjs`
- Package validation, Windows staged install helper: `server/node/portable-update.cjs`
- Standalone portable updater: `scripts/updater.cjs`
- Rollback of an interrupted Windows update: `scripts/updater-recovery.cjs`
- Windows portable update entry point and post-processing: `scripts/portable/update.bat`
- Server dependency closure: `scripts/portable/server-deps/` in the repository, shipped in the portable as `scripts/server-deps.json`; staleness check `scripts/portable/check-server-deps.mjs`
- Source-install updater: `update.sh`
- Release build and draft creation: `.github/workflows/release.yml`
