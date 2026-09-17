import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Chats from './Chats.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'

/**
 * What replaced the previous/next page buttons.
 *
 * This file used to be `ChatPaginationConnections.test.ts`, which read
 * `Chats.svelte` and `DefaultChatScreen.svelte` as text and asserted that
 * `data-chat-page-previous` and friends appeared in them. That proved the
 * markup existed; it could not notice that the nav lived *inside* the
 * `flex-col-reverse` scroll container and scrolled out of reach the first time
 * it was used. So everything below drives the real component: a real mount, a
 * real DOM, and the browser's intersection reporting stood in for -- because
 * happy-dom's IntersectionObserver never fires -- so the window is moved by
 * exactly the signal that moves it in a browser.
 */

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'
const NEWER_SENTINEL = '[data-chat-sentinel="newer"]'

class RecordingIntersectionObserver {
    static live: RecordingIntersectionObserver[] = []
    targets = new Set<Element>()
    constructor(private readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
        RecordingIntersectionObserver.live.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() {
        this.targets.clear()
        RecordingIntersectionObserver.live = RecordingIntersectionObserver.live.filter(observer => observer !== this)
    }
    takeRecords(): IntersectionObserverEntry[] { return [] }

    /** Report the sentinel matching `selector` as having scrolled into view. */
    reportVisible(selector: string) {
        const target = [...this.targets].find(candidate => candidate.matches(selector))
        if (!target) throw new Error(`no observed element matches ${selector}`)
        this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
}

/**
 * The browser's animation frames, stood in for the same reason its
 * intersection reporting is.
 *
 * A sentinel report no longer moves the whole window in the turn that receives
 * it. The screen mounts what one frame can afford and asks for another until
 * the step is finished, which is what stopped a slide freezing the scroll for
 * ninety milliseconds. happy-dom has no frames, so a test that only reported
 * the sentinel would watch the window move by a single row and conclude it had
 * stopped.
 */
class RecordingAnimationFrames {
    static pending = new Map<number, FrameRequestCallback>()
    static next = 1
    static request(callback: FrameRequestCallback): number {
        const handle = RecordingAnimationFrames.next
        RecordingAnimationFrames.next += 1
        RecordingAnimationFrames.pending.set(handle, callback)
        return handle
    }
    static cancel(handle: number) { RecordingAnimationFrames.pending.delete(handle) }
    static reset() { RecordingAnimationFrames.pending.clear() }
    /** Run frames, and everything they schedule, until nothing asks for another. */
    static drain(limit = 2_000) {
        for (let frame = 0; frame < limit; frame += 1) {
            const next = RecordingAnimationFrames.pending.entries().next()
            if (next.done) return frame
            const [handle, callback] = next.value
            RecordingAnimationFrames.pending.delete(handle)
            callback(0)
            flushSync()
        }
        throw new Error('the chat screen never stopped asking for animation frames')
    }
}

function scrollTo(selector: string) {
    const observer = RecordingIntersectionObserver.live.at(-1)
    if (!observer) throw new Error('the chat screen is not observing its scroll ends')
    observer.reportVisible(selector)
    flushSync()
    // The step the report started is finished here, so every assertion below
    // still describes a settled window rather than one frame's worth of it.
    RecordingAnimationFrames.drain()
}

function buildMessages(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `message ${index}`,
    })) as any[]
}

/**
 * The app hands this component `chat.message`, which is a `$state` proxy that
 * storage splices older pages into. A plain array would let the window tests
 * pass while the prepend case -- the one the whole feature exists for -- was
 * never actually observed.
 */
function reactiveMessages(count: number): any[] {
    const messages = $state(buildMessages(count))
    return messages
}

function buildCharacter(messages: any[]) {
    return {
        chaId: 'character-1',
        name: 'Tester',
        type: 'character',
        image: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', name: 'chat', note: '', localLore: [], message: messages }],
        alternateGreetings: [],
        firstMessage: 'hi',
        emotionImages: [],
        customscript: [],
        globalLore: [],
    } as any
}

let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null
/**
 * The object the component actually reads. `DBState.db.characters[0]` is a
 * separate `$state` proxy, and the component holds the prop, so a test that
 * wants to change what the component sees has to change this.
 */
let renderedCharacter: any = null

function render(messages: any[], extra: Record<string, unknown> = {}) {
    const currentCharacter = buildCharacter(messages)
    renderedCharacter = currentCharacter
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    // The component observes `chatBody.parentElement` as the scroll root, which
    // is the `flex flex-col-reverse overflow-y-auto` element in the real screen.
    const scroller = document.createElement('div')
    host = document.createElement('div')
    host.appendChild(scroller)
    document.body.appendChild(host)
    mounted = mount(Chats, {
        target: scroller,
        props: {
            messages,
            currentCharacter,
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'user',
            userIcon: '',
            ...extra,
        },
    }) as Record<string, any>
    flushSync()
    return scroller
}

function mountedIndices(container: HTMLElement): number[] {
    return Array.from(container.querySelectorAll('[data-chat-row]'))
        .map(element => Number(element.getAttribute('data-chat-row')!.slice(2)))
        .sort((left, right) => left - right)
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    RecordingAnimationFrames.reset()
    vi.stubGlobal('requestAnimationFrame', RecordingAnimationFrames.request)
    vi.stubGlobal('cancelAnimationFrame', RecordingAnimationFrames.cancel)
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    RecordingAnimationFrames.reset()
    vi.unstubAllGlobals()
})

describe('the chat screen follows the scroll instead of a page number', () => {
    it('opens on the newest messages', () => {
        const container = render(reactiveMessages(400))
        const indices = mountedIndices(container)

        expect(indices.at(-1)).toBe(399)
        expect(indices.at(0)).toBeGreaterThan(0)
        // Bounded, and bounded around the newest end rather than around a page.
        expect(indices.length).toBeLessThanOrEqual(60)
    })

    it('watches both ends of the scroll rather than a control in the scrolled content', () => {
        const container = render(reactiveMessages(400))

        expect(container.querySelector(OLDER_SENTINEL)).not.toBeNull()
        expect(container.querySelector(NEWER_SENTINEL)).not.toBeNull()
        // The controls this replaced could be scrolled past and never reached again.
        expect(container.querySelector('[data-chat-page-previous]')).toBeNull()
        expect(container.querySelector('[data-chat-page-next]')).toBeNull()
        expect(RecordingIntersectionObserver.live.at(-1)!.targets.size).toBe(2)
    })

    it('mounts older messages as the oldest mounted row comes into view', () => {
        const container = render(reactiveMessages(400))
        const before = mountedIndices(container)

        scrollTo(OLDER_SENTINEL)
        const after = mountedIndices(container)

        expect(after.at(0)!).toBeLessThan(before.at(0)!)
        // Still bounded: the window slid, it did not grow.
        expect(after.length).toBeLessThanOrEqual(60)
    })

    it('mounts the step a frame at a time instead of all of it in the frame that reported', () => {
        const container = render(reactiveMessages(400))
        const before = mountedIndices(container).at(0)!

        // The report on its own, with no frame granted.
        RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
        flushSync()
        expect(mountedIndices(container).at(0)!).toBe(before)

        // Constructing a row costs about three milliseconds and a step is
        // thirty-one of them, which is the ninety-millisecond frozen frame the
        // reader felt as a hitch. Doing them across frames is what removed it,
        // so a single frame must never be allowed to do the lot.
        const frames = RecordingAnimationFrames.drain()
        const moved = before - mountedIndices(container).at(0)!
        expect(moved).toBeGreaterThan(1)
        expect(frames).toBeGreaterThan(1)
        // And the destination is the one the old code jumped to in one go: the
        // reader ends up exactly where they used to, and the sentinel is pushed
        // the same distance back out of range.
        expect(moved).toBe(31)
    })

    it('holds a contiguous window in conversation order on every frame of a step', () => {
        const container = render(reactiveMessages(400))
        RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
        flushSync()

        /**
         * The rows as the DOM actually holds them, unsorted.
         *
         * `mountedIndices` sorts, which cannot tell a window in conversation
         * order from the same sixty rows shuffled -- and a step that mounts a
         * row at a time has thirty-one intermediate states where a row could be
         * inserted against the wrong neighbour and be sorted back into place by
         * the assertion meant to catch it.
         */
        const domOrder = () => Array.from(container.querySelectorAll('[data-chat-row]'))
            .map(element => Number(element.getAttribute('data-chat-row')!.slice(2)))

        let frames = 0
        while (RecordingAnimationFrames.pending.size > 0) {
            const [handle, runFrame] = RecordingAnimationFrames.pending.entries().next().value!
            RecordingAnimationFrames.pending.delete(handle)
            runFrame(0)
            flushSync()
            frames += 1
            const order = domOrder()
            // Newest first, one message apart, no gaps and no repeats: the row
            // in each position is the message that belongs there.
            expect(new Set(order).size).toBe(order.length)
            expect(order).toEqual(Array.from({ length: order.length }, (_, i) => order[0] - i))
            expect(order.length).toBe(60)
        }
        expect(frames).toBeGreaterThan(1)
    })

    it('abandons a slide in progress when the screen is sent somewhere else', () => {
        const container = render(reactiveMessages(400))
        RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
        flushSync()

        // Mid-slide, the reader asks for the latest messages. A step left
        // running would keep walking the window backwards, one row per frame,
        // away from where they just asked to be.
        mounted!.scrollToLatestMessage()
        flushSync()
        RecordingAnimationFrames.drain()

        expect(mountedIndices(container).at(-1)).toBe(399)
        expect(mounted!.getAnchorId()).toBeNull()
    })

    it('abandons a slide in progress when another chat is opened', () => {
        const container = render(reactiveMessages(400))
        RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
        flushSync()

        // The reader opens a different conversation while a step is still
        // running. A step left running would keep walking the new chat's window
        // backwards, one row per frame, from the newest messages it opened on.
        DBState.db.characters[0].chats[0].id = 'chat-2'
        flushSync()
        RecordingAnimationFrames.drain()

        expect(mountedIndices(container).at(-1)).toBe(399)
        expect(mounted!.getAnchorId()).toBeNull()
    })

    it('treats a second report of the same sentinel during a step as the same report', () => {
        const container = render(reactiveMessages(400))
        const before = mountedIndices(container).at(0)!
        const observer = RecordingIntersectionObserver.live.at(-1)!

        // The sentinel goes on intersecting until the rows this step mounts
        // push it back out of range, which now takes several frames rather than
        // one -- so the same sentinel can be reported again while the step it
        // started is already part-way done. One frame of it, then the report.
        observer.reportVisible(OLDER_SENTINEL)
        flushSync()
        const [handle, runFrame] = RecordingAnimationFrames.pending.entries().next().value!
        RecordingAnimationFrames.pending.delete(handle)
        runFrame(0)
        flushSync()
        expect(mountedIndices(container).at(0)!).toBeLessThan(before)
        observer.reportVisible(OLDER_SENTINEL)
        flushSync()
        RecordingAnimationFrames.drain()

        // One step, not two. A second journey begun from a window half-way
        // through the first carries the window past the destination the reader
        // was heading for, and every further report during the step carries it
        // further still.
        expect(before - mountedIndices(container).at(0)!).toBe(31)
    })

    it('lands where revealMessage sent it, even when a step was already running', () => {
        const container = render(reactiveMessages(400))
        RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
        flushSync()

        // A search hit, or the memory panel, jumping the reader somewhere while
        // a step is running. The step has to be abandoned, not resumed from
        // wherever the jump landed.
        mounted!.revealMessage(120)
        flushSync()
        RecordingAnimationFrames.drain()

        expect(mountedIndices(container).at(0)).toBe(90)
        expect(mountedIndices(container).at(-1)).toBe(149)
    })

    it('slides back towards the newest messages when the newer end comes into view', () => {
        const container = render(reactiveMessages(400))
        scrollTo(OLDER_SENTINEL)
        scrollTo(OLDER_SENTINEL)
        const scrolledBack = mountedIndices(container)
        expect(scrolledBack.at(-1)).toBeLessThan(399)

        scrollTo(NEWER_SENTINEL)
        expect(mountedIndices(container).at(-1)!).toBeGreaterThan(scrolledBack.at(-1)!)
    })

    /**
     * Explicit timeout for the same reason the return-to-latest test below
     * carries one, and more so: a step is now mounted a row at a time across
     * frames, so a hundred sentinel reports drive thirty-one renders each
     * instead of one. Comfortable alone, past the default five seconds when
     * the whole suite is competing for the machine.
     */
    it('asks for an older page only once the oldest resident message is mounted', () => {
        const onReachOldestMounted = vi.fn()
        const container = render(reactiveMessages(400), { onReachOldestMounted })

        scrollTo(OLDER_SENTINEL)
        // There are still resident messages left to mount, so nothing needs
        // fetching yet: a request here would page storage for history the
        // screen is already holding.
        expect(onReachOldestMounted).not.toHaveBeenCalled()

        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        expect(mountedIndices(container)).toContain(0)
        expect(onReachOldestMounted).toHaveBeenCalled()
    }, 30_000)

    /**
     * Explicit timeout for the same reason the return-to-latest test below
     * carries one, and more so: a step is now mounted a row at a time across
     * frames, so a hundred sentinel reports drive thirty-one renders each
     * instead of one. Comfortable alone, past the default five seconds when
     * the whole suite is competing for the machine.
     */
    it('asks storage on the slide that reaches the oldest resident message, not on a later report', () => {
        const onReachOldestMounted = vi.fn()
        // 400 messages, a 60-row window sliding by 31: the slide that finally
        // reaches index 0 mounts only the remainder. In a browser that handful
        // of rows may not be tall enough to push the older sentinel back out of
        // the 600px root margin, and IntersectionObserver does not re-notify a
        // target that stays intersecting -- so a request deferred to "the next
        // report" is a request that never happens, and the rest of the history
        // stays on disk with no spinner, no error and no control.
        const container = render(reactiveMessages(400), { onReachOldestMounted })

        let reports = 0
        while (!mountedIndices(container).includes(0) && reports < 100) {
            scrollTo(OLDER_SENTINEL)
            reports += 1
        }
        expect(mountedIndices(container)).toContain(0)
        // Called by the slide itself, with no further scroll signal needed.
        expect(onReachOldestMounted).toHaveBeenCalledTimes(1)
    }, 30_000)

    /**
     * Explicit timeout for the same reason the return-to-latest test below
     * carries one, and more so: a step is now mounted a row at a time across
     * frames, so a hundred sentinel reports drive thirty-one renders each
     * instead of one. Comfortable alone, past the default five seconds when
     * the whole suite is competing for the machine.
     */
    it('reports which end of the history is on screen', () => {
        const onWindowChange = vi.fn()
        const container = render(reactiveMessages(400), { onWindowChange })

        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: false, atNewestEnd: true })

        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        // This is what tells the screen to draw the greeting, and to offer the
        // way back to the latest messages.
        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: true, atNewestEnd: false })
    }, 30_000)

    it('keeps the way back to the latest messages while a reply streams', () => {
        const onWindowChange = vi.fn()
        const container = render(reactiveMessages(400), { onWindowChange })
        renderedCharacter.chats[0].isStreaming = true
        renderedCharacter.chats[0].activeStreamingDisplayOptimizationMode = 'balanced'

        for (let guard = 0; guard < 4; guard += 1) scrollTo(OLDER_SENTINEL)

        // The streaming override force-mounts the tail so the live reply keeps
        // updating, which means the mounted window says "newest end" while the
        // reader is scrolled hundreds of messages away from it, looking at the
        // spacer that override left behind. Reporting the mounted window here
        // would delete the one control that gets them back.
        expect(mountedIndices(container)).toContain(399)
        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: false, atNewestEnd: false })
    })

    it('returns to the newest messages from anywhere in the scroll', () => {
        const container = render(reactiveMessages(400))
        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        expect(mountedIndices(container)).not.toContain(399)

        mounted!.scrollToLatestMessage()
        flushSync()

        expect(mountedIndices(container).at(-1)).toBe(399)
        // Up to a hundred sentinel reports, each a synchronous re-render of a
        // 400-message reactive array. Fast alone, past the default 5s when the
        // whole suite is competing for the machine.
    }, 30_000)

    it('keeps the anchored message on screen when older history is prepended', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollTo(OLDER_SENTINEL)
        scrollTo(OLDER_SENTINEL)
        const anchored = mounted!.getAnchorId()
        expect(anchored).not.toBeNull()

        // A page of older history arrives; every index shifts by 40. An
        // index-based anchor would drag the view 40 messages further back.
        // Spliced, never replaced -- replacing the array unmounts every row.
        messages.splice(0, 0, ...Array.from({ length: 40 }, (_, index) => ({
            chatId: `older-${index}`,
            role: 'char',
            data: `older ${index}`,
        })) as any[])
        flushSync()

        const rows = Array.from(container.querySelectorAll('[data-chat-row]'))
            .map(element => element.getAttribute('data-chat-row'))
        expect(rows).toContain(anchored)
        expect(mounted!.getAnchorId()).toBe(anchored)
    }, 30_000)

    it('mounts around a message the screen was asked to reveal', () => {
        const container = render(reactiveMessages(400))

        mounted!.revealMessage(12)
        flushSync()

        const indices = mountedIndices(container)
        expect(indices).toContain(12)
        expect(indices.length).toBeLessThanOrEqual(60)
    })
})
