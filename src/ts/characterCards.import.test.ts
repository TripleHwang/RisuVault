import { beforeEach, describe, expect, test, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'

const validCard = (assets: any[] = []) => ({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Server character', extensions: { risuai: {} }, assets },
})

const state = vi.hoisted(() => ({
    events: [] as string[], alerts: [] as string[], waitAlerts: [] as string[], doneCalls: 0, importerCalls: 0,
    completion: Promise.resolve(), localCardData: JSON.stringify({ spec: 'not-v3', data: {} }), isNodeServer: false, selectedFiles: null as File[] | null,
    importCharX: vi.fn(), readModule: vi.fn(), pin: vi.fn(), requestImmediateSave: vi.fn(),
    db: { statics: { imports: 0 }, characters: [] as any[] },
}))

vi.mock('./platform', () => ({ get isNodeServer() { return state.isNodeServer } }))
vi.mock('./alert', () => ({
    alertCardExport: vi.fn(), alertConfirm: vi.fn(),
    alertError: vi.fn((error) => { state.alerts.push(String(error)); state.events.push('error') }), alertInput: vi.fn(),
    alertStore: { set: vi.fn((alert) => state.waitAlerts.push(alert.msg)) },
    alertTOS: vi.fn(), alertWait: vi.fn((msg) => state.waitAlerts.push(msg)),
    notifyError: vi.fn((message) => state.events.push(`notify:${message}`)), notifySuccess: vi.fn(() => state.events.push('notified')),
}))
vi.mock('./storage/database.svelte', () => ({
    appVer: 'test', defaultSdDataFunc: () => ({}), getDatabase: () => state.db,
    importPreset: vi.fn(), newChatModelDefaults: () => ({}), setDatabase: vi.fn(), setDatabaseLite: vi.fn(),
}))
vi.mock('./process/processzip', () => ({
    CharXImporter: class {
        alertInfo = false; assets = {}; cardData: string | undefined; moduleData: Uint8Array | undefined
        constructor(private readonly progress?: (event: any) => void) { state.importerCalls += 1 }
        async parse() {
            this.progress?.({ phase: 'reading', completed: 5, total: 10 })
            this.progress?.({ phase: 'extracting', completed: 2, total: 3 })
            this.progress?.({ phase: 'preparing-assets', completed: 3, total: 5 })
            this.progress?.({ phase: 'saving-assets', completed: 5, total: 5 })
            state.completion = new Promise<void>((resolve) => setTimeout(() => { this.cardData = state.localCardData; state.events.push('assets-5/5'); resolve() }, 0))
        }
        async done() { state.doneCalls += 1; await state.completion }
    },
    CharXSkippableChecker: vi.fn(), CharXWriter: class {},
}))
vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {}, BlankWriter: class {}, LocalWriter: class {}, VirtualWriter: class {},
    checkCharOrder: vi.fn(), downloadFile: vi.fn(), forageStorage: { importCharX: (...args: any[]) => state.importCharX(...args) },
    loadAsset: vi.fn(), readImage: vi.fn(), requestImmediateSave: (...args: any[]) => state.requestImmediateSave(...args), saveAsset: vi.fn(),
}))
vi.mock('./process/modules', () => ({ exportModuleLegacy: vi.fn(), readModule: (...args: any[]) => state.readModule(...args) }))
vi.mock('./util', async (importOriginal) => ({ ...(await importOriginal<typeof import('./util')>()), selectFileByDom: vi.fn(() => state.selectedFiles) }))
vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn(), subscribe: vi.fn(() => () => undefined) } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: (...args: any[]) => state.pin(...args) }))
vi.mock('src/lang', () => ({
    language: {
        errors: { noData: 'invalid-data' },
        importedCharacter: 'imported',
        characterImportReading: '읽기',
        characterImportReadingBytes: (done: string, total: string) => `읽기 ${done}/${total}`,
        characterImportScanning: (count: number) => `검사 ${count}`,
        characterImportExtracting: (done: number, total: number) => `압축 ${done}/${total}`,
        characterImportPreparingAssets: (done: number, total: number) => `준비 ${done}/${total}`,
        characterImportSavingAssets: (done: number, total: number) => `저장 ${done}/${total}`,
        characterPackageProgressFinalizing: '마무리',
        characterImportReadingMetadata: '메타데이터 읽기',
        characterImportReadingModule: '모듈 읽기',
        characterImportApplying: '캐릭터 적용',
        characterImportEmotions: (done: number, total: number) => `감정 ${done}/${total}`,
        characterImportAssets: (done: number, total: number) => `에셋 ${done}/${total}`,
        characterImportVoiceFiles: (done: number, total: number) => `음성 ${done}/${total}`,
        characterImportMissingAsset: (key: string) => `missing ${key}`,
        characterImportDataUriTooLarge: 'data uri too large',
    },
}))

import { createBaseV2, createBaseV3, importCharacter, importCharacterProcess } from './characterCards'
import { createBardLoreSettings, fingerprintLegacyLore, upgradeLegacyLorebook } from './lorebook/bardLore'

/** Progress the mocked local importer reports, in the order the UI shows it. */
const LOCAL_IMPORT_PROGRESS = ['읽기 5 B/10 B', '압축 2/3', '준비 3/5', '저장 5/5', '메타데이터 읽기']

function resetState() {
    state.events = []; state.alerts = []; state.waitAlerts = []; state.doneCalls = 0; state.importerCalls = 0; state.completion = Promise.resolve()
    state.localCardData = JSON.stringify({ spec: 'not-v3', data: {} }); state.isNodeServer = false; state.selectedFiles = null; state.db.statics.imports = 0; state.db.characters = []
    state.pin.mockReset(); state.importCharX.mockReset(); state.readModule.mockReset()
    state.requestImmediateSave.mockReset()
    state.requestImmediateSave.mockImplementation(async () => { state.events.push('saved') })
}

beforeEach(resetState)

function cardFixture(spec: 'chara_card_v2'|'chara_card_v3', risuai: Record<string, unknown>|undefined, postHistory = 'legacy card global note') {
    return {
        spec,
        spec_version: spec === 'chara_card_v2' ? '2.0' : '3.0',
        data: {
            name: 'Legacy card', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: postHistory,
            alternate_greetings: [], tags: [], creator: '', character_version: '',
            extensions: risuai === undefined ? {} : { risuai },
        },
    }
}

async function importFixture(card: ReturnType<typeof cardFixture>) {
    state.db.characters = []
    await importCharacterProcess({
        name: 'fixture.json',
        data: Buffer.from(JSON.stringify(card)),
    })
    return state.db.characters[0]
}

describe('CharX import completion', () => {
    test('waits for delayed archive completion before validating card metadata', async () => {
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        await state.completion
        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5', 'error'])
        expect(state.alerts).toContain('invalid-data')
        expect(state.waitAlerts).toEqual(LOCAL_IMPORT_PROGRESS)
    })
})

describe('character import localization', () => {
    test('does not ship hard-coded English loading or import error messages', () => {
        const source = readFileSync('src/ts/characterCards.ts', 'utf8')
        expect(source).not.toMatch(/Loading\.\.\. \((Reading|Loading Emotions|Loading Assets|Assets)\)/)
        expect(source).not.toContain('alertError("Error while importing")')
    })
})

describe('Node-assisted CharX import', () => {
    const serverResult = (overrides = {}) => ({
        card: validCard(), moduleBase64: null, assets: {}, excludedFiles: [], warnings: [], ...overrides,
    })

    beforeEach(() => {
        state.localCardData = JSON.stringify(validCard())
        state.isNodeServer = true
        state.importCharX.mockResolvedValue(serverResult())
    })

    test('sends the same File to the server without constructing the browser importer', async () => {
        const file = new File(['archive'], 'REALM.CHARX')
        await importCharacterProcess({ name: file.name, data: file })
        expect(state.importCharX).toHaveBeenCalledWith(file, expect.any(Function))
        expect(state.importerCalls).toBe(0)
    })

    test('wraps a byte buffer in a Blob for the server', async () => {
        const bytes = new Uint8Array([1, 2, 3])
        await importCharacterProcess({ name: 'realm.charx', data: bytes })
        const uploaded = state.importCharX.mock.calls[0][0]
        expect(uploaded).toBeInstanceOf(Blob)
        expect(uploaded).not.toBe(bytes)
        expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes)
    })

    test('rejects streams with an actionable server-import error', async () => {
        await expect(importCharacterProcess({ name: 'realm.charx', data: new ReadableStream() })).rejects.toThrow('Node CharX import requires a file or byte buffer')
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(0)
    })

    test('rejects stream-like input from another realm before server upload', async () => {
        const foreignStream = { getReader() { return {} } } as any
        await expect(importCharacterProcess({ name: 'realm.charx', data: foreignStream })).rejects.toThrow('Node CharX import requires a file or byte buffer')
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(0)
    })

    test('wraps exact bytes from a foreign Uint8Array in a Blob', async () => {
        const foreignBytes = runInNewContext('new Uint8Array([4, 5, 6])') as Uint8Array
        expect(foreignBytes).not.toBeInstanceOf(Uint8Array)
        await importCharacterProcess({ name: 'realm.charx', data: foreignBytes })
        const uploaded = state.importCharX.mock.calls[0][0]
        expect(uploaded).toBeInstanceOf(Blob)
        expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    })

    test('keeps non-Node CharX on the local importer', async () => {
        state.isNodeServer = false
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
        expect(state.waitAlerts).toEqual([...LOCAL_IMPORT_PROGRESS, '캐릭터 적용'])
    })

    test('propagates a server rejection without local fallback', async () => {
        state.importCharX.mockRejectedValue(new Error('server broke'))
        await expect(importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })).rejects.toThrow('server broke')
        expect(state.importerCalls).toBe(0)
    })

    test('surfaces a server rejection through the import UI boundary without local fallback', async () => {
        state.importCharX.mockRejectedValue(new Error('server broke'))
        state.selectedFiles = [new File(['archive'], 'realm.charx')]
        await importCharacter()
        expect(state.alerts).toContain('Error: server broke')
        expect(state.importerCalls).toBe(0)
    })

    test('merges a server module through the existing module reader', async () => {
        state.readModule.mockResolvedValue({ trigger: [{ id: 'trigger' }], regex: [{ id: 'regex' }], lorebook: [{ key: 'lore' }] })
        state.importCharX.mockResolvedValue(serverResult({ moduleBase64: Buffer.from('module').toString('base64') }))
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.readModule).toHaveBeenCalledWith(Buffer.from('module'))
        expect(state.waitAlerts).toContain('모듈 읽기')
        expect(state.db.characters[0]).toMatchObject({ triggerscript: [{ id: 'trigger' }], customscript: [{ id: 'regex' }], globalLore: [{ key: 'lore' }] })
    })

    test('uses server assets during card finalization and pins the imported character', async () => {
        const assets = [{ type: 'icon', name: 'main', uri: '__asset:assets/avatar.png' }]
        state.importCharX.mockResolvedValue(serverResult({ card: validCard(assets), assets: { 'assets/avatar.png': 'assets/hash.png' } }))
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.db.characters[0].image).toBe('assets/hash.png')
        expect(state.pin).toHaveBeenCalledWith(state.db, state.db.characters[0].chaId)
    })

    test('persists a server-imported character before reporting success', async () => {
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.requestImmediateSave).toHaveBeenCalledWith({ flushServer: true, rejectOnFailure: true })
        expect(state.events).toEqual(['saved', 'notified'])
    })

    test('returns the created character when requested', async () => {
        const result = await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array(), returnCharacter: true })
        expect(result).toMatchObject({ name: 'Server character' })
        expect(state.db.characters).toEqual([])
    })

    test('reports server exclusions and warnings once after finalizing', async () => {
        state.importCharX.mockImplementation(async (_file, progress) => {
            progress({ phase: 'uploading', loaded: 1, total: 2 })
            progress({ phase: 'processing', completed: 1, total: 2 })
            return serverResult({ excludedFiles: ['large.png'], warnings: ['asset skipped'] })
        })
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.waitAlerts).toEqual(['Uploading CharX…', 'Processing CharX on server…', '메타데이터 읽기', 'Finalizing character…', '캐릭터 적용'])
        expect(state.events).toEqual(['saved', 'notified', 'notify:large.png\nasset skipped'])
    })

    test.each(['portrait.jpg', 'portrait.jpeg'])('keeps %s on the local importer', async (name) => {
        await importCharacterProcess({ name, data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
        expect(state.waitAlerts).toEqual([...LOCAL_IMPORT_PROGRESS, '캐릭터 적용'])
    })
})

describe('legacy character-card replace-global-note compatibility', () => {
    test('persists an imported card before reporting success', async () => {
        await importFixture(cardFixture('chara_card_v3', undefined))

        expect(state.requestImmediateSave).toHaveBeenCalledWith({ flushServer: true, rejectOnFailure: true })
        expect(state.events).toEqual(['saved', 'notified'])
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('restores legacy replaceGlobalNote from %s cards with a Risu extension that does not own it', async (spec) => {
        const imported = await importFixture(cardFixture(spec, {}))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'legacy card global note',
            replaceGlobalNote: 'legacy card global note',
        })
    })

    test('does not fall back when a new card explicitly owns an empty replaceGlobalNote', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', { replaceGlobalNote: '' }, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('does not create a Risu replaceGlobalNote for ordinary %s cards', async (spec) => {
        const imported = await importFixture(cardFixture(spec, undefined, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test('imports Risu module extension fields through the public card lifecycle', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', {
            moduleNamespace: 'fixture-namespace', hideChatIcon: true,
        }, ''))

        expect(imported).toMatchObject({ moduleNamespace: 'fixture-namespace', hideChatIcon: true })
    })
})

describe('public character-card lifecycle round-trips', () => {
    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('migrates namespaced Bard Lore without losing one-sided edits through %s', async (_spec, createCard) => {
        const legacyLore = [{
            id: 'legacy',
            key: 'legacy',
            secondkey: '',
            insertorder: 10,
            comment: 'Legacy',
            content: 'Legacy content',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        }]
        const bardEntry = {
            ...legacyLore[0],
            id: 'legacy',
            comment: 'Bard',
            content: 'Bard content',
            bard: {
                sourceLegacyId: 'legacy',
                sourceHash: fingerprintLegacyLore(legacyLore[0] as any),
                kind: 'location',
                activation: 'retrieve',
                aliases: ['장소'],
                tags: ['데이트'],
                summary: '장소 요약',
                facets: [],
                injection: 'full',
                links: [],
            },
        }
        const source = {
            name: 'Bard Lore lifecycle',
            globalLore: legacyLore,
            loreExt: {},
            bardLore: {
                schemaVersion: 1,
                mode: 'bard',
                entries: [bardEntry],
                settings: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                analysisRun: {
                    schemaVersion: 1,
                    id: 'run',
                    scope: 'all',
                    targetIds: ['legacy'],
                    createdAt: '2026-08-31T00:00:00.000Z',
                    updatedAt: '2026-08-31T00:00:00.000Z',
                    status: 'review',
                    settingsSnapshot: createBardLoreSettings({ maximumTokens: 777, maxEntries: 3 }),
                    overwriteExisting: false,
                    batches: [{
                        id: 'batch',
                        index: 0,
                        targetIds: ['legacy'],
                        estimatedInputTokens: 120,
                        status: 'complete',
                        candidates: [{
                            id: 'legacy',
                            sourceHash: 'draft-hash',
                            kind: 'location',
                            aliases: ['장소'],
                            tags: ['데이트'],
                            summary: '검토 대기',
                            facets: [],
                            injection: 'full',
                            atoms: [],
                            links: [],
                        }],
                    }],
                },
            },
        } as any

        const exported = createCard(source)
        expect(exported.data.character_book?.entries).toHaveLength(1)
        expect(exported.data.character_book?.entries[0]).toMatchObject({
            name: 'Bard',
            content: 'Bard content',
        })
        expect((exported.data.extensions as any).risubard.bardLore.settings.maximumTokens).toBe(777)
        expect(JSON.stringify((exported.data.extensions as any).risubard.bardLore)).not.toContain('Bard content')

        const imported = await importFixture(exported as any)
        const reexported = createCard(imported)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.bardLore).toMatchObject({
            schemaVersion: 2,
            metadata: [expect.objectContaining({ sourceLegacyId: 'legacy', kind: 'location' })],
            derivedEntries: [],
        })
        expect(imported.bardLore).not.toHaveProperty('entries')
        expect((reexported.data.extensions as any).risubard.bardLore).toEqual(imported.bardLore)
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves completed Bard analysis drafts for ID-less lore through %s', async (_spec, createCard) => {
        const idlessLore = {
            key: 'place', secondkey: '', insertorder: 10, comment: 'Place', content: 'Stable place body',
            mode: 'normal' as const, alwaysActive: false, selective: false,
        }
        const settings = createBardLoreSettings()
        const bardLore = upgradeLegacyLorebook([{ ...idlessLore, id: 'old-source-id' }], () => 'unused', settings)
        bardLore.analysisRun = {
            schemaVersion: 1,
            id: 'run',
            scope: 'all',
            targetIds: ['old-source-id'],
            createdAt: '2026-09-02T00:00:00.000Z',
            updatedAt: '2026-09-02T00:00:00.000Z',
            status: 'review',
            settingsSnapshot: settings,
            overwriteExisting: false,
            batches: [{
                id: 'batch', index: 0, targetIds: ['old-source-id'], estimatedInputTokens: 10, status: 'complete',
                candidates: [{ id: 'old-source-id', sourceHash: 'draft', kind: 'location', aliases: [], tags: [], summary: 'completed', links: [] }],
            }],
        }

        const imported = await importFixture(createCard({
            name: 'ID-less Bard Lore',
            globalLore: [idlessLore],
            loreExt: {},
            bardLore,
        } as any) as any)
        const importedId = imported.globalLore[0].id

        expect(importedId).toBeTruthy()
        expect(imported.bardLore?.analysisRun?.targetIds).toEqual([importedId])
        expect(imported.bardLore?.analysisRun?.batches[0].candidates?.[0].id).toBe(importedId)
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('ignores malformed Bard Lore metadata without breaking the standard lorebook through %s', async (_spec, createCard) => {
        const exported = createCard({
            name: 'Standard compatibility',
            globalLore: [{
                id: 'legacy',
                key: 'legacy',
                secondkey: '',
                insertorder: 10,
                comment: 'Legacy',
                content: 'Legacy content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
            }],
            loreExt: {},
        } as any)
        ;(exported.data.extensions as any).risubard = {
            bardLore: { schemaVersion: 999, entries: 'invalid' },
        }

        const imported = await importFixture(exported as any)

        expect(imported.globalLore).toHaveLength(1)
        expect(imported.globalLore[0]).toMatchObject({
            comment: 'Legacy',
            content: 'Legacy content',
        })
        expect(imported.bardLore).toBeUndefined()
    })

    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves Risu extensions and post-history instructions through %s export, import, and re-export', async (_spec, createCard) => {
        const source = {
            name: 'Lifecycle fixture', globalLore: [], loreExt: {},
            postHistoryInstructions: 'standard post-history instructions',
            replaceGlobalNote: 'explicit Risu global-note replacement',
            moduleNamespace: 'lifecycle-namespace',
            hideChatIcon: true,
        } as any

        const imported = await importFixture(createCard(source) as any)
        const reexported = createCard(imported)

        expect(imported).toMatchObject({
            postHistoryInstructions: source.postHistoryInstructions,
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
        expect(reexported.data.post_history_instructions).toBe(source.postHistoryInstructions)
        expect(reexported.data.extensions.risuai).toMatchObject({
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
    })
})
