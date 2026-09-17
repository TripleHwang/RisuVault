import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { languageKorean } from '../../lang/ko'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('chat toggle preset binding UI', () => {
    test('applies a selected preset as a named chat baseline and refreshes it on overwrite', () => {
        const alert = source('src/lib/Others/AlertComp.svelte')

        expect(alert).toContain('applyTogglePresetToChat(preset)')
        expect(alert).toContain('setPinnedTogglePresetBaseline(getCurrentChat(), values, presetName)')
    })

    test('shows the baseline name, dirty count, reset action, tooltip, and dirty rows', () => {
        const toggles = source('src/lib/SideBars/Toggles.svelte')

        expect(toggles).toContain('getToggleValueDifferences')
        expect(toggles).toContain('togglePinManualName')
        expect(toggles).toContain('dirtyDifferences.length')
        expect(toggles).toContain('RotateCcwIcon')
        expect(toggles).toContain('resetPinnedToggleValues')
        expect(toggles).toContain('dirtyTooltip')
        expect(toggles).toContain('toggle-row--dirty')
    })

    test('uses the requested Korean labels', () => {
        expect(languageKorean.toggleBindingLabel).toBe('채팅별 프리셋 고정')
        expect(languageKorean.togglePinManualName).toBe('직접 설정')
        expect(languageKorean.togglePinReset).toBe('고정한 프리셋 값으로 되돌리기')
    })
})
