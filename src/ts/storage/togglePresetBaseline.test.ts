import { describe, expect, test } from 'vitest'

import { createTogglePresetBaseline, getToggleValueDifferences } from './togglePresetBaseline'

describe('toggle preset baselines', () => {
    test('clones values so later edits do not mutate the baseline', () => {
        const values = { toggle_one: '1' }
        const baseline = createTogglePresetBaseline(values, 'Story')

        values.toggle_one = '0'

        expect(baseline).toEqual({ name: 'Story', values: { toggle_one: '1' } })
    })

    test('reports deterministic differences across baseline and current keys', () => {
        const differences = getToggleValueDifferences(
            { name: 'Story', values: { toggle_two: '2', toggle_one: '1', toggle_empty: '' } },
            { toggle_two: 'changed', toggle_extra: 'new', toggle_empty: '' },
        )

        expect(differences).toEqual([
            { key: 'toggle_extra', baselineValue: '', currentValue: 'new' },
            { key: 'toggle_one', baselineValue: '1', currentValue: '' },
            { key: 'toggle_two', baselineValue: '2', currentValue: 'changed' },
        ])
    })

    test('treats a missing value and an empty string as equivalent', () => {
        expect(getToggleValueDifferences({ values: { toggle_empty: '' } }, {})).toEqual([])
    })
})
