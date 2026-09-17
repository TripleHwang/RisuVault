import type { AdapterError, AdapterErrorKind } from './types'
import { parseRetryAfterMs } from '../../../../packages/risubard-core/src/modelRetry'

export interface AdapterErrorOptions {
    status?: number
    /** The provider's own `Retry-After`, in milliseconds. */
    retryAfterMs?: number
    retryable?: boolean
    fallbackEligible?: boolean
    cause?: unknown
}

export class ModelPresetAdapterError extends Error {
    readonly kind: AdapterErrorKind
    readonly status?: number
    readonly retryAfterMs?: number
    readonly retryable: boolean
    readonly fallbackEligible: boolean

    constructor(kind: AdapterErrorKind, message: string, options: AdapterErrorOptions = {}) {
        super(message)
        this.name = 'ModelPresetAdapterError'
        this.kind = kind
        this.status = options.status
        this.retryAfterMs = options.retryAfterMs
        this.retryable = options.retryable ?? defaultRetryable(kind)
        this.fallbackEligible = options.fallbackEligible ?? defaultFallbackEligible(kind)
        if (options.cause !== undefined) {
            ;(this as Error & { cause?: unknown }).cause = options.cause
        }
    }

    toAdapterError(): AdapterError {
        return {
            kind: this.kind,
            message: this.message,
            status: this.status,
            retryAfterMs: this.retryAfterMs,
            retryable: this.retryable,
            fallbackEligible: this.fallbackEligible,
            cause: (this as Error & { cause?: unknown }).cause,
        }
    }
}

export function defaultRetryable(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'rate-limit':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

// Distinct from `retryable`: this is the policy for switching to a fallback
// ModelPreset (plan §9-8). 429/rate-limit can be retried in place but is
// not a fallback trigger by policy.
export function defaultFallbackEligible(kind: AdapterErrorKind): boolean {
    switch (kind) {
        case 'network':
        case 'timeout':
        case 'server':
        case 'parse':
            return true
        default:
            return false
    }
}

export function normalizeFetchError(err: unknown): ModelPresetAdapterError {
    if (err instanceof ModelPresetAdapterError) return err
    if (err instanceof Error) {
        if (err.name === 'AbortError') {
            return new ModelPresetAdapterError('aborted', err.message || 'Request aborted', {
                retryable: false,
                cause: err,
            })
        }
        return new ModelPresetAdapterError('network', err.message || 'Network error', {
            cause: err,
        })
    }
    return new ModelPresetAdapterError('unknown', String(err))
}

/**
 * Pulls the upstream provider message out of a gateway wrapper's
 * `metadata.raw`, or returns null when there is nothing to unwrap.
 */
function unwrapGatewayMessage(
    wrapper: { metadata?: { raw?: unknown } }
): string | null {
    const raw = wrapper.metadata?.raw
    if (typeof raw !== 'string') return null
    try {
        const inner = JSON.parse(raw) as { error?: { message?: unknown } }
        const message = inner?.error?.message
        if (typeof message === 'string' && message.trim()) return message
    } catch {
        // Not JSON — fall back to the wrapper's own message.
    }
    return null
}

/**
 * Best-effort error message extractor for vendor JSON error bodies. Handles
 * the common shapes:
 *  - `{ error: { message } }` — OpenAI-compatible, Anthropic Messages, Google AI Studio
 *  - `{ message }`            — bare-message responses
 *  - `{ error_description }`  — Google OAuth token endpoint (RFC 6749 §5.2)
 *  - `{ error }` (string)     — Google OAuth error code (e.g. "invalid_grant")
 *
 * Gateways that proxy other providers wrap the upstream failure and put their
 * own text in `error.message`, keeping the real reason in `error.metadata.raw`
 * (OpenRouter: `{"error":{"message":"Provider returned error","metadata":
 * {"raw":"{…}"}}}`). Returning the wrapper hides why the request failed and
 * defeats callers that match on the provider's wording — most notably
 * `isStructuredOutputSchemaRejection`, whose anchored regex targets Google's
 * exact "Request contains an invalid argument." That is why the unwrapped
 * message is returned on its own rather than appended to the wrapper.
 *
 * Returns the first match in priority order, or a truncated raw body if the
 * payload is not JSON, or `null` if JSON parsed but no known field matched.
 */
export function extractErrorMessage(bodyText: string): string | null {
    if (!bodyText) return null
    try {
        const parsed = JSON.parse(bodyText) as {
            error?: { message?: unknown } | unknown
            message?: unknown
            error_description?: unknown
        }
        if (
            typeof parsed?.error === 'object'
            && parsed.error !== null
            && typeof (parsed.error as { message?: unknown }).message === 'string'
        ) {
            const wrapper = parsed.error as {
                message: string
                metadata?: { raw?: unknown }
            }
            return unwrapGatewayMessage(wrapper) ?? wrapper.message
        }
        if (typeof parsed?.message === 'string') return parsed.message
        if (typeof parsed?.error_description === 'string') {
            // Google OAuth: include the error code alongside the description
            // when both are present, so the caller sees both `invalid_grant`
            // and the human-readable reason.
            if (typeof parsed.error === 'string') {
                return `${parsed.error}: ${parsed.error_description}`
            }
            return parsed.error_description
        }
        if (typeof parsed?.error === 'string') return parsed.error
    } catch {
        return bodyText.slice(0, 200)
    }
    return null
}

export function normalizeHttpStatus(
    status: number,
    message?: string,
    options: { retryAfterMs?: number } = {},
): ModelPresetAdapterError | null {
    // Retry-After is only meaningful for the statuses that mean "later" (429,
    // 503, 3xx); attaching it to a 401 would invite a pointless wait.
    const retry = { status, retryAfterMs: options.retryAfterMs }
    if (status >= 200 && status < 300) return null
    if (status === 401 || status === 403) {
        return new ModelPresetAdapterError('auth', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status === 404) {
        return new ModelPresetAdapterError('not-found', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status === 408) {
        return new ModelPresetAdapterError('timeout', message ?? `HTTP ${status}`, retry)
    }
    if (status === 429) {
        return new ModelPresetAdapterError('rate-limit', message ?? `HTTP ${status}`, retry)
    }
    if (status >= 400 && status < 500) {
        return new ModelPresetAdapterError('invalid-request', message ?? `HTTP ${status}`, {
            status,
            retryable: false,
        })
    }
    if (status >= 500 && status < 600) {
        return new ModelPresetAdapterError('server', message ?? `HTTP ${status}`, retry)
    }
    return new ModelPresetAdapterError('unknown', message ?? `HTTP ${status}`, { status })
}

/**
 * Turn a non-2xx provider `Response` into a classified adapter error, carrying
 * the real HTTP status and the provider's own `Retry-After` instead of leaving
 * both to be guessed at from the error prose further up. Shared by every
 * adapter so the three transports classify identically.
 */
export async function deriveHttpAdapterError(
    response: Response,
): Promise<ModelPresetAdapterError> {
    let bodyText = ''
    try {
        bodyText = await response.text()
    } catch {
        // ignore body read failures; status alone is enough to classify
    }
    const message = extractErrorMessage(bodyText) ?? `HTTP ${response.status}`
    const retryAfterMs = parseRetryAfterMs(
        response.headers?.get?.('retry-after'),
    )
    return normalizeHttpStatus(response.status, message, { retryAfterMs })
        ?? new ModelPresetAdapterError('unknown', message, {
            status: response.status,
            retryAfterMs,
        })
}
