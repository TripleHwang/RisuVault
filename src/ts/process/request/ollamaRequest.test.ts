import { describe, expect, test, vi } from 'vitest'
import { buildOllamaChatRequest, createOllamaFetch } from './ollamaRequest'

describe('legacy Ollama request construction', () => {
    test('passes structured non-streaming controls to Ollama', () => {
        const schema = {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        }

        expect(buildOllamaChatRequest({
            model: 'deepseek-r1:8b',
            messages: [{ role: 'user', content: '응답해 줘.' }],
            useStreaming: false,
            schema,
            temperature: 0.2,
            maxTokens: 4_096,
        })).toEqual({
            model: 'deepseek-r1:8b',
            messages: [{ role: 'user', content: '응답해 줘.' }],
            stream: false,
            format: schema,
            options: { temperature: 0.2, num_predict: 4_096 },
        })
    })

    test('keeps ordinary chat streaming without empty options', () => {
        expect(buildOllamaChatRequest({
            model: 'gemma3:12b',
            messages: [{ role: 'user', content: '계속해.' }],
            useStreaming: true,
        })).toEqual({
            model: 'gemma3:12b',
            messages: [{ role: 'user', content: '계속해.' }],
            stream: true,
        })
    })

    test('attaches the caller abort signal before Ollama opens the request', async () => {
        const controller = new AbortController()
        let receivedSignal: AbortSignal | null | undefined
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            receivedSignal = init?.signal
            return {} as Response
        })

        await createOllamaFetch(fetchImpl, controller.signal)('http://localhost', {})
        controller.abort()

        expect(receivedSignal?.aborted).toBe(true)
    })
})
