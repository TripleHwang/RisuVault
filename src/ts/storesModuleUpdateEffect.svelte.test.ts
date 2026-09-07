import { describe, expect, test, beforeEach } from 'vitest'
// Imported first, and deliberately: this file's assertions are about what the
// module-scope `$effect.root` in `stores.svelte` did while it was evaluating,
// so nothing may touch `database.svelte` before it.
import { DBState, HideIconStore, ReloadGUIPointer, selectedCharID } from './stores.svelte'
import { flushSync } from 'svelte'
import { get } from 'svelte/store'
import type { Database, character } from './storage/database.svelte'
import { refreshModules } from './process/modules'

/**
 * The module-scope `$effect` in `stores.svelte` drives `moduleUpdate()`.
 *
 * It runs synchronously while `stores.svelte` is still evaluating, long before
 * anything installs a database, and `moduleUpdate()` reaches the database only
 * through `database.svelte`'s accessors. That combination is what produced 17
 * unhandled `ReferenceError: Cannot access '__vite_ssr_import_35__' before
 * initialization` errors -- one per test file whose import graph reached
 * `database.svelte` before `stores.svelte`, leaving it suspended at its hoisted
 * `await __vite_ssr_import__` with its import const in TDZ. Every test passed
 * and the run still exited 1.
 *
 * The import-order half of that cannot be asserted from inside a test file: a
 * file that imports `stores.svelte` first is by construction one of the ~370
 * that never threw. What CAN be asserted, in either order, is the property that
 * makes the throw impossible -- the effect must not cross into `database.svelte`
 * while `DBState.db` is still the `{}` placeholder. The observable trace of such
 * a crossing is `getCurrentCharacter()` stamping `db.characters = []` into
 * whatever object it is handed, so an unguarded effect leaves the placeholder
 * carrying a `characters` key by the time this file's first line runs.
 *
 * The other half matters just as much: a guard that is too strict would silently
 * stop `HideIconStore`, `moduleBackgroundEmbedding` and `ReloadGUIPointer` from
 * ever updating, with no error anywhere. Nothing else in the suite covers the
 * store-level effect at all -- `process/modules.test.ts` and
 * `interchangeability.test.ts` both mock `stores.svelte` outright -- so the
 * re-arm cases below are asserted here too.
 */

function makeDatabase(fields: Partial<Database>): Database {
    return { characters: [] as character[], ...fields } as Database
}

describe('stores module-scope effect: placeholder gate', () => {
    test('leaves the placeholder untouched while no database is installed', () => {
        // Read before anything in this file writes to DBState. A `characters`
        // key here means the effect ran `moduleUpdate()` on the placeholder and
        // `getCurrentCharacter()` stamped it -- which also means it reached
        // `database.svelte` at a moment when that module can be mid-await.
        expect(Object.keys(DBState.db ?? {})).toEqual([])
    })
})

describe('stores module-scope effect: re-arms once a database exists', () => {
    beforeEach(() => {
        // `getModules()` caches on the database identity and on module object
        // identity; each case below installs a fresh database, but clearing the
        // cache keeps these independent of the order they run in.
        refreshModules()
    })

    test('runs moduleUpdate as soon as a database is installed', () => {
        const pointerBefore = get(ReloadGUIPointer)
        DBState.db = makeDatabase({
            modules: [{ id: 'm1', name: 'hider', description: '', hideIcon: true }],
            enabledModules: ['m1'],
        })
        flushSync()
        expect(get(HideIconStore)).toBe(true)
        // A changed resolved-module set must still bump the GUI pointer.
        expect(get(ReloadGUIPointer)).toBeGreaterThan(pointerBefore)
    })

    test('runs moduleUpdate when the enabled set changes', () => {
        DBState.db = makeDatabase({
            modules: [{ id: 'm1', name: 'hider', description: '', hideIcon: true }],
            enabledModules: ['m1'],
        })
        flushSync()
        expect(get(HideIconStore)).toBe(true)

        DBState.db.enabledModules = []
        flushSync()
        expect(get(HideIconStore)).toBe(false)
    })

    test('runs moduleUpdate when moduleIntergration changes', () => {
        DBState.db = makeDatabase({
            modules: [{ id: 'm1', name: 'hider', description: '', hideIcon: true }],
            enabledModules: [],
        })
        flushSync()
        expect(get(HideIconStore)).toBe(false)

        DBState.db.moduleIntergration = 'm1'
        flushSync()
        expect(get(HideIconStore)).toBe(true)
    })

    test("runs moduleUpdate when the open chat's module list changes", () => {
        // `getCurrentCharacter()` indexes `db.characters` with `selectedCharID`,
        // which starts at -1 (no character open), so a chat-scoped module is only
        // reachable once a character is selected.
        selectedCharID.set(0)
        DBState.db = makeDatabase({
            modules: [{ id: 'm1', name: 'hider', description: '', hideIcon: true }],
            enabledModules: [],
            characters: [{
                type: 'character',
                chatPage: 0,
                chats: [{ message: [], note: '', name: 'chat', localLore: [], modules: [] }],
            } as unknown as character],
        })
        flushSync()
        expect(get(HideIconStore)).toBe(false)

        DBState.db.characters[0].chats[0].modules = ['m1']
        flushSync()
        expect(get(HideIconStore)).toBe(true)

        selectedCharID.set(-1)
    })

    test('runs moduleUpdate when a module itself changes', () => {
        DBState.db = makeDatabase({
            modules: [{ id: 'm1', name: 'hider', description: '' }],
            enabledModules: ['m1'],
        })
        flushSync()
        expect(get(HideIconStore)).toBe(false)

        DBState.db.modules[0].hideIcon = true
        flushSync()
        expect(get(HideIconStore)).toBe(true)
    })
})
