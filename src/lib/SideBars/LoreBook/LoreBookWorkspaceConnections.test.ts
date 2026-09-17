import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { loreBook } from 'src/ts/storage/database.svelte'
import {
    coreLorebookScopeKey,
    createCharacterLocalActivationBinding,
    createLorebookOwnerBinding,
    ensureGlobalLorebookPageIds,
    ensureStableLorebookOwnerId,
    importLorebooksIntoModule,
    loremasterDisabledBackupKey,
    readLoremasterDisabledBackups,
    resolveCharacterGlobalLoreLabel,
} from './loreBookWorkspaceConnections'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

const settingSource = source('src/lib/SideBars/LoreBook/LoreBookSetting.svelte')
const globalSource = source('src/lib/Setting/Pages/GlobalLoreBookSettings.svelte')
const moduleSource = source('src/lib/Setting/Pages/Module/ModuleMenu.svelte')
const connectionSource = source('src/lib/SideBars/LoreBook/loreBookWorkspaceConnections.ts')
const coreSource = source('src/ts/process/lorebook.svelte.ts')
const databaseSource = source('src/ts/storage/database.svelte.ts')
const globalListSource = source('src/lib/Setting/lorepreset.svelte')

describe('lorebook workspace connection identities', () => {
    it('activates and deactivates a global entry in the captured current chat with legacy fields intact', () => {
        const chatA = { localLore: [] as loreBook[] }
        const chatB = { localLore: [] as loreBook[] }
        const character = { chats: [chatA, chatB] }
        let liveChat = chatA
        const bindingForLiveChat = () => createCharacterLocalActivationBinding(
            character,
            liveChat,
            true,
            () => [character],
        )
        const bindingA = bindingForLiveChat()
        liveChat = chatB
        const bindingB = bindingForLiveChat()
        const globalEntry = { id: 'global-entry' } as loreBook

        bindingA.onToggle(globalEntry, true)
        expect(chatA.localLore).toEqual([{
            key: '',
            comment: '',
            content: '',
            mode: 'child',
            insertorder: 100,
            alwaysActive: true,
            secondkey: '',
            selective: false,
            id: 'global-entry',
        }])
        expect(chatB.localLore).toEqual([])
        expect(bindingA.isActive(globalEntry)).toBe(true)
        expect(bindingB.isActive(globalEntry)).toBe(false)

        bindingA.onToggle(globalEntry, false)
        expect(chatA.localLore).toEqual([])
        expect(chatB.localLore).toEqual([])
    })

    it('cleans removed global child links from every captured character chat only', () => {
        const removed = { id: 'removed', mode: 'child' } as loreBook
        const unrelated = { id: 'unrelated', mode: 'child' } as loreBook
        const sameIdNormal = { id: 'removed', mode: 'normal' } as loreBook
        const chatA = { localLore: [removed, unrelated, sameIdNormal] }
        const chatB = { localLore: [{ ...removed }, { ...unrelated }] }
        const character = { chats: [chatA, chatB] }
        const binding = createCharacterLocalActivationBinding(
            character,
            chatA,
            true,
            () => [character],
        )

        binding.onEntriesRemoved?.(['removed'])

        expect(chatA.localLore).toEqual([unrelated, sameIdNormal])
        expect(chatB.localLore).toEqual([{ ...unrelated }])
    })

    it('makes local activation callbacks no-op after the captured character is removed', () => {
        const chat = { localLore: [] as loreBook[] }
        const character = { chats: [chat] }
        const characters = [character]
        const binding = createCharacterLocalActivationBinding(
            character,
            chat,
            true,
            () => characters,
        )
        characters.splice(0, 1)

        binding.onToggle({ id: 'ignored' } as loreBook, true)
        binding.onEntriesRemoved?.(['ignored'])

        expect(chat.localLore).toEqual([])
    })

    it.each([
        ['character', 'globalLore'],
        ['chat', 'localLore'],
        ['global page', 'data'],
        ['module', 'lorebook'],
    ] as const)('keeps an old %s callback bound to its lexical owner', (_scope, field) => {
        type Owner = Record<typeof field, loreBook[]>
        const original = [{ id: 'original' } as loreBook]
        const replacement = [{ id: 'replacement' } as loreBook]
        const ownerA = { [field]: original } as Owner
        const ownerB = { [field]: [{ id: 'owner-b' } as loreBook] } as Owner
        let liveSelection = ownerA
        const bindingForLiveSelection = () => {
            const owner = liveSelection
            return createLorebookOwnerBinding(
                owner,
                owner[field],
                (capturedOwner, next) => { capturedOwner[field] = next },
            )
        }

        const oldBinding = bindingForLiveSelection()
        liveSelection = ownerB
        const newBinding = bindingForLiveSelection()
        oldBinding.onChange(replacement)

        expect(oldBinding.owner).toBe(ownerA)
        expect(newBinding.owner).toBe(ownerB)
        expect(ownerA[field]).toBe(replacement)
        expect(ownerB[field].map((entry) => entry.id)).toEqual(['owner-b'])
    })

    it('turns an old callback into a no-op after its owner is removed', () => {
        const owner = { data: [{ id: 'original' } as loreBook] }
        const owners = [owner]
        const binding = createLorebookOwnerBinding(
            owner,
            owner.data,
            (capturedOwner, next) => { capturedOwner.data = next },
            (capturedOwner) => owners.includes(capturedOwner),
        )
        owners.splice(0, 1)

        binding.onChange([{ id: 'ignored' } as loreBook])

        expect(owner.data.map((entry) => entry.id)).toEqual(['original'])
    })

    it('creates distinct stable keys from each owning scope identity', () => {
        expect(coreLorebookScopeKey({ kind: 'character', chaId: 'char-a' }))
            .toBe(JSON.stringify(['lorebook', 'character', 'char-a']))
        expect(coreLorebookScopeKey({ kind: 'chat', chaId: 'char-a', chatId: 'chat-b' }))
            .toBe(JSON.stringify(['lorebook', 'chat', 'char-a', 'chat-b']))
        expect(coreLorebookScopeKey({ kind: 'global-page', pageId: 'page-3' }))
            .toBe(JSON.stringify(['lorebook', 'global-page', 'page-3']))
        expect(coreLorebookScopeKey({ kind: 'module', moduleId: 'module-c' }))
            .toBe(JSON.stringify(['lorebook', 'module', 'module-c']))
    })

    it('encodes tuple parts injectively and returns the same key for the same IDs', () => {
        const left = coreLorebookScopeKey({ kind: 'chat', chaId: 'a:b', chatId: 'c' })
        const right = coreLorebookScopeKey({ kind: 'chat', chaId: 'a', chatId: 'b:c' })
        expect(left).not.toBe(right)
        expect(coreLorebookScopeKey({ kind: 'chat', chaId: 'a:b', chatId: 'c' })).toBe(left)
    })

    it('persists missing owner IDs once and keeps global-page identity across reorder', () => {
        const ids = ['created-chat', 'created-page']
        const createId = () => ids.shift()!
        const chat: { id?: string } = {}
        expect(ensureStableLorebookOwnerId(chat, createId)).toBe('created-chat')
        expect(ensureStableLorebookOwnerId(chat, createId)).toBe('created-chat')

        const pages = [
            { name: 'Legacy', data: [] as loreBook[] },
            { id: 'kept-page', name: 'Kept', data: [] as loreBook[] },
        ]
        ensureGlobalLorebookPageIds(pages, createId)
        const before = pages.map((page) => coreLorebookScopeKey({
            kind: 'global-page',
            pageId: page.id!,
        }))
        pages.reverse()
        const after = pages.map((page) => coreLorebookScopeKey({
            kind: 'global-page',
            pageId: page.id!,
        }))
        expect(after).toEqual(before.reverse())
        expect(pages.find((page) => page.name === 'Kept')?.id).toBe('kept-page')
    })

    it('appends module imports to the captured owner current lore after the picker resolves', async () => {
        const picker = deferred<Array<{ data: Uint8Array }>>()
        const target = { id: 'module-a', lorebook: [{ id: 'old' } as loreBook] }
        let current = target
        const pending = importLorebooksIntoModule(
            target,
            () => current,
            () => picker.promise,
            () => [{ id: 'imported' } as loreBook],
        )
        target.lorebook = [{ id: 'concurrent' } as loreBook]
        picker.resolve([{ data: new Uint8Array() }])
        expect(await pending).toBe(true)
        expect(target.lorebook.map((entry) => entry.id)).toEqual(['concurrent', 'imported'])

        const nextPicker = deferred<Array<{ data: Uint8Array }>>()
        const other = { id: 'module-b', lorebook: [] as loreBook[] }
        const aborted = importLorebooksIntoModule(
            target,
            () => current,
            () => nextPicker.promise,
            () => [{ id: 'wrong-owner' } as loreBook],
        )
        current = other
        nextPicker.resolve([{ data: new Uint8Array() }])
        expect(await aborted).toBe(false)
        expect(other.lorebook).toEqual([])
        expect(target.lorebook.map((entry) => entry.id)).toEqual(['concurrent', 'imported'])
    })

    it('reads only the exact current-scope Loremaster backup and keeps it intact', () => {
        const characterKey = loremasterDisabledBackupKey({
            kind: 'character',
            chaId: 'char-a',
        })
        const chatKey = loremasterDisabledBackupKey({
            kind: 'chat',
            chaId: 'char-a',
            chatId: 'chat-b',
        })
        expect(characterKey).toBe('loremaster:disabled:character:char-a')
        expect(chatKey).toBe('loremaster:disabled:chat:char-a:chat-b')

        const characterBackup = { lore: { id: 'character-lore' } as loreBook }
        const chatBackup = { lore: { id: 'chat-lore' } as loreBook }
        const storage = {
            [characterKey]: characterBackup,
            [chatKey]: chatBackup,
            'loremaster:disabled:chat:other:scope': { unrelated: true },
        }

        expect(readLoremasterDisabledBackups(storage, characterKey)).toBe(characterBackup)
        expect(readLoremasterDisabledBackups(storage, chatKey)).toBe(chatBackup)
        expect(Object.keys(storage)).toContain(characterKey)
        expect(Object.keys(storage)).toContain(chatKey)
    })

    it('resolves local child links from the current character global lore name', () => {
        const entries = [
            { id: 'comment', comment: 'Library', key: 'books' },
            { id: 'key', comment: ' ', key: 'places' },
            { id: 'empty', comment: ' ', key: ' ' },
        ] as loreBook[]
        expect(resolveCharacterGlobalLoreLabel(entries, 'comment')).toBe('Library')
        expect(resolveCharacterGlobalLoreLabel(entries, 'key')).toBe('places')
        expect(resolveCharacterGlobalLoreLabel(entries, 'empty')).toBeUndefined()
        expect(resolveCharacterGlobalLoreLabel(entries, 'missing')).toBeUndefined()
    })
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

describe('lorebook workspace source connections', () => {
    it('keeps the sidebar editor while offering the shared workspace for every source', () => {
        for (const value of [settingSource, globalSource, moduleSource]) {
            expect(value).toContain('LoreBookWorkspaceDialog')
        }
        expect(settingSource).toContain('LoreBookList')
        expect(globalSource).not.toContain('LoreBookList')
        expect(moduleSource).not.toContain('LoreBookList')
        expect(settingSource).toContain('.globalLore')
        expect(settingSource).toContain('.localLore')
        expect(globalSource).toContain('.loreBookPage')
        expect(moduleSource).toContain('currentModule.lorebook')
    })

    it('moves scope help to the tabs and uses a localized icon editor button', () => {
        expect(settingSource).toContain('title={language.globalLoreInfo}')
        expect(settingSource).toContain('title={language.localLoreInfo}')
        expect(settingSource).not.toContain(
            '{submenu === 0 ? language.globalLoreInfo : language.localLoreInfo}',
        )
        expect(settingSource).toContain('language.lorebookWorkspace.openBardLore : language.lorebookWorkspace.editor')
        expect(settingSource).toContain('<SolarBoldIcon name="notebook"')
        expect(settingSource).not.toContain('<strong>{activeBinding.scopeLabel}</strong>')
    })

    it('offers the shared Bard Lore analysis run from the main tab and editor', () => {
        expect(settingSource).toContain('import BardLoreAnalysisPanel')
        expect(settingSource).toContain('<BardLoreAnalysisPanel')
        expect(settingSource).toContain('analysisRun={DBState.db.characters[$selectedCharID].bardLore!.analysisRun}')
        expect(settingSource).toContain('onBardAnalysisRunChange=')
    })

    it('separates lore editing tabs from an explicit Bard generation switch', () => {
        expect(settingSource).toContain('data-bard-lore-view="legacy"')
        expect(settingSource).toContain('data-bard-lore-view="bard"')
        expect(settingSource).toContain('data-bard-lore-active')
        expect(settingSource).toContain('role="switch"')
        expect(settingSource).toContain('loreView')
        expect(settingSource).toContain('bardActive')
        expect(settingSource).toContain('bardLore.mode = event.currentTarget.checked ?')
        expect(settingSource).not.toContain('aria-pressed={bardMode}')
        expect(settingSource).toContain('scopeLabel: `${character.name}의 ${language.lorebookWorkspace.bardLore}`')
    })

    it('does not hard-code scope abbreviations or unnamed child labels', () => {
        expect(settingSource).not.toMatch(/>\s*(?:CHAR|CHAT)\s*</u)
        expect(connectionSource).not.toContain('Unnamed Lore')
        expect(settingSource).toContain('{language.character}')
        expect(settingSource).toContain('{language.Chat}')
    })

    it('passes a public stable scope key and meaningful label at every call site', () => {
        expect(settingSource).toContain('scopeKey={activeBinding.scopeKey}')
        expect(settingSource).toContain('scopeLabel={activeBinding.scopeLabel}')
        expect(globalSource).toContain('scopeKey={activeBinding.scopeKey}')
        expect(globalSource).toContain('scopeLabel={activeBinding.scopeLabel}')
        expect(moduleSource).toContain('scopeKey={activeBinding.scopeKey}')
        expect(moduleSource).toContain('scopeLabel={activeBinding.scopeLabel}')
        expect(settingSource).not.toContain('index-')
        expect(globalSource).toContain('pageId: ensureStableLorebookOwnerId(owner')
    })

    it('uses exact replacement callbacks and leaves source selections outside them', () => {
        expect(settingSource).toContain('(owner, next) => applyLegacyEntries(owner, next)')
        expect(settingSource).toContain('(owner, next) => applyBardEntries(owner, next as BardLoreEntry[])')
        expect(settingSource).toContain('(owner, next) => { owner.localLore = next }')
        expect(globalSource).toContain('(owner, next) => { owner.data = next }')
        expect(moduleSource).toContain('(owner, next) => { owner.lorebook = next }')

        expect(settingSource).toContain('entries={activeBinding.entries}')
        expect(globalSource).toContain('entries={activeBinding.entries}')
        expect(moduleSource).toContain('entries={activeBinding.entries}')
        expect(settingSource).toContain('onChange={activeBinding.onChange}')
        expect(globalSource).toContain('onChange={activeBinding.onChange}')
        expect(moduleSource).toContain('onChange={activeBinding.onChange}')
    })

    it('connects scoped backups, local child labels, and existing import/export behavior', () => {
        expect(settingSource).toContain('legacyDisabledBackups={activeLoremasterBackups}')
        expect(settingSource).toContain('resolveChildLabel={activeChildLabelResolver}')
        expect(settingSource).toContain('localActivation={activeBinding.localActivation}')
        expect(settingSource).toContain('DBState.db.localActivationInGlobalLorebook')
        expect(settingSource).toContain("importLoreBook(submenu === 0 ? 'global' : 'local')")
        expect(settingSource).toContain("exportLoreBook(submenu === 0 ? 'global' : 'local')")
        expect(globalSource).toContain("importLoreBook('sglobal')")
        expect(globalSource).toContain("exportLoreBook('sglobal')")
        expect(moduleSource).toContain('onImport={importLoreBook}')
        expect(moduleSource).toContain('onExport={exportLoreBook}')
        expect(settingSource).not.toContain('delete DBState.db.pluginCustomStorage')
    })

    it('routes the global collection import/export mode to the selected global page', () => {
        expect(coreSource).toContain('const globalPageId = selectedGlobalPage')
        expect(coreSource).toContain('page.id === globalPageId')
    })

    it('migrates loaded page/chat IDs and gives newly created global pages an ID', () => {
        expect(databaseSource).toContain('ensureGlobalLorebookPageIds(data.loreBook, uuidv4)')
        expect(databaseSource).toContain('ensureStableLorebookOwnerId(c, uuidv4)')
        expect(globalListSource).toContain('id: v4()')
    })
})
