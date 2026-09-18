import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/ts/plugins/plugins.svelte', () => ({
    pluginV2: { providers: new Map(), builtInProviders: new Map() },
}))
vi.mock('../templates/jsonSchema', () => ({
    convertInterfaceToSchema: (value: string) => JSON.parse(value),
}))

import { PAGEFOLD_PROVIDER_NAME } from 'src/ts/builtin/pagefold'
import { pluginV2, type PluginV2ProviderArgument } from 'src/ts/plugins/plugins.svelte'
import type { ModelPreset } from 'src/ts/preset/types'
import { requestPageFoldPreset, type PageFoldRequestArgument } from './pageFoldPreset'

function preset(): ModelPreset {
    return {
        id: 'preset-pagefold',
        name: 'PageFold preset',
        profileSnapshot: {
            profileId: 'test',
            profileVersion: 1,
            providerBaseId: 'google',
            providerBaseVersion: 1,
            adapterKind: 'google-gemini',
            auth: { kind: 'x-goog-api-key' },
            endpoint: { kind: 'static', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
            modelId: 'gemini-test',
            schema: [
                { key: 'apiKey', type: 'string', label: 'API key', mapsTo: { target: 'auth', path: 'apiKey' } },
                { key: 'temperature', type: 'number', label: 'Temperature', mapsTo: { target: 'body', path: 'generationConfig.temperature' } },
                { key: 'topP', type: 'number', label: 'Top P', mapsTo: { target: 'body', path: 'generationConfig.topP' } },
                { key: 'topK', type: 'number', label: 'Top K', mapsTo: { target: 'body', path: 'generationConfig.topK' } },
                { key: 'maxOutputTokens', type: 'integer', label: 'Max output', mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
        },
        userValues: {
            apiKey: 'preset-google-key',
            temperature: 0.7,
            topP: 0.8,
            topK: 24,
            maxOutputTokens: 2048,
        },
        usePageFold: true,
        createdAt: 1,
        updatedAt: 1,
    }
}

function requestArg(): PageFoldRequestArgument {
    return {
        formated: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'hello' },
        ],
        temperature: 0.1,
        maxTokens: 128,
    }
}

afterEach(() => {
    pluginV2.providers.delete(PAGEFOLD_PROVIDER_NAME)
    pluginV2.builtInProviders.delete(PAGEFOLD_PROVIDER_NAME)
})

describe('ModelPreset PageFold dispatch', () => {
    test.each(['model', 'submodel', 'memory', 'emotion', 'translate', 'otherAx'] as const)(
        'passes the %s output mode and preset parameters to PageFold',
        async (mode) => {
            let received: PluginV2ProviderArgument | undefined
            pluginV2.builtInProviders.set(PAGEFOLD_PROVIDER_NAME, vi.fn(async (arg) => {
                received = arg
                return { success: true, content: `${mode}-ok` }
            }))

            const sourceArg = requestArg()
            const result = await requestPageFoldPreset(sourceArg, preset(), mode, null, { apiKey: 'preset-google-key' }, 2048)

            expect(result).toMatchObject({ type: 'success', result: `${mode}-ok` })
            expect(received).toMatchObject({
                mode,
                max_tokens: 2048,
                temperature: 0.7,
                top_p: 0.8,
                top_k: 24,
            })
            expect(received?.prompt_chat).toEqual(sourceArg.formated)
            expect(received?.prompt_chat).not.toBe(sourceArg.formated)
            expect(received?.pagefold_route).toEqual({
                activeProvider: 'google',
                route: {
                    apiKey: 'preset-google-key',
                    model: 'gemini-test',
                    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                },
            })
        }
    )

    test('flags structured output when a schema is injected as a prompt fallback', async () => {
        // PageFold rewrites "\n" escapes in plain-text answers into real line
        // breaks; a schema answer must stay verbatim or JSON.parse rejects it.
        let received: PluginV2ProviderArgument | undefined
        pluginV2.builtInProviders.set(PAGEFOLD_PROVIDER_NAME, vi.fn(async (arg) => {
            received = arg
            return { success: true, content: '{"summary":"a\\nb"}' }
        }))

        const schema = JSON.stringify({ type: 'object', properties: { summary: { type: 'string' } } })
        await requestPageFoldPreset({ ...requestArg(), schema }, preset(), 'memory', null, { apiKey: 'preset-google-key' }, 2048)
        expect(received?.structured_output).toBe(true)
        expect(received?.prompt_chat[0]?.content).toContain('summary')

        await requestPageFoldPreset(requestArg(), preset(), 'model', null, { apiKey: 'preset-google-key' }, 2048)
        expect(received?.structured_output).toBe(false)
    })

    test('collects a text stream returned by the provider', async () => {
        pluginV2.builtInProviders.set(PAGEFOLD_PROVIDER_NAME, vi.fn(async () => ({
            success: true,
            content: new ReadableStream<string>({
                start(controller) {
                    controller.enqueue('hello ')
                    controller.enqueue('world')
                    controller.close()
                },
            }),
        })))

        await expect(requestPageFoldPreset(requestArg(), preset(), 'model', null, { apiKey: 'preset-google-key' }, 2048))
            .resolves.toMatchObject({ type: 'success', result: 'hello world' })
    })

    test('fails without retry while the built-in provider is unavailable', async () => {
        await expect(requestPageFoldPreset(requestArg(), preset(), 'model', null, { apiKey: 'preset-google-key' }, 2048))
            .resolves.toMatchObject({ type: 'fail', noRetry: true })
    })
})
