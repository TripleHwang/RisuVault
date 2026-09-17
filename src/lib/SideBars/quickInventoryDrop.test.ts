import { describe, expect, test } from 'vitest'
import {
    findQuickInventoryFolderCard,
    resolveQuickInventoryCardDrop,
} from './quickInventoryDrop'

const rect = { left: 10, top: 20, width: 60, height: 80 }

describe('quick inventory card drop resolution', () => {
    test('uses vertical before/after positions in a one-column list', () => {
        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'character',
            targetKind: 'character',
            targetIndex: 3,
            rect,
            columnCount: 1,
            clientX: 40,
            clientY: 40,
        })).toEqual({
            mode: 'insert',
            placement: { after: false, axis: 'column' },
            drop: { index: 3, folder: undefined },
        })

        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'character',
            targetKind: 'character',
            targetIndex: 3,
            rect,
            columnCount: 1,
            clientX: 40,
            clientY: 80,
        })?.drop.index).toBe(4)
    })

    test('uses horizontal before/after positions in a multi-column grid', () => {
        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'character',
            targetKind: 'character',
            targetIndex: 2,
            rect,
            columnCount: 3,
            clientX: 60,
            clientY: 60,
        })).toEqual({
            mode: 'insert',
            placement: { after: true, axis: 'row' },
            drop: { index: 3, folder: undefined },
        })
    })

    test('moves characters into folders but reorders folders between cards', () => {
        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'character',
            targetKind: 'folder',
            targetId: 'folder-b',
            targetIndex: 4,
            targetFolderLength: 2,
            rect,
            columnCount: 3,
            clientX: 60,
            clientY: 60,
        })).toEqual({
            mode: 'inside',
            drop: { index: 2, folder: 'folder-b' },
        })

        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'folder',
            targetKind: 'folder',
            targetId: 'folder-b',
            targetIndex: 4,
            targetFolderLength: 2,
            rect,
            columnCount: 3,
            clientX: 60,
            clientY: 60,
        })).toEqual({
            mode: 'insert',
            placement: { after: true, axis: 'row' },
            drop: { index: 5, folder: undefined },
        })
    })

    test('does not advertise an invalid nested target for folders', () => {
        expect(resolveQuickInventoryCardDrop({
            sourceKind: 'folder',
            targetKind: 'character',
            targetIndex: 1,
            targetFolder: 'folder-b',
            rect,
            columnCount: 3,
            clientX: 20,
            clientY: 30,
        })).toBeNull()
    })

    test('finds the sibling folder card for a character inside an expanded folder', () => {
        const container = document.createElement('div')
        container.innerHTML = `
            <div data-drag-kind="folder" data-drag-id="folder-b"></div>
            <div class="folder-character-grid">
                <div data-drag-kind="character" data-drag-folder="folder-b"></div>
            </div>
        `
        const character = container.querySelector('[data-drag-kind="character"]') as HTMLElement

        expect(findQuickInventoryFolderCard(character)?.dataset.dragId).toBe('folder-b')
    })
})
