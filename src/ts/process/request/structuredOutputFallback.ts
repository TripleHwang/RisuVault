import {
    ModelPresetAdapterError,
    type AdapterChatOptions,
} from 'src/ts/preset/adapter'

const SCHEMA_ERROR_MARKERS = [
    'schema',
    'response_format',
    'response format',
    'responseformat',
    'structured output',
    'structured-output',
    'responsemime',
    'response mime',
]

const MAX_FALLBACK_SCHEMA_CHARACTERS = 32_000
const AMBIGUOUS_INVALID_ARGUMENT = /^(?:request contains an )?invalid[_ ]argument\.?$/i

export function createStructuredOutputFallbackMessage(
    responseSchema: Record<string, unknown> | undefined
): AdapterChatOptions['messages'][number] | null {
    if (!responseSchema) return null
    const serializedSchema = JSON.stringify(responseSchema)
    if (serializedSchema.length > MAX_FALLBACK_SCHEMA_CHARACTERS) return null
    return {
        role: 'system',
        content: [
            'Return exactly one JSON value matching this JSON Schema.',
            'Do not return Markdown, code fences, or commentary.',
            serializedSchema,
        ].join('\n'),
    }
}

export function isStructuredOutputSchemaRejection(error: unknown): boolean {
    if (!(error instanceof ModelPresetAdapterError)
        || error.kind !== 'invalid-request') {
        return false
    }
    const message = error.message.toLowerCase()
    return SCHEMA_ERROR_MARKERS.some((marker) => message.includes(marker))
        || (error.status === 400 && AMBIGUOUS_INVALID_ARGUMENT.test(message))
}

export async function sendWithStructuredOutputFallback<T>(
    options: AdapterChatOptions,
    send: (request: AdapterChatOptions) => Promise<T>,
    onFallback?: (error: ModelPresetAdapterError) => void
): Promise<T> {
    try {
        return await send(options)
    }
    catch (error) {
        if (!options.responseSchema
            || !isStructuredOutputSchemaRejection(error)) {
            throw error
        }
        const fallbackMessage = createStructuredOutputFallbackMessage(
            options.responseSchema
        )
        if (!fallbackMessage) throw error
        onFallback?.(error as ModelPresetAdapterError)
        return send({
            ...options,
            responseSchema: undefined,
            messages: [fallbackMessage, ...options.messages],
        })
    }
}
