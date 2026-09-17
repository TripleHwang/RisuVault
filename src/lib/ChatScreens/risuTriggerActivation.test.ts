import { describe, expect, test, vi } from 'vitest'
import { createRisuTriggerActivation } from './risuTriggerActivation'

function triggerButton() {
    const wrapper = document.createElement('div')
    wrapper.innerHTML = '<button risu-trigger="WALP_SidebarToggle"><span>open</span></button>'
    return wrapper.querySelector('span') as HTMLSpanElement
}

describe('risu trigger activation', () => {
    test('activates once from pointerdown when Firefox does not emit click', async () => {
        const activate = vi.fn()
        const handlers = createRisuTriggerActivation(activate, {
            pointerDownFallback: true,
        })
        const target = triggerButton()

        await handlers.pointerdown({ target, button: 0 } as unknown as PointerEvent)

        expect(activate).toHaveBeenCalledOnce()
        expect(activate.mock.calls[0][0].getAttribute('risu-trigger'))
            .toBe('WALP_SidebarToggle')
    })

    test('does not activate twice when click follows pointerdown', async () => {
        const activate = vi.fn()
        const handlers = createRisuTriggerActivation(activate, {
            pointerDownFallback: true,
        })
        const target = triggerButton()

        await handlers.pointerdown({ target, button: 0 } as unknown as PointerEvent)
        await handlers.click({ target } as unknown as MouseEvent)

        expect(activate).toHaveBeenCalledOnce()
    })

    test('keeps keyboard-generated click activation', async () => {
        const activate = vi.fn()
        const handlers = createRisuTriggerActivation(activate)

        await handlers.click({ target: triggerButton() } as unknown as MouseEvent)

        expect(activate).toHaveBeenCalledOnce()
    })
})
