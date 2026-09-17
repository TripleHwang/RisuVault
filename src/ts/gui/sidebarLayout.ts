function size(value: unknown, fallback: number, min: number, max: number): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.round(Math.min(max, Math.max(Math.min(min, max), number)))
}

export function normalizeChatListHeight(value: unknown, viewportHeight = 1100): number {
    const max = Math.max(120, Math.min(900, (viewportHeight > 0 ? viewportHeight : 1100) - 200))
    return size(value, 320, 120, max)
}

export function normalizeCharacterSidebarWidth(value: unknown, availableWidth = 720): number {
    const max = Number.isFinite(availableWidth) ? Math.max(0, Math.min(720, availableWidth)) : 720
    return size(value, 384, 280, max)
}

export function normalizeCharacterListSidebarWidth(value: unknown, availableWidth = 240): number {
    const max = Number.isFinite(availableWidth) ? Math.max(0, Math.min(240, availableWidth)) : 240
    return size(value, 80, 80, max)
}
