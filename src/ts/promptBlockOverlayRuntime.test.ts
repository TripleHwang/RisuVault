import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('prompt block overlay runtime wiring', () => {
    test('composes the effective prompt template immediately before chat prompt processing', () => {
        const process = read('./process/index.svelte.ts')

        expect(process).toContain('composePromptBlockOverlay(')
        expect(process).toContain('DBState.db.promptBlockOverlay')
        expect(process).toContain('DBState.db.promptBlockOverlayProfiles')
        expect(process).toContain('getActivePromptOverlayToggleTemplate()')
    })

    test('uses effective overlay toggles in the sidebar and toggle persistence', () => {
        const toggles = read('../lib/SideBars/Toggles.svelte')
        const database = read('./storage/database.svelte.ts')

        expect(toggles).toContain('getActivePromptOverlayToggleTemplate()')
        expect(toggles).toContain('getActivePromptOverlayTemplate()')
        expect(database).toContain('export function getActivePromptOverlayToggleTemplate')
        expect(database).toContain('export function getActivePromptOverlayTemplate')
        expect(database).toContain('getActivePromptOverlayToggleTemplate(db)')
    })
})
