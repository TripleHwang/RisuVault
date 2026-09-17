import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: { db: { characters: [] } },
}))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    getDatabase: () => ({
        modules: [], enabledModules: [], personas: [], selectedPersona: 0,
        personaEnabledModules: {}, characters: [],
    }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('NodeStorage bulk asset writes', () => {
    it('sends up to 200 small assets per request', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        ;(storage as any).authFetch = authFetch
        const entries = Array.from({ length: 201 }, (_, index) => ({
            key: `assets/${index}`,
            value: Uint8Array.of(index % 256),
        }))

        await storage.setItems(entries)

        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(authFetch.mock.calls[0]?.[1]?.body))).toHaveLength(200)
        expect(JSON.parse(String(authFetch.mock.calls[1]?.[1]?.body))).toHaveLength(1)
    })
})
