import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageEnglish } from './en'
import { languageKorean } from './ko'

describe('lorebook scan range labels', () => {
    it('describes chat-history scanning instead of recursive lorebook depth', () => {
        expect(languageEnglish.loreBookDepth).toBe('Recent Chat Scan Range')
        expect(languageKorean.loreBookDepth).toBe('최근 대화 검색 범위')
    })

    it('explains that the value counts previous messages', () => {
        expect(languageEnglish.help.loreBookDepth).toContain('messages')
        expect(languageKorean.help.loreBookDepth).toContain('메시지')
    })
})

describe('lorebook workspace labels', () => {
    it('provides every required label in English and Korean', () => {
        const requiredKeys = [
            'open',
            'editor',
            'openBardLore',
            'close',
            'back',
            'search',
            'searchName',
            'searchKeys',
            'showAll',
            'showEnabled',
            'showDisabled',
            'batchEdit',
            'clearSelection',
            'enabled',
            'disabled',
            'alwaysActive',
            'selective',
            'useRegex',
            'addPrimaryKeys',
            'removePrimaryKeys',
            'addSecondaryKeys',
            'removeSecondaryKeys',
            'moveUp',
            'moveDown',
            'moveToFolder',
            'moveToRoot',
            'importLoremaster',
            'importLoremasterResult',
            'activeInCurrentChat',
        ] as const

        for (const labels of [
            languageEnglish.lorebookWorkspace,
            languageKorean.lorebookWorkspace,
        ]) {
            for (const key of requiredKeys) expect(labels[key]).toBeTruthy()
        }

        expect(Object.keys(languageKorean.lorebookWorkspace).sort())
            .toEqual(Object.keys(languageEnglish.lorebookWorkspace).sort())
        for (const key of [
            'importLoremasterResult',
            'workspaceLabel',
            'openScope',
            'entriesCount',
            'selectedCount',
            'deleteEntryConfirm',
            'deleteFolderConfirm',
            'deactivateLinkConfirm',
            'dragEntry',
            'toggleFolder',
            'selectEntry',
        ] as const) {
            expect(typeof languageEnglish.lorebookWorkspace[key]).toBe('function')
            expect(typeof languageKorean.lorebookWorkspace[key]).toBe('function')
        }

        expect(languageKorean.lorebookWorkspace.legacyLoreEditor).toBe('기존 로어북')
        expect(languageKorean.lorebookWorkspace.bardLoreEditor).toBe('그리모어')
        expect(languageKorean.lorebookWorkspace.openBardLore).toBe('그리모어 편집기')
        expect(languageEnglish.lorebookWorkspace.openBardLore).toBe('Grimoire editor')
        expect(languageKorean.lorebookWorkspace.bardKeyed).toBe('키·별칭 적중')
        expect(languageKorean.lorebookWorkspace.bardRetrieve).toBe('키+관련도')
        expect(languageKorean.lorebookWorkspace.bardGuideRetrieveBody)
            .toContain('키·별칭')
        expect(languageKorean.lorebookWorkspace.bardGuideTitle).toBe('그리모어 도움말')
    })
})

describe('lorebook setting help', () => {
    it('provides a click help button for every setting', () => {
        const source = readFileSync(
            resolve('src/lib/SideBars/LoreBook/LoreBookSetting.svelte'),
            'utf8',
        )
        const helpKeys = [
            'useGlobalSettings',
            'recursiveScanning',
            'maxRecursionSteps',
            'lorebookMatchingMode',
            'loreBookDepth',
            'loreBookToken',
        ]

        for(const key of helpKeys){
            expect(source).toContain('<Help ' + 'key="' + key + '"')
        }
    })

    it('explains every matching mode with short examples', () => {
        for(const help of [
            languageEnglish.help.lorebookMatchingMode,
            languageKorean.help.lorebookMatchingMode,
        ]){
            expect(help).toContain('cat')
            expect(help).toContain('category')
            expect(help).toContain('cat,')
            expect(help).toContain('Alice')
            expect(help).toContain('Aliceville')
            expect(help).toContain('앨리스가')
        }
    })
})
