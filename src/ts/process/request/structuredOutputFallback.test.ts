import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { ModelPresetAdapterError } from 'src/ts/preset/adapter'
import type { AdapterChatOptions } from 'src/ts/preset/adapter'

const baseOptions = (): AdapterChatOptions => ({
    messages: [{ role: 'user', content: 'Return JSON.' }],
    responseSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
    },
})

async function loadFallbackModule() {
    const modulePath = './structuredOutputFallback'
    return import(/* @vite-ignore */ modulePath).catch(() => null)
}

describe('structured output compatibility fallback', () => {
    test('builds the same schema prompt for providers without native support', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return

        expect(module.createStructuredOutputFallbackMessage(
            baseOptions().responseSchema
        )).toMatchObject({
            role: 'system',
            content: expect.stringContaining('"value"'),
        })
    })

    test('retries one schema rejection as a prompt-schema request', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Invalid generation_config.response_schema'
            ))
            .mockResolvedValueOnce('ok')

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).resolves.toBe('ok')

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1][0].responseSchema).toBeUndefined()
        expect(send.mock.calls[1][0].messages[0]).toMatchObject({
            role: 'system',
        })
        expect(send.mock.calls[1][0].messages[0].content)
            .toContain('"value"')
    })

    test('retries an ambiguous 400 invalid argument when native schema was active', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Request contains an invalid argument.',
                { status: 400 }
            ))
            .mockResolvedValueOnce('ok')

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).resolves.toBe('ok')

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1][0].responseSchema).toBeUndefined()
    })

    test.each([
        new ModelPresetAdapterError('auth', 'missing key'),
        new ModelPresetAdapterError('rate-limit', 'slow down'),
        new ModelPresetAdapterError('invalid-request', 'blocked prompt'),
        new ModelPresetAdapterError(
            'invalid-request',
            'Invalid argument: contents[0].role is unsupported',
            { status: 400 }
        ),
    ])('does not downgrade unrelated errors: %s', async (error) => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn().mockRejectedValue(error)

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).rejects.toBe(error)
        expect(send).toHaveBeenCalledTimes(1)
    })

    test('does not retry a failed fallback a third time', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const fallbackError = new Error('bad JSON')
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'response_format json_schema unsupported'
            ))
            .mockRejectedValueOnce(fallbackError)

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).rejects.toBe(fallbackError)
        expect(send).toHaveBeenCalledTimes(2)
    })

    test('is wired only around the non-streaming ModelPreset send', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/request/request.ts'),
            'utf8'
        )
        expect(source).toContain("from './structuredOutputFallback'")
        expect(source).toContain('sendWithStructuredOutputFallback(')
        expect(source).toContain('createStructuredOutputFallbackMessage(')
    })

    test('keeps bound model preset reasoning settings for structured internal requests', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/request/request.ts'),
            'utf8'
        )

        expect(source).toContain('responseSchema: arg.schema')
        expect(source).not.toContain(
            "reasoningEffort: arg.schema ? 'minimal' : undefined"
        )
    })
})
