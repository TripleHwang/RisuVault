import {
    parseCanonicalTurnReceipt,
    type CanonicalTurnReceipt,
} from './canonicalTurnReceipt'
import { invokeBrowserFetch } from './browserFetch'
import type { MemoryWikiForkReceipt } from './memoryWikiFork'

interface TransportBase {
    characterId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
    signal?: AbortSignal
}

function bounded(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length < 1
        || value.length > 1_024) throw new Error(`${label} is invalid`)
    return value
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid BardWiki reboot response')
    }
    return value as Record<string, unknown>
}

async function post(
    input: TransportBase,
    url: string,
    body: Record<string, unknown>
): Promise<unknown> {
    const response = await invokeBrowserFetch(input.fetchImpl, url, {
        method: 'POST', credentials: 'same-origin',
        headers: {
            'content-type': 'application/json',
            'risu-auth': await input.createAuth(),
        },
        body: JSON.stringify(body),
        signal: input.signal,
    })
    if (!response.ok) {
        throw new Error(`BardWiki reboot request failed with status ${response.status}`)
    }
    return response.json()
}

export async function prepareWikiRebootReplacement(input: TransportBase & {
    stagingChatId: string
    chatId: string
}): Promise<MemoryWikiForkReceipt> {
    const destinationChatId = bounded(input.chatId, 'Chat ID')
    const value = record(await post(
        input,
        '/api/risubard/memory/reboot/replace',
        {
            characterId: bounded(input.characterId, 'Character ID'),
            sourceChatId: bounded(input.stagingChatId, 'Staging chat ID'),
            destinationChatId,
        }
    ))
    if (value.mode !== 'copy' || value.destinationChatId !== destinationChatId
        || typeof value.sourceExists !== 'boolean'
        || !Array.isArray(value.warnings)
        || !value.warnings.every((item) => typeof item === 'string')
        || typeof value.forkToken !== 'string') {
        throw new Error('Invalid BardWiki reboot replacement receipt')
    }
    return value as unknown as MemoryWikiForkReceipt
}

export async function cleanupWikiRebootWorkspace(input: TransportBase & {
    stagingChatId: string
}): Promise<{ removed: boolean }> {
    const value = record(await post(input, '/api/risubard/memory/reboot/remove', {
        characterId: bounded(input.characterId, 'Character ID'),
        chatId: bounded(input.stagingChatId, 'Staging chat ID'),
    }))
    if (typeof value.removed !== 'boolean') {
        throw new Error('Invalid BardWiki reboot cleanup receipt')
    }
    return { removed: value.removed }
}

interface RebootBatchTransportInput extends TransportBase {
    stagingChatId: string
    sourceMessageIds: string[]
}

function batchBody(input: RebootBatchTransportInput) {
    return {
        characterId: bounded(input.characterId, 'Character ID'),
        chatId: bounded(input.stagingChatId, 'Staging chat ID'),
        sourceMessageIds: input.sourceMessageIds.map((id) =>
            bounded(id, 'Source message ID')
        ),
    }
}

export async function beginWikiRebootBatch(
    input: RebootBatchTransportInput & { eventSourceGroups: string[][] }
): Promise<{ canonicalCount: number }> {
    const value = record(await post(
        input,
        '/api/risubard/memory/wiki/reboot/begin',
        {
            ...batchBody(input),
            eventSourceGroups: input.eventSourceGroups.map((group) =>
                group.map((id) => bounded(id, 'Event source message ID'))
            ),
        }
    ))
    if (!Number.isSafeInteger(value.canonicalCount)
        || (value.canonicalCount as number) < 0) {
        throw new Error('Invalid BardWiki reboot begin receipt')
    }
    return { canonicalCount: value.canonicalCount as number }
}

export async function recordWikiRebootBatchReceipt(
    input: TransportBase & {
        stagingChatId: string
        receipt: CanonicalTurnReceipt
    }
): Promise<CanonicalTurnReceipt> {
    return parseCanonicalTurnReceipt(await post(
        input,
        '/api/risubard/memory/wiki/reboot/record',
        {
            characterId: bounded(input.characterId, 'Character ID'),
            chatId: bounded(input.stagingChatId, 'Staging chat ID'),
            receipt: parseCanonicalTurnReceipt(input.receipt),
        }
    ))
}

export async function completeWikiRebootBatch(
    input: RebootBatchTransportInput
): Promise<{ removed: boolean }> {
    const value = record(await post(
        input,
        '/api/risubard/memory/wiki/reboot/complete',
        batchBody(input)
    ))
    if (typeof value.removed !== 'boolean') {
        throw new Error('Invalid BardWiki reboot completion receipt')
    }
    return { removed: value.removed }
}

export async function recoverWikiRebootBatch(input: TransportBase & {
    stagingChatId: string
    sourceMessageIds: string[]
    eventSourceGroups: string[][]
}): Promise<CanonicalTurnReceipt | null> {
    const value = record(await post(
        input,
        '/api/risubard/memory/wiki/reboot/recover',
        {
            characterId: bounded(input.characterId, 'Character ID'),
            chatId: bounded(input.stagingChatId, 'Staging chat ID'),
            sourceMessageIds: input.sourceMessageIds.map((id) =>
                bounded(id, 'Source message ID')
            ),
            eventSourceGroups: input.eventSourceGroups.map((group) =>
                group.map((id) => bounded(id, 'Event source message ID'))
            ),
        }
    ))
    return value.receipt === null
        ? null
        : parseCanonicalTurnReceipt(value.receipt)
}
