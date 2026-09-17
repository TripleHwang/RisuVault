import { afterAll, afterEach, vi } from 'vitest'

const nativeSetTimeout = globalThis.setTimeout

// Suppress warning
vi.mock(import('katex'), () => ({}))

vi.stubGlobal('safeStructuredClone', (v: unknown) => JSON.parse(JSON.stringify(v)))

// bits-ui intentionally restores dialog body-scroll locks on a 24 ms timer.
// Wait only after tests that actually held a lock, while happy-dom's document
// still exists, so the callback cannot escape into environment teardown.
afterEach(async () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const style = document.body?.style
  if (style?.overflow !== 'hidden' && style?.pointerEvents !== 'none') return
  await new Promise<void>((resolveWait) => window.setTimeout(resolveWait, 30))
})

afterAll(async () => {
    // bits-ui restores body scroll styles on a 24 ms timer after a dialog unmounts.
    // Keep the DOM environment alive until that shared cleanup has completed.
    await new Promise<void>((resolve) => nativeSetTimeout(resolve, 30))
})

// Keep unit tests hermetic. Individual tests can replace this with vi.stubGlobal().
//
// The loopback interface is exempt. The eight `*Live*` suites under `src/ts`
// start a real RisuAI-NodeOnly server on an ephemeral port and drive it over
// HTTP (`test/compat/helpers/client.ts`), which is the point of those suites:
// they measure the client's paging, preload and write-back against the real
// server rather than a stub of it. Every request they make is an absolute
// `http://127.0.0.1:<port>/...`, so only an ABSOLUTE URL whose host is a
// loopback address passes through to the native fetch. A relative path still
// gets the immediate rejection, even under happy-dom where `location` is a
// `localhost` origin -- resolving it and letting it through would turn a
// forgotten mock into a real socket attempt whose outcome depends on what
// happens to be listening on that port. Nothing off the loopback interface is
// reachable from any test.
//
// Those suites also run under `@vitest-environment node`, where `window` does
// not exist; the resolution below uses `location` only when there is one.
const nativeFetch = globalThis.fetch
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
        ? input
        : input instanceof URL
            ? input.href
            : input.url
    const absolute = URL.canParse(url) ? new URL(url) : null
    if (absolute && LOOPBACK_HOSTS.has(absolute.hostname)) {
        return nativeFetch(input, init)
    }
    const baseHref = typeof window !== 'undefined' && window.location?.href
        ? window.location.href
        : 'http://vitest.invalid/'
    const resolvedUrl = new URL(url, baseHref)
    return Promise.reject(new Error(`Unmocked network request in Vitest: ${resolvedUrl.href}`))
}) as typeof fetch
