import { describe, expect, test } from 'vitest'
import {
    applyCanonicalSectionPatches,
    parseCanonicalSectionPatchMarkdown,
} from './risubard-markdown-section-patch'

describe('canonical Markdown section patches', () => {
    test('replaces one H3 section while preserving untouched sections', () => {
        const markdown = [
            '## 루치아',
            '',
            '### 현재 상태',
            '',
            '- 대학원 재학 중',
            '',
            '### 정체성',
            '',
            '- 수의사',
        ].join('\n')

        expect(applyCanonicalSectionPatches({
            markdown,
            title: '루치아',
            patches: [{
                heading: '현재 상태', operation: 'upsert',
                content: '- 석사 학위 취득 완료',
            }],
        })).toBe([
            '## 루치아',
            '',
            '### 현재 상태',
            '',
            '- 석사 학위 취득 완료',
            '',
            '### 정체성',
            '',
            '- 수의사',
        ].join('\n'))
    })

    test('inserts and deletes named sections', () => {
        const markdown = '## 루치아\n\n### 현재 상태\n\n- 여행 중\n\n### 임시 메모\n\n- 삭제 대상'
        const result = applyCanonicalSectionPatches({
            markdown,
            title: '루치아',
            patches: [
                { heading: '목표', operation: 'upsert', content: '- 고향으로 귀환' },
                { heading: '임시 메모', operation: 'delete', content: '' },
            ],
        })

        expect(result).toContain('### 현재 상태\n\n- 여행 중')
        expect(result).toContain('### 목표\n\n- 고향으로 귀환')
        expect(result).not.toContain('임시 메모')
    })

    test('updates the legacy preamble without touching following sections', () => {
        expect(applyCanonicalSectionPatches({
            markdown: '# 루치아\n\n이전 상태.\n\n## 정체성\n\n- 수의사',
            title: '루치아',
            patches: [{
                heading: '', operation: 'upsert', content: '현재 케사리아에 있다.',
            }],
        })).toBe('# 루치아\n\n현재 케사리아에 있다.\n\n## 정체성\n\n- 수의사')
    })

    test('updates direct H2 sections under a legacy H1 title', () => {
        expect(applyCanonicalSectionPatches({
            markdown: '# 루치아\n\n## 현재 상태\n\n- 대학원 재학 중\n\n## 정체성\n\n- 수의사',
            title: '루치아',
            patches: [{
                heading: '현재 상태', operation: 'upsert',
                content: '- 석사 학위 취득 완료',
            }],
        })).toBe('# 루치아\n\n## 현재 상태\n\n- 석사 학위 취득 완료\n\n## 정체성\n\n- 수의사')
    })

    test('preserves omitted section bytes and ignores headings inside fences', () => {
        const untouched = [
            '### 정체성',
            '',
            '  들여쓴 코드',
            'hard break  ',
            '',
            '```md',
            '### 가짜 절',
            '```',
            '',
            '',
        ].join('\n')
        const markdown = `## 루치아\n\n### 현재 상태\n\n- 재학 중\n\n${untouched}### 목표\n\n- 졸업`
        const result = applyCanonicalSectionPatches({
            markdown,
            title: '루치아',
            patches: [{
                heading: '현재 상태', operation: 'upsert',
                content: '- 석사 학위 취득 완료',
            }],
        })

        expect(result.slice(result.indexOf('### 정체성')))
            .toBe(`${untouched}### 목표\n\n- 졸업`)
    })

    test.each([
        { fence: '```', falseClose: '```not-a-close' },
        { fence: '~~~', falseClose: '~~~not-a-close' },
    ])('keeps headings hidden after invalid $fence closing fences', ({ fence, falseClose }) => {
        const markdown = [
            '## 루치아', '', '### 메모', '', fence,
            falseClose, '### 가짜 현재 상태', '- 코드 안의 값', fence,
            '', '### 현재 상태', '', '- 재학 중',
        ].join('\n')
        const result = applyCanonicalSectionPatches({
            markdown,
            title: '루치아',
            patches: [{
                heading: '현재 상태', operation: 'upsert',
                content: '- 석사 학위 취득 완료',
            }],
        })

        expect(result).toContain(`${falseClose}\n### 가짜 현재 상태\n- 코드 안의 값`)
        expect(result.match(/^### 현재 상태$/gmu)).toHaveLength(1)
        expect(result).toContain('### 현재 상태\n\n- 석사 학위 취득 완료')
    })

    test('assembles a new document from returned sections', () => {
        expect(applyCanonicalSectionPatches({
            title: '루치아',
            patches: [
                { heading: '현재 상태', operation: 'upsert', content: '- 여행 중' },
                { heading: '작중 행적', operation: 'upsert', content: '- [[도착]]' },
            ],
        })).toBe([
            '## 루치아',
            '',
            '### 현재 상태',
            '',
            '- 여행 중',
            '',
            '### 작중 행적',
            '',
            '- [[도착]]',
        ].join('\n'))
    })

    test('parses safe direct H3 sections from a Markdown model fallback', () => {
        expect(parseCanonicalSectionPatchMarkdown([
            '### 정체성 및 역할', '', '- 왕실 기록관이다.', '',
            '### 큰 전환점', '', '- [[왕궁 화재]]에서 기록을 구했다.',
        ].join('\n'))).toEqual([
            { heading: '정체성 및 역할', operation: 'upsert', content: '- 왕실 기록관이다.' },
            { heading: '큰 전환점', operation: 'upsert', content: '- [[왕궁 화재]]에서 기록을 구했다.' },
        ])
    })

    test.each([4_000, 4_001])('allows fallback sections with %i characters', (length) => {
        const content = 'A'.repeat(length)
        expect(parseCanonicalSectionPatchMarkdown(
            `### History\n\n${content}`
        )[0].content).toBe(content)
    })

    test.each([
        '설명문\n\n### 정체성\n\n- 기록관',
        '## 문서 제목\n\n### 정체성\n\n- 기록관',
        '### 정체성\n\n- 기록관\n\n### 정체성\n\n- 중복',
    ])('rejects unsafe Markdown fallback output', (markdown) => {
        expect(() => parseCanonicalSectionPatchMarkdown(markdown)).toThrow()
    })

    test('rejects unknown deletes and title-level content', () => {
        expect(() => applyCanonicalSectionPatches({
            markdown: '## 루치아\n\n### 현재 상태\n\n- 여행 중',
            title: '루치아',
            patches: [{ heading: '없는 절', operation: 'delete', content: '' }],
        })).toThrow(/does not exist/)
        expect(() => applyCanonicalSectionPatches({
            title: '루치아',
            patches: [{ heading: '현재 상태', operation: 'upsert', content: '## 다른 문서' }],
        })).toThrow(/heading/)
        expect(() => applyCanonicalSectionPatches({
            markdown: '## 루치아\n\n## 잘못된 두 번째 제목\n\n본문',
            title: '루치아',
            patches: [{ heading: '현재 상태', operation: 'upsert', content: '- 여행 중' }],
        })).toThrow(/title-level/)
    })
})
