import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import pkg from './session-lock.cjs'

const { createSessionLock } = pkg as {
    createSessionLock: (opts?: { now?: () => number, statePath?: string }) => {
        register: (id: string) => void
        checkWrite: (id: string, userActive?: boolean) => { ok: boolean, tookOver?: boolean, passive?: boolean }
        activeId: () => string | null
        peek: (id: string) => 'active' | 'fresh' | 'stale'
    }
}

// Injected clock: each call advances 1ms so "booted after the last write"
// comparisons are deterministic without sleeping. `statePath` makes the lock
// persist, and a second createSessionLock on the same path is a "restart".
function makeLock(statePath?: string, start = 1000) {
    let t = start
    const lock = createSessionLock({ now: () => ++t, statePath })
    return { lock, tick: () => ++t, clock: () => t }
}

const tempDirs: string[] = []
function tempStatePath() {
    const dir = mkdtempSync(join(tmpdir(), 'risu-session-lock-'))
    tempDirs.push(dir)
    return join(dir, '__session_lock')
}
afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('session-lock', () => {
    it('a page load never steals an active lock (glance / OS tab restore)', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)   // pc is active and writing
        lock.register('phone')                        // phone merely opens the app
        expect(lock.activeId()).toBe('pc')            // pc keeps the lock
        expect(lock.checkWrite('pc').ok).toBe(true)   // and keeps writing untouched
    })

    it('adopts the first session when nobody holds the lock', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.activeId()).toBe('pc')
    })

    // This used to assert the opposite: "first write adopts even without a
    // registered boot (server restarted mid-session)". That rule was wrong.
    // A tab this process never saw boot loaded its data BEFORE the restart, so
    // its copy may predate writes another device made since; and the first
    // write after a restart is usually an automatic flush-on-hide from a
    // background tab, not a user action. Adopting it made the tab with the
    // oldest copy the writer of record, and its dirty commits then overwrote
    // rows the device actually in use had saved. Rejecting it costs one
    // reload, after which it registers and adopts on a current copy.
    it('a writer with no boot record (free lock, no persisted state) is rejected, not adopted', () => {
        const { lock } = makeLock()
        expect(lock.checkWrite('pc')).toEqual({ ok: false })       // automatic flush
        expect(lock.checkWrite('pc', true)).toEqual({ ok: false }) // a gesture cannot force it
        expect(lock.activeId()).toBeNull()
        lock.register('pc')                                        // the reload the 423 triggers
        expect(lock.checkWrite('pc')).toEqual({ ok: true })        // adopted at register, as always
        expect(lock.activeId()).toBe('pc')
    })

    // With a persisted lock a restart is invisible to the device in use: its
    // pending commit (the write that WOULD have been rejected under the rule
    // above, taking the unsaved edit with it on the reload) simply lands.
    it('the holder from before a restart keeps writing after it (persisted state)', () => {
        const statePath = tempStatePath()
        const before = makeLock(statePath)
        before.lock.register('pc')
        expect(before.lock.checkWrite('pc', true).ok).toBe(true)

        const after = makeLock(statePath, before.clock())   // restart: same file, later clock
        expect(after.lock.activeId()).toBe('pc')
        expect(after.lock.checkWrite('pc')).toEqual({ ok: true })       // the retry of a mid-restart commit
        expect(after.lock.checkWrite('pc', true)).toEqual({ ok: true }) // and the next user action
        expect(after.lock.peek('pc')).toBe('active')                    // no reload-on-return either
    })

    it('a restart keeps the fresh/stale verdict for the OTHER device (persisted boots)', () => {
        const statePath = tempStatePath()
        const before = makeLock(statePath)
        before.lock.register('phone')                          // phone booted...
        before.lock.register('pc')                             // ...then pc
        expect(before.lock.checkWrite('phone', true).ok).toBe(true) // phone wrote AFTER pc booted
        expect(before.lock.checkWrite('pc').ok).toBe(false)        // pc is stale already

        const after = makeLock(statePath, before.clock())
        expect(after.lock.checkWrite('pc')).toEqual({ ok: false })      // still stale, not adopted
        expect(after.lock.peek('pc')).toBe('stale')
        expect(after.lock.activeId()).toBe('phone')

        // And a tab that booted after phone's last write stays fresh across it.
        before.lock.register('tablet')
        const later = makeLock(statePath, before.clock())
        expect(later.lock.checkWrite('tablet')).toEqual({ ok: true, passive: true })
        expect(later.lock.checkWrite('tablet', true)).toEqual({ ok: true, tookOver: true })
    })

    it('a corrupt or missing state file starts with a free lock', () => {
        const statePath = tempStatePath()
        writeFileSync(statePath, '{not json')
        const { lock } = makeLock(statePath)
        expect(lock.activeId()).toBeNull()
        expect(lock.checkWrite('pc')).toEqual({ ok: false })
        lock.register('pc')
        expect(makeLock(statePath).lock.activeId()).toBe('pc')   // and persists once it has something
    })

    it('a freshly-booted session takes over on its first WRITE, then the old one is rejected', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)   // pc writes
        lock.register('phone')                        // phone boots AFTER that write → fresh
        const takeover = lock.checkWrite('phone', true) // phone's first USER action
        expect(takeover).toEqual({ ok: true, tookOver: true })
        expect(lock.activeId()).toBe('phone')
        expect(lock.checkWrite('pc').ok).toBe(false)  // pc is now the stale one → 423
    })

    it('a stale session (booted before the last write) is rejected, not taken over', () => {
        const { lock } = makeLock()
        lock.register('phone')                        // phone opened first…
        lock.register('pc')                           // …then pc opened
        expect(lock.checkWrite('phone').ok).toBe(true) // phone became active at its boot
        expect(lock.checkWrite('phone').ok).toBe(true) // and wrote AFTER pc booted
        expect(lock.checkWrite('pc').ok).toBe(false)   // pc's copy predates that write → stale
        expect(lock.activeId()).toBe('phone')
    })

    it('a rejected session recovers by re-booting (reload) and writing again', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('phone')
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone took over (user action)
        expect(lock.checkWrite('pc').ok).toBe(false)    // pc kicked → client reloads
        lock.register('pc')                             // reload = fresh boot
        expect(lock.checkWrite('pc', true)).toEqual({ ok: true, tookOver: true })
        expect(lock.activeId()).toBe('pc')
    })

    it('re-registering the ACTIVE id (same-tab reload with persisted id) keeps the lock quietly', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('pc')                            // OS restored the same tab
        expect(lock.activeId()).toBe('pc')
        expect(lock.checkWrite('pc')).toEqual({ ok: true }) // no takeover event, no kick anywhere
    })

    it('serial device alternation never rejects anyone', () => {
        const { lock } = makeLock()
        lock.register('a')
        expect(lock.checkWrite('a', true).ok).toBe(true)
        lock.register('b')
        expect(lock.checkWrite('b', true).ok).toBe(true)
        lock.register('a')
        expect(lock.checkWrite('a', true).ok).toBe(true)
        lock.register('b')
        expect(lock.checkWrite('b', true).ok).toBe(true)
    })

    it('clients without session support always pass', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('').ok).toBe(true)
        expect(lock.activeId()).toBe('pc')
    })

    // S1 regression (2026-07-28): phone backgrounding fires an automatic
    // flush/save with no user gesture — it must NOT move the lock, or the PC
    // actually in use gets kicked "for no reason".
    it('an automatic write from a fresh session passes WITHOUT taking over', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)      // pc writes
        lock.register('phone')                           // phone opened (fresh)
        const auto = lock.checkWrite('phone')            // background flush — no gesture
        expect(auto).toEqual({ ok: true, passive: true })
        expect(lock.activeId()).toBe('pc')               // lock did not move
        expect(lock.checkWrite('pc').ok).toBe(true)      // pc keeps working untouched
    })

    it('a passive pass does not refresh lastWriteAt (later user action still takes over)', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.checkWrite('pc').ok).toBe(true)
        lock.register('phone')
        expect(lock.checkWrite('phone').passive).toBe(true)     // auto write
        expect(lock.checkWrite('phone', true).tookOver).toBe(true) // then a real tap
        expect(lock.activeId()).toBe('phone')
    })

    it('a stale session is rejected even with a user gesture', () => {
        const { lock } = makeLock()
        lock.register('phone')
        lock.register('pc')
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone wrote after pc booted
        expect(lock.checkWrite('pc', true).ok).toBe(false)   // pc stale — gesture cannot force it
    })

    it('peek reports a tab as stale while the lock is free (it cannot have registered here)', () => {
        // Reload-on-return fires the moment the user comes back to a tab, so a
        // tab this process never saw reloads then -- before a write can be
        // rejected and eat the change it was carrying.
        const { lock } = makeLock()
        expect(lock.peek('pc')).toBe('stale')
        expect(lock.activeId()).toBeNull()               // peek never adopts
        lock.register('pc')
        expect(lock.peek('pc')).toBe('active')
    })

    // peek() drives the client's reload-on-return: reload ONLY when stale.
    it('peek reports active/fresh/stale without side effects', () => {
        const { lock } = makeLock()
        lock.register('pc')
        expect(lock.peek('pc')).toBe('active')
        expect(lock.checkWrite('pc').ok).toBe(true)     // pc writes
        lock.register('phone')                          // phone boots after → fresh
        expect(lock.peek('phone')).toBe('fresh')        // no reload needed on phone
        expect(lock.checkWrite('phone', true).ok).toBe(true) // phone takes over
        expect(lock.peek('pc')).toBe('stale')           // pc must reload on return
        // peek never mutates: repeated calls and ordering leave the lock alone
        expect(lock.peek('pc')).toBe('stale')
        expect(lock.activeId()).toBe('phone')
        expect(lock.peek('')).toBe('active')            // sessionless clients never reload
    })
})
