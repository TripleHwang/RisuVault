type ActivateRisuTrigger = (origin: Element) => void | Promise<void>

function findTriggerOrigin(target: EventTarget | null): Element | null {
    return target instanceof Element
        ? target.closest('[risu-trigger], [risu-btn]')
        : null
}

export function createRisuTriggerActivation(
    activate: ActivateRisuTrigger,
    options: { pointerDownFallback?: boolean } = {},
) {
    let pointerOrigin: Element | null = null

    return {
        async pointerdown(event: PointerEvent) {
            if (!options.pointerDownFallback || event.button !== 0) return
            const origin = findTriggerOrigin(event.target)
            if (!origin) return
            pointerOrigin = origin
            await activate(origin)
        },
        async click(event: MouseEvent) {
            const origin = findTriggerOrigin(event.target)
            if (!origin) return
            if (origin === pointerOrigin) {
                pointerOrigin = null
                return
            }
            pointerOrigin = null
            await activate(origin)
        },
    }
}
