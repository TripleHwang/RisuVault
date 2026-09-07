import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

/**
 * That the anchor controller is actually driven by the screen.
 *
 * `ChatScrollAnchorInteraction.test.ts` drives the controller directly, so it
 * proves the state machine and nothing about whether anything calls it. These
 * assertions are the other half, and they are source text because
 * `DefaultChatScreen.svelte` has no runtime coverage: importing it under this
 * config does work, but it costs roughly 40 seconds of Vite transform, and
 * happy-dom lays nothing out, so the scroll geometry every one of these calls
 * turns on would have to be stubbed anyway.
 *
 * What that buys and what it does not: a deletion, a rename, or the scroll call
 * being moved out of the `onscroll` handler all fail here. The call being left
 * in place but wrapped in a condition that is never true does not -- only
 * running the component would catch that.
 */
describe('chat scroll anchor integration', () => {
    test('connects bounded DOM stabilization to the default chat screen', () => {
        const source = read('src/lib/ChatScreens/DefaultChatScreen.svelte')

        expect(source).toContain("from './chatScrollAnchor'")
        expect(source).toContain('new MutationObserver')
        expect(source).toContain("container.addEventListener('load'")
        expect(source).toContain('DBState.db.preserveChatScrollPosition')
    })

    test('drives the anchor controller from the screen', () => {
        const source = read('src/lib/ChatScreens/DefaultChatScreen.svelte')

        // Scoped to the scroll handler's own body, not merely to the file. The
        // scroll event is the only notice this container gives of browser-driven
        // scrolling -- middle-click autoscroll, a scrollbar drag, touch momentum
        // -- so the whole discrimination is unreachable from anywhere else, and
        // the realistic regression is this call drifting out of the handler
        // during a refactor of it rather than being deleted outright.
        const handlerStart = source.indexOf('onscroll={(e) => {')
        expect(handlerStart).toBeGreaterThan(-1)
        const afterHandlerStart = source.slice(handlerStart)
        const handlerBody = afterHandlerStart.slice(0, afterHandlerStart.indexOf('}}>'))
        expect(handlerBody).toContain('scrollAnchorController.handleContainerScroll()')

        // A content shift arms the ladder. Asserted whole: an observer that is
        // constructed and then handed an empty callback satisfies the
        // `new MutationObserver` string above while doing nothing.
        expect(source).toContain('new MutationObserver(() => scrollAnchorController.queueRestore())')

        // Something has to take the first snapshot. Without it `queueRestore`
        // finds no anchor and every shift is a no-op until the first gesture.
        expect(source).toContain('scrollAnchorController.scheduleCapture(0)')

        // The other half of the cancellation path: the gestures the reader makes
        // themselves, which re-anchor instead of waiting for the height to say so.
        expect(source).toContain(
            'const handleDirectScrollInteraction = () => scrollAnchorController.handleDirectScrollInteraction()',
        )
        for (const event of ['pointerdown', 'wheel', 'touchstart', 'keydown']) {
            expect(source).toContain(
                `container.addEventListener('${event}', handleDirectScrollInteraction)`,
            )
        }
    })

    test('exposes a default-on toggle in Accessibility > Scroll', () => {
        const database = read('src/ts/storage/database.svelte.ts')
        const settings = read('src/ts/setting/accessibilitySettingsData.ts')

        expect(database).toContain('data.preserveChatScrollPosition ??= true')
        expect(database).toContain('preserveChatScrollPosition?: boolean')
        expect(settings).toContain("id: 'acc.preserveChatScrollPosition'")
        expect(settings).toMatch(/accessibilityScrollItems[\s\S]*'acc\.preserveChatScrollPosition'/)
    })
})
