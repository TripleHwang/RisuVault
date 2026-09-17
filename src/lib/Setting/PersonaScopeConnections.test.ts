import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('persona scope UI connections', () => {
    test('centers the manager and returns a selected persona without closing it', () => {
        const dialog = source('src/lib/Others/PersonaManager.svelte')
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')
        const binding = source('src/lib/SideBars/PersonaBind.svelte')

        expect(binding).not.toContain('openPersonaList')
        expect(dialog).toMatch(/\.persona-manager-backdrop\s*\{[^}]*justify-content:\s*center/s)
        expect(dialog).toMatch(/\.persona-manager-backdrop\s*\{[^}]*align-items:\s*center/s)
        expect(dialog).toContain('personaSelectCallback.set(null)')
        expect(dialog).toContain('onSelect={$personaSelectCallback ? selectPersona : undefined}')
        expect(dialog).toMatch(/function selectPersona\([^)]*\)[^{]*\{\s*\$personaSelectCallback\?\.\(selection\)\s*\}/)
        expect(dialog).not.toMatch(/function selectPersona\([^)]*\)[^{]*\{[^}]*close\(\)/s)
        expect(manager).toContain('onSelect?: (selection: PersonaSelection) => void')
        expect(manager).toContain('onclick={() => choosePersona(i)}')
        expect(manager).toMatch(/onSelect\(\{ persona, index, scope: activeScope \}\)/)
    })

    test('uses a compact persona header with hover and click help', () => {
        const dialog = source('src/lib/Others/PersonaManager.svelte')

        expect(dialog).not.toContain('personaManager.eyebrow')
        expect(dialog).toContain('personaManager.help')
        expect(dialog).toContain('use:tooltip')
        expect(dialog).toContain('alertMd')
    })

    test('switches the manager between global and current-character repositories', () => {
        const dialog = source('src/lib/Others/PersonaManager.svelte')
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(dialog).toContain('getEffectivePersona')
        expect(dialog).toContain('initialSelection={currentSelection}')
        expect(manager).toContain("type PersonaManagerScope = 'global' | 'character'")
        expect(manager).toContain("initialSelection?.scope ?? 'global'")
        expect(manager).toContain("initialSelection?.scope === 'global' && onSelect")
        expect(manager).toContain("initialSelection?.scope === 'character'")
        expect(manager).toContain('data-persona-scope-tabs')
        expect(manager).toContain('language.settingsWorkspace.personaManager.globalTab')
        expect(manager).toContain('language.settingsWorkspace.personaManager.characterTab')
        expect(manager).toContain('getCharacterPersonas(currentCharacter)')
        expect(manager).toContain('language.settingsWorkspace.personaManager.noCharacter')
    })

    test('clears a destroyed Sortable instance before remounting the global grid', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain('function destroySortable')
        expect(manager).toMatch(/sortable\?\.destroy\(\)\s*sortable = null/)
        expect(manager.match(/destroySortable\(\)/g)?.length).toBeGreaterThanOrEqual(3)
    })

    test('offers note-numbered duplication and cloning in both directions', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain('clonePersonaToStore')
        expect(manager).toContain('duplicateGlobalPersona')
        expect(manager).toContain('cloneGlobalPersonaToCharacter')
        expect(manager).toContain('cloneCharacterPersonaToGlobal')
        expect(manager).toContain('language.settingsWorkspace.personaManager.duplicate')
        expect(manager).toContain('language.settingsWorkspace.personaManager.cloneToCharacter')
        expect(manager).toContain('language.settingsWorkspace.personaManager.cloneToGlobal')
    })

    test('renders compact icon scope tabs without folder controls', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')

        expect(manager).not.toContain('data-persona-folder-create')
        expect(manager).not.toContain('ensurePersonaFolders')
        expect(manager).not.toContain('renamePersonaFolder')
        expect(manager).not.toContain('removePersonaFolder')
        for (const name of ['earth', 'people-nearby']) {
            expect(manager).toContain(`name="${name}"`)
            expect(icons).toContain(`'${name}'`)
        }
    })

    test('renders a scrollable square thumbnail rail with a matching create tile', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain('data-persona-grid')
        expect(manager).toContain('data-persona-create')
        expect(manager).not.toContain('<BaseRoundedButton')
        expect(manager).toMatch(/\.persona-grid\s*\{[^}]*overflow-y:\s*auto/s)
        expect(manager).toMatch(/\.persona-create[^}]*width:\s*5rem[^}]*height:\s*5rem/s)
    })

    test('persistently resizes the persona thumbnail list from a bottom handle', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain('PERSONA_GRID_HEIGHT_KEY')
        expect(manager).toContain('data-persona-grid-resizer')
        expect(manager).toContain('startPersonaGridResize')
        expect(manager).toContain('resizePersonaGridByKeyboard')
        expect(manager).toContain('style:height={`${personaGridHeight}px`}')
        expect(manager).toMatch(/\.persona-grid-resizer[^}]*cursor:\s*row-resize/s)
    })

    test('persistently resizes the persona manager width from its right edge', () => {
        const dialog = source('src/lib/Others/PersonaManager.svelte')

        expect(dialog).toContain('PERSONA_MANAGER_WIDTH_KEY')
        expect(dialog).toContain('data-persona-manager-resizer')
        expect(dialog).toContain('startManagerResize')
        expect(dialog).toContain('resizeManagerByKeyboard')
        expect(dialog).toContain('--persona-manager-width')
        expect(dialog).toMatch(/\.persona-manager-resizer[^}]*cursor:\s*col-resize/s)
    })

    test('uses compact field rows and a full-width persistently resizable description editor', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain('data-persona-field="name"')
        expect(manager).toContain('data-persona-field="note"')
        expect(manager).toContain('data-persona-description')
        expect(manager).toContain('data-persona-description-resizer')
        expect(manager).toContain('PERSONA_DESCRIPTION_HEIGHT_KEY')
        expect(manager).toContain('localStorage.setItem')
        expect(manager).toContain('actionBar={false}')
        expect(manager).toContain('openDescriptionEditor')
    })

    test('opens the persona builder below the description and copies its draft back safely', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')

        expect(manager).toContain("import PersonaBuilder from '../../Others/PersonaBuilder.svelte'")
        expect(manager).toContain('data-persona-builder-open')
        expect(manager).toContain('personaBuilderOpen')
        expect(manager).toContain('copyPersonaBuilderDraft')
        expect(manager).toContain('editingPersona.personaPrompt = draft')
        expect(manager).toContain('requestImmediateSave()')
        expect(manager.indexOf('data-persona-description-resizer')).toBeLessThan(
            manager.indexOf('data-persona-builder-open'),
        )
    })

    test('uses Solar Bold icon buttons for persona actions and portrait mode', () => {
        const manager = source('src/lib/Setting/Pages/PersonaSettings.svelte')
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')

        for (const name of [
            'copy',
            'people-nearby',
            'export',
            'import',
            'trash-bin-trash',
            'smartphone-rotate-2',
        ]) {
            expect(manager).toContain(`name="${name}"`)
            expect(icons).toContain(`'${name}'`)
        }
        expect(manager).toContain('data-persona-portrait-mode')
        expect(manager).toContain('use:tooltip')
    })

    test('shows both character and global personas in the chat profile selector', () => {
        const selector = source('src/lib/Setting/listedPersona.svelte')
        const binding = source('src/lib/SideBars/PersonaBind.svelte')

        expect(selector).toContain('getCharacterPersonas(currentCharacter)')
        expect(selector).toContain("scope: 'character'")
        expect(selector).toContain("scope: 'global'")
        expect(binding).toContain('resolvePersonaById')
        expect(binding).toContain('PersonaSelection')
    })
})
