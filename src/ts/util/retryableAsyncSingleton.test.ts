import { describe, expect, it, vi } from 'vitest'
import { createRetryableAsyncSingleton } from './retryableAsyncSingleton'

describe('createRetryableAsyncSingleton', () => {
    it('shares one in-flight load across concurrent callers', async () => {
        let release: (() => void) | undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const loader = vi.fn(async () => {
            await gate
            return { ready: true }
        })
        const getValue = createRetryableAsyncSingleton(loader)
        const pending = Array.from({ length: 128 }, () => getValue())

        expect(loader).toHaveBeenCalledTimes(1)
        release?.()
        const values = await Promise.all(pending)

        expect(loader).toHaveBeenCalledTimes(1)
        expect(new Set(values).size).toBe(1)
    })

    it('allows retry after a failed load', async () => {
        const loader = vi.fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce({ ready: true })
        const getValue = createRetryableAsyncSingleton(loader)

        await expect(getValue()).rejects.toThrow('temporary failure')
        await expect(getValue()).resolves.toEqual({ ready: true })
        expect(loader).toHaveBeenCalledTimes(2)
    })
})
