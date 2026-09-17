import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const implementation = readFileSync(
    join(process.cwd(), 'src/ts/plugins/apiV3/v3.svelte.ts'),
    'utf8'
)
const declarations = readFileSync(
    join(process.cwd(), 'src/ts/plugins/apiV3/risuai.d.ts'),
    'utf8'
)

describe('BardWiki Plugin API contract', () => {
    it('virtualizes legacy memory getters and sanitizes matching write paths', () => {
        expect(implementation).toContain('decorateBardWikiCharacterForPlugin')
        expect(implementation).toContain('decorateBardWikiChatForPlugin')
        expect(implementation).toContain('stripBardWikiVirtualMemoryFromCharacter')
        expect(implementation).toContain('stripBardWikiVirtualMemoryFromDatabase')
        expect(implementation).toContain('stripBardWikiVirtualMemory(chat)')
    })

    it('exposes a nested BardWiki API with read and write operations', () => {
        expect(implementation).toContain("'bardWiki':{")
        expect(implementation).toContain("'getContext': '_getBardWikiContext'")
        expect(implementation).toContain("'getDocuments': '_getBardWikiDocuments'")
        expect(implementation).toContain("'saveDocument': '_saveBardWikiDocument'")
        expect(implementation).toContain("'setContextMode': '_setBardWikiContextMode'")
        expect(implementation).toContain("'trashDocument': '_trashBardWikiDocument'")
    })

    it('requires a dedicated permission for BardWiki writes', () => {
        expect(implementation).toContain("'bardWikiWrite'")
        expect(implementation).toContain("getPluginPermission(plugin.name, 'bardWikiWrite')")
        expect(implementation).toContain('language.bardWikiWriteConsent')
    })

    it('publishes typed API declarations for plugin authors', () => {
        expect(declarations).toContain('interface BardWikiAPI')
        expect(declarations).toContain('bardWiki: BardWikiAPI;')
        expect(declarations).toContain('getContext(options?: BardWikiContextOptions)')
        expect(declarations).toContain('getDocuments(options?: BardWikiDocumentQuery)')
        expect(declarations).toContain('saveDocument(document: BardWikiDocumentWrite)')
        expect(declarations).toContain('setContextMode(input: BardWikiContextModeWrite)')
        expect(declarations).toContain('trashDocument(documentId: string)')
    })
})
