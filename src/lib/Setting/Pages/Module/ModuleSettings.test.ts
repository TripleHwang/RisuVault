import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(),
    'src/lib/Setting/Pages/Module/ModuleSettings.svelte',
), 'utf8')
const settingsSource = readFileSync(resolve(
    process.cwd(),
    'src/lib/Setting/Settings.svelte',
), 'utf8')
const settingPageSource = readFileSync(resolve(
    process.cwd(),
    'src/lib/UI/GUI/SettingPage.svelte',
), 'utf8')

describe('module persona assignment dialog', () => {
    test('associates the persona search input with a label', () => {
        expect(source).toContain('for="persona-module-search"')
        expect(source).toContain('id="persona-module-search"')
        expect(source).toMatch(/<label[^>]*class="sr-only"[^>]*>\{language\.searchPersonas\}<\/label>/)
    })
})

describe('mobile collection managers', () => {
    test('keeps desktop collection managers on the standard settings page grid', () => {
        expect(settingsSource).toContain('width: min(100%, var(--settings-content-width))')
        expect(settingsSource).not.toMatch(/\.settings-page\.settings-page--collection:has\([^}]+width:\s*100%/s)
    })

    test('uses the settings detail viewport for both module and plugin lists', () => {
        expect(settingsSource).toContain('class:settings-content--mobile-collection={$SettingsMenuIndex === SettingsRoute.Module || $SettingsMenuIndex === SettingsRoute.Plugin}')
        expect(settingsSource).toMatch(/\.settings-content--mobile-collection:has\(:global\(\.settings-standard-page--resizable\)\)\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*overflow:\s*hidden/s)
        expect(settingsSource).toMatch(/\.settings-content--mobile-collection:has\(:global\(\.settings-standard-page--resizable\)\) \.settings-page\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*padding:\s*0/s)
        expect(settingsSource).toMatch(/\.settings-content--mobile-collection :global\(\.settings-standard-page--resizable\)\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*max-height:\s*none/s)
        expect(settingsSource).toContain('.settings-content--mobile-collection :global(.settings-standard-page--resizable > .settings-standard-page__header)')
        expect(settingsSource).toContain('.settings-content--mobile-collection :global([data-manager-window-resize])')
        expect(settingsSource).toContain('.settings-content--mobile-collection :global([data-collection-organizer-list])')
    })

    test('does not cap desktop manager width to the narrow settings page', () => {
        expect(settingPageSource).toContain('align-self: center')
        expect(settingPageSource).toContain('max-width: calc(100vw - 1rem)')
        expect(settingPageSource).not.toMatch(/\.settings-standard-page--resizable\s*\{[^}]*max-width:\s*100%/s)
    })
})
