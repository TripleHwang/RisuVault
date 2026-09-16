import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

let writeCanonicalProjection: any
try {
    ({ writeCanonicalProjection } = require('./canonical-projection-writer.cjs'))
} catch {
    writeCanonicalProjection = undefined
}

describe('W1 canonical projection writer', () => {
    it('uses the direct collection lane for bot presets', () => {
        expect(writeCanonicalProjection).toBeTypeOf('function')
        if (!writeCanonicalProjection) return

        const direct = vi.fn(() => ({ files: 2 }))
        const full = vi.fn()
        const result = writeCanonicalProjection({
            repository: { syncLegacyCollection: direct, importLegacyDatabase: full },
            database: { botPresets: [{ id: 'preset-1' }] },
            directCollection: 'botPresets',
        })

        expect(direct).toHaveBeenCalledWith('botPresets', [{ id: 'preset-1' }])
        expect(full).not.toHaveBeenCalled()
        expect(result).toMatchObject({ strategy: 'bot-presets-direct', fallbackUsed: false, result: { files: 2 } })
    })

    it('falls back to the existing full projection when the direct lane fails', () => {
        expect(writeCanonicalProjection).toBeTypeOf('function')
        if (!writeCanonicalProjection) return

        const directError: any = new Error('direct failed')
        directError.code = 'EIO'
        const fullResult = { files: 9 }
        const result = writeCanonicalProjection({
            repository: {
                syncLegacyCollection: () => { throw directError },
                importLegacyDatabase: vi.fn(() => fullResult),
            },
            database: { botPresets: [] },
            directCollection: 'botPresets',
        })

        expect(result).toEqual({
            strategy: 'bot-presets-direct',
            fallbackUsed: true,
            fallbackCode: 'EIO',
            result: fullResult,
        })
    })

    it('is wired into the patch debounce boundary without changing mixed patches', () => {
        const server = fs.readFileSync(path.join(process.cwd(), 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).toContain("require('./direct-write-tracker.cjs')")
        expect(server).toContain("require('./canonical-projection-writer.cjs')")
        expect(server).toContain('directWriteTracker.observe(filePath, patch)')
        expect(server).toContain('directCollection: directWriteTracker.take(filePath)')
    })
})
