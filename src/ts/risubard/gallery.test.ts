import { describe, expect, test } from 'vitest'
import type { character, Chat, Message, RisuBardGallery, RisuBardGallerySlot } from '../storage/database.svelte'
import * as galleryModule from './gallery'
import {
    createGallerySlot,
    getGalleryPreviewMessage,
    getVisibleGalleryMessages,
    moveGallerySlot,
    moveGallerySlotByDrop,
    moveGallerySlotsToCategory,
    mergeLegacyChatGalleries,
    normalizeGallerySlotSize,
} from './gallery'

function messages(): Message[] {
    return [
        { role: 'user', data: 'before', chatId: 'm-1' },
        { role: 'char', data: 'important start', chatId: 'm-2', swipes: ['alt'] },
        { role: 'user', data: 'important end', chatId: 'm-3' },
        { role: 'char', data: 'after', chatId: 'm-4' },
    ]
}

describe('RisuBard gallery', () => {
    test('creates an independent snapshot from an inclusive message range', () => {
        const source = messages()
        const slot = createGallerySlot({
            id: 'scene-1',
            title: 'The turning point',
            summary: 'A promise is made.',
            sourceChatId: 'chat-1',
            sourceChatName: 'Route A',
            messages: source,
            startIndex: 1,
            endIndex: 2,
            createdAt: 123,
        })

        expect(slot).toEqual({
            id: 'scene-1',
            title: 'The turning point',
            summary: 'A promise is made.',
            sourceChatId: 'chat-1',
            sourceChatName: 'Route A',
            createdAt: 123,
            messages: [source[1], source[2]],
        })

        source[1].data = 'changed later'
        source[1].swipes?.push('another')
        expect(slot.messages[0].data).toBe('important start')
        expect(slot.messages[0].swipes).toEqual(['alt'])
    })

    test.each([
        [-1, 1],
        [0, 4],
        [3, 2],
        [0.5, 1],
    ])('rejects invalid range %s..%s', (startIndex, endIndex) => {
        expect(() => createGallerySlot({
            id: 'scene-1',
            title: 'Scene',
            summary: '',
            sourceChatName: 'Route A',
            messages: messages(),
            startIndex,
            endIndex,
            createdAt: 123,
        })).toThrow('Invalid gallery message range')
    })

    test('moves a slot without mutating the original order', () => {
        const slots: RisuBardGallerySlot[] = ['a', 'b', 'c'].map((id) => ({
            id,
            title: id,
            summary: '',
            sourceChatName: 'Chat',
            createdAt: 1,
            messages: [],
        } satisfies RisuBardGallerySlot))

        const moved = moveGallerySlot(slots, 0, 2)

        expect(moved.map((slot) => slot.id)).toEqual(['b', 'c', 'a'])
        expect(slots.map((slot) => slot.id)).toEqual(['a', 'b', 'c'])
        expect(moveGallerySlot(slots, -1, 1)).toEqual(slots)
    })

    test('moves a multi-selection into one category without changing slot order', () => {
        const slots: RisuBardGallerySlot[] = ['a', 'b', 'c'].map((id) => ({
            id,
            title: id,
            summary: '',
            sourceChatName: 'Chat',
            createdAt: 1,
            messages: [],
        } satisfies RisuBardGallerySlot))

        const moved = moveGallerySlotsToCategory(
            slots,
            new Set(['a', 'c']),
            'alice',
        )

        expect(moved.map((slot) => [slot.id, slot.categoryId])).toEqual([
            ['a', 'alice'],
            ['b', undefined],
            ['c', 'alice'],
        ])
        expect(slots.every((slot) => slot.categoryId === undefined)).toBe(true)
    })

    test('drops a slot after another slot and adopts the target category', () => {
        const slots: RisuBardGallerySlot[] = [
            { id: 'a', title: 'a', summary: '', sourceChatName: 'Chat', createdAt: 1, messages: [] },
            { id: 'b', title: 'b', summary: '', sourceChatName: 'Chat', createdAt: 1, messages: [] },
            { id: 'c', title: 'c', summary: '', sourceChatName: 'Chat', createdAt: 1, messages: [], categoryId: 'alice' },
        ]

        const moved = moveGallerySlotByDrop(slots, 'a', 'c', 'after')

        expect(moved.map((slot) => slot.id)).toEqual(['b', 'c', 'a'])
        expect(moved.find((slot) => slot.id === 'a')?.categoryId).toBe('alice')
        expect(slots[0].categoryId).toBeUndefined()
    })

    test('normalizes pixel slot sizes into the supported range', () => {
        expect(normalizeGallerySlotSize('224px', 160)).toBe(224)
        expect(normalizeGallerySlotSize('40px', 160)).toBe(96)
        expect(normalizeGallerySlotSize('900px', 160)).toBe(600)
        expect(normalizeGallerySlotSize('invalid', 160)).toBe(160)
    })

    test('hides user messages without changing the stored snapshot', () => {
        const slot: RisuBardGallerySlot = {
            id: 'scene-1',
            title: 'Scene',
            summary: '',
            sourceChatName: 'Chat',
            createdAt: 1,
            messages: messages(),
            hideUserMessages: true,
        }

        expect(getVisibleGalleryMessages(slot).map((message) => message.role)).toEqual(['char', 'char'])
        expect(slot.messages).toHaveLength(4)
    })

    test('falls back to a visible preview when the selected preview is a hidden user message', () => {
        const slot: RisuBardGallerySlot = {
            id: 'scene-1',
            title: 'Scene',
            summary: '',
            sourceChatName: 'Chat',
            createdAt: 1,
            messages: messages(),
            previewMessageIndex: 0,
            hideUserMessages: true,
        }

        expect(getGalleryPreviewMessage(slot)?.data).toBe('important start')
    })

    test('merges legacy chat galleries into one bot gallery without duplicate memories', () => {
        const sharedSlot = {
            id: 'shared', title: 'Shared', summary: '', sourceChatName: 'A', createdAt: 1, messages: [],
        } satisfies RisuBardGallerySlot
        const chats = [
            {
                name: 'A', message: [], localLore: [],
                risuBardGallery: {
                    title: 'A memories', categories: [{ id: 'alice', name: 'Alice' }], slots: [sharedSlot],
                },
            },
            {
                name: 'B', message: [], localLore: [],
                risuBardGallery: {
                    title: 'B memories', categories: [{ id: 'alice', name: 'Alice' }],
                    slots: [sharedSlot, { ...sharedSlot, id: 'b', title: 'B' }],
                },
            },
        ] as Chat[]

        const merged = mergeLegacyChatGalleries(chats, 1, 'Alice memories')

        expect(merged?.title).toBe('B memories')
        expect(merged?.categories).toHaveLength(1)
        expect(merged?.slots.map((slot) => slot.id)).toEqual(['shared', 'b'])
    })

    test('exports only an explicitly selected bot gallery without mutating it', () => {
        const getCharacterGalleryForExport = (galleryModule as typeof galleryModule & {
            getCharacterGalleryForExport?: (char: character) => RisuBardGallery | undefined
        }).getCharacterGalleryForExport
        expect(getCharacterGalleryForExport).toBeTypeOf('function')
        if (!getCharacterGalleryForExport) return

        const stored = {
            title: 'Memories', categories: [],
            slots: [{ id: 'scene', title: 'Scene', summary: '', sourceChatName: 'Chat', createdAt: 1, messages: [] }],
        } satisfies RisuBardGallery
        const char = { risuBardGallery: stored, chats: [], chatPage: 0 } as unknown as character
        const exported = getCharacterGalleryForExport(char)

        expect(exported).toEqual(stored)
        expect(exported).not.toBe(stored)
        exported!.title = 'Changed package copy'
        expect(stored.title).toBe('Memories')
    })

    test('removes legacy galleries from exported chat copies without touching stored chats', () => {
        const stripGalleryFromChats = (galleryModule as typeof galleryModule & {
            stripGalleryFromChats?: (chats: Chat[]) => Chat[]
        }).stripGalleryFromChats
        expect(stripGalleryFromChats).toBeTypeOf('function')
        if (!stripGalleryFromChats) return

        const chats = [{
            name: 'Route A', message: [], localLore: [],
            risuBardGallery: { title: 'Legacy', categories: [], slots: [] },
        }] as Chat[]
        const exported = stripGalleryFromChats(chats)

        expect(exported[0].risuBardGallery).toBeUndefined()
        expect(chats[0].risuBardGallery?.title).toBe('Legacy')
        expect(exported).not.toBe(chats)
    })
})
