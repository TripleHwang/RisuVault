import { PAGEFOLD_PROVIDER_NAME } from '../../builtin/pagefold'
import { buildPageFoldPresetRoute, getPageFoldPresetSupport } from '../../builtin/pageFoldPresetRoute'
import { safeStructuredClone } from '../../polyfill'
import { pluginV2, type PluginV2ProviderArgument } from '../../plugins/plugins.svelte'
import type { AdapterCredential } from '../../preset/adapter'
import type { ModelPreset } from '../../preset/types'
import type { OpenAIChat } from '../index.svelte'
import { convertInterfaceToSchema } from '../templates/jsonSchema'
import type { ModelModeExtended } from './shared'
import { createStructuredOutputFallbackMessage } from './structuredOutputFallback'

export interface PageFoldRequestArgument {
    formated: OpenAIChat[]
    schema?: string
    maxTokens?: number
    temperature?: number
}

export type PageFoldRequestResult = {
    type: 'success' | 'fail'
    result: string
    model?: string
    noRetry?: boolean
}

function getNestedPresetValue(value: unknown, path: string): unknown {
    let current = value
    for (const part of path.split('.')) {
        if (!current || typeof current !== 'object') return undefined
        current = (current as Record<string, unknown>)[part]
    }
    return current
}

function resolvePageFoldPresetNumber(
    preset: ModelPreset,
    paths: string[],
    fallback: number,
): number {
    const values = preset.userValues ?? {}
    for (const field of preset.profileSnapshot.schema ?? []) {
        const path = field.mapsTo?.target === 'body' ? field.mapsTo.path : field.key
        if (!paths.some(candidate => path === candidate || path.endsWith(`.${candidate}`))) continue
        const raw = values[field.key] ?? field.default
        const numeric = Number(raw)
        if (Number.isFinite(numeric)) return numeric
    }
    for (const path of paths) {
        const raw = getNestedPresetValue(values, path)
            ?? getNestedPresetValue(preset.profileSnapshot.defaults, path)
        const numeric = Number(raw)
        if (Number.isFinite(numeric)) return numeric
    }
    return fallback
}

async function collectPageFoldText(content: string | ReadableStream<string>): Promise<string> {
    if (typeof content === 'string') return content
    const reader = content.getReader()
    let result = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) return result
        result += value ?? ''
    }
}

export async function requestPageFoldPreset(
    arg: PageFoldRequestArgument,
    preset: ModelPreset,
    mode: ModelModeExtended,
    abortSignal: AbortSignal | null,
    credential: AdapterCredential | undefined,
    presetMaxOutputTokens?: number,
): Promise<PageFoldRequestResult> {
    const support = getPageFoldPresetSupport(preset)
    if (!support.supported) {
        return {
            type: 'fail',
            result: support.reason ?? 'This model preset is not compatible with PageFold.',
            model: preset.name,
            noRetry: true,
        }
    }
    const provider = pluginV2.builtInProviders.get(PAGEFOLD_PROVIDER_NAME)
    if (!provider) {
        return {
            type: 'fail',
            result: 'PageFold is still loading. Restart RisuVault and try again.',
            model: preset.name,
            noRetry: true,
        }
    }

    let promptChat = safeStructuredClone(arg.formated)
    if (arg.schema) {
        const schemaMessage = createStructuredOutputFallbackMessage(
            convertInterfaceToSchema(arg.schema)
        )
        if (!schemaMessage) {
            return {
                type: 'fail',
                result: 'Structured output schema is too large for PageFold.',
                model: preset.name,
                noRetry: true,
            }
        }
        const schemaContent = typeof schemaMessage.content === 'string'
            ? schemaMessage.content
            : JSON.stringify(schemaMessage.content)
        promptChat = promptChat[0]?.role === 'system'
            ? [{ ...promptChat[0], content: `${schemaContent}\n\n${promptChat[0].content}` }, ...promptChat.slice(1)]
            : [{ role: 'system', content: schemaContent }, ...promptChat]
    }

    let pagefoldRoute: Awaited<ReturnType<typeof buildPageFoldPresetRoute>>
    try {
        pagefoldRoute = await buildPageFoldPresetRoute(preset, credential, abortSignal ?? undefined)
    } catch (error) {
        return {
            type: 'fail',
            result: error instanceof Error ? error.message : String(error),
            model: preset.name,
            noRetry: true,
        }
    }

    const providerArg: PluginV2ProviderArgument = {
        prompt_chat: promptChat,
        mode,
        max_tokens: presetMaxOutputTokens ?? arg.maxTokens ?? 4096,
        temperature: resolvePageFoldPresetNumber(preset, ['temperature'], arg.temperature ?? 0),
        top_p: resolvePageFoldPresetNumber(preset, ['top_p', 'topP'], 0.95),
        top_k: resolvePageFoldPresetNumber(preset, ['top_k', 'topK'], 40),
        frequency_penalty: resolvePageFoldPresetNumber(preset, ['frequency_penalty', 'frequencyPenalty'], 0),
        presence_penalty: resolvePageFoldPresetNumber(preset, ['presence_penalty', 'presencePenalty'], 0),
        repetition_penalty: resolvePageFoldPresetNumber(preset, ['repetition_penalty', 'repetitionPenalty'], 0),
        min_p: resolvePageFoldPresetNumber(preset, ['min_p', 'minP'], 0),
        // The schema went in as a prompt fallback, so the model answers with
        // JSON text. PageFold rewrites "\n" escapes in plain-text answers into
        // real line breaks; that would put raw control characters inside the
        // JSON strings and the strict parser upstream rejects them. Flagging
        // structured output keeps the answer verbatim, as request.ts does for
        // every other plugin provider.
        structured_output: Boolean(arg.schema),
        pagefold_route: pagefoldRoute,
    }
    const response = await provider(providerArg, abortSignal ?? undefined)
    if (!response) return { type: 'fail', result: 'PageFold returned no response.', model: preset.name }
    const content = await collectPageFoldText(response.content)
    return response.success
        ? { type: 'success', result: content, model: preset.name }
        : { type: 'fail', result: content || 'PageFold request failed.', model: preset.name }
}
