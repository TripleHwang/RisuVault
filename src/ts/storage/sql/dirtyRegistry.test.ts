import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirtyRegistry } from './dirtyRegistry'

afterEach(() => {
    vi.useRealTimers()
})

describe('DirtyRegistry', () => {
    it('coalesces every scope into a deterministic snapshot', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())

        registry.markRoot('z')
        registry.markRoot('a')
        registry.markCharacter('character-z')
        registry.markCharacter('character-a')
        registry.markChat('character-b', 'chat-z')
        registry.markChat('character-a', 'chat-a')
        registry.markChat('character-a', 'chat-a')
        registry.markMessage('chat-z', 'message-z')
        registry.markMessage('chat-z', 'message-a')
        registry.markMessage('chat-z', 'message-a')
        registry.markMessageDeleted('chat-z', 'message-z')
        registry.markMessageDeleted('chat-z', 'message-a')
        registry.markPluginStorage('plugin-z')
        registry.markPluginStorage('plugin-a')
        registry.markPreset('preset-z')
        registry.markPreset('preset-a')

        expect(registry.takeSnapshot()).toEqual({
            rootKeys: ['a', 'z'],
            characterIds: ['character-a', 'character-z'],
            chats: [
                { characterId: 'character-a', chatId: 'chat-a' },
                { characterId: 'character-b', chatId: 'chat-z' },
            ],
            messages: [{ chatId: 'chat-z', messageIds: ['message-a', 'message-z'] }],
            messageDeletes: [{ chatId: 'chat-z', messageIds: ['message-a', 'message-z'] }],
            pluginStorageKeys: ['plugin-a', 'plugin-z'],
            presetIds: ['preset-a', 'preset-z'],
        })
    })

    it('does not acknowledge a scope re-marked while its snapshot is in flight', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())
        registry.markRoot('language')
        registry.markMessage('chat-a', 'message-a')
        const old = registry.takeSnapshot()

        registry.markRoot('language')
        registry.markMessage('chat-a', 'message-a')
        registry.acknowledge(old)

        expect(registry.takeSnapshot()).toMatchObject({
            rootKeys: ['language'],
            messages: [{ chatId: 'chat-a', messageIds: ['message-a'] }],
        })
    })

    it('acknowledges only values captured by a snapshot', () => {
        const registry = new DirtyRegistry(() => Promise.resolve())
        registry.markRoot('language')
        const old = registry.takeSnapshot()
        registry.markRoot('theme')

        registry.acknowledge(old)

        expect(registry.takeSnapshot().rootKeys).toEqual(['theme'])
    })

    it('uses one scheduled flush timer', async () => {
        vi.useFakeTimers()
        const flush = vi.fn().mockResolvedValue(undefined)
        const registry = new DirtyRegistry(flush)

        registry.markRoot('language')
        registry.schedule(300)
        registry.schedule(300)
        await vi.advanceTimersByTimeAsync(300)

        expect(flush).toHaveBeenCalledTimes(1)
    })

    it('dedupes concurrent flushes and clears a pending timer before flushing', async () => {
        vi.useFakeTimers()
        let resolveFlush: (() => void) | undefined
        const flush = vi.fn(() => new Promise<void>(resolve => { resolveFlush = resolve }))
        const registry = new DirtyRegistry(flush)
        registry.schedule(300)

        const first = registry.flushNow()
        const second = registry.flushNow()
        await Promise.resolve()
        expect(flush).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(300)
        expect(flush).toHaveBeenCalledOnce()

        resolveFlush?.()
        await expect(first).resolves.toBeUndefined()
        await expect(second).resolves.toBeUndefined()
    })

    it('runs one follow-up flush when a scheduled change arrives during an in-flight flush', async () => {
        vi.useFakeTimers()
        let resolveFirst: (() => void) | undefined
        const snapshots: ReturnType<DirtyRegistry['takeSnapshot']>[] = []
        let calls = 0
        let registry: DirtyRegistry
        const flush = vi.fn(() => {
            snapshots.push(registry.takeSnapshot())
            calls += 1
            return calls === 1
                ? new Promise<void>(resolve => { resolveFirst = resolve })
                : Promise.resolve()
        })
        registry = new DirtyRegistry(flush)
        registry.markRoot('language')
        registry.schedule(10)
        vi.advanceTimersByTime(10)
        await Promise.resolve()

        registry.markRoot('theme')
        registry.schedule(10)
        vi.advanceTimersByTime(10)
        expect(flush).toHaveBeenCalledOnce()

        resolveFirst?.()
        await Promise.resolve()
        registry.acknowledge(snapshots[0])
        await vi.advanceTimersByTimeAsync(0)

        expect(flush).toHaveBeenCalledTimes(2)
        expect(snapshots[1].rootKeys).toEqual(['theme'])
    })

    it('preserves the follow-up when a manual flush clears its pending timer', async () => {
        vi.useFakeTimers()
        let resolveFirst: (() => void) | undefined
        const snapshots: ReturnType<DirtyRegistry['takeSnapshot']>[] = []
        let calls = 0
        let registry: DirtyRegistry
        const flush = vi.fn(() => {
            snapshots.push(registry.takeSnapshot())
            calls += 1
            return calls === 1
                ? new Promise<void>(resolve => { resolveFirst = resolve })
                : Promise.resolve()
        })
        registry = new DirtyRegistry(flush)
        registry.markRoot('language')
        const first = registry.flushNow()
        await Promise.resolve()

        registry.markRoot('theme')
        registry.schedule(300)
        expect(registry.flushNow()).toBe(first)
        resolveFirst?.()
        await first
        registry.acknowledge(snapshots[0])
        await vi.advanceTimersByTimeAsync(0)

        expect(flush).toHaveBeenCalledTimes(2)
        expect(snapshots[1].rootKeys).toEqual(['theme'])
    })

    it('keeps dirty state after a rejected flush so a later scheduled retry can succeed', async () => {
        vi.useFakeTimers()
        const flush = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(undefined)
        const registry = new DirtyRegistry(flush)
        registry.markRoot('language')

        await expect(registry.flushNow()).rejects.toThrow('offline')
        expect(registry.takeSnapshot().rootKeys).toEqual(['language'])

        registry.schedule(20)
        await vi.advanceTimersByTimeAsync(20)
        expect(flush).toHaveBeenCalledTimes(2)
    })
})
