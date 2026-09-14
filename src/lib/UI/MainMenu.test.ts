import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(),
    'src/lib/UI/MainMenu.svelte',
), 'utf8')

describe('home screen brand', () => {
    it('shows the RisuBard name and current app version at the top', () => {
        expect(source).toContain("import { nodeOnlyVer } from '../../ts/storage/database.svelte'")
        expect(source).toContain('data-home-brand')
        expect(source).toContain('>RisuVault</span>')
        expect(source).toContain('v{nodeOnlyVer}')
    })
})
