import { describe, expect, test, vi } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import {
    countChatTurns,
    createMemorySaveSlot,
    decodeMemorySaveChat,
    encodeMemorySaveChat,
    listMemorySaveSlots,
    deleteMemorySaveSlot,
    previewMemorySaveSlot,
    prepareMemorySaveLoad,
    renameMemorySaveSlot,
    latestChatMessageId,
    shouldConfirmMemorySaveLoad,
} from './memorySaveSlots'

const chat: Chat = {
    id: 'chat-1', name: '성문 앞', note: '', localLore: [],
    scriptstate: { '$trust': 3 },
    message: [
        { role: 'user', data: '들어간다.', chatId: 'user-1' },
        { role: 'char', data: '문이 열렸다.', chatId: 'assistant-1' },
        {
            role: 'char', data: '분기 표시', chatId: 'comment-1',
            isComment: true,
        },
        {
            role: 'char', data: '비활성 응답', chatId: 'disabled-1',
            disabled: true,
        },
    ],
}

const summary = {
    saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '성문 앞',
    createdAt: '2026-08-14T08:00:00.000Z', turnCount: 1,
    latestMessageId: 'assistant-1',
    latestEvent: { title: '성문이 열렸다', excerpt: '경비병이 허락했다.' },
}

describe('memory save slot client', () => {
    test('counts only visible assistant story turns', () => {
        expect(countChatTurns(chat.message)).toBe(1)
        expect(latestChatMessageId(chat.message)).toBe('assistant-1')
        expect(latestChatMessageId([
            ...chat.message,
            { role: 'user', data: '아직 ID가 없는 최신 메시지' },
        ])).toBeUndefined()
    })

    test('asks before load unless the current story matches the newest save', () => {
        expect(shouldConfirmMemorySaveLoad('assistant-1', [summary])).toBe(false)
        expect(shouldConfirmMemorySaveLoad('unsaved-message', [summary])).toBe(true)
        expect(shouldConfirmMemorySaveLoad('assistant-1', [{
            ...summary,
            latestMessageId: undefined,
        }])).toBe(true)
    })

    test.each([false, true])('saves story state without sidebar preferences with overwrite=%s', async (overwrite) => {
        const currentChat: Chat = {
            ...chat,
            bindedPersona: 'current-persona',
            bindedBotPreset: 'current-prompt', usePromptPresetParams: true,
            useModelPreset: true,
            modelBinding: {
                main: 'current-main', sub: 'current-sub', separateAux: true,
                aux: {
                    memory: 'current-memory', emotion: 'current-emotion',
                    translate: 'current-translate', otherAx: 'current-other',
                },
            },
            useLocallySetGlobalVariables: true,
            savedToggleValues: { toggle_style: 'legacy-style' },
            GLGlobalVariables: { toggle_style: 'new-style', toggle_words: '700', chapter: '2' },
            togglePresetBaseline: {
                name: 'Current toggles',
                values: { toggle_style: 'baseline-style', toggle_words: '500' },
            },
        }
        const before = structuredClone(currentChat)
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
            calls.push({ url: String(url), init })
            return new Response(JSON.stringify(summary), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        await expect(createMemorySaveSlot({
            characterId: 'character', chat: currentChat, overwrite,
            saveId: 'save-1', fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual(summary)
        expect(calls[0].url).toBe('/api/risubard/memory/save-slot')
        const headers = calls[0].init?.headers as Record<string, string>
        expect(headers['x-risubard-turn-count']).toBe('1')
        expect(headers['x-risubard-save-overwrite']).toBe(overwrite ? 'true' : undefined)
        expect(headers['x-risubard-latest-message-id']).toBe('assistant-1')
        const encodedName = headers['x-risubard-chat-name']
            .replaceAll('-', '+').replaceAll('_', '/')
        expect(Buffer.from(encodedName, 'base64').toString('utf8')).toBe('성문 앞')
        expect(calls[0].init?.body).toBeInstanceOf(ArrayBuffer)
        const snapshot = decodeMemorySaveChat(
            new Uint8Array(calls[0].init?.body as ArrayBuffer)
        ) as Chat
        expect(snapshot.scriptstate).toEqual(chat.scriptstate)
        expect(snapshot.message).toEqual(chat.message)
        expect(snapshot.GLGlobalVariables).toEqual({ chapter: '2' })
        for (const key of [
            'bindedPersona', 'bindedBotPreset', 'usePromptPresetParams',
            'useModelPreset', 'modelBinding', 'useLocallySetGlobalVariables',
            'savedToggleValues', 'togglePresetBaseline',
        ]) {
            expect(snapshot).not.toHaveProperty(key)
        }
        expect(currentChat).toEqual(before)
    })

    test('times out a save request that never settles', async () => {
        vi.useFakeTimers()
        try {
            let requestSignal: AbortSignal | undefined
            const fetchImpl = vi.fn(async (_url, init) => {
                requestSignal = init?.signal ?? undefined
                return new Promise<Response>(() => {})
            }) as unknown as typeof fetch
            const saving = createMemorySaveSlot({
                characterId: 'character', chat, saveId: 'save-1', fetchImpl,
                createAuth: async () => 'auth',
            }).then(
                () => 'resolved',
                (error: unknown) => error instanceof Error
                    ? error.name
                    : String(error)
            )

            await vi.advanceTimersByTimeAsync(10 * 60_000)

            await expect(Promise.race([
                saving,
                Promise.resolve('still-pending'),
            ])).resolves.toBe('TimeoutError')
            expect(requestSignal?.aborted).toBe(true)
        }
        finally {
            vi.useRealTimers()
        }
    })

    test('lists strict summaries and decodes a prepared chat load', async () => {
        const savedBytes = encodeMemorySaveChat(chat)
        const fetchMock = vi.fn(async (
            url: URL | RequestInfo,
            _init?: RequestInit
        ) => {
            if (String(url).endsWith('/list')) {
                return new Response(JSON.stringify([summary]))
            }
            return new Response(Uint8Array.from(savedBytes).buffer, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-risubard-fork-token': 'load-token',
                },
            })
        })
        const fetchImpl = fetchMock as unknown as typeof fetch

        await expect(listMemorySaveSlots({
            characterId: 'character', sourceChatId: 'chat-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual([summary])
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            characterId: 'character', sourceChatId: 'chat-1',
        })
        const loaded = await prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1',
            currentChat: {
                ...chat, bindedBotPreset: 'current-prompt',
                useLocallySetGlobalVariables: true,
                GLGlobalVariables: { toggle_language: 'ko' },
            },
            destinationChatId: 'loaded-chat', fetchImpl,
            createAuth: async () => 'auth',
        })
        expect(loaded).toMatchObject({
            forkToken: 'load-token',
            chat: {
                id: 'chat-1', name: '성문 앞',
                scriptstate: { '$trust': 3 },
                bindedBotPreset: 'current-prompt',
                useLocallySetGlobalVariables: true,
                GLGlobalVariables: { toggle_language: 'ko' },
            },
        })
        expect(loaded.chat.message.map((message) => message.chatId)).toEqual([
            'user-1', 'assistant-1', 'comment-1', 'disabled-1',
        ])
    })

    test('rejects a prepared load without its fork token', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(encodeMemorySaveChat(chat)).buffer,
            { headers: { 'content-type': 'application/octet-stream' } }
        )) as unknown as typeof fetch

        await expect(prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1',
            currentChat: chat,
            destinationChatId: 'loaded-chat', fetchImpl,
            createAuth: async () => 'auth',
        })).rejects.toThrow('fork token')
    })

    test.each([
        { name: 'pinned', current: {
            bindedPersona: 'new-persona',
            bindedBotPreset: 'new-prompt', usePromptPresetParams: false,
            useModelPreset: true,
            modelBinding: {
                main: 'new-main', sub: 'new-sub', separateAux: true,
                aux: { memory: 'new-memory', emotion: '', translate: '', otherAx: '' },
            },
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_style: '', toggle_words: '1000', toggle_new: '1', chapter: '9' },
            togglePresetBaseline: {
                name: 'New toggles',
                values: { toggle_style: 'new-baseline', toggle_words: '800' },
            },
        } },
        { name: 'unpinned', current: { useLocallySetGlobalVariables: false } },
        { name: 'global defaults', current: {} },
        { name: 'legacy current pin', current: {
            savedToggleValues: { toggle_style: 'current-legacy', toggle_words: '' },
        } },
    ])('ignores saved sidebar settings and preserves $name preferences', async ({ name, current }) => {
        const savedChat: Chat = {
            ...chat,
            bindedPersona: 'old-persona',
            bindedBotPreset: 'old-prompt', usePromptPresetParams: true,
            useModelPreset: true,
            modelBinding: {
                main: 'old-main', sub: 'old-sub', separateAux: true,
                aux: { memory: 'old-memory', emotion: 'old-emotion', translate: 'old-translate', otherAx: 'old-other' },
            },
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_style: 'old-style', toggle_words: '700', toggle_removed: '1', chapter: '2' },
            savedToggleValues: { toggle_style: 'old-legacy' },
            togglePresetBaseline: {
                name: 'Old toggles',
                values: { toggle_style: 'old-baseline', toggle_words: '600' },
            },
        }
        const currentChat: Chat = {
            ...chat, scriptstate: { '$trust': 9 }, ...current,
        }
        const before = structuredClone(currentChat)
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(encodeMemorySaveChat(savedChat)).buffer,
            { headers: { 'x-risubard-fork-token': 'load-token' } },
        )) as unknown as typeof fetch
        const loaded = await prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1', currentChat,
            destinationChatId: 'chat-1', fetchImpl, createAuth: async () => 'auth',
        })
        expect(loaded.chat.bindedPersona).toBe(currentChat.bindedPersona)
        expect(loaded.chat.bindedBotPreset).toBe(currentChat.bindedBotPreset)
        expect(loaded.chat.usePromptPresetParams).toBe(currentChat.usePromptPresetParams)
        expect(loaded.chat.useModelPreset).toBe(currentChat.useModelPreset)
        expect(loaded.chat.modelBinding).toEqual(currentChat.modelBinding)
        expect(loaded.chat.togglePresetBaseline).toEqual(currentChat.togglePresetBaseline)
        expect(loaded.chat.useLocallySetGlobalVariables).toBe(
            name === 'legacy current pin' ? true : currentChat.useLocallySetGlobalVariables
        )
        const currentToggles = Object.fromEntries(Object.entries(
            currentChat.GLGlobalVariables ?? currentChat.savedToggleValues ?? {}
        ).filter(([key]) => key.startsWith('toggle_')))
        expect(loaded.chat.GLGlobalVariables).toEqual({ chapter: '2', ...currentToggles })
        expect(loaded.chat.savedToggleValues).toBeUndefined()
        expect(loaded.chat.scriptstate).toEqual({ '$trust': 3 })
        expect(loaded.chat.message).toEqual(chat.message)
        expect(currentChat).toEqual(before)
    })

    test('ignores a legacy toggle-only save without repinning the current chat', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(encodeMemorySaveChat({
                ...chat, savedToggleValues: { toggle_style: 'old-legacy' },
            })).buffer,
            { headers: { 'x-risubard-fork-token': 'load-token' } },
        )) as unknown as typeof fetch
        const loaded = await prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1', currentChat: chat,
            destinationChatId: 'chat-1', fetchImpl, createAuth: async () => 'auth',
        })
        expect(loaded.chat.savedToggleValues).toBeUndefined()
        expect(loaded.chat.GLGlobalVariables).toBeUndefined()
        expect(loaded.chat.useLocallySetGlobalVariables).toBeUndefined()
    })

    test('renames and deletes a saved file through bounded JSON requests', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const renamed = { ...summary, sourceChatName: '성 안뜰' }
        const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
            calls.push({ url: String(url), init })
            return String(url).endsWith('/rename')
                ? new Response(JSON.stringify(renamed))
                : new Response(null, { status: 204 })
        }) as unknown as typeof fetch

        await expect(renameMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', name: '성 안뜰',
            fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual(renamed)
        await expect(deleteMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toBeUndefined()
        expect(calls.map((call) => call.url)).toEqual([
            '/api/risubard/memory/save-slot/rename',
            '/api/risubard/memory/save-slot/delete',
        ])
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            characterId: 'character', saveId: 'save-1', name: '성 안뜰',
        })
    })

    test('loads only the selected saved chat for a compact latest-message preview', async () => {
        const previewChat: Chat = {
            ...chat,
            message: [
                { role: 'user', data: '예전 질문', chatId: 'old-user' },
                { role: 'char', data: '예전 답변', chatId: 'old-char' },
                { role: 'user', data: '최신 질문', chatId: 'latest-user' },
                { role: 'char', data: '최신 답변', chatId: 'latest-char' },
                { role: 'char', data: '숨겨진 최신 답변', chatId: 'hidden-char', disabled: true },
            ],
        }
        const savedBytes = encodeMemorySaveChat(previewChat)
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(savedBytes).buffer,
            { headers: { 'content-type': 'application/octet-stream' } }
        )) as unknown as typeof fetch

        await expect(previewMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual([
            { role: 'user', data: '최신 질문' },
            { role: 'char', data: '최신 답변' },
        ])
        expect(fetchImpl).toHaveBeenCalledOnce()
    })
})
