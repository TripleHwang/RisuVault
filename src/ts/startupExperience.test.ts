import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

describe('startup preloader handoff', () => {
    test('removes the static preloader once the app module runs, without waiting on an image', () => {
        const html = readFileSync('index.html', 'utf8')
        const main = readFileSync('src/main.ts', 'utf8')
        const app = readFileSync('src/App.svelte', 'utf8')

        expect(html).toContain('id="preloading"')
        expect(html).not.toContain('data-startup-logo')
        expect(app).not.toContain('data-startup-logo')
        expect(main).toContain('removeStartupPreloader')
        expect(main).not.toContain('decode()')
    })
})
