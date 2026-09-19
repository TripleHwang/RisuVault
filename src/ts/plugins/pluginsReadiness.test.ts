import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/plugins/plugins.svelte.ts'), 'utf8')
const gateSource = readFileSync(resolve(process.cwd(), 'src/ts/plugins/pluginChatAccess.ts'), 'utf8')
const chatScreenSource = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')
const alertSource = readFileSync(resolve(process.cwd(), 'src/lib/Others/AlertComp.svelte'), 'utf8')

describe('plugin readiness with metadata bootstrap', () => {
    it('publishes readiness after plugin loading settles', () => {
        expect(source).toContain('export const pluginReadyStore')
        expect(source).toContain("pluginStateStore.set('failed')")
        expect(source).toContain("pluginStateStore.set('ready')")
        expect(source).not.toMatch(/finally[\s\S]*pluginReadyStore\.set\(true\)/)
    })

    it('gates module UI for idle, loading, and failed plugin states', () => {
        expect(chatScreenSource).toContain('$pluginStateStore === \'idle\' || $pluginStateStore === \'loading\'')
        expect(chatScreenSource).toContain("$pluginStateStore === 'failed'")
        expect(chatScreenSource).toContain('Plugin initialization failed')
        expect(alertSource).toContain("$pluginStateStore === 'ready'")
        expect(alertSource).toContain('Plugin initialization failed')
    })

    it('does not expose or replace metadata-only characters through v2 plugin APIs', () => {
        expect(source).toContain("isPluginCharacterComplete(character) ? character : null")
        expect(source).toContain("throw new Error('Character details are still loading')")
        expect(source).toContain("prop === 'characters' && hasMetadataOnlyCharacters(target)")
        // The gates themselves live in pluginChatAccess.ts and are re-exported.
        expect(source).toContain('} from "./pluginChatAccess";')
        expect(gateSource).toMatch(/isPluginCharacterComplete[\s\S]*character\.chats\.every\(isPluginChatComplete\)/)
        expect(gateSource).toContain("chat._stub !== true")
        expect(gateSource).toContain("Array.isArray(chat.message)")
        expect(source).toMatch(/getChar:[\s\S]*isPluginCharacterComplete\(character\)/)
        expect(source).toMatch(/setChar:[\s\S]*isPluginCharacterComplete\(db\.characters\[charid\]\)/)
    })
})
