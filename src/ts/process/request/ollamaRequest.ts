export interface OllamaChatMessage {
    role: 'assistant' | 'user' | 'system'
    content: string
}

export interface OllamaChatRequestInput {
    model: string
    messages: OllamaChatMessage[]
    useStreaming: boolean
    schema?: string | object
    temperature?: number
    maxTokens?: number
}

export function createOllamaFetch(
    fetchImpl: typeof fetch,
    abortSignal?: AbortSignal,
): typeof fetch {
    if (!abortSignal) return fetchImpl
    return (input, init) => {
        const signal = init?.signal && init.signal !== abortSignal
            ? AbortSignal.any([init.signal, abortSignal])
            : abortSignal
        return fetchImpl(input, { ...init, signal })
    }
}

export function buildOllamaChatRequest(input: OllamaChatRequestInput) {
    let format = input.schema
    if (typeof format === 'string' && format.trim().startsWith('{')) {
        try {
            format = JSON.parse(format) as object
        }
        catch {
            // Ollama also accepts the literal "json" format and validates it.
        }
    }
    const options = {
        ...(input.temperature === undefined
            ? {}
            : { temperature: input.temperature }),
        ...(input.maxTokens === undefined
            ? {}
            : { num_predict: input.maxTokens }),
    }
    return {
        model: input.model,
        messages: input.messages,
        stream: input.useStreaming,
        ...(format === undefined ? {} : { format }),
        ...(Object.keys(options).length === 0 ? {} : { options }),
    }
}
