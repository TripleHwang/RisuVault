'use strict';

const fs = require('fs');

// Cross-device single-writer session lock.
//
// The app's data model allows exactly one writing client (the in-memory DB is
// synced coarsely — concurrent writers would silently clobber each other).
// This module decides WHICH session holds that write lock, replacing the old
// rule of "the last page load steals it", which produced spurious kicks: a
// phone tab resurrected by the OS (= a page load) would silently take the lock
// from a PC mid-session, and merely glancing at a second device would kick the
// one actually being used.
//
// Rules:
//  - register(id): called at page load. Records the session's boot time but
//    does NOT steal an active lock — opening the app must never kick the
//    device being used. Adopts the lock only when nobody holds it.
//  - checkWrite(id, userActive): called on every data write. The active
//    session passes and refreshes its lastWriteAt. A non-active session takes
//    over IFF BOTH hold:
//      · fresh — it booted AFTER the active session's last accepted write, so
//        its boot loaded the state including that write (cannot clobber), AND
//      · userActive — the client reports a recent user gesture. The app also
//        writes WITHOUT the user doing anything (boot housekeeping, the
//        flush-on-hide keepalive), and an automatic write must never move the
//        lock: a phone tab going to background fires a flush, and that used
//        to steal the lock from the PC actually in use.
//    Fresh but NOT user-active → the write passes WITHOUT taking over (it is
//    fresh, so applying it cannot clobber; rejecting it instead would set off
//    reload loops on boot-time auto-saves). lastWriteAt is not bumped — the
//    lock holder did not write.
//    Stale → rejected (423 → the client reloads; after the reload its boot is
//    recent, so its next user action takes over cleanly).
//  - Nobody holds the lock: every session that registered here already
//    adopted it (register() takes a free lock), so a writer that finds the
//    lock free is one this process never saw boot — it loaded its data before
//    the state below was written, and its copy is of unknown age. It is
//    rejected like a stale session: 423, reload, register, and its next user
//    action adopts on a copy loaded from the current data. The old rule let
//    ANY first write adopt, and the first write after a restart is usually an
//    automatic flush-on-hide from a background tab — the pre-restart tab with
//    the oldest copy became the writer of record over the device in use.
//
// Serial device switching (the single-user pattern) therefore never shows a
// block: you stop writing on A, open B (booted after A's last write), and B's
// first action takes the lock. A only ever sees a 423 if it writes again
// afterwards — the one genuinely necessary kick.
//
// State survives a server restart when `statePath` is given: the holder and
// the boot table are written to that file on every change and read back at
// startup. Without it, a restart would leave the lock free and the rule above
// would reject the ONLY device in use on its next write — and the reload that
// follows a 423 drops whatever it had not yet saved (the pending commit is
// what got rejected). With the file, the tab that was writing before the
// restart is still the holder afterwards and never notices; the other tabs
// are judged fresh/stale against the persisted lastWriteAt exactly as if the
// process had not restarted. Only a data root without the file (first run of
// this version, or the file removed by hand) starts with a free lock.
function createSessionLock(opts = {}) {
    const now = opts.now || Date.now;
    const statePath = typeof opts.statePath === 'string' && opts.statePath !== '' ? opts.statePath : null;
    const MAX_TRACKED_BOOTS = 50;

    let active = null; // { id, lastWriteAt } | null
    const boots = new Map(); // sessionId -> boot timestamp (insertion-ordered)

    function load() {
        if (!statePath) return;
        try {
            const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            if (Array.isArray(raw.boots)) {
                for (const entry of raw.boots) {
                    if (!Array.isArray(entry)) continue;
                    const [id, at] = entry;
                    if (typeof id === 'string' && id !== '' && Number.isFinite(at)) boots.set(id, at);
                }
            }
            const holder = raw.active;
            if (holder && typeof holder.id === 'string' && holder.id !== '' && Number.isFinite(holder.lastWriteAt)) {
                active = { id: holder.id, lastWriteAt: holder.lastWriteAt };
            }
        } catch { /* file missing or corrupt – start with a free lock */ }
    }

    function persist() {
        if (!statePath) return;
        // Temp file, then rename: a crash mid-write must not leave a torn
        // file, because `load` treats one as absent and that frees the lock —
        // every tab open across the restart would then be kicked once.
        const temp = `${statePath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify({ active, boots: [...boots] }));
            fs.renameSync(temp, statePath);
        }
        catch {
            try { fs.unlinkSync(temp); } catch { /* already gone */ }
            /* non-critical: the in-memory lock still guards this process */
        }
    }

    load();

    function register(id) {
        if (typeof id !== 'string' || id === '') return;
        // Delete-then-set refreshes insertion order so pruning drops the
        // longest-unseen sessions (bounded memory; single-user scale anyway).
        boots.delete(id);
        boots.set(id, now());
        if (boots.size > MAX_TRACKED_BOOTS) {
            boots.delete(boots.keys().next().value);
        }
        if (!active) {
            active = { id, lastWriteAt: now() };
        }
        // A re-register of the CURRENT active id (same-tab reload / OS tab
        // restore, with the client persisting its id) keeps the lock as-is.
        persist();
    }

    function checkWrite(id, userActive = false) {
        if (typeof id !== 'string' || id === '') {
            return { ok: true }; // client without session support
        }
        // Free lock ⇒ this session never registered here (see the header):
        // its copy predates everything this process knows. Never adopt it.
        if (!active) return { ok: false };
        if (active.id === id) {
            active.lastWriteAt = now();
            persist();
            return { ok: true };
        }
        const boot = boots.get(id);
        const fresh = boot !== undefined && boot > active.lastWriteAt;
        if (fresh && userActive) {
            active = { id, lastWriteAt: now() };
            persist();
            return { ok: true, tookOver: true };
        }
        if (fresh) {
            // Automatic write from a freshly-booted session: apply it, but the
            // lock stays where the user actually is.
            return { ok: true, passive: true };
        }
        return { ok: false };
    }

    function activeId() {
        return active ? active.id : null;
    }

    // Side-effect-free view for the client's reload-on-return check.
    // 'stale' is the only state that requires a reload: another session wrote
    // AFTER this one booted, so this one's in-memory copy is outdated.
    // 'fresh' needs nothing — the copy includes every accepted write, and the
    // next user action simply takes the lock over.
    function peek(id) {
        if (typeof id !== 'string' || id === '') return 'active';
        // Free lock ⇒ the tab predates this process (register() would have
        // adopted), so its copy may be older than the last write before the
        // restart. Reload now, while nothing is in progress, rather than at
        // its next write.
        if (!active) return 'stale';
        if (active.id === id) return 'active';
        const boot = boots.get(id);
        if (boot !== undefined && boot > active.lastWriteAt) return 'fresh';
        return 'stale';
    }

    return { register, checkWrite, peek, activeId };
}

module.exports = { createSessionLock };
