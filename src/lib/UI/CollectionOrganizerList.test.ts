import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()

function source(path: string) {
    return readFileSync(resolve(root, path), 'utf8')
}

describe('inline collection organizer list', () => {
    test('renders organization and parent item actions in the default list instead of a dialog', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).not.toContain('ShDialog')
        expect(component).toContain("import type { Snippet }")
        expect(component).toContain('itemContent')
        expect(component).toContain('{@render itemContent(item.id)}')
        expect(component).toContain('data-collection-splitter')
        expect(component).toContain('container-type: inline-size')
        expect(component).toContain('@container collection-manager (min-width: 720px)')
    })

    test('keeps folder deletion, immediate persistence, and bulk movement inline', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).toContain('deleteCollectionFolder')
        expect(component).toContain('requestImmediateSave')
        expect(component).toContain('assignItemsToFolder')
        expect(component).toContain('moveFolderUp')
        expect(component).toContain('selectedItemIds.filter((id) => itemIds.includes(id))')
    })

    test('replaces manager reorder buttons with selection and makes the card body the drag handle', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')
        const managerRail = component.match(/\{#if managerLayout\}\s*<div\s+class="collection-item-selection-rail"([\s\S]*?)\{:else\}/)?.[1] ?? ''

        expect(component).toContain('collection-item-selection-rail')
        expect(managerRail).toContain('aria-pressed={selectedItemIds.includes(item.id)}')
        expect(managerRail).toContain('toggleSelection(item.id')
        expect(managerRail).not.toContain('moveVisibleItem')
        expect(component).toContain('data-collection-item-drag-handle')
        expect(component).toContain('draggable={managerLayout}')
        expect(component).toContain('reorderCollectionItemDragGroup(')
        expect(component).toContain('tabindex={managerLayout ? 0 : undefined}')
        expect(component).toContain('moveManagerItemWithKeyboard(event, item.id)')
        expect(component).toContain('copy.dragItemKeyboardHint')
        const keyboardHandler = component.match(/function moveManagerItemWithKeyboard[\s\S]*?function startItemDrag/)?.[0] ?? ''
        expect(keyboardHandler).toContain("event.target.closest('button, a, input, select, textarea')")
    })

    test('places clear selection before search and exposes contextual bulk deletion', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).toMatch(/copy\.clearSelection[\s\S]*?<TextInput[^>]*bind:value=\{search\}/)
        expect(component).toContain('onDeleteItems?:')
        expect(component).toContain('copy.deleteSelected')
        expect(component).toContain('deleteSelectedItems')
        const managerToolbar = component.match(/\{#if managerLayout\}\s*<span class="text-xs text-textcolor2">([\s\S]*?)\{#if toolbar\}/)?.[1] ?? ''
        expect(managerToolbar).toContain('bind:value={moveTarget}')
        expect(managerToolbar).toContain('onclick={bulkMove}')
    })

    test('prompt presets render their native actions inside the inline organizer', () => {
        const page = source('src/lib/Setting/botpreset.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(presetId)}')
        expect(page).toContain('copyPreset(i)')
        expect(page).toContain("downloadPreset(i, 'risupreset')")
        expect(page).toContain('assignPresetToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('modules keep export in the editor while rendering enable, persona, edit, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/Module/ModuleSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(moduleId)}')
        expect(page).toContain('openPersonaAssignments(rmodule.id)')
        expect(page).not.toContain('exportModule(rmodule)')
        expect(page).toContain('exportModule(tempModule)')
        expect(page).toContain('assignModuleToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('plugins render native update, toggle, permission, arguments, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/PluginSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(pluginName)}')
        expect(page).toContain('await updatePlugin(plugin)')
        // The failure toast now names which failure it was, so the assertion
        // pins the reporting call rather than the exact one-size message it
        // replaced.
        expect(page).toContain('notifyError(`${language.pluginUpdateFailed}: ${describePluginUpdateFailure(result.failure)}`)')
        expect(page).toContain('assignPluginToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })
})
