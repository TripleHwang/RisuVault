import {
    conversationMessageCount,
    getSqlWindow,
    isSqlWindowPartial,
    replaceChatSlotCarryingSqlRuntimeFields,
} from "../storage/sql/sqlRuntimeWindow";

/**
 * What a plugin may see of a chat, and what it may write back, on RisuVault's
 * windowed loading.
 *
 * A chat here is a view of storage with two independent facts about it:
 *
 *  - its SETTINGS (`detailsLoaded`): `localLore`, `fmIndex`, the persona/preset
 *    bindings, the memory data and the script state live in
 *    `chat_extension_nodes` and arrive only when the chat is hydrated. A
 *    bootstrap summary carries only `name`, `note`, `folderId` and `lastDate`;
 *  - its MESSAGES: a resident window that may be missing the oldest end (a chat
 *    opens on its newest page) or the newest (residency trimming). The window
 *    is a symbol-keyed mark that `$state.snapshot` drops, so a snapshot always
 *    looks whole unless it is marked here.
 *
 * The old gate demanded both, for every chat of the character, before a plugin
 * was handed anything -- so on a long conversation a plugin that only wanted
 * to write a lorebook entry was told the chat did not exist. The split below
 * hands over a chat whose settings are here, says on the snapshot that its
 * messages are a window, and refuses only the one write that would be
 * destructive: replacing the persisted history with the resident slice.
 *
 * Lives apart from `plugins.svelte.ts` so the API surface in `apiV3` and the
 * tests can import it without the plugin loader's dependency graph.
 */

/** A chat whose own settings are resident. Its messages may be a window. */
export function isPluginChatSettingsLoaded(chat: any): boolean {
    return !!chat && chat._stub !== true && chat._placeholder !== true && chat.detailsLoaded !== false && Array.isArray(chat.message) && chat.messagesLoaded !== false
}

export function isPluginChatComplete(chat: any): boolean {
    // `detailsLoaded !== false` is the chat's own settings, and it is a separate
    // fact from its messages -- see the module comment. Reporting a summary as
    // complete is the same "partial record read as a whole one" that every
    // other flag here guards against: a plugin would see an empty `localLore`
    // and no bindings on a chat that has them, and act on that.
    return isPluginChatSettingsLoaded(chat) && chat.messagesFullyLoaded !== false && !isSqlWindowPartial(chat)
}

/** A character whose own record is resident. Its chats may be summaries. */
export function isPluginCharacterDetailsLoaded(character: any): boolean {
    return !!character && character.detailsLoaded !== false && Array.isArray(character.chats)
}

export function isPluginCharacterComplete(character: any): boolean {
    return isPluginCharacterDetailsLoaded(character) && character.chats.every(isPluginChatComplete)
}

/**
 * Keys a plugin never gets to write. `message` is the window (handled
 * separately), the rest is the host's hydration bookkeeping: plain flags that
 * survive a snapshot and would otherwise be echoed back from a stale copy,
 * and `messageTotal`, which only `markPluginChatSnapshot` puts on a snapshot.
 * A `_`-prefixed key is runtime state by convention (`_placeholder`, the
 * window as older builds wrote it, and `_pluginReadTail` below).
 */
const PLUGIN_CHAT_RUNTIME_KEYS = new Set(['message', 'messagesLoaded', 'messagesFullyLoaded', 'detailsLoaded', 'messageTotal'])

const isPluginChatRuntimeKey = (key: string) => PLUGIN_CHAT_RUNTIME_KEYS.has(key) || key.startsWith('_')

/**
 * Say on a snapshot what the live chat knows about its window, and where its
 * history ended when the snapshot was taken.
 *
 * `messagesFullyLoaded: false` is the same flag the host itself uses, so a
 * plugin that already checks it needs nothing new. `messageTotal` is the
 * persisted count when the runtime has it -- `chat.message.length` is the
 * resident count and is routinely mistaken for the conversation's.
 * `_pluginReadTail` is for the write-back only: it lets
 * `writePluginChatToSlot` tell a copy the user has sent past from one the
 * plugin shortened on purpose. Both marks are stripped before anything lands
 * on the live chat.
 */
export function markPluginChatSnapshot<T extends { message?: unknown }>(live: any, snapshot: T): T {
    if (!snapshot || typeof snapshot !== 'object') return snapshot
    if (live?.messagesFullyLoaded === false || isSqlWindowPartial(live)) {
        (snapshot as any).messagesFullyLoaded = false
        if (getSqlWindow(live)) (snapshot as any).messageTotal = conversationMessageCount(live)
    }
    if (Array.isArray(live?.message)) (snapshot as any)._pluginReadTail = tailIdOf(live.message)
    return snapshot
}

/** Mark every chat of a character snapshot the way `markPluginChatSnapshot` does. */
export function markPluginCharacterSnapshot<T extends { chats?: unknown }>(live: any, snapshot: T): T {
    const chats = (snapshot as any)?.chats
    if (!Array.isArray(chats) || !Array.isArray(live?.chats)) return snapshot
    chats.forEach((chat, index) => markPluginChatSnapshot(live.chats[index], chat))
    return snapshot
}

export const PLUGIN_PARTIAL_HISTORY_WRITE_ERROR = 'Chat history is partially loaded; message edits from plugins are not accepted'
export const PLUGIN_CHAT_IDENTITY_ERROR = 'The chat at this index is not the chat the plugin read; the write was refused'

const chatIdOf = (chat: any): string | undefined =>
    typeof chat?.id === 'string' && chat.id.length > 0 ? chat.id : undefined

/**
 * Make `incoming` name the chat that is in the slot, or refuse it.
 *
 * A plugin addresses a chat by index, and an index is not stable: a chat
 * created while the plugin awaited something shifts every sibling by one, so
 * the copy of chat X comes back to a slot that now holds chat Y. Installing
 * it there overwrites Y in memory, and the idle audit then reads Y's absence
 * as a deletion and drops its row -- and, through the cascade, every message
 * under it. A copy with no id at all is the quieter version of the same loss:
 * `normalizeChat` would mint a fresh id and the original would vanish the
 * same way.
 *
 * Call it BEFORE `normalizeChat`, which is what turns "no id" into "a new id".
 */
export function pinPluginChatIdentity<T extends { id?: unknown }>(live: any, incoming: T): T {
    const liveId = chatIdOf(live)
    if (!liveId) return incoming
    const incomingId = chatIdOf(incoming)
    if (incomingId && incomingId !== liveId) throw new Error(PLUGIN_CHAT_IDENTITY_ERROR)
    incoming.id = liveId
    return incoming
}

const messageIds = (messages: unknown): (string | undefined)[] =>
    Array.isArray(messages) ? messages.map((message) => message?.chatId) : []

/** The id of the newest resident message, or `''` for an empty history. */
function tailIdOf(messages: unknown): string {
    const ids = messageIds(messages)
    const tail = ids[ids.length - 1]
    return typeof tail === 'string' ? tail : ''
}

/**
 * Where `needle` sits inside `haystack` as one contiguous run, or -1. An
 * empty needle is a run at the start of anything.
 */
function contiguousRunAt(needle: (string | undefined)[], haystack: (string | undefined)[]): number {
    if (needle.length > haystack.length) return -1
    for (let start = 0; start + needle.length <= haystack.length; start++) {
        let matched = true
        for (let offset = 0; offset < needle.length; offset++) {
            if (haystack[start + offset] !== needle[offset]) { matched = false; break }
        }
        if (matched) return start
    }
    return -1
}

/**
 * Whether a copy taken from a window still describes the live array.
 *
 * Ids and order only, never content: a plugin's message edits are not
 * applied to a window (the live array is kept), so what is asked is whether
 * the copy is the window it was handed, or the window as it was then. Between
 * the read and the write the host may have paged older messages in ahead of
 * it or appended a reply behind it; either leaves the copy as one contiguous
 * run of the live ids, and that run is accepted. A message the plugin added,
 * an id the live array no longer holds, or a reordering is a rewrite it
 * evidently meant, and is refused rather than silently swallowed.
 */
const windowCopyMatchesLive = (live: unknown, incoming: unknown): boolean =>
    contiguousRunAt(messageIds(incoming), messageIds(live)) >= 0

/**
 * A copy of a whole chat that the host has appended to since the plugin read
 * it, and whose tail the plugin left alone.
 *
 * "Since it was read" is what `_pluginReadTail` on the snapshot is for: the
 * id of the newest resident message at read time. Without it a copy that is
 * one message shorter than the slot is ambiguous -- a reply the user sent
 * meanwhile, or a plugin that deliberately dropped the last message -- and
 * the two call for opposite writes. With it: the live tail moved on, the
 * copy's tail is still the one that was read, and the copy's ids lead the
 * live ones. A copy that ends elsewhere edited its tail on purpose and keeps
 * the wholesale write plugins have always had.
 */
function hostAppendedSinceRead(live: any, incoming: any): boolean {
    const readTail = incoming?._pluginReadTail
    if (typeof readTail !== 'string') return false
    if (tailIdOf(live?.message) === readTail || tailIdOf(incoming?.message) !== readTail) return false
    return contiguousRunAt(messageIds(incoming?.message), messageIds(live?.message)) === 0
}

/**
 * Put a plugin's copy of a chat back into `chats[index]` and return the object
 * that is then in the slot.
 *
 * The caller has already normalized `incoming`, with the id pinned to the
 * slot's (`pinPluginChatIdentity`); it is pinned again here so a caller that
 * skipped that step is refused rather than trusted.
 *
 * Which path a write takes is decided from both sides. The live chat says
 * whether its history is whole NOW; the copy says, through the marks
 * `markPluginChatSnapshot` put on it, what it was WHEN IT WAS READ:
 *
 *  - a copy that was a window (`messagesFullyLoaded: false`) is merged even
 *    when the live chat has since become whole. The user scrolled and the
 *    older page arrived while the plugin was busy; installing the stale slice
 *    would drop the resident history and leave a window that says nothing is
 *    older;
 *  - a copy the host has appended to since it was read (the user sent while
 *    the plugin awaited a model) keeps the live array. The copy predates a
 *    message the user typed, and installed over it would remove that message
 *    from memory before it was ever persisted.
 *
 * Otherwise a chat whose whole history is resident gets the wholesale
 * replacement plugins have always had, now carrying the SQL runtime marks so
 * an appended message stays persistable.
 *
 * On the merge path every field but the message array is applied and the
 * live array stays -- the binding or `localLore` write the plugin came for
 * succeeds, and the history on disk is never replaced by the resident slice.
 * A message array that is not a run of the live one is refused, before
 * anything is written.
 *
 * Throws for a chat whose settings are not resident: applying fields over a
 * summary would write an empty lorebook over one that exists in storage.
 */
export function writePluginChatToSlot<T extends { message?: unknown }>(chats: T[], index: number, incoming: T): T {
    const live: any = chats[index]
    if (!isPluginChatSettingsLoaded(live)) throw new Error('Chat history is still loading')
    pinPluginChatIdentity(live, incoming as any)
    const keepLiveMessages = (incoming as any).messagesFullyLoaded === false
        || !isPluginChatComplete(live)
        || hostAppendedSinceRead(live, incoming)
    delete (incoming as any).messageTotal
    delete (incoming as any)._pluginReadTail
    if (!keepLiveMessages) {
        return replaceChatSlotCarryingSqlRuntimeFields(chats, index, incoming)
    }
    if (!windowCopyMatchesLive(live.message, incoming.message)) {
        throw new Error(PLUGIN_PARTIAL_HISTORY_WRITE_ERROR)
    }
    const merged: any = {}
    for (const [key, value] of Object.entries(incoming)) {
        if (!isPluginChatRuntimeKey(key)) merged[key] = value
    }
    for (const key of Object.keys(live)) {
        if (isPluginChatRuntimeKey(key)) merged[key] = live[key]
    }
    return replaceChatSlotCarryingSqlRuntimeFields(chats, index, merged as T)
}
