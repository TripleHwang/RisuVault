/**
 * Portable updater — runs with the bundled bin/node, no npm dependencies.
 * Downloads the latest portable zip/tar.gz from GitHub Releases,
 * replaces app files while preserving save/.
 * On Windows, bundled Node (bin/) is staged and copied by update.bat
 * after this process exits, to avoid self-replacement file locks.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { rollbackInterruptedUpdate, completedUpdateLeftover, describeLeftover } = require('./updater-recovery.cjs');

// A standalone build must be pointed at the fork that owns its releases.
// Do not fall back to the upstream repository: its artifacts may carry a
// different schema, bundled code, or security policy.
const REPO = (process.env.RISU_UPDATE_REPOSITORY || 'TripleHwang/RisuVault').trim();
const ROOT = path.resolve(__dirname, '..');

// Everything under server/ is moved to .update-tmp/backup while an update is
// applied, so a killed update can leave it absent until the backup is
// restored. scripts/ is never moved. These helpers are therefore loaded on
// demand rather than at module init: the --rollback path needs nothing from
// server/, and the normal path restores an interrupted backup first (see
// recoverInterruptedInstallation) using updater-recovery.cjs, which is
// self-contained. The specifiers stay string literals on purpose —
// scripts/portable/gen-server-deps.cjs walks this file's require graph and
// rejects non-literal specifiers.
function loadPortableUpdate() {
    return require('../server/node/portable-update.cjs');
}
function loadUpdateManifest() {
    return require('../server/node/update-manifest.cjs');
}

const isWin = process.platform === 'win32';
const REQUIRED_ENTRIES = ['dist', 'server', 'package.json', 'node_modules'];
const REQUIRED_DIST_FILES = ['index.html'];
const REQUIRED_WIN_ENTRIES = ['bin'];
const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);

function log(msg) {
    process.stdout.write(`[updater] ${msg}\n`);
    try { fs.appendFileSync(path.join(ROOT, 'update.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
function error(msg) { log(`[ERROR] ${msg}`); process.exit(1); }

function getCurrentVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        return 'v' + pkg.version;
    } catch { return 'unknown'; }
}

// If the user moved the server-backup directory to a custom location *inside*
// ROOT (e.g. <ROOT>/data/backups), the server writes the absolute path here so
// the updater can preserve the top-level segment instead of wiping it.
// Outside-ROOT paths return null (updater never touches them anyway).
function getCustomBackupKeepEntry() {
    const markerPath = path.join(ROOT, 'save', '__backup_path');
    try {
        if (!fs.existsSync(markerPath)) return null;
        const raw = fs.readFileSync(markerPath, 'utf-8').trim();
        if (!raw) return null;
        const abs = path.resolve(raw);
        const rel = path.relative(ROOT, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        if (!rel) {
            error('Custom backup directory points at the RisuVault app root. Move it to a separate folder before updating.');
        }
        const top = rel.split(path.sep)[0];
        if (MANAGED_BACKUP_PATH_ROOTS.has(top)) {
            error(`Custom backup directory is inside RisuVault app files (${rel}). Move it to a separate folder such as data/backups before updating.`);
        }
        return top || null;
    } catch {
        return null;
    }
}

const MAX_REDIRECTS = 10;

function httpsGet(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        if (!url.startsWith('https://')) return reject(new Error('Updater only allows HTTPS downloads'));
        https.get(url, { headers: { 'User-Agent': 'RisuVault-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function downloadToFile(url, dest, expected, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const file = fs.createWriteStream(dest);
        if (!url.startsWith('https://')) return reject(new Error('Updater only allows HTTPS downloads'));
        https.get(url, { headers: { 'User-Agent': 'RisuVault-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlinkSync(dest);
                if (!res.headers.location.startsWith('https://')) return reject(new Error('Updater redirect must remain on HTTPS'));
                return downloadToFile(res.headers.location, dest, expected, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            if (total > 0 && total !== expected.size) {
                file.close();
                return reject(new Error(`Download size mismatch (expected ${expected.size}, got ${total})`));
            }
            let downloaded = 0;
            const hash = crypto.createHash('sha256');
            res.on('data', (chunk) => {
                downloaded += chunk.length;
                hash.update(chunk);
                if (total > 0) {
                    const pct = ((downloaded / total) * 100).toFixed(1);
                    process.stdout.write(`\r[updater] Downloading... ${pct}%  `);
                }
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                process.stdout.write('\n');
                if (downloaded !== expected.size) return reject(new Error(`Download size mismatch (expected ${expected.size}, got ${downloaded})`));
                if (hash.digest('hex') !== expected.sha256) return reject(new Error('Downloaded package SHA-256 does not match the trusted release manifest'));
                resolve();
            });
            file.on('error', reject);
        }).on('error', reject);
    });
}

function resolveExtractedRoot(extractedDir) {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
        return path.join(extractedDir, entries[0].name);
    }
    return extractedDir;
}

function validateExtractedRoot(extractedRoot) {
    loadPortableUpdate().validatePackage(extractedRoot);
    for (const entry of REQUIRED_ENTRIES) {
        if (!fs.existsSync(path.join(extractedRoot, entry))) {
            throw new Error(`Downloaded package is missing required entry: ${entry}`);
        }
    }
    if (isWin) {
        for (const entry of REQUIRED_WIN_ENTRIES) {
            if (!fs.existsSync(path.join(extractedRoot, entry))) {
                throw new Error(`Downloaded Windows package is missing required entry: ${entry}`);
            }
        }
    }
    for (const file of REQUIRED_DIST_FILES) {
        if (!fs.existsSync(path.join(extractedRoot, 'dist', file))) {
            throw new Error(`Downloaded package is missing dist/${file}`);
        }
    }
}

function restoreBackupIntoRoot(backupDir) {
    if (!fs.existsSync(backupDir)) return;
    const { restoreEntries } = loadPortableUpdate();
    restoreEntries(ROOT, backupDir, fs.readdirSync(backupDir).filter(entry => entry !== 'update.bat'));
}

// A previous update may have been killed part-way. Put the installation back
// together before reading its version, so a half-applied update is never
// mistaken for an installed one.
function recoverInterruptedInstallation() {
    const tmpDir = path.join(ROOT, '.update-tmp');
    const interrupted = path.join(tmpDir, 'backup');
    if (!fs.existsSync(interrupted)) return;
    const statePath = path.join(tmpDir, 'install-state.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    if (state?.phase === 'complete') {
        loadPortableUpdate().validatePackage(ROOT);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return;
    }
    // The flows that run without a journal (this script itself, and the
    // in-app path before 0.9.35) leave the whole directory, or the part a held
    // handle protected from update.bat's silenced rmdir, behind AFTER the
    // installation completed. Restoring such a backup/ reverted the finished
    // update to the release before it, and update.bat then re-applied the
    // update it had just undone. The rules that recognise those shapes live in
    // updater-recovery.cjs; the installation is validated first, as for a
    // 'complete' journal, so a leftover next to a broken installation still
    // falls through to the restore below.
    if (!state) {
        const completed = completedUpdateLeftover(ROOT);
        if (completed) {
            let valid = true;
            try { loadPortableUpdate().validatePackage(ROOT); }
            catch (e) {
                valid = false;
                log(`Installation next to a completed update's leftover failed validation (${e.message}); restoring its backup.`);
            }
            if (valid) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                log(`Cleared ${describeLeftover(completed)}; existing installation was not changed.`);
                return;
            }
        }
    }
    log('Recovering interrupted installation before checking its version...');
    if (!fs.existsSync(path.join(ROOT, 'server', 'node', 'portable-update.cjs'))) {
        // server/ itself is still in the backup, so the restore helper cannot
        // be loaded from it. updater-recovery.cjs needs nothing from server/.
        rollbackInterruptedUpdate(ROOT, { log });
        return;
    }
    restoreBackupIntoRoot(interrupted);
}

function assertNoOtherWindowsRuntimeProcesses() {
    if (!isWin) return;

    const script = [
        "$target = [IO.Path]::GetFullPath($env:RISUBARD_RUNTIME_DIR).TrimEnd('\\')",
        '$selfPid = [int]$env:RISUBARD_UPDATER_PID',
        "$launcher = Join-Path $env:RISUBARD_INSTALL_DIR 'RisuVault.exe'",
        "$running = @(Get-Process -Name node,cloudflared,RisuVault -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $selfPid -and $_.Path -and ([IO.Path]::GetFullPath((Split-Path -Parent $_.Path)).TrimEnd('\\') -ieq $target -or $_.Path -ieq $launcher) })",
        "if ($running.Count -gt 0) { $running | ForEach-Object { Write-Output ('{0} (PID {1})' -f $_.Path, $_.Id) }; exit 23 }",
    ].join('; ');

    try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                RISUBARD_RUNTIME_DIR: path.join(ROOT, 'bin'),
                RISUBARD_INSTALL_DIR: ROOT,
                RISUBARD_UPDATER_PID: String(process.pid),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) {
        const details = String(e.stdout || '').trim();
        if (e.status === 23) {
            throw new Error(
                `Another RisuVault runtime is still running. Close every RisuVault console and remote-access tunnel, then run update.bat again.${details ? `\n${details}` : ''}`
            );
        }
        throw new Error(`Could not verify that RisuVault is closed. Close it and run update.bat again. (${e.message})`);
    }
}

function listFilesRecursive(dir, baseDir = dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            listFilesRecursive(fullPath, baseDir, files);
            continue;
        }
        if (entry.isFile()) {
            files.push(path.relative(baseDir, fullPath));
        }
    }
    files.sort();
    return files;
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function areDirectoriesEquivalent(a, b) {
    const filesA = listFilesRecursive(a);
    const filesB = listFilesRecursive(b);
    if (filesA.length !== filesB.length) return false;

    for (let i = 0; i < filesA.length; i += 1) {
        if (filesA[i] !== filesB[i]) return false;
        const left = path.join(a, filesA[i]);
        const right = path.join(b, filesB[i]);
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        if (leftStat.size !== rightStat.size) return false;
        if (hashFile(left) !== hashFile(right)) return false;
    }

    return true;
}

async function main() {
    assertNoOtherWindowsRuntimeProcesses();
    recoverInterruptedInstallation();
    if (!REPO) {
        error('Self-update is not configured. Set RISU_UPDATE_REPOSITORY to the owner/repository that publishes this standalone build.');
    }
    const { validatePackage } = loadPortableUpdate();
    const { compareUpdateVersions, isAllowedGitHubReleaseUrl, validateUpdateManifest } = loadUpdateManifest();
    const current = getCurrentVersion();
    log(`Current version: ${current}`);
    log('Checking for updates...');

    const updateChannel = process.env.RISU_UPDATE_CHANNEL || (current.includes('-') ? 'beta' : 'stable');
    const releasePath = updateChannel === 'stable' ? 'releases/latest' : 'releases?per_page=20';
    const data = await httpsGet(`https://api.github.com/repos/${REPO}/${releasePath}`);
    const payload = JSON.parse(data.toString());
    const release = Array.isArray(payload)
        ? payload.find(candidate => !candidate?.draft && (updateChannel !== 'stable' || !candidate?.prerelease))
        : payload;
    if (!release) error(`No ${updateChannel} release is available.`);
    const latest = release.tag_name;

    if (!latest) error('Could not determine latest version.');

    if (current === latest) {
        try {
            validatePackage(ROOT);
            log(`Already up to date (${current}); dependencies verified.`);
            return;
        } catch { log('Current installation is incomplete; downloading the same version to repair it.'); }
    }

    log(`New version available: ${latest}`);

    const manifestAsset = (release.assets || []).find(a => a.name === 'update-manifest.json');
    if (!manifestAsset || !isAllowedGitHubReleaseUrl(manifestAsset.browser_download_url, [REPO])) {
        error(`This release has no trusted update manifest. Download it manually from:\n  ${release.html_url}`);
    }
    const manifest = JSON.parse((await httpsGet(manifestAsset.browser_download_url)).toString('utf8'));
    const platform = isWin ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
    const validation = validateUpdateManifest(manifest, {
        productId: 'risuvault',
        channel: updateChannel,
        currentVersion: current,
        platform,
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        allowedGithubRepositories: [REPO],
    });
    if (!validation.valid || compareUpdateVersions(validation.manifest?.version, latest) !== 0) {
        error(`Release update manifest is not compatible: ${validation.reason || 'release tag mismatch'}`);
    }
    const asset = validation.artifact;
    const assetName = decodeURIComponent(new URL(asset.url).pathname.split('/').pop() || 'update-package');

    const tmpDir = path.join(ROOT, '.update-tmp');
    if (fs.existsSync(tmpDir)) {
        const prevBackup = path.join(tmpDir, 'backup');
        if (fs.existsSync(prevBackup)) {
            log('Restoring files from previous interrupted update...');
            restoreBackupIntoRoot(prevBackup);
        }
        fs.rmSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    const downloadPath = path.join(tmpDir, assetName);
    log(`Downloading ${assetName}...`);
    await downloadToFile(asset.url, downloadPath, asset);

    log('Extracting...');
    const extractedPath = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractedPath, { recursive: true });
    if (assetName.endsWith('.zip')) {
        execSync(`powershell -Command "Expand-Archive -Path '${downloadPath}' -DestinationPath '${extractedPath}' -Force"`, { stdio: 'inherit' });
    } else {
        execSync(`tar -xzf "${downloadPath}" -C "${extractedPath}"`, { stdio: 'inherit' });
    }

    const extractedDir = path.join(tmpDir, 'extracted');
    const extractedRoot = resolveExtractedRoot(extractedDir);
    validateExtractedRoot(extractedRoot);
    const certificate = path.join(ROOT, 'server', 'node', 'ssl', 'certificate');
    if (fs.existsSync(certificate)) {
        fs.cpSync(certificate, path.join(extractedRoot, 'server', 'node', 'ssl', 'certificate'), { recursive: true });
    }
    const currentBin = path.join(ROOT, 'bin');
    const newBin = path.join(extractedRoot, 'bin');
    const skipBinReplacement = fs.existsSync(currentBin)
        && fs.existsSync(newBin)
        && areDirectoriesEquivalent(currentBin, newBin);
    if (skipBinReplacement) {
        log('Bundled Node unchanged; skipping bin/ replacement.');
    }

    // Phase 1: move old files to backup (safer than immediate delete)
    log('Replacing files...');
    const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable', 'update.log', 'update.bat']);
    if (isWin || skipBinReplacement) keep.add('bin');
    const customBackupKeep = getCustomBackupKeepEntry();
    if (customBackupKeep && !keep.has(customBackupKeep)) {
        log(`Preserving custom backup directory: ${customBackupKeep}/`);
        keep.add(customBackupKeep);
    }
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });

    for (const entry of fs.readdirSync(ROOT)) {
        if (keep.has(entry)) continue;
        try {
            fs.renameSync(path.join(ROOT, entry), path.join(backupDir, entry));
        } catch (e) {
            log(`Error backing up ${entry}: ${e.message}`);
            log('Restoring files already moved to backup...');
            restoreBackupIntoRoot(backupDir);
            error(isWin
                ? 'Update failed because some files are in use. Close the running RisuVault window/console first, then run update.bat again.'
                : 'Update failed because some files are in use. Stop the running server first, then try again.');
        }
    }

    // Phase 2: move new files from extracted to root
    const moved = [];
    const skipMove = new Set(['save', 'scripts', 'update.bat']);
    if (isWin || skipBinReplacement) skipMove.add('bin');
    try {
        for (const entry of fs.readdirSync(extractedRoot)) {
            if (skipMove.has(entry)) continue;
            const src = path.join(extractedRoot, entry);
            const dest = path.join(ROOT, entry);
            if (fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            fs.renameSync(src, dest);
            moved.push(entry);
        }
        for (const entry of REQUIRED_ENTRIES) {
            if (!moved.includes(entry) && !fs.existsSync(path.join(ROOT, entry))) {
                throw new Error(`Required entry was not installed: ${entry}`);
            }
        }
        for (const file of REQUIRED_DIST_FILES) {
            if (!fs.existsSync(path.join(ROOT, 'dist', file))) {
                throw new Error(`Required file was not installed: dist/${file}`);
            }
        }
        validatePackage(ROOT);
    } catch (e) {
        // Restore from backup on failure
        log(`Error moving files: ${e.message}`);
        log('Restoring from backup...');
        restoreBackupIntoRoot(backupDir);
        error('Update failed, previous version restored. Please try again.');
    }

    // Phase 3: update scripts/ from new release
    const newScripts = path.join(extractedRoot, 'scripts');
    if (fs.existsSync(newScripts)) {
        if (!fs.existsSync(path.join(ROOT, 'scripts'))) {
            fs.mkdirSync(path.join(ROOT, 'scripts'));
        }
        for (const f of fs.readdirSync(newScripts)) {
            fs.copyFileSync(path.join(newScripts, f), path.join(ROOT, 'scripts', f));
        }
    }

    // Phase 4 (Windows): stage bin/ update for update.bat post-step
    if (isWin) {
        if (!fs.existsSync(newBin)) {
            error('Downloaded Windows package is missing bin/. Update aborted before version finalize.');
        }
        const stagedBin = path.join(tmpDir, 'new-bin');
        const skipBinUpdate = path.join(tmpDir, 'skip-bin-update');
        try { fs.rmSync(stagedBin, { recursive: true, force: true }); } catch { /* noop */ }
        try { fs.rmSync(skipBinUpdate, { force: true }); } catch { /* noop */ }
        if (skipBinReplacement) {
            fs.writeFileSync(skipBinUpdate, 'same');
        } else {
            fs.cpSync(newBin, stagedBin, { recursive: true });
            log('Staged bundled Node update (will be applied after updater exits).');
        }
    }

    // Write version marker after all file replacement is truly complete.
    // On Windows, update.bat finalizes this after bin/ replacement succeeds.
    if (isWin) {
        fs.writeFileSync(path.join(tmpDir, 'latest-version'), latest);
        log('Staged version marker update for post-step finalize.');
    } else {
        fs.writeFileSync(path.join(ROOT, '.installed-version'), latest);
    }

    // Cleanup
    if (isWin) {
        log('Leaving .update-tmp for update.bat post-step cleanup.');
    } else {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        catch { log('Warning: could not remove .update-tmp, you can delete it manually.'); }
    }

    log(`Update complete! ${current} → ${latest}`);
    log('');
    if (isWin) {
        log('Restart by running RisuVault.exe');
    } else {
        log('Restart by running ./start.sh');
    }
}

if (process.argv.includes('--rollback')) {
    try {
        rollbackInterruptedUpdate(ROOT, { log });
    } catch (e) {
        error(`Automatic rollback failed: ${e.message}`);
    }
} else {
    main().catch((e) => error(e.message));
}
