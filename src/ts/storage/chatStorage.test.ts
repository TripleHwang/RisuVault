import { describe, test, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    fetchChatContent: vi.fn(),
}))
const activeStorage = vi.hoisted(() => ({ current: null as any }))
const runtimeState = vi.hoisted(() => {
    const state = { database: { characters: [] as any[], selectedChatId: null as string | null }, selectedIndex: 0, generating: new Set<string>(), hydrating: new Set<string>(), listeners: [] as Array<(value: number) => void>, flush: vi.fn(async () => undefined) }
    return Object.assign(state, { select: (index: number) => { state.selectedIndex = index; state.listeners.forEach(listener => listener(index)) } })
})

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: { fetchChatContent: mocks.fetchChatContent },
    },
}))
vi.mock('./database.svelte', () => ({
    getDatabase: () => runtimeState.database,
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))
vi.mock('./sql/sqlBootstrap', () => ({ getActiveSqlStorage: () => activeStorage.current }))
vi.mock('./sql/sqlPersistenceRuntime', () => ({ flushSqlDirtyChanges: runtimeState.flush, markSqlChatDirty: vi.fn() }))
vi.mock('../process/generationState', () => ({ isChatGenerating: (id: string) => runtimeState.generating.has(id) }))
vi.mock('./hydrationState', () => ({ beginHydration: () => undefined, beginHydrationApply: () => undefined, endHydration: () => undefined, endHydrationApply: () => undefined, isHydrationActive: (key: string) => runtimeState.hydrating.has(key) }))
vi.mock('../stores.svelte', () => ({ selectedCharID: { subscribe: (run: (value: number) => void) => { runtimeState.listeners.push(run); run(runtimeState.selectedIndex); return () => undefined } } }))

const { chatToStub, stubToPlaceholder, convertStubsToPlaceholders, classifyChat, ChatHydrationCache, hydrateRecentChatPage, touchHydratedChat, evictHydratedChats, resetChatHydrationCacheForTesting, chatNeedsServerFetch, isChatHistoryIncomplete, ensureChatHydrated } = await import('./chatStorage')
const { getSqlWindow, setSqlWindow } = await import('./sql/sqlRuntimeWindow')
type Chat = any
type ChatStub = any

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

describe('chatToStub', () => {
    test('preserves explicit null folderId as a key', () => {
        const stub = chatToStub(blankChat({ folderId: null as any }))
        expect('folderId' in stub).toBe(true)
        expect(stub.folderId).toBeNull()
    })

    test('omits folderId when the chat has no such key', () => {
        const stub = chatToStub(blankChat())
        expect('folderId' in stub).toBe(false)
    })

    test('preserves a non-null folderId', () => {
        const stub = chatToStub(blankChat({ folderId: 'F1' }))
        expect(stub.folderId).toBe('F1')
    })

    test('same key-presence semantics applies to modules', () => {
        expect('modules' in chatToStub(blankChat({ modules: null as any }))).toBe(true)
        expect('modules' in chatToStub(blankChat({ modules: [] }))).toBe(true)
        expect('modules' in chatToStub(blankChat())).toBe(false)
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('preserves explicit null folderId from server', () => {
        const stub: ChatStub = {
            id: 'c1',
            name: 't',
            _stub: true,
            folderId: null as any,
        }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(true)
        expect(placeholder.folderId).toBeNull()
    })

    test('omits folderId when stub has no such key', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(false)
    })

    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

    test('preserves modules key (null and array)', () => {
        const nullStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: null as any }
        expect('modules' in stubToPlaceholder(nullStub)).toBe(true)
        expect(stubToPlaceholder(nullStub).modules).toBeNull()

        const arrStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: ['m1'] }
        expect(stubToPlaceholder(arrStub).modules).toEqual(['m1'])
    })
})

// The bug this branch fixes: a user clearing folderId would round-trip into
// a "remove" patch op once the placeholder dropped the null key. With key
// presence preserved end-to-end, the explicit null survives placeholder →
// stub conversion and reaches the server merge layer as a real value.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('classifyChat tags _stub + message as "hybrid"', () => {
        expect(classifyChat(hybridChat())).toBe('hybrid')
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('convertStubsToPlaceholders still converts real stubs to placeholders', () => {
        const realStub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const [result] = convertStubsToPlaceholders([realStub])
        expect((result as any)._placeholder).toBe(true)
        expect(result.message).toEqual([])
        expect(result.fmIndex).toBe(-1)
    })

    test('convertStubsToPlaceholders leaves real Chats alone', () => {
        const realChat: Chat = {
            message: [], note: '', name: 'x', localLore: [], id: 'c2',
        }
        const [result] = convertStubsToPlaceholders([realChat])
        expect(result).toBe(realChat)   // same reference, untouched
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})

describe('ChatHydrationCache', () => {
    test('keeps the two most recently touched hydrated chat IDs after a third hydration', async () => {
        const cache = new ChatHydrationCache({ maxChats: 2, flush: vi.fn().mockResolvedValue(undefined) })

        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        await cache.touch('char-b', 'chat-3', { getActiveKey: () => 'char-b/chat-3' })

        expect(cache.ids()).toEqual(['char-a/chat-2', 'char-b/chat-3'])
    })

    test('moves an existing ID to the most-recent position', async () => {
        const cache = new ChatHydrationCache({ maxChats: 2, flush: vi.fn().mockResolvedValue(undefined) })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        await cache.touch('char-a', 'chat-1')

        expect(cache.ids()).toEqual(['char-a/chat-2', 'char-a/chat-1'])
    })

    test('does not mutate the LRU when flushing before eviction fails', async () => {
        const flush = vi.fn().mockRejectedValue(new Error('offline'))
        const cache = new ChatHydrationCache({ maxChats: 1, flush })
        await cache.touch('char-a', 'chat-1')

        await expect(cache.touch('char-a', 'chat-2', { getActiveKey: () => 'char-a/chat-2' })).rejects.toThrow('offline')
        expect(cache.ids()).toEqual(['char-a/chat-1'])
    })

    test('re-evaluates the eviction candidate after an await reorders the LRU', async () => {
        let release!: () => void
        const flush = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
        const evicted: string[] = []
        const cache = new ChatHydrationCache({ maxChats: 2, flush, onEvict: key => evicted.push(key) })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')

        const third = cache.touch('char-a', 'chat-3')
        await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
        await cache.touch('char-a', 'chat-1')
        release()
        await third

        expect(evicted).toEqual(['char-a/chat-2'])
        expect(cache.ids()).toEqual(['char-a/chat-1', 'char-a/chat-3'])
    })

    test('skips active, protected, and in-flight chat IDs', async () => {
        const evicted: string[] = []
        const cache = new ChatHydrationCache({ maxChats: 2, flush: vi.fn().mockResolvedValue(undefined), onEvict: key => evicted.push(key) })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        await cache.touch('char-a', 'chat-3', {
            getActiveKey: () => 'char-a/chat-1',
            isProtected: key => key === 'char-a/chat-2',
        })

        expect(evicted).toEqual([])
        expect(cache.ids()).toEqual(['char-a/chat-1', 'char-a/chat-2'])
    })

    test('stores identifiers only, never chat object references', async () => {
        const cache = new ChatHydrationCache({ maxChats: 2, flush: vi.fn().mockResolvedValue(undefined) })
        const chat = blankChat()
        await cache.touch('char-a', 'chat-1', { chat } as any)

        expect(Object.values(cache as any).flatMap((value: any) => value instanceof Map ? [...value.values()] : [])).not.toContain(chat)
    })

    test('uses the active-key callback after flush when selection changes', async () => {
        let release!: () => void
        let active = 'char-a/chat-3'
        const flush = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
        const evicted: string[] = []
        const cache = new ChatHydrationCache({ maxChats: 2, flush, onEvict: key => evicted.push(key) })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        const third = cache.touch('char-a', 'chat-3', { getActiveKey: () => active })
        await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce())
        active = 'char-a/chat-1'
        release()
        await third

        expect(evicted).toEqual(['char-a/chat-2'])
    })

    test('prunes a missing resident key before choosing an eviction candidate', async () => {
        const flush = vi.fn().mockResolvedValue(undefined)
        const cache = new ChatHydrationCache({ maxChats: 2, flush, isResident: key => key !== 'char-a/chat-1' })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        await cache.touch('char-a', 'chat-3')

        expect(cache.ids()).toEqual(['char-a/chat-2', 'char-a/chat-3'])
        expect(flush).not.toHaveBeenCalled()
    })

    test('retries a different candidate when the final eviction gap becomes active', async () => {
        let active = 'char-a/chat-3'
        const evicted: string[] = []
        const cache = new ChatHydrationCache({
            maxChats: 2,
            flush: vi.fn().mockResolvedValue(undefined),
            onEvict: key => {
                if (key === 'char-a/chat-1') {
                    active = key
                    return false
                }
                evicted.push(key)
            },
        })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')
        await cache.touch('char-a', 'chat-3', { getActiveKey: () => active })

        expect(evicted).toEqual(['char-a/chat-2'])
        expect(cache.ids()).toEqual(['char-a/chat-1', 'char-a/chat-3'])
    })

    test('bounds churn across flush awaits without changing LRU residency', async () => {
        let active = 'char-a/chat-3'
        const flush = vi.fn(() => {
            active = active === 'char-a/chat-1' ? 'char-a/chat-2' : 'char-a/chat-1'
            return Promise.resolve()
        })
        const evicted: string[] = []
        const cache = new ChatHydrationCache({ maxChats: 2, flush, onEvict: key => evicted.push(key) })
        await cache.touch('char-a', 'chat-1')
        await cache.touch('char-a', 'chat-2')

        await expect(cache.touch('char-a', 'chat-3', { getActiveKey: () => active })).resolves.toBe(false)

        expect(flush).toHaveBeenCalledTimes(2)
        expect(evicted).toEqual([])
        expect(cache.ids()).toEqual(['char-a/chat-1', 'char-a/chat-2'])
    })
})

describe('hydrateRecentChatPage', () => {
    test('rehydrates the newest 40-message reverse page without a snapshot', async () => {
        const loadChatMessageReversePage = vi.fn().mockResolvedValue({
            chatId: 'chat-1', messages: [{ chatId: 'm-39' }, { chatId: 'm-40' }],
            positions: [39, 40], before: 41, nextBefore: 1, nextPosition: 41, total: 41, hasMore: true,
        })
        activeStorage.current = { backendKind: 'server-sql', loadCharacterHydration: vi.fn(), loadChatMessageReversePage }
        const chats = [blankChat({ id: 'chat-1', message: [], messagesLoaded: false })]

        const hydrated = await hydrateRecentChatPage(chats, 0, 'char-a')

        expect(loadChatMessageReversePage).toHaveBeenCalledWith('chat-1', undefined, 40)
        expect(hydrated?.message.map((message: any) => message.chatId)).toEqual(['m-39', 'm-40'])
        expect(getSqlWindow(hydrated)).toMatchObject({ hasOlder: true, total: 41 })
    })

    test('touches the hydrated ID after its slot reorders during the page await', async () => {
        resetChatHydrationCacheForTesting()
        const chatA = blankChat({ id: 'chat-a', message: [], messagesLoaded: false })
        const chatB = blankChat({ id: 'chat-b', message: [{ chatId: 'b' }], messagesLoaded: true })
        const chatX = blankChat({ id: 'chat-x', message: [{ chatId: 'x' }], messagesLoaded: true })
        const chatC = blankChat({ id: 'chat-c', message: [{ chatId: 'c' }], messagesLoaded: true })
        const chatD = blankChat({ id: 'chat-d', message: [{ chatId: 'd' }], messagesLoaded: true })
        const chats = [chatA, chatB]
        runtimeState.database.characters = [
            { chaId: 'char-x', chatPage: 0, chats: [chatX] },
            { chaId: 'char-a', chatPage: 0, chats },
            { chaId: 'char-c', chatPage: 0, chats: [chatC] },
            { chaId: 'char-d', chatPage: 0, chats: [chatD] },
        ]
        runtimeState.selectedIndex = 3
        activeStorage.current = {
            backendKind: 'server-sql', loadCharacterHydration: vi.fn(),
            loadChatMessageReversePage: vi.fn(async () => {
                chats.splice(0, 2, chatB, chatA)
                return { chatId: 'chat-a', messages: [{ chatId: 'a' }], positions: [0], before: 1, nextBefore: null, nextPosition: 1, total: 1, hasMore: false }
            }),
        }
        await touchHydratedChat('char-x', runtimeState.database.characters[0].chats, 0)
        await hydrateRecentChatPage(chats, 0, 'char-a')
        await touchHydratedChat('char-c', runtimeState.database.characters[2].chats, 0)
        await touchHydratedChat('char-d', runtimeState.database.characters[3].chats, 0)

        expect(chats.find(chat => chat.id === 'chat-a')?._placeholder).toBe(true)
        expect(chats.find(chat => chat.id === 'chat-b')?._placeholder).not.toBe(true)
    })
})

describe('runtime hydrated-chat eviction', () => {
    // Build the hydration window the way hydration itself does. It is
    // symbol-keyed runtime state, so an object literal cannot express it and a
    // fixture that tried would leave the chat looking like one that was never
    // hydrated -- which is not what eviction has to survive.
    const runtimeChat = (id: string, extras: any = {}) => {
        const chat = blankChat({
            id, message: [{ chatId: `${id}-message`, data: 'body' }], messagesLoaded: true,
            messagesFullyLoaded: false, note: `${id}-note`,
            localLore: [{ key: id }], modules: [`${id}-module`], customMetadata: { id }, ...extras,
        })
        setSqlWindow(chat, { before: null, nextBefore: 0, total: 2, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 2 })
        return chat
    }
    const character = (id: string, chat: any) => ({ chaId: id, chatPage: 0, chats: [chat] })

    test('re-finds a stable ID after flush and replaces only its message body', async () => {
        resetChatHydrationCacheForTesting()
        runtimeState.flush.mockClear()
        const first = runtimeChat('chat-1')
        const second = runtimeChat('chat-2')
        const third = runtimeChat('chat-3')
        runtimeState.database.characters = [character('char-1', first), character('char-2', second), character('char-3', third)]
        runtimeState.selectedIndex = 2

        await touchHydratedChat('char-1', runtimeState.database.characters[0].chats, 0)
        await touchHydratedChat('char-2', runtimeState.database.characters[1].chats, 0)
        const replacement = runtimeChat('chat-1', { name: 'replacement', customMetadata: { fresh: true } })
        const originalFlush = runtimeState.flush.getMockImplementation()!
        runtimeState.flush.mockImplementationOnce(async () => {
            runtimeState.database.characters[0].chats[0] = replacement
            await originalFlush()
        })
        await touchHydratedChat('char-3', runtimeState.database.characters[2].chats, 0)

        const evicted = runtimeState.database.characters[0].chats[0]
        expect(evicted).not.toBe(replacement)
        expect(evicted).toMatchObject({ id: 'chat-1', name: 'replacement', customMetadata: { fresh: true }, note: 'chat-1-note', modules: ['chat-1-module'], message: [], _placeholder: true, messagesLoaded: false })
        expect(evicted.localLore).toEqual([{ key: 'chat-1' }])
        // The replacement slot describes an empty, unhydrated chat, so it must
        // carry no window at all: a window says "these forty are resident and
        // storage holds more", and the slot now holds none. Both spellings are
        // checked -- the symbol one is the live marker, and the string one is
        // what a save encoder would have serialised had it survived.
        expect(getSqlWindow(evicted)).toBeUndefined()
        expect('_sqlWindow' in evicted).toBe(false)
        expect(runtimeState.flush).toHaveBeenCalledTimes(2)
    })

    test('uses the globally selected character as active across characters', async () => {
        resetChatHydrationCacheForTesting()
        const active = runtimeChat('chat-active')
        const other = runtimeChat('chat-other')
        runtimeState.database.characters = [character('char-active', active), character('char-other', other)]
        runtimeState.selectedIndex = 0
        await touchHydratedChat('char-active', runtimeState.database.characters[0].chats, 0)
        await touchHydratedChat('char-other', runtimeState.database.characters[1].chats, 0)

        await evictHydratedChats()

        expect(runtimeState.database.characters[0].chats[0]._placeholder).not.toBe(true)
        expect(runtimeState.database.characters[1].chats[0]).toMatchObject({ _placeholder: true, message: [] })
    })

    test('does not evict a chat with any reboot job object', async () => {
        resetChatHydrationCacheForTesting()
        const job = runtimeChat('chat-job', { risuBardWikiReboot: { status: 'failed' } })
        const safe = runtimeChat('chat-safe')
        const third = runtimeChat('chat-third')
        runtimeState.database.characters = [character('char-job', job), character('char-safe', safe), character('char-third', third)]
        runtimeState.selectedIndex = 2
        await touchHydratedChat('char-job', runtimeState.database.characters[0].chats, 0)
        await touchHydratedChat('char-safe', runtimeState.database.characters[1].chats, 0)
        await touchHydratedChat('char-third', runtimeState.database.characters[2].chats, 0)

        expect(runtimeState.database.characters[0].chats[0]._placeholder).not.toBe(true)
        expect(runtimeState.database.characters[1].chats[0]).toMatchObject({ _placeholder: true, message: [] })
    })

    test('prunes a same-ID placeholder slot instead of treating it as resident', async () => {
        resetChatHydrationCacheForTesting()
        runtimeState.flush.mockClear()
        const first = runtimeChat('chat-1')
        const second = runtimeChat('chat-2')
        const third = runtimeChat('chat-3')
        runtimeState.database.characters = [character('char-1', first), character('char-2', second), character('char-3', third)]
        runtimeState.selectedIndex = 2
        await touchHydratedChat('char-1', runtimeState.database.characters[0].chats, 0)
        await touchHydratedChat('char-2', runtimeState.database.characters[1].chats, 0)
        runtimeState.database.characters[0].chats[0] = { id: 'chat-1', name: 'placeholder', message: [], _placeholder: true, messagesLoaded: false }
        await touchHydratedChat('char-3', runtimeState.database.characters[2].chats, 0)

        expect(runtimeState.flush).not.toHaveBeenCalled()
        expect(runtimeState.database.characters[1].chats[0]._placeholder).not.toBe(true)
        expect(runtimeState.database.characters[2].chats[0]._placeholder).not.toBe(true)
    })

    test('touches a direct selected-character store change for hotkey/card paths', async () => {
        resetChatHydrationCacheForTesting()
        const first = runtimeChat('chat-1')
        const second = runtimeChat('chat-2')
        const third = runtimeChat('chat-3')
        runtimeState.database.characters = [character('char-1', first), character('char-2', second), character('char-3', third)]
        runtimeState.selectedIndex = 2
        await touchHydratedChat('char-1', runtimeState.database.characters[0].chats, 0)
        await touchHydratedChat('char-2', runtimeState.database.characters[1].chats, 0)

        runtimeState.select(0)
        await vi.waitFor(() => expect(runtimeState.database.characters[0].chats[0]._placeholder).not.toBe(true))
        await touchHydratedChat('char-3', runtimeState.database.characters[2].chats, 0)

        expect(runtimeState.database.characters[0].chats[0]._placeholder).not.toBe(true)
        expect(runtimeState.database.characters[1].chats[0]._placeholder).toBe(true)
    })

    test('protects streaming, generating, hydrating, and full-history chats', async () => {
        const cases: Array<[string, any, () => void]> = [
            ['streaming', { isStreaming: true }, () => undefined],
            ['generating', {}, () => runtimeState.generating.add('chat-protected')],
            ['hydrating', {}, () => runtimeState.hydrating.add('char-protected/chat-protected')],
            ['full history', { fullHistoryOperation: true }, () => undefined],
        ]
        for (const [_name, extras, prepare] of cases) {
            resetChatHydrationCacheForTesting()
            runtimeState.generating.clear()
            runtimeState.hydrating.clear()
            const protectedChat = runtimeChat('chat-protected', extras)
            const safe = runtimeChat('chat-safe')
            const third = runtimeChat('chat-third')
            runtimeState.database.characters = [character('char-protected', protectedChat), character('char-safe', safe), character('char-third', third)]
            runtimeState.selectedIndex = 2
            prepare()
            await touchHydratedChat('char-protected', runtimeState.database.characters[0].chats, 0)
            await touchHydratedChat('char-safe', runtimeState.database.characters[1].chats, 0)
            await touchHydratedChat('char-third', runtimeState.database.characters[2].chats, 0)

            expect(runtimeState.database.characters[0].chats[0]._placeholder).not.toBe(true)
            expect(runtimeState.database.characters[1].chats[0]._placeholder).toBe(true)
        }
    })
})

/**
 * `isChatHistoryIncomplete` is the single predicate the app asks before it does
 * anything that writes a chat's whole message list back: saving a slot, merging
 * chats, recovering a job, exporting. If it answers "complete" for a chat that
 * is holding only its newest page, the write replaces the persisted history
 * with that page.
 *
 * The window it consults is symbol-keyed runtime state. A reader still spelling
 * the old property name reads `undefined` and answers "complete" -- silently,
 * with no error anywhere -- which is why this is asserted against the real
 * accessor and the real function rather than a fixture shaped by hand.
 */
describe('isChatHistoryIncomplete', () => {
    test('reports a fully resident chat as complete', () => {
        expect(isChatHistoryIncomplete(blankChat({
            id: 'chat-1', message: [{ chatId: 'm-1' }], messagesLoaded: true, messagesFullyLoaded: true,
        }))).toBe(false)
    })

    test('reports a chat whose older messages are still in storage as incomplete', () => {
        const chat = blankChat({
            id: 'chat-1', message: [{ chatId: 'm-400' }], messagesLoaded: true, messagesFullyLoaded: true,
        })
        setSqlWindow(chat, { before: null, nextBefore: 360, total: 400, hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 400 })

        expect(isChatHistoryIncomplete(chat)).toBe(true)
    })

    test('reports a chat whose newest messages were released as incomplete', () => {
        // The mirror of the case above, and the one residency trimming creates:
        // the user paged back to the start of the history, so nothing is older,
        // and the trimmer released the newest end to bound memory. The flags say
        // "loaded" here on purpose -- this pins the window predicate itself
        // rather than passing on `messagesFullyLoaded === false`, which trimming
        // also clears. A reader still asking `hasOlderSqlMessages` answers
        // "complete" over a slice that is missing the end of the conversation.
        const chat = blankChat({
            id: 'chat-1', message: [{ chatId: 'm-100' }], messagesLoaded: true, messagesFullyLoaded: true,
        })
        setSqlWindow(chat, { before: null, nextBefore: null, total: 400, hasOlder: false, hasNewer: true, nextAfter: 279, nextPosition: 400 })

        expect(isChatHistoryIncomplete(chat)).toBe(true)
    })

    test('reports the chat as complete again once the window says nothing is older', () => {
        const chat = blankChat({
            id: 'chat-1', message: [{ chatId: 'm-1' }], messagesLoaded: true, messagesFullyLoaded: true,
        })
        setSqlWindow(chat, { before: null, nextBefore: null, total: 1, hasOlder: false, hasNewer: false, nextAfter: null, nextPosition: 1 })

        expect(isChatHistoryIncomplete(chat)).toBe(false)
    })

    test('still reports placeholders and unloaded chats as incomplete', () => {
        // No window at all is "no evidence", not "nothing older": these flags
        // are what catch a chat that was never hydrated in the first place.
        expect(isChatHistoryIncomplete(null)).toBe(true)
        expect(isChatHistoryIncomplete(blankChat({ _placeholder: true }))).toBe(true)
        expect(isChatHistoryIncomplete(blankChat({ messagesLoaded: false }))).toBe(true)
        expect(isChatHistoryIncomplete(blankChat({ messagesFullyLoaded: false }))).toBe(true)
    })
})

describe('deciding whether a chat must be fetched before export or backup', () => {
    // Both paths work on a structuredClone of the database, where the
    // symbol-keyed hydration window does not survive -- so these flags are the
    // only signal left. A trimmed chat keeps messagesLoaded true, which is why
    // the earlier condition skipped the fetch and then refused the backup with
    // "load earlier messages", the one action that trims further.
    test('fetches a chat residency trimming has shortened', () => {
        expect(chatNeedsServerFetch({
            id: 'chat-1', message: [], messagesLoaded: true, messagesFullyLoaded: false,
        } as any)).toBe(true)
    })

    test('fetches a placeholder and an unloaded chat', () => {
        expect(chatNeedsServerFetch({ id: 'chat-1', _placeholder: true } as any)).toBe(true)
        expect(chatNeedsServerFetch({ id: 'chat-1', messagesLoaded: false } as any)).toBe(true)
    })

    test('leaves a whole chat alone', () => {
        expect(chatNeedsServerFetch({
            id: 'chat-1', message: [], messagesLoaded: true, messagesFullyLoaded: true,
        } as any)).toBe(false)
        // A chat that never went through SQL hydration carries neither flag.
        expect(chatNeedsServerFetch({ id: 'chat-1', message: [] } as any)).toBe(false)
    })
})

describe('ensureChatHydrated', () => {
    test('applies the loaded chat when the browser never delivers the next animation frame', async () => {
        // The paint wait sits on the whole-chat fetch path, which only runs
        // when no server-SQL backend is active. Earlier suites leave one
        // installed, so this test clears it rather than depending on order.
        activeStorage.current = null
        resetChatHydrationCacheForTesting()
        vi.useFakeTimers()
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
        try {
            const placeholder = stubToPlaceholder({ id: 'chat-1', name: 'Chat 1', _stub: true })
            const full = blankChat({ id: 'chat-1', name: 'Chat 1', message: [
                { role: 'char', data: 'loaded' },
            ] })
            const chats = [placeholder]
            mocks.fetchChatContent.mockResolvedValueOnce(full)

            const hydration = ensureChatHydrated(chats, 0, 'char-1')
            await vi.advanceTimersByTimeAsync(1_000)

            expect(chats[0]).toBe(full)
            await expect(hydration).resolves.toBe(full)
        } finally {
            vi.useRealTimers()
            vi.unstubAllGlobals()
        }
    })
})
