'use strict';

// Built-ins only: copied outside the installation and run by a private Node
// executable so neither the running server nor the helper locks bin/node.exe.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function validatePackage(root, node = process.execPath) {
    const script = String.raw`
        const fs = require('node:fs'), path = require('node:path');
        const root = fs.realpathSync(process.argv[1]);
        for (const file of ['dist/index.html', 'server/node/server.cjs', 'package.json', 'node_modules']) {
            if (!fs.existsSync(path.join(root, file))) throw new Error('Missing package file: ' + file);
        }
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const r = require('node:module').createRequire(path.join(root, 'server/node/server.cjs'));
        for (const name of new Set(['express', ...Object.keys(pkg.dependencies || {})])) {
            const resolved = fs.realpathSync(path.join(root, 'node_modules', name, 'package.json'));
            const relative = path.relative(root, resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Dependency outside package: ' + name);
        }
        for (const name of ['express', 'compression', 'node-html-parser', 'express-rate-limit', 'ws', 'wasm-vips', 'msgpackr']) {
            if (pkg.dependencies?.[name] || name === 'express') r(name);
        }
        process.stdout.write(pkg.version);
    `;
    return execFileSync(node, ['-e', script, path.resolve(root)], {
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
    // The portable launcher waits for its child and remains locked at pause.
    // Its stable launch contract does not need replacing during an app update.
    if (fs.existsSync(path.join(root, 'RisuBard.exe'))) keep.add('RisuBard.exe');
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
        fs.rmSync(tmp, { recursive: true, force: true });
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

async function stageWindowsUpdate(root, source, parentPid) {
    const tmp = path.join(root, '.update-tmp');
    // Never discard an interrupted installation or its only recoverable backup.
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

module.exports = { validatePackage, waitForExit, restoreEntries, installStaged, startAndVerify, stageWindowsUpdate };
if (require.main === module) {
    const [mode, root, pid] = process.argv.slice(2);
    if (mode === '--validate') console.log(validatePackage(root));
    else if (mode === '--install') runHelper(path.resolve(root), Number(pid));
    else throw new Error('Expected --validate ROOT or --install ROOT PID');
}
