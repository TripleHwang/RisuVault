export type ContextRole = 'system' | 'user' | 'assistant' | 'tool'

export type ContextSourceKind =
    | 'static'
    | 'scene'
    | 'user-input'
    | 'memory'
    | 'recent'
    | 'tool'

export interface ContextBudget {
    maxContextTokens: number
    reservedResponseTokens: number
}

export interface ContextSource {
    id: string
    kind: ContextSourceKind
    role: ContextRole
    content: string
    tokens: number
    required?: boolean
    priority?: number
    occurredAt?: number
    displayName?: string
}

export interface ContextInput {
    budget: ContextBudget
    sources: ContextSource[]
}

export interface ContextMessage {
    sourceId: string
    role: ContextRole
    content: string
}

export interface ContextPacket {
    inputTokenLimit: number
    usedTokens: number
    messages: ContextMessage[]
    selectedSourceIds: string[]
    omittedSourceIds: string[]
    omittedSources: OmittedContextSource[]
}

export interface OmittedContextSource {
    sourceId: string
    tokens: number
    reason: 'budget'
}

export function compileContext(input: ContextInput): ContextPacket {
    if (!Number.isInteger(input.budget.maxContextTokens)
        || input.budget.maxContextTokens < 0) {
        throw new Error('maxContextTokens must be a non-negative integer')
    }
    if (!Number.isInteger(input.budget.reservedResponseTokens)
        || input.budget.reservedResponseTokens < 0) {
        throw new Error('reservedResponseTokens must be a non-negative integer')
    }
    if (input.budget.reservedResponseTokens > input.budget.maxContextTokens) {
        throw new Error('reservedResponseTokens cannot exceed maxContextTokens')
    }

    const sourceIds = new Set<string>()
    for (const source of input.sources) {
        if (source.id.trim().length === 0) {
            throw new Error('Context source IDs must not be empty')
        }
        if (sourceIds.has(source.id)) {
            throw new Error(`Context source IDs must be unique: ${source.id}`)
        }
        sourceIds.add(source.id)

        if (!Number.isInteger(source.tokens) || source.tokens < 0) {
            throw new Error(
                `Source ${source.id} tokens must be a non-negative integer`
            )
        }
    }

    const inputTokenLimit =
        input.budget.maxContextTokens - input.budget.reservedResponseTokens
    const selectedIndexes = new Set<number>()
    let usedTokens = 0

    input.sources.forEach((source, index) => {
        if (source.required) {
            selectedIndexes.add(index)
            usedTokens += source.tokens
        }
    })

    if (usedTokens > inputTokenLimit) {
        throw new Error(
            `Required context uses ${usedTokens} tokens but only ${inputTokenLimit} are available`
        )
    }

    const candidates = input.sources
        .map((source, index) => ({ source, index }))
        .filter(({ source }) => !source.required)
        .sort((left, right) =>
            (right.source.priority ?? 0) - (left.source.priority ?? 0)
            || (right.source.occurredAt ?? 0) - (left.source.occurredAt ?? 0)
            || left.index - right.index
        )

    for (const { source, index } of candidates) {
        if (usedTokens + source.tokens <= inputTokenLimit) {
            selectedIndexes.add(index)
            usedTokens += source.tokens
        }
    }

    const selectedSources = input.sources.filter((_, index) =>
        selectedIndexes.has(index)
    )
    const omittedSources = input.sources.filter((_, index) =>
        !selectedIndexes.has(index)
    )

    return {
        inputTokenLimit,
        usedTokens,
        messages: selectedSources.map((source) => ({
            sourceId: source.id,
            role: source.role,
            content: source.content,
        })),
        selectedSourceIds: selectedSources.map((source) => source.id),
        omittedSourceIds: omittedSources.map((source) => source.id),
        omittedSources: omittedSources.map((source) => ({
            sourceId: source.id,
            tokens: source.tokens,
            reason: 'budget',
        })),
    }
}
