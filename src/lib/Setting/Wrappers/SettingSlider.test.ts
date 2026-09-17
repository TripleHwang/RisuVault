// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import SettingSlider from './SettingSlider.svelte'

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: { characters: [] } },
    selIdState: { selId: -1 },
}))
vi.mock('src/lang', () => ({
    language: {
        temperature: 'Temperature',
        disabled: 'Disabled',
        help: { tempature: 'Sampling temperature' },
    },
}))

let mounted: ReturnType<typeof mount> | undefined

const temperatureItem = {
    id: 'params.temperature',
    type: 'slider',
    labelKey: 'temperature',
    helpKey: 'tempature',
    bindKey: 'temperature',
    options: { min: 0, max: 200, multiple: 0.01, fixed: 2, disableable: true },
} as const

function renderTemperature(value: number) {
    DBState.db = { temperature: value } as typeof DBState.db
    mounted = mount(SettingSlider, {
        target: document.body,
        props: {
            item: temperatureItem as never,
            ctx: { db: DBState.db, layout: 'row' } as never,
        },
    })
}

beforeEach(() => {
    document.body.replaceChildren()
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('row setting slider storage boundary', () => {
    test('renders the -1000 sentinel as a disabled switch instead of a number', async () => {
        renderTemperature(-1000)
        await tick()

        const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')
        expect(toggle).not.toBeNull()
        expect(toggle?.getAttribute('data-state')).toBe('unchecked')
        expect(document.body.textContent).not.toContain('-1000')
        expect(document.querySelector('input[type="number"]')).toBeNull()
    })

    test.each([-1, 201, Number.NaN])('treats an invalid stored temperature %s as disabled without rewriting it', async (value) => {
        renderTemperature(value)
        await tick()

        const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')
        expect(toggle?.getAttribute('data-state')).toBe('unchecked')
        expect(document.querySelector('input[type="number"]')).toBeNull()
        expect(Object.is(DBState.db.temperature, value)).toBe(true)
    })

    test('edits temperature in API units while preserving hundredths in storage', async () => {
        renderTemperature(100)
        await tick()

        const input = document.querySelector<HTMLInputElement>('input[type="number"]')
        expect(input?.value).toBe('1')

        input!.value = '1.25'
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        await tick()

        expect(DBState.db.temperature).toBe(125)
    })
})
