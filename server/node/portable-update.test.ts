import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
    validatePackage, waitForExit, restoreEntries, installStaged, stageWindowsUpdate,
    classifyUpdateTmp, inspectUpdateTmp, interruptedUpdateMessage, removeTree,
} = require('./portable-update.cjs')
const { rollbackInterruptedUpdate, completedUpdateLeftover } = require('../../scripts/updater-recovery.cjs')
const temporaryRoots: string[] = []

function temporaryRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-update-test-'))
    temporaryRoots.push(root)
    return root
}

function write(root: string, name: string, content: string) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

function packageFixture(root: string, version = '0.9.35') {
    write(root, 'package.json', JSON.stringify({ version, dependencies: { express: '*' } }))
    write(root, 'dist/index.html', version)
    write(root, 'server/node/server.cjs', "require('express')")
    write(root, 'node_modules/express/package.json', JSON.stringify({ name: 'express', main: 'index.js' }))
    write(root, 'node_modules/express/index.js', 'module.exports = function express() {}')
}

function installationFixture() {
    const root = temporaryRoot()
    packageFixture(root, '0.9.34')
    packageFixture(path.join(root, '.update-tmp/staged'))
    write(root, 'save/characters.json', 'keep my characters')
    write(root, '.installed-version', 'v0.9.34')
    return root
}

const readVersion = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

afterEach(() => {
    vi.restoreAllMocks()
    for (const root of temporaryRoots.splice(0)) {
        if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('risubard-update-test-')) {
            throw new Error('Refusing to remove unexpected fixture path')
        }
        fs.rmSync(root, { recursive: true, force: true })
    }
})

describe('portable package verification', () => {
    test('loads express in a real subprocess and returns the packaged version', () => {
        const root = temporaryRoot()
        packageFixture(root)
        expect(validatePackage(root)).toBe('0.9.35')
    })

    test('rejects a missing runtime dependency', () => {
        const root = temporaryRoot()
        packageFixture(root)
        fs.rmSync(path.join(root, 'node_modules/express'), { recursive: true })
        expect(() => validatePackage(root)).toThrow(/express/)
    })

    test('rejects express resolved from a parent installation', () => {
        const parent = temporaryRoot()
        packageFixture(parent)
        const root = path.join(parent, 'nested-installation')
        packageFixture(root)
        fs.rmSync(path.join(root, 'node_modules/express'), { recursive: true })
        expect(() => validatePackage(root)).toThrow(/express/)
    })

    test('rejects a dependency whose entry exists but cannot actually load', () => {
        const root = temporaryRoot()
        packageFixture(root)
        write(root, 'node_modules/express/index.js', "require('./missing-transitive-dependency')")
        expect(() => validatePackage(root)).toThrow(/missing-transitive-dependency/)
    })

    // The portable ships the app package.json (69 dependencies) but only the
    // server closure from scripts/portable/server-deps/ (12 packages) under
    // node_modules, so the app manifest must not be the reference list.
    // release.yml ships the closure as the flat file scripts/server-deps.json
    // because Phase 3 of scripts/updater.cjs copies every scripts/ entry with
    // fs.copyFileSync, which throws on a subdirectory.
    test('validates node_modules against the shipped server-deps closure, not the app package.json', () => {
        const root = temporaryRoot()
        packageFixture(root)
        write(root, 'package.json', JSON.stringify({ version: '0.9.35', dependencies: { express: '*', 'frontend-only': '*' } }))
        expect(() => validatePackage(root)).toThrow(/frontend-only/)
        write(root, 'scripts/server-deps.json', JSON.stringify({ dependencies: { express: '*', fflate: '*' } }))
        expect(() => validatePackage(root)).toThrow(/fflate/)
        write(root, 'node_modules/fflate/package.json', JSON.stringify({ name: 'fflate', main: 'index.js' }))
        write(root, 'node_modules/fflate/index.js', 'module.exports = {}')
        expect(validatePackage(root)).toBe('0.9.35')
    })

    // A source checkout has the closure only at its repository path, so the
    // same check applies there; the portable's flat file takes precedence
    // when both exist.
    test('falls back to the repository closure manifest of a source checkout', () => {
        const root = temporaryRoot()
        packageFixture(root)
        write(root, 'package.json', JSON.stringify({ version: '0.9.35', dependencies: { express: '*', 'frontend-only': '*' } }))
        write(root, 'scripts/portable/server-deps/package.json', JSON.stringify({ dependencies: { express: '*', fflate: '*' } }))
        expect(() => validatePackage(root)).toThrow(/fflate/)
        write(root, 'scripts/server-deps.json', JSON.stringify({ dependencies: { express: '*' } }))
        expect(validatePackage(root)).toBe('0.9.35')
    })
})

describe('portable installation transaction', () => {
    test('does not roll back a running server if writing the version marker fails', async () => {
        const root = installationFixture()
        const child = { pid: 123 }
        const originalWrite = fs.writeFileSync
        const logs: string[] = []
        const result = await installStaged(root, {
            verify: readVersion,
            start: async () => {
                vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
                    if (String(file) === path.join(root, '.installed-version')) throw new Error('metadata write denied')
                    return originalWrite(file, ...args)
                })
                return child
            },
            log: (line: string) => logs.push(line),
        })
        expect(result).toBe(child)
        expect(readVersion(root)).toBe('0.9.35')
        expect(fs.existsSync(path.join(root, '.update-tmp/backup/package.json'))).toBe(true)
        expect(logs.join('\n')).toContain('metadata write denied')
    })

    test('marks success and removes the backup only after the new server starts', async () => {
        const root = installationFixture()
        const child = { pid: 123 }
        const start = vi.fn(async () => {
            expect(readVersion(root)).toBe('0.9.35')
            expect(fs.existsSync(path.join(root, '.update-tmp/backup/package.json'))).toBe(true)
            expect(fs.readFileSync(path.join(root, '.installed-version'), 'utf8')).toBe('v0.9.34')
            return child
        })
        expect(await installStaged(root, { verify: readVersion, start })).toBe(child)
        expect(start).toHaveBeenCalledOnce()
        expect(fs.readFileSync(path.join(root, '.installed-version'), 'utf8')).toBe('v0.9.35')
        expect(fs.readFileSync(path.join(root, 'save/characters.json'), 'utf8')).toBe('keep my characters')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test('rejects an invalid staged package before moving any installed file', async () => {
        const root = installationFixture()
        const start = vi.fn()
        await expect(installStaged(root, {
            verify: () => { throw new Error('Missing express') }, start,
        })).rejects.toThrow('Missing express')
        expect(readVersion(root)).toBe('0.9.34')
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
        expect(start).not.toHaveBeenCalled()
    })

    test('restores old files after startup failure and preserves saves and diagnostics', async () => {
        const root = installationFixture()
        write(root, '.update-tmp/staged/new-file.txt', 'new version only')
        const logs: string[] = []
        await expect(installStaged(root, {
            verify: readVersion,
            start: async () => { throw new Error('server failed to start') },
            log: (line: string) => logs.push(line),
        })).rejects.toThrow('server failed to start')
        expect(readVersion(root)).toBe('0.9.34')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.34')
        expect(fs.readFileSync(path.join(root, '.installed-version'), 'utf8')).toBe('v0.9.34')
        expect(fs.readFileSync(path.join(root, 'save/characters.json'), 'utf8')).toBe('keep my characters')
        expect(fs.existsSync(path.join(root, 'new-file.txt'))).toBe(false)
        expect(JSON.parse(fs.readFileSync(path.join(root, '.update-tmp/install-state.json'), 'utf8')).phase).toBe('rolled-back')
        expect(logs.join('\n')).toContain('server failed to start')
    })

    test('refuses to overwrite an earlier recovery backup', async () => {
        const root = installationFixture()
        write(root, '.update-tmp/backup/precious.txt', 'earlier installation')
        await expect(installStaged(root, { verify: readVersion })).rejects.toThrow('Previous backup exists')
        expect(fs.readFileSync(path.join(root, '.update-tmp/backup/precious.txt'), 'utf8')).toBe('earlier installation')
        expect(readVersion(root)).toBe('0.9.34')
    })

    test('retains the only backup when recovery cannot rename a locked entry', () => {
        const root = temporaryRoot()
        const backup = path.join(root, '.update-tmp/backup')
        write(backup, 'package.json', 'original package')
        write(root, 'package.json', 'new package')
        const rename = fs.renameSync
        vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (String(source) === path.join(backup, 'package.json')) throw new Error('EPERM: locked entry')
            return rename(source, destination)
        })
        expect(() => restoreEntries(root, backup, ['package.json'])).toThrow('Recovery incomplete')
        expect(fs.readFileSync(path.join(backup, 'package.json'), 'utf8')).toBe('original package')
    })
})

describe('Windows update staging failures', () => {
    test('removes incomplete staging after a copy failure so the update can be retried', async () => {
        const root = temporaryRoot()
        vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('copy failed'))
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid)).rejects.toThrow('copy failed')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test('removes staging after package validation fails without touching installed files', async () => {
        const root = temporaryRoot()
        packageFixture(root, '0.9.34')
        const source = temporaryRoot()
        packageFixture(source)
        // A missing bundled Node prevents package validation before any helper is launched.
        await expect(stageWindowsUpdate(root, source, process.pid)).rejects.toThrow()
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        expect(readVersion(root)).toBe('0.9.34')
    })

    test('preserves an existing recovery directory when staging is requested again', async () => {
        const root = temporaryRoot()
        write(root, '.update-tmp/backup/precious.txt', 'only recovery copy')
        await expect(stageWindowsUpdate(root, root, process.pid)).rejects.toThrow()
        expect(fs.readFileSync(path.join(root, '.update-tmp/backup/precious.txt'), 'utf8')).toBe('only recovery copy')
    })
})

// Every file under a directory with its bytes, so "untouched" can be asserted
// rather than inferred from one sentinel file.
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) { out[path.relative(dir, full) + '/'] = ''; walk(full) }
            else out[path.relative(dir, full)] = fs.readFileSync(full).toString('base64')
        }
    }
    walk(dir)
    return out
}

describe('existing .update-tmp before staging', () => {
    test('classifies the journal and backup into absent, debris and interrupted', () => {
        const root = temporaryRoot()
        expect(classifyUpdateTmp(root)).toBe('absent')
        fs.mkdirSync(path.join(root, '.update-tmp'))
        expect(classifyUpdateTmp(root)).toBe('debris')
        write(root, '.update-tmp/staged/package.json', '{}')
        expect(classifyUpdateTmp(root)).toBe('debris')
        write(root, '.update-tmp/backup/package.json', 'previous')
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ phase: 'installing' }))
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ phase: 'recovering' }))
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ phase: 'rolled-back' }))
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        fs.rmSync(path.join(root, '.update-tmp/backup/package.json'))
        expect(classifyUpdateTmp(root)).toBe('debris')
        write(root, '.update-tmp/backup/package.json', 'previous')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ phase: 'complete' }))
        // A finished install still has every backed-up entry at the root;
        // without it the journal alone does not make the leftover debris.
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        write(root, 'package.json', 'installed')
        expect(classifyUpdateTmp(root)).toBe('debris')
        write(root, '.update-tmp/install-state.json', 'not json')
        expect(classifyUpdateTmp(root)).toBe('interrupted')
    })

    test('removes debris from a completed update and stages into a fresh directory', async () => {
        const root = temporaryRoot()
        write(root, 'package.json', 'installed by the completed update')
        write(root, '.update-tmp/backup/package.json', 'files of the release before the completed update')
        write(root, '.update-tmp/staged/package.json', 'already installed')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'complete', names: ['package.json'], backedUp: ['package.json'], installed: ['package.json'] }))
        const logs: string[] = []
        // The copy is the first step after the directory exists; failing it
        // proves the mkdir succeeded and stops before any helper is launched.
        vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('copy reached'))
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, (line: string) => logs.push(line))).rejects.toThrow('copy reached')
        expect(logs.join('\n')).toMatch(/Removing \.update-tmp .*journal phase 'complete'.*backup, install-state\.json, staged/)
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test('removes debris that has neither a journal nor a backup', async () => {
        const root = temporaryRoot()
        write(root, '.update-tmp/staged/package.json', 'stale staging')
        const logs: string[] = []
        vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('copy reached'))
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, (line: string) => logs.push(line))).rejects.toThrow('copy reached')
        expect(logs.join('\n')).toContain('no backup to restore')
        expect(fs.existsSync(path.join(root, '.update-tmp/staged'))).toBe(false)
    })

    // Shape G: a journal whose backup/ is gone. Both recovery tools treat it
    // as nothing to restore (rollbackInterruptedUpdate returns without
    // touching it, recoverInterruptedInstallation returns and the updater
    // removes it), so refusing it with advice to run --rollback would loop:
    // the command would leave the directory, and the next update refuse again.
    test('treats a journal without a backup as debris because no recovery tool can act on it', async () => {
        const root = temporaryRoot()
        write(root, '.update-tmp/staged/package.json', 'new package')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'installing', names: ['package.json'], backedUp: ['package.json'], installed: [] }))
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'debris', reason: 'no backup to restore' })
        const rollbackLog: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => rollbackLog.push(line) })).toBe(false)
        expect(rollbackLog).toEqual(['No interrupted update backup was found; existing installation was not changed.'])
        expect(fs.existsSync(path.join(root, '.update-tmp/install-state.json'))).toBe(true)
        const logs: string[] = []
        vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('copy reached'))
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, (line: string) => logs.push(line))).rejects.toThrow('copy reached')
        expect(logs.join('\n')).toMatch(/Removing \.update-tmp .*no backup to restore; entries: install-state\.json, staged/)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test('refuses an interrupted install with recovery guidance and leaves it byte-for-byte', async () => {
        const root = temporaryRoot()
        write(root, '.update-tmp/backup/package.json', 'previous package')
        write(root, '.update-tmp/backup/dist/index.html', 'previous html')
        write(root, '.update-tmp/staged/package.json', 'new package')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'installing', names: ['package.json', 'dist'], backedUp: ['package.json', 'dist'], installed: ['package.json'] }))
        const before = snapshot(path.join(root, '.update-tmp'))
        const cp = vi.spyOn(fs.promises, 'cp')
        const mkdir = vi.spyOn(fs.promises, 'mkdir')
        const rm = vi.spyOn(fs, 'rmSync')
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, () => {})).rejects.toThrow(
            /A previous update did not finish.*\.update-tmp[\\/]backup holds the files from before that update.*\n(bin[\\/]node(\.exe)? scripts[\\/]updater\.cjs --rollback)\n.*Do not delete \.update-tmp by hand/s,
        )
        expect(cp).not.toHaveBeenCalled()
        expect(mkdir).not.toHaveBeenCalled()
        expect(rm).not.toHaveBeenCalled()
        expect(snapshot(path.join(root, '.update-tmp'))).toEqual(before)
        expect(interruptedUpdateMessage(root)).toContain(path.join(root, '.update-tmp', 'backup'))
    })

    test('retries the post-install cleanup when the first removal fails', async () => {
        const root = installationFixture()
        const tmp = path.join(root, '.update-tmp')
        const rm = fs.rmSync
        let failures = 0
        vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
            if (String(target) === tmp && failures++ === 0) throw new Error('EPERM: operation not permitted, rmdir')
            return rm(target, options)
        })
        const logs: string[] = []
        expect(await installStaged(root, { verify: readVersion, start: async () => ({ pid: 123 }), log: (line: string) => logs.push(line) })).toEqual({ pid: 123 })
        expect(failures).toBe(2)
        expect(logs.join('\n')).toContain('Cleanup attempt 1 of 5 failed (EPERM: operation not permitted, rmdir); retrying')
        expect(logs.join('\n')).not.toContain('cleanup deferred')
        expect(fs.existsSync(tmp)).toBe(false)
        expect(readVersion(root)).toBe('0.9.35')
    })

    test('gives up the cleanup after the last attempt and reports it', async () => {
        const root = temporaryRoot()
        const logs: string[] = []
        vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY: locked') })
        await expect(removeTree(path.join(root, 'locked'), (line: string) => logs.push(line), 3, 1)).rejects.toThrow('EBUSY: locked')
        expect(logs).toEqual([
            'Cleanup attempt 1 of 3 failed (EBUSY: locked); retrying',
            'Cleanup attempt 2 of 3 failed (EBUSY: locked); retrying',
        ])
    })
})

// What scripts/updater.cjs (run by update.bat) and the in-app Windows path
// before 0.9.35 leave behind: no journal, the download, the staged bin/ and
// the latest-version marker that update.bat's finishing step copies over the
// root .installed-version before its silenced `rmdir /s /q`.
function oldFlowLeftover(installedVersion: string, markerVersion: string | null) {
    const root = temporaryRoot()
    packageFixture(root, '0.9.36')
    write(root, 'bin/node.exe', 'bundled node')
    if (installedVersion) write(root, '.installed-version', installedVersion)
    write(root, '.update-tmp/backup/package.json', JSON.stringify({ version: '0.9.35' }))
    write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
    write(root, '.update-tmp/backup/server/node/server.cjs', 'previous server')
    write(root, '.update-tmp/new-bin/node.exe', 'newer node')
    write(root, '.update-tmp/extracted/package.json', '{}')
    write(root, '.update-tmp/RisuVault-v0.9.36-win-x64.zip', 'archive')
    if (markerVersion !== null) write(root, '.update-tmp/latest-version', markerVersion)
    return root
}

// What that rmdir leaves when an antivirus or indexer handle is held on one
// backed-up file: reproduced on Windows 10 with a FileShare.None handle on
// backup/dist/index.html, the rmdir exits 0 and deletes everything else,
// latest-version included.
function rmdirRemnant(installedVersion: string) {
    const root = temporaryRoot()
    packageFixture(root, '0.9.36')
    write(root, '.installed-version', installedVersion)
    write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
    return root
}

// What installStaged leaves when killed between the dist/ swap and the
// package.json swap (see the helper tests below): the root mixes the new
// dist/ with the old package.json, server/ and node_modules/, the stamp is
// the old one, backup/ holds only the old dist/ and the journal records the
// phase the helper was in.
function helperKilledMidSwap(phase: string) {
    const root = temporaryRoot()
    write(root, 'package.json', JSON.stringify({ version: '0.3.30', dependencies: { express: '*' } }))
    write(root, 'dist/index.html', 'NEW 0.3.31')
    write(root, 'server/node/server.cjs', 'OLD server')
    write(root, 'node_modules/express/package.json', JSON.stringify({ name: 'express', main: 'index.js' }))
    write(root, 'node_modules/express/index.js', 'module.exports = function express() {}')
    write(root, 'bin/node.exe', 'bundled node')
    write(root, '.installed-version', 'v0.3.30')
    write(root, '.update-tmp/backup/dist/index.html', 'OLD 0.3.30')
    write(root, '.update-tmp/staged/package.json', JSON.stringify({ version: '0.3.31', dependencies: { express: '*' } }))
    write(root, '.update-tmp/staged/server/node/server.cjs', 'NEW server')
    write(root, '.update-tmp/staged/node_modules/express/package.json', '{}')
    write(root, '.update-tmp/install-state.json', JSON.stringify({
        version: '0.3.31', phase, names: ['dist', 'node_modules', 'package.json', 'server'], backedUp: ['dist'], installed: ['dist'],
    }))
    return root
}

async function expectStagingToProceed(root: string) {
    const logs: string[] = []
    vi.spyOn(fs.promises, 'cp').mockRejectedValueOnce(new Error('copy reached'))
    await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, (line: string) => logs.push(line))).rejects.toThrow('copy reached')
    expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    return logs.join('\n')
}

describe('leftovers of the update flows that write no journal', () => {
    test('shape D: latest-version equal to .installed-version means update.bat finished, so the leftover is debris', async () => {
        const root = oldFlowLeftover('v0.9.36', 'v0.9.36')
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'debris', reason: 'latest-version v0.9.36 matches .installed-version, so the finishing step ran' })
        expect(completedUpdateLeftover(root)).toBe('latest-version v0.9.36 matches .installed-version')
        const log = await expectStagingToProceed(root)
        expect(log).toMatch(/Removing \.update-tmp .*latest-version v0\.9\.36 matches \.installed-version, so the finishing step ran; entries: /)
        for (const entry of ['RisuVault-v0.9.36-win-x64.zip', 'backup', 'extracted', 'latest-version', 'new-bin']) expect(log).toContain(entry)
        expect(readVersion(root)).toBe('0.9.36')
    })

    test('compares the two markers after trailing whitespace only', () => {
        const root = oldFlowLeftover('v0.9.36\r\n', 'v0.9.36')
        expect(classifyUpdateTmp(root)).toBe('debris')
        expect(completedUpdateLeftover(root)).not.toBeNull()
        write(root, '.installed-version', ' v0.9.36')
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        expect(completedUpdateLeftover(root)).toBeNull()
        write(root, '.installed-version', 'V0.9.36')
        expect(classifyUpdateTmp(root)).toBe('interrupted')
        expect(completedUpdateLeftover(root)).toBeNull()
    })

    test("shape D': a marker that was never finalised is an interrupted update and is refused untouched", async () => {
        const root = oldFlowLeftover('v0.9.35', 'v0.9.36')
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'interrupted', reason: 'latest-version v0.9.36 was never finalised into .installed-version (v0.9.35)' })
        expect(completedUpdateLeftover(root)).toBeNull()
        const before = snapshot(root)
        await expect(stageWindowsUpdate(root, path.join(root, 'source'), process.pid, () => {})).rejects.toThrow(
            /A previous update did not finish \(latest-version v0\.9\.36 was never finalised into \.installed-version \(v0\.9\.35\)\), so this one was not started\. The folder .*\.update-tmp[\\/]backup holds the files/,
        )
        expect(snapshot(root)).toEqual(before)
        // A missing stamp cannot vouch for the marker either.
        fs.rmSync(path.join(root, '.installed-version'))
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'interrupted', reason: 'latest-version v0.9.36 was never finalised into .installed-version (absent)' })
        expect(completedUpdateLeftover(root)).toBeNull()
    })

    test('rmdir remnant: a stamped installation holding every backed-up entry is debris', async () => {
        const root = rmdirRemnant('v0.9.36')
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'debris', reason: '.installed-version v0.9.36 matches the installed package.json and every backed-up entry exists at the root' })
        expect(completedUpdateLeftover(root)).toBe('.installed-version v0.9.36 matches the installed package.json and every backed-up entry exists at the root')
        expect(await expectStagingToProceed(root)).toContain('matches the installed package.json')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
    })

    test('rmdir remnant rules do not fire for a swap that stopped part-way', () => {
        // Phase 2 finished (root holds the new files) but the stamp is old.
        const stale = rmdirRemnant('v0.9.35')
        expect(inspectUpdateTmp(stale)).toEqual({ kind: 'interrupted', reason: '.installed-version (v0.9.35) does not stamp the installed package.json (0.9.36)' })
        expect(completedUpdateLeftover(stale)).toBeNull()
        // Phase 1 stopped after dist/ left the root; the stamp still matches
        // the old package.json that never moved.
        const partial = rmdirRemnant('v0.9.36')
        fs.rmSync(path.join(partial, 'dist'), { recursive: true })
        write(partial, '.update-tmp/backup/node_modules/express/package.json', '{}')
        fs.rmSync(path.join(partial, 'node_modules'), { recursive: true })
        expect(inspectUpdateTmp(partial)).toEqual({ kind: 'interrupted', reason: 'backup holds entries missing from the installation: dist, node_modules' })
        expect(completedUpdateLeftover(partial)).toBeNull()
        expect(interruptedUpdateMessage(partial)).toContain('(backup holds entries missing from the installation: dist, node_modules)')
        // No stamp at all: a fresh portable never had one, and nothing vouches
        // for the root.
        const unstamped = rmdirRemnant('v0.9.36')
        fs.rmSync(path.join(unstamped, '.installed-version'))
        expect(classifyUpdateTmp(unstamped)).toBe('interrupted')
        expect(completedUpdateLeftover(unstamped)).toBeNull()
    })
})

describe('scripts/updater-recovery.cjs rollbackInterruptedUpdate', () => {
    test('clears a completed update\'s leftover (shape D) instead of restoring the release before it', () => {
        const root = oldFlowLeftover('v0.9.36', 'v0.9.36')
        const serverBefore = fs.readFileSync(path.join(root, 'server/node/server.cjs'))
        const rootBefore = snapshot(root)
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(false)
        expect(logs).toEqual(['Cleared the leftover of a completed update (latest-version v0.9.36 matches .installed-version); existing installation was not changed.'])
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        expect(fs.readFileSync(path.join(root, 'server/node/server.cjs')).equals(serverBefore)).toBe(true)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
        const rootAfter = snapshot(root)
        for (const [file, bytes] of Object.entries(rootBefore)) {
            if (!file.startsWith('.update-tmp')) expect(rootAfter[file]).toBe(bytes)
        }
    })

    test('clears the rmdir remnant instead of replacing dist/ with one stale file', () => {
        const root = rmdirRemnant('v0.9.36')
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(false)
        expect(logs[0]).toMatch(/^Cleared the leftover of a completed update \(\.installed-version v0\.9\.36 matches the installed package\.json/)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
    })

    test("still restores an interrupted update (shape D')", () => {
        const root = oldFlowLeftover('v0.9.35', 'v0.9.36')
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(true)
        expect(logs[0]).toBe('Restoring the previous installation after update failure...')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.35')
        expect(fs.readFileSync(path.join(root, 'server/node/server.cjs'), 'utf8')).toBe('previous server')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    // installStaged swaps one entry at a time in readdirSync order (bin, dist,
    // node_modules, package.json, server). Killed after dist/ and before
    // package.json, it leaves the new dist/ next to the old package.json, the
    // stamp still equal to that old package.json, every backed-up entry
    // present at the root and the journal at 'installing'. Without the
    // journal check, the stamp rule read this as a completed update and
    // --rollback deleted backup/dist, the only copy of the old dist/.
    for (const phase of ['installing', 'recovering']) {
        test(`restores a helper killed mid-swap (journal '${phase}') instead of deleting its backup`, () => {
            const root = helperKilledMidSwap(phase)
            expect(inspectUpdateTmp(root)).toEqual({ kind: 'interrupted', reason: `journal phase '${phase}'` })
            expect(completedUpdateLeftover(root)).toBeNull()
            const logs: string[] = []
            expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(true)
            expect(logs.join('\n')).not.toMatch(/completed/i)
            expect(logs[0]).toBe('Restoring the previous installation after update failure...')
            expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('OLD 0.3.30')
            expect(readVersion(root)).toBe('0.3.30')
            expect(fs.readFileSync(path.join(root, 'server/node/server.cjs'), 'utf8')).toBe('OLD server')
            expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
            expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        })
    }

    test('leaves a helper journal that cannot be read to the restore', () => {
        const root = helperKilledMidSwap('installing')
        write(root, '.update-tmp/install-state.json', 'not json')
        expect(inspectUpdateTmp(root)).toEqual({ kind: 'interrupted', reason: 'journal unreadable' })
        expect(completedUpdateLeftover(root)).toBeNull()
        expect(rollbackInterruptedUpdate(root)).toBe(true)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('OLD 0.3.30')
    })

    // A 'complete' journal records that the helper finished. It does not
    // record that the root is still whole: if dist/ has since gone missing,
    // backup/dist is the only copy left, and clearing the leftover on the
    // strength of the journal alone destroyed it. The existence check the
    // no-journal rule already makes has to apply here too.
    test("restores a 'complete' journal's backup when the root has lost a backed-up entry", () => {
        const root = helperKilledMidSwap('complete')
        fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true })
        expect(inspectUpdateTmp(root)).toEqual({
            kind: 'interrupted',
            reason: "journal phase 'complete' but the root is missing dist",
        })
        expect(completedUpdateLeftover(root)).toBeNull()
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(true)
        expect(logs.join('\n')).not.toMatch(/completed/i)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('OLD 0.3.30')
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
    })

    test("clears a 'complete' journal's leftover without restoring the release before it", () => {
        const root = temporaryRoot()
        packageFixture(root, '0.9.35')
        write(root, '.installed-version', 'v0.9.35')
        write(root, '.update-tmp/backup/dist/index.html', '0.9.34')
        write(root, '.update-tmp/backup/package.json', JSON.stringify({ version: '0.9.34' }))
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'complete' }))
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(false)
        expect(logs).toEqual(["Cleared the leftover of a completed update (journal phase 'complete'); existing installation was not changed."])
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.35')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    // restoreEntries renames every entry out of backup/ before the phase is
    // written as 'rolled-back', so the empty directory is debris. The outcome
    // (clear it, touch nothing) was already right; the log called it the
    // leftover of a completed update, which is what a user reading update.log
    // after a failed update would least expect.
    test("clears an empty backup with a 'rolled-back' journal and says nothing about a completed update", () => {
        const root = temporaryRoot()
        packageFixture(root, '0.9.34')
        write(root, '.installed-version', 'v0.9.34')
        fs.mkdirSync(path.join(root, '.update-tmp/backup'), { recursive: true })
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'rolled-back', names: ['dist'], backedUp: ['dist'], installed: ['dist'] }))
        const before = snapshot(root)
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(false)
        expect(logs).toEqual(["Cleared an empty update backup (journal phase 'rolled-back' and backup is empty: nothing left to restore); existing installation was not changed."])
        expect(logs.join('\n')).not.toMatch(/completed/i)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        const after = snapshot(root)
        const outside = (files: Record<string, string>) => Object.keys(files).filter(file => !file.startsWith('.update-tmp')).sort()
        expect(outside(after)).toEqual(outside(before))
        for (const file of outside(before)) expect(after[file]).toBe(before[file])
    })

    test("still restores a 'rolled-back' journal whose backup kept an entry", () => {
        const root = temporaryRoot()
        packageFixture(root, '0.9.34')
        write(root, '.installed-version', 'v0.9.34')
        write(root, '.update-tmp/backup/dist/index.html', 'kept by a locked handle')
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.9.35', phase: 'rolled-back' }))
        expect(completedUpdateLeftover(root)).toBeNull()
        expect(rollbackInterruptedUpdate(root)).toBe(true)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('kept by a locked handle')
    })

    // scripts/updater.cjs restores itself after a phase 1 or 2 failure and
    // leaves the empty backup/ behind; update.bat's :fail label then runs
    // --rollback on it.
    test('clears the empty backup a self-restored updater.cjs run leaves and says nothing about a completed update', () => {
        const root = temporaryRoot()
        packageFixture(root, '0.9.34')
        write(root, '.installed-version', 'v0.9.34')
        fs.mkdirSync(path.join(root, '.update-tmp/backup'), { recursive: true })
        write(root, '.update-tmp/extracted/package.json', '{}')
        const logs: string[] = []
        expect(rollbackInterruptedUpdate(root, { log: (line: string) => logs.push(line) })).toBe(false)
        expect(logs).toEqual(['Cleared an empty update backup (.installed-version v0.9.34 matches the installed package.json and backup is empty: nothing left to restore); existing installation was not changed.'])
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        expect(readVersion(root)).toBe('0.9.34')
    })
})

describe('server exit gate', () => {
    test('times out while the parent process is still alive', async () => {
        await expect(waitForExit(process.pid, 1)).rejects.toThrow('Server did not exit; installation was not changed')
    })

    test('rejects invalid process IDs', async () => {
        await expect(waitForExit(0)).rejects.toThrow('Invalid server process ID')
    })
})
