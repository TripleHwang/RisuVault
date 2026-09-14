import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { stageWindowsUpdate, waitForExit } = require('./portable-update.cjs')

function write(root: string, name: string, content: string) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

async function until(predicate: () => boolean, milliseconds = 15000) {
    const deadline = Date.now() + milliseconds
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Fixture did not reach expected update state')
        await new Promise(resolve => setTimeout(resolve, 50))
    }
}

test.skipIf(process.platform !== 'win32')('detached Windows helper waits for shutdown, installs and starts the replacement server', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-update-e2e-'))
    const root = path.join(fixture, 'installation')
    const source = path.join(fixture, 'release')
    let parent: ChildProcess | undefined
    let helper: ChildProcess | undefined
    let parentClosed: Promise<void> | undefined
    let helperClosed: Promise<void> | undefined
    let serverPid: number | undefined
    let runner: string | undefined
    try {
        write(root, 'package.json', JSON.stringify({ version: '0.9.34' }))
        write(root, '.installed-version', 'v0.9.34')
        write(root, 'RisuBard.exe', 'existing launcher')
        write(root, 'save/characters.json', 'existing characters')
        write(root, 'server/node/ssl/certificate/cert.pem', 'existing certificate')
        write(root, 'server/node/ssl/certificate/key.pem', 'existing private key')
        write(source, 'package.json', JSON.stringify({ version: '0.9.35', dependencies: { express: '*' } }))
        write(source, 'dist/index.html', 'new UI')
        write(source, 'RisuBard.exe', 'replacement launcher must not overwrite running launcher')
        write(source, 'node_modules/express/package.json', JSON.stringify({ name: 'express', main: 'index.js' }))
        write(source, 'node_modules/express/index.js', 'module.exports = function express() {}')
        write(source, 'server/node/server.cjs', `
            const fs = require('node:fs'), path = require('node:path');
            require('express');
            const data = process.env.RISUBARD_DATA_ROOT;
            if (data !== path.join(process.cwd(), 'save')) throw new Error('Unexpected fixture data directory');
            const certificate = fs.readFileSync(path.join(__dirname, 'ssl/certificate/cert.pem'), 'utf8');
            const server = require('node:http').createServer((req, res) => res.end('0.9.35'));
            server.listen(0, '127.0.0.1', () => {
                fs.writeFileSync(path.join(data, 'http-ready.json'), JSON.stringify({ pid: process.pid, port: server.address().port, certificate }));
                console.log('[Server] HTTP server is running.');
            });
        `)
        fs.mkdirSync(path.join(source, 'bin'))
        fs.copyFileSync(process.execPath, path.join(source, 'bin/node.exe'))
        vi.stubEnv('RISUBARD_DATA_ROOT', path.join(root, 'save'))
        parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
        parentClosed = new Promise(resolve => parent!.once('close', () => resolve()))
        expect(parent.pid).toBeTypeOf('number')
        helper = await stageWindowsUpdate(root, source, parent.pid)
        helperClosed = new Promise(resolve => helper!.once('close', () => resolve()))
        runner = path.dirname(helper!.spawnargs[0])
        // The helper is ready, but it must not replace files while the old server lives.
        await new Promise(resolve => setTimeout(resolve, 250))
        expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('0.9.34')
        expect(fs.existsSync(path.join(root, '.update-tmp/backup'))).toBe(false)
        parent.kill()
        await parentClosed
        await waitForExit(parent.pid, 5000)
        const readyFile = path.join(root, 'save/http-ready.json')
        await until(() => fs.existsSync(readyFile))
        const ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'))
        serverPid = ready.pid
        await until(() => fs.readFileSync(path.join(root, '.installed-version'), 'utf8') === 'v0.9.35')
        expect(await (await fetch(`http://127.0.0.1:${ready.port}`)).text()).toBe('0.9.35')
        expect(ready.certificate).toBe('existing certificate')
        expect(fs.readFileSync(path.join(root, 'server/node/ssl/certificate/key.pem'), 'utf8')).toBe('existing private key')
        expect(fs.readFileSync(path.join(root, 'save/characters.json'), 'utf8')).toBe('existing characters')
        expect(fs.readFileSync(path.join(root, 'RisuBard.exe'), 'utf8')).toBe('existing launcher')
        await until(() => !fs.existsSync(path.join(root, '.update-tmp')))
        expect(fs.readFileSync(path.join(root, 'update.log'), 'utf8')).toContain('Update complete: v0.9.35')
    } finally {
        vi.unstubAllEnvs()
        if (!serverPid) {
            const readyFile = path.join(root, 'save/http-ready.json')
            if (fs.existsSync(readyFile)) serverPid = JSON.parse(fs.readFileSync(readyFile, 'utf8')).pid
        }
        for (const pid of [serverPid, parent?.pid, helper?.pid]) {
            if (!pid) continue
            try { process.kill(pid) } catch (error: any) { if (error.code !== 'ESRCH') throw error }
            await waitForExit(pid, 5000)
        }
        await Promise.all([parentClosed, helperClosed])
        for (const [directory, prefix] of [[fixture, 'risubard-update-e2e-'], [runner, 'risubard-updater-']]) {
            if (!directory) continue
            if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(prefix!)) {
                throw new Error('Refusing to remove unexpected fixture path')
            }
            await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        }
    }
}, 30000)
