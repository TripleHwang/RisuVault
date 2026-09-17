import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {} as any,
    globalFetch: vi.fn(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    globalFetch: mocks.globalFetch,
    fetchNative: vi.fn(),
    textifyReadableStream: vi.fn(),
}))
vi.mock('src/ts/model/modellist', () => ({
    LLMFlags: {},
    LLMFormat: {},
}))
vi.mock('src/ts/alert', () => ({ notifyError: vi.fn() }))
vi.mock('src/ts/tokenizer', () => ({ strongBan: [], tokenizeNum: vi.fn() }))
vi.mock('src/ts/model/openrouter', () => ({ getFreeOpenRouterModels: vi.fn() }))
vi.mock('src/ts/network/localNetwork', () => ({ isLocalNetworkUrl: vi.fn(() => false) }))
vi.mock('src/ts/util', () => ({ simplifySchema: vi.fn() }))
vi.mock('../../templates/jsonSchema', () => ({ extractJSON: vi.fn(), getOpenAIJSONSchema: vi.fn() }))
vi.mock('../../templates/chatTemplate', () => ({ applyChatTemplate: vi.fn() }))
vi.mock('../../files/inlays', () => ({ supportsInlayImage: vi.fn() }))
vi.mock('../../mcp/mcp', () => ({ callTool: vi.fn(), decodeToolCall: vi.fn(), encodeToolCall: vi.fn() }))

async function requestResponseBody(parameters: string[], reasoningEffort = 2, mode = 'model') {
    mocks.db.reasoningEffort = reasoningEffort
    const { requestOpenAIResponseAPI } = await import('./requests')
    await requestOpenAIResponseAPI({
        aiModel: 'gpt-5',
        formated: [{ role: 'user', content: 'Hello' }],
        maxTokens: 100,
        mode,
        modelInfo: {
            id: 'catalog-id',
            internalID: 'wire-model',
            parameters,
            flags: [],
        },
    } as any)
    return mocks.globalFetch.mock.calls[0][1].body
}

beforeEach(() => {
    vi.resetModules()
    mocks.db = {
        openAIKey: 'test-key',
        modelTools: [],
        localNetworkMode: false,
        seperateParametersEnabled: false,
        temperature: 90,
        top_p: 0.8,
        reasoningEffort: 2,
        verbosity: 2,
    }
    mocks.globalFetch.mockReset()
    mocks.globalFetch.mockResolvedValue({
        ok: true,
        data: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] },
    })
})

describe('requestOpenAIResponseAPI parameters', () => {
    test('sends only declared Responses fields and nests reasoning and verbosity', async () => {
        const body = await requestResponseBody([
            'temperature',
            'top_p',
            'reasoning_effort',
            'verbosity',
            'frequency_penalty',
            'presence_penalty',
        ])

        expect(body).toMatchObject({
            temperature: 0.9,
            top_p: 0.8,
            reasoning: { effort: 'high', summary: 'auto' },
            text: { verbosity: 'high' },
        })
        expect(body).not.toHaveProperty('frequency_penalty')
        expect(body).not.toHaveProperty('presence_penalty')
    })

    test.each([
        [['reasoning_effort'], -1, 'minimal'],
        [['reasoning_effort', 'reasoning_effort_none'], -1, 'none'],
        [['reasoning_effort', 'reasoning_effort_min_medium'], 0, 'medium'],
        [['reasoning_effort', 'reasoning_effort_xhigh'], 3, 'xhigh'],
        [['reasoning_effort'], 3, 'high'],
    ])('applies reasoning modifiers only with the base capability: %j', async (parameters, effort, expected) => {
        const body = await requestResponseBody(parameters, effort)

        expect(body.reasoning).toMatchObject({ effort: expected, summary: 'auto' })
        expect(body).not.toHaveProperty('reasoning_effort')
    })

    test.each([
        ['reasoning_effort_none'],
        ['reasoning_effort_min_medium'],
        ['reasoning_effort_xhigh'],
    ])('does not emit reasoning from modifier-only metadata: %s', async (modifier) => {
        const body = await requestResponseBody([modifier], -1)

        expect(body).not.toHaveProperty('reasoning')
    })

    test('does not leak undeclared fields into the Responses body', async () => {
        const body = await requestResponseBody(['verbosity', 'thinking_tokens', 'frequency_penalty'])

        expect(body.text).toEqual({ verbosity: 'high' })
        expect(body).not.toHaveProperty('temperature')
        expect(body).not.toHaveProperty('top_p')
        expect(body).not.toHaveProperty('reasoning')
        expect(body).not.toHaveProperty('thinking_tokens')
        expect(body).not.toHaveProperty('frequency_penalty')
    })

    test('uses auxiliary separate parameters for reasoning modifiers', async () => {
        mocks.db.seperateParametersEnabled = true
        mocks.db.seperateParametersByModel = false
        mocks.db.seperateParameters = {
            memory: { reasoning_effort: -1 },
        }

        const body = await requestResponseBody(['reasoning_effort', 'reasoning_effort_none'], 2, 'memory')

        expect(body.reasoning).toMatchObject({ effort: 'none', summary: 'auto' })
    })
})

describe('requestOpenAILegacyInstruct sampling validation', () => {
    test('omits invalid stored penalties without changing them', async () => {
        mocks.db.PresensePenalty = -1
        mocks.db.frequencyPenalty = 201
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { choices: [{ text: 'ok' }] } })
        const { requestOpenAILegacyInstruct } = await import('./requests')

        await requestOpenAILegacyInstruct({
            formated: [{ role: 'user', content: 'Hello' }],
            maxTokens: 100,
            temperature: 0.7,
        } as any)

        const body = mocks.globalFetch.mock.calls[0][1].body
        expect(body).not.toHaveProperty('presence_penalty')
        expect(body).not.toHaveProperty('frequency_penalty')
        expect(mocks.db.PresensePenalty).toBe(-1)
        expect(mocks.db.frequencyPenalty).toBe(201)
    })

    test('preserves an explicit zero penalty', async () => {
        mocks.db.PresensePenalty = 70
        mocks.db.frequencyPenalty = 70
        mocks.globalFetch.mockResolvedValue({ ok: true, data: { choices: [{ text: 'ok' }] } })
        const { requestOpenAILegacyInstruct } = await import('./requests')

        await requestOpenAILegacyInstruct({
            formated: [{ role: 'user', content: 'Hello' }],
            maxTokens: 100,
            temperature: 0.7,
            PresensePenalty: 0,
            frequencyPenalty: 0,
        } as any)

        expect(mocks.globalFetch.mock.calls[0][1].body).toMatchObject({
            presence_penalty: 0,
            frequency_penalty: 0,
        })
    })
})
