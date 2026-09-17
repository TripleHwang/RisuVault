import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const { createUserDataRepository } = require('./user-data-repository.cjs')
let createProjectionShadow: any
try {
    ({ createProjectionShadow } = require('./projection-shadow.cjs'))
} catch {
    createProjectionShadow = undefined
}

const roots: string[] = []

function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-shadow-'))
    roots.push(root)
    return root
}

function legacyDatabase() {
    return {
        formatversion: 5,
        language: 'ko',
        botPresets: [{ id: 'preset-1', name: 'Preset' }],
        modules: [],
        personas: [],
        loreBook: [],
        characters: [{
            chaId: 'char-1',
            name: 'Private character name',
            chats: [{
                id: 'chat-1',
                name: 'Private chat name',
                message: [{ id: 'message-1', role: 'user', data: 'Private message body' }],
            }],
        }],
    }
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('S1 projection shadow', () => {
    it('runs from the successful canonical projection boundary', () => {
        const server = readFileSync(path.join(process.cwd(), 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).toContain("require('./projection-shadow.cjs')")
        expect(server).toContain('projectionShadow.schedule({')
        expect(server).toContain('database: databaseObject')
    })

    it('compares the committed projection without publishing another copy', async () => {
        expect(createProjectionShadow).toBeTypeOf('function')
        if (!createProjectionShadow) return

        const repository = createUserDataRepository({ dataRoot: tempRoot() })
        const database = legacyDatabase()
        const imported = repository.importLegacyDatabase(database, { mode: 'sync' })
        const tasks: Array<() => Promise<void>> = []
        const rows: any[] = []
        const shadow = createProjectionShadow({
            repository,
            observation: { record: (row: any) => rows.push(row) },
            scheduleTask: (task: () => Promise<void>) => { tasks.push(task) },
            isPersisting: () => false,
        })

        expect(shadow.schedule({ database, trigger: 'chat-debounce', plannedFiles: imported.files })).toBe(true)
        expect(tasks).toHaveLength(1)
        await tasks[0]()

        expect(rows).toEqual([expect.objectContaining({
            kind: 'projection-shadow',
            trigger: 'chat-debounce',
            outcome: 'success',
            semanticMatch: true,
            plannedFiles: imported.files,
        })])
        expect(JSON.stringify(rows)).not.toContain('Private')
    })

    it('accepts the malformed legacy shapes observed in the S1 runtime', async () => {
        expect(createProjectionShadow).toBeTypeOf('function')
        if (!createProjectionShadow) return

        const repository = createUserDataRepository({ dataRoot: tempRoot() })
        const database: any = legacyDatabase()
        database.collectionOrganizers = { promptPresets: { folderByItemId: {} } }
        database.seperateParameters = { first: {}, second: {} }
        database.characters[0].chats[0].id = ''
        delete database.characters[0].chats[0].message
        const imported = repository.importLegacyDatabase(database, { mode: 'sync' })
        const tasks: Array<() => Promise<void>> = []
        const rows: any[] = []
        const shadow = createProjectionShadow({
            repository,
            observation: { record: (row: any) => rows.push(row) },
            scheduleTask: (task: () => Promise<void>) => { tasks.push(task) },
        })

        shadow.schedule({ database, trigger: 'chat-debounce', plannedFiles: imported.files })
        await tasks[0]()

        expect(rows).toEqual([expect.objectContaining({ outcome: 'success', semanticMatch: true })])
    })

    it('reports only a content-free mismatch result and never throws into saving', async () => {
        expect(createProjectionShadow).toBeTypeOf('function')
        if (!createProjectionShadow) return

        const repository = createUserDataRepository({ dataRoot: tempRoot() })
        const database = legacyDatabase()
        repository.importLegacyDatabase(database, { mode: 'sync' })
        const tasks: Array<() => Promise<void>> = []
        const rows: any[] = []
        const shadow = createProjectionShadow({
            repository,
            observation: { record: (row: any) => rows.push(row) },
            scheduleTask: (task: () => Promise<void>) => { tasks.push(task) },
            isPersisting: () => false,
        })

        expect(() => shadow.schedule({
            database: { ...database, language: 'en' },
            trigger: 'flush',
            plannedFiles: 9,
        })).not.toThrow()
        await tasks[0]()

        expect(rows).toEqual([expect.objectContaining({
            kind: 'projection-shadow',
            outcome: 'mismatch',
            errorStage: 'semantic-compare',
            semanticMatch: false,
        })])
        expect(JSON.stringify(rows)).not.toContain('Private')
    })

    it('skips comparison while a compatibility persist is active', async () => {
        expect(createProjectionShadow).toBeTypeOf('function')
        if (!createProjectionShadow) return

        const tasks: Array<() => Promise<void>> = []
        const rows: any[] = []
        const shadow = createProjectionShadow({
            repository: { exportLegacyDatabase: () => { throw new Error('must not read') } },
            observation: { record: (row: any) => rows.push(row) },
            scheduleTask: (task: () => Promise<void>) => { tasks.push(task) },
            isPersisting: () => true,
        })

        shadow.schedule({ database: legacyDatabase(), trigger: 'patch-debounce', plannedFiles: 9 })
        await tasks[0]()

        expect(rows).toEqual([expect.objectContaining({
            kind: 'projection-shadow',
            outcome: 'skipped',
            errorStage: 'persist-active',
        })])
    })
})
