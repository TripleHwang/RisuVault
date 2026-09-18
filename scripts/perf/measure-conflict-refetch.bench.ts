/**
 * What one revision conflict costs.
 *
 * On a 409 `sendStatements` drops `bootstrapPayload`, and `rebaseDirtyScopes`
 * then issues a targeted read per dirty scope. Several of those reads are
 * `this.current()`, which is `loadDatabase({ shallow: true })` -- the whole
 * bootstrap. This measures how many full bootstrap FETCHES one conflict costs,
 * and what the reads that hit the cached payload cost instead, because
 * `loadDatabase` rebuilds the entire `Database` from the payload on every call
 * whether it fetched or not.
 *
 * Run with: npx vitest run --config vitest.config.perf.ts
 */
import { afterEach, describe, it } from 'vitest'

import { NodeSqliteStorage } from '../../src/ts/storage/sql/nodeSqliteStorage'
import {
    activateSqlPersistenceRuntime,
    flushSqlDirtyChanges,
    markSqlCharacterDirty,
    markSqlChatDirty,
    markSqlMessageDirty,
    markSqlPluginStorageDirty,
    markSqlPresetDirty,
    markSqlRootDirty,
    resetSqlPersistenceRuntimeForTesting,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import { resetDeferredRootKeys } from '../../src/ts/storage/sql/deferredRootKeys'
import { buildKoreanDatabase, SHAPES } from './koreanFixture'

const STRUCTURAL = new Set(['characters', 'botPresets', 'botPresetsId', 'pluginCustomStorage'])

/**
 * Buffered, then written once per test. Vitest reorders interleaved writes
 * from different tests, which is exactly how a number ends up filed under the
 * wrong scenario.
 */
let pending: string[] = []
function row(label: string, value: string): void {
    pending.push(`    ${label.padEnd(46)} ${value}`)
}
function flushReport(): void {
    if (pending.length) process.stdout.write(`${pending.join('\n')}\n`)
    pending = []
}

/**
 * A server double that answers the routes `rebaseDirtyScopes` can reach, over
 * a database of the reporting user's shape. The bootstrap body is serialised
 * once and reused so the measurement is of the client, not of the double.
 */
function createProbe(database: any, options: { conflicts: number }) {
    let revision = 10
    let conflictsLeft = options.conflicts
    const counts = new Map<string, number>()
    let bootstrapBytes = 0
    let rootKeyBytes = 0

    const settings: Record<string, unknown> = {}
    for (const key of Object.keys(database)) if (!STRUCTURAL.has(key)) settings[key] = database[key]
    const bootstrapBody = () => ({
        status: 'ready' as const,
        revision,
        // Without this stamp the client refuses the payload as a half-finished
        // migration, so the probe would measure a rebuild refusal, not a rebase.
        settings: { ...settings, __risuSqlChatHistoriesVerified: 1 },
        botPresets: database.botPresets,
        // Summaries, exactly as the server sends them: no message bodies.
        characters: database.characters.map((character: any) => ({
            ...character,
            chats: character.chats.map((chat: any) => ({ ...chat, message: undefined })),
        })),
        pluginCustomStorage: {},
        selectedCharacterId: null,
        selectedChatId: null,
        deferredRootKeys: [],
        absentDeferredRootKeys: [],
        unreadableRootKeys: [],
    })
    const serialisedBootstrap = JSON.stringify(bootstrapBody())
    bootstrapBytes = Buffer.byteLength(serialisedBootstrap, 'utf8')

    const bump = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1)

    const request = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const path = String(input)
        if (path.startsWith('/api/sql/bootstrap')) {
            bump('bootstrap')
            return new Response(serialisedBootstrap, { headers: { 'content-type': 'application/json' } })
        }
        // One root key, which is where `loadSettingKey`,
        // `loadPluginCustomStorageKey` and `loadBotPreset` now go instead of
        // through the whole bootstrap. Sized like the real route: the settings
        // rows carry one key's value, `botPresets` the preset list, and
        // `pluginCustomStorage` the plugin table -- never a character or a chat.
        if (path.startsWith('/api/sql/root-keys/')) {
            bump('root-key')
            const key = decodeURIComponent(path.slice('/api/sql/root-keys/'.length))
            const value = key === 'botPresets'
                ? database.botPresets
                : key === 'pluginCustomStorage'
                    ? (database.pluginCustomStorage ?? {})
                    : database[key]
            if (value === undefined) {
                return Response.json({ error: 'Root key not found', key, present: false }, { status: 404 })
            }
            const body = JSON.stringify({ revision, key, present: true, value })
            rootKeyBytes += Buffer.byteLength(body, 'utf8')
            return new Response(body, { headers: { 'content-type': 'application/json' } })
        }
        if (path === '/api/sql/commit') {
            bump('commit')
            if (conflictsLeft > 0) {
                conflictsLeft -= 1
                revision += 1
                return Response.json({ code: 'SQL_REVISION_CONFLICT', currentRevision: revision }, { status: 409 })
            }
            revision += 1
            return Response.json({ revision })
        }
        if (path.startsWith('/api/sql/characters/')) {
            bump('character')
            const id = decodeURIComponent(path.slice('/api/sql/characters/'.length))
            const character = database.characters.find((entry: any) => entry.chaId === id)
            return Response.json({ revision, character: { ...character, chats: undefined } })
        }
        if (path.includes('/messages')) {
            bump('message-page')
            const url = new URL(path, 'https://risu.invalid')
            const chatId = decodeURIComponent(url.pathname.slice('/api/sql/chats/'.length, url.pathname.indexOf('/messages')))
            const chat = database.characters
                .flatMap((entry: any) => entry.chats).find((entry: any) => entry.id === chatId)
            const all = chat?.message ?? []
            const limit = Number(url.searchParams.get('limit')) || 100
            const start = Math.max(0, all.length - limit)
            const messages = all.slice(start)
            return Response.json({
                revision, chatId, messages,
                positions: messages.map((_: unknown, index: number) => start + index),
                nextPosition: all.length,
                before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null,
                nextBefore: start > 0 ? start : null,
                hasMore: start > 0,
                total: all.length,
            })
        }
        if (path.startsWith('/api/sql/chats/')) {
            bump('chat-detail')
            const chatId = decodeURIComponent(path.slice('/api/sql/chats/'.length))
            const chat = database.characters
                .flatMap((entry: any) => entry.chats).find((entry: any) => entry.id === chatId)
            return Response.json({ revision, chat: { ...chat, message: undefined } })
        }
        throw new Error(`unexpected request: ${path}`)
    }

    return { request, counts, bootstrapBytes, rootKeyBytes: () => rootKeyBytes }
}

afterEach(() => {
    resetSqlPersistenceRuntimeForTesting()
    resetDeferredRootKeys()
})

describe('cost of one revision conflict', () => {
    for (const scopes of [
        { label: 'one message edit (the common case)', roots: 0, plugins: 0, presets: 0, characters: 0, chats: 0, messages: 1 },
        { label: 'a settings change the audit caught', roots: 3, plugins: 0, presets: 0, characters: 0, chats: 0, messages: 0 },
        { label: 'a preset edit + settings', roots: 3, plugins: 0, presets: 2, characters: 0, chats: 0, messages: 0 },
        { label: 'a plugin wrote 5 keys', roots: 0, plugins: 5, presets: 0, characters: 0, chats: 0, messages: 0 },
        { label: 'a broad audit sweep', roots: 12, plugins: 5, presets: 4, characters: 3, chats: 4, messages: 20 },
    ]) {
        it(scopes.label, async () => {
            const database = buildKoreanDatabase(SHAPES.reporting)
            const probe = createProbe(database, { conflicts: 1 })
            const storage = new NodeSqliteStorage(probe.request)
            await storage.init()
            probe.counts.clear()
            activateSqlPersistenceRuntime(storage as any, database)

            const rootNames = Object.keys(database).filter((key) => !STRUCTURAL.has(key))
            for (let index = 0; index < scopes.roots; index++) markSqlRootDirty(rootNames[index])
            for (let index = 0; index < scopes.plugins; index++) markSqlPluginStorageDirty(`plugin-key-${index}`)
            for (let index = 0; index < scopes.presets; index++) markSqlPresetDirty(database.botPresets[index].id)
            for (let index = 0; index < scopes.characters; index++) markSqlCharacterDirty(database.characters[index].chaId)
            for (let index = 0; index < scopes.chats; index++) {
                const character = database.characters[index]
                markSqlChatDirty(character.chaId, character.chats[0].id)
            }
            const openChat = database.characters
                .flatMap((character: any) => character.chats).find((chat: any) => chat.message.length > 0)
            // The commit builder needs a canonical position for every dirty
            // message and refuses ones it cannot place. This chat holds its
            // whole history, so say so; a refused row would never reach a
            // commit and there would be no conflict to measure.
            openChat.messagesFullyLoaded = true
            for (let index = 0; index < scopes.messages; index++) {
                markSqlMessageDirty(openChat.id, openChat.message[openChat.message.length - 1 - index].chatId)
            }

            const started = performance.now()
            let rejection: string | null = null
            await flushSqlDirtyChanges().catch((error) => { rejection = String(error?.message ?? error) })
            const elapsed = performance.now() - started

            pending.push(`\n  [${scopes.label}]`)
            row('dirty scopes (root/plugin/preset/char/chat/msg)',
                `${scopes.roots}/${scopes.plugins}/${scopes.presets}/${scopes.characters}/${scopes.chats}/${scopes.messages}`)
            row('bootstrap FETCHES caused by the conflict', String(probe.counts.get('bootstrap') ?? 0))
            row('bootstrap payload size (UTF-8)', `${((probe.bootstrapBytes) / 1024 / 1024).toFixed(2)} MiB`)
            row('targeted root-key reads', String(probe.counts.get('root-key') ?? 0))
            row('bytes those root-key reads returned', `${(probe.rootKeyBytes() / 1024).toFixed(1)} KiB`)
            row('targeted entity reads (character/chat/messages)',
                `${probe.counts.get('character') ?? 0}/${probe.counts.get('chat-detail') ?? 0}/${probe.counts.get('message-page') ?? 0}`)
            row('commit attempts', String(probe.counts.get('commit') ?? 0))
            row('wall time for the whole recovery', `${elapsed.toFixed(1)} ms`)
            if (rejection) row('flush ultimately rejected with', rejection)
            flushReport()
        })
    }

    it('what a repeated conflict costs', async () => {
        const database = buildKoreanDatabase(SHAPES.reporting)
        const probe = createProbe(database, { conflicts: 3 })
        const storage = new NodeSqliteStorage(probe.request)
        await storage.init()
        probe.counts.clear()
        activateSqlPersistenceRuntime(storage as any, database)
        markSqlRootDirty('mainPrompt')
        markSqlRootDirty('jailbreak')

        // Each flush recovers from one conflict and then rethrows the next.
        for (let attempt = 0; attempt < 4; attempt++) {
            await flushSqlDirtyChanges().catch(() => undefined)
        }
        pending.push('\n  [three consecutive conflicts, 2 dirty root keys]')
        row('bootstrap FETCHES', String(probe.counts.get('bootstrap') ?? 0))
        row('commit attempts', String(probe.counts.get('commit') ?? 0))
        flushReport()
    })

    /**
     * A conflict is not the only thing that drops the cached bootstrap: every
     * SUCCESSFUL commit does too (`sendStatements` ends with
     * `this.bootstrapPayload = null`). So the cost of a `current()` reader is
     * not "rare, only after a conflict" -- it is "a full bootstrap fetch for
     * the first one after any save at all".
     */
    it('what a successful commit costs the next current() reader', async () => {
        const database = buildKoreanDatabase(SHAPES.reporting)
        const probe = createProbe(database, { conflicts: 0 })
        const storage = new NodeSqliteStorage(probe.request)
        await storage.init()
        probe.counts.clear()
        activateSqlPersistenceRuntime(storage as any, database)

        await storage.loadPersonas()
        const beforeCommit = probe.counts.get('bootstrap') ?? 0
        markSqlRootDirty('mainPrompt')
        await flushSqlDirtyChanges()
        const afterCommit = probe.counts.get('bootstrap') ?? 0
        await storage.loadPersonas()
        const afterReader = probe.counts.get('bootstrap') ?? 0
        await storage.loadModules()
        await storage.loadBotPreset(database.botPresets[0].id)
        const afterMoreReaders = probe.counts.get('bootstrap') ?? 0

        pending.push('\n  [no conflict at all: one ordinary save]')
        row('bootstrap fetches after the first reader', String(beforeCommit))
        row('...after one successful commit', String(afterCommit))
        row('...after the next loadPersonas()', String(afterReader))
        row('...after loadModules() + loadBotPreset()', String(afterMoreReaders))
        flushReport()
    })
})
