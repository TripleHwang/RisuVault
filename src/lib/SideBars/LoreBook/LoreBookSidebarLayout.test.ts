import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('lorebook sidebar layout', () => {
    const lorebook = source('src/lib/SideBars/LoreBook/LoreBookSetting.svelte')
    const characterConfig = source('src/lib/SideBars/CharConfig.svelte')
    const chatSidebar = source('src/lib/SideBars/SideChatList.svelte')
    const app = source('src/App.svelte')
    const analysisPanel = source('src/lib/SideBars/LoreBook/BardLoreAnalysisPanel.svelte')

    test('uses the same compact section header hierarchy as the chat sidebar', () => {
        expect(chatSidebar).toContain(
            'data-current-chat-section class="border-b border-darkborderc pb-2"',
        )
        expect(characterConfig).toContain(
            'data-lorebook-sidebar-header class="border-b border-darkborderc pb-2"',
        )
        expect(characterConfig).not.toContain(
            '<h2 class="mb-2 text-2xl font-bold">{language.loreBook}',
        )
    })

    test('uses quiet full-width tab rails instead of bordered button blocks', () => {
        expect(lorebook).toContain('data-lorebook-sidebar-layout')
        expect(lorebook).toContain('data-lorebook-primary-tabs')
        expect(lorebook).toContain('data-bard-lore-mode')
        expect(lorebook.match(/rounded-lg bg-selected\/25 p-1/g)).toHaveLength(2)
    })

    test('keeps every setting control on a deliberate full-width row', () => {
        // `?? ([] as string[])`: a bare `[]` is `never[]`, and whether the
        // union with `RegExpMatchArray` narrows to `string[]` at `.every`
        // depends on the checker's visiting order for the whole program --
        // clean on an upstream checkout, `input` is `never` in the merged one.
        const numberInputs = lorebook.match(/<NumberInput\b[^>]*\/>/gs) ?? ([] as string[])
        expect(numberInputs.length).toBeGreaterThan(0)
        expect(numberInputs.every((input) => input.includes('fullwidth'))).toBe(true)
        expect(lorebook).toContain('data-lorebook-settings')
        expect(lorebook).toContain('data-lorebook-setting-field')
        expect(lorebook).toContain('data-lorebook-setting-row')
        expect(lorebook).toContain('<ShSwitch')
        expect(lorebook).not.toContain('<Check')
        expect(lorebook).toContain('<ShSelect className="w-full"')
    })

    test('exposes portable Bard metadata actions without routing them through legacy lore import', () => {
        expect(lorebook).toContain('data-bard-lore-portable')
        expect(lorebook).toContain('exportBardLoreMetadata(bardLore, character.globalLore, character.name)')
        expect(lorebook).toContain('importBardLoreMetadata(')
        expect(lorebook).toContain('cleanseBardLoreMetadata(character)')
        expect(lorebook).toContain('onImport={bardView ? importBardLoreOverlay')
        expect(lorebook).toContain('onExport={bardView ? exportBardLoreOverlay')
    })

    test('keeps the open lorebook dialogs mounted when the responsive sidebar shell changes', () => {
        expect(app.match(/<Sidebar\b/g)).toHaveLength(1)
        expect(app).toContain('data-responsive-sidebar-host')
    })

    test('wraps analysis request-plan cards according to the resized pane width', () => {
        expect(analysisPanel).toContain('repeat(auto-fit, minmax(min(100%, 6rem), 1fr))')
    })
})
