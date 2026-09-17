export type QuickInventoryDragKind = 'character' | 'folder'

export type QuickInventoryCardTarget = {
    kind:QuickInventoryDragKind
    id:string
    index:number
    folder?:string
    folderLength?:number
}

type DropRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

type ResolveCardDropOptions = {
    sourceKind:QuickInventoryDragKind
    targetKind:QuickInventoryDragKind
    targetId?:string
    targetIndex:number
    targetFolder?:string
    targetFolderLength?:number
    rect:DropRect
    columnCount:number
    clientX:number
    clientY:number
}

export type QuickInventoryCardDrop = {
    mode:'insert'
    placement:{ after:boolean, axis:'row' | 'column' }
    drop:{ index:number, folder?:string }
} | {
    mode:'inside'
    drop:{ index:number, folder:string }
}

export const findQuickInventoryFolderCard = (target:HTMLElement) => {
    const grid = target.closest('.folder-character-grid')
    const folderCard = grid?.previousElementSibling
    return folderCard instanceof HTMLElement
        && folderCard.dataset.dragKind === 'folder'
        ? folderCard
        : null
}

export const resolveQuickInventoryCardDrop = (
    options:ResolveCardDropOptions
):QuickInventoryCardDrop | null => {
    if(options.sourceKind === 'character' && options.targetKind === 'folder'){
        return {
            mode: 'inside',
            drop: {
                index: options.targetFolderLength ?? 0,
                folder: options.targetId!,
            },
        }
    }
    if(options.sourceKind === 'folder' && options.targetFolder){
        return null
    }

    const axis = options.columnCount > 1 ? 'row' : 'column'
    const after = axis === 'row'
        ? options.clientX >= options.rect.left + options.rect.width / 2
        : options.clientY >= options.rect.top + options.rect.height / 2
    return {
        mode: 'insert',
        placement: { after, axis },
        drop: {
            index: options.targetIndex + (after ? 1 : 0),
            folder: options.targetKind === 'character' ? options.targetFolder : undefined,
        },
    }
}
