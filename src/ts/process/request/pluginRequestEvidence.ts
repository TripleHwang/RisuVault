import type {
    recordRequestLog,
    RequestLogSource,
} from 'src/ts/requestLog'
import type { RequestPurpose } from 'src/ts/requestPurpose'
import type { RequestInjectionManifest } from 'src/ts/status/requestStatus'
import { parseRetryAfterMs } from '../../../../packages/risubard-core/src/modelRetry'

interface PluginRequestEvidenceInput {
    startedAt: number
    source: RequestLogSource
    purpose?: RequestPurpose
    sessionChatId?: string
    generationId: string
    model: string
    provider: string
    injectionManifest?: RequestInjectionManifest
}

interface PluginRequestEvidenceFinish {
    success: boolean
    aborted?: boolean
    streaming: boolean
    output?: string
    errorMessage?: string
}

interface PluginRequestEvidenceDependencies {
    now?(): number
    countTokens(text: string): Promise<number>
    record(entry: Parameters<typeof recordRequestLog>[0]): void
}

export async function runPluginProviderWithTimeout<T>(
    invoke: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    abortSignal?: AbortSignal | null,
): Promise<T> {
    const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.max(1, Math.floor(timeoutMs))
        : 600_000
    const controller = new AbortController()
    const signal = abortSignal
        ? AbortSignal.any([abortSignal, controller.signal])
        : controller.signal

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            const error = new Error(
                `Plugin provider request timed out after ${boundedTimeoutMs}ms`
            )
            controller.abort(error)
            reject(error)
        }, boundedTimeoutMs)
    })
    try {
        return await Promise.race([
            Promise.resolve().then(() => invoke(signal)),
            timeoutPromise,
        ])
    } finally {
        if (timeout !== undefined) clearTimeout(timeout)
    }
}

export function formatPluginProviderFailure(
    provider: string,
    error: unknown,
): string {
    const raw = error instanceof Error ? error.message : String(error)
    const reason = raw.replace(/\s+/gu, ' ').trim().slice(0, 512)
        || 'Unknown plugin error'
    return `Plugin Error from ${provider}: ${reason}`
}

function readStatus(value: unknown): number | undefined {
    const status = typeof value === 'string' && /^\d{3}$/.test(value)
        ? Number(value)
        : value
    if (typeof status !== 'number' || !Number.isInteger(status)) return undefined
    return status >= 100 && status <= 599 ? status : undefined
}

/**
 * Recover an HTTP status (and any `Retry-After`) from a plugin provider's
 * thrown error.
 *
 * Plugin providers are third-party JavaScript: unlike the built-in adapters
 * there is no `Response` here to read a status off, only whatever the plugin
 * threw. So this reads the *structured* carriers first — `err.status`,
 * `err.statusCode`, `err.response.status`, `err.response.headers` — which is
 * what a plugin that wraps `fetch` or an SDK actually throws.
 *
 * The last resort is a string match, and it is deliberately narrow: the status
 * must be the very first token of the plugin's own message
 * (`429 Too Many Requests {...}`), which is the shape `Response.status` +
 * `statusText` produces. It will still not fire for a plugin that words its
 * message differently ("rate limit exceeded"), and it can misfire only if a
 * plugin begins an unrelated error message with a bare 4xx/5xx number. It is
 * never applied to model output — only to a thrown provider error.
 */
export function derivePluginFailureSignal(error: unknown): {
    status?: number
    retryAfterMs?: number
} {
    if (typeof error !== 'object' || error === null) return {}
    const value = error as {
        status?: unknown
        statusCode?: unknown
        retryAfterMs?: unknown
        response?: {
            status?: unknown
            headers?: { get?: (name: string) => string | null } | undefined
        }
        message?: unknown
    }
    const status = readStatus(value.status)
        ?? readStatus(value.statusCode)
        ?? readStatus(value.response?.status)
        ?? (typeof value.message === 'string'
            ? readStatus(/^\s*(?:HTTP\s*)?([45]\d{2})\b/u
                .exec(value.message)?.[1])
            : undefined)
    if (status === undefined) return {}
    let retryAfterMs: number | undefined
    if (typeof value.retryAfterMs === 'number'
        && Number.isFinite(value.retryAfterMs)
        && value.retryAfterMs >= 0) {
        retryAfterMs = value.retryAfterMs
    }
    else {
        try {
            retryAfterMs = parseRetryAfterMs(
                value.response?.headers?.get?.('retry-after')
            )
        }
        catch {
            // A hostile plugin's header bag must not break error reporting.
        }
    }
    return {
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
}

export function createPluginRequestEvidenceRecorder(
    input: PluginRequestEvidenceInput,
    dependencies: PluginRequestEvidenceDependencies,
) {
    const now = dependencies.now ?? (() => Date.now())
    const record = dependencies.record
    let firstTokenAt: number | undefined
    let finished = false
    return {
        markFirstToken(timestamp = now()) {
            firstTokenAt ??= timestamp
        },
        async finish(result: PluginRequestEvidenceFinish): Promise<void> {
            if (finished) return
            finished = true
            let outputTokens: number | undefined
            if (result.output) {
                try {
                    outputTokens = await dependencies.countTokens(result.output)
                } catch {
                    // Evidence collection must never affect the provider result.
                }
            }
            record({
                timestamp: input.startedAt,
                category: 'llm',
                source: input.source,
                purpose: input.purpose,
                chatId: input.generationId,
                sessionChatId: input.sessionChatId,
                generationId: input.generationId,
                model: input.model,
                provider: input.provider,
                url: `plugin://${encodeURIComponent(input.provider)}`,
                method: 'PLUGIN',
                success: result.success,
                aborted: result.aborted,
                streaming: result.streaming,
                durationMs: Math.max(0, now() - input.startedAt),
                ...(firstTokenAt === undefined ? {} : {
                    firstTokenMs: Math.max(0, firstTokenAt - input.startedAt),
                }),
                inputTokens: input.injectionManifest?.totalTokens,
                outputTokens,
                injectionManifest: input.injectionManifest,
                errorMessage: result.errorMessage,
            })
        },
    }
}
