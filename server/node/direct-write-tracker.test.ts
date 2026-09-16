import { describe, expect, it } from 'vitest'

let createDirectWriteTracker: any
try {
    ({ createDirectWriteTracker } = require('./direct-write-tracker.cjs'))
} catch {
    createDirectWriteTracker = undefined
}

describe('W1 direct-write tracker', () => {
    it('selects bot presets only when every coalesced operation stays in that collection', () => {
        expect(createDirectWriteTracker).toBeTypeOf('function')
        if (!createDirectWriteTracker) return

        const tracker = createDirectWriteTracker()
        tracker.observe('database', [{ op: 'replace', path: '/botPresets/0/name', value: 'Renamed' }])
        tracker.observe('database', [{ op: 'add', path: '/botPresets/1', value: { id: 'preset-2' } }])

        expect(tracker.take('database')).toBe('botPresets')
        expect(tracker.take('database')).toBeNull()
    })

    it('keeps the legacy full-sync lane for mixed, copied, or unrelated operations', () => {
        expect(createDirectWriteTracker).toBeTypeOf('function')
        if (!createDirectWriteTracker) return

        const tracker = createDirectWriteTracker()
        tracker.observe('mixed', [{ op: 'replace', path: '/botPresets/0/name', value: 'Renamed' }])
        tracker.observe('mixed', [{ op: 'replace', path: '/language', value: 'en' }])
        tracker.observe('copied', [{ op: 'copy', from: '/language', path: '/botPresets/0/name' }])
        tracker.observe('other', [{ op: 'replace', path: '/modules/0/name', value: 'Module' }])

        expect(tracker.take('mixed')).toBeNull()
        expect(tracker.take('copied')).toBeNull()
        expect(tracker.take('other')).toBeNull()
    })
})
