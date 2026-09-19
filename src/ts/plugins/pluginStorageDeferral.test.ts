import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getV2PluginAPIs } from './plugins.svelte'
import { DBState } from '../stores.svelte'
import {
    markRootKeyDeferred,
    resetDeferredRootKeys,
} from '../storage/sql/deferredRootKeys'
import {
    enablePluginStoragePerKeyMode,
    readPluginStorageOverlay,
    resetPluginStorageOverlay,
} from '../storage/sql/pluginStorageOverlay'

/**
 * The plugin storage APIs are synchronous, so when `pluginCustomStorage` has
 * not been loaded they cannot wait for it. Their only two honest options are to
 * answer from the real map or to refuse; reporting "no such key" from a map
 * nobody read is how a plugin ends up rebuilding its config over the top of
 * data it could not see.
 *
 * Every test here calls the real API surface a plugin is handed.
 */

const STORED = {
    'pagefold.config.v1': { provider: 'google' },
    'translator.cache.v2': ['a', 'b'],
}

let previousDatabase: any

beforeEach(() => {
    resetDeferredRootKeys()
    previousDatabase = DBState.db
    DBState.db = {
        characters: [],
        botPresets: [],
        plugins: [],
        pluginCustomStorage: { ...STORED },
    } as any
})

afterEach(() => {
    resetDeferredRootKeys()
    resetPluginStorageOverlay()
    DBState.db = previousDatabase
})

/** What the bootstrap leaves behind for a withheld key: marked, and absent. */
function deferPluginStorage() {
    delete (DBState.db as any).pluginCustomStorage
    markRootKeyDeferred('pluginCustomStorage')
}

describe('plugin storage APIs while pluginCustomStorage is deferred', () => {
    it('answers normally while the map is resident', () => {
        const apis = getV2PluginAPIs() as any

        expect(apis.pluginStorage.getItem('pagefold.config.v1')).toEqual({ provider: 'google' })
        expect(apis.pluginStorage.keys().sort()).toEqual([
            'pagefold.config.v1',
            'translator.cache.v2',
        ])
        expect(apis.pluginStorage.length()).toBe(2)
    })

    it('refuses every read rather than reporting stored keys as missing', () => {
        deferPluginStorage()
        const apis = getV2PluginAPIs() as any

        expect(() => apis.pluginStorage.getItem('pagefold.config.v1')).toThrow(/not loaded/)
        expect(() => apis.pluginStorage.keys()).toThrow(/not loaded/)
        expect(() => apis.pluginStorage.key(0)).toThrow(/not loaded/)
        expect(() => apis.pluginStorage.length()).toThrow(/not loaded/)
    })

    it('refuses every write rather than letting a pending load overwrite it', () => {
        deferPluginStorage()
        const apis = getV2PluginAPIs() as any

        expect(() => apis.pluginStorage.setItem('pagefold.config.v1', 'x')).toThrow(/not loaded/)
        expect(() => apis.pluginStorage.removeItem('pagefold.config.v1')).toThrow(/not loaded/)
        expect(() => apis.pluginStorage.clear()).toThrow(/not loaded/)
        // Nothing was created behind the refusals: an empty map here would be
        // written back over the stored rows on the next commit.
        expect(DBState.db.pluginCustomStorage).toBeUndefined()
    })

    it('refuses custom property access through the safe database proxy', () => {
        deferPluginStorage()
        const db = (getV2PluginAPIs() as any).getDatabase()

        // Custom (non-allowlisted) properties resolve against plugin storage,
        // so an unloaded map would answer every one of them with `undefined`.
        expect(() => db['some.plugin.key']).toThrow(/not loaded/)
        expect(() => db.pluginCustomStorage).toThrow(/not loaded/)
        expect(() => { db['some.plugin.key'] = 1 }).toThrow(/not loaded/)
        expect(() => Object.keys(db)).toThrow(/not loaded/)
    })

    it('still serves allowlisted database keys through the proxy', () => {
        deferPluginStorage()
        const db = (getV2PluginAPIs() as any).getDatabase()

        // Only the plugin storage scope is unknown; the rest of the database is
        // fully loaded and must keep working.
        expect(db.plugins).toEqual([])
        expect(db.characters).toEqual([])
    })

    it('refuses a bulk database replacement that would fold into plugin storage', async () => {
        deferPluginStorage()
        const apis = getV2PluginAPIs() as any

        expect(() => apis.setDatabaseLite({ 'some.plugin.key': 1 })).toThrow(/not loaded/)
        await expect(apis.setDatabase({ 'some.plugin.key': 1 })).rejects.toThrow(/not loaded/)
    })

    it('accepts a replacement that touches only allowlisted keys while the map is unloaded', async () => {
        deferPluginStorage()
        const apis = getV2PluginAPIs() as any

        // Nothing here goes into plugin storage, so the unloaded map is not a
        // reason to refuse: Persona Binder saves a persona through exactly this
        // call, and every install where all plugins are v3 never loads the map.
        const personas = [{ name: 'A', personaPrompt: 'p', icon: '', largePortrait: false }]
        expect(() => apis.setDatabaseLite({ personas })).not.toThrow()
        expect(DBState.db.personas).toEqual(personas)
        await expect(apis.setDatabase({ selectedPersona: 0 })).resolves.toBeUndefined()
    })

    it('routes a storage key through the per-key writer when the map is served lazily', async () => {
        deferPluginStorage()
        enablePluginStoragePerKeyMode()
        const apis = getV2PluginAPIs() as any

        expect(() => apis.setDatabaseLite({ 'some.plugin.key': 1, personas: [] })).not.toThrow()
        expect(readPluginStorageOverlay('some.plugin.key')).toEqual({ present: true, value: 1 })
        expect(DBState.db.personas).toEqual([])
        await expect(apis.setDatabase({ 'other.plugin.key': 'x' })).resolves.toBeUndefined()
        expect(readPluginStorageOverlay('other.plugin.key')).toEqual({ present: true, value: 'x' })
    })
})
