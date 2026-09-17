import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { resolveNarrativeGraphWorkspace } from './risubard-graph-workspace'
import { resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'

const require = createRequire(import.meta.url)

describe('RisuBard memory CommonJS runtime', () => {
    test('wires save creation, listing, and prepared loading to storage', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-save-slot-')
        )
        const summary = {
            saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '모험',
            createdAt: '2026-08-14T08:00:00.000Z', turnCount: 4,
        }
        const createSaveSlot = vi.fn(async (input) => ({
            ...summary,
            latestEvent: input.latestEvent,
        }))
        const listSaveSlots = vi.fn(async () => [summary])
        const prepareSaveLoad = vi.fn(async (input) => ({
            chatBytes: Buffer.from([9]), save: summary,
            fork: {
                mode: 'copy', sourceExists: true,
                destinationChatId: input.destinationChatId,
                warnings: [], forkToken: 'token',
            },
        }))
        const previewSaveSlot = vi.fn(async () => Buffer.from([8]))
        const renameSaveSlot = vi.fn(async (input) => ({
            ...summary, sourceChatName: input.name,
        }))
        const deleteSaveSlot = vi.fn(async () => undefined)
        const service = createRuntimeMemoryService(userDataDirectory, {
            createSaveSlot, listSaveSlots, prepareSaveLoad,
            previewSaveSlot, renameSaveSlot, deleteSaveSlot,
        })

        await service.saveMarkdownWikiTurn({
            characterId: 'character', chatId: 'chat-1',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 성문이 열렸다\n\n경비병이 통행을 허락했다.',
        })
        await expect(service.createMemorySave({
            characterId: 'character', sourceChatId: 'chat-1',
            saveId: 'save-1', sourceChatName: '모험', turnCount: 4,
            chatBytes: Buffer.from([1, 2]),
        })).resolves.toMatchObject({
            saveId: 'save-1',
            latestEvent: { title: '성문이 열렸다' },
        })
        expect(createSaveSlot).toHaveBeenCalledWith(expect.objectContaining({
            userDataDirectory,
            latestEvent: expect.objectContaining({ title: '성문이 열렸다' }),
        }))

        await expect(service.listMemorySaves({
            characterId: 'character', sourceChatId: 'chat-1',
        }))
            .resolves.toEqual([summary])
        expect(listSaveSlots).toHaveBeenCalledWith({
            userDataDirectory, characterId: 'character', sourceChatId: 'chat-1',
        })

        await expect(service.prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1',
            destinationChatId: 'loaded',
        })).resolves.toMatchObject({ fork: { forkToken: 'token' } })
        expect(prepareSaveLoad).toHaveBeenCalledWith({
            userDataDirectory, characterId: 'character',
            saveId: 'save-1', destinationChatId: 'loaded',
        })

        await expect(service.previewMemorySave({
            characterId: 'character', saveId: 'save-1',
        })).resolves.toEqual(Buffer.from([8]))
        await expect(service.renameMemorySave({
            characterId: 'character', saveId: 'save-1', name: '새 이름',
        })).resolves.toMatchObject({ sourceChatName: '새 이름' })
        await expect(service.deleteMemorySave({
            characterId: 'character', saveId: 'save-1',
        })).resolves.toBeUndefined()
        expect(previewSaveSlot).toHaveBeenCalledWith({
            userDataDirectory, characterId: 'character', saveId: 'save-1',
        })
        expect(renameSaveSlot).toHaveBeenCalledWith({
            userDataDirectory, characterId: 'character', saveId: 'save-1',
            name: '새 이름',
        })
        expect(deleteSaveSlot).toHaveBeenCalledWith({
            userDataDirectory, characterId: 'character', saveId: 'save-1',
        })
    })

    test('serializes source writes behind a workspace fork', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-fork-queue-')
        )
        let releaseFork!: () => void
        let markForkStarted!: () => void
        const forkStarted = new Promise<void>((resolve) => {
            markForkStarted = resolve
        })
        const forkGate = new Promise<void>((resolve) => {
            releaseFork = resolve
        })
        const forkWorkspace = vi.fn(async (input) => {
                markForkStarted()
                await forkGate
                return {
                    mode: input.mode,
                    sourceExists: true,
                    destinationChatId: input.destinationChatId,
                    warnings: [],
                    forkToken: 'fork-token',
                }
            })
        const service = createRuntimeMemoryService(userDataDirectory, {
            forkWorkspace,
        })
        const fork = service.forkMemory({
            characterId: 'character', sourceChatId: 'source',
            destinationCharacterId: 'copy-character',
            destinationChatId: 'copy', mode: 'copy',
        })
        await Promise.race([
            forkStarted,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('fork did not start')),
                1_000
            )),
        ])
        expect(forkWorkspace).toHaveBeenCalledOnce()
        let saveFinished = false
        let destinationSaveFinished = false
        const save = service.saveMarkdownWikiTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 사건\n\n포크 뒤에 저장된다.',
        }).then(() => { saveFinished = true })
        const destinationSave = service.saveMarkdownWikiTurn({
            characterId: 'copy-character', chatId: 'copy',
            sourceMessageIds: ['assistant-2'],
            markdown: '# 복제 사건\n\n목적지 포크 뒤에 저장된다.',
        }).then(() => { destinationSaveFinished = true })

        await Promise.resolve()
        expect(saveFinished).toBe(false)
        expect(destinationSaveFinished).toBe(false)
        releaseFork()
        await Promise.all([fork, save, destinationSave])
        expect(saveFinished).toBe(true)
        expect(destinationSaveFinished).toBe(true)
    })

    test('serializes fork completion on the destination workspace', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-fork-complete-')
        )
        const completeForkWorkspace = vi.fn(async (input) => ({
            action: input.action,
            completed: true,
        }))
        const service = createRuntimeMemoryService(userDataDirectory, {
            completeForkWorkspace,
        })

        await expect(service.completeMemoryFork({
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        })).resolves.toEqual({ action: 'finalize', completed: true })
        expect(completeForkWorkspace).toHaveBeenCalledWith({
            userDataDirectory,
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        })
    })

    test('serializes a bounded Markdown wiki reboot checkpoint', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-snapshot-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        await service.saveManualWikiDocument({
            characterId: 'character', chatId: 'reboot-job', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n이전 상태.',
        })

        await expect(service.beginWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job',
            sourceMessageIds: ['user-1', 'assistant-1'],
            eventSourceGroups: [['user-1', 'assistant-1']],
        })).resolves.toMatchObject({ canonicalCount: 1 })
        const receipt = {
            sourceMessageIds: ['user-1', 'assistant-1'], eventIds: [],
            changes: [], warnings: [], recordedAt: 'now',
        }
        await expect(service.recordWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job', receipt,
        })).resolves.toEqual(receipt)
        await expect(service.completeWikiRebootBatch({
            characterId: 'character', chatId: 'reboot-job',
            sourceMessageIds: receipt.sourceMessageIds,
        })).resolves.toEqual({ removed: true })
    })

    test('reveals only a persisted wiki document path through the injected opener', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-reveal-')
        )
        const revealFile = vi.fn()
        const service = createRuntimeMemoryService(userDataDirectory, {
            revealFile,
        })
        const page = await service.saveManualWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            markdown: '# 라비안\n\n기사.',
        })

        await expect(service.revealWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: page.id,
        })).resolves.toEqual({ ok: true })
        const workspace = resolveMarkdownWikiWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        expect(revealFile).toHaveBeenCalledWith(join(
            workspace.directory,
            ...page.relativePath.split('/')
        ))
    })

    test('does not create a workspace when viewing an empty chat', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-empty-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character',
            'empty-chat'
        )

        await expect(service.loadView(
            'character',
            'empty-chat'
        )).resolves.toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'empty-chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })
        await expect(access(workspace.directory)).rejects.toMatchObject({
            code: 'ENOENT',
        })
    })

    test('loads the TypeScript persistence service from the production runtime', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)

        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'append-event',
                    operationId: 'operation-1',
                    eventId: 'event-1',
                    summary: 'The door opened.',
                    evidence: [{
                        chatId: 'chat',
                        messageId: 'message-1',
                    }],
                }],
            },
            availableEvidence: [{
                chatId: 'chat',
                messageId: 'message-1',
            }],
        })

        const state = await service.loadState('character', 'chat')
        expect(state.events).toHaveLength(1)
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        const events = await readFile(workspace.eventsFile, 'utf8')
        expect(events).toContain('"operationId":"operation-1"')

        await service.saveSourceBaseline(
            'character',
            'chat',
            'Current situation'
        )
        const view = await service.loadView('character', 'chat')
        expect(view).toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })
    })

    test('loads and persists strict v2 graph state from the production runtime', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-graph-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-1',
        }]

        await service.applyGraphDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                operations: [{
                    type: 'add-node',
                    operationId: 'graph-operation-1',
                    node: {
                        id: 'entity:lina',
                        kind: 'entity',
                        subtype: 'character',
                        title: 'Lina',
                        summary: 'Lina is cautious.',
                        storyId: 'character',
                        branchId: 'chat',
                        status: 'active',
                        authority: 'draft',
                        salience: 5,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                }],
            },
            availableEvidence: evidence,
        })

        await expect(service.loadGraphState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            revision: 1,
            nodes: [{ id: 'entity:lina' }],
        })
        await expect(service.readGraphForInquiry(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'v2',
            index: { revision: 1 },
        })
        const view = await service.loadView(
            'character',
            'chat'
        )
        expect(view).toEqual({
            mode: 'markdown',
            wikiPath: resolveMarkdownWikiWorkspace(
                userDataDirectory,
                'character',
                'chat'
            ).directory,
            health: {
                danglingLinks: [],
                unlinkedDocumentIds: [],
                duplicatePassages: [],
            },
            documents: [],
        })

        const restarted = createRuntimeMemoryService(userDataDirectory)
        await expect(restarted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })

        const graphWorkspace = resolveNarrativeGraphWorkspace(
            userDataDirectory,
            'character',
            'chat'
        )
        await writeFile(graphWorkspace.stateFile, '{broken', 'utf8')
        const corrupted = createRuntimeMemoryService(userDataDirectory)
        await expect(corrupted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })
    })

    test('reconciles a dirty graph from current v1 state', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-reconcile-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-1',
        }]
        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'add-fact',
                    operationId: 'operation-fact',
                    factId: 'door-state',
                    text: 'The door is open.',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })
        await expect(service.applyGraphDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:door-state',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow()
        await expect(service.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })

        await expect(service.reconcileGraphV1(
            'character',
            'chat'
        )).resolves.toMatchObject({
            nodes: [{
                id: 'claim:v1:door-state',
                status: 'active',
            }],
        })
        await expect(service.readGraphForInquiry(
            'character',
            'chat'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('promotes an existing mention into v1 prompt memory and native v2 character state', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-writer-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)
        const evidence = [{
            chatId: 'chat',
            messageId: 'message-market',
        }]
        await service.applyDelta({
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'append-event',
                    operationId: 'market-event',
                    eventId: 'market-collision',
                    summary:
                        'The protagonist collided with a blue-haired elf.',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })
        await service.reconcileGraphV1('character', 'chat')
        const command = {
            schemaVersion: 1,
            type: 'promote-character',
            commandId: 'promotion-eliana',
            storyId: 'character',
            branchId: 'chat',
            sourceNodeId: 'event:v1:market-collision',
            name: 'Eliana',
            summary: 'Eliana is the blue-haired elf from the market.',
            salience: 9,
        }

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 1,
            command,
        })).resolves.toEqual({ revision: 2 })

        await expect(service.loadState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            facts: [{
                id: 'writer:promotion-eliana:character-fact',
                text: 'Eliana is the blue-haired elf from the market.',
                status: 'active',
            }],
        })
        await expect(service.loadGraphState(
            'character',
            'chat'
        )).resolves.toMatchObject({
            revision: 2,
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    id: 'entity:writer:promotion-eliana',
                    kind: 'entity',
                    authority: 'canonical',
                }),
                expect.objectContaining({
                    id:
                        'claim:v1:writer:promotion-eliana:character-fact',
                }),
            ]),
            edges: expect.arrayContaining([
                expect.objectContaining({
                    type: 'involves',
                    targetId: 'entity:writer:promotion-eliana',
                }),
                expect.objectContaining({
                    type: 'about',
                    targetId: 'entity:writer:promotion-eliana',
                }),
            ]),
        })

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 2,
            command,
        })).resolves.toEqual({ revision: 2 })

        const restarted = createRuntimeMemoryService(userDataDirectory)
        await expect(restarted.loadView(
            'character',
            'chat'
        )).resolves.toMatchObject({
            mode: 'markdown',
            documents: [],
        })
    })

    test('rejects a stale writer revision before changing v1 memory', async () => {
        const { createRuntimeMemoryService } = require(
            './risubard-memory-runtime.cjs'
        )
        const userDataDirectory = await mkdtemp(
            join(tmpdir(), 'risubard-runtime-writer-stale-')
        )
        const service = createRuntimeMemoryService(userDataDirectory)

        await expect(service.applyWriterCommand({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 1,
            command: {
                schemaVersion: 1,
                type: 'promote-character',
                commandId: 'promotion-eliana',
                storyId: 'character',
                branchId: 'chat',
                sourceNodeId: 'event:v1:market-collision',
                name: 'Eliana',
                summary: 'Eliana is the blue-haired elf from the market.',
                salience: 9,
            },
        })).rejects.toThrow('Writer graph revision is stale')

        await expect(service.loadState(
            'character',
            'chat'
        )).resolves.toMatchObject({ facts: [], events: [] })
    })
})
