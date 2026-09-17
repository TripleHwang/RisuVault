# Durable Imports And Backup Diagnostics Plan

**Goal:** Prevent a refresh from discarding recently imported characters, modules, or plugins, and let users verify a multi-gigabyte backup without uploading or loading all assets.

**Architecture:** Treat import success and backup creation as durability boundaries. At those boundaries, await `requestImmediateSave({ flushServer: true, rejectOnFailure: true })` before reporting success or asking the server to export. Add a Node CLI that walks backup entry headers with positioned reads, loads only `database.risudat`, and emits content-free counts and database/ID hashes.

**Tech Stack:** TypeScript, Svelte, Vitest, Node.js CommonJS.

---

### Task 1: Lock durability behavior with failing tests

**Files:**
- Modify: `src/ts/drive/backuplocal.test.ts`
- Modify: `src/ts/characterCards.import.test.ts`
- Modify: `src/ts/process/modules.test.ts`
- Create: `src/ts/plugins/plugins.import-durability.test.ts`

Add assertions that a rejecting durable save prevents export/success, and that successful character, module, and plugin imports await the durable save before notifying or returning.

Run the four focused tests and confirm they fail against the current implementation.

### Task 2: Make import and backup boundaries durable

**Files:**
- Modify: `src/ts/drive/backuplocal.ts`
- Modify: `src/ts/characterCards.ts`
- Modify: `src/ts/process/modules.ts`
- Modify: `src/ts/plugins/plugins.svelte.ts`

Await `requestImmediateSave({ flushServer: true, rejectOnFailure: true })` before full/settings/upstream/server backup creation and after imported data enters the database but before success is reported. Preserve partial backup as an emergency browser-state export that can still run when server persistence is unhealthy.

Run the focused tests and confirm they pass.

### Task 3: Add a streaming backup inspector

**Files:**
- Create: `server/node/backup-inspector.cjs`
- Create: `server/node/backup-inspector.test.ts`
- Create: `server/node/inspect-backup.cjs`
- Modify: `package.json`

Walk entry headers using `fs.promises.FileHandle.read`, skip asset payloads by offset, decode only `database.risudat`, and print JSON containing the file size, database hash, and character, chat, message, module, plugin, and preset counts. Include only hashed IDs—never names, prompts, or chat text.

Run the server inspector test and a CLI smoke check.

### Task 4: Document and verify

**Files:**
- Modify: `patchnote/0.9.31.md`

Document durable imports/backups and the local inspector command. Run focused tests, TypeScript/Svelte check, and `git diff --check` before completion.
