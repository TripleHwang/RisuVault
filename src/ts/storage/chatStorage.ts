import { forageStorage } from "../globalApi.svelte"
import { getDatabase, type Chat, type ChatStub, type ChatOrStub, type character, isChatStub } from "./database.svelte"
import { tick } from "svelte"
import { getActiveSqlStorage } from "./sql/sqlBootstrap"
import { ensureChatDetailsHydrated, ensureChatMessageWindow } from "./sql/sqlRuntimeHydration"
import { getSqlWindow, type SqlHydrationWindow } from "./sql/sqlRuntimeWindow"
import { isChatHistoryIncomplete } from "./chatHistoryCompleteness"
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply, isHydrationActive } from "./hydrationState"
import { flushSqlDirtyChanges, markSqlChatDirty } from "./sql/sqlPersistenceRuntime"
import { isChatGenerating } from "../process/generationState"
import { selectedCharID } from "../stores.svelte"
import { get } from "svelte/store"
import { updateRuntimeResources } from '../performance/performanceReport'

// ── Stub ↔ Placeholder conversion ───────────────────────────────────────────

/**
 * Convert a ChatStub to a placeholder Chat with safe empty defaults.
 * The placeholder passes all Chat type checks so existing code works unchanged.
 * `_placeholder: true` marks it for hydration and dirty-tracking suppression.
 *
 * Key presence is preserved (mirroring chatToStub) so an explicit null from
 * the server — meaning "user cleared this field" — survives the placeholder
 * round-trip. Otherwise the next chatToStub call would emit a "remove" patch
 * op and the server merge would fall back to a stale fullChat value.
 */
export function stubToPlaceholder(stub: ChatStub): Chat {
    const placeholder: Chat = {
        message: [],
        note: '',
        name: stub.name,
        localLore: [],
        id: stub.id,
        fmIndex: -1,
        _placeholder: true,
    }
    if ('lastDate' in stub) placeholder.lastDate = stub.lastDate
    if ('folderId' in stub) placeholder.folderId = stub.folderId
    if ('modules' in stub) placeholder.modules = stub.modules
    return placeholder
}

/**
 * Convert a Chat (or placeholder) to a ChatStub for database.bin encoding.
 *
 * Key presence is preserved even when the value is null/undefined so the
 * stub round-trip distinguishes "user cleared" from "field absent". The
 * server merge layer relies on `in` semantics — see mergeChatStubWithFullChat.
 */
export function chatToStub(chat: Chat | ChatStub): ChatStub {
    if (isChatStub(chat)) return chat
    const stub: ChatStub = {
        id: chat.id ?? '',
        name: chat.name ?? '',
        _stub: true,
    }
    if ('lastDate' in chat) stub.lastDate = chat.lastDate
    if ('folderId' in chat) stub.folderId = chat.folderId
    if ('modules' in chat) stub.modules = chat.modules
    return stub
}

/**
 * Replace all ChatStubs in a character's chats array with placeholder Chats.
 * Call this once after decoding database.bin so runtime code only sees Chat objects.
 *
 * Self-healing for hybrid corruption: if a chat carries the `_stub: true`
 * flag *and* a real message array (legacy v1.4.x disk corruption), strip the
 * flag and keep the Chat as-is. Converting it to a placeholder would call
 * stubToPlaceholder, which resets `message` to `[]` — the corruption would
 * become real data loss the moment the user sees the chat list.
 */
export function convertStubsToPlaceholders(chats: ChatOrStub[]): Chat[] {
    return chats.map(c => {
        if (!c) return c as Chat
        if ((c as any)._stub === true && Array.isArray((c as any).message)) {
            const { _stub: _drop, ...rest } = c as any
            return rest as Chat
        }
        return isChatStub(c) ? stubToPlaceholder(c) : (c as Chat)
    })
}

// Classify a chat slot by shape. Used by the chat-data guard's diagnostic
// dump to surface hybrid corruption (the `_stub: true` + message pattern that
// caused widespread chat data loss in v1.4.x).
export type ChatShape = 'stub' | 'placeholder' | 'hybrid' | 'full' | 'empty' | 'neither'

export function classifyChat(c: any): ChatShape {
    if (!c) return 'empty'
    const isStub = c._stub === true
    const isPh = c._placeholder === true
    const hasMessage = Array.isArray(c.message)
    if (isStub && hasMessage) return 'hybrid'
    if (isStub) return 'stub'
    if (isPh) return 'placeholder'
    if (hasMessage) return 'full'
    return 'neither'
}

// ── Hydration state ──────────────────────────────────────────────────────────

function chatKey(chaId: string, chatId: string): string {
    return `${chaId}/${chatId}`
}

type ChatEvictionOptions = {
    /** Read at every candidate selection, including after persistence awaits. */
    getActiveKey?: () => string | undefined
    /** Evaluated immediately before eviction, after the persistence await. */
    isProtected?: (key: string) => boolean
}

type ChatHydrationCacheOptions = {
    maxChats: number
    flush: () => Promise<void>
    /** Receives a stable key only; cache ownership must never retain Chat objects. */
    onEvict?: (key: string) => unknown | Promise<unknown>
    /** Persist victim metadata before its body is released. */
    prepareEviction?: (key: string) => unknown | Promise<unknown>
    /** Validates the stable slot still contains the body prepared before await. */
    isEvictionCurrent?: (key: string, token: unknown) => boolean
    /** Missing slots are stale cache IDs, not protected residents. */
    isResident?: (key: string) => boolean
}

/**
 * ID-only LRU bookkeeping for hydrated chat bodies.  Actual chat lookup is
 * intentionally delegated to the caller so the LRU cannot keep a message or
 * Chat reference alive after that slot has been stubbed.
 */
export class ChatHydrationCache {
    private readonly order = new Map<string, true>()

    constructor(private readonly options: ChatHydrationCacheOptions) {}

    ids(): string[] {
        return [...this.order.keys()]
    }

    clear(): void {
        this.order.clear()
    }

    private prune(): void {
        if (!this.options.isResident) return
        for (const key of this.order.keys()) if (!this.options.isResident(key)) this.order.delete(key)
    }

    private evictionCandidate(options: ChatEvictionOptions): string | null {
        const activeKey = options.getActiveKey?.()
        for (const key of this.order.keys()) {
            if (key === activeKey || options.isProtected?.(key)) continue
            return key
        }
        return null
    }

    private async flushCandidate(options: ChatEvictionOptions): Promise<string | null> {
        let candidate = this.evictionCandidate(options)
        // Selection and slot identity can churn while persistence awaits.
        // Two stable-ID retries cover the normal reorder/replacement race; a
        // third change is treated as contention and leaves residency intact.
        for (let attempts = 0; candidate && attempts < 2; attempts++) {
            const token = await this.options.prepareEviction?.(candidate)
            if (token === false) return null
            await this.options.flush()
            // Selection/reordering can pick another victim while persistence
            // is in flight. Mark and flush that new stable ID before release.
            const current = this.evictionCandidate(options)
            if (current === candidate && (!this.options.isEvictionCurrent || this.options.isEvictionCurrent(candidate, token))) return candidate
            candidate = current
        }
        return null
    }

    /**
     * Records a completed hydration. A third chat flushes dirty scopes before
     * its oldest safe peer is evicted; a failed flush leaves the LRU unchanged.
     */
    async touch(characterId: string, chatId: string, touchOptions: ChatEvictionOptions = {}): Promise<boolean> {
        const key = chatKey(characterId, chatId)
        this.prune()
        if (this.order.delete(key)) {
            this.order.set(key, true)
            return true
        }
        if (this.order.size < this.options.maxChats) {
            this.order.set(key, true)
            return true
        }

        if (!this.evictionCandidate(touchOptions)) return false
        // Do not adjust ordering before this await: on failure both the slot
        // and the observable LRU order remain exactly as they were.
        const victim = await this.flushCandidate(touchOptions)
        if (!victim) return false
        let candidate: string | null = victim
        while (candidate) {
            const evicted = await this.options.onEvict?.(candidate)
            if (evicted !== false) {
                this.order.delete(candidate)
                this.order.set(key, true)
                return true
            }
            const next = await this.flushCandidate(touchOptions)
            if (!next || next === candidate) return false
            candidate = next
        }
        return false
    }

    /** Evict every safe resident body except the selected chat. */
    async evictExcept(options: ChatEvictionOptions = {}): Promise<void> {
        this.prune()
        while (true) {
            const victim = await this.flushCandidate(options)
            if (!victim) return
            let candidate: string | null = victim
            while (candidate) {
                const evicted = await this.options.onEvict?.(candidate)
                if (evicted !== false) {
                    this.order.delete(candidate)
                    break
                }
                const next = await this.flushCandidate(options)
                if (!next || next === candidate) return
                candidate = next
            }
        }
    }
}

function parseChatKey(key: string): { characterId: string; chatId: string } | null {
    const separator = key.lastIndexOf('/')
    if (separator <= 0 || separator === key.length - 1) return null
    return { characterId: key.slice(0, separator), chatId: key.slice(separator + 1) }
}

type RuntimeChat = Chat & {
    messagesLoaded?: boolean
    messagesFullyLoaded?: boolean
    isLoadingFullHistory?: boolean
    loadingFullHistory?: boolean
    fullHistoryOperation?: boolean
    _fullHistoryOperation?: boolean
    loadingMessages?: boolean
    isLoading?: boolean
    risuBardWikiReboot?: { status?: string }
}

/** Re-find by stable IDs at eviction time; never retain a character/chat reference in the LRU. */
function findRuntimeChat(key: string): { chats: Chat[]; index: number; chat: RuntimeChat } | null {
    const ids = parseChatKey(key)
    if (!ids) return null
    const character = (getDatabase().characters ?? []).find(value => value?.chaId === ids.characterId)
    const index = character?.chats?.findIndex(value => value?.id === ids.chatId) ?? -1
    const chat = index === -1 ? null : character?.chats[index] as RuntimeChat | undefined
    return chat && character ? { chats: character.chats, index, chat } : null
}

function hasLiveChatWork(key: string): boolean {
    const ids = parseChatKey(key)
    const found = findRuntimeChat(key)
    if (!ids || !found) return true
    const { chat } = found
    // `fullHistoryOperation` / `loading` are not fields of `SqlHydrationWindow`.
    // They are read defensively: any writer that marks the window busy must be
    // able to hold off eviction, because evicting a chat mid-operation is the
    // whole failure this guard exists to prevent. Widening here keeps that
    // check meaningful instead of quietly dropping it during the move to the
    // symbol-keyed accessor.
    const sqlWindow = getSqlWindow(chat) as (SqlHydrationWindow & {
        fullHistoryOperation?: boolean
        loading?: boolean
    }) | undefined
    return chat._placeholder === true || isHydrationActive(key) || isChatGenerating(ids.chatId) ||
        Boolean(chat.isStreaming || chat.activeStreamingDisplayOptimizationMode ||
            chat.isLoadingFullHistory || chat.loadingFullHistory || sqlWindow?.fullHistoryOperation ||
            sqlWindow?.loading || chat.fullHistoryOperation || chat._fullHistoryOperation ||
            chat.loadingMessages || chat.isLoading || chat.risuBardWikiReboot)
}

function evictRuntimeChat(key: string): boolean {
    const found = findRuntimeChat(key)
    if (!found || key === getActiveRuntimeChatKey() || hasLiveChatWork(key)) return false
    // Keep every enumerable metadata field. The sole heavy body is `message`.
    // The hydration window is symbol-keyed, so `Object.entries` cannot see it
    // and it never reaches the replacement slot -- which is what we want: the
    // slot describes an empty, unhydrated chat, and a window carried across
    // would claim a resident page that is no longer there. The `_`-prefix
    // filter still drops a window written as a plain property by an older
    // build. No message or derived-cache reference moves into the slot.
    const metadata = Object.fromEntries(Object.entries(found.chat).filter(([key]) =>
        key !== 'message' && !key.startsWith('_'),
    ))
    found.chats[found.index] = {
        ...metadata,
        message: [],
        _placeholder: true,
        messagesLoaded: false,
        messagesFullyLoaded: false,
    } as unknown as Chat
    return true
}

function prepareRuntimeEviction(key: string): RuntimeChat | false {
    const ids = parseChatKey(key)
    const found = findRuntimeChat(key)
    if (!ids || !found || hasLiveChatWork(key)) return false
    markSqlChatDirty(ids.characterId, ids.chatId)
    return found.chat
}

const runtimeChatHydrationCache = new ChatHydrationCache({
    maxChats: 2,
    flush: flushSqlDirtyChanges,
    prepareEviction: prepareRuntimeEviction,
    isEvictionCurrent: (key, token) => findRuntimeChat(key)?.chat === token,
    isResident: key => {
        const chat = findRuntimeChat(key)?.chat
        return Boolean(chat && !chat._placeholder && Array.isArray(chat.message) && chat.messagesLoaded !== false)
    },
    onEvict: evictRuntimeChat,
})

/** Bounded counters only: no IDs or content leave the runtime cache. */
function recordHydrationResources(): void {
    const keys = runtimeChatHydrationCache.ids()
    updateRuntimeResources({ hydratedChats: keys.length })
}

function getActiveRuntimeChatKey(): string | undefined {
    const database = getDatabase() as typeof getDatabase extends () => infer T ? T & { selectedChatId?: string | null } : never
    const character = database.characters?.[get(selectedCharID)] as character | undefined
    const selected = character?.chats?.[character.chatPage ?? -1]?.id
    return selected && character?.chaId ? chatKey(character.chaId, selected) : undefined
}

/** Public safe eviction entrypoint for saver-mode/resource reclamation. */
export async function evictHydratedChats(): Promise<void> {
    await runtimeChatHydrationCache.evictExcept({ getActiveKey: getActiveRuntimeChatKey, isProtected: hasLiveChatWork })
    recordHydrationResources()
}

export async function touchHydratedChat(chaId: string, chats: Chat[], index: number): Promise<void> {
    const chatId = chats[index]?.id
    if (!chatId) return
    // Hydration has already applied and settled before this point. An eviction
    // failure must not roll back that successful fetch, so it is deliberately
    // contained here while the cache retains its previous IDs/slot.
    try {
        await runtimeChatHydrationCache.touch(chaId, chatId, {
            getActiveKey: getActiveRuntimeChatKey,
            isProtected: hasLiveChatWork,
        })
    } catch (error) {
        console.warn(`[chatStorage] unable to evict hydrated chat after ${chatKey(chaId, chatId)}`, error)
    } finally {
        recordHydrationResources()
    }
}

export function resetChatHydrationCacheForTesting(): void {
    runtimeChatHydrationCache.clear()
}

/**
 * Apply the newest bounded SQL message page to one stable chat slot.  The
 * reverse-page hydrator owns window metadata and duplicate suppression; this
 * wrapper is the single convergence point for runtime LRU touches.
 */
export async function hydrateRecentChatPage(
    chats: Chat[],
    index: number,
    chaId: string,
    limit = 40,
): Promise<Chat | null> {
    const initial = chats[index]
    if (!initial?.id) return null
    const hydrated = await ensureChatMessageWindow({ chaId, chats } as character, index, limit)
    if (!hydrated) return null
    const currentIndex = chats.findIndex(chat => chat?.id === hydrated.id)
    if (currentIndex !== -1) await touchHydratedChat(chaId, chats, currentIndex)
    return hydrated
}

/** Track in-flight hydration promises to avoid duplicate fetches */
const hydrationPromises = new Map<string, Promise<Chat | null>>()

const HYDRATION_PAINT_TIMEOUT_MS = 250

function waitForHydrationPaint(): Promise<void> {
    return new Promise(resolve => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const finish = () => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            resolve()
        }
        timeout = setTimeout(finish, HYDRATION_PAINT_TIMEOUT_MS)
        requestAnimationFrame(finish)
    })
}

// ── Server fetch/save ───────────────────────────────────────────────────────

export async function fetchChatFromServer(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
    const storage = forageStorage.realStorage
    return storage.fetchChatContent(chaId, chatIndex, chatId)
}

/**
 * Write a chat to the server's own copy, which is the authoritative history.
 *
 * Guarded at the choke point rather than at each caller. `chat.message` is a
 * window: hydration makes the newest page resident and residency trimming can
 * release either end, so an in-memory chat is routinely a slice of itself.
 * Writing a slice here replaces the server's full history with it -- silently,
 * because saveChatContent has no way to tell a shortened chat from an edited
 * one. Callers that persist a chat as a side effect of something else (a
 * find/replace across a conversation, a wiki reboot recording progress) have no
 * reason to think about windowing, and two of them did not.
 *
 * Refusing is the safe direction: the caller's edit is still in memory and the
 * server still holds the history it had.
 */
export async function saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
    if (isChatHistoryIncomplete(chat)) {
        throw new Error(
            `Refusing to save chat ${chatId}: only part of its history is loaded, so writing it ` +
            "would replace the server's full copy with a slice. Load the whole chat first.",
        )
    }
    const storage = forageStorage.realStorage
    await storage.saveChatContent(chaId, chatIndex, chatId, chat)
}

// ── Hydration ───────────────────────────────────────────────────────────────

/**
 * Check if a specific chat is currently being hydrated (for dirty tracking suppression).
 */
export function isHydrating(chaId: string, chatId: string): boolean {
    const key = chatKey(chaId, chatId)
    return isHydrationActive(key)
}

/**
 * True when the in-memory message array is not the canonical full history.
 *
 * Re-exported, not re-implemented: the definition lives in
 * `chatHistoryCompleteness.ts` so that it can be read by code and tests that
 * cannot import this module's dependency graph. Every existing import site
 * keeps working through here.
 */
export { isChatHistoryIncomplete }

/**
 * Hydrate a placeholder Chat in-place on the character's chats array.
 * If the slot is already a real Chat (not placeholder), returns it as-is.
 * Returns the hydrated Chat, or null if fetch failed.
 */
export async function ensureChatHydrated(
    chats: Chat[],
    index: number,
    chaId: string,
): Promise<Chat | null> {
    const slot = chats[index]
    if (!slot) return null
    const activeSql = getActiveSqlStorage()
    const usingServerSql = activeSql?.backendKind === 'server-sql'
    const needsSqlWindow = usingServerSql && (slot as Chat & { messagesLoaded?: boolean }).messagesLoaded === false
    // A chat's own settings are a separate read from its messages, and a chat
    // can need one without the other: the message window is filled on first
    // open, so a second open finds `messagesLoaded === true` and used to return
    // here -- with `localLore`, `fmIndex` and every binding still unread.
    const needsSqlDetails = usingServerSql && (slot as Chat & { detailsLoaded?: boolean }).detailsLoaded === false
    if (!slot._placeholder && !needsSqlWindow && !needsSqlDetails) {
        await touchHydratedChat(chaId, chats, index)
        return slot
    }

    const chatId = slot.id
    if (!chatId) return null
    const key = chatKey(chaId, chatId)

    // Deduplicate concurrent hydration for the same chat
    const existing = hydrationPromises.get(key)
    if (existing) return existing

    const promise = (async () => {
        beginHydration(key)
        try {
            const sqlStorage = activeSql
            if (sqlStorage?.backendKind === 'server-sql') {
                // Two independent reads, and the chat's own settings go first.
                //
                // Deliberately tolerant of its own failure: a chat whose detail
                // read fails is still readable, and `ensureChatDetailsHydrated`
                // leaves `detailsLoaded === false` behind so the dirty commit
                // refuses to write the summary over the stored row. Aborting the
                // open instead would take the conversation away from the user
                // for a fault that costs them nothing.
                try {
                    await ensureChatDetailsHydrated(chats, index, chaId)
                } catch (error) {
                    console.error(
                        `[chatStorage] could not load chat settings for ${key}; the chat opens ` +
                        'with its stored settings unread, and will not be written back until ' +
                        'they load.',
                        error,
                    )
                }
                const hydrated = await hydrateRecentChatPage(chats, index, chaId, 40)
                if (!hydrated) return null
                return hydrated
            }
            const full = await fetchChatFromServer(chaId, index, chatId)
            if (!full) {
                console.error(`[chatStorage] hydrate failed: chat not found on server (${key})`)
                return null
            }

            // Clear stale streaming flags: if the app died mid-stream after a
            // save, the server copy can carry isStreaming=true forever.
            // (setDatabase does the same for chats present at boot.)
            full.isStreaming = false
            full.activeStreamingDisplayOptimizationMode = undefined

            const currentIndex = chats.findIndex(chat => chat?.id === chatId)
            if (currentIndex === -1) {
                console.warn(`[chatStorage] hydrate skipped: chat removed before apply (${key})`)
                return null
            }

            const currentSlot = chats[currentIndex]
            if (!currentSlot?._placeholder) {
                return currentSlot
            }

            // Yield one frame before heavy DOM work, but never let a suspended
            // browser frame keep the placeholder and hydration cache forever.
            await waitForHydrationPaint()

            // Apply to memory — mark JustApplied to suppress the reactive write-back
            beginHydrationApply(key)
            chats[currentIndex] = full

            // Wait one tick so Svelte reactivity settles before allowing dirty
            // tracking. In a `finally`: a leaked apply count leaves this chat's
            // dirty marks deferred against a window that never closes, which is
            // the same silent loss as dropping them.
            try { await tick() } finally { endHydrationApply(key) }

            await touchHydratedChat(chaId, chats, currentIndex)

            // Read the slot back rather than returning `full`.
            //
            // `chats` is a `$state` array, so the assignment above stored a
            // PROXY of `full`, and a Svelte 5 proxy never writes through to its
            // target. Handing `full` back gives callers an object that is no
            // longer the one in the database: writes to it are invisible to the
            // UI, are never marked dirty, and are gone on reload.
            //
            // That is not hypothetical. `loadTogglesFromChat` mutates the chat
            // it is given, and two call sites (characters.ts and
            // globalApi.svelte.ts `changeChatTo`) pass this return value
            // straight into it; `jobRecovery.ts` carries a comment naming the
            // same failure from the field. Returning the live slot fixes every
            // caller at once instead of asking each to remember.
            return chats[currentIndex] ?? full
        } finally {
            endHydration(key)
            hydrationPromises.delete(key)
        }
    })()

    hydrationPromises.set(key, promise)
    return promise
}

/**
 * Convenience: ensure the current active chat for a character is hydrated.
 */
export async function ensureCurrentChatReady(
    chats: Chat[],
    chatPage: number,
    chaId: string,
): Promise<Chat | null> {
    return ensureChatHydrated(chats, chatPage, chaId)
}

/**
 * True when this chat object is not its own whole history, judged without the
 * runtime window.
 *
 * Export and backup work on a `structuredClone` of the database, and
 * structuredClone does not carry symbol-keyed properties -- so the hydration
 * window is simply not on those objects and `isSqlWindowPartial` answers false
 * for every one of them. Only the plain flags survive the clone, which makes
 * them the only honest signal at that point.
 *
 * Used to decide whether to fetch the full chat from the server first. Getting
 * it wrong in the false direction exports a slice as if it were the history;
 * getting it wrong in the true direction costs one fetch.
 */
export function chatNeedsServerFetch(chat: Chat | null | undefined): boolean {
    if (!chat) return false
    const runtime = chat as Chat & { messagesLoaded?: boolean; messagesFullyLoaded?: boolean }
    return chat._placeholder === true
        || runtime.messagesLoaded === false
        || runtime.messagesFullyLoaded === false
}
