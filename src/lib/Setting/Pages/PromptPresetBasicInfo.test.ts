import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const componentPath = resolve(
    process.cwd(),
    'src/lib/Setting/Pages/PromptPreset/PromptPresetBasicInfo.svelte'
)

describe('PromptPresetBasicInfo', () => {
    test('uses a compact basic-info layout', () => {
        const source = readFileSync(componentPath, 'utf8')

        expect(source).toContain('data-prompt-preset-identity')
        expect(source).toContain('data-prompt-preset-description')
        expect(source).toContain('grid-cols-4')
        expect(source).toContain('bind:value={activePreset.name}')
        expect(source).toContain('activePreset.description')
    })

    test('opens a web address only from a shift-click inside the description', () => {
        const source = readFileSync(componentPath, 'utf8')

        expect(source).toContain('event.shiftKey')
        expect(source).toContain('findHttpUrlAtOffset')
        expect(source).toContain('selectionStart')
        expect(source).toContain('openURL(url)')
    })
})
