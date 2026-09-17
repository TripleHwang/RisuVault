// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { createBardLoreSettings, type BardLoreEntry } from 'src/ts/lorebook/bardLore'
import BardLoreSearchPreview from './BardLoreSearchPreview.svelte'

const tokenizerMock = vi.hoisted(() => vi.fn(async () => 10))
const parserMock = vi.hoisted(() => vi.fn((value: string) => `parsed:${value}`))
vi.mock('src/ts/tokenizer', () => ({ tokenize: tokenizerMock }))
vi.mock('src/ts/parser/parser.svelte', () => ({ risuChatParser: parserMock }))

const entry = (id: string, tags: string[]): BardLoreEntry => ({
    id,
    key: '',
    secondkey: '',
    insertorder: 10,
    comment: id,
    content: id + ' content',
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    bard: {
        sourceLegacyId: id,
        sourceHash: id,
        kind: 'location',
        activation: 'retrieve',
        aliases: [],
        tags,
        summary: '',
        facets: [],
        injection: 'full',
        links: [],
    },
})

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('BardLoreSearchPreview', () => {
    it('shows only entries selected by the current saved retrieval settings', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(BardLoreSearchPreview, {
            target,
            props: {
                entries: [entry('mall', ['시내']), entry('dorm', ['기숙사'])],
                character: {} as any,
                settings: createBardLoreSettings({
                    targetTokens: 100,
                    maximumTokens: 100,
                    maxEntries: 1,
                }),
            },
        })
        await tick()
        const input = document.body.querySelector<HTMLInputElement>('[data-bard-lore-preview-query]')!
        input.value = '시내 데이트'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-preview-run]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-preview-result="mall"]')).not.toBeNull())

        expect(document.body.querySelector('[data-bard-lore-preview-result="dorm"]')).toBeNull()
        expect(document.body.querySelector('[data-bard-lore-preview-excluded="dorm"]')).not.toBeNull()
        expect(document.body.textContent).toContain('sparse')
        expect(parserMock).toHaveBeenCalledWith('mall content', { chara: expect.anything() })
        expect(tokenizerMock).toHaveBeenCalledWith('parsed:mall content')
    })

    it('shows the parsed target, count, constraints, and separated budget lanes', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        const male = entry('akihiko', [])
        male.bard.kind = 'character'
        male.bard.facets = [
            { key: 'work', value: 'Persona 3', aliases: ['페르소나 3'] },
            { key: 'gender', value: 'male', aliases: ['남자'] },
        ]
        mounted = mount(BardLoreSearchPreview, {
            target,
            props: {
                entries: [male],
                character: {} as any,
                settings: createBardLoreSettings(),
            },
        })
        await tick()
        const input = document.body.querySelector<HTMLInputElement>('[data-bard-lore-preview-query]')!
        input.value = '페르소나 3의 남자 캐릭터 아무나 1명 설명'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-bard-lore-preview-run]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-bard-lore-query-plan]')).not.toBeNull())

        expect(document.body.querySelector('[data-bard-lore-query-intent]')?.textContent).toBe('describe')
        expect(document.body.querySelector('[data-bard-lore-query-count]')?.textContent).toBe('1')
        expect(document.body.querySelector('[data-bard-lore-query-kinds]')?.textContent).toContain('character')
        expect(document.body.querySelector('[data-bard-lore-query-constraints]')?.textContent).toContain('gender=male')
        expect(document.body.querySelector('[data-bard-lore-budget-lanes]')?.textContent).toContain('context')
    })
})
