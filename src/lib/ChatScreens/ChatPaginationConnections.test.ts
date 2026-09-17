import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Source-text connections between the chat screen, the windowed message list
 * and the toolbar.
 *
 * Upstream's version of this file asserted a page-number UI. This screen has
 * none: older messages arrive by scrolling (`createOlderMessageLoader`), the
 * DOM holds an anchor-based sliding window, and the only surviving control is
 * the way back to the newest messages. What upstream added on top of its pages
 * in 0.9.30 -- response turn numbers on each reply and a turn jump in the
 * toolbar -- is kept, re-expressed against the window: turns are counted over
 * the resident array, only while it starts at the first message of the
 * conversation, and a jump re-anchors the window through `scrollToMessage`
 * rather than selecting a page.
 */

const chats = () => readFileSync('src/lib/ChatScreens/Chats.svelte', 'utf8')
const screen = () => readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')
const shortcuts = () => readFileSync('src/lib/ChatScreens/RisuBardSaveLoadShortcuts.svelte', 'utf8')
const chat = () => readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8')

describe('scroll-driven chat window connections', () => {
    it('mounts an anchor-based window rather than a page range', () => {
        const source = chats()
        expect(source).toContain('getChatWindow({ total: messages.length, anchorIndex: resolveAnchorIndex(), limit: domLimit() })')
        expect(source).toContain('data-chat-sentinel="older"')
        expect(source).toContain('data-chat-sentinel="newer"')
        expect(source).toContain('onReachOldestMounted')
        expect(source).toContain('onWindowChange({ atOldestEnd, atNewestEnd })')
        expect(source).not.toContain('pageStart')
        expect(source).not.toContain('pageEnd')
        expect(source).not.toContain('messages.length - loadPages')
    })

    it('loads older messages from the scroll and keeps only the way back to the latest', () => {
        const source = screen()
        expect(source).toContain("from 'src/ts/chatScrollPaging'")
        expect(source).toContain('const olderMessageLoader = createOlderMessageLoader({')
        expect(source).toContain('onReachOldestMounted={() => void olderMessageLoader.request()}')
        expect(source).toContain('data-chat-jump-latest')
        expect(source).toContain('onclick={() => void jumpToLatestMessages()}')
        expect(source).toContain('data-chat-older-loading')
        expect(source).not.toContain('data-chat-pagination')
        expect(source).not.toContain('data-chat-page-previous')
        expect(source).not.toContain('data-chat-page-next')
        expect(source).not.toContain('getChatPageBounds')
        expect(source).not.toContain('selectChatPage(')
        expect(source).not.toMatch(/loadPages\s*\+=/)
    })

    it('keeps the side navigator compact and places the turn jump at the toolbar right edge', () => {
        const source = screen()
        const navigator = source.slice(
            source.indexOf("DBState.db.nodeOnlyScrollButtonType !== 'off'"),
            source.indexOf('{#if showNewMessageButton}'),
        )
        const toolbar = shortcuts()
        const close = toolbar.indexOf('class="toolbar-close"')
        const pageJump = toolbar.indexOf('data-chat-page-jump')
        const turnJump = toolbar.indexOf('data-chat-turn-jump', pageJump)
        const jumpButton = toolbar.indexOf('data-chat-page-turn-jump-button', turnJump)

        expect(navigator).not.toContain('data-chat-page-jump')
        expect(navigator).not.toContain('data-chat-turn-jump')
        expect(navigator).toContain('data-chat-page-top')
        expect(navigator).toContain('scrollToLoadedTop()')
        expect(navigator).toContain('DBState.db.pinChatScrollNavigator')
        expect([close, pageJump, turnJump, jumpButton].every(index => index >= 0)).toBe(true)
        expect(close).toBeLessThan(pageJump)
        expect(pageJump).toBeLessThan(turnJump)
        expect(turnJump).toBeLessThan(jumpButton)
        expect(toolbar).toContain('ArrowRightToLineIcon')
        expect(toolbar).toContain('onJump')
        // No pages: the whole resident slice is page 1, and the turns are the
        // resident ones.
        expect(source).toContain('pageCount={1}')
        expect(source).toContain('turnCount={residentTurnNavigation.turnCount}')
        expect(source).toContain('onJump={jumpToPageTurn}')
        expect(source).toContain('navigation.messageIndexByTurn[target - 1]')
        expect(source).toContain('if (messageIndex !== undefined) await scrollToMessage(messageIndex)')
        expect(source).not.toContain('targetPageTurnNavigation')
    })

    it('numbers response turns only from a resident start of history, through the mounted window', () => {
        const list = chats()
        const source = screen()
        const row = chat()

        expect(list).toContain('historyStartResident?: boolean')
        expect(list).toContain('? buildChatTurnNavigation(messages)')
        expect(list).toContain('const turnNumber = turnNavigation?.turnByMessageIndex.get(i)')
        expect(list).toContain('|${turnNumber ?? 0}|')
        expect(list).toMatch(/role: message\.role,\s*turnNumber,/)
        expect(source).toContain('let historyStartResident = $derived(!hasOlderSqlMessages(currentChatSlot))')
        expect(source).toContain('historyStartResident ? buildChatTurnNavigation(currentChat) : NO_TURN_NAVIGATION')
        expect(source).toContain('{historyStartResident}')
        expect(row).toContain('data-chat-turn-reference="header"')
        expect(row).toContain('data-chat-turn-reference="footer"')
    })

    it('restores the per-chat anchor and scroll position after the chat screen remounts', () => {
        const source = screen()
        expect(source).toContain("from 'src/ts/chatViewSession'")
        expect(source).toContain('loadChatViewSession(nextKey)')
        expect(source).toContain('saveChatViewSession(paginationKey')
        expect(source).toContain('anchorId: chatsInstance?.getAnchorId() ?? null')
        expect(source).toContain('chatsInstance?.revealMessageById(savedView.anchorId)')
        expect(source).toContain('bind:this={chatScrollContainer}')
        expect(source).toContain('chatScrollContainer.scrollTop = savedView.scrollTop')
    })

    it('never expands the mounted chat to infinity for screenshots', () => {
        const source = screen()
        expect(source).not.toContain('loadPages = Infinity')
        expect(source).toContain('chat-view-${v4()}.png')
    })

    it('draws the greeting only once the start of the conversation is on screen', () => {
        const source = screen()
        expect(source).toContain('{#if atOldestEnd && !hasOlderSqlMessages(currentChatSlot)}')
        expect(source).not.toContain('data-chat-pinned-first-message')
        expect(source).not.toContain('firstMessageCollapsed')
    })
})
