import { getDatabase } from 'src/ts/storage/database.svelte'

export type LLMParameter =
    | 'temperature'
    | 'top_k'
    | 'repetition_penalty'
    | 'min_p'
    | 'top_a'
    | 'top_p'
    | 'frequency_penalty'
    | 'presence_penalty'
    | 'reasoning_effort'
    | 'reasoning_effort_none'
    | 'reasoning_effort_min_medium'
    | 'reasoning_effort_xhigh'
    | 'thinking_tokens'
    | 'verbosity'

export type StoredSamplingParameter =
    | 'temperature'
    | 'top_k'
    | 'repetition_penalty'
    | 'min_p'
    | 'top_a'
    | 'top_p'
    | 'frequency_penalty'
    | 'presence_penalty'

export type ModelModeExtended = 'model' | 'submodel' | 'memory' | 'emotion' | 'otherAx' | 'translate'

export function isReasoningCapabilityParameter(parameter: LLMParameter): boolean {
    return parameter === 'reasoning_effort'
        || parameter === 'reasoning_effort_none'
        || parameter === 'reasoning_effort_min_medium'
        || parameter === 'reasoning_effort_xhigh'
}

export function resolveReasoningEffort(effort: number, parameters: readonly LLMParameter[]): string {
    if (effort === -1 && parameters.includes('reasoning_effort_none')) return 'none'
    if (effort === 0 && parameters.includes('reasoning_effort_min_medium')) return 'medium'
    if (effort === 3) return parameters.includes('reasoning_effort_xhigh') ? 'xhigh' : 'high'

    switch (effort) {
        case -1: return 'minimal'
        case 0: return 'low'
        case 1: return 'medium'
        case 2: return 'high'
        default: return 'medium'
    }
}

export function resolveStoredSamplingParameter(
    parameter: StoredSamplingParameter,
    value: number | undefined,
): number | undefined {
    if (value === undefined || value === -1000 || !Number.isFinite(value)) return undefined

    switch (parameter) {
        case 'temperature':
        case 'frequency_penalty':
        case 'presence_penalty':
            return resolveApiSamplingParameter(parameter, value / 100)
        default:
            return resolveApiSamplingParameter(parameter, value)
    }
}

export function resolveApiSamplingParameter(
    parameter: StoredSamplingParameter,
    value: number | undefined,
): number | undefined {
    if (value === undefined || !Number.isFinite(value)) return undefined

    switch (parameter) {
        case 'temperature':
        case 'frequency_penalty':
        case 'presence_penalty':
        case 'repetition_penalty':
            return value >= 0 && value <= 2 ? value : undefined
        case 'top_k':
            return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined
        case 'min_p':
        case 'top_a':
        case 'top_p':
            return value >= 0 && value <= 1 ? value : undefined
    }
}

export function resolveStoredTemperature(value: number | undefined): number | undefined {
    return resolveStoredSamplingParameter('temperature', value)
}

export function setObjectValue<T>(obj: T, key: string, value: any): T {
    const splitKey = key.split('.')
    if (splitKey.length > 1) {
        const firstKey = splitKey.shift()
        if (!obj[firstKey]) {
            obj[firstKey] = {}
        }
        obj[firstKey] = setObjectValue(obj[firstKey], splitKey.join('.'), value)
        return obj
    }

    obj[key] = value
    return obj
}

export function getAdditionalParameters(aiModel?: string): [string, string][] {
    const db = getDatabase()

    if (!aiModel) {
        return []
    }

    if (aiModel === 'reverse_proxy') {
        return [...(db.additionalParams ?? [])]
    }

    if (!aiModel.startsWith('xcustom:::')) {
        return []
    }

    const found = db.customModels.find((model) => model.id === aiModel)
    const params = found?.params
    if (!params) {
        return []
    }

    const additionalParams: [string, string][] = []
    for (const line of params.split('\n')) {
        const split = line.split('=')
        if (split.length >= 2) {
            additionalParams.push([split[0], split.slice(1).join('=')])
        }
    }

    return additionalParams
}

export function applyAdditionalParameters<T extends Record<string, any>>(
    body: T,
    headers: Record<string, string>,
    additionalParams: [string, string][],
): T {
    for (const [rawKey, rawValue] of additionalParams) {
        let key = rawKey
        let value = rawValue

        if (!key || !value) {
            continue
        }

        if (value === '{{none}}') {
            if (key.startsWith('header::')) {
                delete headers[key.replace('header::', '')]
            }
            else {
                delete body[key]
            }
            continue
        }

        if (key.startsWith('header::')) {
            headers[key.replace('header::', '')] = value
            continue
        }

        if (value.startsWith('json::')) {
            try {
                body = setObjectValue(body, key, JSON.parse(value.replace('json::', '')))
            }
            catch (error) {}
            continue
        }

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            body = setObjectValue(body, key, value.slice(1, -1))
            continue
        }

        if (value === 'true' || value === 'false') {
            body = setObjectValue(body, key, value === 'true')
            continue
        }

        if (value === 'null') {
            body = setObjectValue(body, key, null)
            continue
        }

        const num = Number(value)
        body = setObjectValue(body, key, isNaN(num) ? value : num)
    }

    return body
}

// Drain a streaming response to its final text. Every chunk on the
// requestDataResponse boundary carries the FULL accumulated text in its first
// key (deltas are folded upstream), so the last chunk holds the complete reply.
// Used by callers that requested a streaming wire request but want a single
// string result (trigger/Lua collectors, per-preset decoupled streaming).
export async function collectStreamingText(stream: ReadableStream<{ [key: string]: string }>): Promise<string> {
    const reader = stream.getReader()
    let lastChunk = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (value) {
                const firstKey = Object.keys(value)[0]
                if (firstKey) {
                    lastChunk = value[firstKey] ?? lastChunk
                }
            }
            if (done) {
                break
            }
        }
        return lastChunk
    } finally {
        reader.releaseLock()
    }
}

export function applyParameters(
    data: Record<string, any>,
    parameters: LLMParameter[],
    rename: Partial<Record<LLMParameter, string>>,
    modelMode: ModelModeExtended,
    arg: {
        ignoreTopKIfZero?: boolean
        modelId:string
        temperatureOverride?: number
    },
): Record<string, any> {
    const db = getDatabase()

    function applyRequestOverrides() {
        if (
            parameters.includes('temperature')
            && arg.temperatureOverride !== undefined
            && Number.isFinite(arg.temperatureOverride)
            && arg.temperatureOverride >= 0
        ) {
            data = setObjectValue(
                data,
                rename.temperature ?? 'temperature',
                arg.temperatureOverride,
            )
        }
        return data
    }

    function getVerbosity(verbosity: number) {
        switch (verbosity) {
            case 0: {
                return 'low'
            }
            case 1: {
                return 'medium'
            }
            case 2: {
                return 'high'
            }
            default: {
                return 'medium'
            }
        }
    }

    if (db.seperateParametersEnabled && (modelMode !== 'model' || db.seperateParametersByModel)) {
        let sepParams = db.seperateParameters[modelMode]
        if (db.seperateParametersByModel){
            sepParams = db.seperateParameters.overrides[arg.modelId]

            if(!sepParams){
                throw new Error(`No seperate parameters found for model ${arg.modelId} in model mode ${modelMode}. Please set parameters for this model`)
            }
        }
        if (modelMode === 'submodel') {
            sepParams = db.seperateParameters['otherAx']
        }

        for (const parameter of parameters) {
            let value: number | string | undefined = 0
            if (parameter !== 'reasoning_effort' && isReasoningCapabilityParameter(parameter)) continue
            if (parameter === 'top_k' && arg.ignoreTopKIfZero && sepParams[parameter] === 0) {
                continue
            }

            switch (parameter) {
                case 'temperature': {
                    value = resolveStoredTemperature(sepParams.temperature)
                    break
                }
                case 'top_k': {
                    value = resolveStoredSamplingParameter('top_k', sepParams.top_k)
                    break
                }
                case 'repetition_penalty': {
                    value = resolveStoredSamplingParameter('repetition_penalty', sepParams.repetition_penalty)
                    break
                }
                case 'min_p': {
                    value = resolveStoredSamplingParameter('min_p', sepParams.min_p)
                    break
                }
                case 'top_a': {
                    value = resolveStoredSamplingParameter('top_a', sepParams.top_a)
                    break
                }
                case 'top_p': {
                    value = resolveStoredSamplingParameter('top_p', sepParams.top_p)
                    break
                }
                case 'thinking_tokens': {
                    value = sepParams.thinking_tokens
                    break
                }
                case 'frequency_penalty': {
                    value = resolveStoredSamplingParameter('frequency_penalty', sepParams.frequency_penalty)
                    break
                }
                case 'presence_penalty': {
                    value = resolveStoredSamplingParameter('presence_penalty', sepParams.presence_penalty)
                    break
                }
                case 'reasoning_effort': {
                    value = resolveReasoningEffort(sepParams.reasoning_effort, parameters)
                    break
                }
                case 'verbosity': {
                    value = getVerbosity(sepParams.verbosity)
                    break
                }
            }

            if (
                value === -1000 ||
                value === undefined ||
                value === null ||
                (typeof value === 'number' && isNaN(value))
            ) {
                continue
            }

            data = setObjectValue(data, rename[parameter] ?? parameter, value)
        }
        return applyRequestOverrides()
    }

    for (const parameter of parameters) {
        let value: number | string | undefined = 0
        if (parameter !== 'reasoning_effort' && isReasoningCapabilityParameter(parameter)) continue
        if (parameter === 'top_k' && arg.ignoreTopKIfZero && db.top_k === 0) {
            continue
        }
        switch (parameter) {
            case 'temperature': {
                value = resolveStoredTemperature(db.temperature)
                break
            }
            case 'top_k': {
                value = resolveStoredSamplingParameter('top_k', db.top_k)
                break
            }
            case 'repetition_penalty': {
                value = resolveStoredSamplingParameter('repetition_penalty', db.repetition_penalty)
                break
            }
            case 'min_p': {
                value = resolveStoredSamplingParameter('min_p', db.min_p)
                break
            }
            case 'top_a': {
                value = resolveStoredSamplingParameter('top_a', db.top_a)
                break
            }
            case 'top_p': {
                value = resolveStoredSamplingParameter('top_p', db.top_p)
                break
            }
            case 'reasoning_effort': {
                value = resolveReasoningEffort(db.reasoningEffort, parameters)
                break
            }
            case 'verbosity': {
                value = getVerbosity(db.verbosity)
                break
            }
            case 'frequency_penalty': {
                value = resolveStoredSamplingParameter('frequency_penalty', db.frequencyPenalty)
                break
            }
            case 'presence_penalty': {
                value = resolveStoredSamplingParameter('presence_penalty', db.PresensePenalty)
                break
            }
            case 'thinking_tokens': {
                value = db.thinkingTokens
                break
            }
        }

        if (
            value === -1000 ||
            value === undefined ||
            value === null ||
            (typeof value === 'number' && isNaN(value))
        ) {
            continue
        }

        data = setObjectValue(data, rename[parameter] ?? parameter, value)
    }
    return applyRequestOverrides()
}
