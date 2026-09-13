import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const dock = readFileSync(resolve(
    process.cwd(),
    'src/lib/Others/RisuBardMemoryWiki.svelte'
), 'utf8')
const chatScreen = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/DefaultChatScreen.svelte'
), 'utf8')
const processSource = readFileSync(resolve(
    process.cwd(),
    'src/ts/process/index.svelte.ts'
), 'utf8')
const korean = readFileSync(resolve(process.cwd(), 'src/lang/ko.ts'), 'utf8')
const english = readFileSync(resolve(process.cwd(), 'src/lang/en.ts'), 'utf8')

describe('BardWiki Batch analysis control', () => {
    test('analyzes all pending responses and retains missing-candidate fallback', () => {
        expect(dock).toContain('onBatchWikiUpdate?: () => Promise<boolean>')
        expect(dock).toContain('data-risubard-batch-wiki-update')
        expect(dock).toContain('await onBatchWikiUpdate?.()')
        expect(chatScreen).toContain(
            'onBatchWikiUpdate={batchCurrentNarrativeWikiUpdate}'
        )
        expect(processSource).toContain('projectPendingWikiBatch(')
        expect(processSource).toContain('eventTurns: projected.eventTurns')
        expect(processSource).toContain('settings.risuBardAnalysisExcludeUserMessages')
        expect(processSource).toContain("operation: 'error'")
        expect(processSource).toContain('위키 갱신 실패:')
        expect(processSource).toContain('canonicalTurnRetryWarning(receipt)')
        expect(processSource).toContain('message: retryWarning')
        expect(processSource).toContain('boundedMemoryAnalysisError(error)')
        expect(processSource).toContain('console.warn(`[RisuBard memory analysis] ${reason}`)')
        expect(processSource).toContain('additionalAnalysis: true')
        expect(processSource).toContain('excludeCanonicalDocumentIds')
        expect(processSource).toContain("logSource: 'wiki-admin'")
        expect(processSource).toContain('realChatId: chatId')
    })

    test('describes the action as Batch analysis', () => {
        expect(korean).toContain('risuBardMemoryForceUpdate: "Batch 분석"')
        expect(korean).toContain(
            'risuBardMemoryForceUpdateEmpty: "분석할 AI 응답이 없습니다."'
        )
        expect(korean).toContain(
            'risuBardMemoryForceUpdateMeta: (turn: number, time: string) => `분석 기준: ${turn.toLocaleString()}턴 · 갱신: ${time}`'
        )
        expect(english).toContain('risuBardMemoryForceUpdate: "Batch analysis"')
    })
})
