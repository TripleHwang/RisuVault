function jsonObjectCandidates(value: string): unknown[] {
    const candidates: unknown[] = []
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]
        if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '{') {
            if (depth === 0) start = index
            depth += 1
        }
        else if (character === '}' && depth > 0) {
            depth -= 1
            if (depth === 0 && start >= 0) {
                try {
                    const parsed = JSON.parse(value.slice(start, index + 1))
                    if (typeof parsed === 'object'
                        && parsed !== null
                        && !Array.isArray(parsed)) {
                        candidates.push(parsed)
                    }
                }
                catch {
                    // Ignore prose braces and continue looking for one object.
                }
                start = -1
            }
        }
    }
    return candidates
}

export function stripModelReasoning(value: string): string {
    let remaining = value
    while (true) {
        // Strip only leading provider wrappers, never tags quoted inside JSON
        // document content. An unfinished reasoning block has no final answer.
        const reasoning = remaining.match(
            /^\s*<(Thoughts|think)>[\s\S]*?(?:<\/\1>|$)/i
        )
        if (!reasoning) return remaining
        remaining = remaining.slice(reasoning[0].length)
    }
}

export function parseSingleJsonObject(value: string): unknown {
    if (typeof value !== 'string') {
        throw new Error('Model output must be a string')
    }
    const candidates = jsonObjectCandidates(
        stripModelReasoning(value)
    )
    if (candidates.length !== 1) {
        throw new Error('Model output must contain exactly one JSON object')
    }
    return candidates[0]
}

export function parseSingleJsonObjectMatching(
    value: string,
    matches: (candidate: Record<string, unknown>) => boolean
): unknown {
    if (typeof value !== 'string') {
        throw new Error('Model output must be a string')
    }
    const candidates = jsonObjectCandidates(stripModelReasoning(value))
    if (candidates.length === 1) return candidates[0]
    const matching = candidates.filter((candidate) =>
        matches(candidate as Record<string, unknown>)
    )
    if (matching.length !== 1) {
        throw new Error('Model output must contain exactly one JSON object')
    }
    return matching[0]
}

export function normalizeNarrativeBaseline(value: string): string {
    if (typeof value !== 'string') {
        throw new Error('Baseline output must be a string')
    }
    let normalized = stripModelReasoning(value).trim()
    const fenced = normalized.match(
        /^```(?:text|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i
    )
    if (fenced) normalized = fenced[1].trim()
    if (normalized.length === 0) {
        throw new Error('Baseline output is empty after normalization')
    }
    if (normalized.length > 12_000) {
        throw new Error('Baseline output exceeds 12000 characters')
    }
    return normalized
}
