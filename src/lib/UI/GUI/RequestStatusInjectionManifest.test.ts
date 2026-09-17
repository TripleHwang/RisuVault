import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const toast = readFileSync(
    resolve(process.cwd(), 'src/lib/UI/GUI/RequestStatusToast.svelte'),
    'utf8',
)
const requestPipeline = readFileSync(
    resolve(process.cwd(), 'src/ts/process/request/request.ts'),
    'utf8',
)
const chatPipeline = readFileSync(
    resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
    'utf8',
)

describe('request status injection manifest', () => {
    test('renders named injection items, their token counts, and the input total', () => {
        expect(toast).toContain('entry.injectionManifest')
        expect(toast).toContain('injectionLabel(item)')
        expect(toast).toContain('item.tokens')
        expect(toast).toContain('injectionManifest.totalTokens')
        expect(toast).toContain('grimoireRequired:')
        expect(chatPipeline).toContain('lorebook.requestStatusKind')
    })

    test('renders the explicit request purpose instead of only the broad kind', () => {
        expect(toast).toContain('requestPurposeLabels[entry.purpose]')
        expect(requestPipeline).toContain('purpose: logPurpose')
    })

    test('offers an accessible close button that dismisses the current request card', () => {
        expect(toast).toContain('aria-label={rs?.close')
        expect(toast).toContain('onclick={dismiss}')
        expect(toast).toContain('clearStatus(id)')
        expect(toast).toContain('toast.dismiss(`req:${id}`)')
    })

    test('builds the manifest after preset normalization and strips private sources before adapter dispatch', () => {
        const normalizedAt = requestPipeline.indexOf('arg.formated = reformater')
        const manifestAt = requestPipeline.indexOf('buildInjectionManifest(')
        const stripAt = requestPipeline.indexOf('delete message.requestStatusSources', manifestAt)
        const adapterAt = requestPipeline.indexOf('const messages = tools', manifestAt)

        expect(normalizedAt).toBeGreaterThan(-1)
        expect(manifestAt).toBeGreaterThan(normalizedAt)
        expect(stripAt).toBeGreaterThan(manifestAt)
        expect(adapterAt).toBeGreaterThan(stripAt)
    })

    test('reconciles available provider usage without changing stream semantics', () => {
        expect(requestPipeline).toContain(
            'collectStreamUsage: getDatabase().requestLogStreamUsage === true'
        )
        expect(requestPipeline).toContain('inputTokens: lastUsage.promptTokens')
        expect(requestPipeline).toContain('inputTokens: response.usage.promptTokens')
    })

    test('persists the same manifest under the stable owning chat id', () => {
        expect(requestPipeline).toContain('sessionChatId: arg.realChatId')
        expect(requestPipeline).toContain('logScope.setInjectionManifest(requestStatusManifest)')
        expect(requestPipeline).toContain('reportStatus || requestLogEnabled()')
    })

    test('preserves selected BardWiki and narrative-memory source identities', () => {
        expect(chatPipeline).toContain("kind: source.id.includes(':wiki:') ? 'wiki' : 'memory'")
        expect(chatPipeline).toContain('name: narrativeSourceDisplayName(')
        expect(chatPipeline).toContain('source.displayName')
    })
})
