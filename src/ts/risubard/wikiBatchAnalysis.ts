import {
    projectRecentMemoryMessages,
    type MemoryAnalysisMessage,
} from './memoryAnalysisClient'

interface StoredBatchMessage {
    role?: unknown
    data?: unknown
    chatId?: unknown
    isComment?: unknown
    disabled?: unknown
    risubardMemoryConfirmed?: unknown
}

export interface PendingWikiBatchProjection {
    assistantMessageIds: string[]
    eventTurns: Array<{
        assistantMessageId: string
        sourceMessageIds: string[]
    }>
    messages: MemoryAnalysisMessage[]
    sourceMessageIds: string[]
    eventSourceGroups: string[][]
}

function active(message: StoredBatchMessage): boolean {
    return !message.isComment && !message.disabled
        && typeof message.data === 'string'
        && typeof message.chatId === 'string'
        && message.chatId.trim().length > 0
}

function projectMessage(message: StoredBatchMessage): MemoryAnalysisMessage {
    return {
        messageId: message.chatId as string,
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.data as string,
    }
}

export function projectPendingWikiBatch(
    storedMessages: readonly StoredBatchMessage[],
    contextTurnLimit: number,
    includeUserMessages: boolean,
    firstMessage?: MemoryAnalysisMessage,
): PendingWikiBatchProjection | null {
    const pending = storedMessages.flatMap((message, index) =>
        active(message)
        && message.role === 'char'
        && message.risubardMemoryConfirmed !== true
            ? [{ message, index }]
            : []
    )
    if (pending.length === 0) return null

    const firstIndex = pending[0].index
    const lastIndex = pending.at(-1)?.index ?? firstIndex
    const targetUserByAssistant = new Map<number, StoredBatchMessage>()
    let latestUser: StoredBatchMessage | undefined
    for (let index = 0; index <= lastIndex; index += 1) {
        const message = storedMessages[index]
        if (!active(message)) continue
        if (message.role === 'user') latestUser = message
        if (message.role === 'char' && latestUser) {
            targetUserByAssistant.set(index, latestUser)
        }
    }

    let spanStart = firstIndex
    if (includeUserMessages) {
        const firstUser = targetUserByAssistant.get(firstIndex)
        const firstUserIndex = firstUser
            ? storedMessages.indexOf(firstUser)
            : -1
        if (firstUserIndex >= 0) spanStart = firstUserIndex
    }
    const context = projectRecentMemoryMessages(
        storedMessages.slice(0, spanStart),
        contextTurnLimit,
        undefined,
        firstMessage,
        includeUserMessages,
    )
    const span = storedMessages.slice(spanStart, lastIndex + 1)
        .filter((message) => active(message)
            && (message.role === 'char'
                || (includeUserMessages && message.role === 'user')))
        .map(projectMessage)
    const seenMessages = new Set<string>()
    const messages = [...context, ...span].filter((message) => {
        if (seenMessages.has(message.messageId)) return false
        seenMessages.add(message.messageId)
        return true
    })

    const usedSources = new Set<string>()
    const eventTurns = pending.map(({ message, index }) => {
        const candidates = [
            ...(includeUserMessages ? [targetUserByAssistant.get(index)] : []),
            message,
        ].filter((item): item is StoredBatchMessage => Boolean(item))
        const sourceMessageIds = candidates.flatMap((item) => {
            const id = item.chatId as string
            if (usedSources.has(id)) return []
            usedSources.add(id)
            return [id]
        })
        return {
            assistantMessageId: message.chatId as string,
            sourceMessageIds,
        }
    })
    const sourceMessageIds = eventTurns.flatMap((turn) =>
        turn.sourceMessageIds
    )
    return {
        assistantMessageIds: pending.map(({ message }) =>
            message.chatId as string
        ),
        eventTurns,
        messages,
        sourceMessageIds,
        eventSourceGroups: eventTurns.map((turn) => turn.sourceMessageIds),
    }
}
