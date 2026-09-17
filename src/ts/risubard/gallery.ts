import { safeStructuredClone } from '../polyfill'
import type { character, Chat, Message, RisuBardGallery, RisuBardGallerySlot } from '../storage/database.svelte'

export interface CreateGallerySlotInput {
    id: string
    title: string
    summary: string
    sourceChatId?: string
    sourceChatName: string
    messages: Message[]
    startIndex: number
    endIndex: number
    createdAt: number
}

export function createGallerySlot(input: CreateGallerySlotInput): RisuBardGallerySlot {
    const { startIndex, endIndex, messages } = input
    const validRange = Number.isInteger(startIndex)
        && Number.isInteger(endIndex)
        && startIndex >= 0
        && endIndex >= startIndex
        && endIndex < messages.length

    if (!validRange) {
        throw new Error('Invalid gallery message range')
    }

    return {
        id: input.id,
        title: input.title,
        summary: input.summary,
        sourceChatId: input.sourceChatId,
        sourceChatName: input.sourceChatName,
        createdAt: input.createdAt,
        messages: safeStructuredClone(messages.slice(startIndex, endIndex + 1)),
    }
}

export function moveGallerySlot(
    slots: RisuBardGallerySlot[],
    from: number,
    to: number,
): RisuBardGallerySlot[] {
    const next = [...slots]
    if (
        !Number.isInteger(from)
        || !Number.isInteger(to)
        || from < 0
        || to < 0
        || from >= next.length
        || to >= next.length
        || from === to
    ) {
        return next
    }

    const [slot] = next.splice(from, 1)
    next.splice(to, 0, slot)
    return next
}

export function moveGallerySlotByDrop(
    slots: RisuBardGallerySlot[],
    draggedId: string,
    targetId: string,
    placement: 'before' | 'after',
): RisuBardGallerySlot[] {
    const dragged = slots.find((slot) => slot.id === draggedId)
    const target = slots.find((slot) => slot.id === targetId)
    if (!dragged || !target || draggedId === targetId) return [...slots]

    const next = slots.filter((slot) => slot.id !== draggedId)
    const targetIndex = next.findIndex((slot) => slot.id === targetId)
    const insertIndex = targetIndex + (placement === 'after' ? 1 : 0)
    next.splice(insertIndex, 0, { ...dragged, categoryId: target.categoryId })
    return next
}

export function normalizeGallerySlotSize(value: string | number, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(600, Math.max(96, Math.round(parsed)))
}

export function getVisibleGalleryMessages(slot: RisuBardGallerySlot): Message[] {
    if (!slot.hideUserMessages) return slot.messages
    return slot.messages.filter((message) => message.role !== 'user')
}

export function getGalleryPreviewMessage(slot: RisuBardGallerySlot): Message | undefined {
    const selected = slot.messages[slot.previewMessageIndex ?? 0]
    if (!slot.hideUserMessages || selected?.role !== 'user') return selected
    return slot.messages.find((message) => message.role !== 'user')
}

export function mergeLegacyChatGalleries(
    chats: Chat[],
    currentChatIndex: number,
    defaultTitle: string,
): RisuBardGallery | undefined {
    const activeChat = chats[currentChatIndex]
    const orderedChats = activeChat
        ? [activeChat, ...chats.filter((_, index) => index !== currentChatIndex)]
        : chats
    const galleries = orderedChats
        .map((chat) => chat.risuBardGallery)
        .filter((gallery): gallery is RisuBardGallery => Boolean(gallery))
    if (galleries.length === 0) return undefined

    const primary = galleries[0]
    const categories = new Map(primary.categories.map((category) => [category.id, category]))
    const slots = new Map(primary.slots.map((slot) => [slot.id, slot]))
    for (const gallery of galleries.slice(1)) {
        for (const category of gallery.categories) {
            if (!categories.has(category.id)) categories.set(category.id, category)
        }
        for (const slot of gallery.slots) {
            if (!slots.has(slot.id)) slots.set(slot.id, slot)
        }
    }

    return {
        title: primary.title?.trim() || defaultTitle,
        slotWidth: primary.slotWidth,
        slotHeight: primary.slotHeight,
        categories: [...categories.values()],
        slots: [...slots.values()],
    }
}

export function getCharacterGalleryForExport(char: character): RisuBardGallery | undefined {
    const gallery = char.risuBardGallery ?? mergeLegacyChatGalleries(
        char.chats,
        char.chatPage,
        `${char.name} memories`,
    )
    return gallery ? safeStructuredClone(gallery) : undefined
}

export function stripGalleryFromChats(chats: Chat[]): Chat[] {
    const copies = safeStructuredClone(chats)
    for (const chat of copies) delete chat.risuBardGallery
    return copies
}

export function moveGallerySlotsToCategory(
    slots: RisuBardGallerySlot[],
    selectedIds: ReadonlySet<string>,
    categoryId?: string,
): RisuBardGallerySlot[] {
    return slots.map((slot) => selectedIds.has(slot.id)
        ? { ...slot, categoryId }
        : slot)
}
