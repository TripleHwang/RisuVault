import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..', '..', '..')
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8')

describe('system dashboard orphan cleanup surface', () => {
    it('offers one confirmed and loading-safe cleanup action for every orphan category', () => {
        const dashboard = read('src/lib/Setting/Pages/SystemDashboard.svelte')
        const korean = read('src/lang/ko.ts')
        const english = read('src/lang/en.ts')

        expect(dashboard).toContain('async function cleanupAllOrphans()')
        expect(dashboard).toContain("fetch('/api/db/orphans/cleanup'")
        expect(dashboard).toContain('language.storageOrphanCleanupConfirm')
        expect(dashboard).toContain('language.storageOrphanCleanupMedia')
        expect(dashboard).toContain('language.storageOrphanCleanupHypa')
        expect(dashboard).toContain('language.storageOrphanCleanupObjects')
        expect(dashboard).toContain('disabled={orphanCleanupOpen || !hasCleanupCandidates}')
        expect(dashboard).toContain('aria-live="polite"')
        expect(dashboard).not.toContain('stats.storage.reclaimable < 50 * 1024 * 1024')

        for (const source of [korean, english]) {
            expect(source).toContain('storageOrphanCleanupAll:')
            expect(source).toContain('storageOrphanCleanupDone:')
        }
    })
})
