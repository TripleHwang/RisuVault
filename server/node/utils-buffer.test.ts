import { describe, expect, it } from 'vitest'

const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    encodeRisuSaveLegacyBuffer,
} = require('./utils.cjs')

describe('legacy save buffer encoding', () => {
    const database = {
        characters: [],
        modules: [{ id: 'module-1', name: 'Module' }],
        personaPrompt: 'hello',
    }

    it.each(['noCompression', 'compression'])('keeps %s bytes and round-trips without a conversion copy', async compression => {
        const legacy = encodeRisuSaveLegacy(database, compression)
        const encoded = encodeRisuSaveLegacyBuffer(database, compression)

        expect(Buffer.isBuffer(legacy)).toBe(false)
        expect(legacy.byteOffset).toBe(0)
        expect(legacy.buffer.byteLength).toBe(legacy.byteLength)
        expect(Buffer.isBuffer(encoded)).toBe(true)
        expect(encoded.equals(Buffer.from(legacy))).toBe(true)
        expect(await decodeRisuSave(encoded)).toEqual(database)
    })
})
