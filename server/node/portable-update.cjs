'use strict';

// Built-ins only: copied outside the installation and run by a private Node
// executable so neither the running server nor the helper locks bin/node.exe.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

// The manifests that describe what node_modules must contain, in lookup
// order. The portable ships the app package.json (for its version) but
// installs only the server's runtime dependency closure — 12 packages from
// scripts/portable/server-deps/ (~46MB) rather than the app's 69 dependencies
// (~750MB), because the frontend is prebuilt into dist/ and never loaded by
// the server.
//
// A portable carries the closure as the flat file scripts/server-deps.json
// rather than under scripts/portable/: Phase 3 of the standalone updater
// (scripts/updater.cjs, and identically every already-released copy) copies
// scripts/ with fs.copyFileSync over each readdirSync entry, which throws on
// a directory (EPERM on Windows, EISDIR on Linux). That loop runs after
// server/, dist/, node_modules/ and package.json have been swapped and outside
// the try/catch that restores the backup, so a directory under scripts/ would
// crash every existing installation's update.bat / update.sh mid-update on
// the first upgrade to a release that ships one. A source checkout has the
// closure only at its repository path, so that is checked second. Only a
// tree with neither (the bare app-build artifact) is validated against the
// app package.json, whose dependency list is a superset of the closure.
const SERVER_DEPS_MANIFESTS = ['scripts/server-deps.json', 'scripts/portable/server-deps/package.json'];

function validatePackage(root, node = process.execPath) {
    const script = String.raw`
        const fs = require('node:fs'), path = require('node:path');
        const root = fs.realpathSync(process.argv[1]);
        for (const file of ['dist/index.html', 'server/node/server.cjs', 'package.json', 'node_modules']) {
            if (!fs.existsSync(path.join(root, file))) throw new Error('Missing package file: ' + file);
        }
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const manifest = process.argv.slice(2).map(file => path.join(root, file)).find(file => fs.existsSync(file));
        const dependencies = (manifest ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : pkg).dependencies || {};
        const r = require('node:module').createRequire(path.join(root, 'server/node/server.cjs'));
        for (const name of new Set(['express', ...Object.keys(dependencies)])) {
            const resolved = fs.realpathSync(path.join(root, 'node_modules', name, 'package.json'));
            const relative = path.relative(root, resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dependency outside package: ' + name);
        }
        for (const name of ['express', 'compression', 'node-html-parser', 'express-rate-limit', 'ws', 'wasm-vips', 'msgpackr']) {
            if (dependencies[name] || name === 'express') r(name);
        }
        process.stdout.write(pkg.version);
    `;
    return execFileSync(node, ['-e', script, path.resolve(root), ...SERVER_DEPS_MANIFESTS], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForExit(pid, timeoutMs = 60000) {
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid server process ID');
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') return; throw error; }
        if (Date.now() >= deadline) throw new Error('Server did not exit; installation was not changed');
        await sleep(100);
    }
}

function writeState(file, state) {
    const fd = fs.openSync(file + '.tmp', 'w');
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(file + '.tmp', file);
}

function readState(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

// A version marker's bytes with trailing whitespace removed, or null when the
// file is absent. The three writers of these markers (scripts/updater.cjs
// writes the release tag, the pre-journal in-app path wrote `v${version}`,
// installStaged writes 'v' + version) all omit a newline and update.bat
// copies latest-version to .installed-version byte for byte, so the files
// are byte-equal in practice; trailing whitespace is ignored only so that a
// marker opened and re-saved by an editor that appends a newline still
// matches, and nothing else is normalised.
function readMarker(file) {
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return null; }
    let end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09 || bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--;
    return bytes.subarray(0, end);
}

function packageVersion(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; }
    catch { return null; }
}

// Decides what an existing .update-tmp means before a new update touches it.
// Returns { kind, reason }; the reason is plain text for update.log and for
// the refusal shown to the user.
//
// The directory is shared by four flows, which leave different shapes:
//
//   installStaged (Windows in-app helper, 0.9.35+) and the Unix in-app path
//   in server.cjs write a journal:
//     staged/              the validated new package, before the swap (helper only)
//     backup/              the previous files, renamed out during the swap
//     install-state.json   { phase: 'installing' | 'recovering' | 'rolled-back' | 'complete', ... }
//
//   scripts/updater.cjs (what update.bat still runs today) and the in-app
//   Windows path that shipped before the helper write NO journal:
//     <package>.zip, extracted/   the download
//     backup/                     the previous files
//     new-bin/ or skip-bin-update the staged bundled Node
//     latest-version              the release tag, written after the swap
//   Their finishing step (update.bat, or the restart .bat the old in-app
//   path generated) applies new-bin/, copies latest-version over the root
//   .installed-version and runs `rmdir /s /q .update-tmp 2>nul`. The rmdir
//   is silenced, so a handle held on anything beneath the directory leaves
//   part of it behind after the installation is complete. Reproduced on
//   Windows 10 with a FileShare.None handle on backup/dist/index.html: the
//   rmdir exits 0, deletes latest-version, new-bin/, extracted/, the archive
//   and every other backup entry, and leaves only backup/dist/index.html.
//
// 'debris'       Nothing in the directory is needed:
//                - the journal says 'complete';
//                - the journal says 'rolled-back' and backup/ is empty
//                  (restoreEntries renames every backed-up entry out before
//                  the phase becomes 'rolled-back');
//                - there is no backup/ at all, whatever else is present: a
//                  stale staged/ from a staging killed before its own
//                  cleanup, or a journal whose backup/ was deleted by hand.
//                  Both recovery tools treat that as nothing to restore
//                  (rollbackInterruptedUpdate returns without touching
//                  anything, recoverInterruptedInstallation returns and the
//                  updater then removes the directory), so refusing it would
//                  send the user to a command that cannot clear it;
//                - no journal, and latest-version is byte-equal to the root
//                  .installed-version: the finishing step of the old flow
//                  ran, so the swap it recorded is installed and backup/
//                  holds the release before it. Restoring that backup, as
//                  the recovery tools would, reverts a finished update;
//                - no journal, no latest-version, and the installation is
//                  stamped as finished for exactly the files it holds: the
//                  root .installed-version equals 'v' + the root
//                  package.json version, and every top-level entry of
//                  backup/ also exists at the root. This is the shape the
//                  silenced rmdir leaves (above). An old-flow update killed
//                  during the swap cannot produce it: entries are renamed
//                  in directory order, dist/ and node_modules/ leave the
//                  root before package.json, and the stamp is written only
//                  after the swap was validated, so a stamp that matches the
//                  root package.json with no entry missing means the swap
//                  finished.
//                Observed on the Windows portable: installStaged removes the
//                directory right after marking 'complete', but a handle still
//                held on a freshly renamed file under backup/ (antivirus,
//                search indexer) makes that rmSync fail, the failure was
//                logged as "cleanup deferred" and never retried, and every
//                later in-app update then died with "EEXIST: file already
//                exists, mkdir '...\.update-tmp'".
//
// 'interrupted'  backup/ holds files from a swap that did not finish:
//                the journal shows 'installing'/'recovering' or cannot be
//                read; or latest-version exists but differs from
//                .installed-version (the swap ran, the finishing step did
//                not: the root has the new app files, bin/ and the version
//                stamp are old); or there is no journal and no marker and
//                backup/ holds an entry the root lacks. Those files are the
//                only copy of the previous installation; the caller must
//                refuse and point the user at `scripts/updater.cjs
//                --rollback`. There is no liveness signal for a helper that
//                is still running (no pid file), so a concurrent install
//                classifies the same way: refusing is the safe outcome.
//
// 'absent'       No directory.
//
// scripts/updater-recovery.cjs carries the same rules, journal first and
// then marker and stamp (completedUpdateLeftover), because it must run when
// server/ is still inside backup/ and this file is copied on its own into a
// runner directory, so neither can load the other; keep the two in step.
// The journal must come first in both: the marker and stamp rules describe
// only the flows that write no journal, and applied to a helper killed
// mid-swap (journal 'installing', new dist/ next to the old package.json and
// its old stamp) they mistook the half-swapped root for a completed update.
function inspectUpdateTmp(root) {
    const tmp = path.join(root, '.update-tmp');
    if (!fs.existsSync(tmp)) return { kind: 'absent', reason: 'no .update-tmp' };
    const backup = path.join(tmp, 'backup');
    const journal = path.join(tmp, 'install-state.json');
    const state = readState(journal);
    if (state?.phase === 'complete') {
        // Same rule as completedUpdateLeftover in scripts/updater-recovery.cjs:
        // a finished journal beside a root that has since lost a backed-up
        // entry is not debris, because clearing it would take the only copy.
        // Refusing sends the user to --rollback, which restores that entry.
        const missing = fs.readdirSync(backup).filter(entry => !fs.existsSync(path.join(root, entry)));
        if (missing.length) {
            return { kind: 'interrupted', reason: `journal phase 'complete' but the root is missing ${missing.join(', ')}` };
        }
        return { kind: 'debris', reason: "journal phase 'complete'" };
    }
    if (!fs.existsSync(backup)) return { kind: 'debris', reason: 'no backup to restore' };
    const backedUp = fs.readdirSync(backup);
    if (state?.phase === 'rolled-back' && backedUp.length === 0) {
        return { kind: 'debris', reason: "journal phase 'rolled-back' and backup empty" };
    }
    if (fs.existsSync(journal)) {
        return { kind: 'interrupted', reason: state ? `journal phase '${state.phase}'` : 'journal unreadable' };
    }
    const marker = readMarker(path.join(tmp, 'latest-version'));
    const installed = readMarker(path.join(root, '.installed-version'));
    if (marker !== null) {
        if (installed !== null && marker.equals(installed)) {
            return { kind: 'debris', reason: `latest-version ${marker} matches .installed-version, so the finishing step ran` };
        }
        return { kind: 'interrupted', reason: `latest-version ${marker} was never finalised into .installed-version (${installed ?? 'absent'})` };
    }
    const version = packageVersion(root);
    const missing = backedUp.filter(name => !fs.existsSync(path.join(root, name)));
    if (version && installed !== null && installed.toString('utf8') === 'v' + version && missing.length === 0) {
        return { kind: 'debris', reason: `.installed-version v${version} matches the installed package.json and every backed-up entry exists at the root` };
    }
    return {
        kind: 'interrupted',
        reason: missing.length
            ? `backup holds entries missing from the installation: ${missing.join(', ')}`
            : `.installed-version (${installed ?? 'absent'}) does not stamp the installed package.json (${version ?? 'unreadable'})`,
    };
}

function classifyUpdateTmp(root) {
    return inspectUpdateTmp(root).kind;
}

// Plain-language refusal for an 'interrupted' .update-tmp. The command is the
// one update.bat / update.sh run themselves before updating
// (scripts/updater.cjs recoverInterruptedInstallation), spelled out for the
// user because the in-app updater cannot perform it while the server is the
// process holding the files. Every 'interrupted' verdict has a backup/ next
// to it (inspectUpdateTmp classifies a directory without one as debris), so
// the folder named here exists.
function interruptedUpdateMessage(root, reason = inspectUpdateTmp(root).reason) {
    const win = process.platform === 'win32';
    const backup = path.join(path.resolve(root), '.update-tmp', 'backup');
    const command = win ? 'bin\\node.exe scripts\\updater.cjs --rollback' : 'bin/node scripts/updater.cjs --rollback';
    const script = win ? 'update.bat' : './update.sh';
    return `A previous update did not finish (${reason}), so this one was not started. `
        + `The folder ${backup} holds the files from before that update; nothing has been deleted. `
        + `To restore them, close RisuVault and run this from the RisuVault folder:\n${command}\n`
        + `(${script} does the same before updating.) Do not delete .update-tmp by hand.`;
}

// Removes a directory, retrying briefly when the operating system still holds
// it open. On Windows a directory cannot be deleted while any process has a
// handle on anything beneath it; handles taken by antivirus or the search
// indexer on files that were just renamed into backup/ are released within
// tens of milliseconds, so a few short waits recover the common case without
// stalling a server that is already serving. A directory that outlives every
// attempt is classified as debris by classifyUpdateTmp on the next update.
async function removeTree(dir, log = () => {}, attempts = 5, delayMs = 200) {
    for (let attempt = 1; ; attempt++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); return; }
        catch (error) {
            if (attempt >= attempts) throw error;
            log(`Cleanup attempt ${attempt} of ${attempts} failed (${error.message}); retrying`);
            await sleep(delayMs * attempt);
        }
    }
}

function restoreEntries(root, backup, names) {
    const failures = [];
    for (const name of names) {
        const source = path.join(backup, name);
        if (!fs.existsSync(source)) continue;
        try {
            fs.rmSync(path.join(root, name), { recursive: true, force: true });
            fs.renameSync(source, path.join(root, name));
        } catch (error) { failures.push(`${name}: ${error.message}`); }
    }
    if (failures.length) throw new Error('Recovery incomplete; keep .update-tmp: ' + failures.join('; '));
}

function startAndVerify(root, env = process.env, timeoutMs = 60000, log = () => {}) {
    return new Promise((resolve, reject) => {
        const node = path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
        const child = spawn(node, ['server/node/server.cjs'], {
            cwd: root, env: { ...env, OPEN_BROWSER: '0' },
            detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let settled = false, output = '';
        const timer = setTimeout(() => fail(new Error('Updated server did not become ready')), timeoutMs);
        function fail(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode !== null || !child.pid) { reject(error); return; }
            // Wait until the process releases files before restoring the backup.
            child.once('exit', () => reject(error));
            child.kill();
        }
        child.on('error', fail);
        child.on('exit', code => fail(new Error(`Updated server exited (${code}) before readiness`)));
        const consume = chunk => {
            const text = chunk.toString();
            if (!settled) log(text.trim());
            output = (output + text).slice(-8192);
            if (!settled && /\[Server\] (HTTP|HTTPS) server is running\./.test(output)) {
                settled = true;
                clearTimeout(timer);
                // The server keeps its pipe readers while this helper stays alive.
                resolve(child);
            }
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', consume);
    });
}

async function installStaged(root, options = {}) {
    root = path.resolve(root);
    const tmp = path.join(root, '.update-tmp');
    const staged = path.join(tmp, 'staged');
    const backup = path.join(tmp, 'backup');
    const stateFile = path.join(tmp, 'install-state.json');
    const log = options.log || (() => {});
    const verify = options.verify || validatePackage;
    const start = options.start || (dir => startAndVerify(dir, process.env, 120000, log));
    if (fs.existsSync(backup)) throw new Error('Previous backup exists; recovery is required');
    const version = verify(staged);
    const keep = new Set(['save', 'backups', '.env', '.npmrc', '.portable', '.installed-version', '.update-tmp', 'update.log']);
    // The portable launcher (RisuVault.exe, built from scripts/portable/launcher.c
    // by release.yml) waits for its child and remains locked at pause. Its
    // stable launch contract does not need replacing during an app update.
    if (fs.existsSync(path.join(root, 'RisuVault.exe'))) keep.add('RisuVault.exe');
    const names = fs.readdirSync(staged).filter(name => !keep.has(name));
    fs.mkdirSync(backup);
    const state = { version, phase: 'installing', names, backedUp: [], installed: [] };
    writeState(stateFile, state);
    let child;
    try {
        for (const name of names) {
            const destination = path.join(root, name);
            if (fs.existsSync(destination)) {
                fs.renameSync(destination, path.join(backup, name));
                state.backedUp.push(name);
                writeState(stateFile, state);
            }
            fs.renameSync(path.join(staged, name), destination);
            state.installed.push(name);
            writeState(stateFile, state);
        }
        if (verify(root, path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')) !== version) {
            throw new Error('Installed version does not match staged version');
        }
        log('Package verified; starting updated server');
        child = await start(root);
    } catch (error) {
        log('Update failed: ' + error.message);
        state.phase = 'recovering';
        writeState(stateFile, state);
        // Remove only new entries that had no predecessor.
        for (const name of state.installed.filter(name => !state.backedUp.includes(name))) {
            fs.rmSync(path.join(root, name), { recursive: true, force: true });
        }
        restoreEntries(root, backup, state.backedUp);
        state.phase = 'rolled-back';
        writeState(stateFile, state);
        log('Previous files restored; diagnostic files retained in .update-tmp');
        throw error;
    }
    // Once a healthy server owns the files, metadata/cleanup failure must never
    // roll it back. Keep the backup for diagnosis if finalization fails.
    try {
        fs.writeFileSync(path.join(root, '.installed-version'), 'v' + version);
        state.phase = 'complete';
        writeState(stateFile, state);
        log(`Update complete: v${version}`);
        // The 'complete' journal above is what lets a directory that survives
        // these attempts be recognised as debris later instead of as an
        // interrupted install.
        await removeTree(tmp, log);
    } catch (error) { log('Server is ready; backup cleanup deferred: ' + error.message); }
    return child;
}

async function runHelper(root, pid) {
    const log = message => fs.appendFileSync(path.join(root, 'update.log'), `${new Date().toISOString()} ${message}\n`);
    try {
        log('Waiting for server to exit');
        if (process.send) { process.send({ ready: true }); process.disconnect(); }
        await waitForExit(pid);
        const child = await installStaged(root, { log });
        // Keep consuming the server's output. This helper exits with that server.
        child.once('exit', code => process.exit(code || 0));
    } catch (error) {
        log('Update stopped: ' + error.message);
        process.exitCode = 1;
    }
}

async function stageWindowsUpdate(root, source, parentPid, log = message => console.log('[Update] ' + message)) {
    const tmp = path.join(root, '.update-tmp');
    // Never discard an interrupted installation or its only recoverable backup;
    // only clear what a finished or rolled-back update left behind. The mkdir
    // stays non-recursive so a directory that appears between the check and
    // the mkdir (another updater racing on the same folder) still fails
    // instead of being shared.
    const leftover = inspectUpdateTmp(root);
    if (leftover.kind === 'interrupted') throw new Error(interruptedUpdateMessage(root, leftover.reason));
    if (leftover.kind === 'debris') {
        log(`Removing .update-tmp left by an earlier update (${leftover.reason}; entries: ${fs.readdirSync(tmp).join(', ') || 'none'})`);
        try { await removeTree(tmp, log); }
        catch (error) {
            // The handle that defeated the earlier cleanup may still be held
            // (the rmdir experiment above shows what such a handle leaves).
            // Name the directory so the user can find what holds it instead
            // of seeing the bare EBUSY/EPERM.
            throw new Error(`Could not remove ${tmp}, left by an earlier update that completed (${leftover.reason}): ${error.message}`);
        }
    }
    await fs.promises.mkdir(tmp);
    try {
    const staged = path.join(tmp, 'staged');
    await fs.promises.cp(source, staged, { recursive: true });
    const certificate = path.join(root, 'server', 'node', 'ssl', 'certificate');
    if (fs.existsSync(certificate)) {
        await fs.promises.cp(certificate, path.join(staged, 'server', 'node', 'ssl', 'certificate'), { recursive: true });
    }
    validatePackage(staged, path.join(staged, 'bin', 'node.exe'));
    const runner = await fs.promises.mkdtemp(path.join(require('node:os').tmpdir(), 'risubard-updater-'));
    const helper = path.join(runner, 'portable-update.cjs');
    const node = path.join(runner, 'node.exe');
    await fs.promises.copyFile(__filename, helper);
    await fs.promises.copyFile(process.execPath, node);
    return await new Promise((resolve, reject) => {
        const child = spawn(node, [helper, '--install', root, String(parentPid)], {
            cwd: runner, detached: true, windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Update helper did not start')); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Update helper exited: ${code}`)); });
        child.once('message', message => {
            if (message?.ready) { clearTimeout(timer); child.unref(); resolve(child); }
        });
    });
    } catch (error) {
        if (!fs.existsSync(path.join(tmp, 'backup')) && !fs.existsSync(path.join(tmp, 'install-state.json'))) {
            await fs.promises.rm(tmp, { recursive: true, force: true });
        }
        throw error;
    }
}

module.exports = {
    validatePackage, waitForExit, restoreEntries, installStaged, startAndVerify, stageWindowsUpdate,
    writeState, inspectUpdateTmp, classifyUpdateTmp, interruptedUpdateMessage, removeTree,
};
if (require.main === module) {
    const [mode, root, pid] = process.argv.slice(2);
    if (mode === '--validate') console.log(validatePackage(root));
    else if (mode === '--install') runHelper(path.resolve(root), Number(pid));
    else throw new Error('Expected --validate ROOT or --install ROOT PID');
}
