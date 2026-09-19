import { get, writable } from "svelte/store";
import { language } from "../../lang";
import { getCurrentCharacter, getDatabase, setDatabase, setDatabaseLite } from "../storage/database.svelte";
import { alertConfirm, alertError, alertPluginConfirm } from "../alert";
import { selectSingleFile, sleep } from "../util";
import type { OpenAIChat } from "../process/index.svelte";
import { fetchNative, globalFetch, readImage, requestImmediateSave, saveAsset, toGetter } from "../globalApi.svelte";
import { DBState, hotReloading, pluginAlertModalStore, selectedCharID } from "../stores.svelte";
import type { ScriptMode } from "../process/scripts";
import { checkCodeSafety } from "./pluginSafety";
import { SafeDocument, SafeIdbFactory, SafeLocalStorage } from "./pluginSafeClass";
import { loadV3Plugins } from "./apiV3/v3.svelte";
import { pluginCodeTranspiler } from "./apiV3/transpiler";
import { describePluginUpdateFailure, isPluginUpdateRefusal, runPluginUpdate, type PluginImportOutcome, type PluginUpdateResult } from "./pluginUpdate";
import { v4 } from "uuid";
import { BUILT_IN_PLUGIN_NAMES, isBuiltInPluginActive as isBuiltInPluginActiveIn, loadBuiltInPlugins } from "../builtin";
import { PluginChatOutputListeners, V2_CHAT_OUTPUT_OWNER, createV2ChatOutputApi } from "./pluginChatOutput";
import { isRootKeyDeferred } from "../storage/sql/deferredRootKeys";
import { isPluginStoragePerKeyMode } from "../storage/sql/pluginStorageOverlay";
import { writePluginStorageKeyLazily } from "./pluginStorageAccess";
import { isPluginCharacterComplete, isPluginChatComplete } from "./pluginChatAccess";
import { markSqlPluginStorageDirty } from "../storage/sql/sqlPersistenceRuntime";
import { planPluginStorageLoad, tryEnablePerKeyPluginStorage } from "./pluginStorageAccess";
import type { PluginProviderStructuredOutput } from './providerStructuredOutput';

export const customProviderStore = writable([] as string[])
export const pluginProviderOwners = new Map<string, string>()
export const pluginLoadingStore = writable(false)
export const pluginReadyStore = writable(false)
export const pluginStateStore = writable<'idle' | 'loading' | 'ready' | 'failed'>('idle')

export function hasMetadataOnlyCharacters(db: { characters?: any[] }): boolean {
    return (db.characters ?? []).some((character) => character?.detailsLoaded === false)
}

/**
 * The plugin storage APIs below are synchronous, so they cannot wait for a
 * deferred `pluginCustomStorage` to arrive. Answering anyway would mean
 * reporting "no such key" / "no keys at all" from a map that was never read,
 * and a plugin acting on that answer (re-initialising its config, clearing a
 * cache, writing a fresh empty state) destroys the very rows it could not see.
 *
 * `loadPlugins` hydrates the map before any plugin code runs, so in practice
 * this only fires when that load failed. Then a loud throw is the honest
 * answer: unknown, not empty.
 */
export function assertPluginStorageResident(action: string): void {
    if (!isRootKeyDeferred('pluginCustomStorage')) return
    throw new Error(
        `Plugin storage is not loaded, so ${action} cannot be answered. Its rows exist in ` +
        'storage but are not in memory; treating them as absent would destroy them.',
    )
}

// The chat/character gates live in `pluginChatAccess.ts` with the write-back
// helper they pair with; re-exported so existing import sites are unchanged.
export {
    isPluginCharacterComplete,
    isPluginCharacterDetailsLoaded,
    isPluginChatComplete,
    isPluginChatSettingsLoaded,
} from "./pluginChatAccess";

interface ProviderPlugin {
    /**
     * Stable install identity, minted once and carried across every update.
     *
     * The name is the runtime key (permissions, providers, IPC and the
     * collection organizer are all keyed by it), and it is user-visible, which
     * means it can change. Resolving an *install* by that name is what let an
     * update whose source declared a different `//@name` land on a different
     * plugin's record. Optional in the type only because a database written
     * before identities existed has none; `ensurePluginIdentities` fills those
     * in before anything reads them.
     */
    id?: string
    name: string
    displayName?: string
    script: string
    arguments: { [key: string]: 'int' | 'string' | string[] }
    realArg: { [key: string]: number | string }
    version?: 1 | 2 | '2.1' | '3.0'
    customLink: ProviderPluginCustomLink[]
    argMeta: { [key: string]: {[key:string]:string} }
    versionOfPlugin?: string
    updateURL?: string
    enabled?: boolean
    allowedIPC?: string[]
    builtIn?: boolean
}
interface ProviderPluginCustomLink {
    link: string
    hoverText?: string
}

export type RisuPlugin = ProviderPlugin

export const isBuiltInPluginName = (name: string | undefined) =>
    BUILT_IN_PLUGIN_NAMES.has(name?.trim().toLowerCase() ?? '')

/**
 * A built-in that runs for this user. An opt-in built-in the user has not
 * turned on is not "built in" as far as installing or loading is concerned:
 * their own copy of it, if they have one, keeps working exactly as before.
 */
export const isBuiltInPluginActive = (name: string | undefined) =>
    isBuiltInPluginActiveIn(name, getDatabase()?.enabledOptionalBuiltInPlugins)

export async function createBlankPlugin(){
    await importPlugin(
`
//@name New Plugin
//@display-name New Plugin Display Name
//@api 3.0
//@arg example_arg string

Risuai.log("Hello from New Plugin!");
`.trim()
    )
}

const compareVersions = (v1: string, v2: string): 0|1|-1 => {
    const v1parts = v1.split('.').map(Number);
    const v2parts = v2.split('.').map(Number);
    const len = Math.max(v1parts.length, v2parts.length);
    for (let i = 0; i < len; i++) {
        const part1 = v1parts[i] || 0;
        const part2 = v2parts[i] || 0;
        if (part1 > part2) return 1;
        if (part1 < part2) return -1;
    }
    return 0;
}

/**
 * Cache key and lookup key for one *install*.
 *
 * `id` once the plugin has one. The `name:` fallback exists only for the window
 * between reading a pre-identity database and `ensurePluginIdentities` running
 * over it, and is prefixed so it can never collide with a UUID.
 */
export const pluginIdentityKey = (plugin: { id?: string, name: string }): string =>
    plugin.id ? plugin.id : `name:${plugin.name}`

/**
 * Find the installed record for a plugin by identity.
 *
 * Falls back to the name only when the target carries no id at all. It never
 * falls back after an id lookup misses: an id that matches nothing means the
 * install is gone, and answering with a same-named different plugin is exactly
 * the defect this function exists to end.
 */
export function findInstalledPlugin(
    plugins: RisuPlugin[] | undefined,
    target: { id?: string, name: string },
): RisuPlugin | undefined {
    if (!plugins) return undefined
    if (target.id) return plugins.find((candidate) => candidate.id === target.id)
    return plugins.find((candidate) => !candidate.id && candidate.name === target.name)
}

/**
 * Give every installed plugin a stable id, once.
 *
 * Returns the number of records changed so the caller can decide whether a save
 * is owed. It refuses to run while `plugins` is deferred: a deferred key is
 * "not loaded", not "no plugins", and writing an empty/partial list back would
 * destroy the user's plugin list -- the exact way a plugin list has been lost
 * here before.
 */
export function ensurePluginIdentities(plugins: RisuPlugin[] | undefined): number {
    if (isRootKeyDeferred('plugins')) {
        console.warn(
            '[Plugin] plugin identities not assigned: the plugin list exists in storage but is not '
            + 'loaded, and writing to a list that was never read would drop its rows.',
        )
        return 0
    }
    if (!plugins) return 0
    const seen = new Set<string>()
    let changed = 0
    for (const plugin of plugins) {
        // A duplicated id is as ambiguous as no id -- two installs answering to
        // one identity is the same wrong-record lookup by another route -- so
        // the first holder keeps it and any later one is re-minted.
        if (plugin.id && !seen.has(plugin.id)) {
            seen.add(plugin.id)
            continue
        }
        const assigned = v4()
        console.info(`[Plugin] assigned a stable id to "${plugin.name}" (${assigned}).`)
        plugin.id = assigned
        seen.add(assigned)
        changed += 1
    }
    return changed
}

const updateCache = new Map<string, { version: string, updateURL: string } | undefined>();

export const checkPluginUpdate = async (plugin: RisuPlugin) => {
    try {
        if(!plugin.updateURL){
            return
        }

        // Keyed by install identity, not by name: two plugins may briefly share
        // a name across a rename, and a name-keyed cache then answers for the
        // wrong install.
        const cacheKey = pluginIdentityKey(plugin)
        if(updateCache.has(cacheKey)){
            const cached = updateCache.get(cacheKey)
            if(cached
                && cached.updateURL === plugin.updateURL
                && compareVersions(cached.version, plugin.versionOfPlugin || '0.0.0') === 1){
                return cached
            }
        }

        const response = (await fetch(plugin.updateURL, {
            method: 'GET',
            cache: 'no-store',
            headers: {
                'Range': 'bytes=0-512'
            }
        }))

        if(response.status >= 200 && response.status < 300){
            const text = await response.text()
            const versioRegex = /\/\/@version\s+([^\s]+)/;
            const match = text.match(versioRegex);
            if(match && match[1]){
                const latestVersion = match[1].trim()
                if(compareVersions(latestVersion, plugin.versionOfPlugin || '0.0.0') === 1){
                    updateCache.set(cacheKey, {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    })
                    return {
                        version: latestVersion,
                        updateURL: plugin.updateURL
                    }
                }
            }
        }
    } catch (error) {
        console.warn('Failed to check plugin update:', error)
    }
}

export async function updatePlugin(plugin: RisuPlugin): Promise<PluginUpdateResult> {
    // The identity is resolved once, before the download: `plugin` is the
    // caller's record and an update may rename it underneath us.
    const target = { id: plugin.id, name: plugin.name, updateURL: plugin.updateURL }
    const result = await runPluginUpdate(target, {
        fetcher: (url) => fetchNative(url, { method: 'GET' }),
        importer: (source) => importPlugin(source, {
            isUpdate: true,
            originalPluginName: plugin.name,
            originalPluginId: plugin.id,
        }),
        readInstalled: (lookup) => findInstalledPlugin(getDatabase().plugins, lookup),
    })
    if (isPluginUpdateRefusal(result)) {
        console.error(
            `[Plugin] updating "${plugin.name}" did not install anything: `
            + describePluginUpdateFailure(result.failure),
            result.failure.kind === 'threw' ? result.failure.error : undefined,
        )
    } else {
        updateCache.delete(pluginIdentityKey(target))
    }
    return result
}

export async function importPlugin(code:string|null = null, argu:{
    isUpdate?: boolean
    originalPluginName?: string
    /** Identity of the install being updated. Preferred over the name. */
    originalPluginId?: string
    isHotReload?: boolean
    isTypescript?: boolean
} = {}): Promise<PluginImportOutcome> {
    try {
        let jsFile = ''
        let db = getDatabase()
        let isUpdate = argu.isUpdate || false
        let originalPluginName = argu.originalPluginName || ''
        let isTypescript = argu.isTypescript || false
        
        if(!code){
            const f = await selectSingleFile(['js','ts'])
            if (!f) {
                // The user closed the picker. Not a failure, but still not an
                // install, and the caller must be able to tell.
                return { ok: false, reason: 'no file was selected' }
            }
            if(f.name.endsWith('.ts')){
                isTypescript = true
            }
            //support utf-8 with BOM or without BOM
            jsFile = Buffer.from(f.data).toString('utf-8').replace(/^\uFEFF/gm, "");
        }
        else{
            jsFile = code
        }

        const splitedJs = jsFile.split('\n')
        let name = ''
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                name = line.slice(7).trim()
                break
            }
        }

        /**
         * Report a refusal and hand the caller the same words.
         *
         * Returning the outcome (rather than `void`) is what lets
         * `runPluginUpdate` say why an update installed nothing instead of
         * reporting a bare `false`.
         */
        const showError = (msg: string): PluginImportOutcome => {
            if(argu.isHotReload){
                console.error(`Hot-reload plugin "${name}" error: ${msg}`)
            }
            else{
                alertError(msg)
            }
            return { ok: false, reason: msg }
        }

        let displayName: string = undefined
        let arg: { [key: string]: 'int' | 'string' | string[] } = {}
        let realArg: { [key: string]: number | string } = {}
        let argMeta: { [key: string]: {[key:string]:string} } = {}
        let customLink: ProviderPluginCustomLink[] = []
        let updateURL: string = ''
        let versionOfPlugin: string = '' //This is the version of the plugin itself, not the API version
        let apiVersion = '2.0'
        let ipcList: string[] = []
        for (const line of splitedJs) {
            if (line.startsWith('//@name')) {
                const provied = line.slice(7)
                if (provied === '') {
                    return showError('plugin name must be longer than 0, did you put it correctly?')
                }
                name = provied.trim()
            }
            if(line.startsWith('//@api')){
                const proviedVersions = line.slice(6).trim().split(' ')
                const supportedVersions = ['2.0','2.1','3.0']
                for(const ver of proviedVersions){
                    if(supportedVersions.includes(ver)){
                        apiVersion = ver
                        break
                    }
                    else{
                        console.warn(`Plugin API version "${ver}" is not supported.`)
                    }
                }
            }
            if (line.startsWith('//@display-name')) {
                const provied = line.slice('//@display-name'.length + 1)
                if (provied === '') {
                    return showError('plugin display name must be longer than 0, did you put it correctly?')
                }
                displayName = provied.trim()
            }

            if (line.startsWith('//@link')) {
                const link = line.split(" ")[1]
                if (!link || link === '') {
                    return showError('plugin link is empty, did you put it correctly?')
                }
                if (!link.startsWith('https')) {
                    return showError('plugin link must start with https, did you check it?')
                }
                const hoverText = line.split(' ').slice(2).join(' ').trim()
                if (hoverText === '') {
                    // OK, no hover text. It's fine.
                    customLink.push({
                        link: link,
                        hoverText: undefined
                    });
                }
                else
                    customLink.push({
                        link: link,
                        hoverText: hoverText || undefined
                    });
            }
            if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
                const provied = line.trim().split(' ')
                if (provied.length < 3) {
                    return showError('plugin argument is incorrect, did you put space in argument name?')
                }
                const provKey = provied[1]

                if (provied[2] !== 'int' && provied[2] !== 'string') {
                    return showError(`plugin argument type is "${provied[2]}", which is an unknown type.`)
                }
                if (provied[2] === 'int') {
                    arg[provKey] = 'int'
                    realArg[provKey] = 0
                }
                else if (provied[2] === 'string') {
                    arg[provKey] = 'string'
                    realArg[provKey] = ''
                }

                if(provied.length > 3){
                    const meta: {[key:string]:string} = {}
                    //Compatibility layer for unofficial meta
                    let metaStr = provied.slice(3).join(' ').replace(
                        /{{(.+?)(::?(.+?))?}}/g,
                        (a,g1:string,g2,g3:string) => {
                            console.log(g1,g3)
                            meta[g1] = g3 || '1'
                            return ''
                        }
                    ).trim()

                    if(metaStr){
                        meta['description'] = metaStr
                    }

                    argMeta[provKey] = meta
                }
            }

            if(line.startsWith('//@update-url')){
                updateURL = line.split(' ')[1]

                try {
                    const url = new URL(updateURL)
                    if(url.protocol !== 'https:'){
                        return showError('plugin update URL must start with https, did you put it correctly?')
                    }
                } catch (error) {
                    return showError('plugin update URL is not a valid URL, did you put it correctly?')
                }
            }

            if(line.startsWith('//@version')){
                versionOfPlugin = line.split(' ').slice(1).join(' ').trim()

                const versionLocation = jsFile.indexOf('//@version')
                const numberOfBytesBefore = new TextEncoder().encode(jsFile.slice(0, versionLocation) + line).length
                if(numberOfBytesBefore > 500){
                    return showError('plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.')
                }
            }

            if(line.startsWith('//@allowed-ipc')){
                const provied = line.trim().split(' ')
                if(provied.length < 2){
                    return showError('plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?')
                }

                const allowedIPCList = provied.slice(1)

                ipcList.push(...allowedIPCList)
            }
        }

        if (name.length === 0) {
            return showError('plugin name not found, did you put it correctly?')
        }

        // Built-ins are application assets. Importing another copy would make
        // two sandbox instances compete for the same provider/model id, or for
        // the same chat bindings. Keep legacy copies in the database untouched
        // for reversibility, but do not install any new duplicate over the
        // built-in one while it is active.
        if (isBuiltInPluginActive(name)) {
            return showError(`${name} is built in and cannot be installed as a separate plugin.`)
        }

        if(updateURL && versionOfPlugin.length === 0){
            return showError('plugin version not found, did you put it correctly? It is required when update URL is provided.')
        }

        if(versionOfPlugin && compareVersions(versionOfPlugin, '0.0.1') === -1){
            return showError('plugin version must be at least 0.0.1')
        }

        
        if(isTypescript){
            try {
                jsFile = await pluginCodeTranspiler(jsFile)                
            } catch (error) {
                // Installing the untranspiled TypeScript would store a script
                // that cannot run, under a version number that says it can.
                console.error('[Plugin] TypeScript transpilation failed', error)
                return showError('Failed to transpile TypeScript code: ' + error.message)
            }
        }

        let apiInternalVersion: 2|'2.1'|'3.0' = '2.1'

        if(apiVersion === '2.1'){
            const safety = await checkCodeSafety(jsFile)
            if(!safety.isSafe){
                pluginAlertModalStore.errors = safety.errors
                pluginAlertModalStore.open = true
                
                //I can use event but lazy
                while(pluginAlertModalStore.open){
                    await sleep(100)
                }

                if(pluginAlertModalStore.errors.length > 0){
                    return { ok: false, reason: 'the code-safety warnings were not accepted' }
                }
            }
            apiInternalVersion = '2.1'
        }
        else if(apiVersion === '2.0'){
            if(!DBState.db.allowV2Plugin){
                return showError('Your code does not include //@api or specifies API version 2.0, which is outdated. Please update your plugin to use at least API version 2.1.')
            }
            apiInternalVersion = 2
        }
        else if(apiVersion === '3.0'){
            apiInternalVersion = '3.0'
        }

        if(apiInternalVersion !== '3.0' && argu.isHotReload){
            return showError('Only API version 3.0 plugins can be hot-reloaded.')
        }
        
        let pluginData: RisuPlugin = {
            name: name,
            script: jsFile,
            realArg: realArg,
            arguments: arg,
            displayName: displayName,
            version: apiInternalVersion,
            customLink: customLink,
            argMeta: argMeta,
            versionOfPlugin: versionOfPlugin,
            updateURL: updateURL,
            allowedIPC: ipcList,
            enabled: true
        }

        db.plugins ??= []

        // Which installed record is this import for?
        //
        // An explicit update target resolves by IDENTITY, so the source is free
        // to change its `//@name`: that renames one install instead of
        // redirecting the update onto whatever other plugin now answers to the
        // new name -- which is how `risu_multiagent` once received
        // `flashback_memory`. A plain import, and a hot reload (which names no
        // target), still match by name; that is what makes "you already have
        // this plugin, replace it?" work.
        const hasUpdateTarget = !!(argu.originalPluginId || originalPluginName)
        const targeted = hasUpdateTarget
            ? findInstalledPlugin(db.plugins, { id: argu.originalPluginId, name: originalPluginName })
            : undefined
        const oldPluginIndex = hasUpdateTarget
            ? (targeted ? db.plugins.indexOf(targeted) : -1)
            : db.plugins.findIndex((p: RisuPlugin) => p.name === pluginData.name);

        if(hasUpdateTarget && oldPluginIndex === -1){
            return showError(
                `The plugin being updated ("${originalPluginName}") is no longer installed, so nothing was `
                + 'changed. Import it as a new plugin instead.',
            )
        }

        // The name remains the runtime key for permissions, providers and IPC,
        // so two installs must not share one. A rename onto an occupied name is
        // refused rather than silently creating that collision.
        const collidingIndex = db.plugins.findIndex((p: RisuPlugin, index: number) =>
            index !== oldPluginIndex && p.name === pluginData.name)
        if(hasUpdateTarget && collidingIndex !== -1){
            return showError(
                `Updating "${originalPluginName}" would rename it to "${pluginData.name}", which another `
                + 'installed plugin already uses. Nothing was changed.',
            )
        }

        if(!isUpdate && oldPluginIndex !== -1){
            const c = await alertConfirm(language.duplicatePluginFoundUpdateIt)
            if(!c){
                return { ok: false, reason: 'the existing plugin was not replaced' }
            }
        }

        if(oldPluginIndex !== -1){
            // The identity belongs to the install, not to the file, so it is
            // carried across the replacement. Without this every update would
            // mint a new id and the next one would have nothing to resolve by.
            pluginData.id = db.plugins[oldPluginIndex].id ?? v4()
            db.plugins[oldPluginIndex] = pluginData;
        }
        else if(!isUpdate || argu.isHotReload){
            pluginData.id = v4()
            db.plugins.push(pluginData)
        }
        else {
            return showError(
                `"${pluginData.name}" was treated as an update but matches no installed plugin, so nothing `
                + 'was installed.',
            )
        }

        if(argu.isHotReload && !hotReloading.includes(pluginData.name)){
            hotReloading.push(pluginData.name)
        }

        console.log(`Imported plugin: ${pluginData.name} (API v${apiVersion})`)
        setDatabaseLite(db)
        await requestImmediateSave({ flushServer: true, rejectOnFailure: true })

        await loadPlugins()

        return { ok: true }
    } catch (error) {
        console.error(error)
        if (argu.isUpdate) throw error
        alertError(language.errors.noData)
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
}

let pluginTranslator = false

export async function loadPlugins() {
    pluginLoadingStore.set(true)
    pluginReadyStore.set(false)
    pluginStateStore.set('loading')
    try {
    console.log('Loading plugins...')
    let db = getDatabase()

    // Backfill install identities for a database written before they existed.
    // This runs on every load and is a no-op once every record has one; it is
    // deliberately here rather than in a bootstrap step so that a plugin list
    // arriving late (or being replaced by a restore) is covered too. It writes
    // nothing when the plugin list is deferred -- see `ensurePluginIdentities`.
    const identitiesAssigned = ensurePluginIdentities(db.plugins)
    if (identitiesAssigned > 0) {
        console.info(`[Plugin] assigned stable ids to ${identitiesAssigned} plugin(s); saving.`)
        setDatabaseLite(db)
        void requestImmediateSave()
    }

    // Built-ins are code assets, not mutable rows in the user database. This
    // keeps PageFold available in every model selector (main, sub/aux and
    // module-bound plugin requests), and Persona Binder available to a user
    // who turned it on, without duplicating a multi-megabyte bundle in every
    // save or SQL migration. A built-in that fails to load is skipped, not
    // fatal: the user's own plugins must not stay unloaded because of a
    // bundled asset. An opt-in built-in the user has not turned on is not
    // loaded, and an installed copy of it runs as it always did.
    const builtInPlugins = await loadBuiltInPlugins(db.enabledOptionalBuiltInPlugins)
    for (const installed of db.plugins ?? []) {
        if (installed.enabled && isBuiltInPluginActive(installed.name)) {
            console.warn(`[Plugin] Ignoring installed ${installed.name} because the built-in copy is active.`)
        }
    }
    const enabledPlugins = [
        ...builtInPlugins,
        ...safeStructuredClone(db.plugins ?? []).filter((p: RisuPlugin) =>
            p.enabled && !isBuiltInPluginActive(p.name)
        ),
    ]
    // Plugin storage is withheld from the SQL bootstrap, and this is the one
    // place that can load it: the v2 storage API is synchronous and cannot wait
    // for HTTP, so a legacy plugin's storage has to be resident before its first
    // line runs.
    //
    // Deliberately AFTER `enabledPlugins`, not before. Hydrating first meant
    // downloading and parsing the whole map on every launch regardless of what
    // was installed -- hundreds of megabytes for a user with no enabled plugins
    // at all, and for a user whose plugins are all v3 and never touch the
    // synchronous surface. What is needed is decided from `version`, which
    // `importPlugin` records and which is knowable before any plugin executes.
    //
    // A failure is not smoothed over: the key stays deferred, so every storage
    // read a plugin attempts throws instead of reporting an empty map. Plugins
    // that never touch storage still load.
    //
    // Dynamically imported: this module is pulled in by `bootstrap`, which the
    // SQL hydration path reaches back into, and a static edge here closes that
    // cycle.
    if (isRootKeyDeferred('pluginCustomStorage')) {
        const plan = planPluginStorageLoad(enabledPlugins)
        // Per-key mode needs a backend that can serve one row at a time. If it
        // cannot be entered, fall through to the whole-map load rather than
        // leaving v3 plugins with a storage API that has no way to answer.
        const lazy = plan === 'per-key' && tryEnablePerKeyPluginStorage()
        if (!lazy) {
            try {
                const { ensureRootKeyHydrated } = await import('../storage/sql/sqlRuntimeHydration')
                await ensureRootKeyHydrated(db, 'pluginCustomStorage')
            } catch (error) {
                console.error(
                    '[Plugin] could not load pluginCustomStorage. It stays marked as unloaded, so '
                    + 'plugin storage reads will throw rather than report the user\'s stored keys as '
                    + 'missing. Plugins that use storage will fail until it loads.',
                    error,
                )
            }
        } else if (lazy) {
            console.info(
                '[Plugin] every enabled plugin uses the async v3 API, so plugin storage is served '
                + 'one key at a time and the whole map is never loaded.',
            )
        }
    }

    const pluginV2 = enabledPlugins.filter((a: RisuPlugin) => a.version === 2 || a.version === '2.1')
    const pluginV3 = enabledPlugins.filter((a: RisuPlugin) => a.version === '3.0')

    await loadV2Plugin(pluginV2)
    await loadV3Plugins(pluginV3)
    pluginReadyStore.set(true)
    pluginStateStore.set('ready')
    } catch (error) {
        pluginStateStore.set('failed')
        throw error
    } finally {
        pluginLoadingStore.set(false)
    }
}

export type PluginV2ProviderArgument = {
    prompt_chat: OpenAIChat[]
    frequency_penalty: number
    min_p: number
    presence_penalty: number
    repetition_penalty: number
    top_k: number
    top_p: number
    temperature: number
    mode: string
    max_tokens: number
    /** True whenever the caller expects schema-constrained JSON, including prompt-fallback retries. */
    structured_output?: boolean
    /** Native structured output request. Present only for providers that explicitly opt in. */
    response_schema?: PluginProviderStructuredOutput
    /** Host-only, request-scoped route for the bundled PageFold provider. Never persist or log it. */
    pagefold_route?: unknown
}

export type PluginV2ProviderOptions = {
    tokenizer?: string
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>
    /** RisuVault keeps its host status UI by default; set true only when the plugin replaces the host request status UI. */
    overrideRequestStatus?: boolean | (() => boolean | Promise<boolean>)
    /** Legacy inverse switch. Prefer `overrideRequestStatus: true` for plugin-owned status UI. */
    hostRequestStatus?: boolean | (() => boolean | Promise<boolean>)
    /** Plugin storage key whose `risubard` value opts in dynamically. */
    hostRequestStatusStorageKey?: string
    /** Receive response_schema and translate it to the upstream provider's native structured-output format. */
    structuredOutput?: boolean | (() => boolean)
}

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>
type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>

export const pluginV2 = {
    providers: new Map<string, (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>>(),
    /** Trusted handles captured only from bundled providers; unlike `providers`, plugins cannot replace these. */
    builtInProviders: new Map<string, (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string | ReadableStream<string> }>>(),
    providerOptions: new Map<string, PluginV2ProviderOptions>(),
    editdisplay: new Set<EditFunction>(),
    editoutput: new Set<EditFunction>(),
    editprocess: new Set<EditFunction>(),
    editinput: new Set<EditFunction>(),
    replacerbeforeRequest: new Set<ReplacerFunction>(),
    replacerafterRequest: new Set<(content: string, type: string) => string | Promise<string>>(),
    chatOutput: new PluginChatOutputListeners(),
    unload: new Set<() => void | Promise<void>>(),
    loaded: false
}

export const allowedDbKeys = [
    'characters',
    'modules',
    'enabledModules',
    'moduleIntergration',
    'pluginV2',
    'personas',
    'plugins',
    'pluginCustomStorage',
    'temperature',
    'maxContext',
    'maxResponse',
    'frequencyPenalty',
    'PresensePenalty',
    'theme',
    'textTheme',
    'lineHeight',
    'seperateModelsForAxModels',
    'seperateModels',
    'customCSS',
    'guiHTML',
    'colorSchemeName',
    'selectedPersona',
    'characterOrder'
]

export const getV2PluginAPIs = (pluginName = '') => {
    const chatOutputApi = createV2ChatOutputApi(pluginV2.chatOutput)
    return {
        risuFetch: globalFetch,
        nativeFetch: fetchNative,
        getArg: (arg: string) => {
            const db = getDatabase()
            const [name, realArg] = arg.split('::')
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    return plugin.realArg[realArg]
                }
            }
        },
        getChar: () => {
            const character = getCurrentCharacter({ snapshot: true }) as any
            return isPluginCharacterComplete(character) ? character : null
        },
        setChar: (char: any) => {
            const db = getDatabase()
            const charid = get(selectedCharID)
            if (!isPluginCharacterComplete(db.characters[charid])) {
                throw new Error('Character details are still loading')
            }
            db.characters[charid] = char
            setDatabaseLite(db)
        },
        addProvider: (name: string, func: (arg: PluginV2ProviderArgument, abortSignal?: AbortSignal) => Promise<{ success: boolean, content: string }>, options?: PluginV2ProviderOptions) => {
            let provs = get(customProviderStore)
            provs.push(name)
            pluginV2.providers.set(name, func)
            pluginV2.providerOptions.set(name, options ?? {})
            if (pluginName) pluginProviderOwners.set(name, pluginName)
            customProviderStore.set(provs)
        },
        addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].add(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
            if (pluginV2['edit' + name]) {
                pluginV2['edit' + name].delete(func)
            }
            else {
                throw (`script handler named ${name} not found`)
            }
        },
        addRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].add(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        removeRisuReplacer: (name: string, func: ReplacerFunction) => {
            if (pluginV2['replacer' + name]) {
                pluginV2['replacer' + name].delete(func)
            }
            else {
                throw (`replacer handler named ${name} not found`)
            }
        },
        ...chatOutputApi,
        onUnload: (func: () => void | Promise<void>) => {
            pluginV2.unload.add(func)
        },
        setArg: (arg: string, value: string | number) => {
            const db = getDatabase();
            const [name, realArg] = arg.split("::");
            for (const plugin of db.plugins) {
                if (plugin.name === name) {
                    plugin.realArg[realArg] = value;
                }
            }
        },
        safeGlobalThis: {} as any,
        getSafeGlobalThis: () => {
            if(Object.keys(globalThis.__pluginApis__.safeGlobalThis).length > 0){
                return globalThis.__pluginApis__.safeGlobalThis;
            }
            //safeGlobalThis
            const keys = Object.keys(globalThis);
            const safeGlobal: any = {};
            const allowedKeys = [
                'console',
                'TextEncoder',
                'TextDecoder',
                'URL',
                'URLSearchParams',
            ]
            for (const key of keys) {
                if(allowedKeys.includes(key)){
                    safeGlobal[key] = (globalThis as any)[key];
                }
            }

            //compatibility layer with old unsafe APIs

            //from PBV2
            safeGlobal.showDirectoryPicker = window.showDirectoryPicker

            safeGlobal.DBState = {
                db: toGetter(
                    globalThis.__pluginApis__.getDatabase
                )
            }
            safeGlobal.setInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setInterval params causes type mismatch with TimerHandler signature
                return globalThis.setInterval(...args);
            }
            safeGlobal.setTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into setTimeout params causes type mismatch with TimerHandler signature
                return globalThis.setTimeout(...args);
            }
            safeGlobal.clearInterval = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearInterval - first arg should be number | undefined
                return globalThis.clearInterval(...args);
            }
            safeGlobal.clearTimeout = (...args: any[]) => {
                //@ts-expect-error spreading any[] into clearTimeout - first arg should be number | undefined
                return globalThis.clearTimeout(...args);
            }
            safeGlobal.alert = globalThis.alert;
            safeGlobal.confirm = globalThis.confirm;
            safeGlobal.prompt = globalThis.prompt;
            safeGlobal.innerWidth = window.innerWidth;
            safeGlobal.innerHeight = window.innerHeight;
            safeGlobal.getComputedStyle = window.getComputedStyle
            safeGlobal.navigator = window.navigator;
            safeGlobal.localStorage = globalThis.__pluginApis__.safeLocalStorage;
            safeGlobal.indexedDB = globalThis.__pluginApis__.safeIdbFactory;
            safeGlobal.__pluginApis__ = globalThis.__pluginApis__
            safeGlobal.Object = Object;
            safeGlobal.Array = Array;
            safeGlobal.String = String;
            safeGlobal.Number = Number;
            safeGlobal.Boolean = Boolean;
            safeGlobal.Math = Math;
            safeGlobal.Date = Date;
            safeGlobal.RegExp = RegExp;
            safeGlobal.Error = Error;
            safeGlobal.Function = globalThis.__pluginApis__.SafeFunction;
            safeGlobal.document = globalThis.__pluginApis__.safeDocument;
            safeGlobal.addEventListener = (...args: any[]) => {
                //@ts-expect-error spreading any[] into addEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions)
                window.addEventListener(...args);
            }
            safeGlobal.removeEventListener = (...args: any[]) => {
                //@ts-expect-error spreading any[] into removeEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions)
                window.removeEventListener(...args);
            }
            return safeGlobal;
        },
        safeLocalStorage: new SafeLocalStorage(),
        safeIdbFactory: SafeIdbFactory,
        safeDocument: SafeDocument,
        alertStore: {
            set: (msg: string) => {}
        },
        apiVersion: "2.1",
        apiVersionCompatibleWith: ["2.0","2.1"],
        getDatabase: () => {
            const db = DBState?.db
            if(!db){
                return {}
            }
            return new Proxy(db, {
                get(target, prop) {
                    if (prop === 'characters' && hasMetadataOnlyCharacters(target)) return undefined
                    if (prop === 'pluginCustomStorage') assertPluginStorageResident('reading db.pluginCustomStorage')
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        return (target as any)[prop];
                    }
                    // Anything outside `allowedDbKeys` resolves against plugin
                    // storage, so an unloaded map would answer every custom
                    // property with `undefined` — "you never stored this".
                    assertPluginStorageResident(`reading db.${prop.toString()}`)
                    if(target.pluginCustomStorage){
                        console.log('Getting custom db property', prop.toString());
                        return target.pluginCustomStorage[prop.toString()];
                    }
                    return undefined;
                },
                set(target, prop, value) {
                    if (prop === 'characters' && hasMetadataOnlyCharacters(target)) throw new Error('Character details are still loading')
                    if (prop === 'pluginCustomStorage') assertPluginStorageResident('replacing db.pluginCustomStorage')
                    if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
                        (target as any)[prop] = value;
                        return true;
                    }
                    else{
                        // Writing into a map that is still being withheld would
                        // be overwritten by the pending load, silently losing
                        // the write.
                        assertPluginStorageResident(`writing db.${prop.toString()}`)
                        console.log('Setting custom db property', prop.toString(), value);
                        target.pluginCustomStorage ??= {}
                        target.pluginCustomStorage[prop.toString()] = value;
                        markSqlPluginStorageDirty(prop.toString())
                        return true;
                    }
                },
                ownKeys(target) {
                    // Enumeration must be complete or refused: a short key list
                    // reads as "these are all the keys there are".
                    assertPluginStorageResident('enumerating db keys')
                    const keys = Reflect.ownKeys(target).filter(key => typeof key === 'string' && allowedDbKeys.includes(key) && !(key === 'characters' && hasMetadataOnlyCharacters(target)));
                    if(target.pluginCustomStorage){
                        keys.push(...Object.keys(target.pluginCustomStorage));
                    }
                    return keys;
                },
                deleteProperty(target, prop) {
                    console.log('Attempt to delete db.' + String(prop) + ' denied in safe database proxy.');
                    return false;
                },
                getPrototypeOf(target) {
                    return Reflect.getPrototypeOf(target);
                },
            })
        },
        pluginStorage: {
            getItem: (key: string) => {
                assertPluginStorageResident(`pluginStorage.getItem(${JSON.stringify(key)})`);
                const db = getDatabase({ snapshot: true });
                db.pluginCustomStorage ??= {}
                return db.pluginCustomStorage[key] || null;
            },
            setItem: (key: string, value: string) => {
                assertPluginStorageResident(`pluginStorage.setItem(${JSON.stringify(key)})`);
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                db.pluginCustomStorage[key] = value;
                markSqlPluginStorageDirty(key)
            },
            removeItem: (key: string) => {
                assertPluginStorageResident(`pluginStorage.removeItem(${JSON.stringify(key)})`);
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                delete db.pluginCustomStorage[key];
                markSqlPluginStorageDirty(key)
            },
            clear: () => {
                assertPluginStorageResident('pluginStorage.clear()');
                const db = getDatabase();
                // Marked BEFORE the map is replaced. Afterwards there is
                // nothing left to enumerate, and a key nobody marked is a row
                // the commit builder never visits -- the clear would look like
                // it worked and leave every row in SQLite.
                for (const key of Object.keys(db.pluginCustomStorage ?? {})) markSqlPluginStorageDirty(key)
                db.pluginCustomStorage = {};
            },
            key: (index: number) => {
                assertPluginStorageResident(`pluginStorage.key(${index})`);
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                const keys = Object.keys(db.pluginCustomStorage);
                return keys[index] || null;
            },
            keys: () => {
                assertPluginStorageResident('pluginStorage.keys()');
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                return Object.keys(db.pluginCustomStorage);
            },
            length: () => {
                assertPluginStorageResident('pluginStorage.length()');
                const db = getDatabase();
                db.pluginCustomStorage ??= {}
                return Object.keys(db.pluginCustomStorage).length;
            }
        },
        setDatabaseLite: (newDb: any) => {
            const db = getDatabase();
            if ('characters' in newDb && hasMetadataOnlyCharacters(db)) throw new Error('Character details are still loading')
            // Only a key outside the allowed list lands in plugin storage, so
            // only such a key needs the map -- or, in per-key mode, the lazy
            // writer. A write of `personas` alone must not be refused because
            // the map was never loaded; that is what stopped Persona Binder
            // from saving a persona on every install where every plugin is v3.
            const storageKeys = Object.keys(newDb).filter(key => !allowedDbKeys.includes(key))
            const lazy = storageKeys.length > 0 && isPluginStoragePerKeyMode()
            if (storageKeys.length > 0 && !lazy) assertPluginStorageResident('setDatabaseLite');
            for (const key of Object.keys(newDb)) {
                if (allowedDbKeys.includes(key)) {
                    (db as any)[key] = newDb[key];
                }
                else if (lazy) {
                    writePluginStorageKeyLazily(key, newDb[key])
                }
                else{
                    db.pluginCustomStorage ??= {}
                    db.pluginCustomStorage[key] = newDb[key];
                    markSqlPluginStorageDirty(key)
                }
            }
            DBState.db = db;
        },
        setDatabase: async (newDb: any) => {
            const db = getDatabase();
            if ('characters' in newDb && hasMetadataOnlyCharacters(db)) throw new Error('Character details are still loading')
            // Same rule as setDatabaseLite above.
            const storageKeys = Object.keys(newDb).filter(key => !allowedDbKeys.includes(key))
            const lazy = storageKeys.length > 0 && isPluginStoragePerKeyMode()
            if (storageKeys.length > 0 && !lazy) assertPluginStorageResident('setDatabase');
            for (const key of Object.keys(newDb)) {
                if (key === 'plugins') {
                    console.warn('[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.')
                    newDb[key] = await handlePluginInstallViaPlugin(newDb.plugins)
                }
                
                if (allowedDbKeys.includes(key)) {
                    (db as any)[key] = newDb[key];
                }
                else if (lazy) {
                    writePluginStorageKeyLazily(key, newDb[key])
                }
                else{
                    db.pluginCustomStorage ??= {}
                    db.pluginCustomStorage[key] = newDb[key];
                    markSqlPluginStorageDirty(key)
                }
            }
            setDatabase(db);
        },
        SafeFunction: new Proxy(Function, {
            construct(target, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            },
            
            //call too
            apply(target, thisArg, args) {
                return function() {
                    return globalThis.__pluginApis__.getSafeGlobalThis();
                }
            }

        }),
        loadPlugins: loadPlugins,
        readImage: (path:string) => {
            if(path.startsWith('assets/')){
                //trim assets/ prefix temporarily
                path = path.slice(7);
            }
            if(path.includes('/') || path.includes('\\')){
                throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.");
            }
            //re-add assets/ prefix
            return readImage('assets/' + path);
        },
        saveAsset: (data:Uint8Array) => {
            return saveAsset(data);
        },

    }
}

export async function loadV2Plugin(plugins: RisuPlugin[]) {

    if (pluginV2.loaded) {
        for (const unload of pluginV2.unload) {
            await unload()
        }

        pluginV2.providers.clear()
        pluginV2.builtInProviders.clear()
        pluginV2.editdisplay.clear()
        pluginV2.editoutput.clear()
        pluginV2.editprocess.clear()
        pluginV2.editinput.clear()
        pluginV2.chatOutput.clear(V2_CHAT_OUTPUT_OWNER)
    }

    pluginV2.loaded = true

    globalThis.__pluginApis__ = getV2PluginAPIs()

    for (const plugin of plugins) {
        globalThis.__pluginApis__ = getV2PluginAPIs(plugin.name)
        let data = ''
        let version = plugin.version || 2

        const createRealScript = (data:string): string => {
            const tt = (window as unknown as Window & {
                trustedTypes?: {
                    createPolicy: (name: string, rules: { createScript: (input: string) => string }) => { createScript: (input: string) => string }
                }
            }).trustedTypes
            const policyFactory = tt ?? {
                createPolicy: (_name: string, rules: { createScript: (input: string) => string }) => rules // Just return the rules object as the "policy"
            }

            const policy = policyFactory.createPolicy('plugin-policy', {
                createScript: (_input) => {
                    return `(async () => {
                        const risuFetch = globalThis.__pluginApis__.risuFetch
                        const nativeFetch = globalThis.__pluginApis__.nativeFetch
                        const getArg = globalThis.__pluginApis__.getArg
                        const printLog = globalThis.__pluginApis__.printLog
                        const getChar = globalThis.__pluginApis__.getChar
                        const setChar = globalThis.__pluginApis__.setChar
                        const addProvider = globalThis.__pluginApis__.addProvider
                        const addRisuScriptHandler = globalThis.__pluginApis__.addRisuScriptHandler
                        const removeRisuScriptHandler = globalThis.__pluginApis__.removeRisuScriptHandler
                        const addRisuReplacer = globalThis.__pluginApis__.addRisuReplacer
                        const removeRisuReplacer = globalThis.__pluginApis__.removeRisuReplacer
                        const onUnload = globalThis.__pluginApis__.onUnload
                        const setArg = globalThis.__pluginApis__.setArg
                        const saveAsset = globalThis.__pluginApis__.saveAsset
                        const readImage = globalThis.__pluginApis__.readImage
                        ${version === '2.1' ? `
                            const safeGlobalThis = globalThis.__pluginApis__.getSafeGlobalThis()
                            const Risuai = globalThis.__pluginApis__
                            const safeLocalStorage = globalThis.__pluginApis__.safeLocalStorage
                            const safeIdbFactory = globalThis.__pluginApis__.safeIdbFactory
                            const alertStore = globalThis.__pluginApis__.alertStore
                            const safeDocument = globalThis.__pluginApis__.safeDocument
                            const getDatabase = globalThis.__pluginApis__.getDatabase
                            const setDatabaseLite = globalThis.__pluginApis__.setDatabaseLite
                            const setDatabase = globalThis.__pluginApis__.setDatabase
                            const loadPlugins = globalThis.__pluginApis__.loadPlugins
                            const SafeFunction = globalThis.__pluginApis__.SafeFunction
                        ` : ''}

                        ${data}
                    })();`
                }
            });

            return policy.createScript(data);
        }

        if(version === '2.1'){
            const safety = (await checkCodeSafety(plugin.script))
            data = safety.modifiedCode
            console.log('Safety check result:', safety)
            console.log('Loading V2.1 Plugin', plugin.name, data)

            try {
                new Function(createRealScript(data))()
            } catch (error) {
                console.error(error)
            }

            console.log('Loaded V2.1 Plugin', plugin.name)
        }
        else{
            data = plugin.script
            console.log('Loading V2.0 Plugin', plugin.name)

            if(DBState.db.allowV2Plugin){
                try {
                    new Function(createRealScript(data))()
                } catch (error) {
                    console.error(error)
                }

                console.warn(`Plugin 2.0 support is deprecated and disabled by default. Please update plugin "${plugin.name}" to API version 3.0`)
            }
            else{
                console.warn(`Plugin 2.0 is disabled by default. Enable deprecated V2.0 plugin support in advanced settings to run plugin "${plugin.name}", and please update it to API version 3.0`)
            }
        }
    }
}

export async function translatorPlugin(text: string, from: string, to: string) {
    return false
}

export async function pluginProcess(arg: {
    prompt_chat: OpenAIChat,
    temperature: number,
    max_tokens: number,
    presence_penalty: number
    frequency_penalty: number
    bias: { [key: string]: string }
} | {}) {
    return {
        success: false,
        content: language.pluginProviderNotFound
    }
}

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[]){

    const trimmedPlugins: RisuPlugin[] = []
    for(const plugin of plugins){
        if(!DBState.db.plugins.find((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)){

            if(plugin.version !== '3.0'){
                console.warn(`Plugin "${plugin.name}" has version "${plugin.version}", which is not supported for installation via plugin. Only API version 3.0 plugins can be installed via plugin. Skipping installation of this plugin.`)
                continue
            }
            const confirmation = await alertConfirm(language.confirmInstallPluginViaPlugin.replace('{plugin}', plugin.name))
            if(confirmation){
                trimmedPlugins.push(plugin)
            }
        }
        else{
            console.warn(`Plugin "${plugin.name}" already exists, skipping installation via plugin.`)
        }
    }

    return trimmedPlugins
}
