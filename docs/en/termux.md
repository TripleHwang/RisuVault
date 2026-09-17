<p align="center">
  <strong>English</strong> | <a href="../ko/termux.md">한국어</a> | <a href="../de/termux.md">Deutsch</a> | <a href="../cn/termux.md">简体中文</a> | <a href="../es/termux.md">Español</a> | <a href="../vi/termux.md">Tiếng Việt</a> | <a href="../zh-Hant/termux.md">繁體中文</a>
</p>

# Termux Installation Guide

This guide explains how to build and run RisuVault directly on an Android phone using Termux. The intended use pattern is to open `http://localhost:6001` in the phone's own browser.

- [1. Prerequisites](#1-prerequisites) — F-Droid Termux and system requirements
- [2. Install and Build](#2-install-and-build) — single-command setup
- [3. Run and Connect](#3-run-and-connect) — open from the phone's browser
- [4. Keep It Running](#4-keep-it-running) — survive screen-off
- [5. Update](#5-update) — pull the latest version
- [6. Limitations](#6-limitations) — features that do not work on Termux


## System Requirements

| Item              | Minimum         | Recommended                |
| ----------------- | --------------- | -------------------------- |
| **Android**       | 7.0 (API 24)    | 10 or newer                |
| **CPU**           | ARM64           | ARM64                      |
| **RAM**           | 2 GB            | 4 GB or more               |
| **Free storage** | 2 GB            | 4 GB or more (with build)  |

RisuVault builds on the phone. The runtime no longer depends on native SQLite or `better-sqlite3`, which removes the former SQLite compilation barrier on Termux.


---

## 1. Prerequisites

### Use the F-Droid or GitHub Releases build of Termux

> ⚠️ **The Play Store version of Termux cannot be used.**
> The Termux maintainers stopped updating the Play Store build in 2020, and it can no longer install the recent packages RisuVault needs (Node.js 22+).

Install Termux from one of:

- **F-Droid (recommended)**: https://f-droid.org/packages/com.termux/
- **GitHub Releases**: https://github.com/termux/termux-app/releases

If you already have the Play Store version installed, uninstall it first and install from one of the sources above.


---

## 2. Install and Build

Open Termux and run this single command:

```bash
pkg install -y git && \
  git clone https://github.com/TripleHwang/RisuVault.git && \
  cd RisuVault && \
  bash scripts/termux/build.sh
```

The command takes care of:

1. Installing `git`
2. Cloning the RisuVault repository
3. Installing build dependencies (`nodejs-lts`, `python`, `make`, `clang`, `pnpm`, etc.)
4. `pnpm install` — JavaScript dependencies and native module compilation
5. `pnpm build` — frontend bundling

When the build finishes, you'll see:

```
Build OK. Start the server with:
  node server/node/server.cjs

Then open this address in the phone's own browser:
  http://localhost:6001
```


---

## 3. Run and Connect

From the same directory, start the server:

```bash
node server/node/server.cjs
```

Once the server boot log appears, open the phone's browser (Chrome, Firefox, etc.) and navigate to:

```
http://localhost:6001
```

The RisuVault UI should load. `localhost` is automatically treated as a secure context by the browser, so clipboard, `crypto.subtle`, and other secure-context APIs work normally.

Stop the server with `Ctrl + C`.

User data defaults to Termux-internal `$HOME/.local/share/risubard`. You may set another internal absolute path with `RISUBARD_DATA_ROOT`, but `/sdcard` and `/storage/emulated` are rejected as canonical roots. Use shared storage only for completed backup copies. See [File-native user data](file-native-storage.md).


---

## 4. Keep It Running

To keep the server alive when the screen turns off or you switch to other apps, enable Termux's wake lock:

```bash
termux-wake-lock
```

The Termux notification will show the wake-lock indicator, and the server continues to run even with the screen off.

Release with: `termux-wake-unlock`

> Android may still kill Termux under memory pressure. For long-running use, exclude Termux from your phone's battery optimization settings.


---

## 5. Update

From the RisuVault directory:

```bash
cd ~/RisuVault
git pull
NODE_OPTIONS="--max-old-space-size=2048" pnpm build
```

If dependencies changed, `pnpm install` runs automatically as part of the build. Restart the server when the build completes.


---

## 6. Limitations

**Quick Tunnel (Cloudflare auto tunnel) does not work on Termux.** The `cloudflared` binary is incompatible with Termux's DNS and TLS environment.

RisuVault detects the Termux environment automatically and shows a warning in the Remote Access menu, hiding the start button.


---

← [Back to README](../../README.en.md)
