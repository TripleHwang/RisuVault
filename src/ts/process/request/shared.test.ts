import { beforeEach, describe, expect, test, vi } from 'vitest'

// shared.ts imports getDatabase at module load; stub it so this pure-helper test
// stays off the big database import graph (mirrors modelPresetBinding.test.ts).
const mocks = vi.hoisted(() => ({ db: {} as any }))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
}))

import * as shared from './shared'

const { applyParameters, collectStreamingText } = shared

beforeEach(() => {
    mocks.db = {
        seperateParametersEnabled: false,
        reasoningEffort: 2,
    }
})

// collectStreamingText underpins per-preset decoupled streaming: the wire stays
// SSE, but the stream is drained to a single string. Every chunk carries the
// FULL accumulated text in its first key, so draining must return the LAST
// chunk's first-key value (not a concatenation of deltas).

function streamOf(chunks: Array<{ [key: string]: string }>): ReadableStream<{ [key: string]: string }> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        },
    })
}

describe('collectStreamingText', () => {
    test('returns the last chunk because chunks are cumulative, not deltas', async () => {
        const stream = streamOf([{ '0': 'He' }, { '0': 'Hello' }, { '0': 'Hello world' }])
        expect(await collectStreamingText(stream)).toBe('Hello world')
    })

    test('preserves a reasoning-prefixed final chunk verbatim', async () => {
        const final = '<Thoughts>\nthinking\n</Thoughts>\n\nanswer'
        const stream = streamOf([{ '0': '<Thoughts>' }, { '0': final }])
        expect(await collectStreamingText(stream)).toBe(final)
    })

    test('reads the first key only (multiGen sidecar indices are ignored)', async () => {
        const stream = streamOf([{ '0': 'main', '1': 'second' }])
        expect(await collectStreamingText(stream)).toBe('main')
    })

    test('returns empty string for an empty stream', async () => {
        const stream = streamOf([])
        expect(await collectStreamingText(stream)).toBe('')
    })

    test('releases its reader after completion', async () => {
        const stream = streamOf([{ '0': 'answer' }])
        await collectStreamingText(stream)
        expect(stream.locked).toBe(false)
    })

    test('releases its reader while preserving a transport error', async () => {
        const failure = new Error('connection lost')
        const stream = new ReadableStream<{ [key: string]: string }>({
            start(controller) { controller.error(failure) },
        })
        await expect(collectStreamingText(stream)).rejects.toBe(failure)
        expect(stream.locked).toBe(false)
    })
})

describe('applyParameters reasoning capability modifiers', () => {
    test.each([
        [['reasoning_effort'], -1, 'minimal'],
        [['reasoning_effort', 'reasoning_effort_none'], -1, 'none'],
        [['reasoning_effort', 'reasoning_effort_min_medium'], 0, 'medium'],
        [['reasoning_effort', 'reasoning_effort_xhigh'], 3, 'xhigh'],
        [['reasoning_effort'], 3, 'high'],
    ])('uses %j to resolve effort %i as %s', (parameters, effort, expected) => {
        mocks.db.reasoningEffort = effort

        expect(applyParameters({}, parameters as any, {}, 'model', { modelId: 'model' }))
            .toMatchObject({ reasoning_effort: expected })
    })
})

describe('applyParameters request overrides', () => {
    test('prefers an explicit request temperature over the global model temperature', () => {
        mocks.db.temperature = 115

        expect(applyParameters(
            {},
            ['temperature'] as any,
            {},
            'model',
            { modelId: 'pluginmodel:::pagefold-gemini-3.7-flash', temperatureOverride: 0 },
        )).toMatchObject({ temperature: 0 })
    })

    test('does not reintroduce a disabled temperature through a negative override', () => {
        mocks.db.temperature = -1000

        expect(applyParameters(
            {},
            ['temperature'] as any,
            {},
            'model',
            { modelId: 'legacy-provider', temperatureOverride: -10 },
        )).not.toHaveProperty('temperature')
    })
})

describe('stored temperature conversion', () => {
    test('maps the disabled sentinel to undefined and hundredths to API units', () => {
        const resolveStoredTemperature = (shared as any).resolveStoredTemperature
        expect(resolveStoredTemperature).toBeTypeOf('function')
        expect(resolveStoredTemperature(-1000)).toBeUndefined()
        expect(resolveStoredTemperature(-1)).toBeUndefined()
        expect(resolveStoredTemperature(201)).toBeUndefined()
        expect(resolveStoredTemperature(100)).toBe(1)
        expect(resolveStoredTemperature(1)).toBe(0.01)
    })
})

describe('stored sampling parameter validation', () => {
    test('keeps valid values, including a temperature of 0.01 API units', () => {
        const resolve = (shared as any).resolveStoredSamplingParameter
        expect(resolve).toBeTypeOf('function')
        expect(resolve('temperature', 1)).toBe(0.01)
        expect(resolve('top_k', 40)).toBe(40)
        expect(resolve('top_p', 0.95)).toBe(0.95)
        expect(resolve('presence_penalty', 125)).toBe(1.25)
    })

    test('validates already-normalized request values without rescaling them', () => {
        const resolveApi = (shared as any).resolveApiSamplingParameter
        expect(resolveApi).toBeTypeOf('function')
        expect(resolveApi('temperature', 0.01)).toBe(0.01)
        expect(resolveApi('presence_penalty', 0)).toBe(0)
        expect(resolveApi('temperature', 2.01)).toBeUndefined()
    })

    test.each([
        ['temperature', 201],
        ['top_k', 101],
        ['top_k', 1.5],
        ['top_p', 1.01],
        ['min_p', -0.01],
        ['top_a', Number.NaN],
        ['repetition_penalty', 2.01],
        ['frequency_penalty', 201],
        ['presence_penalty', -1],
    ])('omits invalid %s value %s', (parameter, value) => {
        expect((shared as any).resolveStoredSamplingParameter(parameter, value)).toBeUndefined()
    })

    test('applyParameters omits invalid values without changing the database', () => {
        Object.assign(mocks.db, {
            temperature: 201,
            top_k: 101,
            top_p: 1.01,
            min_p: -0.01,
            top_a: Number.NaN,
            repetition_penalty: 2.01,
            frequencyPenalty: 201,
            PresensePenalty: -1,
        })
        const before = { ...mocks.db }

        const result = applyParameters({}, [
            'temperature', 'top_k', 'top_p', 'min_p', 'top_a',
            'repetition_penalty', 'frequency_penalty', 'presence_penalty',
        ] as any, {}, 'model', { modelId: 'model' })

        expect(result).toEqual({})
        expect(mocks.db).toEqual(before)
    })
})
