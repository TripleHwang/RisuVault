// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest'
import {
    buildArcaLogClipboardHtml,
    buildArcaLogPlainText,
    getArcaLogTurnCount,
    hasVisibleArcaLogContent,
    selectArcaLogMessages,
    summarizeArcaLogMessages,
    type ArcaLogRenderedMessage,
} from './arcaChatLog'

describe('Arca chat log message selection', () => {
    const messages = [
        { data: 'greeting', role: 'char' as const },
        { data: 'hello', role: 'user' as const },
        { data: 'hidden', role: 'char' as const, disabled: true },
        { data: 'note', role: 'char' as const, isComment: true },
        { data: 'answer', role: 'char' as const },
        { data: 'follow-up', role: 'user' as const },
    ]

    test('whole-chat mode keeps only active conversation messages', () => {
        const selected = selectArcaLogMessages(messages, { mode: 'all' })

        expect(selected.map(item => [item.number, item.message.data])).toEqual([
            [1, 'greeting'],
            [2, 'hello'],
            [3, 'answer'],
            [4, 'follow-up'],
        ])
    })

    test('page range uses source indices and keeps the greeting on page one only', () => {
        const paged = [
            { data: 'greeting', role: 'char' as const, sourceIndex: -1 },
            { data: 'u1', role: 'user' as const, sourceIndex: 0 },
            { data: 'c1', role: 'char' as const, sourceIndex: 1 },
            { data: 'u2', role: 'user' as const, sourceIndex: 2 },
            { data: 'c2', role: 'char' as const, sourceIndex: 3 },
        ]
        const first = selectArcaLogMessages(paged, { mode: 'page', start: 1, end: 1, pageSize: 2 })
        const second = selectArcaLogMessages(paged, { mode: 'page', start: 2, end: 2, pageSize: 2 })

        expect(first.map(item => item.message.data)).toEqual(['greeting', 'u1', 'c1'])
        expect(second.map(item => item.message.data)).toEqual(['u2', 'c2'])
    })

    test('turn range groups each user message with following character responses', () => {
        const selected = selectArcaLogMessages(messages, { mode: 'turn', start: 2, end: 2 })

        expect(selected.map(item => item.message.data)).toEqual([
            'hello',
            'answer',
        ])
        expect(getArcaLogTurnCount(messages)).toBe(3)
    })

    test('can exclude user messages without changing whole-chat numbering', () => {
        const selected = selectArcaLogMessages(
            messages,
            { mode: 'all' },
            { includeUserMessages: false },
        )

        expect(selected.map(item => [item.number, item.message.data])).toEqual([
            [1, 'greeting'],
            [3, 'answer'],
        ])
    })

    test('messages that render as blank placeholders are not exported', () => {
        const selected = selectArcaLogMessages([
            { data: '{{none}}', role: 'char' as const },
            { data: '   ', role: 'user' as const },
            { data: '{{blank}}', role: 'char' as const },
            { data: 'visible', role: 'char' as const },
        ], { mode: 'all' })

        expect(selected.map(item => item.message.data)).toEqual(['visible'])
    })
})

describe('Arca chat log selection summary', () => {
    test('counts visible characters and HTML or Markdown images', () => {
        expect(summarizeArcaLogMessages([
            { data: '가나다' },
            { data: '![사진](a.png)라마' },
            { data: '<img src="b.png" alt="">바' },
        ])).toEqual({ characters: 6, images: 2 })
    })
})

describe('Arca chat log render readiness', () => {
    test('ignores invisible AI metadata until visible text or visual content exists', () => {
        const body = document.createElement('div')
        body.textContent = '\u200B\u200C\u200D\uFEFF\u2060\u180E'
        expect(hasVisibleArcaLogContent(body)).toBe(false)

        body.innerHTML = '<p>실제 메시지</p>'
        expect(hasVisibleArcaLogContent(body)).toBe(true)

        body.innerHTML = '<img src="data:image/png;base64,AAA" alt="">'
        expect(hasVisibleArcaLogContent(body)).toBe(true)

        body.innerHTML = '<div style="height:48px"><div style="animation:spin 1s linear infinite"></div></div>'
        expect(hasVisibleArcaLogContent(body)).toBe(false)
    })
})

describe('Arca chat log clipboard composition', () => {
    const rendered: ArcaLogRenderedMessage[] = [
        {
            number: 1,
            role: 'char',
            displayName: 'Alice <Admin>',
            badge: 'Model & One',
            iconDataUrl: 'data:image/png;base64,AAA',
            bodyHtml: '<p>First <strong>reply</strong></p>',
            plainText: 'First reply',
        },
        {
            number: 2,
            role: 'user',
            displayName: 'User',
            iconDataUrl: 'data:image/png;base64,BBB',
            bodyHtml: '<p>Second message</p>',
            plainText: 'Second message',
        },
    ]

    test('builds one polished document with escaped labels and one footer', () => {
        const html = buildArcaLogClipboardHtml({
            title: 'Chat <One>',
            messages: rendered,
            showTitleImage: true,
        })

        expect(html).toContain('Chat &lt;One&gt;')
        expect(html).toContain('Alice &lt;Admin&gt;')
        expect(html).toContain('Model &amp; One')
        expect(html).toContain('<p>First <strong>reply</strong></p>')
        expect(html.match(/From RisuVault/g)).toHaveLength(1)
        expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2)
    })

    test('omits profile images when the shared setting is disabled', () => {
        const html = buildArcaLogClipboardHtml({
            title: 'Chat',
            messages: rendered,
            showTitleImage: false,
        })

        expect(html).not.toContain('data:image/png;base64,')
    })

    test('builds readable plain text in message order', () => {
        expect(buildArcaLogPlainText('Chat One', rendered)).toBe(
            'Chat One\n\n1. Alice <Admin> · Model & One\nFirst reply\n\n2. User\nSecond message',
        )
    })
})
