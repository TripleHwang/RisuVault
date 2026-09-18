import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DirtySnapshot } from './dirtyRegistry'
import type { ISqlStorage } from './ISqlStorage'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import {
    clearDeferredRootKey,
    deferredRootDeleteRefusals,
    deferredRootKeySnapshot,
    isRootKeyDeferred,
    markRootKeyDeferred,
    markRootKeysDeferred,
    resetDeferredRootKeys,
} from './deferredRootKeys'
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    rebaselineHydratedRootKey,
    resetSqlPersistenceRuntimeForTesting,
} from './sqlPersistenceRuntime'

const cleanDirty = (): DirtySnapshot => ({
    rootKeys: [], characterIds: [], chats: [], messages: [],
    messageDeletes: [], pluginStorageKeys: [], presetIds: [],
})

function fixtureDatabase(extra: Record<string, unknown> = {}) {
    return { characters: [], botPresets: [], pluginCustomStorage: {}, ...extra } as any
}

function fakeStorageAtRevision(revision: number): ISqlStorage {
    return {
        getRevision: vi.fn(() => revision),
        commit: vi.fn(async () => ({ revision: revision + 1 })),
    } as unknown as ISqlStorage
}

function pluginStorageUpsertsOf(storage: ISqlStorage): { key: string; value: unknown }[] {
    return (storage.commit as any).mock.calls.flatMap(([commit]: [any]) => commit.pluginStorage?.upserts ?? [])
}

function rootDeletesOf(storage: ISqlStorage): string[] {
    return (storage.commit as any).mock.calls.flatMap(([commit]: [any]) => commit.root?.deletes ?? [])
}

afterEach(() => {
    resetSqlPersistenceRuntimeForTesting()
    resetDeferredRootKeys()
    vi.restoreAllMocks()
})

describe('deferred root key registry', () => {
    it('is a plain module-level structure, not $state (mutations are observed synchronously)', () => {
        markRootKeysDeferred(['plugins', 'botPresets'])
        expect(deferredRootKeySnapshot()).toEqual(['botPresets', 'plugins'])
        expect(isRootKeyDeferred('plugins')).toBe(true)

        clearDeferredRootKey('plugins')
        expect(isRootKeyDeferred('plugins')).toBe(false)
        expect(deferredRootKeySnapshot()).toEqual(['botPresets'])

        resetDeferredRootKeys()
        expect(deferredRootKeySnapshot()).toEqual([])
    })

    it('ignores empty keys instead of registering a blank entry', () => {
        markRootKeysDeferred(['', 'plugins'])
        markRootKeyDeferred('')
        expect(deferredRootKeySnapshot()).toEqual(['plugins'])
    })
})

describe('buildSqlDirtyCommit refuses to delete an unloaded root key', () => {
    it('still deletes a genuinely absent, non-deferred root key', () => {
        const dirty = cleanDirty()
        dirty.rootKeys = ['plugins']

        const commit = buildSqlDirtyCommit(fixtureDatabase(), dirty, 7)

        expect(commit.root.deletes).toEqual(['plugins'])
        expect(deferredRootDeleteRefusals()).toEqual([])
    })

    it('produces no delete for a deferred root key, and reports the refusal loudly', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        markRootKeyDeferred('plugins')
        const dirty = cleanDirty()
        dirty.rootKeys = ['plugins']

        const commit = buildSqlDirtyCommit(fixtureDatabase(), dirty, 7)

        expect(commit.root.deletes).toEqual([])
        expect(commit.root.upserts).toEqual([])
        expect(deferredRootDeleteRefusals()).toEqual([{ key: 'plugins', origin: 'buildSqlDirtyCommit' }])
        expect(consoleError).toHaveBeenCalledTimes(1)
        expect(consoleError.mock.calls[0][0]).toContain('plugins')
        expect(consoleError.mock.calls[0][0]).toContain('[SQL deferred root guard]')
    })

    it('commits every other dirty root key in the same batch as the refused one', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        markRootKeyDeferred('plugins')
        const dirty = cleanDirty()
        dirty.rootKeys = ['plugins', 'username', 'gone']

        const commit = buildSqlDirtyCommit(fixtureDatabase({ username: 'anon' }), dirty, 7)

        expect(commit.root.upserts).toEqual([{ key: 'username', value: 'anon' }])
        expect(commit.root.deletes).toEqual(['gone'])
    })

    it('upserts a deferred key normally once its real value has loaded', () => {
        markRootKeyDeferred('plugins')
        clearDeferredRootKey('plugins')
        const dirty = cleanDirty()
        dirty.rootKeys = ['plugins']

        const commit = buildSqlDirtyCommit(fixtureDatabase({ plugins: [{ name: 'p' }] }), dirty, 7)

        expect(commit.root.upserts).toEqual([{ key: 'plugins', value: [{ name: 'p' }] }])
        expect(commit.root.deletes).toEqual([])
    })
})

describe('the compatibility audit does not treat an unloaded root key as changed', () => {
    it('commits a DELETE for a root key that a loaded database genuinely lost', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabase({ plugins: [{ name: 'my-plugin' }] })
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        delete database.plugins
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(rootDeletesOf(storage)).toEqual(['plugins'])
    })

    it('never marks a deferred root key dirty, so no DELETE is ever built for it', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabase({ plugins: [{ name: 'my-plugin' }] })
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        // Re-bootstrap defers the key: it exists in storage, it is dropped from memory.
        markRootKeyDeferred('plugins')
        delete database.plugins
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(rootDeletesOf(storage)).toEqual([])
        // The commit builder's backstop was never even reached.
        expect(deferredRootDeleteRefusals()).toEqual([])
        expect(consoleError).not.toHaveBeenCalled()
    })

    it('does not baseline a deferred key, and marks it dirty as an upsert once it loads', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabase()
        markRootKeyDeferred('plugins')
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        database.plugins = [{ name: 'my-plugin' }]
        clearDeferredRootKey('plugins')
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            root: expect.objectContaining({
                upserts: [{ key: 'plugins', value: [{ name: 'my-plugin' }] }],
                deletes: [],
            }),
        }))
    })
})

describe('the unknown -> known transition does not swallow writes', () => {
    // auditSqlCompatibilityDatabase adopts the new snapshot as the baseline
    // before deciding what to diff, and skips a scope whose two snapshots
    // disagree about whether the value was known. Without a re-baseline at load
    // time those combine into silent write loss: the freshly loaded value is
    // adopted as the baseline having never been diffed, so anything written
    // between the load and the next audit looks identical to what storage held.
    const loadDeferred = (database: any, value: Record<string, unknown>) => {
        database.pluginCustomStorage = value
        clearDeferredRootKey('pluginCustomStorage')
        rebaselineHydratedRootKey(database, 'pluginCustomStorage')
    }

    it('persists a value written right after the load', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabase()
        delete database.pluginCustomStorage
        markRootKeyDeferred('pluginCustomStorage')
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        loadDeferred(database, { 'plugin.config': { provider: 'google' } })
        // A plugin edits its own storage as soon as it loads.
        database.pluginCustomStorage['plugin.config'] = { provider: 'anthropic' }

        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(pluginStorageUpsertsOf(storage)).toEqual([
            { key: 'plugin.config', value: { provider: 'anthropic' } },
        ])
    })

    it('writes nothing back when the loaded value is left untouched', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabase()
        delete database.pluginCustomStorage
        markRootKeyDeferred('pluginCustomStorage')
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        loadDeferred(database, { 'plugin.config': { provider: 'google' } })

        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(pluginStorageUpsertsOf(storage)).toEqual([])
    })
})
