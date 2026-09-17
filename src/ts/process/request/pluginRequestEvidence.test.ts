import { describe, expect, it, vi } from 'vitest'
import {
    createPluginRequestEvidenceRecorder,
    formatPluginProviderFailure,
} from './pluginRequestEvidence'
import * as pluginRequestLifecycle from './pluginRequestEvidence'

describe('plugin request evidence recorder', () => {
    it('ends a plugin provider call that never settles when the host timeout expires', async () => {
        const run = (pluginRequestLifecycle as unknown as {
            runPluginProviderWithTimeout?: <T>(
                invoke: (signal: AbortSignal) => Promise<T>,
                timeoutMs: number,
                abortSignal?: AbortSignal | null,
            ) => Promise<T>
        }).runPluginProviderWithTimeout
        expect(run).toBeTypeOf('function')

        vi.useFakeTimers()
        try {
            let receivedSignal: AbortSignal | undefined
            const pending = run!(signal => {
                receivedSignal = signal
                return new Promise(() => {})
            }, 50)
            const rejected = expect(pending).rejects.toThrow(
                'Plugin provider request timed out after 50ms'
            )

            await vi.advanceTimersByTimeAsync(50)

            await rejected
            expect(receivedSignal?.aborted).toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })

    it('preserves a bounded Error message instead of serializing it as an empty object', () => {
        expect(formatPluginProviderFailure(
            'pagefold-gemini-3.7-flash',
            new Error('Upstream request timed out after 300000ms')
        )).toBe(
            'Plugin Error from pagefold-gemini-3.7-flash: Upstream request timed out after 300000ms'
        )
    })

    it('records body-free per-chat evidence with locally counted output tokens', async () => {
        const record = vi.fn()
        const recorder = createPluginRequestEvidenceRecorder({
            startedAt: 1_000,
            source: 'wiki-admin',
            purpose: 'bardwiki-admin',
            sessionChatId: 'chat-1',
            generationId: 'generation-1',
            model: 'pluginmodel:::gemini',
            provider: 'gemini',
            injectionManifest: {
                totalTokens: 31,
                estimated: true,
                items: [{ kind: 'wiki', tokens: 31 }],
            },
        }, {
            now: () => 1_250,
            countTokens: async (text) => text.length,
            record,
        })

        recorder.markFirstToken(1_100)
        await recorder.finish({ success: true, streaming: true, output: 'done' })

        expect(record).toHaveBeenCalledWith(expect.objectContaining({
            timestamp: 1_000,
            category: 'llm',
            source: 'wiki-admin',
            purpose: 'bardwiki-admin',
            sessionChatId: 'chat-1',
            generationId: 'generation-1',
            inputTokens: 31,
            outputTokens: 4,
            firstTokenMs: 100,
            durationMs: 250,
            success: true,
            streaming: true,
        }))
        expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('done')
    })
})
