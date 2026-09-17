require('sucrase/register/ts')

const {
    createNarrativeMemoryService,
} = require('./risubard-memory-service.ts')
const {
    createSourceSnapshotAdapter,
} = require('./risubard-source-workspace.ts')
const {
    createNarrativeGraphService,
} = require('./risubard-graph-service.ts')
const {
    createMarkdownNarrativeWiki,
} = require('./risubard-markdown-wiki.ts')
const {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
    removeRebootMemoryWorkspace,
    replaceMemoryWorkspace,
} = require('./risubard-memory-fork.ts')
const {
    createMemorySaveSlot,
    deleteMemorySaveSlot,
    listMemorySaveSlots,
    memorySaveWorkspaceId,
    prepareMemorySaveLoad,
    readMemorySaveChat,
    renameMemorySaveSlot,
} = require('./risubard-memory-save.ts')
const { revealLocalFile } = require('./reveal-local-file.cjs')

function createRuntimeMemoryService(userDataDirectory, options = {}) {
    const memory = createNarrativeMemoryService(userDataDirectory)
    const sources = createSourceSnapshotAdapter(userDataDirectory)
    const graph = createNarrativeGraphService(userDataDirectory, {
        loadV1State: (characterId, chatId) =>
            memory.loadState(characterId, chatId),
        applyV1Delta: (input) => memory.applyDelta(input),
    })
    const wiki = createMarkdownNarrativeWiki(userDataDirectory)
    const revealFile = options.revealFile || revealLocalFile
    const forkWorkspace = options.forkWorkspace || forkMemoryWorkspace
    const completeForkWorkspace = options.completeForkWorkspace
        || completeMemoryWorkspaceFork
    const replaceWorkspace = options.replaceWorkspace || replaceMemoryWorkspace
    const removeRebootWorkspace = options.removeRebootWorkspace
        || removeRebootMemoryWorkspace
    const createSaveSlot = options.createSaveSlot || createMemorySaveSlot
    const listSaveSlots = options.listSaveSlots || listMemorySaveSlots
    const prepareSaveLoad = options.prepareSaveLoad || prepareMemorySaveLoad
    const previewSaveSlot = options.previewSaveSlot || readMemorySaveChat
    const renameSaveSlot = options.renameSaveSlot || renameMemorySaveSlot
    const deleteSaveSlot = options.deleteSaveSlot || deleteMemorySaveSlot
    const queues = new Map()
    const serializedMany = (pairs, operation) => {
        const keys = [...new Set(pairs.map((pair) => JSON.stringify(pair)))]
            .sort()
        const previous = keys.map((key) => queues.get(key) || Promise.resolve())
        const current = Promise.all(previous.map((pending) =>
            pending.catch(() => undefined)
        )).then(operation)
        for (const key of keys) queues.set(key, current)
        current.finally(() => {
            for (const key of keys) {
                if (queues.get(key) === current) queues.delete(key)
            }
        }).catch(() => undefined)
        return current
    }
    const serialized = (characterId, chatId, operation) => serializedMany(
        [[characterId, chatId]],
        operation
    )
    return {
        ...memory,
        applyDelta: (input) => serialized(
            input.characterId,
            input.chatId,
            () => memory.applyDelta(input)
        ),
        forkMemory: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.destinationCharacterId || input.characterId,
                input.destinationChatId],
        ], () => forkWorkspace({
            userDataDirectory,
            ...input,
        })),
        replaceMemory: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, input.destinationChatId],
        ], () => replaceWorkspace({ userDataDirectory, ...input })),
        removeRebootMemory: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                const removed = await removeRebootWorkspace({
                    userDataDirectory,
                    ...input,
                })
                wiki.invalidateCache(input.characterId, input.chatId)
                return removed
            }
        ),
        completeMemoryFork: (input) => serialized(
            input.characterId,
            input.destinationChatId,
            async () => {
                const completed = await completeForkWorkspace({
                    userDataDirectory,
                    ...input,
                })
                wiki.invalidateCache(
                    input.characterId,
                    input.destinationChatId
                )
                return completed
            }
        ),
        createMemorySave: (input) => serializedMany([
            [input.characterId, input.sourceChatId],
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
        ], async () => {
            const view = await wiki.loadView(
                input.characterId,
                input.sourceChatId
            )
            const latest = view.documents
                .filter((document) => document.type === 'event'
                    && document.status === 'active')
                .sort((left, right) =>
                    (right.created || '').localeCompare(left.created || '')
                    || right.id.localeCompare(left.id)
                )[0]
            const excerpt = latest?.content
                .replace(/^#\s+[^\r\n]+\r?\n*/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 500)
            return createSaveSlot({
                userDataDirectory,
                ...input,
                ...(latest ? {
                    latestEvent: {
                        title: latest.title,
                        excerpt: excerpt || latest.title,
                    },
                } : {}),
            })
        }),
        listMemorySaves: (input) => listSaveSlots({
            userDataDirectory,
            ...input,
        }),
        previewMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => previewSaveSlot({ userDataDirectory, ...input })
        ),
        renameMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => renameSaveSlot({ userDataDirectory, ...input })
        ),
        deleteMemorySave: (input) => serialized(
            input.characterId,
            memorySaveWorkspaceId(input.saveId),
            () => deleteSaveSlot({ userDataDirectory, ...input })
        ),
        prepareMemorySaveLoad: (input) => serializedMany([
            [input.characterId, memorySaveWorkspaceId(input.saveId)],
            [input.characterId, input.destinationChatId],
        ], () => prepareSaveLoad({
            userDataDirectory,
            ...input,
        })),
        loadGraphState: (characterId, chatId) =>
            graph.loadState(characterId, chatId),
        applyGraphDelta: (input) => serialized(
            input.characterId,
            input.chatId,
            () => graph.applyDelta(input)
        ),
        reconcileGraphV1: (characterId, chatId) => serialized(
            characterId,
            chatId,
            () => graph.reconcileV1(characterId, chatId)
        ),
        hydrateGraphIndex: (characterId, chatId) => serialized(
            characterId,
            chatId,
            () => graph.hydrateIndex(characterId, chatId)
        ),
        readGraphForInquiry: (characterId, chatId) =>
            graph.readForInquiry(characterId, chatId),
        inquireNarrative: (input) => wiki.inquire(input),
        saveMarkdownWikiTurn: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.saveConfirmedTurn(input)
        ),
        saveCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.saveCanonicalDocument(input)
        ),
        reviewCanonicalWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.reviewCanonicalDocument(input)
        ),
        beginBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.beginBardChatUndo(input)
        ),
        finalizeBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.finalizeBardChatUndo(input)
        ),
        getBardChatUndoStatus: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.getBardChatUndoStatus(input)
        ),
        restoreBardChatUndo: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.restoreBardChatUndo(input)
        ),
        saveManualWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.saveManualDocument(input)
        ),
        replaceWikiText: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.replaceAllText(input)
        ),
        setWikiDocumentContextMode: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.setDocumentContextMode(input)
        ),
        trashWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.trashDocument(input)
        ),
        retractWikiEvent: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.retractEvent(input)
        ),
        retractWikiEventsBySourceMessages: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.retractEventsBySourceMessages(input)
        ),
        revealWikiDocument: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => {
                revealFile(await wiki.resolveDocumentFile(input))
                return { ok: true }
            }
        ),
        beginWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.beginRebootBatch(input)
        ),
        recordWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.recordRebootBatchReceipt(input)
        ),
        recoverWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            async () => ({ receipt: await wiki.recoverRebootBatch(input) })
        ),
        completeWikiRebootBatch: (input) => serialized(
            input.characterId,
            input.chatId,
            () => wiki.completeRebootBatch(input)
        ),
        recordGraphAnalysis: (characterId, chatId, result) => serialized(
            characterId,
            chatId,
            () => graph.recordAnalysis(characterId, chatId, result)
        ),
        async applyWriterCommand(input) {
            return serialized(input.characterId, input.chatId, async () => {
                const snapshot = structuredClone(input)
                try {
                    return await graph.applyWriterCommand(snapshot)
                }
                catch (error) {
                    if (!(error instanceof Error)
                        || error.message
                            !== 'Writer graph persistence failed') {
                        throw error
                    }
                    try {
                        await graph.reconcileV1(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // Dirty graph fallback remains authoritative.
                    }
                    throw error
                }
            })
        },
        async loadView(characterId, chatId) {
            return serialized(characterId, chatId, async () => {
                return wiki.loadView(characterId, chatId)
            })
        },
        async ensureSourceSnapshot(characterId, chatId, snapshot) {
            return serialized(characterId, chatId, async () => {
                const stored = await sources.loadSnapshot(characterId, chatId)
                const selected = stored
                    || await sources.saveSnapshot(characterId, chatId, snapshot)
                return {
                    snapshot: selected,
                    baseline: await sources.loadBaseline(characterId, chatId),
                }
            })
        },
        async saveSourceBaseline(characterId, chatId, summary) {
            return serialized(characterId, chatId, async () => {
                const existing = await sources.loadBaseline(characterId, chatId)
                return existing
                    || sources.saveBaseline(characterId, chatId, summary)
            })
        },
    }
}

module.exports = {
    createRuntimeMemoryService,
}
