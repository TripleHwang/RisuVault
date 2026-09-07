const MIN_CORRECTION_PX = 1.25

export interface ChatScrollAnchor {
    contextKey: string
    messageIndex: number
    messageCount: number
    offsetTop: number
    atLatest: boolean
}

export type ChatScrollRestoreResult =
    | 'restored'
    | 'stable'
    | 'context-changed'
    | 'missing'
    | 'new-message'

function getIndexedMessages(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-chat-index]'))
        .map((element) => ({
            element,
            index: Number(element.dataset.chatIndex),
            rect: element.getBoundingClientRect(),
        }))
        .filter((message) => Number.isInteger(message.index) && message.index >= 0)
}

export function captureChatScrollAnchor(
    container: HTMLElement,
    contextKey: string,
    messageCount: number,
): ChatScrollAnchor | null {
    if (!contextKey || messageCount <= 0) return null

    const containerRect = container.getBoundingClientRect()
    const viewportTop = containerRect.top + 1
    const viewportBottom = containerRect.bottom - 1
    const messages = getIndexedMessages(container)
    let selected: (typeof messages)[number] | null = null
    let bestScore = Number.POSITIVE_INFINITY

    for (const message of messages) {
        if (message.rect.bottom <= viewportTop || message.rect.top >= viewportBottom) continue
        const crossesTop = message.rect.top <= viewportTop && message.rect.bottom > viewportTop
        const score = crossesTop
            ? Math.abs(message.rect.top - viewportTop) * 0.001
            : Math.abs(message.rect.top - viewportTop) + 10
        if (score < bestScore) {
            selected = message
            bestScore = score
        }
    }

    if (!selected) return null
    const newest = messages.reduce<(typeof messages)[number] | null>(
        (current, message) => !current || message.index > current.index ? message : current,
        null,
    )

    return {
        contextKey,
        messageIndex: selected.index,
        messageCount,
        offsetTop: selected.rect.top - containerRect.top,
        atLatest: Boolean(newest && newest.rect.top <= containerRect.bottom + 100),
    }
}

export function restoreChatScrollAnchor(
    container: HTMLElement,
    anchor: ChatScrollAnchor,
    contextKey: string,
    messageCount: number,
): ChatScrollRestoreResult {
    if (anchor.contextKey !== contextKey) return 'context-changed'
    if (anchor.messageIndex >= messageCount) return 'missing'
    if (anchor.atLatest && messageCount > anchor.messageCount) return 'new-message'

    const target = container.querySelector<HTMLElement>(
        `[data-chat-index="${anchor.messageIndex}"]`,
    )
    if (!target) return 'missing'

    const currentOffset = target.getBoundingClientRect().top
        - container.getBoundingClientRect().top
    const delta = currentOffset - anchor.offsetTop
    if (Math.abs(delta) < MIN_CORRECTION_PX) return 'stable'

    container.scrollTo({
        top: container.scrollTop + delta,
        behavior: 'instant',
    })
    return 'restored'
}

/**
 * When a content shift is corrected, in milliseconds after the mutation that
 * announced it.
 *
 * A single correction is not enough. A `load` event fires before the image is
 * laid out, an inlay asset can resize again once its intrinsic size is known,
 * and a re-rendered message settles over several frames. The ladder re-applies
 * the same anchor until the layout stops moving; the entries that find nothing
 * to correct return `'stable'` and cost one rect read each.
 */
const SCROLL_ANCHOR_RESTORE_DELAYS = [0, 80, 180, 350, 700, 1300, 2100]

/**
 * How far a scroll position may sit from the position a restore just wrote and
 * still be recognised as that restore's own echo. Subpixel scroll offsets are
 * reported back rounded, so an exact comparison would miss.
 */
const RESTORE_ECHO_TOLERANCE_PX = 1

/**
 * The longest a continuous scroll may run without the anchor being re-read.
 *
 * `scheduleCapture` is a trailing debounce, and a browser dispatches scroll
 * events about once per frame -- 8 to 17ms, always shorter than the 55ms delay
 * -- so a debounce left to itself is re-armed on every frame and fires only
 * once the scrolling has stopped. For the whole of a gesture the anchor then
 * still holds the position the gesture started from, and a content shift
 * arriving mid-gesture is corrected by the reader's entire travel instead of by
 * the amount the content grew: forty frames of the traced 608px-per-frame
 * autoscroll is a 24k px correction, which lands the reader back where they
 * began. Wheel scrolling escapes this only because `wheel` fires per notch and
 * re-anchors directly; the gestures that emit nothing while running -- middle-
 * click autoscroll, a scrollbar drag, touch momentum -- are the same three this
 * discrimination exists for.
 *
 * Two frames at 60Hz, one at 120Hz. Since the cap is only consulted when a
 * scroll event arrives, the anchor can reach the cap plus one frame before it
 * is re-read. The bound comes from how far a surviving correction may then drag
 * the reader, which is that age times scroll speed: under 2k px at the speed
 * traced above, against the 24k px a whole gesture gives.
 *
 * Cost does not set it -- a capture is one `getBoundingClientRect` per mounted
 * row, at most the 60 the chat window keeps mounted, and about 0.1ms for the
 * sweep, so one per 32ms is roughly 0.3% of the time spent scrolling against
 * roughly 0.6% for the per-event capture the debounce exists to avoid. Below
 * one frame there is nothing left to buy, since the position only moves once
 * per frame.
 */
const MAX_ANCHOR_STALENESS_MS = 32

/**
 * How long after a content shift is announced that shift's own adjustment
 * scroll event may still arrive and be told apart from the reader's scrolling.
 *
 * The height is recorded when the shift is announced, so if the browser then
 * adjusts `scrollTop` for it, the event that adjustment dispatches reports a
 * height that is no longer new -- by height alone it is indistinguishable from
 * a reader scroll, and it would end the ladder before its first rung had
 * settled anything. That event arrives within a frame of the mutation; two
 * frames covers a mutation observed just after a rendering update.
 *
 * The window is spent on the first event that would otherwise cancel, as well
 * as expiring, for the same reason the echo slot is single: a reader who starts
 * moving inside it gives up one frame of travel and cancels on their next
 * event, rather than the window swallowing every event it spans.
 */
const CONTENT_SHIFT_ADJUSTMENT_GRACE_MS = 32

export interface ChatScrollAnchorControllerOptions {
    /** The chat scroll container, or nothing while the screen has none mounted. */
    getContainer: () => HTMLElement | null | undefined
    /** Identifies the conversation; an anchor never crosses a change in it. */
    getContextKey: () => string
    getMessageCount: () => number
    /** `preserveChatScrollPosition`, read fresh so the toggle takes effect at once. */
    isEnabled: () => boolean
}

export interface ChatScrollAnchorController {
    /**
     * Re-read the anchor after `delay` ms, replacing any capture already
     * pending -- and read it straight away as well if the one on record has
     * gone stale, which is what stops repeated calls deferring it indefinitely.
     */
    scheduleCapture: (delay?: number) => void
    /** Start a restore ladder for the anchor last captured. */
    queueRestore: () => void
    /** A gesture on the container: drop the ladder and re-anchor where the reader is now. */
    handleDirectScrollInteraction: () => void
    /** The container's `scroll` event, from any cause. */
    handleContainerScroll: () => void
    /** Forget the anchor and every timer, e.g. when the conversation changes. */
    reset: () => void
}

/**
 * Keeps the reader's place across content shifts, and gets out of the way of
 * the reader.
 *
 * The correction is worth making because an image or inlay asset that finishes
 * loading above the viewport pushes everything below it down, which in this
 * `flex-col-reverse` container throws the reader forward through text they had
 * not read yet. It is worth making repeatedly because the layout takes a while
 * to settle, hence the ladder.
 *
 * The cost of a ladder is that for as long as it runs the container's scroll
 * position is not the reader's to set: every entry drags it back to a snapshot
 * taken before the shift, and `freezeUntil` stops a new anchor being captured
 * in between. That is correct while the layout is moving underneath a reader
 * who is holding still, and completely wrong the moment the reader is the one
 * moving -- which is why the two are told apart below rather than assumed.
 */
export function createChatScrollAnchorController(
    options: ChatScrollAnchorControllerOptions,
): ChatScrollAnchorController {
    let currentAnchor: ChatScrollAnchor | null = null
    let captureTimer: ReturnType<typeof setTimeout> | null = null
    /**
     * When the anchor was last actually read, which is what bounds how far the
     * debounce may be pushed out by scroll events arriving faster than it.
     * Zero counts as never, so the first request after a reset reads at once.
     */
    let lastCaptureAt = 0
    let restoreTimers: ReturnType<typeof setTimeout>[] = []
    /** Invalidates the timers of a superseded ladder without clearing them. */
    let mutationToken = 0
    /** Until when capturing is suppressed, so a ladder anchors to one snapshot. */
    let freezeUntil = 0
    let restoring = false
    /**
     * The container's `scrollHeight` as of the last point the controller had
     * first-hand knowledge of it -- a capture, an announced content shift, a
     * ladder rung or a scroll event -- which is what says whether the document
     * moved or only the viewport into it did.
     *
     * Recorded at all four rather than at scroll events alone because a height
     * change nobody recorded is charged to whichever scroll event arrives next,
     * and that is normally the reader's. Null only before the first anchor is
     * taken, and a ladder cannot exist without an anchor, so the unknown state
     * is unreachable on the path that would score it as a reader scroll.
     */
    let lastScrollHeight: number | null = null
    /**
     * Until when a scroll event may still be the adjustment the announced
     * content shift caused, rather than the reader. Zeroed when it is spent.
     */
    let shiftAdjustmentGraceUntil = 0
    /**
     * The `scrollTop` the most recent `'restored'` left behind, held until the
     * scroll event it causes arrives.
     *
     * One slot rather than a queue. Ladder entries are at least 80ms apart and a
     * scroll event follows its `scrollTo` within a frame, so two echoes are not
     * normally outstanding together; and when a newer restore does overwrite the
     * slot, the older echo goes unmatched and ends the ladder early -- the same
     * outcome as a real gesture, and one the immediate re-capture recovers from.
     * A queue would trade that for the opposite failure: a stale entry matching,
     * and swallowing, a genuine reader scroll. That is the failure this whole
     * discrimination exists to prevent, so the slot stays single and is cleared
     * eagerly.
     *
     * Only `'restored'` writes it. `'stable'` issues no `scrollTo` and so causes
     * no scroll event, and must leave the slot alone: an earlier restore's echo
     * can still be in flight behind it.
     */
    let expectedEchoScrollTop: number | null = null

    function clearTimers() {
        if (captureTimer) clearTimeout(captureTimer)
        captureTimer = null
        for (const timer of restoreTimers) clearTimeout(timer)
        restoreTimers = []
    }

    function captureNow() {
        const container = options.getContainer()
        if (!options.isEnabled() || !container || restoring || Date.now() < freezeUntil) return
        lastCaptureAt = Date.now()
        // The height as of the anchor, and a measured one rather than an
        // assumption: an unrecorded height reads as "the document stood still",
        // which is the verdict that ends a ladder. Taking it here puts a height
        // on record before any ladder can exist, since a ladder needs an anchor
        // and an anchor is only ever taken here. Nor can it launder a post-shift
        // height into a pending ladder's comparison: the guard above holds
        // capturing off for the whole of a ladder, and a shift is what starts
        // one.
        //
        // Not made redundant by the record `queueRestore` takes, because that
        // one can only be taken when `getContainer()` has something to measure.
        // A shift announced while the screen has no scroller mounted arms a
        // ladder and records no height at all, and this is then the only height
        // that ladder has to compare against; without it the ladder's first
        // event is scored as a reader scroll over a document that grew. That is
        // the one path on which this line decides anything, and it is what 'a
        // shift announced while the screen has no scroller is still measured
        // against the height the anchor was taken at' drives.
        lastScrollHeight = container.scrollHeight
        currentAnchor = captureChatScrollAnchor(
            container,
            options.getContextKey(),
            options.getMessageCount(),
        )
    }

    function scheduleCapture(delay = 55) {
        if (!options.isEnabled()) return
        // A capture that is already pending and is now being pushed out again,
        // with the anchor older than the cap, is being starved rather than
        // debounced: read it before re-arming. A request with nothing pending
        // is not, and keeps its delay whole -- which is what leaves a lone
        // scroll event arriving just before a shift is announced unable to
        // re-anchor onto the shifted layout, since `queueRestore` freezes
        // capturing within the same task.
        const starved = captureTimer !== null
            && Date.now() - lastCaptureAt >= MAX_ANCHOR_STALENESS_MS
        if (captureTimer) clearTimeout(captureTimer)
        captureTimer = null
        if (starved) captureNow()
        // Armed either way: this is what reads the position a gesture finally
        // settles at, and what the callers passing a deliberate delay are
        // waiting for. It does not fire during a continuous scroll, where the
        // cap alone sets the cadence.
        captureTimer = setTimeout(() => {
            captureTimer = null
            captureNow()
        }, delay)
    }

    /**
     * Abandon the pending ladder and hand the scroll position back, without
     * touching the anchor itself. Capturing here would cost a
     * `getBoundingClientRect` per mounted row, which a caller running on every
     * scroll event cannot afford; those callers lean on the capture that the
     * cleared freeze now lets through. Nothing captured for the duration of the
     * ladder, so the anchor is already older than the staleness cap: the next
     * scroll event arms the debounce and the one after that reads the anchor,
     * about a frame later, instead of waiting out a debounce the reader keeps
     * re-arming for as long as they keep moving.
     */
    function cancelPendingRestores() {
        mutationToken += 1
        for (const timer of restoreTimers) clearTimeout(timer)
        restoreTimers = []
        freezeUntil = 0
        expectedEchoScrollTop = null
    }

    function queueRestore() {
        if (!options.isEnabled() || !currentAnchor) {
            scheduleCapture(80)
            return
        }

        // The height as of the shift, taken at the moment the shift is
        // announced instead of waiting for a scroll event to notice it. Growth
        // outside the viewport of this `flex-col-reverse` container leaves
        // `scrollTop` where it was and so dispatches no scroll event at all,
        // and an unrecorded height change is then charged to the next event
        // that does arrive -- the reader's first frame, which reads as a
        // content shift and buys the ladder one free rung to undo that frame
        // with. Recorded here, the reader's events are only ever compared
        // against a height the reader's own scrolling did not change.
        const shiftedContainer = options.getContainer()
        if (shiftedContainer) lastScrollHeight = shiftedContainer.scrollHeight
        shiftAdjustmentGraceUntil = Date.now() + CONTENT_SHIFT_ADJUSTMENT_GRACE_MS

        const snapshot = { ...currentAnchor }
        const token = ++mutationToken
        for (const timer of restoreTimers) clearTimeout(timer)
        expectedEchoScrollTop = null
        freezeUntil = Date.now() + SCROLL_ANCHOR_RESTORE_DELAYS.at(-1)! + 0
        restoreTimers = SCROLL_ANCHOR_RESTORE_DELAYS.map((delay, index) =>
            setTimeout(() => {
                const container = options.getContainer()
                if (
                    token !== mutationToken
                    || !options.isEnabled()
                    || !container
                ) return

                restoring = true
                const result = restoreChatScrollAnchor(
                    container,
                    snapshot,
                    options.getContextKey(),
                    options.getMessageCount(),
                )
                restoring = false

                // Layout goes on settling between rungs -- an image decoding,
                // an inlay resolving its intrinsic size -- and each of those
                // moves the height with no scroll event of its own. Reading it
                // back here denies the reader's next scroll the free pass that
                // the shift itself no longer gets.
                lastScrollHeight = container.scrollHeight

                if (result === 'restored') {
                    // Read back rather than computed: the container clamps the
                    // requested offset to its own scroll range, and the echo has
                    // to be compared against what the container actually took.
                    expectedEchoScrollTop = container.scrollTop
                }

                if (result === 'context-changed') {
                    mutationToken += 1
                    return
                }
                if (index === SCROLL_ANCHOR_RESTORE_DELAYS.length - 1) {
                    freezeUntil = 0
                    scheduleCapture(55)
                }
            }, delay),
        )
    }

    function handleDirectScrollInteraction() {
        cancelPendingRestores()
        captureNow()
    }

    /**
     * Scroll events are the only notice this container gives of browser-driven
     * scrolling, and they do not say who caused them -- so `scrollHeight` is
     * asked instead.
     *
     * `pointerdown`, `wheel`, `touchstart` and `keydown` cover a gesture that
     * the reader is still making. They do not cover one the browser has taken
     * over: middle-click autoscroll emits a single `pointerdown` and then scrolls
     * by itself, and a scrollbar drag and a touch momentum fling emit nothing at
     * all once running. Measured against a real chat, autoscroll moved the
     * container about 608px per frame for some forty consecutive frames while
     * `scrollHeight` held at exactly 72717 throughout -- zero change on every
     * frame. A content shift is the opposite: it is a change in `scrollHeight`
     * by definition, since it is more or less document than there was before.
     *
     * So an unchanged height means the document stood still and only the view
     * into it moved, which nothing but the reader (or something acting for them)
     * does, and the ladder has no business overriding it.
     *
     * The height compared against is the last one the controller saw anywhere --
     * a capture, a shift it was told about, a ladder rung -- and not merely the
     * one the previous scroll event reported, so "unchanged" means nothing has
     * grown since the controller last looked rather than since the reader last
     * moved. Growth that dispatched no scroll event of its own is charged to the
     * shift that caused it instead of to the reader's next frame.
     */
    function handleContainerScroll() {
        const container = options.getContainer()
        if (!container) return

        const scrollHeight = container.scrollHeight
        const heightChanged = lastScrollHeight !== null && scrollHeight !== lastScrollHeight
        lastScrollHeight = scrollHeight

        if (restoreTimers.length > 0 && !heightChanged) {
            // `scrollTo({ behavior: 'instant' })` dispatches its scroll event
            // asynchronously, long after `restoring` has been reset, so a
            // restore's own event arrives here looking exactly like a reader
            // scroll: same height, different offset. Recognising it by the
            // offset it wrote is what keeps a ladder from cancelling itself.
            const isRestoreEcho = expectedEchoScrollTop !== null
                && Math.abs(container.scrollTop - expectedEchoScrollTop) <= RESTORE_ECHO_TOLERANCE_PX
            if (isRestoreEcho) expectedEchoScrollTop = null
            // The shift's own adjustment reports the height the shift already
            // put on record, so it looks like a reader scroll here and would
            // end the ladder in the first frame of the thing the ladder is for.
            // One event's worth of grace, then the reader has it back.
            else if (Date.now() < shiftAdjustmentGraceUntil) shiftAdjustmentGraceUntil = 0
            else cancelPendingRestores()
        }

        if (!restoring && Date.now() >= freezeUntil) scheduleCapture()
    }

    function reset() {
        mutationToken += 1
        currentAnchor = null
        clearTimers()
        freezeUntil = 0
        lastScrollHeight = null
        lastCaptureAt = 0
        shiftAdjustmentGraceUntil = 0
        expectedEchoScrollTop = null
    }

    return {
        scheduleCapture,
        queueRestore,
        handleDirectScrollInteraction,
        handleContainerScroll,
        reset,
    }
}
