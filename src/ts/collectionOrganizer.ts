export type CollectionKind = 'promptPresets' | 'modules' | 'plugins'
export type OrganizableCollection = CollectionKind

export interface CollectionFolder {
    id: string
    name: string
    createdAt: number
}

export interface CollectionOrganizerState {
    folders: CollectionFolder[]
    folderByItemId: Record<string, string>
    itemOrder: string[]
}

export interface CollectionOrganizerItem {
    id: string
    title: string
    detail?: string
    status?: string
}

export interface CollectionFolderCounts {
    all: number
    uncategorized: number
    byFolderId: Record<string, number>
}

export type CollectionOrganizers = Record<CollectionKind, CollectionOrganizerState>

type FolderFilter = string | null | undefined

function validItemIds(itemIds: readonly string[]): string[] {
    const seen = new Set<string>()
    const validIds: string[] = []
    for (const id of itemIds) {
        if (id && !seen.has(id)) {
            seen.add(id)
            validIds.push(id)
        }
    }
    return validIds
}

function cloneState(state: CollectionOrganizerState): CollectionOrganizerState {
    return {
        folders: state.folders.map((folder) => ({ ...folder })),
        folderByItemId: { ...state.folderByItemId },
        itemOrder: [...state.itemOrder],
    }
}

function isValidCreatedAt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function normalizeCollectionOrganizerState(
    saved: Partial<CollectionOrganizerState> | null | undefined,
    currentItemIds: readonly string[],
): CollectionOrganizerState {
    const folders: CollectionFolder[] = []
    const folderIds = new Set<string>()
    for (const folder of Array.isArray(saved?.folders) ? saved.folders : []) {
        const id = typeof folder?.id === 'string' ? folder.id.trim() : ''
        const name = typeof folder?.name === 'string' ? folder.name.trim() : ''
        if (!id || !name || !isValidCreatedAt(folder?.createdAt) || folderIds.has(id)) continue
        folderIds.add(id)
        folders.push({ id, name, createdAt: folder.createdAt })
    }

    const currentIds = validItemIds(currentItemIds)
    const currentIdSet = new Set(currentIds)
    const folderByItemId: Record<string, string> = {}
    if (saved?.folderByItemId && typeof saved.folderByItemId === 'object') {
        for (const [itemId, folderId] of Object.entries(saved.folderByItemId)) {
            if (currentIdSet.has(itemId) && typeof folderId === 'string' && folderIds.has(folderId)) {
                folderByItemId[itemId] = folderId
            }
        }
    }

    const ordered = new Set<string>()
    const itemOrder: string[] = []
    for (const itemId of Array.isArray(saved?.itemOrder) ? saved.itemOrder : []) {
        if (currentIdSet.has(itemId) && !ordered.has(itemId)) {
            ordered.add(itemId)
            itemOrder.push(itemId)
        }
    }
    for (const itemId of currentIds) {
        if (!ordered.has(itemId)) itemOrder.push(itemId)
    }

    return { folders, folderByItemId, itemOrder }
}

export function normalizeCollectionOrganizers(
    saved: Partial<CollectionOrganizers> | null | undefined,
    itemIds: Record<CollectionKind, readonly string[]>,
): CollectionOrganizers {
    const organizers = {} as CollectionOrganizers
    for (const collection of ['promptPresets', 'modules', 'plugins'] as const) {
        organizers[collection] = normalizeCollectionOrganizerState(saved?.[collection], itemIds[collection])
    }
    return organizers
}

export function assignCollectionItem(
    state: CollectionOrganizerState,
    itemId: string,
    folderId: string | null,
): CollectionOrganizerState {
    const next = cloneState(state)
    if (!next.itemOrder.includes(itemId)) return next
    if (folderId === null) {
        delete next.folderByItemId[itemId]
    } else if (next.folders.some((folder) => folder.id === folderId)) {
        next.folderByItemId[itemId] = folderId
    }
    return next
}

export function assignItemsToFolder(
    state: CollectionOrganizerState,
    itemIds: readonly string[],
    folderId: string | null,
): CollectionOrganizerState {
    return itemIds.reduce((next, itemId) => assignCollectionItem(next, itemId, folderId), state)
}

export function createCollectionFolder(
    state: CollectionOrganizerState,
    name: string,
    id: string,
    createdAt: number,
): CollectionOrganizerState {
    const trimmedId = id.trim()
    const trimmedName = name.trim()
    if (!trimmedId || !trimmedName || !isValidCreatedAt(createdAt) || state.folders.some((folder) => folder.id === trimmedId)) return cloneState(state)
    return { ...cloneState(state), folders: [...state.folders, { id: trimmedId, name: trimmedName, createdAt }] }
}

export function renameCollectionFolder(
    state: CollectionOrganizerState,
    folderId: string,
    name: string,
): CollectionOrganizerState {
    const trimmedName = name.trim()
    if (!trimmedName) return cloneState(state)
    return {
        ...cloneState(state),
        folders: state.folders.map((folder) => folder.id === folderId ? { ...folder, name: trimmedName } : { ...folder }),
    }
}

export function deleteCollectionFolder(state: CollectionOrganizerState, folderId: string): CollectionOrganizerState {
    const next = cloneState(state)
    next.folders = next.folders.filter((folder) => folder.id !== folderId)
    for (const [itemId, assignedFolderId] of Object.entries(next.folderByItemId)) {
        if (assignedFolderId === folderId) delete next.folderByItemId[itemId]
    }
    return next
}

export function filterCollectionItems(state: CollectionOrganizerState, folderId: FolderFilter): string[] {
    if (folderId === undefined) return [...state.itemOrder]
    const folderIds = new Set(state.folders.map((folder) => folder.id))
    return state.itemOrder.filter((itemId) => folderId === null
        ? !folderIds.has(state.folderByItemId[itemId])
        : state.folderByItemId[itemId] === folderId)
}

export function getVisibleCollectionItems(
    state: CollectionOrganizerState,
    items: readonly CollectionOrganizerItem[],
    folderId: FolderFilter,
    search: string,
    status = '',
): CollectionOrganizerItem[] {
    const itemById = new Map(items.map((item) => [item.id, item]))
    const query = search.trim().toLocaleLowerCase()
    return filterCollectionItems(state, folderId)
        .map((itemId) => itemById.get(itemId))
        .filter((item): item is CollectionOrganizerItem => Boolean(item))
        .filter((item) => !query || `${item.title}\n${item.detail ?? ''}`.toLocaleLowerCase().includes(query))
        .filter((item) => !status || item.status === status)
}

export function getCollectionFolderCounts(state: CollectionOrganizerState): CollectionFolderCounts {
    const byFolderId = Object.fromEntries(state.folders.map((folder) => [folder.id, 0]))
    const folderIds = new Set(state.folders.map((folder) => folder.id))
    let uncategorized = 0
    for (const itemId of state.itemOrder) {
        const folderId = state.folderByItemId[itemId]
        if (folderIds.has(folderId)) {
            byFolderId[folderId]++
        } else {
            uncategorized++
        }
    }
    return { all: state.itemOrder.length, uncategorized, byFolderId }
}

export function retainVisibleCollectionSelection(
    selectedItemIds: readonly string[],
    visibleItemIds: readonly string[],
): string[] {
    const visible = new Set(visibleItemIds)
    return selectedItemIds.filter((itemId) => visible.has(itemId))
}

export function getCollectionItemDragState(
    grabbedItemId: string,
    selectedItemIds: readonly string[],
): { primaryItemId: string, itemIds: string[] } {
    return {
        primaryItemId: grabbedItemId,
        itemIds: selectedItemIds.includes(grabbedItemId) ? validItemIds(selectedItemIds) : [grabbedItemId],
    }
}

export function reorderCollectionItemDragGroup(
    visibleItemIds: readonly string[],
    draggedItemIds: readonly string[],
    primaryItemId: string,
    targetItemId: string,
): string[] {
    const visibleIds = validItemIds(visibleItemIds)
    const visibleIdSet = new Set(visibleIds)
    const dragged = new Set(validItemIds(draggedItemIds).filter((itemId) => visibleIdSet.has(itemId)))
    const primaryIndex = visibleIds.indexOf(primaryItemId)
    const targetIndex = visibleIds.indexOf(targetItemId)
    if (primaryIndex < 0 || targetIndex < 0 || dragged.has(targetItemId)) return visibleIds

    const movingDown = primaryIndex < targetIndex
    const group = visibleIds.filter((itemId) => dragged.has(itemId))
    const remaining = visibleIds.filter((itemId) => !dragged.has(itemId))
    const remainingTargetIndex = remaining.indexOf(targetItemId)
    if (!group.length || remainingTargetIndex < 0) return visibleIds

    const insertionIndex = remainingTargetIndex + (movingDown ? 1 : 0)
    return [
        ...remaining.slice(0, insertionIndex),
        ...group,
        ...remaining.slice(insertionIndex),
    ]
}

export function reorderVisibleCollectionItems(
    state: CollectionOrganizerState,
    visibleItemIds: readonly string[],
): CollectionOrganizerState {
    const knownIds = new Set(state.itemOrder)
    const replacementIds = validItemIds(visibleItemIds).filter((itemId) => knownIds.has(itemId))
    const visibleIds = new Set(replacementIds)
    let replacementIndex = 0
    const itemOrder = state.itemOrder.map((itemId) => visibleIds.has(itemId)
        ? replacementIds[replacementIndex++]!
        : itemId)
    return { ...cloneState(state), itemOrder }
}
