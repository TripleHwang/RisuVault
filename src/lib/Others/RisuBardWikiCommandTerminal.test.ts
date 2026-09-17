// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mount, tick, unmount } from 'svelte'
import { BARDCHAT_COMMAND_TEMPLATES } from 'src/ts/risubard/bardChatCommandTemplates'
import RisuBardWikiCommandTerminal from './RisuBardWikiCommandTerminal.svelte'

let mounted: ReturnType<typeof mount> | undefined

function readCssBlock(source: string, marker: string) {
    const markerIndex = source.indexOf(marker)
    if (markerIndex < 0) return ''
    const openingBrace = source.indexOf('{', markerIndex)
    if (openingBrace < 0) return ''
    let depth = 0
    for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1
        if (source[index] !== '}') continue
        depth -= 1
        if (depth === 0) return source.slice(markerIndex, index + 1)
    }
    return ''
}

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardWikiCommandTerminal', () => {
    test('uses a compact control layout when mobile layout is selected', () => {
        const source = readFileSync(
            'src/lib/Others/RisuBardWikiCommandTerminal.svelte',
            'utf8'
        )

        expect(source).toContain('class:mobile-layout={mobileLayout}')
        expect(source).toContain('.mobile-layout .context-menu label')
        expect(source).not.toContain('ShieldAlertIcon')
        expect(source).not.toContain('DIRECT')
    })

    test('sizes the command dialog by viewport instead of the wiki dock', () => {
        const source = readFileSync(
            'src/lib/Others/RisuBardWikiCommandTerminal.svelte',
            'utf8'
        )
        const compactTerminal = source.slice(
            source.indexOf('.command-terminal.mobile-layout'),
            source.indexOf('@media (max-width: 46rem)')
        )
        const compactViewport = readCssBlock(
            source,
            '@media (max-width: 46rem)'
        )

        expect(compactTerminal).not.toContain('.template-backdrop')
        expect(compactTerminal).not.toContain('.template-dialog')
        expect(compactViewport).toContain('.template-backdrop')
        expect(compactViewport).toContain('.template-dialog')
        expect(source).not.toContain('@container (max-width: 30rem)')
        expect(source).toContain('@media (max-width: 30rem)')
    })

    test('uses one toolbar row with execute at the far right', async () => {
        mounted = mount(RisuBardWikiCommandTerminal, {
            target: document.body,
            props: { onExecute: vi.fn() },
        })
        await tick()

        const terminal = document.body.querySelector<HTMLElement>(
            '[data-wiki-command-terminal]'
        )!
        const title = terminal.querySelector<HTMLElement>('.terminal-title')
        const toolbar = terminal.querySelector<HTMLElement>('.terminal-toolbar')!
        const body = terminal.querySelector<HTMLElement>('.terminal-body')!
        const input = terminal.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        const run = terminal.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!

        expect(title?.textContent?.trim()).toBe('BARDCHAT')
        expect(toolbar.contains(title!)).toBe(true)
        expect(toolbar.lastElementChild).toBe(run)
        expect(body.contains(input)).toBe(true)
        expect(run.parentElement).toBe(toolbar)
        expect(terminal.textContent).not.toContain('AI에게 지시를 내리세요')
        expect(terminal.textContent).not.toContain('DIRECT')
    })

    test('opens context controls as one column and closes them outside', async () => {
        mounted = mount(RisuBardWikiCommandTerminal, {
            target: document.body,
            props: { onExecute: vi.fn() },
        })
        const open = document.querySelector<HTMLButtonElement>(
            '[data-bardchat-context-open]'
        )!
        expect(open.textContent?.trim()).toBe('컨텍스트')
        expect(document.querySelector('[data-bardchat-context-menu]')).toBeNull()

        open.click()
        await tick()
        const menu = document.querySelector<HTMLElement>(
            '[data-bardchat-context-menu]'
        )!
        expect(menu).not.toBeNull()
        expect(menu.querySelectorAll('[data-bardchat-context]')).toHaveLength(7)
        expect(getComputedStyle(menu).gridTemplateColumns).not.toContain('repeat')

        document.body.click()
        await tick()
        expect(document.querySelector('[data-bardchat-context-menu]')).toBeNull()
    })

    test('exposes a tooltiped restore button and calls it once', async () => {
        const onRestore = vi.fn(async () => {})
        mounted = mount(RisuBardWikiCommandTerminal, {
            target: document.body,
            props: { onExecute: vi.fn(), onRestore, canRestore: true },
        })
        const restore = document.querySelector<HTMLButtonElement>(
            '[data-bardchat-restore]'
        )!
        expect(restore.disabled).toBe(false)
        expect(restore.title).toContain('이전 스냅샷')
        restore.click()
        await vi.waitFor(() => expect(onRestore).toHaveBeenCalledOnce())
    })

    test('shows seven compact context toggles and executes with the live selection', async () => {
        const onExecute = vi.fn(async () => ({ applied: [], failed: [] }))
        const onContextSelectionChange = vi.fn()
        mounted = mount(RisuBardWikiCommandTerminal, {
            target: document.body,
            props: {
                onExecute,
                contextSelection: {
                    wiki: true,
                    chat: false,
                    systemPrompt: false,
                    characterDescription: false,
                    persona: false,
                    characterLorebook: false,
                    moduleLorebook: false,
                },
                onContextSelectionChange,
            },
        })
        await tick()

        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-context-open]'
        )!.click()
        await tick()

        const toggles = [...document.body.querySelectorAll<HTMLInputElement>(
            '[data-bardchat-context]'
        )]
        expect(toggles).toHaveLength(7)
        expect(toggles.map((toggle) => toggle.dataset.bardchatContext))
            .toEqual([
                'wiki', 'chat', 'systemPrompt',
                'characterDescription', 'persona',
                'characterLorebook', 'moduleLorebook',
            ])
        expect(toggles[0].checked).toBe(true)
        expect(toggles[1].checked).toBe(false)

        toggles[2].click()
        await tick()
        expect(onContextSelectionChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ wiki: true, systemPrompt: true })
        )

        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '새 인물을 만들어.'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const run = document.body.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!
        await vi.waitFor(() => expect(run.disabled).toBe(false))
        run.click()

        await vi.waitFor(() => expect(onExecute).toHaveBeenCalledWith(
            '새 인물을 만들어.',
            expect.objectContaining({ wiki: true, systemPrompt: true })
        ))
    })

    test('opens a two-pane BARDCHAT command list', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: {
                onExecute: vi.fn(),
                targetDocumentTitleOrId: '세계관 설정',
            },
        })

        expect(document.body.textContent).toContain('BARDCHAT')
        expect(document.body.textContent).not.toContain('AI에게 지시를 내리세요')
        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-open]'
        )!.click()

        await vi.waitFor(() => {
            const dialog = document.body.querySelector(
                '[data-bardchat-template-dialog]'
            )
            expect(dialog).not.toBeNull()
            expect(dialog?.querySelector('[data-template-list-pane]')).not.toBeNull()
            expect(dialog?.querySelector('[data-template-prompt-pane]')).not.toBeNull()
            expect(dialog?.textContent).toContain('항목 결합')
            expect(dialog?.textContent).toContain('작업: COMBINE')
        })
    })

    test('inserts the selected command at the remembered textarea selection', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: { onExecute: vi.fn() },
        })
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '앞REPLACE뒤'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        input.focus()
        input.setSelectionRange(1, 8)

        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-open]'
        )!.click()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[data-bardchat-template-dialog]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-insert]'
        )!.click()

        const prompt = BARDCHAT_COMMAND_TEMPLATES[0].prompt.replaceAll(
            '<문서 제목 또는 ID>', '세계관 설정'
        )
        await vi.waitFor(() => expect(input.value).toBe(`앞${prompt}뒤`))
        expect(input.selectionStart).toBe(1 + prompt.length)
        expect(input.selectionEnd).toBe(1 + prompt.length)
        expect(document.body.querySelector(
            '[data-bardchat-template-dialog]'
        )).toBeNull()
    })

    test('replaces the whole command or closes without changing it', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: { onExecute: vi.fn() },
        })
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '기존 지시'
        input.dispatchEvent(new Event('input', { bubbles: true }))

        const open = document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-open]'
        )!
        open.click()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[data-bardchat-template-dialog]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-close]'
        )!.click()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[data-bardchat-template-dialog]'
        )).toBeNull())
        expect(input.value).toBe('기존 지시')

        open.click()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[data-bardchat-template-dialog]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-option="expand"]'
        )!.click()
        document.body.querySelector<HTMLButtonElement>(
            '[data-bardchat-template-replace]'
        )!.click()

        const expand = BARDCHAT_COMMAND_TEMPLATES.find(
            (template) => template.id === 'expand'
        )!
        await vi.waitFor(() => expect(input.value).toBe(expand.prompt))
    })

    test('runs one natural-language administrator command without workbench fields', async () => {
        const onExecute = vi.fn(async () => ({
            applied: [{
                action: 'upsert' as const,
                documentId: 'character.eri',
                title: '사토 에리',
                relativePath: 'characters/eri.md',
            }],
            failed: [],
        }))
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: { onExecute },
        })

        expect(document.body.querySelector('[data-markdown-writer-new-title]'))
            .toBeNull()
        expect(document.body.querySelector('[data-markdown-writer-draft]'))
            .toBeNull()
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '현 메시지의 프로파일 인물들을 각각 character로 만들어.'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const run = document.body.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!
        await vi.waitFor(() => expect(run.disabled).toBe(false))
        run.click()

        await vi.waitFor(() => {
            expect(onExecute).toHaveBeenCalledWith(
                input.value,
                expect.objectContaining({ wiki: true })
            )
            expect(document.body.querySelector('[data-wiki-command-result]')
                ?.textContent).toContain('사토 에리')
        })
    })

    test('shows every partial failure instead of a false success', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: {
                onExecute: async () => ({
                    applied: [],
                    failed: [{
                        action: 'upsert' as const,
                        targetDocumentId: 'character.eri',
                        title: '사토 에리',
                        reason: '동시 편집 충돌',
                    }],
                }),
            },
        })
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '인물을 갱신해.'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const run = document.body.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!
        await vi.waitFor(() => expect(run.disabled).toBe(false))
        run.click()

        await vi.waitFor(() => expect(
            document.body.querySelector('[data-wiki-command-result]')?.textContent
        ).toContain('동시 편집 충돌'))
    })
})
