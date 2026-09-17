// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

vi.mock('src/ts/process/modules', () => ({ moduleUpdate: vi.fn() }))

import type { character } from 'src/ts/storage/database.svelte'
import RisuBardGallery from './RisuBardGallery.svelte'

let mounted: ReturnType<typeof mount> | undefined

function mountGallery(props: { chara: character; onClose?: () => void }): HTMLElement {
    const scrollHost = document.createElement('div')
    scrollHost.dataset.galleryScroll = ''
    scrollHost.className = 'h-full w-full overflow-y-auto overscroll-y-contain relative default-chat-screen'
    document.body.append(scrollHost)
    mounted = mount(RisuBardGallery, { target: scrollHost, props })
    return scrollHost
}

function characterFixture(): character {
    return {
        type: 'character',
        chaId: 'gallery-character',
        name: 'Alice',
        chatPage: 0,
        firstMessage: '',
        alternateGreetings: [],
        customscript: [],
        additionalAssets: [],
        virtualscript: [],
        emotionImages: [],
        triggerscript: [],
        risuBardGallery: {
            title: 'Alice의 기억',
            categories: [],
            slots: [{
                id: 'memory-1',
                title: '첫 기억',
                summary: '',
                sourceChatId: 'chat-1',
                sourceChatName: 'Chat 1',
                createdAt: 1,
                messages: [
                    { role: 'char', data: '첫 번째 프리뷰', chatId: 'message-1' },
                    { role: 'char', data: '두 번째 프리뷰', chatId: 'message-2' },
                ],
            }],
        },
        chats: [
            { id: 'chat-1', name: 'Chat 1', message: [] },
            { id: 'chat-2', name: 'Chat 2', message: [] },
        ],
    } as unknown as character
}

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardGallery viewport interactions', () => {
    test('hides list tools while reading and returns to the gallery list', async () => {
        const chara = characterFixture()
        chara.risuBardGallery!.slots[0].messages = []
        const scroll = mountGallery({ chara })

        document.querySelector<HTMLButtonElement>('[data-gallery-slot-title]')?.click()
        await tick()

        expect(document.querySelector('[data-gallery-reader]')).not.toBeNull()
        expect(document.querySelector('[data-gallery-list-toolbar]')).toBeNull()

        scroll.scrollTop = 240
        document.querySelector<HTMLButtonElement>('[data-gallery-back]')?.click()
        await tick()

        expect(document.querySelector('[data-gallery-reader]')).toBeNull()
        expect(document.querySelector('[data-gallery-list-toolbar]')).not.toBeNull()
        expect(scroll.scrollTop).toBe(0)
    })

    test('calls the chat return callback from the list toolbar', async () => {
        const onClose = vi.fn()
        mountGallery({ chara: characterFixture(), onClose })

        document.querySelector<HTMLButtonElement>('[data-gallery-close]')?.click()
        await tick()

        expect(onClose).toHaveBeenCalledOnce()
    })

    test('shows the same bot gallery after switching chats', async () => {
        const chara = characterFixture()
        chara.chatPage = 1
        mountGallery({ chara })
        await tick()

        expect(document.querySelector('[data-gallery-slot-title]')?.textContent).toContain('첫 기억')
    })

    test('updates the card thumbnail when its preview message changes', async () => {
        mountGallery({ chara: characterFixture() })
        document.querySelector<HTMLButtonElement>('[data-gallery-edit-toggle]')?.click()
        document.querySelector<HTMLButtonElement>('.memory-card__preview')?.click()
        await tick()

        const select = document.querySelector<HTMLSelectElement>('[data-gallery-preview-message]')!
        select.value = '1'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        document.querySelector<HTMLButtonElement>('[data-gallery-back]')?.click()
        await tick()

        expect(document.querySelector('.memory-card__preview')?.textContent).toContain('두 번째 프리뷰')
    })

    test('does not render a redundant edit button on cards', async () => {
        mountGallery({ chara: characterFixture() })
        document.querySelector<HTMLButtonElement>('[data-gallery-edit-toggle]')?.click()
        await tick()

        expect(document.querySelector('[data-gallery-slot-edit]')).toBeNull()
        expect(document.querySelector('[data-gallery-slot-delete]')).not.toBeNull()
    })
})
