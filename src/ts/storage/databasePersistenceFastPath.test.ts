import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('database persistence fast path', () => {
    test('checks the patch before full encoding and skips empty patches', () => {
        const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
        const persistStart = source.indexOf('async function persistTrackedChanges(')
        const persistEnd = source.indexOf('\n    async function triggerSave(', persistStart)
        const persist = source.slice(persistStart, persistEnd)
        const patchIndex = persist.indexOf('await patcher.set(')
        const encodeIndex = persist.indexOf('await encoder.set(')

        expect(patchIndex).toBeGreaterThan(-1)
        expect(encodeIndex).toBeGreaterThan(-1)
        expect(patchIndex).toBeLessThan(encodeIndex)
        expect(persist).toMatch(/if \(patchData\.patch\.length === 0\) \{\s*updateKnownChatsAfterSuccessfulSave\(db, toSave\)\s*return 'saved'\s*\}/)
    })
})
