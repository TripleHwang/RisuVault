import { describe, expect, test } from 'vitest'
import {
    STORY_ARC_CHECKPOINT_SIZE,
    buildStoryArcUpdatePlan,
    isStoryArcTitle,
    readStoryArcCheckpoint,
    stampStoryArcCheckpoint,
    storyArcRewriteInstruction,
} from './risubard-story-arc-writer'

const event = (index: number) => ({
    id: `event.${index}`,
    type: 'event' as const,
    title: `사건 ${index}`,
    content: `## 사건 ${index}\n\n### 이야기 요약\n\n- ${index}번째 사건`,
    sourceMessageIds: [`assistant-${index}`],
    created: `2026-08-30T00:00:${String(index).padStart(2, '0')}.000Z`,
})

describe('story arc writer', () => {
    test('waits for a bounded event checkpoint before creating the plot', () => {
        expect(buildStoryArcUpdatePlan({
            documents: Array.from(
                { length: STORY_ARC_CHECKPOINT_SIZE - 1 },
                (_, index) => event(index + 1)
            ),
            savedEvents: [],
            writingLanguage: 'ko',
        })).toBeUndefined()

        const plan = buildStoryArcUpdatePlan({
            documents: Array.from(
                { length: STORY_ARC_CHECKPOINT_SIZE },
                (_, index) => event(index + 1)
            ),
            savedEvents: [],
            writingLanguage: 'ko',
        })

        expect(plan).toMatchObject({
            checkpointEventId: `event.${STORY_ARC_CHECKPOINT_SIZE}`,
            candidate: {
                type: 'other',
                title: '스토리 아크 플롯',
                action: 'create',
                targetDocumentId: null,
            },
        })
        expect(plan?.events).toHaveLength(STORY_ARC_CHECKPOINT_SIZE)
    })

    test('uses configured checkpoint and prompt limits', () => {
        const settings = {
            checkpointSize: 4,
            maxArcs: 5,
            maxTurningPoints: 9,
            maxOpenThreads: 3,
            maxCharacters: 4_500,
        }
        const plan = buildStoryArcUpdatePlan({
            documents: Array.from({ length: 4 }, (_, index) => event(index + 1)),
            savedEvents: [],
            writingLanguage: 'ko',
            settings,
        })

        expect(plan?.events).toHaveLength(4)
        expect(storyArcRewriteInstruction('ko', settings)).toContain(
            'at most 5 chronological arc bullets, 9 turning-point bullets, and 3 open-thread bullets'
        )
        expect(storyArcRewriteInstruction('ko', settings)).toContain('4,500 characters')
    })

    test('continues from the program checkpoint and updates one reserved map', () => {
        const existing = {
            id: 'other.story-arc-map',
            type: 'other' as const,
            title: 'Story Arc Map',
            content: stampStoryArcCheckpoint(
                '## Story Arc Map\n\n### Arc Overview\n\n- The road begins at [[사건 8]].',
                'event.8'
            ),
            sourceMessageIds: [],
        }
        const plan = buildStoryArcUpdatePlan({
            documents: [
                existing,
                ...Array.from({ length: 16 }, (_, index) => event(index + 1)),
            ],
            savedEvents: [],
            writingLanguage: 'en',
        })

        expect(plan).toMatchObject({
            checkpointEventId: 'event.16',
            candidate: {
                title: 'Story Arc Map',
                action: 'update',
                targetDocumentId: 'other.story-arc-map',
            },
        })
        expect(plan?.events.map((item) => item.id)).toEqual(
            Array.from({ length: 8 }, (_, index) => `event.${index + 9}`)
        )
        expect(readStoryArcCheckpoint(existing.content)).toBe('event.8')
    })

    test('repairs a checkpoint plot that has no event links', () => {
        const existing = {
            id: 'other.story-arc-plot',
            type: 'other' as const,
            title: '스토리 아크 플롯',
            content: stampStoryArcCheckpoint(
                '## 스토리 아크 플롯\n\n### 아크 개요\n\n- 관문까지 여정이 이어졌다.',
                'event.8'
            ),
            sourceMessageIds: [],
        }
        const plan = buildStoryArcUpdatePlan({
            documents: [
                existing,
                ...Array.from({ length: 9 }, (_, index) => event(index + 1)),
            ],
            savedEvents: [],
            writingLanguage: 'ko',
        })

        expect(plan).toMatchObject({
            checkpointEventId: 'event.8',
            candidate: {
                action: 'update',
                targetDocumentId: 'other.story-arc-plot',
            },
        })
        expect(plan?.events.map((item) => item.id)).toEqual(
            Array.from({ length: 8 }, (_, index) => `event.${index + 1}`)
        )
    })

    test('replaces a stale checkpoint marker without changing the body', () => {
        const first = stampStoryArcCheckpoint('## 스토리 아크 지도', 'event.8')
        const second = stampStoryArcCheckpoint(first, 'event.16')

        expect(second.match(/risubard-story-arc-checkpoint/g)).toHaveLength(1)
        expect(second).toContain('## 스토리 아크 지도')
        expect(readStoryArcCheckpoint(second)).toBe('event.16')
    })

    test('does not replay old events when an existing map has no checkpoint', () => {
        expect(buildStoryArcUpdatePlan({
            documents: [{
                id: 'other.manual-map',
                type: 'other',
                title: '스토리 아크 지도',
                content: '## 스토리 아크 지도\n\n### 아크 개요\n\n- 수동 기록',
                sourceMessageIds: [],
            }, ...Array.from({ length: 8 }, (_, index) => event(index + 1))],
            savedEvents: [],
            writingLanguage: 'ko',
        })).toBeUndefined()
    })

    test('recognizes the new plot titles and legacy map titles', () => {
        expect(isStoryArcTitle('스토리 아크 플롯')).toBe(true)
        expect(isStoryArcTitle('Story Arc Plot')).toBe(true)
        expect(isStoryArcTitle('스토리 아크 지도')).toBe(true)
        expect(isStoryArcTitle('Story Arc Map')).toBe(true)
    })

    test.each([
        ['ja', 'ストーリーアークプロット', 'アーク概要'],
        ['zh-Hans', '故事篇章情节', '篇章概览'],
        ['zh-Hant', '故事篇章情節', '篇章概覽'],
    ] as const)('uses locale data for the %s story arc', (locale, title, overview) => {
        const plan = buildStoryArcUpdatePlan({
            documents: Array.from(
                { length: STORY_ARC_CHECKPOINT_SIZE },
                (_, index) => event(index + 1)
            ),
            savedEvents: [],
            writingLanguage: locale,
        })
        expect(plan?.candidate.title).toBe(title)
        expect(storyArcRewriteInstruction(locale)).toContain(overview)
        expect(isStoryArcTitle(title)).toBe(true)
    })
})
