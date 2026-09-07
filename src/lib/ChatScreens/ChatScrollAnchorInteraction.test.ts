import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createChatScrollAnchorController } from './chatScrollAnchor'

/**
 * Who is allowed to move the chat's scroll position while a restore ladder is
 * pending.
 *
 * The ladder exists so that an image finishing its load, or a message being
 * re-rendered, cannot throw the reader forward through text they had not read.
 * It re-applies one snapshot at 0, 80, 180, 350, 700, 1300 and 2100ms and
 * refuses to take a new snapshot for the whole of that window, and until this
 * suite existed the only thing that could stop it was `pointerdown`, `wheel`,
 * `touchstart` or `keydown` on the container.
 *
 * Those four report the START of a gesture, not scrolling the browser then goes
 * on to do by itself. Middle-click autoscroll emits one `pointerdown` and then
 * scrolls unaided; a scrollbar drag and a touch momentum fling emit nothing at
 * all once running. Traced in a real chat, autoscroll moved the container about
 * 608px per frame for some forty consecutive frames, and four `scrollTo` calls
 * landed in the middle of it at 350ms, 599ms and 801ms apart -- the tail of the
 * ladder, dragging the reader back to a two-second-old position and finally
 * snapping them to the newest end. `scrollHeight` was 72717 on every one of
 * those forty frames, unchanged, which is the signal used below: a content
 * shift is a change in how much document there is, and reader scrolling is not.
 *
 * `DefaultChatScreen.svelte` is not mounted here, and not because it cannot be.
 * Measured under this repo's own vitest config: `await import()` of the
 * component resolves to a component constructor and throws nothing, in roughly
 * 40 seconds of which almost all is Vite transform -- so it blows the default
 * 5000ms `testTimeout`, which is what a passing glance reads as a failure. Its
 * module graph does emit one unhandled `ReferenceError: Cannot access
 * '__vite_ssr_import_35__' before initialization` from an `$effect` in
 * `stores.svelte`, which vitest reports separately and which fails nothing; the
 * sibling `.svelte.test.ts` files in this directory emit the same error while
 * passing (checked against `ChatRenderLayoutReads.svelte.test.ts`: 5 passed,
 * 1 error). What is driven here instead is the controller itself, because what
 * is under test is timing at frame resolution against a container whose
 * `scrollHeight`, `scrollTop`, rects and scroll events all have to be dictated,
 * and happy-dom lays nothing out. The wiring between this controller and the
 * screen's `onscroll` is asserted as source text in
 * `ChatScrollAnchorIntegration.test.ts`.
 */

/**
 * Where this suite stops, so a green run is not read as more than it is.
 *
 * `ChatScrollAnchorIntegration.test.ts` reads `DefaultChatScreen.svelte` as
 * text. That catches the scroll handler's `handleContainerScroll()` call being
 * deleted, renamed, or moved out of `onscroll`; it does not catch the call
 * being left exactly where it is inside a condition that is never true, which
 * passes all three of those tests. Nothing short of mounting the component
 * sees that, at the transform cost the header above describes, so until
 * something does mount the screen the body of that handler is held down by
 * review rather than by a test.
 *
 * `freezeUntil` is not held down at either end. Two things read it: the guard
 * in `captureNow` and the gate on the tail of `handleContainerScroll`. Either
 * can be dropped, or both at once, with every test in this directory still
 * passing -- so nothing here tells a controller that suspends capturing for the
 * length of a ladder apart from one that never suspends it at all. Its four
 * writes go the same way, each deleted on its own and each green: the arming in
 * `queueRestore`, and the clearing in `cancelPendingRestores`, in `reset` and on
 * the last rung. The clearing in `cancelPendingRestores` is the one to write a
 * test for first, because it is the one with a reader on the other end. Without
 * it the gesture that cancelled the ladder cannot re-anchor -- the `captureNow`
 * it makes runs straight into a guard that is still standing -- and no scroll
 * event can re-arm one either, so the anchor stays on the row the reader has
 * left and the next shift's ladder pulls them back to it.
 *
 * The last rung's `scheduleCapture(55)` goes with it, and is a second thing
 * entirely: it is the ladder's own closing re-anchor, the one snapshot taken
 * after the content has finished settling without waiting for the reader to
 * move again. Deleting it changes nothing any test here can see.
 *
 * The echo slot is pinned where it matches and nowhere else. Removing the clear
 * inside the match fails 'the echo slot is emptied the moment it matches'; the
 * two eager clears -- in `cancelPendingRestores`, and at the top of
 * `queueRestore` -- can each be deleted with the suite green, so the claim on
 * that field's declaration that the slot "is cleared eagerly" is answered for at
 * neither site.
 *
 * A rung's two exits are unheld, and between them they are one hole rather than
 * two. The `token !== mutationToken` check that stops a superseded ladder
 * survives deletion, and so does the `context-changed` return that raises that
 * token without clearing the rungs queued behind it -- which is the only state
 * the check still has to catch, since every other path that raises the token
 * clears those timers in the same breath. One test that changes the context
 * mid-ladder would cover both.
 *
 * Everything this note names as surviving, above and below, is a record of what
 * has been probed and not a sweep of what could be. Each entry has been run
 * against this directory and passed, and none has been argued to be
 * behaviour-preserving, so each is undetermined rather than cleared and a
 * maintainer editing one of those lines should expect no test to answer for it
 * either way. A mutation that is absent from the record is most likely one
 * nobody has run: absence is not coverage, and the record is worth extending
 * rather than trusted as a boundary.
 *
 * In the controller's own bookkeeping, what has been probed and survived is
 * `handleContainerScroll` not recording `lastScrollHeight`; a null
 * `lastScrollHeight` scored as a change rather than as not-yet-known;
 * `restoring` never set around a rung, and either of the two places that read it
 * dropped -- the guard in `captureNow`, the gate on the tail of
 * `handleContainerScroll`; the token bump at the top of `cancelPendingRestores`;
 * `clearTimers` leaving `captureTimer` alone; and `reset` keeping either the
 * height or the grace deadline it was holding.
 *
 * Among the tuning constants: the echo tolerance narrowed from a pixel to
 * nothing, the shift-adjustment grace halved to 16ms, the freeze margin past the
 * last rung cut from 50ms to none, and the ladder losing its 1300ms rung or
 * losing its last 2100ms rung. Each of those numbers is argued for where it is
 * declared, and for these the argument is the whole of what stands behind them.
 *
 * The two pure functions are no better held, and the older
 * `chatScrollAnchor.test.ts` alongside does not close them: the one-pixel
 * viewport insets, the 0.001 weight that prefers a row crossing the top edge,
 * the +10 penalty on one that does not, the 100px margin that decides
 * `atLatest`, the `messageCount <= 0` guard in `captureChatScrollAnchor`, and
 * the `context-changed` and `missing` early returns in `restoreChatScrollAnchor`
 * all survive this directory run whole.
 *
 * Set against that, so a green run is not read as less than it is either. The
 * switch the reader can see is held down at each of the four sites that consult
 * it: deleting `!options.isEnabled()` from `captureNow`, from `scheduleCapture`,
 * from `queueRestore` or from the rung -- each on its own, and all four together
 * -- fails 'the preserveChatScrollPosition switch is obeyed at every site'. The
 * four shield one another, which is why that test drives three states rather
 * than one; and the one in `scheduleCapture` is the one with a caller that does
 * not check for itself, since the screen's `onscroll` calls
 * `handleContainerScroll` whatever the setting says. The third early return in
 * `restoreChatScrollAnchor`, `'new-message'`, is what hands an appended reply
 * back to the auto-scroll, and deleting it fails next door. `MIN_CORRECTION_PX`
 * moved to 0 or to 100, the staleness cap to 16 or to 64, the grace window
 * widened to 64ms, `scheduleCapture`'s 55ms default dropped to 0, the 80ms the
 * no-anchor path asks for narrowed to 55, the grace window left unspent instead
 * of zeroed on the event it covers, `behavior: 'instant'` softened to
 * `'smooth'`, and the sign of the correction delta reversed each fail something
 * in this directory as well.
 *
 * One test below rests on the module's contract rather than on its caller. 'a
 * shift announced while the screen has no scroller is still measured against
 * the height the anchor was taken at' drives `getContainer()` answering nothing
 * between a capture and a `queueRestore`, which the options type explicitly
 * permits -- "nothing while the screen has none mounted". No path through
 * `DefaultChatScreen.svelte` is known to reach it: the effect owning the
 * MutationObserver disconnects it and calls `reset()` in the same cleanup, so
 * on the app path the shift that would have to be announced into that window is
 * never delivered. The seed line in `captureNow` that the test names is
 * therefore justified by what the options type promises a caller may do, and
 * not by the caller there is.
 */

const CONTEXT_KEY = 'character/chat'
const MESSAGE_COUNT = 10
/** What the measured chat reported on every frame of the autoscroll. */
const INITIAL_SCROLL_HEIGHT = 72717
const BASE_SCROLL_TOP = -200
/** The autoscroll's traced speed, and a frame at 60Hz. */
const FRAME_PX = -608
const FRAME_MS = 16

interface Row {
    index: number
    top: number
    bottom: number
}

const ROWS: Row[] = [
    { index: 4, top: -80, bottom: 100 },
    { index: 5, top: 110, bottom: 310 },
    // Far below the container's bottom edge, so the anchor is not `atLatest`
    // and a restore is not handed back to the appended-reply auto-scroll.
    { index: 9, top: 900, bottom: 1100 },
]

/**
 * A document tall enough to scroll through for a whole gesture.
 *
 * Three rows are enough to decide who moved the viewport, but not to watch the
 * anchor age: forty frames of 608px carries the reader 24320px, and with three
 * rows every one of them has left the viewport by the second frame, so a
 * re-read anchor would come back null and a test could not tell a fresh anchor
 * from no anchor at all. These rows span that travel, so a capture taken
 * mid-gesture finds a real row to anchor to. Index 55 crosses the viewport's
 * top edge at rest, history runs down to index 0 below it, and the newest row
 * sits far enough past the container's bottom edge that the anchor is never
 * `atLatest`.
 */
const GESTURE_MESSAGE_COUNT = 60
const GESTURE_ANCHOR_INDEX = 55
const GESTURE_ROW_HEIGHT = 800
const GESTURE_ROWS: Row[] = Array.from({ length: GESTURE_MESSAGE_COUNT }, (_, index) => {
    const top = -80 + (index - GESTURE_ANCHOR_INDEX) * GESTURE_ROW_HEIGHT
    return { index, top, bottom: top + GESTURE_ROW_HEIGHT - 20 }
})

function domRect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        left: 0,
        right: 600,
        width: 600,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
    } as DOMRect
}

/**
 * A scroll container that answers rect queries the way a browser's would:
 * raising `scrollTop` by N moves the rows up by N, and a content shift moves
 * everything below the loading asset down by the amount it grew.
 */
function createHarness(
    options: {
        rows?: Row[]
        messageCount?: number
        rowsMounted?: boolean
        enabled?: boolean
    } = {},
) {
    const rows = options.rows ?? ROWS
    const messageCount = options.messageCount ?? MESSAGE_COUNT
    /** `preserveChatScrollPosition`, which the controller re-reads at every site. */
    let enabled = options.enabled ?? true
    const container = document.createElement('div')
    let scrollTop = BASE_SCROLL_TOP
    let scrollHeight = INITIAL_SCROLL_HEIGHT
    let shift = 0
    let controllerRef: { handleContainerScroll: () => void } | null = null
    /** What `getContainer()` answers -- the screen unmounts its scroller. */
    let containerMounted = true
    /** Whether the harness plays back a `scrollTo`'s own scroll event. */
    let deliverRestoreEcho = true
    /** Every `getBoundingClientRect` on the container: one per anchor read. */
    let containerRectReads = 0

    Object.defineProperty(container, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (next: number) => { scrollTop = next },
    })
    Object.defineProperty(container, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
    })
    container.getBoundingClientRect = () => {
        containerRectReads += 1
        return domRect(0, 500)
    }

    const scrollTo = vi.fn((options: ScrollToOptions) => {
        const next = options.top ?? scrollTop
        const moved = next !== scrollTop
        scrollTop = next
        // A real container answers a scroll it was told to make with a scroll
        // event, dispatched a turn later and with nothing left flagged as
        // restoring. Without this the ladder's own corrections are the one kind
        // of scrolling the controller never has to tell apart from the reader's,
        // and the height comparison this suite exists to pin down is never
        // reached: every event the test delivers by hand happens to sit on the
        // offset the last restore wrote, so the echo slot answers for it.
        if (moved && deliverRestoreEcho) {
            setTimeout(() => { controllerRef?.handleContainerScroll() }, 0)
        }
    })
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo

    const rowElements = rows.map((row) => {
        const element = document.createElement('article')
        element.dataset.chatIndex = String(row.index)
        element.getBoundingClientRect = () => {
            const offset = shift - (scrollTop - BASE_SCROLL_TOP)
            return domRect(row.top + offset, row.bottom + offset)
        }
        return element
    })
    if (options.rowsMounted !== false) container.append(...rowElements)

    const controller = createChatScrollAnchorController({
        getContainer: () => (containerMounted ? container : null),
        getContextKey: () => CONTEXT_KEY,
        getMessageCount: () => messageCount,
        isEnabled: () => enabled,
    })
    controllerRef = controller

    return {
        container,
        controller,
        scrollTo,
        /** How many times the anchor has been read: one container rect per capture. */
        get anchorReads() { return containerRectReads },
        /** The rows render. */
        mountRows() { container.append(...rowElements) },
        /**
         * The screen has no scroller for the controller to measure -- the
         * `bind:this` binding is empty, which is the state the options type
         * calls "nothing while the screen has none mounted".
         */
        unmountContainer() { containerMounted = false },
        remountContainer() { containerMounted = true },
        /**
         * The reader moves the `preserveChatScrollPosition` switch. Every site
         * that consults it reads through this, so a flip lands on the next call
         * rather than at the next construction.
         */
        setEnabled(next: boolean) { enabled = next },
        /**
         * Stop replaying the scroll event a `scrollTo` causes. A restore's echo
         * is dispatched a turn later, so the reader's next frame can reach the
         * handler first and find the echo still outstanding.
         */
        withholdRestoreEcho() { deliverRestoreEcho = false },
        /** An asset above the viewport finished loading: more document, pushed down. */
        growContent(pixels: number) {
            shift += pixels
            scrollHeight += pixels
        },
        /**
         * More document, but not above the reader: an asset resolving its size
         * further up the history than the anchored row. `scrollHeight` grows,
         * every row stays exactly where it was, and in this `flex-col-reverse`
         * container `scrollTop` is preserved -- so the browser dispatches no
         * scroll event, and nothing but the controller's own bookkeeping can
         * know the document changed.
         */
        growHeightOnly(pixels: number) {
            scrollHeight += pixels
        },
        /** The reader moved the viewport; the document is untouched. */
        scrollBy(pixels: number) {
            scrollTop += pixels
        },
        /**
         * One frame of browser-driven scrolling: the viewport moves and the
         * container reports it, with nothing saying who moved it.
         */
        scrollFrame(pixels: number) {
            scrollTop += pixels
            controller.handleContainerScroll()
        },
        get scrollTop() { return scrollTop },
        /**
         * Take the first snapshot, and let the controller see one scroll event
         * so it has a previous `scrollHeight` to compare against.
         */
        primeAnchor() {
            controller.scheduleCapture(0)
            vi.advanceTimersByTime(1)
            controller.handleContainerScroll()
            vi.advanceTimersByTime(100)
        },
    }
}

describe('chat scroll anchor controller', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    test('browser-driven scrolling with an unchanged scrollHeight ends the ladder', () => {
        const harness = createHarness()
        harness.primeAnchor()

        // An asset settles, and the scroll event it causes puts the grown height
        // on record -- so the frames below are compared against the height they
        // actually have, as they would be in a chat the reader has been scrolling
        // through for a while.
        harness.growContent(300)
        harness.controller.handleContainerScroll()

        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        // The forty frames of middle-click autoscroll, replayed: no `wheel`, no
        // further `pointerdown`, nothing but scroll events over a document whose
        // height never moves.
        for (let frame = 0; frame < 40; frame += 1) {
            harness.scrollBy(FRAME_PX)
            harness.controller.handleContainerScroll()
        }
        const scrolledTo = harness.scrollTop

        // Past the whole ladder, including the 2100ms entry that used to snap the
        // reader back to the newest end.
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        expect(harness.scrollTop).toBe(scrolledTo)
    })

    test('a ladder keeps correcting while the content is still shifting', () => {
        const harness = createHarness()
        harness.primeAnchor()

        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        // Two more assets settle. Each one is a real content shift, so each one
        // is corrected -- and the scroll events they cause must not be mistaken
        // for the reader, which is what the height comparison decides.
        for (const [growth, delay] of [[220, 80], [140, 100]] as const) {
            harness.growContent(growth)
            harness.controller.handleContainerScroll()
            vi.advanceTimersByTime(delay)
        }

        expect(harness.scrollTo).toHaveBeenCalledTimes(3)

        // And the ladder runs to its end rather than being cut short: a shift
        // arriving just before the last entry is still corrected.
        harness.growContent(90)
        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).toHaveBeenCalledTimes(4)
    })

    test('a restore does not cancel its own ladder through the scroll event it causes', () => {
        const harness = createHarness()
        harness.primeAnchor()

        // The shift's own scroll event, delivered before the ladder starts, so
        // the height it grew to is already the one on record. Every scroll event
        // from here until the next shift reports that same height -- including
        // the ladder's own -- which is what makes the echo indistinguishable
        // from the reader by height alone.
        harness.growContent(300)
        harness.controller.handleContainerScroll()

        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        // `scrollTo({ behavior: 'instant' })` dispatches its scroll event a turn
        // later, by which point nothing in the controller is still flagged as
        // restoring, and it reports the height the rung that caused it had just
        // read back -- so by height alone an echo is a reader scroll. The
        // harness delivers that event itself, as the container does.
        //
        // Rung 0's echo is not the one that decides this. It lands about a turn
        // after `queueRestore`, inside the shift's own 32ms grace window, which
        // would swallow it whether or not the slot recognised it. The rung below
        // is past that window: a second asset settles with no scroll event of
        // its own, the 80ms rung corrects it and records the height it left
        // behind, and the echo that correction dispatches has nothing but the
        // offset that same rung wrote to be told apart by.
        harness.growContent(150)
        vi.advanceTimersByTime(120)
        expect(harness.scrollTo).toHaveBeenCalledTimes(2)

        // A third asset, with no scroll event of its own: only a ladder that
        // survived the 80ms rung's echo is still alive to correct it.
        harness.growContent(90)
        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).toHaveBeenCalledTimes(3)
    })

    test('a gesture on the container still ends the ladder outright', () => {
        const harness = createHarness()
        harness.primeAnchor()

        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        harness.controller.handleDirectScrollInteraction()
        harness.growContent(150)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
    })

    test('a gesture re-anchors where the reader is now, so a shift landing in a wheel gesture is corrected by what the content grew', () => {
        const harness = createHarness({
            rows: GESTURE_ROWS,
            messageCount: GESTURE_MESSAGE_COUNT,
        })

        // Primed without the idle tail `primeAnchor` leaves, so the anchor is
        // fresh as the gesture opens. That is what takes the staleness cap out
        // of the picture below: the cap is what rescues a gesture the browser
        // runs by itself, and this one has a `wheel` of its own per notch.
        harness.controller.scheduleCapture(0)
        vi.advanceTimersByTime(1)
        harness.controller.handleContainerScroll()

        // Three notches of wheel scrolling, 8ms apart. `wheel` is dispatched
        // before the scroll it causes, so each notch re-anchors on the position
        // the one before it left, and the whole gesture is over inside the 32ms
        // staleness cap -- no scroll event here is ever starved, and the 55ms
        // debounce is re-armed by each notch and never fires.
        for (let notch = 0; notch < 3; notch += 1) {
            harness.controller.handleDirectScrollInteraction()
            harness.scrollFrame(FRAME_PX)
            vi.advanceTimersByTime(8)
        }
        const scrolledTo = harness.scrollTop
        expect(scrolledTo).toBe(BASE_SCROLL_TOP + 3 * FRAME_PX)

        // An image above the reader finishes loading before the gesture's
        // trailing debounce has run.
        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(3000)

        // The correction is the size of the shift, and the slack is the one
        // notch the anchor is behind by -- `wheel` arrives ahead of its own
        // scroll, so the freshest anchor a notch can take is the position the
        // previous notch settled at. Strip the re-anchor and the only snapshot
        // left is the one from before the gesture: the correction is then the
        // whole 1824px of travel plus the shift, and the reader is thrown back
        // past where they started reading.
        const correction = harness.scrollTop - scrolledTo
        expect(correction).toBeGreaterThanOrEqual(300)
        expect(correction).toBeLessThanOrEqual(300 + -FRAME_PX)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
    })

    test('a long gesture cannot starve the capture, so a shift landing in it is corrected by what the content grew', () => {
        const harness = createHarness({
            rows: GESTURE_ROWS,
            messageCount: GESTURE_MESSAGE_COUNT,
        })
        harness.primeAnchor()

        // Forty frames of middle-click autoscroll: 608px each, 16ms apart, and
        // every gap shorter than the 55ms capture debounce. A debounce left to
        // itself is re-armed by each of them and never fires, so the anchor
        // would still hold the position the gesture started from.
        for (let frame = 0; frame < 40; frame += 1) {
            harness.scrollFrame(FRAME_PX)
            vi.advanceTimersByTime(FRAME_MS)
        }
        const scrolledTo = harness.scrollTop
        expect(scrolledTo).toBe(BASE_SCROLL_TOP + 40 * FRAME_PX)

        // An image above the reader finishes loading in the middle of it.
        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(3000)

        // The correction is the size of the shift, not the size of the gesture.
        // The slack is what the anchor may be behind by: the staleness cap is
        // only consulted when a scroll event arrives, so at most the cap plus
        // one frame of travel -- against the 24320px the whole gesture covered.
        const correction = harness.scrollTop - scrolledTo
        expect(correction).toBeGreaterThanOrEqual(300)
        expect(correction).toBeLessThanOrEqual(300 + 2 * -FRAME_PX)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
    })

    test("the scroll event a shift's own adjustment dispatches does not end that shift's ladder", () => {
        const harness = createHarness()
        harness.primeAnchor()

        // The shift is announced first -- a `load` or a MutationObserver batch
        // -- which is when the controller records the height. If the browser
        // then adjusts `scrollTop` to account for the growth, the scroll event
        // that adjustment dispatches reports the height already on record: by
        // height alone it is a reader scroll, and cancelling on it would end the
        // ladder in the first frame of the thing the ladder exists for.
        harness.growContent(300)
        harness.controller.queueRestore()
        harness.scrollFrame(-40)

        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
    })

    test('layout settling between rungs is charged to the shift, not to the reader who scrolls next', () => {
        const harness = createHarness()
        harness.primeAnchor()

        // A shift that grows the document without moving the anchored row, so
        // every rung returns 'stable' and no restore echo is ever produced.
        harness.growHeightOnly(400)
        harness.controller.queueRestore()

        // The layout goes on settling between rungs -- an image decoding, an
        // inlay resolving its intrinsic size -- again with no scroll event of
        // its own. The 80ms rung is what reads that back.
        vi.advanceTimersByTime(40)
        harness.growHeightOnly(200)
        vi.advanceTimersByTime(50)

        // The reader now starts a scrollbar drag: no `wheel`, no `pointerdown`,
        // and a document that has not grown since the controller last looked.
        // If the settling were still unaccounted for, this frame would be scored
        // as a content shift and buy the ladder a free rung to undo it with.
        harness.scrollFrame(FRAME_PX)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).not.toHaveBeenCalled()
    })

    test('a silent shift does not buy the ladder a free rung out of the reader\'s first frames', () => {
        const harness = createHarness()
        harness.primeAnchor()

        // Growth that dispatches no scroll event at all, so nothing but
        // `queueRestore` itself can put the new height on record.
        harness.growHeightOnly(400)
        harness.controller.queueRestore()

        // Two frames of the reader's drag, both reaching the handler before the
        // ladder's first rung does. That ordering is the one findings 6 and 9
        // turn on: the rung is a `setTimeout(0)` queued from the mutation
        // callback, and a scroll event dispatched in the same rendering update
        // can be delivered ahead of it. The first frame is the one event the
        // shift's grace window is allowed to swallow; the second is the reader's
        // again, and must end the ladder before any rung can undo their travel.
        harness.scrollFrame(FRAME_PX)
        harness.scrollFrame(FRAME_PX)

        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).not.toHaveBeenCalled()
    })

    /**
     * The same grace window as the test above, entered from a reset instead of
     * from a chat that has been scrolled -- and named for that rather than for
     * the height bookkeeping, because it is not what carries it. Checked by
     * mutation: deleting the grace window's `else if` fails this test, and
     * deleting `lastScrollHeight = container.scrollHeight` from `captureNow`
     * does not. The height taken at capture is overwritten by `queueRestore`
     * before any event arrives here, so it cannot be what decides this. The
     * case where it does decide is the one after this.
     */
    test('a shift announced before any scroll event has been seen still gets its ladder', () => {
        const harness = createHarness()

        // What a conversation switch leaves behind: the effect's cleanup resets
        // the controller and its setup takes one snapshot, and nothing has
        // scrolled the container in between -- a chat with no stored view
        // session, or one already at its newest end, dispatches no scroll event
        // on entry. The freshly mounted chat's avatars are loading meanwhile,
        // which is exactly what the ladder is for.
        harness.controller.reset()
        harness.controller.scheduleCapture(0)
        vi.advanceTimersByTime(1)

        harness.growContent(300)
        harness.controller.queueRestore()
        harness.controller.handleContainerScroll()
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalled()
    })

    test('a shift announced while the screen has no scroller is still measured against the height the anchor was taken at', () => {
        const harness = createHarness()
        harness.controller.scheduleCapture(0)
        vi.advanceTimersByTime(1)

        // The one path on which the height recorded at capture is the only one
        // there is. `getContainer()` is allowed to come back empty -- the
        // options type says "nothing while the screen has none mounted" -- and
        // when the mutation that announces a shift is delivered in that window,
        // `queueRestore` has nothing to measure and records no height of its
        // own. Delete the capture's record too and the ladder starts with the
        // height unknown, which reads as "the document stood still": the verdict
        // that ends a ladder, handed down over a document that grew 300px.
        harness.growContent(300)
        harness.unmountContainer()
        harness.controller.queueRestore()
        harness.remountContainer()

        // Two reader frames, both reaching the handler before the 0ms rung, as
        // in the silent-shift test above. The first is charged to the growth the
        // capture's height proves happened; the second is the one the grace
        // window spends. That is one frame of the reader's travel more than the
        // usual path costs them, and it is what a ladder that survives at all
        // costs here: without it the shift goes uncorrected and the reader is
        // thrown forward by the whole 300px instead.
        harness.scrollFrame(FRAME_PX)
        harness.scrollFrame(FRAME_PX)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        expect(harness.scrollTop).toBe(100)
    })

    test('the echo slot is emptied the moment it matches, so the reader is not answered with it twice', () => {
        const harness = createHarness()
        harness.primeAnchor()

        harness.growContent(300)
        harness.controller.handleContainerScroll()

        harness.controller.queueRestore()
        // Rung 0 restores, and the scroll event that restore causes arrives and
        // is matched against the slot.
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        // Past the shift's own grace window, and short of the 80ms rung, so the
        // event below has nothing else to hide behind.
        vi.advanceTimersByTime(40)

        // One pixel of the reader's own, which is inside
        // `RESTORE_ECHO_TOLERANCE_PX`: a slot still holding the offset that
        // restore wrote would answer for this event as a second echo, and the
        // ladder would go on owning the scroll position.
        harness.scrollBy(1)
        harness.controller.handleContainerScroll()

        // The layout settles further, with no scroll event of its own -- only a
        // ladder that survived the pixel above can act on it.
        harness.growContent(150)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        expect(harness.scrollTop).toBe(101)
    })

    test("a reader's frame is not taken for a restore echo just because a restore is outstanding", () => {
        const harness = createHarness()
        // The restore's own scroll event is dispatched a turn later, and the
        // reader's next frame can reach the handler ahead of it. Held back here
        // so the slot is still armed when that frame arrives.
        harness.withholdRestoreEcho()
        harness.primeAnchor()

        harness.growContent(300)
        harness.controller.handleContainerScroll()
        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(40)

        // 608px from the offset the restore wrote. The tolerance is a pixel,
        // for subpixel offsets reported back rounded, and nothing wider: widen
        // it and the reader's own travel is swallowed as an echo and yanked back.
        harness.scrollBy(FRAME_PX)
        harness.controller.handleContainerScroll()
        const scrolledTo = harness.scrollTop

        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        expect(harness.scrollTop).toBe(scrolledTo)
    })

    test('a rung that finds nothing to correct leaves the echo slot to the restore still in flight', () => {
        const harness = createHarness()
        // The echo is played back by hand below, after the rung that has to
        // leave it alone. A `scrollTo` answers with its scroll event a turn
        // later at the earliest, and the slot holds the offset until it comes.
        harness.withholdRestoreEcho()
        harness.primeAnchor()

        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(1)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        // A second asset settles, and the browser's own scroll anchoring
        // compensates for it: the document grows 100px and `scrollTop` moves
        // 100px with it, so the anchored row lands back exactly where the
        // snapshot has it. The scroll event that adjustment dispatches reports
        // the growth, so it is scored as content rather than as the reader and
        // the ladder rightly survives it -- but the position is now 100px away
        // from the one the first rung wrote.
        harness.growContent(100)
        harness.scrollFrame(100)

        // The 80ms rung, which finds that row already in place: 'stable', no
        // `scrollTo`, and so no echo of its own to expect.
        vi.advanceTimersByTime(80)
        expect(harness.scrollTo).toHaveBeenCalledTimes(1)

        // The first rung's echo, finally delivered. It reports a position two
        // moves stale, which is not the one the slot is holding, so it ends the
        // ladder -- the same outcome as an unmatched gesture, and the one the
        // single slot is documented to accept. A 'stable' rung that had
        // overwritten the slot with the position it merely observed would make
        // this match instead, and hand the ladder the reader's own position to
        // keep correcting from.
        harness.controller.handleContainerScroll()

        // The layout settles once more, with no scroll event of its own: only
        // a ladder that survived the event above can act on it.
        harness.growContent(150)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
        expect(harness.scrollTop).toBe(200)
    })

    test('a continuous scroll re-reads the anchor on the staleness cap, not once per event', () => {
        const harness = createHarness({
            rows: GESTURE_ROWS,
            messageCount: GESTURE_MESSAGE_COUNT,
        })
        harness.primeAnchor()

        const before = harness.anchorReads
        for (let frame = 0; frame < 40; frame += 1) {
            harness.scrollFrame(FRAME_PX)
            vi.advanceTimersByTime(FRAME_MS)
        }

        // 40 frames 16ms apart is 640ms of scrolling, and one read per 32ms cap
        // is 20 of them. What holds it there is the controller recording when it
        // last read: stop recording and every request with a capture pending
        // counts as starved, which is a rect sweep per mounted row per scroll
        // event -- the per-event cost the debounce exists to avoid.
        expect(harness.anchorReads - before).toBe(20)
        expect(harness.scrollTo).not.toHaveBeenCalled()
    })

    test('a starved immediate capture still leaves the deliberate delay armed', () => {
        const harness = createHarness({ rowsMounted: false })

        // The screen mounts and asks for its first snapshot, and the chat has
        // not put its rows in the DOM yet, so the read comes back empty.
        harness.controller.scheduleCapture(0)
        vi.advanceTimersByTime(1)
        // Long enough that the anchor on record is older than the staleness cap.
        vi.advanceTimersByTime(40)

        // A scroll event arms the 55ms debounce, and an avatar finishes loading
        // in the same frame. There is no anchor, so `queueRestore` asks for a
        // capture 80ms out -- a deliberate delay, waiting for the layout this
        // shift is still settling into. That request is starved, so it reads at
        // once as well, and reads nothing again. The re-arm is what is left.
        harness.controller.handleContainerScroll()
        harness.controller.queueRestore()

        // The rows arrive 60ms later: past the 55ms the scroll event had
        // already armed, and short of the 80ms the shift asked for. Both delays
        // are live in this frame and only their difference decides the outcome
        // -- a capture that fires at 55 sweeps an empty container and takes no
        // anchor, one that fires at 80 finds the rows. Without the window
        // between them the surviving 55ms debounce answers for the 80ms request
        // and the delay this test is named for is pinned by nothing.
        vi.advanceTimersByTime(60)
        harness.mountRows()
        vi.advanceTimersByTime(30)

        // Drop the re-arm on a starved request and the 80ms delay goes with it:
        // no anchor is ever taken, and the next shift is a no-op.
        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).toHaveBeenCalledTimes(1)
    })

    /**
     * The setting is the reader's answer to the whole feature, so a controller
     * that ignores it is worse than one that was never written: it moves the
     * scroll position of someone who asked for it to be left alone.
     *
     * Four sites consult it -- `captureNow`, `scheduleCapture`, `queueRestore`
     * and the rung -- and they shield each other, so switching it off in one
     * state does not exercise all four. Reading it fresh at each of them is what
     * the options type promises ("read fresh so the toggle takes effect at
     * once"), and it is what the three states below are for: off from the start,
     * off while a ladder is already armed, and off at the moment a shift is
     * announced with the switch coming back on afterwards.
     */
    test('the preserveChatScrollPosition switch is obeyed at every site, so turning it off leaves nothing running and queues nothing for when it returns', () => {
        const harness = createHarness({ enabled: false })

        // Off from the start. A first snapshot request, a scroll event and a
        // gesture between them reach every path that would read the anchor, and
        // the anchor costs a `getBoundingClientRect` per mounted row, which is
        // the work a reader who declined the feature is not asked to pay for.
        harness.controller.scheduleCapture(0)
        vi.advanceTimersByTime(1)
        harness.controller.handleContainerScroll()
        harness.controller.handleDirectScrollInteraction()
        vi.advanceTimersByTime(100)
        expect(harness.anchorReads).toBe(0)

        // And with no anchor ever taken, a shift is not something to correct.
        harness.growContent(300)
        harness.controller.queueRestore()
        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).not.toHaveBeenCalled()

        // Switched on, an anchor taken, and a shift announced while it is still
        // on -- so the ladder is armed with every guard satisfied. The switch
        // then goes off before the first rung runs, which is the state a reader
        // reaches by turning the setting off while a page of avatars is loading.
        harness.setEnabled(true)
        harness.primeAnchor()
        harness.growContent(300)
        harness.controller.queueRestore()
        harness.setEnabled(false)
        vi.advanceTimersByTime(3000)
        expect(harness.scrollTo).not.toHaveBeenCalled()

        // Off again, and this time the anchor on record survives from when it
        // was on, so a shift announced now has everything it needs except
        // permission. Switching back on afterwards must not collect it: the
        // ladder is not to be armed and left waiting, and neither is the capture
        // that a refused `queueRestore` would otherwise fall back on.
        const readsBeforeReturn = harness.anchorReads
        harness.growContent(300)
        harness.controller.queueRestore()
        harness.setEnabled(true)
        vi.advanceTimersByTime(3000)

        expect(harness.scrollTo).not.toHaveBeenCalled()
        expect(harness.anchorReads).toBe(readsBeforeReturn)
        expect(harness.scrollTop).toBe(BASE_SCROLL_TOP)
    })
})
