import { describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: -1 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: vi.fn(),
    saveAsset: vi.fn(async () => ''),
}))
vi.mock('../alert', () => ({ notifySuccess: vi.fn(), alertError: vi.fn() }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: vi.fn() }))

const { getDatabase, setDatabase } = await import('./database.svelte')

describe('RisuBard settings persistence', () => {
    test.each([
        { recent: 250, response: 300, expectedRecent: 250, expectedResponse: 300 },
        { recent: 0, response: Infinity, expectedRecent: 12, expectedResponse: 12 },
    ])('normalizes persisted message counts without a fixed ceiling: $recent', ({
        recent, response, expectedRecent, expectedResponse,
    }) => {
        setDatabase({
            characters: [], formatingOrder: ['main'], loreBook: [],
            personas: [], username: 'User', userIcon: '', userNote: '',
            risuBardRecentMessageCount: recent,
            risuBardResponseMessageCount: response,
            risuBardAnalysisTokenLimit: 99_999,
            risuBardAdditionalSearchLimit: 99,
            risuBardCanonicalTargetLimit: 99,
            risuBardCanonicalConcurrencyLimit: 2,
            risuBardInquiryTargetTokenBudget: 50_000,
            risuBardInquiryMaximumTokenBudget: 99_999,
        } as any)
        const saved = JSON.parse(JSON.stringify(getDatabase()))
        setDatabase(saved)
        expect(getDatabase()).toMatchObject({
            risuBardRecentMessageCount: expectedRecent,
            risuBardResponseMessageCount: expectedResponse,
            risuBardAnalysisTokenLimit: 99_999,
            risuBardAdditionalSearchLimit: 99,
            risuBardCanonicalTargetLimit: 99,
            risuBardCanonicalConcurrencyLimit: 2,
            risuBardInquiryTargetTokenBudget: 50_000,
            risuBardInquiryMaximumTokenBudget: 99_999,
        })
    })
})
