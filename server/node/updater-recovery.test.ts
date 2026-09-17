import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

// scripts/updater.cjs resolves its installation root from its own location
// and starts main() on load, so recoverInterruptedInstallation is exercised
// by copying the script into a fixture installation and running it there.
// With RISU_UPDATE_REPOSITORY blank the run stops right after recovery with
// "Self-update is not configured", before any network access.
const repository = fileURLToPath(new URL('../../', import.meta.url))
const temporaryRoots: string[] = []

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-updater-recovery-'))
    temporaryRoots.push(root)
    for (const file of ['scripts/updater.cjs', 'scripts/updater-recovery.cjs', 'server/node/portable-update.cjs', 'server/node/update-manifest.cjs']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.copyFileSync(path.join(repository, file), path.join(root, file))
    }
    return root
}

function write(root: string, name: string, content: string) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

function installation(root: string, version: string) {
    write(root, 'package.json', JSON.stringify({ version, dependencies: { express: '*' } }))
    write(root, 'dist/index.html', version)
    write(root, 'server/node/server.cjs', "require('express')")
    write(root, 'node_modules/express/package.json', JSON.stringify({ name: 'express', main: 'index.js' }))
    write(root, 'node_modules/express/index.js', 'module.exports = function express() {}')
    write(root, 'bin/node.exe', 'bundled node')
}

function runUpdater(root: string, args: string[] = []) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'updater.cjs'), ...args], {
        cwd: root, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, RISU_UPDATE_REPOSITORY: ' ' },
    })
    const log = fs.existsSync(path.join(root, 'update.log')) ? fs.readFileSync(path.join(root, 'update.log'), 'utf8') : ''
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, log }
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('risubard-updater-recovery-')) {
            throw new Error('Refusing to remove unexpected fixture path')
        }
        fs.rmSync(root, { recursive: true, force: true })
    }
})

// What installStaged leaves when killed between the dist/ swap and the
// package.json swap: entries are swapped one at a time in readdirSync order
// (bin, dist, node_modules, package.json, server), so the root mixes the new
// dist/ with the old package.json, server/ and node_modules/, the stamp is
// still the old one, backup/ holds only the old dist/ and the journal records
// the phase the helper was in.
function helperKilledMidSwap(root: string, phase: string) {
    installation(root, '0.3.30')
    write(root, 'dist/index.html', 'NEW 0.3.31')
    write(root, '.installed-version', 'v0.3.30')
    write(root, '.update-tmp/backup/dist/index.html', 'OLD 0.3.30')
    write(root, '.update-tmp/staged/package.json', JSON.stringify({ version: '0.3.31', dependencies: { express: '*' } }))
    write(root, '.update-tmp/install-state.json', JSON.stringify({
        version: '0.3.31', phase, names: ['dist', 'node_modules', 'package.json', 'server'], backedUp: ['dist'], installed: ['dist'],
    }))
}

// `bin\node.exe scripts\updater.cjs --rollback` is the command the in-app
// refusal tells the user to run. It reaches rollbackInterruptedUpdate straight
// from the argv check with no journal check of its own, so the journal has to
// be read inside completedUpdateLeftover. Before it was, this command on the
// shape above deleted backup/dist, the only copy of the old dist/, and
// printed that the installation was not changed.
describe('scripts/updater.cjs --rollback', () => {
    for (const phase of ['installing', 'recovering']) {
        test(`restores a helper killed mid-swap (journal '${phase}') instead of deleting its backup`, () => {
            const root = fixture()
            helperKilledMidSwap(root, phase)
            const result = runUpdater(root, ['--rollback'])
            expect(result.status, result.stdout + result.stderr).toBe(0)
            expect(result.stdout).toContain('Restoring the previous installation after update failure...')
            expect(result.stdout).toContain('Previous installation restored.')
            expect(result.stdout).not.toMatch(/completed/i)
            expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('OLD 0.3.30')
            expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.3.30')
            expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
        })
    }

    test("clears an empty backup with a 'rolled-back' journal without calling the update completed", () => {
        const root = fixture()
        installation(root, '0.3.30')
        write(root, '.installed-version', 'v0.3.30')
        fs.mkdirSync(path.join(root, '.update-tmp/backup'), { recursive: true })
        write(root, '.update-tmp/install-state.json', JSON.stringify({ version: '0.3.31', phase: 'rolled-back' }))
        const result = runUpdater(root, ['--rollback'])
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(result.stdout).toContain("Cleared an empty update backup (journal phase 'rolled-back' and backup is empty: nothing left to restore); existing installation was not changed.")
        expect(result.stdout).not.toMatch(/completed/i)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.3.30')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })
})

describe('scripts/updater.cjs recoverInterruptedInstallation', () => {
    test('clears a completed update\'s leftover (shape D) without restoring the release before it', () => {
        const root = fixture()
        installation(root, '0.9.36')
        write(root, '.installed-version', 'v0.9.36')
        write(root, '.update-tmp/backup/package.json', JSON.stringify({ version: '0.9.35' }))
        write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
        write(root, '.update-tmp/backup/server/node/server.cjs', 'previous server')
        write(root, '.update-tmp/new-bin/node.exe', 'newer node')
        write(root, '.update-tmp/latest-version', 'v0.9.36')
        const serverBefore = fs.readFileSync(path.join(root, 'server/node/server.cjs'))
        const result = runUpdater(root)
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.stdout).toContain('Self-update is not configured')
        expect(result.log).toMatch(/Cleared the leftover of a completed update \(latest-version v0\.9\.36 matches \.installed-version\); existing installation was not changed\./)
        expect(result.log).not.toContain('Recovering interrupted installation')
        expect(fs.readFileSync(path.join(root, 'server/node/server.cjs')).equals(serverBefore)).toBe(true)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test('clears the remnant that update.bat\'s silenced rmdir leaves behind a held handle', () => {
        const root = fixture()
        installation(root, '0.9.36')
        write(root, '.installed-version', 'v0.9.36')
        write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
        const result = runUpdater(root)
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.log).toMatch(/Cleared the leftover of a completed update \(\.installed-version v0\.9\.36 matches the installed package\.json/)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    // A phase 1 or 2 failure in this script restores itself and leaves the
    // empty backup/ behind; the next run must not call that a completed
    // update in update.log.
    test('clears the empty backup a self-restored run left without calling the update completed', () => {
        const root = fixture()
        installation(root, '0.9.36')
        write(root, '.installed-version', 'v0.9.36')
        fs.mkdirSync(path.join(root, '.update-tmp/backup'), { recursive: true })
        write(root, '.update-tmp/extracted/package.json', '{}')
        const result = runUpdater(root)
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.log).toContain('Cleared an empty update backup (.installed-version v0.9.36 matches the installed package.json and backup is empty: nothing left to restore); existing installation was not changed.')
        expect(result.log).not.toMatch(/completed update/)
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.36')
        expect(fs.existsSync(path.join(root, '.update-tmp'))).toBe(false)
    })

    test("still restores an interrupted update (shape D')", () => {
        const root = fixture()
        installation(root, '0.9.36')
        write(root, '.installed-version', 'v0.9.35')
        write(root, '.update-tmp/backup/package.json', JSON.stringify({ version: '0.9.35', dependencies: { express: '*' } }))
        write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
        write(root, '.update-tmp/latest-version', 'v0.9.36')
        const result = runUpdater(root)
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.log).toContain('Recovering interrupted installation before checking its version...')
        expect(result.log).not.toContain('Cleared the leftover')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.35')
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.9.35')
    })

    test('restores the backup when the installation next to a completed leftover no longer validates', () => {
        const root = fixture()
        installation(root, '0.9.36')
        fs.rmSync(path.join(root, 'node_modules/express/index.js'))
        write(root, '.installed-version', 'v0.9.36')
        write(root, '.update-tmp/backup/dist/index.html', '0.9.35')
        write(root, '.update-tmp/latest-version', 'v0.9.36')
        const result = runUpdater(root)
        expect(result.status, result.stdout + result.stderr).toBe(1)
        expect(result.log).toMatch(/failed validation \(.*express.*\); restoring its backup\./s)
        expect(result.log).toContain('Recovering interrupted installation before checking its version...')
        expect(fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8')).toBe('0.9.35')
    })
})
