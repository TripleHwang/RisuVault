<script lang="ts">
    import type { character, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { flushSync, mount, onDestroy, tick, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from 'src/ts/stores.svelte';
    import { get } from 'svelte/store';
    import { scrollWithinContainer } from './scrollWithin';
    import { estimateSpacerHeight, getChatWindow, stepChatWindowCenter, type ChatWindow } from 'src/ts/chatWindow';
    import { publishMountedMessageIds, releaseMountedMessageIds } from 'src/ts/chatMountRegistry';
    import { recordRuntimeDuration, updateRuntimeResources } from 'src/ts/performance/performanceReport';
    import { buildChatTurnNavigation, type ChatTurnNavigation } from 'src/ts/chatTurnNavigation';

    /**
     * Wall clock for the forced-layout measurement below. Falls back to
     * `Date.now` rather than throwing, because a missing `performance` must
     * never be able to stop the chat from rendering.
     */
    const layoutClock = () => {
        try {
            const value = globalThis.performance?.now?.();
            return Number.isFinite(value) ? value : Date.now();
        } catch { return Date.now(); }
    };

    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = DBState.db.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    let {
        messages,
        currentCharacter,
        onReroll,
        onNextSwipe = () => {},
        unReroll,
        onDeleteSwipe = () => {},
        onConfirmMemory = async () => false,
        onReanalyzeMemory = async () => false,
        currentUsername,
        userIcon,
        /**
         * The scroll has reached the oldest message this screen is holding and
         * there is nothing resident left to mount. Whether anything older
         * exists is storage's question, not this component's.
         */
        onReachOldestMounted = () => {},
        /** Which ends of the resident history the mounted window now covers. */
        onWindowChange = () => {},
        /**
         * `messages[0]` is the first message of the conversation, so anything
         * counted from it -- the response turn numbers -- is counted from the
         * start. `false` while storage holds older messages; only the screen
         * that owns the storage window knows, and it says so.
         */
        historyStartResident = true,
        // Task 8's SaverModeCoordinator owns the reactive source and will pass
        // this hook; no saver store exists yet, so normal mode is the default.
        saverMode = false,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false)
    }:{
        messages: Message[]
        currentCharacter: character
        onReroll: () => void
        onNextSwipe?: () => void
        unReroll: () => void
        onDeleteSwipe?: () => void
        onConfirmMemory?: (messageId: string) => Promise<boolean>
        onReanalyzeMemory?: (messageId: string) => Promise<boolean>
        currentUsername: string
        userIcon: string
        onReachOldestMounted?: () => void
        onWindowChange?: (state: { atOldestEnd: boolean, atNewestEnd: boolean }) => void
        historyStartResident?: boolean
        saverMode?: boolean
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    let messageHost: HTMLDivElement;
    let olderSentinel: HTMLDivElement | undefined = $state();
    let newerSentinel: HTMLDivElement | undefined = $state();
    /**
     * The message the mounted window is centred on, by stable id -- never by
     * index.
     *
     * `null` means "pinned to the newest end", which is where a chat opens and
     * where it returns to. An index would be wrong the moment storage prepends
     * an older page: every index shifts by the size of that page, and a
     * window that followed the number instead of the message would drag the
     * reader backwards by a page each time one arrived.
     */
    let anchorId: string | null = $state(null);
    let anchoredChatRoomId: string | null = null;
    let reportedAtOldestEnd: boolean | null = null;
    let reportedAtNewestEnd: boolean | null = null;
    /**
     * How far outside the viewport an end has to come before it counts as
     * reached. Wide enough that the next rows are mounted, or the next page
     * requested, before the reader arrives at blank spacer.
     */
    const SCROLL_END_MARGIN_PX = 600;
    /**
     * How long one animation frame may spend moving the window.
     *
     * A slide displaces the window by half its length -- thirty-one rows -- and
     * doing all of them in the frame the sentinel reported on is the hitch:
     * constructing a row costs about three milliseconds, so that frame runs
     * ninety-odd and the scroll stops dead while it does.
     *
     * Nothing in that work is per-slide. Measured against a resident sixty-row
     * window, the layout newly inserted rows force is 0.6ms for one, 1.2ms for
     * two and 13.1ms for thirty, and reading every row's height once layout is
     * clean is 0.15ms whether one row moved or thirty. There is no constant to
     * amortise, so the same total can be paid a row at a time without paying
     * more of it.
     *
     * Two milliseconds is below what one row costs, which is the point: on the
     * machine this was measured on it buys exactly one row per frame, and a
     * frame that mounts one row takes 7.1ms against a quiet frame's 6.9ms --
     * the work disappears into the frame it is already spending. It is a
     * budget rather than a count so the two ends stay bounded on their own. A
     * chat of one-line messages has rows that cost a fraction of this, and
     * several fit, which is what keeps the mounting edge ahead of a fast
     * scroll when each row buys only a few pixels of lead; a machine slow
     * enough that one row costs more than the whole budget still does one,
     * because the budget is checked between rows and never before the first.
     */
    const SLIDE_FRAME_BUDGET_MS = 2;
    type ChatInstance = {
        updateStreamingDisplay?: (state: {
            isOptimizedStreamingMessage: boolean
            streamingOptimizationMode: StreamingDisplayOptimizationMode
            rawStreamingText: string
        }) => void
    }
    type MountedChat = { instance: ChatInstance, element: HTMLDivElement, signature: string }
    let mountInstances: Map<string, MountedChat> = new Map();
    /**
     * Identity of this screen in the mount registry. Storage-side residency
     * trimming refuses to release any row published here, so the token has to
     * outlive every render and be retracted exactly once, on destroy.
     */
    const mountRegistryToken = {};
    /**
     * The spacer counts currently written into the DOM. `-1` means "nothing has
     * been written yet", so the first render always sizes them.
     */
    let appliedBeforeCount = -1;
    let appliedAfterCount = -1;

    function stableMessageId(message: Message): string {
        // Legacy imported rows receive their durable identity before becoming a
        // mounted owner; there is no mutable-index identity fallback.
        message.chatId ??= crypto.randomUUID();
        return message.chatId;
    }

    const domLimit = (): 60 | 40 => saverMode ? 40 : 60;

    /**
     * Where the anchored message sits now.
     *
     * A missing anchor falls back to the newest end rather than to zero: an id
     * that is no longer in the array means the row was released or deleted, and
     * silently re-centring on the start of the array would look like the chat
     * had jumped to its beginning on its own.
     */
    function resolveAnchorIndex(): number {
        const total = messages.length;
        if (total === 0) return 0;
        if (anchorId === null) return total - 1;
        const found = messages.findIndex((message) => message.chatId === anchorId);
        return found >= 0 ? found : total - 1;
    }

    function currentDomWindow(): ChatWindow {
        return getChatWindow({ total: messages.length, anchorIndex: resolveAnchorIndex(), limit: domLimit() });
    }

    /**
     * The slide still owed to a sentinel report, in rows and in the direction
     * it was reported from. `null` when the window is where it wants to be.
     *
     * Rows remaining, deliberately, rather than the index the window is heading
     * for: storage can splice an older page in while the slide is still
     * running, which moves every index by the size of that page. A remembered
     * target index would then name a different message and drag the window a
     * page further back; a count of rows still to travel is the same journey
     * whatever the array does underneath it.
     */
    let pendingSlide: { direction: -1 | 1, remaining: number } | null = null;
    let cancelPendingSlideFrame: (() => void) | null = null;

    /**
     * A frame, or the closest thing to one available.
     *
     * Read off `globalThis` at call time rather than captured, so a test can
     * stand in for the browser's frames the same way it already stands in for
     * its intersection reporting. The timeout fallback is for environments with
     * no frames at all, where nothing paints and the only thing that matters is
     * that the window still arrives.
     */
    function scheduleSlideFrame() {
        if (cancelPendingSlideFrame) return;
        const requestFrame = globalThis.requestAnimationFrame;
        if (typeof requestFrame === 'function') {
            const handle = requestFrame(() => { cancelPendingSlideFrame = null; advanceSlide(); });
            cancelPendingSlideFrame = () => globalThis.cancelAnimationFrame?.(handle);
            return;
        }
        const handle = setTimeout(() => { cancelPendingSlideFrame = null; advanceSlide(); }, 0);
        cancelPendingSlideFrame = () => clearTimeout(handle);
    }

    /**
     * Abandon a slide in progress.
     *
     * Every deliberate jump -- opening another chat, returning to the latest
     * message, revealing a search hit -- has to do this. A slide left running
     * would keep stepping the window away from wherever the jump just put it,
     * one row per frame, which reads as the chat wandering off on its own.
     */
    function cancelSlide() {
        pendingSlide = null;
        cancelPendingSlideFrame?.();
        cancelPendingSlideFrame = null;
    }

    /** Point the anchor at the window that begins at `start`. */
    function anchorWindowStart(start: number) {
        const total = messages.length;
        const limit = domLimit();
        // Reaching the newest end drops the anchor entirely, so a message
        // appended after this point keeps the window pinned to the tail.
        if (start + limit >= total) {
            anchorId = null;
            return;
        }
        anchorId = stableMessageId(messages[start + Math.floor(limit / 2)]);
    }

    /**
     * Begin sliding the mounted window one step, and return the window that
     * step is heading for -- `null` when it has nowhere to go, which at the
     * older end is the signal that only storage can supply more.
     *
     * The step is still `stepChatWindowCenter`'s: the reader who has scrolled
     * to a sentinel ends up exactly where the previous code put them, with the
     * sentinel pushed the same distance back out of range. Only the rate
     * changed. What used to be thirty-one mounts in the reporting frame is now
     * thirty-one mounts spread over the frames that follow it, and because the
     * reader is still six hundred pixels from the edge when the report comes
     * and each frame mounts at least one whole row, the rows arrive far faster
     * than a scroll can consume them.
     */
    function requestSlide(direction: -1 | 1): ChatWindow | null {
        const total = messages.length;
        if (total === 0) return null;
        const limit = domLimit();
        const current = currentDomWindow();
        const centre = stepChatWindowCenter(current, total, limit, direction);
        const target = getChatWindow({ total, anchorIndex: centre, limit });
        if (target.start === current.start && target.end === current.end) return null;
        pendingSlide = { direction, remaining: Math.abs(target.start - current.start) };
        scheduleSlideFrame();
        return target;
    }

    /** Move the window as far towards its target as this frame can afford. */
    function advanceSlide() {
        if (!pendingSlide) return;
        const startedAt = layoutClock();
        while (pendingSlide) {
            const total = messages.length;
            const limit = domLimit();
            const current = currentDomWindow();
            const furthestStart = Math.max(0, total - limit);
            const nextStart = Math.max(0, Math.min(furthestStart, current.start + pendingSlide.direction));
            if (nextStart === current.start) {
                // Clamped: the window is against an end of the array and the
                // rest of the journey does not exist.
                pendingSlide = null;
                break;
            }
            anchorWindowStart(nextStart);
            pendingSlide.remaining -= 1;
            if (pendingSlide.remaining <= 0) {
                pendingSlide = null;
                break;
            }
            // Flushed here rather than left to the microtask that would run it
            // anyway, so the budget below is measured against rows that have
            // actually been mounted instead of rows that are merely scheduled.
            flushSync();
            if (layoutClock() - startedAt >= SLIDE_FRAME_BUDGET_MS) break;
        }
        if (pendingSlide) scheduleSlideFrame();
    }

    function handleOlderEndVisible() {
        // The sentinel stays intersecting for as long as the slide it started
        // is still running, and a second report during that time is the same
        // report: acting on it would start a second journey from a window
        // half-way through the first.
        if (pendingSlide?.direction === -1) return;
        // A slide that lands on the oldest resident row is the last one this
        // component can make, so storage is asked in the same turn rather than
        // on a later sentinel report. That report may never come: the terminal
        // slide mounts only the remainder of the array, which can be one row,
        // and if that is not tall enough to push the sentinel back outside the
        // root margin then IntersectionObserver -- which does not re-notify a
        // target that stays intersecting -- has nothing left to fire. The chat
        // would sit at its oldest resident message with the rest of its history
        // on disk, no spinner, no error and no way forward.
        //
        // Asked from the window the slide is heading for, not from the one it
        // has reached, because the slide now takes several frames to arrive and
        // the question -- is there any resident history left past this step --
        // is answered by its destination either way.
        const target = requestSlide(-1);
        if (target && target.beforeCount > 0) return;
        onReachOldestMounted();
    }

    function handleNewerEndVisible() {
        if (pendingSlide?.direction === 1) return;
        requestSlide(1);
    }

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        if (!messageHost) return;
        const currentIds = new Set<string>();
        let nextRow: Element | null = null;
        const charImage = getCharImage(currentCharacter.image, 'css')
        const userImage = getCharImage(userIcon, 'css')
        const simpleChar = createSimpleCharacter(currentCharacter);
        const currentChat = currentCharacter.chats?.[currentCharacter.chatPage]
        const configuredPerformanceMode = DBState.db.streamingDisplayOptimizationMode ?? 'off';
        const performanceMode = currentChat?.isStreaming
            ? currentChat.activeStreamingDisplayOptimizationMode ?? configuredPerformanceMode
            : configuredPerformanceMode
        const activeStreamingIndex = performanceMode !== 'off' && currentChat?.isStreaming
            ? messages.length - 1
            : -1
        const limit = domLimit();
        const anchoredWindow = currentDomWindow();
        let domWindow = anchoredWindow;
        // A live stream stays mounted even when the user has scrolled away from its tail.
        if (currentChat?.isStreaming && activeStreamingIndex >= 0 && (activeStreamingIndex < domWindow.start || activeStreamingIndex >= domWindow.end)) {
            const end = messages.length;
            const start = Math.max(0, end - limit);
            domWindow = { start, end, beforeCount: start, afterCount: 0 };
        }
        // These two answer different questions, so they are read from different
        // windows.
        //
        // `atOldestEnd` is about the rows: it gates the "start of the
        // conversation" block, which must never be drawn above a window that
        // does not actually reach the start. That is the mounted window.
        //
        // `atNewestEnd` is about the reader: it gates the only control that
        // returns them to the latest messages. The streaming override above
        // mounts the tail without the reader asking for it, and reading the
        // flag from that window would report "already at the newest end" --
        // removing the control at the exact moment the override has swapped
        // the rows they were reading for a spacer they are now scrolled into.
        // The anchor is where the reader actually is.
        const atOldestEnd = domWindow.beforeCount === 0;
        const atNewestEnd = anchoredWindow.afterCount === 0;
        if (atOldestEnd !== reportedAtOldestEnd || atNewestEnd !== reportedAtNewestEnd) {
            reportedAtOldestEnd = atOldestEnd;
            reportedAtNewestEnd = atNewestEnd;
            onWindowChange({ atOldestEnd, atNewestEnd });
        }
        const loadStart = domWindow.end - 1
        const loadEnd = domWindow.start
        /**
         * True once this pass has added or removed a row.
         *
         * A row re-rendered in place under the same id does not count. The
         * heights exist to size a placeholder for rows that are NOT mounted, so
         * what matters is whether the mounted set is still a representative
         * sample of the chat -- which changes when rows join or leave it, not
         * when one of them is rewritten. A rewrite that does change heights is
         * still picked up: the next thing that can consume the estimate is a
         * change in a spacer count, and that re-measures.
         */
        let mountedRowSetChanged = false;
        /**
         * Response turn numbers, counted from the first message of the
         * conversation -- which is only `messages[0]` when the resident array
         * begins there. While storage still holds older messages the count
         * would start part-way through the chat and label the first resident
         * reply "Turn 1", so no numbers are produced at all until the start of
         * history is resident. Numbering from that point is exact whatever the
         * newest end does: residency trimming releases the tail, and a count
         * from the start does not move when the tail goes.
         */
        const turnNavigation: ChatTurnNavigation | null = historyStartResident
            ? buildChatTurnNavigation(messages)
            : null

        // Find the last real (non-comment, non-disabled) char message index
        // Only show reroll if it's the actual last non-disabled message
        let lastRealCharIdx = -1;
        let lastNonDisabledIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (!messages[i].isComment && !messages[i].disabled) {
                lastNonDisabledIdx = i;
                break;
            }
        }
        if (lastNonDisabledIdx >= 0 && messages[lastNonDisabledIdx].role === 'char') {
            lastRealCharIdx = lastNonDisabledIdx;
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const messageId = stableMessageId(message);
            const reloadPointer = reloadPointerMap[messageId] ?? 0;
            const isRerollTarget = i === lastRealCharIdx;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const turnNumber = turnNavigation?.turnByMessageIndex.get(i)
            const hashMessageData = activeStreamingMessage ? '' : message.data;
            const signature = `${hashMessageData}|${messageLargePortrait}|${message.disabled}|${reloadPointer}|${message.swipeId ?? 0}|${message.swipes?.length ?? 0}|${isRerollTarget}|${turnNumber ?? 0}|${message.risubardMemoryConfirmed ?? false}|${JSON.stringify(message.risubardCanonicalReceipt ?? null)}`;
            currentIds.add(messageId);
            const mounted = mountInstances.get(messageId);
            if (!mounted || mounted.signature !== signature) {
                if (mounted) {
                    unmount(mounted.instance);
                    mounted.element.remove();
                    mountInstances.delete(messageId);
                }
                const b = document.createElement('div');
                b.setAttribute('data-chat-row', messageId);
                b.setAttribute('data-chat-id', messageId);
                b.classList.add('chat-message-container');
                const swipes = message.swipes;
                const swipeId = message.swipeId ?? 0;
                const inst = mount(Chat, {
                    target: b,
                    props: {
                        message: message.data,
                        isLastMemory: false,
                        idx: i,
                        messageId,
                        totalLength: messages.length,
                        img: message.role === 'user' ? userImage : charImage,
                        onReroll: onReroll,
                        onNextSwipe: i === lastRealCharIdx ? onNextSwipe : () => {},
                        unReroll: unReroll,
                        onDeleteSwipe: i === lastRealCharIdx ? onDeleteSwipe : () => {},
                        onConfirmMemory,
                        onReanalyzeMemory,
                        memoryConfirmed:
                            message.risubardMemoryConfirmed === true,
                        canonicalReceipt: message.risubardCanonicalReceipt,
                        rerollIcon: i === lastRealCharIdx ? 'force' : false,
                        character: simpleChar,
                        largePortrait: message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false),
                        messageGenerationInfo: message.generationInfo,
                        role: message.role,
                        turnNumber,
                        name: message.role === 'user' ? currentUsername : currentCharacter.name,
                        isComment: message.isComment ?? false,
                        disabled: message.disabled ?? false,
                        isOptimizedStreamingMessage: activeStreamingMessage,
                        streamingOptimizationMode: performanceMode,
                        rawStreamingText: message.data,
                        ...(i === lastRealCharIdx ? {
                            currentPage: (swipeId ?? 0) + 1,
                            totalPages: swipes?.length ?? 1,
                        } : {}),
                    },

                })
                if (!mounted) mountedRowSetChanged = true;
                mountInstances.set(messageId, { instance: inst, element: b, signature });
                if(nextRow){
                    messageHost.insertBefore(b, nextRow.nextSibling);
                }
                else{
                    messageHost.prepend(b);
                }
            }
            else{
                mounted.instance.updateStreamingDisplay?.({
                    isOptimizedStreamingMessage: activeStreamingMessage,
                    streamingOptimizationMode: performanceMode,
                    rawStreamingText: message.data,
                })
            }
            nextRow = mountInstances.get(messageId)?.element ?? nextRow;
        }

        for (const [id, mounted] of mountInstances) {
            if (!currentIds.has(id)) {
                unmount(mounted.instance);
                mounted.element.remove();
                mountInstances.delete(id);
                mountedRowSetChanged = true;
            }
        }
        /**
         * The one place in the render path that forces a synchronous layout,
         * now paid only when its answer can differ.
         *
         * `estimateSpacerHeight` turns the measured heights into a placeholder
         * for the rows outside the window. Its inputs are those heights and the
         * two counts; while all three are what they were, re-reading them costs
         * a whole-tree layout to write back the pixel values already in the
         * DOM. That was every effect run -- every keystroke, every streamed
         * token -- and it is what the console reported as "Forced reflow while
         * executing JavaScript".
         *
         * Staleness cannot outlive its consequence. A stale height only matters
         * once it is used to size a spacer, and a spacer is only ever resized
         * from here; both triggers below -- a changed count, a changed mounted
         * set -- fire before the estimate is applied, so every spacer height
         * written is computed from rows measured in the same pass. The
         * measurement is taken after the mount sweep for the same reason: it
         * now describes the rows that are on screen rather than the ones that
         * were there before this pass ran.
         */
        const spacersNeedResizing = mountedRowSetChanged ||
            domWindow.beforeCount !== appliedBeforeCount ||
            domWindow.afterCount !== appliedAfterCount;
        if (spacersNeedResizing) {
            const rowMeasureStartedAt = layoutClock();
            /**
             * Heights of the rows mounted right now.
             *
             * Deliberately local. Nothing outside this block reads them, and
             * nothing carries them to a later render: a height is measured and
             * consumed in the same pass, so a spacer can never be sized from
             * rows that have since been replaced. `spacersNeedResizing` is what
             * decides when that pass happens.
             */
            const measuredRowHeights = Array.from(messageHost.querySelectorAll('[data-chat-row]'))
                .map((element) => (element as HTMLElement).getBoundingClientRect().height)
                .filter(height => height > 0);
            recordRuntimeDuration('chat-row-measure', layoutClock() - rowMeasureStartedAt);
            const spacerHeight = (count: number) => estimateSpacerHeight(measuredRowHeights, count);
            const afterSpacer = chatBody.querySelector('[data-chat-spacer="after"]') as HTMLElement | null;
            const beforeSpacer = chatBody.querySelector('[data-chat-spacer="before"]') as HTMLElement | null;
            if (afterSpacer) afterSpacer.style.height = `${spacerHeight(domWindow.afterCount)}px`;
            if (beforeSpacer) beforeSpacer.style.height = `${spacerHeight(domWindow.beforeCount)}px`;
            appliedBeforeCount = domWindow.beforeCount;
            appliedAfterCount = domWindow.afterCount;
        }
        // Published after the sweep, so what the registry holds is what is
        // actually mounted right now -- never a row this pass just unmounted.
        // The trimmer refuses to release anything named here.
        publishMountedMessageIds(mountRegistryToken, mountInstances.keys());
        updateRuntimeResources({ mountedMessages: mountInstances.size });
    };

    onDestroy(() => {
        console.log('Unmounting Chats');
        cancelSlide();
        // `inst` is the `{ instance, element, signature }` record, not the
        // component -- passing the record unmounted nothing, so leaving a chat
        // screen leaked every one of its mounted rows. Every other call site in
        // this file already unmounts `.instance`.
        mountInstances.forEach((mounted) => {
            unmount(mounted.instance);
            mounted.element.remove();
        });
        mountInstances.clear();
        releaseMountedMessageIds(mountRegistryToken);
        updateRuntimeResources({ mountedMessages: 0 });
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement || !messageHost) return true;
        const sc = chatBody.parentElement;
        const lastEl = messageHost.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    function scrollLatestIntoChatScreen() {
        if(!chatBody || !messageHost) return;
        const element = messageHost.firstElementChild as HTMLElement | null;
        const chatScreen = chatBody.parentElement;
        if(!element || !chatScreen) return;
        scrollWithinContainer(element, chatScreen, { block: 'start', behavior: 'instant' });
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        cancelSlide();
        if (anchorId !== null) {
            // The newest messages are not mounted yet. Re-pin first, then scroll
            // once the rows they refer to actually exist.
            anchorId = null;
            void tick().then(() => scrollLatestIntoChatScreen());
            return;
        }
        scrollLatestIntoChatScreen();
    }

    /** Mount the window around `index`, for jumps that do not come from scrolling. */
    export const revealMessage = (index: number) => {
        const total = messages.length;
        if (total === 0) return;
        cancelSlide();
        const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));
        const next = getChatWindow({ total, anchorIndex: clamped, limit: domLimit() });
        anchorId = next.end >= total ? null : stableMessageId(messages[clamped]);
    }

    /** Same, addressed by stable id; ignored when that message is not resident. */
    export const revealMessageById = (id: string | null) => {
        if (!id) {
            cancelSlide();
            anchorId = null;
            return;
        }
        const index = messages.findIndex((message) => message.chatId === id);
        if (index < 0) return;
        revealMessage(index);
    }

    /** The anchor, for a caller that wants to restore this view later. */
    export const getAnchorId = (): string | null => anchorId;

    let previousLength = 0;
    let previousLastMessageId: string | null = null;
    /**
     * Every id this screen has already seen sitting at the newest end of this
     * chat.
     *
     * Needed because the newest end can come back after having been taken away.
     * Residency trimming releases the tail of a long chat once the resident
     * slice passes its bound, and `loadNewestChatMessages` later splices that
     * whole window back on -- which grows the array and moves the last id, the
     * exact shape of a message arriving. The difference is not structural, it
     * is historical: a restored tail ends on a message that was the newest one
     * before, and this set is the only thing that remembers that. Growth is by
     * one id per genuinely new tail, so it stays the size of a conversation's
     * arrivals, not of its history.
     */
    let seenNewestMessageIds = new Set<string>();
    let previousChatRoomId: string | null = null;

    // Opening a different chat starts at its newest messages. Kept out of the
    // render effect below so writing the anchor cannot re-trigger the render
    // that reads it.
    $effect(() => {
        const roomId = getCurrentChatRoomId();
        if (roomId === anchoredChatRoomId) return;
        anchoredChatRoomId = roomId;
        cancelSlide();
        anchorId = null;
    })

    /**
     * Both ends of the scroll, watched directly.
     *
     * `scrollTop` is deliberately never read: this container is
     * `flex-col-reverse`, where its sign and origin differ between browsers,
     * and the previous attempt at scroll loading did arithmetic on it -- which
     * is what made the screen jump and blank. An observer reports "this element
     * is on screen", which means the same thing everywhere.
     */
    $effect(() => {
        const older = olderSentinel;
        const newer = newerSentinel;
        const root = chatBody?.parentElement ?? null;
        if (!older || !newer || !root) return;
        if (typeof IntersectionObserver === 'undefined') {
            console.error('[Chats] IntersectionObserver is unavailable, so scrolling to the top of this chat will not load earlier messages.');
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                if (entry.target === older) handleOlderEndVisible();
                else if (entry.target === newer) handleNewerEndVisible();
            }
        }, { root, rootMargin: `${SCROLL_END_MARGIN_PX}px 0px` });
        observer.observe(older);
        observer.observe(newer);
        return () => observer.disconnect();
    })

    $effect(() => {
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;
        if (!isSameChat) seenNewestMessageIds.clear();

        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastMessageId = lastMsg ? stableMessageId(lastMsg) : null;

        /**
         * A message actually arrived at the newest end.
         *
         * The array growing is not that fact and never was. Scroll-driven
         * loading splices an older page in at the *front*, so `length` jumps by
         * a page while the newest message is the same one the reader has
         * already read; a length test calls that an arrival, arms "new
         * message", and every further page back re-arms it. What changes only
         * when something lands at the newest end is the identity of the last
         * message, so that is what is compared -- against both the previous
         * tail and every tail this chat has had, so that a tail restored after
         * residency trimming is recognised as history rather than news.
         *
         * Growth is still required, and is what keeps a reroll quiet: it
         * rewrites the last message in place, leaving the length alone.
         */
        const arrivedAtNewestEnd = isSameChat
            && lastMessageId !== null
            && messages.length > previousLength
            && lastMessageId !== previousLastMessageId
            && !seenNewestMessageIds.has(lastMessageId);

        /**
         * Where the reader was before this render changed anything.
         *
         * Read here, ahead of `updateChatBody`, because it has to describe the
         * scroll as it was -- but read ONLY when something is going to consume
         * it. `getBoundingClientRect` after the DOM has been written forces the
         * browser to lay the whole tree out synchronously, and this call was the
         * first such read in the turn, so it paid for the reflow on every effect
         * run whether or not anything had arrived. A streamed token rewrites the
         * last message in place, which is not an arrival, so during a stream
         * this answer was computed thirty to sixty times a second and thrown
         * away every time.
         *
         * The conditions are exactly the ones guarding its only use below, in
         * the same order, so short-circuiting also keeps the effect's reactive
         * dependencies where they were: `autoScrollToNewMessage` and
         * `alwaysScrollToNewMessage` are still read only on an arrival.
         */
        const wasAtBottom = arrivedAtNewestEnd
            && lastMsg!.role === 'char'
            && !!DBState.db.autoScrollToNewMessage
            && !DBState.db.alwaysScrollToNewMessage
            ? checkIfAtBottom()
            : false;

        updateChatBody()

        if(arrivedAtNewestEnd){
            if(lastMsg.role === 'char' && DBState.db.autoScrollToNewMessage){
                if(wasAtBottom || DBState.db.alwaysScrollToNewMessage){
                    setTimeout(() => {
                        scrollLatestIntoChatScreen();
                    }, 700);
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        if (lastMessageId !== null) seenNewestMessageIds.add(lastMessageId);
        previousLength = messages.length;
        previousLastMessageId = lastMessageId;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}>
    <!-- In reverse flex order, newer omitted rows belong first (visual bottom).
         Each sentinel sits between its spacer and the mounted rows, so it marks
         the edge of what is on screen. Mounting rows on the far side of a
         sentinel pushes it back out of range, which is what stops one gesture
         from sliding the window forever. -->
    <div data-chat-spacer="after" aria-hidden="true"></div>
    <div data-chat-sentinel="newer" aria-hidden="true" class="h-px w-full shrink-0" bind:this={newerSentinel}></div>
    <div class="contents" bind:this={messageHost}></div>
    <div data-chat-sentinel="older" aria-hidden="true" class="h-px w-full shrink-0" bind:this={olderSentinel}></div>
    <div data-chat-spacer="before" aria-hidden="true"></div>
</div>
