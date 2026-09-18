import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage } from './ISqlStorage'
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply } from '../hydrationState'
import { SqlRevisionConflictError } from './sqlCommit'
import { setSqlPosition, setSqlWindow } from './sqlRuntimeWindow'
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    isSqlMessageDirty,
    markSqlMessageDirty,
    startSqlMetadataPersistence,
    startSqlCompatibilityAuditLoop,
    resetSqlPersistenceRuntimeForTesting,
    scheduleSqlCompatibilityAudit,
    onSqlCommitActivity,
} from './sqlPersistenceRuntime'

function fixtureDatabaseWithMessages(count: number) {
    return {
        characters: [{ chaId: 'character-a', chats: [{ id: 'chat-a', message: Array.from({ length: count }, (_, position) => ({
            chatId: `m-${position}`, role: 'char', data: `message-${position}`,
        })) }] }],
        botPresets: [], pluginCustomStorage: {},
    } as any
}

function fakeStorageAtRevision(revision: number): ISqlStorage {
    return {
        getRevision: vi.fn(() => revision),
        commit: vi.fn(async () => ({ revision: revision + 1 })),
    } as unknown as ISqlStorage
}

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('SQL persistence runtime', () => {
    it('commits a marked message without a full database clone', async () => {
        const storage = fakeStorageAtRevision(3)
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(20_000))

        markSqlMessageDirty('chat-a', 'm-19999')
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            baseRevision: 3,
            messages: [expect.objectContaining({ id: 'm-19999', chatId: 'chat-a', position: 19_999 })],
        }))
    })

    it('schedules, rather than immediately runs, compatibility audit', () => {
        const audit = vi.fn()
        scheduleSqlCompatibilityAudit(audit)
        expect(audit).not.toHaveBeenCalled()
    })

    it('retains dirty scopes when an unload flush rejects', async () => {
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new Error('offline'))
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        markSqlMessageDirty('chat-a', 'm-0')

        await expect(flushSqlDirtyChanges()).rejects.toThrow('offline')
        ;(storage.commit as any).mockResolvedValueOnce({ revision: 4 })
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledTimes(2)
    })

    it('retries a rejected dirty flush once after the bounded backoff', async () => {
        vi.useFakeTimers()
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ revision: 4 })
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        markSqlMessageDirty('chat-a', 'm-0')
        await expect(flushSqlDirtyChanges()).rejects.toThrow('offline')
        await vi.advanceTimersByTimeAsync(5_000)
        expect(storage.commit).toHaveBeenCalledTimes(2)
    })

    it('installs one metadata lifecycle runtime without doing a legacy save', () => {
        const add = vi.fn()
        const keepalive = vi.fn()
        startSqlMetadataPersistence({ addEventListener: add } as any, keepalive)
        startSqlMetadataPersistence({ addEventListener: add } as any, keepalive)
        expect(add).toHaveBeenCalledTimes(2)
        expect(keepalive).not.toHaveBeenCalled()
    })

    /**
     * This used to assert the opposite, and it is why the loss below survived
     * 2900 tests: it opened `beginHydration` -- the flag that spans a whole page
     * REQUEST -- and required the mark to be discarded. During a request
     * hydration has not written anything into the chat, so the only marks in
     * that window belong to the user. A reply that arrived while an older page
     * was being fetched lost its mark, never reached a commit, and was gone
     * after a reload with nothing logged.
     */
    it('marks a message edited while a page request is in the air', async () => {
        const storage = fakeStorageAtRevision(3)
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        beginHydration('character-a/chat-a')
        markSqlMessageDirty('chat-a', 'm-0', true)
        await flushSqlDirtyChanges()
        endHydration('character-a/chat-a')
        expect(storage.commit).toHaveBeenCalledTimes(1)
    })

    /**
     * The apply window is the real one: hydration is writing the fetched page
     * into the live chat, and a mark made there could be hydration's own write
     * being read back. It is parked rather than dropped -- nothing in hydration
     * marks anything, so the mark still belongs to somebody -- and it runs the
     * moment the apply closes.
     */
    it('defers a mark made mid-apply and commits it once the apply ends', async () => {
        const storage = fakeStorageAtRevision(3)
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        beginHydrationApply('character-a/chat-a')
        markSqlMessageDirty('chat-a', 'm-0', true)
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()

        endHydrationApply('character-a/chat-a')
        await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledTimes(1)
    })

    /**
     * One chat's apply window must not park another chat's mark.
     *
     * A parked mark is invisible to `isSqlMessageDirty`, and that predicate is
     * what residency trimming and `loadNewestChatMessages` ask before releasing
     * a message from memory. A mark hidden there is an edit released and never
     * written -- the same silent loss, arrived at from the other side. Which
     * means the deferral has to be gated per chat and not on "is any hydration
     * applying"; a global gate passes every test above and loses data here.
     */
    it('leaves a mark for another chat visible while one chat is mid-apply', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(1)
        database.characters[0].chats.push({ id: 'chat-b', message: [{ chatId: 'b-0', role: 'char', data: 'b' }] })
        activateSqlPersistenceRuntime(storage, database)

        beginHydrationApply('character-a/chat-a')
        // `finally`, because the apply counters live in a module-level map that
        // no `afterEach` here clears: a count leaked by a failing assertion
        // parks every later test's marks and reports this one defect as seven.
        try {
            markSqlMessageDirty('chat-b', 'b-0', true)

            expect(isSqlMessageDirty('chat-b', 'b-0')).toBe(true)
            expect(isSqlMessageDirty('chat-a', 'm-0')).toBe(false)

            await flushSqlDirtyChanges()
            expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
                messages: [expect.objectContaining({ id: 'b-0', chatId: 'chat-b' })],
            }))
        } finally {
            endHydrationApply('character-a/chat-a')
        }
    })

    /**
     * One message with no canonical position must not stop every other chat
     * from being written.
     *
     * `commitDirtyScopes` builds its commit outside the try, so a build that
     * threw aborted the whole transaction -- not just the offending row, not
     * just its chat, but every pending edit in the application. The 5s retry
     * then rebuilt the same snapshot and threw again, every five seconds, for
     * the rest of the session, reporting nothing but a console line. That is
     * the same silent total data loss as the dropped dirty mark, reached from
     * the other end, and it was live in the tree.
     */
    it('commits every other chat when one message has no canonical position', async () => {
        const storage = fakeStorageAtRevision(3)
        // A partial window (`messagesFullyLoaded: false`) with no SQL window at
        // all, so `allocateAppendedPositions` has no `nextPosition` to hand out
        // and the row can never be positioned.
        const broken = {
            id: 'chat-broken', messagesLoaded: true, messagesFullyLoaded: false,
            message: [{ chatId: 'orphan', role: 'char', data: 'no position' }],
        }
        const database = fixtureDatabaseWithMessages(1)
        database.characters[0].chats.push(broken)
        activateSqlPersistenceRuntime(storage, database)

        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        markSqlMessageDirty('chat-broken', 'orphan')
        markSqlMessageDirty('chat-a', 'm-0')
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            messages: [expect.objectContaining({ id: 'm-0', chatId: 'chat-a' })],
        }))
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('chat-broken/orphan'),
            expect.anything(),
        )
        error.mockRestore()

        // Refused is not written, and refused is not forgotten: the row stays
        // dirty, which is also what stops residency trimming releasing it.
        expect(isSqlMessageDirty('chat-broken', 'orphan')).toBe(true)
        expect(isSqlMessageDirty('chat-a', 'm-0')).toBe(false)

        // And it really is retried, not merely remembered: give the row the
        // position it was missing and the next ordinary flush writes it. This
        // also drains the mark, which matters -- the dirty registry is module
        // state that `resetSqlPersistenceRuntimeForTesting` does not clear, so
        // a test that leaves one behind leaves it for every test after it.
        setSqlPosition(broken.message[0], 5)
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenLastCalledWith(expect.objectContaining({
            messages: [expect.objectContaining({ id: 'orphan', chatId: 'chat-broken', position: 5 })],
        }))
        expect(isSqlMessageDirty('chat-broken', 'orphan')).toBe(false)
    })

    it('retries a conflict without replacing the dirty local append', async () => {
        const database = fixtureDatabaseWithMessages(1)
        database.characters[0].chats[0].message.push({ chatId: 'm-local', role: 'char', data: 'local' })
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new SqlRevisionConflictError(4)).mockResolvedValueOnce({ revision: 5 })
        ;(storage.loadChatMessages as any) = vi.fn(async () => [{ chatId: 'm-0', role: 'char', data: 'remote' }])
        ;(storage.loadChat as any) = vi.fn(async () => null)
        activateSqlPersistenceRuntime(storage, database)
        markSqlMessageDirty('chat-a', 'm-local')

        await flushSqlDirtyChanges()

        expect(database.characters[0].chats[0].message.at(-1)).toMatchObject({ chatId: 'm-local', data: 'local' })
        expect((storage.commit as any).mock.calls[1][0].messages).toEqual([expect.objectContaining({ id: 'm-local' })])
    })

    it('treats a missing remote entity as resolved while retaining a local delete', async () => {
        const database = fixtureDatabaseWithMessages(0); database.characters = []
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new SqlRevisionConflictError(4)).mockResolvedValueOnce({ revision: 5 })
        ;(storage.loadCharacter as any) = vi.fn(async () => null)
        activateSqlPersistenceRuntime(storage, database)
        const { markSqlCharacterDirty } = await import('./sqlPersistenceRuntime')
        markSqlCharacterDirty('character-a')
        await flushSqlDirtyChanges()
        expect((storage.commit as any).mock.calls[1][0].characterDeletes).toEqual(['character-a'])
    })

    it('uses the first compatibility audit as a baseline and writes only a changed root', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(0)
        database.theme = 'dark'
        activateSqlPersistenceRuntime(storage, database)
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        database.theme = 'light'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ root: { upserts: [{ key: 'theme', value: 'light' }], deletes: [] } }))
    })

    it('detects an edit made before the first idle compatibility audit', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(0)
        database.theme = 'dark'; activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        database.theme = 'light'; auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ root: { upserts: [{ key: 'theme', value: 'light' }], deletes: [] } }))
    })

    it('owns one cancelable compatibility recurrence across repeated startup', async () => {
        vi.useFakeTimers()
        const audit = vi.fn()
        startSqlCompatibilityAuditLoop(audit)
        startSqlCompatibilityAuditLoop(audit)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(audit).toHaveBeenCalledTimes(1)
        resetSqlPersistenceRuntimeForTesting()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(audit).toHaveBeenCalledTimes(1)
    })

    it('detects an idle-only raw plugin message edit and preserves its row id', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(1)
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats[0].message[0].data = 'plugin edit'
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ id: 'm-0', data: expect.objectContaining({ data: 'plugin edit' }) })] }))
    })

    it('does not write an unsafe middle insertion in an incomplete resident history', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(2)
        database.characters[0].chats[0].messagesFullyLoaded = false
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats[0].message.splice(1, 0, { chatId: 'm-middle', role: 'char', data: 'unsafe' })
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        database.characters[0].chats[0].messagesFullyLoaded = true
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        // Every row at its new position, and nothing that could delete a row
        // this tab does not hold: the reorder used to ride on a manifest.
        const [commit] = (storage.commit as any).mock.calls[0]
        expect(commit.messages.map(({ id, position }: any) => [id, position]).sort()).toEqual([
            ['m-0', 0], ['m-1', 2], ['m-middle', 1],
        ])
        expect(commit.messageManifests).toEqual([])
    })

    it('never builds a manifest for a chat another device may have appended to', async () => {
        // The multi-device loss: a phone wrote m-2 after this tab loaded the
        // chat, so this tab's copy ends at m-1. Removing m-0 here must delete
        // m-0 alone. A manifest of this tab's ids would also have deleted m-2.
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(2)
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats[0].message.splice(0, 1)
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        const [commit] = (storage.commit as any).mock.calls[0]
        expect(commit.messageManifests).toEqual([])
        expect(commit.chatManifests).toEqual([])
        expect(commit.messageDeletes).toEqual([{ chatId: 'chat-a', ids: ['m-0'] }])
    })

    it('deletes a chat removed in this tab by id, never by a manifest of the survivors', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(0)
        database.characters[0].chats.push({ id: 'chat-b', message: [] })
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats.splice(0, 1)
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        const [commit] = (storage.commit as any).mock.calls[0]
        expect(commit.chatDeletes).toEqual([{ characterId: 'character-a', id: 'chat-a' }])
        expect(commit.chatManifests).toEqual([])
    })
})

describe('an unloaded chat is not a chat whose messages were deleted', () => {
    // SQL windowing makes chat.message a slice, and eviction (chatStorage.ts:300)
    // drops it entirely while setting messagesFullyLoaded false. The idle audit
    // used to read that as the user having deleted every message in the chat and
    // issued a delete for each -- against rows still on disk.
    const messageDeletesOf = (storage: ISqlStorage): string[] =>
        (storage.commit as any).mock.calls.flatMap(([commit]: [any]) =>
            (commit.messageDeletes ?? []).flatMap((entry: any) => entry.ids as string[]))

    it('issues no deletes when a windowed chat is evicted', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(40)
        const chat = database.characters[0].chats[0]
        chat.messagesFullyLoaded = false
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        // Eviction: the array is emptied and the chat is marked not fully loaded.
        chat.message = []
        chat.messagesLoaded = false
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(messageDeletesOf(storage)).toEqual([])
    })

    it('still deletes a message removed from a fully loaded chat', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(3)
        const chat = database.characters[0].chats[0]
        chat.messagesFullyLoaded = true
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        chat.message.splice(1, 1)
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(messageDeletesOf(storage)).toEqual(['m-1'])
    })
})

/**
 * The idle audit is the second chance a dropped dirty mark depends on: it
 * diffs the live graph every few seconds and re-marks anything it finds
 * changed. It used to lose that ability permanently the first time a reader
 * scrolled back in a chat.
 */
describe('the idle audit over a chat that has been scrolled back', () => {
    /** A partial window, as `loadOlderChatMessages` leaves one. */
    function windowedChat(count: number, startPosition: number) {
        const chat: any = {
            id: 'chat-a', message: [], messagesLoaded: true, messagesFullyLoaded: false,
        }
        for (let index = 0; index < count; index += 1) {
            const message = { chatId: `m-${startPosition + index}`, role: 'char', data: `d${startPosition + index}` }
            setSqlPosition(message, startPosition + index)
            chat.message.push(message)
        }
        setSqlWindow(chat, {
            before: null, nextBefore: startPosition, total: 100, hasOlder: true,
            hasNewer: false, nextAfter: null, nextPosition: 100,
        })
        return {
            characters: [{ chaId: 'character-a', chats: [chat] }],
            botPresets: [], pluginCustomStorage: {},
        } as any
    }

    /** What `loadOlderChatMessages` does: splice an older page onto the front. */
    function prependOlderPage(chat: any, from: number, to: number): void {
        const older: any[] = []
        for (let position = from; position < to; position += 1) {
            const message = { chatId: `m-${position}`, role: 'char', data: `d${position}` }
            setSqlPosition(message, position)
            older.push(message)
        }
        chat.message.splice(0, 0, ...older)
    }

    it('still notices an appended message after an older page was prepended', () => {
        const storage = fakeStorageAtRevision(3)
        const database = windowedChat(20, 80)
        const chat = database.characters[0].chats[0]
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        prependOlderPage(chat, 60, 80)
        chat.message.push({ chatId: 'reply', role: 'char', data: 'the reply' })

        auditSqlCompatibilityDatabase(database)

        expect(isSqlMessageDirty('chat-a', 'reply')).toBe(true)
    })

    it('adopts the prepended page as the baseline instead of pinning to the old one', () => {
        const storage = fakeStorageAtRevision(3)
        const database = windowedChat(20, 80)
        const chat = database.characters[0].chats[0]
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        prependOlderPage(chat, 60, 80)
        auditSqlCompatibilityDatabase(database)

        // The baseline used to be pinned to the pre-scroll snapshot, so this
        // second audit compared against it again and failed the same way, for
        // the rest of the session.
        chat.message.push({ chatId: 'reply', role: 'char', data: 'the reply' })
        auditSqlCompatibilityDatabase(database)

        expect(isSqlMessageDirty('chat-a', 'reply')).toBe(true)
    })

    /**
     * The other half of the guard, and the half nothing covered: the shared ids
     * themselves changing order. Widening the rule to let prepends through must
     * not also let a reorder through.
     *
     * What the deferral withholds is the *order*, not the row edits -- the
     * branch deliberately still marks a changed row dirty, because a row's
     * canonical position is attached to the message and does not move when the
     * array does. So the observable difference is the decision itself: the chat
     * is declared unreconcilable, warned about, and its baseline held for a
     * later full hydration to settle. Assert that, because asserting the marks
     * would pass either way and prove nothing.
     */
    it('still declares a reorder of known ids unreconcilable', () => {
        const storage = fakeStorageAtRevision(3)
        const database = windowedChat(20, 80)
        const chat = database.characters[0].chats[0]
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const [moved] = chat.message.splice(5, 1)
        chat.message.splice(12, 0, moved)
        auditSqlCompatibilityDatabase(database)

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsafe middle message insertion/reorder in partial chat chat-a'))

        // Held, not adopted: a second audit that changes nothing further still
        // sees the same disagreement against the pre-reorder baseline.
        warn.mockClear()
        auditSqlCompatibilityDatabase(database)
        expect(warn).toHaveBeenCalledTimes(1)
        warn.mockRestore()
    })

    it('still refuses a message inserted between two known ones in a partial window', () => {
        const storage = fakeStorageAtRevision(3)
        const database = windowedChat(20, 80)
        const chat = database.characters[0].chats[0]
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        chat.message.splice(10, 0, { chatId: 'wedged', role: 'char', data: 'wedged' })
        auditSqlCompatibilityDatabase(database)
        warn.mockRestore()

        expect(isSqlMessageDirty('chat-a', 'wedged')).toBe(false)
    })
})

describe('the saving indicator in SQL mode', () => {
    it('reports a commit as active while it runs and inactive once it lands', async () => {
        const states: boolean[] = []
        let release: (() => void) | null = null
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockImplementation(
            () => new Promise<void>((resolve) => { release = () => resolve() }),
        )
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(2))
        onSqlCommitActivity((active) => states.push(active))

        markSqlMessageDirty('chat-a', 'm-1')
        const flushed = flushSqlDirtyChanges()
        await Promise.resolve()
        await Promise.resolve()
        // `saveDb` drove this indicator and the SQL path never calls it, so
        // without a writer here the screen says nothing whether saving works or
        // not -- and this path has already shipped a save that failed in silence.
        expect(states).toEqual([true])

        release?.()
        await flushed
        expect(states).toEqual([true, false])
    })
})

describe('the audit-then-flush pair requestImmediateSave is wired to in SQL mode', () => {
    it('commits a mutation that has not been marked dirty by anything else yet', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(2)
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        // What every `requestImmediateSave` call site does: mutate, then ask to
        // be saved now. `saveDb` assigns that function and never runs in this
        // mode, so it stayed a no-op and none of the sixty-three call sites
        // saved anything; the ones that await it and then act were acting on a
        // save that had not happened.
        database.username = 'renamed right now'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect((storage.commit as any).mock.calls[0][0].root.upserts)
            .toContainEqual(expect.objectContaining({ key: 'username', value: 'renamed right now' }))
    })
})
