import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8')

describe('App startup bundle boundaries', () => {
    it('loads the settings screen only when it is opened', () => {
        expect(source).not.toContain("import Settings from './lib/Setting/Settings.svelte'")
        expect(source).toContain("import('./lib/Setting/Settings.svelte')")
        expect(source).toContain('{#await loadSettings()}')
    })
})
