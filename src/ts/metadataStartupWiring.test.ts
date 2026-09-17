import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-level, for the same reason the sibling contracts in
 * `globalApiImmediateSave.test.ts` and `bootstrapStartup.test.ts` are: importing
 * `globalApi.svelte` pulls wasmoon and DOMPurify and needs a DOM.
 *
 * What these guard is a class of defect, not a line: a side effect that only
 * ever happened as a consequence of *running* `saveDb`, in the mode that never
 * calls `saveDb`.
 */
const globalApi = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const bootstrap = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')

function startMetadataPersistenceBlock(): string {
    const start = globalApi.indexOf('export async function startMetadataPersistence')
    expect(start).toBeGreaterThan(-1)
    const next = globalApi.indexOf('\nexport ', start + 1)
    return globalApi.slice(start, next > start ? next : undefined)
}

describe('metadata-first startup wires up what saveDb used to', () => {
    /**
     * The BroadcastChannel, the `risu-session-deactivated` listener and the
     * reload-on-return check were all created as a side effect of running
     * `saveDb`. There is exactly one `BroadcastChannel` and exactly one
     * `risu-session-deactivated` listener in the whole application, and both of
     * them were inside it -- so in metadata-first mode two tabs on one machine
     * both wrote, and a 423 from `/api/sql/commit` became a five-second retry
     * loop that never ended and never said anything.
     */
    it('installs the single-writer guards, which do not belong to a save function', () => {
        expect(globalApi).toContain('export function installSingleWriterGuards()')
        expect(startMetadataPersistenceBlock()).toContain('installSingleWriterGuards()')

        const guards = globalApi.slice(globalApi.indexOf('export function installSingleWriterGuards()'))
        expect(guards).toContain("new BroadcastChannel('risu-db')")
        expect(guards).toContain("addEventListener('risu-session-deactivated'")
        expect(guards).toContain('getWriterLockState()')
    })

    /**
     * And the other half of it. `saveDb` posted to the channel on every write;
     * nothing in SQL mode did, so installing the listener alone would leave two
     * metadata-first tabs listening to a channel neither ever speaks on.
     */
    it('broadcasts its own writes so another tab on this device can surrender', () => {
        expect(startMetadataPersistenceBlock()).toContain('onSqlCommitSucceeded(() => broadcastLocalWrite())')
        // ...and routes that through the handoff rather than posting straight to
        // the channel. `onSqlCommitSucceeded` fires for every commit that
        // reaches storage, including the ones a tab makes after it has already
        // surrendered, so a bare `postMessage` here evicts the tab this one
        // surrendered TO. The rule itself is executed in
        // `storage/writerHandoff.test.ts`; this only pins that the wiring uses it.
        expect(globalApi).toMatch(
            /export function broadcastLocalWrite\(\): void \{\s*\n\s*writerHandoff\.announce\(/,
        )
    })

    /**
     * `saving.state` is a spinner with no failure state that clears itself in a
     * `finally`, and the legacy `savetrys > 4 -> alertError` was inside
     * `saveDb`. Without a channel out of the persistence layer, a commit failing
     * forever is indistinguishable from one succeeding.
     */
    it('subscribes to the persistence problem channel', () => {
        expect(startMetadataPersistenceBlock()).toContain('onSqlPersistenceProblem(')
    })

    /**
     * The unload flush and saver mode's flush both run at the one moment when
     * no later audit is coming, and the audit is the only thing that turns a
     * settings mutation into a dirty mark.
     */
    it('audits before flushing on the paths where no audit follows', () => {
        const runtime = readFileSync(
            resolve(process.cwd(), 'src/ts/storage/sql/sqlPersistenceRuntime.ts'),
            'utf8',
        )
        const metadata = runtime.slice(runtime.indexOf('export function startSqlMetadataPersistence'))
        expect(metadata).toContain('flushSqlDirtyChangesWithAudit()')
        expect(bootstrap).toContain('configureSaverModeActions({ flush: flushSqlDirtyChangesWithAudit')
    })

    /**
     * `patchSyncBaseline` feeds `saveDb`'s binary patch encoder and nothing
     * else, and `saveDb` is also its only clearer -- so metadata-first startup
     * paid for two whole-database deep clones on the critical path and then held
     * one of them for the session.
     */
    it('does not clone a patch baseline it will never read', () => {
        expect(bootstrap).toMatch(/if \(startupMode !== 'metadata-first'\) \{\s*\n\s*setPatchSyncBaseline\(existingSql\.database\)/)
        expect(startMetadataPersistenceBlock()).toContain('setPatchSyncBaseline(null)')
    })
})
