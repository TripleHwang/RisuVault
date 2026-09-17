import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Chats from './Chats.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'

/**
 * The "새 메시지" button, and what it is allowed to mean.
 *
 * It used to be armed by `messages.length > previousLength`, written when the
 * array only ever grew at the tail. Scroll-driven loading splices an older page
 * in at the *front*: the length jumps by a page, the last message is the same
 * one the reader has already read, the reader is nowhere near the bottom -- and
 * the button came on. Every further page back re-armed it and nothing turned it
 * off, so it sat there permanently announcing a message the reader had already
 * seen. The suite never noticed, because nothing ever bound the flag and drove
 * the component; so everything below mounts the real `Chats.svelte` with a real
 * binding and moves the real array.
 */

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'

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

/**
 * Where the reader is sitting.
 *
 * `checkIfAtBottom` compares two `getBoundingClientRect`s, and happy-dom
 * reports every rect as zero -- which reads as "at the bottom", the one state
 * in which the component never arms the button at all. Left unstubbed, every
 * assertion below would pass for the wrong reason.
 */
let readerAtBottom = false
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect

function stubScrollGeometry() {
    Element.prototype.getBoundingClientRect = function (this: Element) {
        const isRow = this.hasAttribute?.('data-chat-row') === true
        const top = isRow && !readerAtBottom ? 5000 : 0
        return { top, bottom: top + 20, left: 0, right: 0, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    }
}

function buildMessages(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `message ${index}`,
    })) as any[]
}

/** The `$state` proxy the app actually hands over, spliced rather than replaced. */
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
/** What `bind:hasNewUnreadMessage` in `DefaultChatScreen.svelte` is bound to. */
let newMessageButtonShown = false

function render(messages: any[]) {
    const currentCharacter = buildCharacter(messages)
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    const scroller = document.createElement('div')
    host = document.createElement('div')
    host.appendChild(scroller)
    document.body.appendChild(host)
    // Accessors, not a data property: this is what `bind:` compiles to, and it
    // is the only way a write inside the component is observable out here.
    const props = {
        messages,
        currentCharacter,
        onReroll: () => {},
        unReroll: () => {},
        currentUsername: 'user',
        userIcon: '',
        get hasNewUnreadMessage() { return newMessageButtonShown },
        set hasNewUnreadMessage(value: boolean) { newMessageButtonShown = value },
    }
    mounted = mount(Chats, { target: scroller, props }) as Record<string, any>
    flushSync()
    return scroller
}

/** A page of older history landing at the front, exactly as storage splices it. */
function prependOlderPage(messages: any[], tag: string, count = 30) {
    messages.splice(0, 0, ...Array.from({ length: count }, (_, index) => ({
        chatId: `${tag}-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `older ${tag} ${index}`,
    })) as any[])
    flushSync()
}

function scrollBack(container: HTMLElement, pages = 3) {
    for (let step = 0; step < pages; step += 1) scrollTo(OLDER_SENTINEL)
    return container
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    readerAtBottom = false
    newMessageButtonShown = false
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    RecordingAnimationFrames.reset()
    vi.stubGlobal('requestAnimationFrame', RecordingAnimationFrames.request)
    vi.stubGlobal('cancelAnimationFrame', RecordingAnimationFrames.cancel)
    stubScrollGeometry()
    DBState.db.autoScrollToNewMessage = true
    DBState.db.alwaysScrollToNewMessage = false
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    Element.prototype.getBoundingClientRect = nativeGetBoundingClientRect
    RecordingAnimationFrames.reset()
    vi.unstubAllGlobals()
})

describe('the new-message button means a message arrived', () => {
    /**
     * Explicit timeout: each `scrollBack` reports the sentinel several times
     * and a report now mounts its step a row at a time across frames, so this
     * drives hundreds of renders of a four-hundred-message reactive array.
     */
    it('stays off while the reader scrolls back through page after page of older history', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)

        prependOlderPage(messages, 'page-1')
        expect(newMessageButtonShown).toBe(false)

        // The reported symptom was that it never went off again, so the second
        // and third pages matter as much as the first: under the length test
        // each one re-armed it.
        scrollBack(container)
        prependOlderPage(messages, 'page-2')
        scrollBack(container)
        prependOlderPage(messages, 'page-3')

        expect(messages.length).toBe(490)
        expect(newMessageButtonShown).toBe(false)
    }, 30_000)

    it('comes on when a char message is appended while the reader is scrolled back', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)
        expect(newMessageButtonShown).toBe(false)

        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()

        expect(newMessageButtonShown).toBe(true)
    })

    it('still comes on for a message that arrives after older history was prepended', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)
        prependOlderPage(messages, 'page-1')
        expect(newMessageButtonShown).toBe(false)

        // The prepend moved `previousLength` far past anything a single append
        // reaches; an arrival has to be recognised on its own terms, not by
        // out-growing the last thing that grew the array.
        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()

        expect(newMessageButtonShown).toBe(true)
    })

    it('scrolls instead of announcing when the reader is already at the bottom', () => {
        const messages = reactiveMessages(400)
        render(messages)
        readerAtBottom = true

        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()

        expect(newMessageButtonShown).toBe(false)
    })

    it('says nothing about a user message the reader just sent', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)

        messages.push({ chatId: 'mine', role: 'user', data: 'typed by the reader' } as any)
        flushSync()

        expect(newMessageButtonShown).toBe(false)
    })

    it('stays off through a reroll, which rewrites the last message in place', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)

        messages[messages.length - 1] = { chatId: 'm-399-rerolled', role: 'char', data: 'rerolled' } as any
        flushSync()

        expect(messages.length).toBe(400)
        expect(newMessageButtonShown).toBe(false)
    })

    it('stays off when residency trimming releases the newest end and it is restored', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)
        const releasedTail = messages.slice(360)

        // Trimming splices the newest rows off in place; the last message is
        // now an older one the reader has already read.
        messages.splice(360, 40)
        flushSync()
        expect(newMessageButtonShown).toBe(false)

        // `loadNewestChatMessages` puts that same window back. The array grows
        // and the last id moves -- the exact shape of an arrival, and the one
        // case where that shape is a lie.
        prependOlderPage(messages, 'page-1')
        messages.push(...releasedTail)
        flushSync()

        expect(messages.length).toBe(430)
        expect(newMessageButtonShown).toBe(false)
    })

    it('still announces a real reply that lands after a trimmed tail was restored', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)
        const releasedTail = messages.slice(360)

        messages.splice(360, 40)
        flushSync()
        messages.push(...releasedTail)
        flushSync()
        expect(newMessageButtonShown).toBe(false)

        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()

        expect(newMessageButtonShown).toBe(true)
    })

    it('handles a legacy tail that has no id of its own yet', () => {
        // The last message is not mounted once the reader has scrolled back, so
        // this is the one place that mints its durable id -- a `$state` write
        // from inside the effect that reads it. It has to settle, not loop, and
        // minting an id must not read as a message having arrived.
        //
        // Only the tail is stripped. `updateChatBody` already mints an id for
        // every row it mounts, so stripping all four hundred re-mints sixty per
        // slide and makes each write invalidate the effect that made it -- the
        // whole file's work doubled, for a case this test is not about. It ran
        // past the 5s default under a full-suite run and passed alone, which is
        // a flake, not a finding. The tail is the row `updateChatBody` never
        // reaches, and it is the one this test exists for.
        const messages = reactiveMessages(400)
        delete messages[messages.length - 1].chatId
        const container = render(messages)
        scrollBack(container)

        prependOlderPage(messages, 'page-1')

        expect(typeof messages[messages.length - 1].chatId).toBe('string')
        expect(newMessageButtonShown).toBe(false)

        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()
        expect(newMessageButtonShown).toBe(true)
    }, 30_000)

    it('is cleared by the jump back to the latest messages', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollBack(container)
        messages.push({ chatId: 'arrived', role: 'char', data: 'a genuinely new reply' } as any)
        flushSync()
        expect(newMessageButtonShown).toBe(true)

        mounted!.scrollToLatestMessage()
        flushSync()

        expect(newMessageButtonShown).toBe(false)
    })
})
