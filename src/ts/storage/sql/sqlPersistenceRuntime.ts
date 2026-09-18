import type { Chat, Database, character } from '../database.svelte'
import {
    deferUntilHydrationApplied,
    isChatHydrationApplying,
    isHydrationActive,
    isHydrationApplying,
} from '../hydrationState'
import { isRootKeyDeferred } from './deferredRootKeys'
import type { ISqlStorage } from './ISqlStorage'
import { DirtyRegistry, type DirtySnapshot } from './dirtyRegistry'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { hasSqlCommitChanges, SqlRevisionConflictError } from './sqlCommit'
import { v4 as uuidv4 } from 'uuid'
import { runtimeMetrics } from '../../performance/runtimeMetrics'
import { recordRuntimeDuration, updateRuntimeMemory } from '../../performance/performanceReport'
import { readJsHeap } from '../../performance/heapUsage'

let activeStorage: ISqlStorage | null = null
/**
 * How to reach the database to commit -- never the database itself.
 *
 * Holding the object was the defect: `activateSqlPersistenceRuntime` runs from
 * `activateSqlStorage` at boot, before `setDatabase` wraps that same object as
 * `DBState.db`. A `$state` proxy does not write through to its target, so the
 * held object stopped matching what the user was editing the instant the proxy
 * existed, and every commit after that was built from boot-time values.
 */
let activeDatabaseSource: SqlDatabaseSource | null = null
let compatibilityTimer: ReturnType<typeof setTimeout> | undefined
let compatibilityAuditScheduled = false
let compatibilityRecurrenceTimer: ReturnType<typeof setTimeout> | undefined
let dirtyRetryTimer: ReturnType<typeof setTimeout> | undefined
let metadataRuntimeStarted = false
type CompatibilityBaseline = {
    roots: Map<string, string>
    /**
     * False while `pluginCustomStorage` is deferred: the map is not in memory,
     * so this snapshot knows nothing about its keys. An empty `plugins` map on
     * such a baseline means "unknown", never "the user has none", and any diff
     * against it would read every row as deleted.
     */
    pluginsKnown: boolean
    plugins: Map<string, string>; presets: Map<string, string>
    characters: Map<string, string>; chats: Map<string, { characterId: string; signature: string }>
    messages: Map<string, { order: string[]; values: Map<string, string>; complete: boolean }>
    characterOrder: string[]; presetOrder: string[]; activePreset: number; chatOrders: Map<string, string[]>
    /**
     * Content-free size of this snapshot, counted while it was built rather
     * than by walking it afterwards, so measuring costs nothing.
     *
     * `bytes` is UTF-16 bytes of the fingerprint strings only -- the string
     * payload the process holds for the rest of the session -- not the Map
     * overhead around them. `entries` is how many such strings there are.
     *
     * These describe the snapshot as taken. `rebaselineHydratedRootKey`
     * deliberately does not adjust them: it swaps one key's fingerprint, and
     * the next audit (at most five seconds later) recomputes both exactly.
     */
    bytes: number
    entries: number
    /**
     * How many of those `entries` are the string instance the previous baseline
     * already held, because this pass produced a byte-identical one.
     *
     * `entries - reused` is what this pass actually added to the heap for the
     * next five seconds. It is the only observable evidence that the carry-over
     * in `snapshotCompatibility` is working: JavaScript cannot compare string
     * identity, so a test has no other way to tell one copy from two.
     */
    reused: number
}
let compatibilityBaseline: CompatibilityBaseline | null = null

/**
 * Whether a commit is in flight, for the saving indicator.
 *
 * The legacy path drove that indicator from inside `saveDb`, which the SQL path
 * never calls -- so in SQL mode the corner of the screen went quiet and stayed
 * quiet, and there was no way to tell a working save from a silent one. Given
 * this path has already shipped a silent save failure, having no writer at all
 * here is its own defect.
 *
 * Counted rather than set, because an immediate flush can overlap a scheduled
 * one and the first to finish would otherwise report the second as done.
 */
let commitsInFlight = 0
let commitActivityListener: ((active: boolean) => void) | null = null

export function onSqlCommitActivity(listener: ((active: boolean) => void) | null): void {
    commitActivityListener = listener
}

/**
 * Something the user has to be told about persistence, because nothing else
 * will tell them.
 *
 * The legacy path had `savetrys > 4 -> alertError` and a family of persist
 * failure toasts, all of them written inside `saveDb` and therefore all of them
 * dead in the mode every user is now in. What replaced them was
 * `saving.state`, a boolean spinner with no failure state that clears itself in
 * a `finally`. So a commit failing forever -- offline server, a stale writer
 * lock, a value storage cannot hold -- was `console.error` and a quiet retry
 * every five seconds, indistinguishable from working.
 */
export type SqlPersistenceProblem = {
    kind:
        /** One root key's value could not be encoded; the rest of the commit went. */
        | 'root-key-refused'
        /** Commits have been failing in a row for long enough to be real. */
        | 'commit-failing'
        /** The server says another session owns the writer lock (HTTP 423). */
        | 'session-deactivated'
    /** The root key involved, for 'root-key-refused'. */
    key?: string
    /** Consecutive failures so far, for 'commit-failing'. */
    failures?: number
    error?: unknown
    /** English fallback text; the UI layer may localise by `kind`. */
    message: string
}

/**
 * Called once per commit that actually reached storage.
 *
 * This is what the same-device writer lock is built on: the legacy path posted
 * to the `risu-db` BroadcastChannel on every write, and a tab receiving another
 * tab's post surrendered and reloaded. Installing the listener without a
 * sender leaves the guard half-dead -- this tab would yield to a legacy tab,
 * but two metadata-first tabs would never learn about each other.
 *
 * Fired from `commitWithMetrics` rather than from the flush, because most
 * flushes commit nothing: a no-op flush that broadcast would evict the other
 * tab for no reason at all.
 */
let commitSucceededListener: (() => void) | null = null

export function onSqlCommitSucceeded(listener: (() => void) | null): void {
    commitSucceededListener = listener
}

let persistenceProblemListener: ((problem: SqlPersistenceProblem) => void) | null = null
/** Problems already announced, so a 5s retry loop cannot become a 5s modal loop. */
const announcedProblems = new Set<string>()

export function onSqlPersistenceProblem(
    listener: ((problem: SqlPersistenceProblem) => void) | null,
): void {
    persistenceProblemListener = listener
}

function reportPersistenceProblem(id: string, problem: SqlPersistenceProblem): void {
    if (announcedProblems.has(id)) return
    announcedProblems.add(id)
    console.error(`[SQL persistence] ${problem.message}`, problem.error ?? '')
    persistenceProblemListener?.(problem)
}

function noteCommitActivity(delta: 1 | -1): void {
    const wasActive = commitsInFlight > 0
    commitsInFlight = Math.max(0, commitsInFlight + delta)
    const isActive = commitsInFlight > 0
    if (isActive !== wasActive) commitActivityListener?.(isActive)
}

/**
 * Consecutive failed commits. The legacy path counted these as `savetrys` and
 * raised an alert at five; nothing counted them here at all.
 */
let consecutiveCommitFailures = 0
/** Matches the legacy `savetrys > 4` threshold: four retries, ~20s of silence. */
const COMMIT_FAILURE_ALERT_THRESHOLD = 5

const registry = new DirtyRegistry(async () => {
    noteCommitActivity(1)
    try {
        await commitDirtyScopes()
        if (consecutiveCommitFailures > 0) {
            consecutiveCommitFailures = 0
            // Saving recovered, so a later run of failures is news again.
            announcedProblems.delete('commit-failing')
        }
    }
    catch (error) {
        consecutiveCommitFailures += 1
        // A writer-lock refusal is terminal, not transient. Another tab or
        // another device owns the session, and every retry will get the same
        // 423 -- so retrying forever means this tab silently stops saving while
        // its spinner keeps clearing itself, which is exactly what happened
        // once the `risu-session-deactivated` listener inside `saveDb` went
        // dead. Say so once and stop; the listener reloads the page.
        if (isWriterLockRefusal(error)) {
            reportPersistenceProblem('session-deactivated', {
                kind: 'session-deactivated',
                error,
                message:
                    'Another tab or device has taken over saving for this account, so this page ' +
                    'can no longer save. Reload to continue here.',
            })
            throw error
        }
        if (consecutiveCommitFailures >= COMMIT_FAILURE_ALERT_THRESHOLD) {
            reportPersistenceProblem('commit-failing', {
                kind: 'commit-failing',
                failures: consecutiveCommitFailures,
                error,
                message:
                    `Saving has failed ${consecutiveCommitFailures} times in a row. Recent changes ` +
                    'are still only in this tab and will be lost if it closes.',
            })
        }
        scheduleDirtyRetry()
        throw error
    }
    finally { noteCommitActivity(-1) }
})

/**
 * Where a commit reads the database from.
 *
 * A function is the form production uses, because the object that is correct at
 * boot is not the object the user edits: `setDatabase` wraps it in a `$state`
 * proxy afterwards and the two never reconverge. A bare `Database` is accepted
 * for callers that genuinely own a stable object -- tests that build one live
 * `$state` graph and mutate it directly -- and is resolved as-is.
 */
export type SqlDatabaseSource = Database | (() => Database | null)

function resolveActiveDatabase(): Database | null {
    if (!activeDatabaseSource) return null
    return typeof activeDatabaseSource === 'function' ? activeDatabaseSource() : activeDatabaseSource
}

/**
 * Bind persistence to a database source. Pass a resolver unless you own the
 * object for the whole of its life: a captured object silently stops being the
 * one the user is editing as soon as anything wraps it in `$state`.
 */
export function activateSqlPersistenceRuntime(storage: ISqlStorage, database: SqlDatabaseSource): void {
    activeStorage = storage
    activeDatabaseSource = database
}

export function deactivateSqlPersistenceRuntime(): void {
    activeStorage = null
    activeDatabaseSource = null
}

/**
 * Suppression is scoped to the apply window and defers rather than discards.
 *
 * The previous form asked `isChatHydrationActive`, which is true for the whole
 * of a page fetch, and returned. During a fetch hydration has not written a
 * single byte into the chat, so there was nothing to protect and the only marks
 * in that window belonged to the user: a reply that arrived while an older page
 * was in the air lost its mark, never entered a commit, and was gone after a
 * reload with nothing logged and nothing shown. Scroll-driven loading holds
 * that window open on almost every gesture, which is what turned a latent hole
 * into a reproducible loss.
 *
 * Inside the real apply window the mark is parked, not dropped. Hydration
 * itself never marks anything, so a mark arriving there is still somebody
 * else's edit; the queue drains as soon as the apply finishes.
 */
function whenMarkable(chatId: string, mark: () => void): void {
    deferUntilHydrationApplied(() => isChatHydrationApplying(chatId), mark)
}

export function markSqlMessageDirty(chatId: string, messageId: string, immediate = false): void {
    if (!chatId || !messageId) return
    whenMarkable(chatId, () => {
        registry.markMessage(chatId, messageId)
        scheduleDirtyFlush(immediate)
    })
}

/**
 * True while a message carries an unflushed local change.
 *
 * Residency trimming consults this before releasing a message from memory.
 * `buildSqlDirtyCommit` resolves each dirty id by looking it up in the live
 * `chat.message` array and skips ids it cannot find, so releasing a dirty row
 * turns a pending edit into one that is never written -- silent loss, not a
 * deferral. Unknown is the safe answer here, and an id with no mark is known
 * clean rather than unknown: marks survive until the commit carrying them is
 * acknowledged.
 */
export function isSqlMessageDirty(chatId: string, messageId: string): boolean {
    if (!chatId || !messageId) return false
    return registry.hasMessage(chatId, messageId)
}

export function markSqlMessageDeleted(chatId: string, messageId: string): void {
    if (!chatId || !messageId) return
    whenMarkable(chatId, () => {
        registry.markMessageDeleted(chatId, messageId)
        scheduleDirtyFlush(false)
    })
}

export function markSqlChatDirty(characterId: string, chatId: string): void {
    if (!characterId || !chatId) return
    const key = `${characterId}/${chatId}`
    deferUntilHydrationApplied(() => isHydrationApplying(key), () => {
        registry.markChat(characterId, chatId)
        scheduleDirtyFlush(false)
    })
}

export function markSqlCharacterDirty(characterId: string): void {
    // Left reading the wide predicate on purpose. Nothing registers a bare
    // character id -- `beginHydration` is only ever called with a
    // `characterId/chatId` key -- so this check does not currently fire, and
    // narrowing a condition that is already never true would only make it look
    // as though character hydration had been reasoned about here. It has not.
    if (!characterId || isHydrationActive(characterId)) return
    registry.markCharacter(characterId)
    scheduleDirtyFlush(false)
}

export function markSqlRootDirty(key: string): void {
    if (!key) return
    registry.markRoot(key)
    scheduleDirtyFlush(false)
}

export function markSqlPresetDirty(id: string): void {
    if (!id) return
    registry.markPreset(id)
    scheduleDirtyFlush(false)
}

export function markSqlPluginStorageDirty(key: string): void {
    if (!key) return
    registry.markPluginStorage(key)
    scheduleDirtyFlush(false)
}

function scheduleDirtyFlush(immediate: boolean): void {
    if (immediate) void registry.flushNow().catch(() => undefined)
    else registry.schedule(350)
}

/**
 * Said once, not every five seconds.
 *
 * Normal boot passes through the unresolved window in milliseconds and this
 * never fires. If it keeps firing, persistence is bound to storage that has no
 * live database to read -- the retry loop will keep the user's edits marked, but
 * nothing will ever be written, and that has to be visible rather than inferred
 * from a save indicator that never settles.
 */
let unresolvedDatabaseReported = false

function reportUnresolvedDatabase(): void {
    if (unresolvedDatabaseReported) return
    unresolvedDatabaseReported = true
    console.warn(
        '[SQL dirty commit] SQL storage is active but no live database has been installed yet; ' +
        'pending changes stay marked and will be retried.',
    )
}

function scheduleDirtyRetry(): void {
    if (dirtyRetryTimer !== undefined) return
    dirtyRetryTimer = setTimeout(() => {
        dirtyRetryTimer = undefined
        void flushSqlDirtyChanges().catch(() => undefined)
    }, 5_000)
}

/** Flush only scopes explicitly marked at mutation boundaries. Rejections retain the registry. */
export async function flushSqlDirtyChanges(): Promise<void> {
    await registry.flushNow()
}

/**
 * Audit, then flush. The only correct order for a flush that has to catch up
 * with edits nobody marked.
 *
 * There is no mutation-boundary marking for settings at all:
 * `markSqlRootDirty`, `markSqlPresetDirty` and `markSqlPluginStorageDirty` have
 * exactly one caller each in the whole application, and it is
 * `auditSqlCompatibilityDatabase`. So until the idle audit next runs -- up to
 * ~10s, a 5s timer chained to `requestIdleCallback({timeout: 5000})` -- a theme
 * change, a hotkey, a regex rule, an API key, a global lorebook entry or a
 * plugin's `setItem` is not merely unflushed, it is *unmarked*. A bare
 * `flushSqlDirtyChanges` at that moment commits whatever happened to already be
 * marked and reports success, and the user's change is gone.
 *
 * `requestImmediateSaveImpl` gets this right and says why. The two paths that
 * matter most and got it wrong are the ones that run when there is no next
 * audit coming: `pagehide`/`visibilitychange`, and saver mode's flush.
 */
export async function flushSqlDirtyChangesWithAudit(): Promise<void> {
    const database = resolveActiveDatabase()
    if (database) auditSqlCompatibilityDatabase(database)
    await registry.flushNow()
}

/**
 * Rows this flush could not position, kept out of the commit so the rest of it
 * can go, and re-marked afterwards so they are not acknowledged away.
 *
 * Refusing a row is not the same as writing it. It stays dirty, it retries, and
 * if its position never appears it never persists -- but that was already true
 * before, and before, it also took every other chat's writes with it.
 */
type RefusedMessage = { chatId: string; messageId: string }
/** A chat the commit refused because it is still a bootstrap summary. */
type RefusedChat = { characterId: string; chatId: string }
/** A root key whose value could not be encoded into rows at all. */
type RefusedRootKey = { key: string; error: unknown }

/**
 * Load the stored record of every character a commit refused as a bootstrap
 * summary, so the next flush can write the whole thing.
 *
 * The chat twin of this has existed since chats got `onRefusedChat`; characters
 * were refused with a bare `console.error` and no retain, so the edit was
 * acknowledged away. Same shape, same best-effort contract: the marks are
 * already retained by the time this runs, so a failure here costs a retry.
 */
async function hydrateRefusedCharacters(ids: readonly string[]): Promise<void> {
    const database = resolveActiveDatabase()
    if (!database) return
    const { ensureCharacterHydrated } = await import('./sqlRuntimeHydration')
    for (const id of ids) {
        const index = (database.characters ?? []).findIndex(item => item?.chaId === id)
        if (index < 0) continue
        try {
            await ensureCharacterHydrated(database, index)
        } catch (error) {
            console.error(
                `[SQL dirty commit] could not load the stored record of refused character ${id}; ` +
                'it stays dirty and unwritten rather than being written back as a stub.',
                error,
            )
        }
    }
}

/** True for the server's "another session holds the writer lock" refusal. */
function isWriterLockRefusal(error: unknown): boolean {
    return Number((error as { status?: unknown } | null)?.status) === 423
}

/**
 * Load the settings of every chat a commit refused, so the next flush can write
 * the whole record.
 *
 * Deliberately best effort and deliberately detached from the flush: the marks
 * are already retained by the time this runs, so a failure here costs a retry,
 * not an edit. Imported lazily because `sqlRuntimeHydration` imports this
 * module -- taking the dependency at module scope would close the cycle.
 */
async function hydrateRefusedChats(entries: readonly RefusedChat[]): Promise<void> {
    const database = resolveActiveDatabase()
    if (!database) return
    const { ensureChatDetailsHydrated } = await import('./sqlRuntimeHydration')
    for (const { characterId, chatId } of entries) {
        const character = (database.characters ?? []).find(item => item?.chaId === characterId)
        const index = character?.chats?.findIndex(chat => chat?.id === chatId) ?? -1
        if (!character || index === -1) continue
        try {
            await ensureChatDetailsHydrated(character.chats, index, characterId)
        } catch (error) {
            console.error(
                `[SQL dirty commit] could not load the stored settings of refused chat ${chatId}; ` +
                'it stays dirty and unwritten rather than being written back as a stub.',
                error,
            )
        }
    }
}

function reportRefusedMessages(refused: RefusedMessage[], error: unknown): void {
    if (refused.length === 0) return
    console.error(
        `[SQL dirty commit] refused ${refused.length} message(s) with no canonical position; ` +
        `they stay dirty and will be retried: ` +
        refused.map(entry => `${entry.chatId}/${entry.messageId}`).join(', '),
        error,
    )
}

async function commitDirtyScopes(): Promise<void> {
    const storage = activeStorage
    const database = resolveActiveDatabase()
    if (!storage) return
    // Resolved fresh on every flush, never cached across one. A null resolution
    // means storage is bound but the live graph is not installed yet -- the
    // window between `activateSqlStorage` and `setDatabase`. Returning without
    // acknowledging keeps every mark, and the retry is what makes those marks
    // reach a commit: without it they would wait for the user's next edit, and a
    // flush that fired in that window would look like it had succeeded.
    if (!database) {
        reportUnresolvedDatabase()
        scheduleDirtyRetry()
        return
    }
    const snapshot = registry.takeSnapshot()
    const refused: RefusedMessage[] = []
    let lastRefusal: unknown
    const refuse = (chatId: string, messageId: string, error: unknown) => {
        refused.push({ chatId, messageId })
        lastRefusal = error
    }
    const refusedChats: RefusedChat[] = []
    const refuseChat = (characterId: string, chatId: string) => {
        refusedChats.push({ characterId, chatId })
    }
    const refusedCharacters: string[] = []
    const refuseCharacter = (characterId: string) => { refusedCharacters.push(characterId) }
    const refusedRootKeys: RefusedRootKey[] = []
    const refuseRootKey = (key: string, error: unknown) => { refusedRootKeys.push({ key, error }) }
    // Re-marking is what keeps a refused row dirty. `acknowledge` only clears a
    // scope whose generation matches the one the snapshot recorded, and
    // `markMessage` takes a fresh, higher generation -- so a re-mark placed
    // after the acknowledge survives it, and the row is picked up by the next
    // flush instead of being dropped on the floor.
    const retainRefused = () => {
        for (const entry of refused) registry.markMessage(entry.chatId, entry.messageId)
        reportRefusedMessages(refused, lastRefusal)
        // Same contract for a chat refused as a bootstrap summary: re-mark so
        // `acknowledge` cannot drop the edit, then go and get the fields that
        // make the chat writable. Without the second half the mark would be
        // retained forever against a chat nothing was ever going to hydrate --
        // a rename made from the chat list, on a chat the user never opened,
        // would sit dirty and be refused on every flush for the rest of the
        // session.
        for (const entry of refusedChats) {
            registry.markChat(entry.characterId, entry.chatId)
        }
        if (refusedChats.length > 0) void hydrateRefusedChats(refusedChats)
        // And the same for a character, which until now had the refusal without
        // the retain: `acknowledge` cleared the mark and a move-to-trash on a
        // character the user had never opened was simply forgotten.
        for (const id of refusedCharacters) registry.markCharacter(id)
        if (refusedCharacters.length > 0) void hydrateRefusedCharacters(refusedCharacters)
        // A root key that cannot be encoded stays dirty too. It has to: the
        // audit overwrites its baseline the moment it marks the key
        // (`compatibilityBaseline = next` happens before the diff is even
        // read), so a dropped mark is not a deferred write, it is the only
        // record of the change.
        for (const entry of refusedRootKeys) {
            registry.markRoot(entry.key)
            reportPersistenceProblem(`root-key-refused:${entry.key}`, {
                kind: 'root-key-refused',
                key: entry.key,
                error: entry.error,
                message:
                    `"${entry.key}" is too large or too complex for this storage backend to save, ` +
                    'so it was left out of the last save. Everything else was saved. ' +
                    'Removing some of its contents will let it save again.',
            })
        }
    }
    let commit = buildSqlDirtyCommit(
        database, snapshot, storage.getRevision(),
        refuse, refuseChat, refuseRootKey, refuseCharacter,
    )
    if (!hasSqlCommitChanges(commit)) {
        registry.acknowledge(snapshot)
        retainRefused()
        return
    }
    try {
        await commitWithMetrics(storage, commit)
        registry.acknowledge(snapshot)
        retainRefused()
    } catch (error) {
        if (!(error instanceof SqlRevisionConflictError)) throw error
        // Targeted reads are observability-only: local dirty intent is
        // last-local-wins and must never be overwritten before the retry.
        await rebaseDirtyScopes(storage, snapshot)
        refused.length = 0
        refusedChats.length = 0
        refusedCharacters.length = 0
        refusedRootKeys.length = 0
        commit = buildSqlDirtyCommit(
            database, snapshot, storage.getRevision(),
            refuse, refuseChat, refuseRootKey, refuseCharacter,
        )
        if (!hasSqlCommitChanges(commit)) {
            registry.acknowledge(snapshot)
            retainRefused()
            return
        }
        await commitWithMetrics(storage, commit)
        registry.acknowledge(snapshot)
        retainRefused()
    }
}

/** One metric pair per actual row-commit attempt, including the conflict retry. */
async function commitWithMetrics(storage: ISqlStorage, commit: ReturnType<typeof buildSqlDirtyCommit>): Promise<void> {
    const metric = runtimeMetrics.start('dirty-commit')
    try {
        await storage.commit(commit)
        commitSucceededListener?.()
    } finally {
        runtimeMetrics.end(metric)
    }
}

/**
 * Conflict recovery intentionally uses entity endpoints only.  A full snapshot
 * can overwrite concurrent rows and is reserved for explicit recovery flows.
 */
/** Targeted-read last-local-wins rebase: a successful present/null read resolves
 * the remote row; our explicit dirty upsert/delete remains authoritative. */
async function rebaseDirtyScopes(storage: ISqlStorage, dirty: DirtySnapshot): Promise<void> {
    for (const key of dirty.rootKeys) await storage.loadSettingKey(key)
    for (const key of dirty.pluginStorageKeys) await storage.loadPluginCustomStorageKey(key)
    for (const id of dirty.presetIds) await storage.loadBotPreset(id)
    for (const characterId of dirty.characterIds) {
        await storage.loadCharacter(characterId)
    }
    for (const { characterId, chatId } of dirty.chats) {
        await storage.loadChat(chatId, { messageLimit: 100 })
    }
    const messageChatIds = new Set([
        ...dirty.messages.map(({ chatId }) => chatId),
        ...dirty.messageDeletes.map(({ chatId }) => chatId),
    ])
    for (const chatId of messageChatIds) {
        await storage.loadChat(chatId, { messageLimit: 1 })
        await storage.loadChatMessages(chatId)
    }
}

/** Plugins may mutate raw objects. Scan once when idle, never on each keystroke. */
export function scheduleSqlCompatibilityAudit(run?: () => Promise<void> | void): void {
    if (compatibilityAuditScheduled) return
    compatibilityAuditScheduled = true
    const execute = () => {
        compatibilityTimer = undefined
        compatibilityAuditScheduled = false
        void Promise.resolve(run?.()).catch(error => console.error('SQL compatibility audit failed', error))
    }
    const idle = globalThis.requestIdleCallback
    if (idle) {
        idle(() => execute(), { timeout: 5_000 })
        // `requestIdleCallback` has its own timeout; keep the fallback only for
        // browsers without it, so audit remains a single coalesced callback.
    } else {
        compatibilityTimer = setTimeout(execute, 1_000)
    }
}

/** Own the recurring compatibility scan so repeated metadata startup cannot multiply it. */
export function startSqlCompatibilityAuditLoop(run: () => Promise<void> | void): void {
    if (compatibilityRecurrenceTimer !== undefined) return
    const repeat = () => {
        scheduleSqlCompatibilityAudit(run)
        compatibilityRecurrenceTimer = setTimeout(repeat, 5_000)
    }
    repeat()
}

function fingerprint(value: unknown): string {
    try { return JSON.stringify(value) ?? 'undefined' }
    catch { return String(value) }
}

/** Roots carried by their own baseline scope, never by the generic root map. */
const STRUCTURAL_COMPATIBILITY_ROOTS = ['characters', 'pluginCustomStorage', 'botPresets', 'botPresetsId']

/**
 * Re-fingerprint everything resident, keeping the strings the standing baseline
 * already holds wherever this pass produced the same bytes.
 *
 * The carry-over is not a narrowing. Every value is serialised on every pass,
 * exactly as before, and every comparison the diff makes is over the same
 * bytes; `previous` decides only which of two identical strings the process
 * goes on holding. What it removes is the churn. A fingerprint produced here is
 * referenced for the whole five seconds until the next pass replaces it, which
 * on any generational collector is long enough to be promoted out of the
 * nursery and then abandoned -- so the audit was handing the collector 2.55 MiB
 * of promoted-then-dead string every five seconds at the reporting shape, and
 * holding two full copies of it for the length of each pass. Carried over, the
 * new string dies inside the pass that made it and the old one is never
 * touched.
 *
 * `previous` is `null` for the first pass, and every value is new by
 * definition.
 */
function snapshotCompatibility(database: Database, previous: CompatibilityBaseline | null): CompatibilityBaseline {
    // Counted here, on the strings this pass already produced, so knowing the
    // size of the baseline costs one addition per fingerprint and never a
    // second walk over the graph.
    let bytes = 0
    let entries = 0
    let reused = 0
    /**
     * `held` is what the standing baseline has for this same slot, or
     * `undefined` when it has nothing. Equal content means the two strings are
     * interchangeable, so the older instance is kept and the new one is left to
     * die as nursery garbage.
     */
    const take = (held: string | undefined, value: unknown): string => {
        const text = fingerprint(value)
        bytes += text.length * 2
        entries += 1
        if (held !== undefined && held === text) { reused += 1; return held }
        return text
    }
    const roots = new Map<string, string>()
    // A deferred key is not fingerprinted at all: its in-memory value is a
    // placeholder for "unknown", and baselining that would let a later diff
    // read the placeholder as real content.
    for (const key of Object.keys(database)) if (!STRUCTURAL_COMPATIBILITY_ROOTS.includes(key) && !isRootKeyDeferred(key)) roots.set(key, take(previous?.roots.get(key), (database as any)[key]))
    // A deferred plugin storage map is fingerprinted as nothing at all and
    // flagged as unknown, so `auditSqlCompatibilityDatabase` skips the diff
    // instead of reading the absence as hundreds of deleted rows.
    const pluginsKnown = !isRootKeyDeferred('pluginCustomStorage')
    // Only carried from a baseline that actually knew the map. A previous
    // snapshot flagged unknown holds an empty map, which would offer nothing to
    // carry anyway, but reading it as a source of truth is the mistake this
    // whole `pluginsKnown` flag exists to prevent.
    const heldPlugins = previous?.pluginsKnown ? previous.plugins : undefined
    const plugins = pluginsKnown
        ? new Map(Object.entries(database.pluginCustomStorage ?? {}).map(([key, value]) => [key, take(heldPlugins?.get(key), value)]))
        : new Map<string, string>()
    for (const preset of database.botPresets ?? []) preset.id ||= uuidv4()
    const presets = new Map((database.botPresets ?? []).filter(preset => preset.id).map(preset => [preset.id!, take(previous?.presets.get(preset.id!), preset)]))
    const characters = new Map<string, string>(); const chats = new Map<string, { characterId: string; signature: string }>(); const chatOrders = new Map<string, string[]>(); const messages = new Map<string, { order: string[]; values: Map<string, string>; complete: boolean }>()
    for (const character of database.characters ?? []) {
        if (!character) continue
        character.chaId ||= uuidv4()
        characters.set(character.chaId, take(previous?.characters.get(character.chaId), { ...character, chats: undefined }))
        for (const chat of character.chats ?? []) if (chat) chat.id ||= uuidv4()
        const ids = (character.chats ?? []).map(chat => chat?.id).filter((id): id is string => Boolean(id)); chatOrders.set(character.chaId, ids)
        for (const chat of character.chats ?? []) { if (!chat) continue; {
            chats.set(chat.id, { characterId: character.chaId, signature: take(previous?.chats.get(chat.id)?.signature, { ...chat, message: undefined }) })
            const rows = chat.message ?? []; for (const message of rows) message.chatId ||= uuidv4()
            const heldMessages = previous?.messages.get(chat.id)?.values
            messages.set(chat.id, { order: rows.map(message => message.chatId!), values: new Map(rows.map(message => [message.chatId!, take(heldMessages?.get(message.chatId!), message)])), complete: (chat as Chat & { messagesFullyLoaded?: boolean }).messagesFullyLoaded !== false })
        } }
    }
    return { roots, pluginsKnown, plugins, presets, characters, chats, messages, characterOrder: (database.characters ?? []).map(c => c?.chaId).filter(Boolean), presetOrder: (database.botPresets ?? []).map(p => p.id).filter(Boolean), activePreset: Number(database.botPresetsId) || 0, chatOrders, bytes, entries, reused }
}

function auditNow(): number {
    try {
        const value = globalThis.performance?.now?.()
        return Number.isFinite(value) ? value : Date.now()
    }
    catch { return Date.now() }
}

/**
 * What one audit pass cost and what it left behind.
 *
 * Reported after the baseline is installed, so `compatibilityBaseline*`
 * describes the snapshot the process is now holding for the rest of the
 * session -- which is the number that decides whether this loop is a memory
 * floor. Best-effort in the same sense as every other metric here:
 * instrumentation must never be able to fail a save.
 */
function reportCompatibilityAudit(startedAt: number, baseline: CompatibilityBaseline): void {
    try {
        recordRuntimeDuration('compatibility-audit', Math.max(0, auditNow() - startedAt))
        const heap = readJsHeap()
        updateRuntimeMemory({
            jsHeapUsedBytes: heap.usedBytes,
            jsHeapTotalBytes: heap.totalBytes,
            compatibilityBaselineBytes: baseline.bytes,
            compatibilityBaselineEntries: baseline.entries,
            compatibilityBaselineReusedEntries: baseline.reused,
        })
    }
    catch { /* reporting is optional */ }
}

/** The size of the baseline this session is holding, or null when it holds none. */
export function sqlCompatibilityBaselineFootprint(): { bytes: number; entries: number; reused: number } | null {
    if (!compatibilityBaseline) return null
    return {
        bytes: compatibilityBaseline.bytes,
        entries: compatibilityBaseline.entries,
        reused: compatibilityBaseline.reused,
    }
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
    return new Set([...before.keys(), ...after.keys()].filter(key => before.get(key) !== after.get(key)))
}

/**
 * Root-key diff. A deferred key is absent from the in-memory database because
 * it has not been loaded, not because it changed, so it must never enter this
 * set: doing so marks it dirty, and a dirty absent root key becomes a DELETE.
 */
function changedRootKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
    const changed = changedKeys(before, after)
    for (const key of changed) if (isRootKeyDeferred(key)) changed.delete(key)
    return changed
}

/**
 * Fold a just-loaded deferred root key into the standing baseline.
 *
 * `auditSqlCompatibilityDatabase` installs `next` as the new baseline before it
 * decides what to diff, and it deliberately skips a scope whose two snapshots
 * disagree about whether the value was known. On the unknown -> known
 * transition those two facts combine badly: the newly-loaded value is adopted
 * as the baseline without ever being diffed, so any write made between the load
 * and the next audit is absorbed and never persisted. Silent write loss is the
 * same failure this guard exists to prevent, only moved from deleted rows to
 * changes that never leave memory.
 *
 * The caller runs this in the same synchronous step that installs the value, so
 * what is fingerprinted here is what storage returned, not a mutated copy.
 * Every other scope is left alone: their pending changes must still be audited.
 */
export function rebaselineHydratedRootKey(database: Database, key: string): void {
    if (!compatibilityBaseline) return
    const record = database as unknown as Record<string, unknown>
    if (key === 'pluginCustomStorage') {
        compatibilityBaseline.pluginsKnown = true
        compatibilityBaseline.plugins = new Map(
            Object.entries(database.pluginCustomStorage ?? {}).map(([entry, value]) => [entry, fingerprint(value)]),
        )
        return
    }
    if (STRUCTURAL_COMPATIBILITY_ROOTS.includes(key)) return
    compatibilityBaseline.roots.set(key, fingerprint(record[key]))
}

/**
 * A message id missing from a chat's array means "deleted" only when that array
 * is the whole history. Under SQL windowing it is a slice: hydration makes the
 * newest forty resident, and eviction (chatStorage.ts:300) drops the array
 * entirely while setting messagesFullyLoaded false. Without this guard the idle
 * audit reads an evicted chat as one whose every message the user just deleted,
 * and issues a delete for each -- partial knowledge turned into a definite
 * negative, against rows that are still on disk.
 */
function deleteMissing(
    chatId: string,
    prior: { order: string[] },
    current: { values: Map<string, string>; complete: boolean },
): void {
    if (!current.complete) return
    for (const id of prior.order) if (!current.values.has(id)) markSqlMessageDeleted(chatId, id)
}

/**
 * True when two partial snapshots of one chat's message order cannot be
 * reconciled without knowing every message's persisted position.
 *
 * Two things make a partial diff unreconcilable:
 *
 *   - the ids both snapshots know changed their order relative to each other;
 *   - a new id appeared *between* two ids the baseline already knew, so the
 *     audit cannot tell where in the persisted history it belongs.
 *
 * Everything else is safe, and one case in particular has to be: new ids
 * arriving at the *front*. That is exactly what `loadOlderChatMessages` does --
 * it splices an older page onto the start of the resident slice -- and the
 * previous rule required the shared ids to still be the first N of the current
 * order, which is true of an append and false of every prepend there has ever
 * been. So the first time a reader scrolled back, this chat was declared
 * unreconcilable, its baseline was pinned to the pre-scroll snapshot, and it
 * stayed pinned: the same comparison failed identically on every later audit.
 * From that moment the audit could no longer see a message arrive in that chat
 * at all, which is the second chance a dropped dirty mark depends on.
 *
 * The middle-insertion case this exists for still trips it: an id spliced
 * between two known ones lands inside the shared span and is caught below.
 */
function hasUnreconcilablePartialOrder(
    prior: { order: string[]; values: Map<string, string> },
    current: { order: string[]; values: Map<string, string> },
    currentPrior: string[],
): boolean {
    const survivingPrior = prior.order.filter(id => current.values.has(id))
    if (survivingPrior.join('\u0000') !== currentPrior.join('\u0000')) return true
    const first = current.order.findIndex(id => prior.values.has(id))
    // No shared id at all: there is no known span for anything to be inserted
    // into, so nothing here can be misplaced relative to the baseline.
    if (first < 0) return false
    let last = first
    for (let index = current.order.length - 1; index > first; index -= 1) {
        if (prior.values.has(current.order[index])) { last = index; break }
    }
    for (let index = first; index <= last; index += 1) {
        if (!prior.values.has(current.order[index])) return true
    }
    return false
}

/** Idle compatibility audit: baseline first, then only explicitly changed scopes. */
export function auditSqlCompatibilityDatabase(database: Database): void {
    const startedAt = auditNow()
    const previous = compatibilityBaseline
    const next = snapshotCompatibility(database, previous)
    compatibilityBaseline = next
    if (!previous) { reportCompatibilityAudit(startedAt, next); return }
    try { auditChangedScopes(previous, next) }
    finally { reportCompatibilityAudit(startedAt, next) }
}

/** The diff half of one audit pass, split out only so the pass can be timed whole. */
function auditChangedScopes(previous: CompatibilityBaseline, next: CompatibilityBaseline): void {
    for (const key of changedRootKeys(previous.roots, next.roots)) markSqlRootDirty(key)
    // Only diff plugin storage when BOTH snapshots actually knew its contents.
    // A load (unknown -> known) is not an edit, and a deferral (known ->
    // unknown) is not a deletion; treating either as a change would mark every
    // row dirty, which for the "unknown" side means marking them for deletion.
    if (previous.pluginsKnown && next.pluginsKnown) {
        for (const key of changedKeys(previous.plugins, next.plugins)) markSqlPluginStorageDirty(key)
    }
    for (const id of changedKeys(previous.presets, next.presets)) markSqlPresetDirty(id)
    if (previous.presetOrder.join('\u0000') !== next.presetOrder.join('\u0000')) markSqlRootDirty('botPresets')
    if (previous.activePreset !== next.activePreset) markSqlRootDirty('botPresetsId')
    for (const id of changedKeys(previous.characters, next.characters)) markSqlCharacterDirty(id)
    const characterOrderChanged = previous.characterOrder.join('\u0000') !== next.characterOrder.join('\u0000')
    const changedChats = changedKeys(new Map([...previous.chats].map(([id, value]) => [id, `${value.characterId}\u0000${value.signature}`])), new Map([...next.chats].map(([id, value]) => [id, `${value.characterId}\u0000${value.signature}`])))
    for (const chatId of changedChats) {
        const info = next.chats.get(chatId) ?? previous.chats.get(chatId)
        if (info) markSqlChatDirty(info.characterId, chatId)
    }
    if (characterOrderChanged) for (const id of next.characterOrder) markSqlCharacterDirty(id)
    for (const [characterId, order] of next.chatOrders) if (previous.chatOrders.get(characterId)?.join('\u0000') !== order.join('\u0000')) {
        for (const chatId of order) markSqlChatDirty(characterId, chatId)
    }
    for (const [chatId, current] of next.messages) {
        const prior = previous.messages.get(chatId)
        if (!prior) {
            for (const id of current.order) markSqlMessageDirty(chatId, id)
            continue
        }
        const currentPrior = current.order.filter(id => prior.values.has(id))
        const unsafePartialOrder = !prior.complete && !current.complete &&
            hasUnreconcilablePartialOrder(prior, current, currentPrior)
        if (unsafePartialOrder) {
            console.warn(`[SQL compatibility audit] deferred unsafe middle message insertion/reorder in partial chat ${chatId}; hydrate it before retrying`)
            // Keep this chat's old baseline so a later full hydration can safely
            // reconcile the same mutation. Independent row edits below remain dirty.
            next.messages.set(chatId, prior)
            for (const id of currentPrior) if (prior.values.get(id) !== current.values.get(id)) markSqlMessageDirty(chatId, id)
            deleteMissing(chatId, prior, current)
            continue
        }
        for (const id of current.order) if (prior.values.get(id) !== current.values.get(id)) markSqlMessageDirty(chatId, id)
        deleteMissing(chatId, prior, current)
        // A reorder rewrites every row's position; the ids that left the array
        // were already named by `deleteMissing`. Nothing else is marked: a
        // manifest here deleted every row this tab had not loaded, which is
        // how a chat continued on a phone lost its newest messages to a PC tab
        // still holding the older copy.
        if (current.complete && prior.order.join('\u0000') !== current.order.join('\u0000')) {
            for (const id of current.order) markSqlMessageDirty(chatId, id)
        }
    }
}

export function initializeSqlCompatibilityBaseline(database: Database): void {
    const startedAt = auditNow()
    compatibilityBaseline = snapshotCompatibility(database, null)
    reportCompatibilityAudit(startedAt, compatibilityBaseline)
}

/** Metadata-first startup deliberately avoids saveDb and its reactive encoder path. */
export function startSqlMetadataPersistence(
    eventTarget: Pick<Window, 'addEventListener'> = window,
    keepalive: () => void = () => {},
): void {
    if (metadataRuntimeStarted) return
    metadataRuntimeStarted = true
    const flush = () => { void flushSqlDirtyChangesWithAudit().catch(() => undefined); keepalive() }
    eventTarget.addEventListener('pagehide', flush)
    eventTarget.addEventListener('visibilitychange', () => {
        if (typeof document === 'undefined' || document.visibilityState === 'hidden') flush()
    })
}

export function resetSqlPersistenceRuntimeForTesting(): void {
    commitsInFlight = 0
    commitActivityListener = null
    if (compatibilityTimer !== undefined) clearTimeout(compatibilityTimer)
    if (compatibilityRecurrenceTimer !== undefined) clearTimeout(compatibilityRecurrenceTimer)
    if (dirtyRetryTimer !== undefined) clearTimeout(dirtyRetryTimer)
    compatibilityTimer = undefined
    compatibilityRecurrenceTimer = undefined
    dirtyRetryTimer = undefined
    compatibilityAuditScheduled = false
    metadataRuntimeStarted = false
    compatibilityBaseline = null
    unresolvedDatabaseReported = false
    consecutiveCommitFailures = 0
    announcedProblems.clear()
    persistenceProblemListener = null
    commitSucceededListener = null
    deactivateSqlPersistenceRuntime()
}
