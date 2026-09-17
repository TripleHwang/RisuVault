export type ChatContentPageEnvelope<
    TMessage = unknown,
    TChat extends object = Record<string, unknown>,
> = {
    chat?: TChat
    messages: TMessage[]
    offset: number
    limit: number
    total: number
}

function requireNonNegativeInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Chat content page has invalid ${name}`)
    }
    return value as number
}

/**
 * Validates a chat's pages as they arrive, in order, without holding them.
 *
 * The collecting caller (`assembleChatContentPages`) sorts its pages and feeds
 * them through; the streaming caller (the SQL migration) feeds each page the
 * moment it lands and forgets it. Both get the same guarantees, because there
 * is one validator: contiguous offsets, a total that never changes underneath
 * the transfer, and a run that is only complete when it reaches that total.
 *
 * Nothing here tolerates a gap. A short history assembled from pages that
 * skipped one is exactly the failure this whole area exists to prevent.
 */
export function createChatContentAssembler<TMessage, TChat extends object>() {
    let chat: TChat | undefined
    let total: number | undefined
    let received = 0

    return {
        /** Validates one page against the run so far and returns its messages. */
        accept(page: ChatContentPageEnvelope<TMessage, TChat>): TMessage[] {
            const pageTotal = requireNonNegativeInteger(page.total, 'total')
            const offset = requireNonNegativeInteger(page.offset, 'offset')
            if (total === undefined) {
                if (offset !== 0 || !page.chat || typeof page.chat !== 'object') {
                    throw new Error('Chat content page metadata is missing')
                }
                chat = page.chat
                total = pageTotal
            } else if (pageTotal !== total) {
                throw new Error('Chat content page total changed during hydration')
            }
            if (offset !== received) throw new Error('Chat content pages must be contiguous')
            if (!Array.isArray(page.messages)) throw new Error('Chat content page messages are invalid')
            received += page.messages.length
            if (received > total) throw new Error('Chat content page exceeds total')
            return page.messages
        },
        /** True once every message the first page promised has been accepted. */
        get complete(): boolean {
            return total !== undefined && received === total
        },
        /** What the server said the history is, or undefined before page one. */
        get total(): number | undefined {
            return total
        },
        get received(): number {
            return received
        },
        /** The chat's own fields, taken from the first page. */
        finishChat(): TChat {
            if (total === undefined || chat === undefined) {
                throw new Error('Chat content page metadata is missing')
            }
            if (received !== total) {
                throw new Error('Chat content pages must be contiguous through total')
            }
            return chat
        },
    }
}

export function getRemainingChatContentPageOffsets(
    totalValue: number,
    loadedValue: number,
    pageSizeValue: number,
): number[] {
    const total = requireNonNegativeInteger(totalValue, 'total')
    const loaded = requireNonNegativeInteger(loadedValue, 'loaded count')
    const pageSize = requireNonNegativeInteger(pageSizeValue, 'page size')
    if (pageSize === 0) throw new Error('Chat content page has invalid page size')
    if (loaded > total) throw new Error('Chat content page exceeds total')

    const offsets: number[] = []
    for (let offset = loaded; offset < total; offset += pageSize) offsets.push(offset)
    return offsets
}

export function assembleChatContentPages<TMessage, TChat extends object>(
    inputPages: ChatContentPageEnvelope<TMessage, TChat>[],
): TChat & { message: TMessage[] } {
    if (inputPages.length === 0) throw new Error('Chat content page metadata is missing')
    const pages = [...inputPages].sort((left, right) => left.offset - right.offset)
    const assembler = createChatContentAssembler<TMessage, TChat>()
    const messages: TMessage[] = []
    for (const page of pages) messages.push(...assembler.accept(page))
    return { ...assembler.finishChat(), message: messages }
}
