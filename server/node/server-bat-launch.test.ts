import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const serverBat = fileURLToPath(new URL('../../server.bat', import.meta.url))
const serverEntry = fileURLToPath(new URL('./server.cjs', import.meta.url))
const browserHelper = fileURLToPath(
    new URL('./open-server-browser.cjs', import.meta.url)
)

describe('Windows server.bat launcher', () => {
    test('uses port 6001 and requests browser opening after server readiness', () => {
        const batch = readFileSync(serverBat, 'utf8')
        expect(batch).toContain('if not defined PORT set "PORT=6001"')
        expect(batch).toContain('set "OPEN_BROWSER=1"')
        expect(batch).toContain('call pnpm run runserver')

        const entry = readFileSync(serverEntry, 'utf8')
        expect(entry).toContain("require('./open-server-browser.cjs')")
        expect(entry).toContain("process.env.OPEN_BROWSER === '1'")
        expect(entry).toContain('openServerBrowser(url)')
    })

    test('reuses installed pnpm and a fresh frontend build on later starts', () => {
        const batch = readFileSync(serverBat, 'utf8')
        expect(batch).toContain('where pnpm >nul 2>&1')
        expect(batch).toContain('node server\\node\\server-build-cache.cjs')
        expect(batch).toContain('if errorlevel 1 call pnpm run build')
    })

    test('opens the ready URL with the Windows default browser', () => {
        if (!existsSync(browserHelper)) {
            expect(existsSync(browserHelper)).toBe(true)
            return
        }
        const { openServerBrowser } = require('./open-server-browser.cjs')
        const unref = vi.fn()
        const spawn = vi.fn(() => ({ unref }))

        openServerBrowser('http://localhost:6001/', {
            platform: 'win32',
            spawn,
        })

        expect(spawn).toHaveBeenCalledWith(
            'cmd.exe',
            [
                '/d',
                '/c',
                'start',
                '',
                'http://localhost:6001/',
            ],
            {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            }
        )
        expect(unref).toHaveBeenCalledOnce()
    })

    test('keeps the server alive when the browser launcher is unavailable', () => {
        const { openServerBrowser } = require('./open-server-browser.cjs')
        expect(() => openServerBrowser('http://localhost:6001/', {
            platform: 'win32',
            spawn: () => {
                throw new Error('launcher unavailable')
            },
        })).not.toThrow()
    })
})
