import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import { requestImmediateSave } from 'src/ts/globalApi.svelte'
import {
    normalizeCharacterListSidebarWidth,
    normalizeChatListHeight,
    normalizeCharacterSidebarWidth,
} from 'src/ts/gui/sidebarLayout'
import SidebarResizeHandle from './SidebarResizeHandle.svelte'

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { DBState: { db: {} }, SizeStore: writable({ w: 1280, h: 900 }) }
})
vi.mock('src/ts/globalApi.svelte', () => ({ requestImmediateSave: vi.fn(async () => undefined) }))
let mounted: ReturnType<typeof mount> | undefined
beforeEach(() => { DBState.db = {} as typeof DBState.db; vi.clearAllMocks() })
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

async function render(
    axis: 'height' | 'width',
    maxWidth = 720,
    field?: 'characterSidebarWidth' | 'characterListSidebarWidth',
) {
    const target = document.body.appendChild(document.createElement('div'))
    target.getBoundingClientRect = () => ({ width: 384, height: 320, left: 0, top: 0, right: 384, bottom: 320, x: 0, y: 0, toJSON() {} })
    mounted = mount(SidebarResizeHandle, { target, props: { axis, target, maxWidth, field } })
    await tick()
    const handle = target.querySelector<HTMLButtonElement>('button')!
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    handle.releasePointerCapture = vi.fn()
    return { handle, target }
}

describe('sidebar layout sizes', () => {
    test('defaults, clamps, and rejects invalid saved sizes', () => {
        expect(normalizeChatListHeight(undefined, 900)).toBe(320)
        expect(normalizeChatListHeight(NaN, 900)).toBe(320)
        expect(normalizeChatListHeight(20, 900)).toBe(120)
        expect(normalizeChatListHeight(9999, 900)).toBe(700)
        expect(normalizeCharacterSidebarWidth(undefined, 1000)).toBe(384)
        expect(normalizeCharacterSidebarWidth(Infinity, 1000)).toBe(384)
        expect(normalizeCharacterSidebarWidth(10, 1000)).toBe(280)
        expect(normalizeCharacterSidebarWidth(900, 1000)).toBe(720)
        expect(normalizeCharacterSidebarWidth(600, 232)).toBe(232)
        expect(normalizeCharacterListSidebarWidth(undefined, 240)).toBe(80)
        expect(normalizeCharacterListSidebarWidth(10, 240)).toBe(80)
        expect(normalizeCharacterListSidebarWidth(999, 240)).toBe(240)
    })

    test.each(['width', 'height'] as const)('persists %s keyboard resizing globally and restores the default with Home', async axis => {
        const { handle } = await render(axis)
        const field = axis === 'height' ? 'chatListHeight' : 'characterSidebarWidth'
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: axis === 'height' ? 'ArrowDown' : 'ArrowRight', bubbles: true }))
        expect(DBState.db[field]).toBe(axis === 'height' ? 336 : 400)
        expect(requestImmediateSave).toHaveBeenCalledOnce()
        const persisted = JSON.parse(JSON.stringify(DBState.db))
        expect(persisted[field]).toBe(DBState.db[field])
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
        expect(DBState.db[field]).toBeUndefined()
        expect(requestImmediateSave).toHaveBeenCalledTimes(2)
    })

    test('uses pointer delta from the starting height and saves once on release', async () => {
        const { handle } = await render('height')
        handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7, clientY: 400, bubbles: true }))
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientY: 500 }))
        expect(DBState.db.chatListHeight).toBe(420)
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientY: 550 }))
        expect(DBState.db.chatListHeight).toBe(470)
        expect(requestImmediateSave).not.toHaveBeenCalled()
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
        expect(requestImmediateSave).toHaveBeenCalledOnce()
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientY: 700 }))
        expect(DBState.db.chatListHeight).toBe(470)
    })

    test('bounds the width to available space and cleans up cancelled dragging', async () => {
        const { handle } = await render('width', 500)
        handle.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 3, clientX: 384, bubbles: true }))
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 2000 }))
        expect(DBState.db.characterSidebarWidth).toBe(500)
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3 }))
        expect(requestImmediateSave).toHaveBeenCalledOnce()
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 3, clientX: 100 }))
        expect(DBState.db.characterSidebarWidth).toBe(500)
    })

    test('persists the resizable character-list rail independently', async () => {
        const { handle } = await render('width', 240, 'characterListSidebarWidth')
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(DBState.db.characterListSidebarWidth).toBe(240)
        expect(DBState.db.characterSidebarWidth).toBeUndefined()
        expect(handle.getAttribute('aria-label')).toContain('캐릭터 목록 사이드바 너비 조절')
    })
})
