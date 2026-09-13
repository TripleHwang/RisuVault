const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { checkHeader, decodeRisuSave } = require('./utils.cjs')

const MAX_NAME_BYTES = 1024
const DEFAULT_MAX_DATABASE_BYTES = 1024 * 1024 * 1024

async function readExactly(file, length, position, label) {
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset)
        if (bytesRead === 0) throw new Error(`Truncated backup while reading ${label}`)
        offset += bytesRead
    }
    return buffer
}

async function scanBackupEntries(file, fileSize) {
    const entries = new Map()
    let position = 0
    let entryCount = 0

    while (position < fileSize) {
        const nameLengthBuffer = await readExactly(file, 4, position, 'entry name length')
        const nameLength = nameLengthBuffer.readUInt32LE(0)
        position += 4
        if (nameLength > MAX_NAME_BYTES) {
            throw new Error(`Suspicious backup entry name length: ${nameLength}`)
        }

        const nameBuffer = await readExactly(file, nameLength, position, 'entry name')
        const name = nameBuffer.toString('utf8')
        position += nameLength
        const dataLengthBuffer = await readExactly(file, 4, position, `data length for ${name}`)
        const dataLength = dataLengthBuffer.readUInt32LE(0)
        position += 4

        const end = position + dataLength
        if (!Number.isSafeInteger(end) || end > fileSize) {
            throw new Error(`Truncated backup entry: ${name}`)
        }
        if (entries.has(name)) throw new Error(`Duplicate backup entry: ${name}`)
        entries.set(name, { offset: position, length: dataLength })
        entryCount += 1
        position = end
    }

    return { entries, entryCount }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex')
}

function idHash(value) {
    return sha256(String(value)).slice(0, 16)
}

function collection(value) {
    return Array.isArray(value) ? value : []
}

function summarizeDatabase(db) {
    const characters = collection(db?.characters)
    let chatCount = 0
    let messageCount = 0
    let placeholderChatCount = 0
    const characterChats = characters.map((character, characterIndex) => {
        const chats = collection(character?.chats)
        const characterMessageCount = chats.reduce((total, chat) => total + collection(chat?.message).length, 0)
        const characterPlaceholderCount = chats.filter(chat => chat?._placeholder === true).length
        chatCount += chats.length
        messageCount += characterMessageCount
        placeholderChatCount += characterPlaceholderCount
        return {
            idHash: idHash(character?.chaId ?? `missing-character-id:${characterIndex}`),
            chatCount: chats.length,
            messageCount: characterMessageCount,
            placeholderChatCount: characterPlaceholderCount,
            chatIdsHash: sha256(chats.map((chat, chatIndex) => String(chat?.id ?? `missing-chat-id:${chatIndex}`)).sort().join('\0')),
        }
    })

    return {
        characterCount: characters.length,
        chatCount,
        messageCount,
        placeholderChatCount,
        moduleCount: collection(db?.modules).length,
        pluginCount: collection(db?.plugins).length,
        botPresetCount: collection(db?.botPresets).length,
        characterIdsHash: sha256(characters.map((character, index) => String(character?.chaId ?? `missing-character-id:${index}`)).sort().join('\0')),
        characterChats,
    }
}

async function inspectBackup(filePath, options = {}) {
    const resolvedPath = path.resolve(filePath)
    const file = await fs.open(resolvedPath, 'r')
    let payloadBytesRead = 0
    try {
        const stat = await file.stat()
        const { entries, entryCount } = await scanBackupEntries(file, stat.size)
        const databaseEntry = entries.get('database.risudat')
        if (!databaseEntry) throw new Error('Backup does not contain database.risudat')

        const maxDatabaseBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES
        if (databaseEntry.length > maxDatabaseBytes) {
            throw new Error(
                `database.risudat is ${(databaseEntry.length / 1024 / 1024).toFixed(1)} MiB; ` +
                `raise RISUBARD_INSPECT_MAX_DB_MB to inspect it explicitly`,
            )
        }

        const readEntry = async (name) => {
            const entry = entries.get(name)
            if (!entry) return null
            payloadBytesRead += entry.length
            return readExactly(file, entry.length, entry.offset, name)
        }
        const databaseBytes = await readEntry('database.risudat')
        const db = await decodeRisuSave(databaseBytes, {
            resolveRemote: async (name) => {
                for (const candidate of [name, `remotes/${name}.local.bin`, `remotes/${name}`]) {
                    const value = await readEntry(candidate)
                    if (value) return value
                }
                return null
            },
        })

        return {
            formatVersion: 1,
            fileBytes: stat.size,
            entryCount,
            databaseEntryBytes: databaseEntry.length,
            databaseFormat: checkHeader(databaseBytes) ?? 'unknown',
            databaseSha256: sha256(databaseBytes),
            payloadBytesRead,
            ...summarizeDatabase(db),
        }
    } finally {
        await file.close()
    }
}

module.exports = { inspectBackup, scanBackupEntries, summarizeDatabase }
