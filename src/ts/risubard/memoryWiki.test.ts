import { describe, expect, it, vi } from 'vitest'
import {
    loadNarrativeMemoryWiki,
    revealWikiDocument,
    saveManualWikiDocument,
    setWikiDocumentContextMode,
    trashWikiDocument,
    retractWikiEvent,
    retractWikiEventsBySourceMessages,
    reviewCanonicalWikiDocument,
} from './memoryWiki'

describe('loadNarrativeMemoryWiki', () => {
    it('saves an AI-free Markdown page through the authenticated manual route', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'concept.oath',
            type: 'concept',
            status: 'active',
            title: '성약',
            aliases: ['맹약'],
            relativePath: 'concepts/성약-oath.md',
            sourceMessageIds: [],
            created: '2026-08-08T00:00:00.000Z',
            updated: '2026-08-08T00:00:00.000Z',
            authoring: 'manual',
            content: '# 성약\n\n직접 기록.',
            links: [],
            contextMode: 'auto',
            contentHash: 'hash-oath',
        }))) as unknown as typeof fetch

        await expect(saveManualWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'concept',
            title: '성약',
            aliases: ['맹약'],
            markdown: '# 성약\n\n직접 기록.',
            fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual(expect.objectContaining({
            id: 'concept.oath',
            authoring: 'manual',
        }))
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/document/manual-save',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character',
                    chatId: 'chat',
                    type: 'concept',
                    title: '성약',
                    aliases: ['맹약'],
                    markdown: '# 성약\n\n직접 기록.',
                }),
            })
        )
    })

    it('updates one canonical document context mode with a hash precondition', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'concept.oath', type: 'concept', status: 'active',
            title: '성약', relativePath: 'concepts/성약-oath.md',
            sourceMessageIds: [], updated: '2026-08-09T00:00:00.000Z',
            content: '# 성약', links: [], authoring: 'manual',
            contextMode: 'always', contentHash: 'hash-next',
        }))) as unknown as typeof fetch

        await expect(setWikiDocumentContextMode({
            characterId: 'character', chatId: 'chat',
            documentId: 'concept.oath', contextMode: 'always',
            expectedContentHash: 'hash-oath', fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toMatchObject({ contextMode: 'always' })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/document/context-mode',
            expect.objectContaining({
                body: JSON.stringify({
                    characterId: 'character', chatId: 'chat',
                    documentId: 'concept.oath', contextMode: 'always',
                    expectedContentHash: 'hash-oath',
                }),
            })
        )
    })

    it('moves a canonical page to trash through an authenticated request', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'concept.oath',
            trashed: true,
        }))) as unknown as typeof fetch

        await expect(trashWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: 'concept.oath',
            fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual({ id: 'concept.oath', trashed: true })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/document/trash',
            expect.objectContaining({ method: 'POST' })
        )
    })

    it('retracts one event through an authenticated hash-guarded request', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'event.turn-1', type: 'event', status: 'retracted',
            title: '잘못된 첫 만남', relativePath: 'events/turn-1.md',
            sourceMessageIds: ['assistant-1'],
            updated: '2026-08-12T00:00:00.000Z',
            content: '# 잘못된 첫 만남', links: [], authoring: 'automatic',
            contextMode: 'auto', contentHash: 'hash-retracted',
        }))) as unknown as typeof fetch

        await expect(retractWikiEvent({
            characterId: 'character', chatId: 'chat',
            documentId: 'event.turn-1', expectedContentHash: 'hash-active',
            fetchImpl, createAuth: async () => 'token',
        })).resolves.toMatchObject({ status: 'retracted' })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/event/retract',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character', chatId: 'chat',
                    documentId: 'event.turn-1',
                    expectedContentHash: 'hash-active',
                }),
            })
        )
    })

    it('rejects an invalid event retraction receipt', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'event.turn-1', type: 'event', status: 'active',
            contentHash: 'hash-active',
        }))) as unknown as typeof fetch

        await expect(retractWikiEvent({
            characterId: 'character', chatId: 'chat',
            documentId: 'event.turn-1', expectedContentHash: 'hash-active',
            fetchImpl, createAuth: async () => 'token',
        })).rejects.toThrow('Invalid wiki event retraction receipt')
    })

    it('retracts events linked to confirmed messages before chat deletion', async () => {
        const fetchMock = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => new Response(JSON.stringify({
            retractedIds: ['event.turn-1'],
        })))
        const fetchImpl = fetchMock as unknown as typeof fetch
        const sourceMessageIds = Array.from(
            { length: 101 },
            (_, index) => `message-${index}`
        )

        await expect(retractWikiEventsBySourceMessages({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds, fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual({ retractedIds: ['event.turn-1'] })
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/event/retract-sources',
            expect.objectContaining({ method: 'POST' })
        )
        const request = fetchMock.mock.calls[0]?.[1] as RequestInit
        expect(JSON.parse(String(request.body)).sourceMessageIds)
            .toEqual(sourceMessageIds)
    })

    it('accepts or reverts a canonical review through an authenticated request', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'character.lavian', type: 'character', status: 'active',
            title: '라비안', relativePath: 'characters/lavian.md',
            sourceMessageIds: ['turn-1'], updated: '2026-08-11T00:00:00.000Z',
            content: '# 라비안\n\n창을 든다.', links: [],
            authoring: 'ai-assisted', contextMode: 'auto',
            contentHash: 'hash-reviewed', reviewStatus: 'reviewed',
        }))) as unknown as typeof fetch
        await expect(reviewCanonicalWikiDocument({
            characterId: 'character', chatId: 'chat',
            documentId: 'character.lavian', action: 'accept',
            expectedContentHash: 'hash-current', fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toMatchObject({ reviewStatus: 'reviewed' })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/document/review',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character', chatId: 'chat',
                    documentId: 'character.lavian', action: 'accept',
                    expectedContentHash: 'hash-current',
                }),
            })
        )
    })

    it('accepts a deleted receipt when reverting a newly automatic canonical', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            id: 'scene.current', reverted: true, deleted: true,
        }))) as unknown as typeof fetch
        await expect(reviewCanonicalWikiDocument({
            characterId: 'character', chatId: 'chat',
            documentId: 'scene.current', action: 'revert',
            expectedContentHash: 'hash-current', fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual({
            id: 'scene.current', reverted: true, deleted: true,
        })
    })

    it('requests the operating system to reveal a wiki document', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch

        await expect(revealWikiDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: 'character.lavian',
            fetchImpl,
            createAuth: async () => 'token',
        })).resolves.toEqual({ ok: true })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/document/reveal',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character',
                    chatId: 'chat',
                    documentId: 'character.lavian',
                }),
            })
        )
    })

    it('loads Markdown documents without a graph DTO', async () => {
        const wiki = await loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            createAuth: async () => 'token',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'markdown',
                wikiPath: 'C:\\Users\\reader\\RisuBard\\wiki',
                health: {
                    danglingLinks: [{ sourceId: 'event.one', target: '리나' }],
                    unlinkedDocumentIds: ['character.lavian'],
                },
                documents: [{
                    id: 'event.one',
                    type: 'event',
                    status: 'superseded',
                    supersededBy: 'event.two',
                    title: '약속',
                    relativePath: 'events/turn-one.md',
                    sourceMessageIds: ['message-1'],
                    updated: '2026-08-08T00:00:00.000Z',
                    content: '# 약속\n\n[[리나]]가 돌아오겠다고 약속했다.',
                    links: ['리나'],
                    contextMode: 'auto',
                    contentHash: 'hash-event',
                }, {
                    id: 'character.lavian',
                    type: 'character',
                    status: 'active',
                    title: '라비안',
                    relativePath: 'characters/라비안.md',
                    sourceMessageIds: ['message-1'],
                    updated: '2026-08-08T00:00:00.000Z',
                    content: '# 라비안\n\n현재 상태.',
                    links: [],
                    contextMode: 'always',
                    contentHash: 'hash-character',
                }],
            }))),
        })

        expect(wiki).toEqual({
            mode: 'markdown',
            wikiPath: 'C:\\Users\\reader\\RisuBard\\wiki',
            health: {
                danglingLinks: [{ sourceId: 'event.one', target: '리나' }],
                unlinkedDocumentIds: ['character.lavian'],
            },
            documents: [
                expect.objectContaining({
                    title: '약속',
                    relativePath: 'events/turn-one.md',
                    links: ['리나'],
                    status: 'superseded',
                    supersededBy: 'event.two',
                }),
                expect.objectContaining({
                    type: 'character',
                    title: '라비안',
                }),
            ],
        })
    })

    it('loads the authenticated read-only view for one chat', async () => {
        const view = {
            mode: 'v1' as const,
            reason: 'missing-or-stale-v2-index' as const,
            baseline: 'Current situation',
            state: {
                facts: [{
                    id: 'fact',
                    text: 'The door is open.',
                    status: 'active' as const,
                    evidence: [{
                        chatId: 'chat',
                        messageId: 'message-1',
                    }],
                }],
                events: [],
            },
        }
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify(view),
            {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }
        )) as unknown as typeof fetch

        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl,
            createAuth: async () => 'auth-token',
        })).resolves.toEqual(view)
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/view',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'risu-auth': 'auth-token',
                }),
                body: JSON.stringify({
                    characterId: 'character',
                    chatId: 'chat',
                }),
            })
        )
    })

    it('rejects failed responses', async () => {
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response('', {
                status: 500,
            })) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow(/500/)
    })

    it('calls browser fetch with the Window-compatible global receiver', async () => {
        const fetchImpl = vi.fn(function (this: unknown) {
            expect(this).toBe(globalThis)
            return Promise.resolve(new Response(JSON.stringify({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                baseline: null,
                state: {
                    facts: [],
                    events: [],
                },
            })))
        }) as unknown as typeof fetch

        await loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl,
            createAuth: async () => 'auth-token',
        })
    })

    it('rejects an unknown memory view mode', async () => {
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'future',
                baseline: null,
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view')
    })

    it('rejects a v2 graph outside the requested story scope', async () => {
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v2',
                baseline: null,
                graph: {
                    schemaVersion: 2,
                    storyId: 'other-character',
                    branchId: 'chat',
                    revision: 1,
                    nodes: [],
                    edges: [],
                },
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view scope')
    })

    it('loads a node-and-edge-only v2 graph snapshot', async () => {
        const view = {
            mode: 'v2' as const,
            baseline: null,
            graph: {
                schemaVersion: 2 as const,
                storyId: 'character',
                branchId: 'chat',
                revision: 1,
                nodes: [],
                edges: [],
            },
        }
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(
                JSON.stringify(view)
            )) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).resolves.toEqual(view)
    })

    it('rejects cross-chat evidence in a v1 compatibility view', async () => {
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                baseline: null,
                state: {
                    facts: [{
                        id: 'fact',
                        text: 'Fact',
                        status: 'active',
                        evidence: [{
                            chatId: 'other-chat',
                            messageId: 'message-1',
                        }],
                    }],
                    events: [],
                },
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view evidence')
    })

    it.each([
        {
            facts: [{
                id: 'fact',
                text: 'Fact',
                status: 'active',
                evidence: [],
            }],
            events: [],
        },
        {
            facts: [],
            events: [{
                id: 'event',
                summary: 'Event',
                evidence: [],
            }],
        },
    ])('rejects v1 facts and events without evidence', async (state) => {
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                baseline: null,
                state: {
                    ...state,
                },
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view evidence')
    })

    it.each([
        ['node evidence', {
            evidence: [{
                chatId: 'other-chat',
                messageId: 'message-1',
            }],
        }],
        ['node status evidence', {
            statusEvidence: [{
                chatId: 'other-chat',
                messageId: 'message-2',
            }],
        }],
    ])('rejects cross-chat %s in a v2 graph', async (
        _label,
        nodePatch
    ) => {
        const node = {
            id: 'entity:lina',
            kind: 'entity',
            subtype: 'character',
            title: 'Lina',
            summary: 'Lina',
            storyId: 'character',
            branchId: 'chat',
            status: 'active',
            authority: 'draft',
            salience: 5,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: 'chat',
                messageId: 'message-1',
            }],
            revision: 1,
            ...nodePatch,
        }
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v2',
                baseline: null,
                graph: {
                    schemaVersion: 2,
                    storyId: 'character',
                    branchId: 'chat',
                    revision: 1,
                    nodes: [node],
                    edges: [],
                },
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view evidence')
    })

    it('rejects cross-chat edge evidence in a v2 graph', async () => {
        const makeNode = (id: string, kind = 'entity') => ({
            id,
            kind,
            subtype: kind === 'event' ? 'event' : 'character',
            title: id,
            summary: id,
            storyId: 'character',
            branchId: 'chat',
            status: 'active',
            authority: 'draft',
            salience: 5,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: 'chat',
                messageId: 'message-1',
            }],
            revision: 1,
        })
        await expect(loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v2',
                baseline: null,
                graph: {
                    schemaVersion: 2,
                    storyId: 'character',
                    branchId: 'chat',
                    revision: 1,
                    nodes: [
                        makeNode('event:arrival', 'event'),
                        makeNode('entity:kain'),
                    ],
                    edges: [{
                        id: 'edge:involves',
                        sourceId: 'event:arrival',
                        type: 'involves',
                        targetId: 'entity:kain',
                        storyId: 'character',
                        branchId: 'chat',
                        evidence: [{
                            chatId: 'other-chat',
                            messageId: 'message-2',
                        }],
                        revision: 1,
                    }],
                },
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })).rejects.toThrow('Invalid RisuVault memory view evidence')
    })

    it('parses body-free runtime inquiry and analysis observability', async () => {
        const observability = {
            requestGraphNodeInspections: 0,
            requestIndexBuilds: 0,
            lastPromptMode: 'v2-current',
            graphRevision: 7,
            indexRevision: 7,
            cacheStatus: 'current',
            lastInquiry: {
                candidateCount: 9,
                inspectedNodeCount: 9,
                inspectedEdgeCount: 24,
                selectedNodeCount: 4,
                selectedTokens: 88,
                hopCount: 1,
                auxiliaryModelCalls: 0,
            },
            lastAnalysis: {
                status: 'success',
                appliedCount: 3,
            },
        }
        const wiki = await loadNarrativeMemoryWiki({
            characterId: 'character',
            chatId: 'chat',
            fetchImpl: vi.fn(async () => new Response(JSON.stringify({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                baseline: null,
                state: { facts: [], events: [] },
                observability,
            }))) as unknown as typeof fetch,
            createAuth: async () => 'auth-token',
        })

        expect(wiki.observability).toEqual(observability)
        expect(JSON.stringify(wiki.observability)).not.toContain(
            'The bridge collapsed'
        )
    })
})
