const fs = require('fs');
const path = require('path');

// A version marker's bytes with trailing whitespace removed, or null when the
// file is absent. Every writer of these markers omits a newline and update.bat
// copies latest-version over .installed-version byte for byte; trailing
// whitespace is ignored only so a marker re-saved by an editor still matches.
function readMarker(file) {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return null; }
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
    return bytes.subarray(0, end);
}

// Reason suffix for a backup/ that holds no entries. Whatever left it (a
// restore that already renamed every entry back, or a swap stopped before
// its first rename) left the root complete, so clearing the directory is the
// whole job. rollbackInterruptedUpdate reads this suffix to say so instead
// of calling the update "completed".
const NOTHING_TO_RESTORE = 'nothing left to restore';

// Tells a .update-tmp/backup that holds nothing worth restoring from one left
// by an update that stopped part-way. Returns the reason as text when the
// directory may be cleared, null when backup/ must be treated as the only
// copy of the previous installation.
//
// This file must not load anything from server/, because it runs while
// server/ may still be inside backup/, and server/node/portable-update.cjs
// is copied on its own into a temporary runner directory (built-ins only),
// so the two cannot share a module. The rules are therefore duplicated from
// inspectUpdateTmp there; keep the two in step. That function's comment
// records how each flow leaves the directory and the experiment behind the
// stamp rule.
//
// The journal (install-state.json) is read first, and decides on its own
// whenever it is present. `bin\node.exe scripts\updater.cjs --rollback`, the
// command the in-app refusal prints, reaches rollbackInterruptedUpdate
// straight from the argv check in updater.cjs with no prior journal check,
// so this function is the only place that can see it. Before the journal was
// consulted here, the marker and stamp rules below ran on a helper
// (installStaged) killed mid-swap: entries are swapped one at a time in
// readdirSync order (bin, dist, node_modules, package.json, server), so a
// kill after dist/ and before package.json leaves the root with the new
// dist/ next to the old package.json, .installed-version still equal to
// 'v' + that old package.json, every backed-up entry present at the root and
// the journal at 'installing'. The stamp rule took that for a completed
// update and --rollback deleted backup/dist, the only copy of the old dist/,
// while logging that the installation was not changed. The stamp rule's
// "cannot look like this" reasoning holds only for the flows without a
// journal, whose stamp is written after the swap; the helper's stamp is the
// one from before the update.
//
// With a journal:
//
// - 'complete': installStaged marked the update finished and only its rmSync
//   failed (a held handle; see the "cleanup deferred" observation in the
//   portable-update.cjs comment). backup/ holds the release before it.
//
// - 'rolled-back' with an empty backup/: restoreEntries renamed every entry
//   out before the phase was written, so the root is the previous release
//   already and the directory is debris.
//
// - 'installing', 'recovering', 'rolled-back' with entries still in backup/,
//   or a journal that cannot be parsed: backup/ is the only copy of what left
//   the root. Null, so the restore runs.
//
// Without a journal (scripts/updater.cjs, and the in-app path before 0.9.35):
//
// - latest-version byte-equal to the root .installed-version: the finishing
//   step of update.bat (or of the restart script the pre-0.9.35 in-app path
//   generated) copied the marker into place, which it does only after the
//   swapped package validated and bin/ was applied. Its `rmdir /s /q
//   .update-tmp 2>nul` then failed silently, so the whole directory is still
//   here after the installation completed. The pre-existing behaviour of
//   restoring backup/ in this state put the release from before the update
//   back over the finished one.
//
// - no latest-version, but .installed-version equals 'v' + the root
//   package.json version and every top-level entry of backup/ also exists at
//   the root: the silenced rmdir removed everything it could, including
//   latest-version, and left only the entries a still-open handle (antivirus,
//   search indexer) protected. Reproduced on Windows 10: a FileShare.None
//   handle on backup/dist/index.html leaves exactly backup/dist/index.html.
//   Restoring that would replace the installed dist/ with a directory holding
//   one stale file. An update killed mid-swap cannot look like this: entries
//   leave the root in directory order, dist/ and node_modules/ before
//   package.json, and the stamp is written only after the swap validated.
//   When backup/ is empty this rule is vacuous: the shape is left by a phase
//   1 or 2 failure in updater.cjs that already restored itself (its
//   restoreBackupIntoRoot renames every entry back and leaves the empty
//   directory), after which update.bat's :fail label runs --rollback. The
//   reason then carries NOTHING_TO_RESTORE so the log does not call the
//   failed update completed.
function completedUpdateLeftover(root) {
    const tmpDir = path.join(root, '.update-tmp');
    const backupDir = path.join(tmpDir, 'backup');
    if (!fs.existsSync(backupDir)) return null;
    const journal = path.join(tmpDir, 'install-state.json');
    if (fs.existsSync(journal)) {
        let state;
        try { state = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch { return null; }
        const phase = state?.phase;
        if (phase === 'complete') {
            // A 'complete' journal says the helper finished, not that the
            // root is still whole. This is the --rollback argv path, where
            // validatePackage cannot run (server/ may be sitting in backup/),
            // so the only cheap check is the one the no-journal rule uses:
            // every entry that was backed up must still exist at the root.
            // Observed: a root that had since lost dist/ next to a 'complete'
            // journal -- clearing here deleted the only copy of dist/.
            const missing = fs.readdirSync(backupDir).filter(entry => !fs.existsSync(path.join(root, entry)));
            return missing.length ? null : "journal phase 'complete'";
        }
        if (phase === 'rolled-back' && fs.readdirSync(backupDir).length === 0) {
            return `journal phase 'rolled-back' and backup is empty: ${NOTHING_TO_RESTORE}`;
        }
        return null;
    }
    const installed = readMarker(path.join(root, '.installed-version'));
    if (installed === null) return null;
    const marker = readMarker(path.join(tmpDir, 'latest-version'));
    if (marker !== null) {
        return marker.equals(installed) ? `latest-version ${marker} matches .installed-version` : null;
    }
    let version;
    try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return null; }
    if (!version || installed.toString('utf8') !== 'v' + version) return null;
    const backedUp = fs.readdirSync(backupDir);
    if (backedUp.length === 0) {
        return `.installed-version v${version} matches the installed package.json and backup is empty: ${NOTHING_TO_RESTORE}`;
    }
    const missing = backedUp.filter(entry => !fs.existsSync(path.join(root, entry)));
    if (missing.length) return null;
    return `.installed-version v${version} matches the installed package.json and every backed-up entry exists at the root`;
}

// Noun phrase for a reason returned by completedUpdateLeftover, shared with
// recoverInterruptedInstallation in updater.cjs so both logs describe the
// same shape the same way.
function describeLeftover(reason) {
    return reason.includes(NOTHING_TO_RESTORE)
        ? `an empty update backup (${reason})`
        : `the leftover of a completed update (${reason})`;
}

function rollbackInterruptedUpdate(root, options = {}) {
    const log = options.log || (() => {});
    const tmpDir = path.join(root, '.update-tmp');
    const backupDir = path.join(tmpDir, 'backup');
    if (!fs.existsSync(backupDir)) {
        log('No interrupted update backup was found; existing installation was not changed.');
        return false;
    }

    const completed = completedUpdateLeftover(root);
    if (completed) {
        // Either the files under backup/ predate an update that finished, so
        // restoring them would revert it, or backup/ is empty and there is
        // nothing to restore. Only the leftover directory is cleared. A
        // failure here is the same held handle that defeated the earlier
        // cleanup; it is reported rather than thrown so update.bat does not
        // print its "contains the previous installation backup" advice for a
        // directory that holds nothing worth keeping. The reason text decides
        // the wording: an empty backup/ was left by a rolled-back or
        // self-restored update, and calling that "completed" misreported the
        // outcome the user was looking into.
        const what = describeLeftover(completed);
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            log(`Cleared ${what}; existing installation was not changed.`);
        } catch (e) {
            log(`Could not clear ${tmpDir}, ${what}: ${e.message}. Existing installation was not changed; close whatever holds that folder and delete it.`);
        }
        return false;
    }

    log('Restoring the previous installation after update failure...');
    for (const entry of fs.readdirSync(backupDir)) {
        // update.bat may still be executing. Keep the new recovery-capable
        // launcher instead of replacing it from underneath cmd.exe.
        if (entry === 'update.bat') continue;
        const source = path.join(backupDir, entry);
        const destination = path.join(root, entry);
        if (fs.existsSync(destination)) {
            fs.rmSync(destination, { recursive: true, force: true });
        }
        fs.renameSync(source, destination);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log('Previous installation restored. Close RisuVault completely before retrying.');
    return true;
}

module.exports = { rollbackInterruptedUpdate, completedUpdateLeftover, describeLeftover };
