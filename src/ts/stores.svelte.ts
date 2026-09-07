import { writable } from "svelte/store";
import type { character, Database } from "./storage/database.svelte";
import { type simpleCharacterArgument } from "./parser/parser.svelte";
import type { alertData } from "./alert";
import { moduleUpdate } from "./process/modules";
import { deepTouch } from "./gui/deepTouch.svelte";
import { resetScriptCache } from "./process/scripts";
import type { hubType } from "./characterCards";
import type { PluginSafetyErrors } from "./plugins/pluginSafety";
import type { PersonaSelection } from "./personaScopes";
import { bumpMessageReloadPointer, messageReloadKey, type MessageReloadPointers } from "./reloadChatPointer";

function updateSize(){
    SizeStore.set({
        w: window.innerWidth,
        h: window.innerHeight
    })
    DynamicGUI.set(window.innerWidth <= 1024)
}

export const SizeStore = writable({
    w: 0,
    h: 0
})

export const loadedStore = writable(false)
export const isTouchDevice = writable(typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
export const DynamicGUI = writable(false)
export const sideBarClosing = writable(false)
export const sideBarStore = writable(window.innerWidth > 1024)
export const leftBarCollapsed = writable(false)
export const selectedCharID = writable(-1)
export const chatDeselected = writable(false)
export const CurrentTriggerIdStore = writable<string | null>(null)
export const CharEmotion = writable({} as {[key:string]: [string, string, number][]})
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }); // Default width and height in pixels
export const settingsOpen = writable(false)
export const botMakerMode = writable(false)
export const moduleBackgroundEmbedding = writable('')
export const openPresetList = writable(false)
export const presetSelectCallback = writable<((index: number) => void) | null>(null)
export const presetSelectActiveId = writable<string | null>(null)
export const openModelPresetList = writable(false)
export const modelPresetSelectCallback = writable<((id: string) => void) | null>(null)
export const openModelProfileBrowser = writable(false)
// When set to a preset id, the profile browser replaces that preset's profile
// (migrating matching userValues) instead of creating a new preset. null = create.
export const modelProfileReplaceTarget = writable<string | null>(null)
// Set to a newly-created preset id so the ModelPreset settings page opens it
// for editing immediately. Consumed (cleared) by ModelPresetSettings.
export const openModelPresetEditId = writable<string | null>(null)
export const openModuleListStore = writable(false)
export const openThemePresetList = writable(false)
export const openPersonaList = writable(false)
export const openPersonaManager = writable(false)
export const characterVaultOpen = writable(false)
export const personaSelectCallback = writable<((selection: PersonaSelection) => void) | null>(null)
export const openHypaV3PresetList = writable(false)
export const bookmarkListOpen = writable(false)
export const MobileGUI = writable(false)
export const MobileGUIStack = writable(0)
export const MobileSideBar = writable(0)
export const SettingsMenuIndex = writable(-1)
// Boot-time backup reminder prompt — set by bootstrap and rendered by
// BootBackupPrompt. The component resolves the user's choice (proceed/skip)
// back via the resolve callback. See src/ts/bootstrap.ts.
export interface BootBackupPromptData {
    estimate: number | null
    free: number | null
    total: number | null
    insufficient: boolean
    resolve: (proceed: boolean) => void
}
export const bootBackupPromptStore = writable<BootBackupPromptData | null>(null)

// Sub-tab index inside the System settings page. Exposed as a store so
// other pages can deep-link via openSettings(SettingsRoute.System,
// SystemTab.X) — see src/ts/routing.
export const SystemSubmenuIndex = writable(0)
// Sub-tab index inside the Accessibility settings page. A store so the model-
// mode gear button can deep-link to the Sidebar tab — see src/ts/routing
// (AccessibilityTab) and Setting/Pages/AccessibilitySettings.svelte.
export const AccessibilitySubmenuIndex = writable(0)
// Sub-tab indices for the remaining tabbed settings pages. Stores (instead of
// page-local $state) so the settings search can deep-link to a specific tab —
// see src/ts/setting/searchIndex.ts (navigateToSearchResult).
export const DisplaySubmenuIndex = writable(0)
export const BotSubmenuIndex = writable(0)
export const PromptPresetSubmenuIndex = writable(0)
export const AdvancedSubmenuIndex = writable(0)
export const OtherBotsSubmenuIndex = writable(0)
export const InlayGallerySubmenuIndex = writable(0)
// List-view tab of the Model Preset page (Presets / API keys / Options).
// Distinct from the editor's own sub-tabs, which stay page-local.
export const ModelPresetListTabIndex = writable(0)
export const ReloadGUIPointer = writable(0)
export const ReloadChatPointer = writable({} as MessageReloadPointers)
export const ScrollToMessageStore = $state({ value: -1 })
export const OpenRealmStore = writable(false)
export const RealmInitialOpenChar = writable<null | hubType>(null)
export const PlaygroundStore = writable(0)
export const HideIconStore = writable(false)
export const CustomCSSStore = writable('')
export const SafeModeStore = writable(false)
export const MobileSearch = writable('')
export const CharConfigSubMenu = writable(0)
export const alertStore = writable({
    type: 'none',
    msg: 'n',
} as alertData)
export const hypaV3ModalOpen = writable(false)
// Toggle preset selector lives outside alertStore so child alertConfirm /
// alertInput overlays can layer on top of it without overwriting state.
export const togglePresetsOpenStore = writable(false)
export const hypaV3ProgressStore = writable({
    open: false,
    miniMsg: '',
    msg: '',
    subMsg: '',
})
export const selIdState = $state({
    selId: -1
})


CustomCSSStore.subscribe((css) => {
    console.log(css)
    const q = document.querySelector('#customcss')
    if(q){
        q.innerHTML = css
    }
    else{
        const s = document.createElement('style')
        s.id = 'customcss'
        s.innerHTML = css
        document.body.appendChild(s)
    }
})

export function createSimpleCharacter(char:character){
    if(!char){
        return null
    }

    const simpleChar:simpleCharacterArgument = {
        type: "simple",
        customscript: char.customscript,
        chaId: char.chaId,
        additionalAssets: char.additionalAssets,
        virtualscript: char.virtualscript,
        emotionImages: char.emotionImages,
        triggerscript: char.triggerscript,
    }

    return simpleChar

}

updateSize()
window.addEventListener("resize", updateSize);
export const DBState = $state({
    db: {} as any as Database
});

/** Stable row invalidation. Numeric indexes become stale whenever a page prepends. */
export function bumpReloadChatPointer(messageId: string | null | undefined): void {
    ReloadChatPointer.update((pointers) => bumpMessageReloadPointer(pointers, messageId ?? null))
}

/** Compatibility entry point for script APIs that still receive an index. */
export function bumpActiveChatReloadAt(index: number): void {
    const current = DBState.db.characters[selIdState.selId]?.chats?.[DBState.db.characters[selIdState.selId]?.chatPage]
    bumpReloadChatPointer(messageReloadKey(current?.message[index] ?? {}))
}

export const LoadingStatusState = $state({
    text: '',
})

export const loadingOverlayStore = writable<{
    active: boolean,
    text: string,
    onCancel?: (() => void) | null,
}>({
    active: false,
    text: '',
    onCancel: null,
})

export const QuickSettings = $state({
    open: false,
    index: 0
})

export const pluginAlertModalStore = $state({
    open: false,
    errors: [] as PluginSafetyErrors[]
})

export const disableHighlight = writable(true)

export type MenuDef = {
    name: string,
    icon: string,
    iconType:'html'|'img'|'none',
    callback: any,
    id: string,
    pluginName: string,
    layoutKey?: string,
}

export type ChatPanelDef = {
    id: string,
    pluginName: string,
    html: string,
    className?: string,
}

export const additionalSettingsMenu = $state([] as MenuDef[])
export const additionalFloatingActionButtons = $state([] as MenuDef[])
export const additionalHamburgerMenu = $state([] as MenuDef[])
export const additionalChatMenu = $state([] as MenuDef[])
export const chatPanelStore = $state([] as ChatPanelDef[])
export const bodyIntercepterStore = $state([] as {
    id: string,
    callback: (body: any, type: string) => Promise<any>
}[])
export const popupStore = $state({
    children: null as null | import("svelte").Snippet,
    mouseX: 0,
    mouseY: 0,
    openId: 0,
})

export const popUpEditorStore = $state({
    open: false,
    value: '',
    mode: 'default' as 'default',
    language: 'markdown' as string
})

//Set might be more ideal, however since Svelte doesn't support reactive Sets, using array for now
export const hotReloading = $state<string[]>([])

ReloadGUIPointer.subscribe(() => {
    ReloadChatPointer.set({})
    resetScriptCache()
})

$effect.root(() => {
    selectedCharID.subscribe((v) => {
        selIdState.selId = v

        if (DBState?.db?.characters?.[selIdState.selId]) {
            if (DBState.db.hypaV3 && DBState.db.hypaV3Presets?.[DBState.db.hypaV3PresetId]?.settings?.alwaysToggleOn) {
                const char = DBState.db.characters[selIdState.selId]
                if (char?.chats?.[char.chatPage]) {
                    char.chats[char.chatPage].supaMemory = true
                }
            }
        }
    })
    $effect(() => {
        try { deepTouch(DBState.db.modules) } catch (e) {
            console.warn('[ModuleUpdate] deepTouch(modules) failed:', e)
            return
        }
        DBState?.db?.enabledModules
        DBState?.db?.enabledModules?.length
        DBState?.db?.characters?.[selIdState.selId]?.chats?.[DBState?.db?.characters?.[selIdState.selId]?.chatPage]?.modules?.length
        DBState?.db?.characters?.[selIdState.selId]?.hideChatIcon
        DBState?.db?.characters?.[selIdState.selId]?.backgroundHTML
        DBState?.db?.moduleIntergration
        // This effect runs synchronously inside the `$effect.root` above, during
        // this module's own body -- before boot, before any test, and before
        // anything has installed a database. `DBState.db` is still the `{}`
        // placeholder declared above at that point, and `moduleUpdate()` reaches
        // it only through `database.svelte`'s accessors. Two separate problems
        // come out of that, and the marker below covers both.
        //
        // Under Vite's SSR transform -- what vitest runs, and only vitest -- a
        // module graph that reaches `database.svelte` before this module leaves
        // it suspended at its hoisted `await __vite_ssr_import__` for
        // `stores.svelte`. The transform gives each importer its own
        // `const __vite_ssr_import_N__` for that edge, so while `database.svelte`
        // is parked mid-await its const is in TDZ and `getDatabase()` throws
        // `ReferenceError: Cannot access '__vite_ssr_import_35__' before
        // initialization`. Nothing catches it: `getModules()` calls
        // `getCurrentChat()` and `getCurrentCharacter()` unguarded. 17 test files
        // entered the cycle in that order and each raised one unhandled error,
        // failing the run at exit code 1 with every test passing. The browser
        // build has no such intermediate const -- `DBState` and this effect share
        // a module body, so the same cycle resolves without a TDZ in any bundle
        // order, which is why the application never saw this.
        //
        // Independently of module systems, running on the placeholder is not
        // inert. `getCurrentCharacter()` fills in `db.characters = []` on
        // whatever object it is handed, so an early run stamps the placeholder
        // with the very field `resolveLiveDatabase()` reads to tell an installed
        // graph apart from the placeholder (see `storage/sql/liveDatabase.ts`).
        //
        // `characters` is therefore the marker here too, and `setDatabase`
        // guarantees it -- it is the first field that function fills in -- so the
        // guard opens for every installed database and closes for nothing else.
        // Every dependency this effect needs is read above, before the return,
        // and `setDatabaseLite` replaces `DBState.db` wholesale, so the effect
        // re-runs and `moduleUpdate()` fires the moment there is a database to
        // read -- and on every later change to modules, the enabled set, the
        // chat's module list or `moduleIntergration`, exactly as before.
        if(!Array.isArray(DBState?.db?.characters)){
            return
        }
        moduleUpdate()
    })
})
