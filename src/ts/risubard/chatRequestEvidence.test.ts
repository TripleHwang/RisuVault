import { describe, expect, it, vi } from 'vitest'
import type { RequestLogEntry } from 'src/ts/requestLog'

vi.mock('src/ts/requestLog', () => ({
    fetchRequestLogPage: vi.fn(),
}))

import {
    buildLegacyChatRequestEvidence,
    buildChatRequestEvidence,
    formatChatRequestEvidenceMarkdown,
} from './chatRequestEvidence'
import * as evidenceModule from './chatRequestEvidence'

const entry: RequestLogEntry = {
    id: 7,
    timestamp: Date.UTC(2026, 7, 12, 3, 4, 5),
    category: 'llm',
    source: 'main',
    purpose: 'chat-response',
    chatId: 'generation-7',
    sessionChatId: 'chat-7',
    model: 'Vertex AI - Gemini 3.1 Pro',
    provider: 'vertex',
    url: 'https://provider.example/v1',
    status: 200,
    success: true,
    aborted: false,
    route: 'proxy',
    streaming: true,
    durationMs: 22_400,
    firstTokenMs: 850,
    inputTokens: 6_537,
    outputTokens: 792,
    cachedTokens: 100,
    reasoningTokens: 40,
    injectionManifest: {
        totalTokens: 1_245,
        estimated: true,
        items: [
            { kind: 'systemPrompt', tokens: 16 },
            { kind: 'lorebook', name: '라비안', tokens: 226 },
            { kind: 'lorebook', name: 'Main', tokens: 1_003 },
        ],
    },
    requestBody: '{"apiKey":"must-not-export"}',
    responseBody: 'secret prose',
    truncated: false,
}

describe('chat request evidence', () => {
    it('builds exportable evidence for old plugin generations without stored rows', () => {
        const evidence = buildLegacyChatRequestEvidence('chat-legacy', [{
            timestamp: Date.UTC(2026, 7, 12, 3, 4, 5),
            generationId: 'generation-plugin',
            model: 'pluginmodel:::[PM] gemini-3.7-flash',
            inputTokens: 27_094,
            outputTokens: 1_361,
            durationMs: 15_088,
            wikiTokens: 420,
        }], Date.UTC(2026, 7, 12, 4))

        expect(evidence.requestCount).toBe(1)
        expect(evidence.requests[0]).toMatchObject({
            timestamp: '2026-08-12T03:04:05.000Z',
            generationId: 'generation-plugin',
            source: 'main',
            inputTokens: 27_094,
            outputTokens: 1_361,
        })
        expect(evidence.requests[0].injectionManifest).toEqual({
            totalTokens: 27_094,
            estimated: true,
            items: [
                { kind: 'wiki', name: '선택된 BardWiki', tokens: 420 },
                { kind: 'other', name: '세부 구성이 보존되지 않은 입력', tokens: 26_674 },
            ],
        })
    })

    it('keeps only evidence metadata and reconciles injection tokens to input usage', () => {
        const evidence = buildChatRequestEvidence('chat-7', [entry], Date.UTC(2026, 7, 12, 4))

        expect(evidence.requests).toHaveLength(1)
        expect(evidence.requests[0].purpose).toBe('chat-response')
        expect(evidence.requests[0].injectionManifest?.totalTokens).toBe(6_537)
        expect(evidence.requests[0].injectionManifest?.items.reduce(
            (sum, item) => sum + item.tokens, 0
        )).toBe(6_537)
        expect(JSON.stringify(evidence)).not.toContain('must-not-export')
        expect(JSON.stringify(evidence)).not.toContain('secret prose')
        expect(JSON.stringify(evidence)).not.toContain('provider.example')
    })

    it('exports a safe failure category and HTTP status without the raw provider error', () => {
        const failed: RequestLogEntry = {
            ...entry,
            success: false,
            status: 504,
            errorMessage: 'Upstream request timed out after 300000ms api_key=must-not-export',
        }
        const evidence = buildChatRequestEvidence('chat-7', [failed])
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(evidence.requests[0]).toMatchObject({
            outcome: 'failed',
            status: 504,
            failureCategory: 'timeout',
        })
        expect(markdown).toContain('| HTTP 상태 | 504 |')
        expect(markdown).toContain('| 오류 유형 | 타임아웃 |')
        expect(markdown).not.toContain('api_key')
        expect(markdown).not.toContain('must-not-export')
    })

    it('identifies native structured-output validation failures without exporting output', () => {
        const failed: RequestLogEntry = {
            ...entry,
            success: false,
            errorMessage: '[PageFold] Structured output validation failed: /schemaVersion: value does not match const',
        }
        const evidence = buildChatRequestEvidence('chat-7', [failed])
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(evidence.requests[0].failureCategory).toBe('format')
        expect(markdown).toContain('| 오류 유형 | 구조화 응답 검증 오류 |')
        expect(markdown).not.toContain('/schemaVersion')
    })

    it('identifies provider invalid-argument rejections without exporting request data', () => {
        const failed: RequestLogEntry = {
            ...entry,
            success: false,
            errorMessage: '[PageFold] Request contains an invalid argument.',
        }
        const evidence = buildChatRequestEvidence('chat-7', [failed])
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(evidence.requests[0].failureCategory).toBe('invalid-request')
        expect(markdown).toContain('| 오류 유형 | 요청 인자 거부 |')
        expect(markdown).not.toContain('Request contains')
    })

    it('identifies invalid-argument rejections preserved only in the provider response body', () => {
        const failed: RequestLogEntry = {
            ...entry,
            success: false,
            status: 400,
            errorMessage: undefined,
            responseBody: JSON.stringify({
                error: {
                    code: 400,
                    status: 'INVALID_ARGUMENT',
                    message: 'Request contains an invalid argument.',
                },
            }),
        }
        const evidence = buildChatRequestEvidence('chat-7', [failed])
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(evidence.requests[0].failureCategory).toBe('invalid-request')
        expect(markdown).toContain('| 오류 유형 | 요청 인자 거부 |')
        expect(markdown).not.toContain('Request contains')
    })

    it('records successful BardWiki HTTP calls as responses, not completed work', () => {
        const evidence = buildChatRequestEvidence('chat-7', [{
            ...entry,
            source: 'memory',
            purpose: 'bardwiki-canonical-update',
        }])
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(evidence.requests[0].outcome).toBe('response-received')
        expect(markdown).toContain('| 결과 | 응답 수신 (후속 검증·저장 결과 별도) |')
        expect(markdown).not.toContain('| 결과 | done |')
    })

    it('formats the card fields and every injection row as readable Markdown', () => {
        const evidence = buildChatRequestEvidence(
            'chat-7',
            [entry],
            Date.UTC(2026, 7, 12, 4),
            'Asia/Seoul',
        )
        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(markdown).toContain('- 표시 시간대: Asia/Seoul (UTC+09:00)')
        expect(markdown).toContain('- 생성 시각: 2026-08-12 13:00:00')
        expect(markdown).toContain('| 시각 | 2026-08-12 12:04:05 |')
        expect(markdown).not.toContain('2026-08-12T03:04:05.000Z')
        expect(markdown).toContain('Vertex AI - Gemini 3.1 Pro')
        expect(markdown).toContain('| 요청 목적 | 채팅 답변 생성 |')
        expect(markdown).toContain('| 로그 종류 | main |')
        expect(markdown).toContain('6,537')
        expect(markdown).toContain('792')
        expect(markdown).toContain('22.4초')
        expect(markdown).toContain('로어북 · 라비안')
        expect(markdown).toContain('로어북 · Main')
        expect(markdown).not.toContain('must-not-export')
        expect(markdown).not.toContain('secret prose')
        expect(markdown).not.toContain('가상 레거시')
        expect(markdown).not.toContain('레거시 입력 구성')
        expect(markdown).toContain('## 요청 #7 · 채팅 답변 생성')
        expect(markdown).not.toContain('## 요청 1')
    })

    it('groups instruction blocks and adjacent chat ranges for display', () => {
        const evidence = buildChatRequestEvidence('chat-7', [{
            ...entry,
            inputTokens: 1_000,
            injectionManifest: {
                totalTokens: 1_000,
                items: [
                    { kind: 'chatHistory', name: '4개 (1~4)', tokens: 300 },
                    { kind: 'instruction', name: '작업 지시', tokens: 120 },
                    { kind: 'chatHistory', name: '1개 (5~5)', tokens: 200 },
                    { kind: 'instruction', name: '추가 프롬프트', tokens: 180 },
                    { kind: 'chatHistory', name: '1개 (6~6)', tokens: 200 },
                ],
            },
        }])

        const markdown = formatChatRequestEvidenceMarkdown(evidence)

        expect(markdown.match(/\| 추가 지침 · 2개 항목 \| 300 \|/g)).toHaveLength(1)
        expect(markdown.match(/\| 채팅 기록 · 6개 \(1~6\) \| 700 \|/g)).toHaveLength(1)
        expect(markdown).not.toContain('5~5')
        expect(markdown).not.toContain('6~6')
    })

    it('counts only retained assistant bodies and the currently selected reroll', async () => {
        const summarize = (evidenceModule as Record<string, unknown>)
            .addRetainedAssistantSummary as undefined | ((
                evidence: ReturnType<typeof buildChatRequestEvidence>,
                messages: Array<Record<string, unknown>>,
                countText: (text: string) => Promise<number>,
            ) => Promise<ReturnType<typeof buildChatRequestEvidence>>)

        expect(typeof summarize).toBe('function')
        const countText = vi.fn(async (text: string) => text.length)
        const evidence = await summarize!(
            buildChatRequestEvidence('chat-7', [entry]),
            [{ role: 'user', data: 'question' }, {
                role: 'char',
                data: 'selected answer',
                swipes: ['discarded reroll', 'selected answer'],
                swipeId: 1,
            }, {
                role: 'char',
                data: 'second',
                chatId: 'generation-7',
                generationInfo: {
                    generationId: 'generation-7',
                    risuBardContext: {
                        recentMessages: [
                            { id: 'assistant-1', role: 'char' },
                            { id: 'user-2', role: 'user' },
                        ],
                    },
                },
            }, {
                role: 'char',
                data: 'assistant-side comment',
                isComment: true,
            }],
            countText,
        )

        expect(countText.mock.calls.map(([text]) => text)).toEqual([
            'selected answer',
            'second',
        ])
        expect(evidence.retainedAssistant).toEqual({
            responseCount: 2,
            bodyTokens: 21,
        })
        const markdown = formatChatRequestEvidenceMarkdown(evidence)
        expect(markdown).toContain('- 리롤 제외 누적 assistant 답변 수: 2')
        expect(markdown).toContain('- 리롤 제외 누적 assistant 본문 토큰: 21')
        expect(markdown).toContain('| 선택된 채팅 메시지 | 2 |')
    })
})
