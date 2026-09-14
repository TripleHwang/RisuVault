import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { validatePackage, waitForExit, restoreEntries, installStaged, stageWindowsUpdate } = require('./portable-update.cjs')
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

describe('server exit gate', () => {
    test('times out while the parent process is still alive', async () => {
        await expect(waitForExit(process.pid, 1)).rejects.toThrow('Server did not exit; installation was not changed')
    })

    test('rejects invalid process IDs', async () => {
        await expect(waitForExit(0)).rejects.toThrow('Invalid server process ID')
    })
})
