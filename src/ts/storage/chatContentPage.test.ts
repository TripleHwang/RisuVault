import { describe, expect, it } from 'vitest'
import { assembleChatContentPages, getRemainingChatContentPageOffsets, type ChatContentPageEnvelope } from './chatContentPage'

const page = (
    offset: number,
    messages: Array<{ data: string }>,
    total = 4,
): ChatContentPageEnvelope => ({
    chat: offset === 0 ? { id: 'chat-1', name: 'Chat' } : undefined,
    messages,
    offset,
    limit: 2,
    total,
})

describe('assembleChatContentPages', () => {
    it('orders contiguous pages and restores the full compatibility chat', () => {
        expect(assembleChatContentPages([
            page(2, [{ data: 'c' }, { data: 'd' }]),
            page(0, [{ data: 'a' }, { data: 'b' }]),
        ])).toEqual({
            id: 'chat-1',
            name: 'Chat',
            message: [{ data: 'a' }, { data: 'b' }, { data: 'c' }, { data: 'd' }],
        })
    })

    it('rejects gaps, inconsistent totals, and missing metadata', () => {
        expect(() => assembleChatContentPages([page(2, [{ data: 'c' }, { data: 'd' }])])).toThrow(/metadata/i)
        expect(() => assembleChatContentPages([
            page(0, [{ data: 'a' }, { data: 'b' }]),
            page(3, [{ data: 'd' }]),
        ])).toThrow(/contiguous/i)
        expect(() => assembleChatContentPages([
            page(0, [{ data: 'a' }, { data: 'b' }]),
            page(2, [{ data: 'c' }, { data: 'd' }], 5),
        ])).toThrow(/total/i)
    })
})

describe('getRemainingChatContentPageOffsets', () => {
    it('returns deterministic offsets after the first page', () => {
        expect(getRemainingChatContentPageOffsets(750, 200, 200)).toEqual([200, 400, 600])
        expect(getRemainingChatContentPageOffsets(200, 200, 200)).toEqual([])
        expect(getRemainingChatContentPageOffsets(0, 0, 200)).toEqual([])
    })

    it('rejects an invalid page size', () => {
        expect(() => getRemainingChatContentPageOffsets(1, 0, 0)).toThrow(/page size/i)
    })
})
