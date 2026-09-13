import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempFiles: string[] = []
const { encodeRisuSaveLegacy } = require('./utils.cjs')
const { inspectBackup } = require('./backup-inspector.cjs')

function encodeEntry(name: string, data: Buffer) {
    const nameBytes = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(8 + nameBytes.length)
    header.writeUInt32LE(nameBytes.length, 0)
    nameBytes.copy(header, 4)
    header.writeUInt32LE(data.length, 4 + nameBytes.length)
    return Buffer.concat([header, data])
}

function writeBackup(parts: Buffer[]) {
    const file = path.join(os.tmpdir(), `risubard-inspect-${crypto.randomUUID()}.bin`)
    fs.writeFileSync(file, Buffer.concat(parts))
    tempFiles.push(file)
    return file
}

afterEach(() => {
    for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true })
})

describe('backup inspector', () => {
    it('skips assets and reports content-free database counts and hashes', async () => {
        const database = {
            characters: [{
                chaId: 'character-secret-id',
                name: 'Private character name',
                chats: [{
                    id: 'chat-secret-id',
                    name: 'Private chat title',
                    message: [{ data: 'Private chat message' }, { data: 'Second private message' }],
                }],
            }],
            modules: [{ id: 'module' }],
            plugins: [{ name: 'plugin' }],
            botPresets: [{ id: 'preset' }, { id: 'preset-2' }],
        }
        const databaseBytes = Buffer.from(encodeRisuSaveLegacy(database))
        const file = writeBackup([
            encodeEntry('assets/large.webp', Buffer.alloc(4 * 1024 * 1024, 0x5a)),
            encodeEntry('database.risudat', databaseBytes),
        ])

        const report = await inspectBackup(file)
        const serialized = JSON.stringify(report)

        expect(report).toMatchObject({
            entryCount: 2,
            databaseEntryBytes: databaseBytes.length,
            payloadBytesRead: databaseBytes.length,
            characterCount: 1,
            chatCount: 1,
            messageCount: 2,
            moduleCount: 1,
            pluginCount: 1,
            botPresetCount: 2,
        })
        expect(serialized).not.toContain('Private character name')
        expect(serialized).not.toContain('Private chat title')
        expect(serialized).not.toContain('Private chat message')
        expect(serialized).not.toContain('character-secret-id')
        expect(serialized).not.toContain('chat-secret-id')
    })

    it('rejects a truncated backup before decoding the database', async () => {
        const file = writeBackup([encodeEntry('database.risudat', Buffer.from('broken')).subarray(0, -1)])
        await expect(inspectBackup(file)).rejects.toThrow(/truncated backup entry/i)
    })
})
