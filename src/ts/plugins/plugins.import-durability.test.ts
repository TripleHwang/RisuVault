import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('plugin import durability contract', () => {
    it('awaits a server-flushed save for new plugins as well as updates', () => {
        const source = readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
        const start = source.indexOf('export async function importPlugin')
        const end = source.indexOf('export async function loadPlugins', start)
        const importer = source.slice(start, end)

        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
        expect(importer).toContain('await requestImmediateSave({ flushServer: true, rejectOnFailure: true })')
        expect(importer).not.toContain('void requestImmediateSave()')
    })
})
