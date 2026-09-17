import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('application overlay layering', () => {
    test('uses the original static layer contract without a global draw-order observer', () => {
        const app = source('src/App.svelte')
        const dialog = source('src/lib/UI/GUI/ShDialog.svelte')
        const alert = source('src/lib/UI/GUI/ShAlertDialog.svelte')
        const loading = source('src/lib/UI/GUI/ShLoadingDialog.svelte')
        const dropdown = source('src/lib/UI/GUI/ShDropdownMenuContent.svelte')
        const select = source('src/lib/UI/GUI/ShSelect.svelte')
        const toaster = source('src/lib/UI/GUI/Toaster.svelte')
        const tooltip = source('src/ts/gui/tooltip.ts')
        const personaBuilder = source('src/lib/Others/PersonaBuilder.svelte')
        const loreBuilder = source('src/lib/Others/LoreBuilder.svelte')
        const pluginApi = source('src/ts/plugins/apiV3/v3.svelte.ts')

        expect(app).not.toContain('observeModalLayers')
        expect(existsSync(resolve(process.cwd(), 'src/lib/UI/GUI/modalLayerStack.ts'))).toBe(false)
        for (const component of [dialog, alert, loading]) {
            expect(component).toContain("base: 'z-40'")
            expect(component).toContain("alert: 'z-50'")
            expect(component).toContain("top: 'z-[60]'")
            expect(component).not.toContain('data-risu-modal-tier')
        }
        expect(alert).toContain("tier = 'alert'")
        expect(dropdown).toContain("'z-50 min-w-32")
        expect(dropdown).not.toContain('data-risu-floating-layer')
        expect(select).toContain('class="fixed z-50')
        expect(select).not.toContain('data-risu-floating-layer')
        expect(toaster).not.toContain('data-sonner-toaster')
        expect(tooltip).not.toContain('layerAbove')
        expect(personaBuilder).toContain('overlayClass="z-[45]"')
        expect(personaBuilder).toContain('contentClass="persona-builder-dialog z-[45]"')
        expect(loreBuilder).toContain('tier="alert"')
        expect(loreBuilder).not.toContain('tier="base"')
        expect(pluginApi).toContain('iframe.style.zIndex = "1000"')
        expect(pluginApi).not.toContain('iframe.dataset.risuModalTier')
    })

    test('places the reboot choice dialog in the top confirmation tier', () => {
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        expect(wiki).toContain(
            "alertConfirm(language.risuBardWikiRebootWarning, { tier: 'top' })"
        )
        expect(wiki).toContain(
            "alertConfirm(language.risuBardWikiRebootCancelWarning, { tier: 'top' })"
        )
        const chooser = wiki.slice(
            wiki.indexOf('{#if rebootChooserOpen}'),
            wiki.indexOf('{#snippet rebootChooserFooter')
        )
        expect(chooser).toContain('tier="top"')
    })

    test('lets a global confirmation opt into the top tier', () => {
        const alertApi = source('src/ts/alert.ts')
        const alertHost = source('src/lib/Others/AlertComp.svelte')
        const ask = alertHost.slice(
            alertHost.indexOf("open={$alertStore.type === 'ask'}"),
            alertHost.indexOf("open={$alertStore.type === 'pluginconfirm'}")
        )

        expect(alertApi).toContain('options: AlertConfirmOptions = {}')
        expect(alertApi).toContain("'tier': options.tier")
        expect(ask).toContain("tier={$alertStore.tier ?? 'alert'}")
    })

    test('lets a nested preset name input opt into the top tier', () => {
        const alertApi = source('src/ts/alert.ts')
        const alertHost = source('src/lib/Others/AlertComp.svelte')
        const presetEditor = source('src/lib/Others/LorePromptPresetEditor.svelte')
        const inputDialog = alertHost.slice(
            alertHost.indexOf("open={$alertStore.type === 'input'}"),
            alertHost.indexOf('</ShDialog>', alertHost.indexOf("open={$alertStore.type === 'input'}")),
        )

        expect(alertApi).toContain('options: AlertConfirmOptions = {}')
        expect(inputDialog).toContain("tier={$alertStore.tier ?? 'alert'}")
        expect(presetEditor).toContain("{ tier: 'top' }")
    })

    test('keeps the BardWiki dock below base editor dialogs', () => {
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        const dialog = source('src/lib/UI/GUI/ShDialog.svelte')
        const lorebook = source(
            'src/lib/SideBars/LoreBook/LoreBookWorkspaceDialog.svelte'
        )
        const dockRule = wiki.slice(
            wiki.indexOf('.memory-wiki-dock {'),
            wiki.indexOf('.memory-wiki-dock.closed')
        )

        expect(dialog).toContain("tier = 'alert'")
        expect(lorebook).toContain('tier="base"')
        expect(dockRule).toContain('z-index: 30;')
    })
})
