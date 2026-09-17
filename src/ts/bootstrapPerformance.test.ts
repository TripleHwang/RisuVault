import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')

describe('bootstrap performance boundaries', () => {
    it('does not clone or retain the decoded database redundantly', () => {
        // Both the primary decode and the migration-backup decode hand their
        // database to `activateCanonicalDatabase`, whose single baseline call
        // takes the opened SQL database as-is; `setPatchSyncBaseline` clones
        // internally, so a caller-side clone would double the cost.
        expect(source).toContain('setPatchSyncBaseline(canonical.database)')
        expect(source).not.toContain('setPatchSyncBaseline(safeStructuredClone(')
        expect(source).not.toContain('console.log(decoded)')
    })

    it('keeps the default cleanup scan prefix-bounded', () => {
        expect(source).toContain("forageStorage.keys('remotes/')")
        expect(source).toContain("forageStorage.keys('assets/')")
        expect(source).toContain("forageStorage.keys('cache/plugin-storage/')")
        expect(source).not.toMatch(/forageStorage\.keys\(\s*\)/)
    })
})
