import { describe, expect, it } from 'vitest'
import {
    createBardLoreEntry,
    createBardLoreSettings,
    upgradeLegacyLorebook,
    type BardLoreEntry,
} from './bardLore'
import {
    BardLorePortableError,
    cleanseBardLoreMetadata,
    exportBardLoreMetadata,
    importBardLoreMetadata,
} from './bardLorePortable'
import type { loreBook } from '../storage/database.svelte'

function legacy(id: string, comment: string, content: string): loreBook {
    return {
        id,
        key: comment,
        secondkey: '',
        insertorder: 10,
        comment,
        content,
        mode: 'normal',
        alwaysActive: false,
        selective: false,
    }
}

function upgrade(entries: loreBook[]) {
    return upgradeLegacyLorebook(entries, () => { throw new Error('unexpected ID allocation') }, createBardLoreSettings())
}

describe('Bard Lore portable metadata overlay', () => {
    it('exports approved metadata without serializing ordinary legacy lore bodies', () => {
        const entries = [legacy('school', '월광관 고등학교', '공유하면 안 되는 학교 전체 본문')]
        const state = upgrade(entries)
        state.metadata[0] = {
            ...state.metadata[0],
            kind: 'location',
            aliases: ['학교'],
            tags: ['교육기관'],
            summary: '주요 학교',
            facets: [{ key: 'work', value: 'Persona 3', aliases: ['페르소나 3'] }],
        }

        const exported = exportBardLoreMetadata(state, entries, '페르소나 3')
        const parsed = JSON.parse(exported)

        expect(parsed).toMatchObject({
            type: 'risubard-bard-lore-metadata',
            version: 1,
            characterName: '페르소나 3',
            entries: [expect.objectContaining({
                sourceLegacyId: 'school',
                metadata: expect.objectContaining({ kind: 'location', aliases: ['학교'] }),
            })],
        })
        expect(exported).not.toContain('공유하면 안 되는 학교 전체 본문')
        expect(parsed.entries[0]).not.toHaveProperty('derived')
    })

    it('imports metadata and remaps links by source fingerprint when target IDs differ', () => {
        const sourceEntries = [
            legacy('school-source', '월광관 고등학교', '학교 본문'),
            legacy('shuji-source', '이쿠츠키 슈지', '슈지 본문'),
        ]
        const source = upgrade(sourceEntries)
        source.metadata[0].kind = 'location'
        source.metadata[1] = {
            ...source.metadata[1],
            kind: 'character',
            aliases: ['슈지'],
            links: [{ targetId: 'school-source', relation: 'works_at', retrieval: 'ambient' }],
        }
        const targetEntries = [
            legacy('school-target', '월광관 고등학교', '학교 본문'),
            legacy('shuji-target', '이쿠츠키 슈지', '슈지 본문'),
        ]
        const target = upgrade(targetEntries)
        const before = structuredClone(target)

        const result = importBardLoreMetadata(target, targetEntries, exportBardLoreMetadata(source, sourceEntries), () => 'unused')

        expect(target).toEqual(before)
        expect(result.report).toMatchObject({ applied: 2, createdDerived: 0, skipped: 0, unresolvedLinks: 0 })
        expect(result.state.metadata.map((entry) => entry.sourceLegacyId)).toEqual(['school-target', 'shuji-target'])
        expect(result.state.metadata[1]).toMatchObject({
            kind: 'character',
            aliases: ['슈지'],
            links: [{ targetId: 'school-target', relation: 'works_at', retrieval: 'ambient' }],
        })
    })

    it('reconstructs derived analysis atoms without exporting the composite source body', () => {
        const sourceEntries = [legacy('roster', '주요 인물 명부', '긴 명부 본문\n슈지: 학교 이사장.')]
        const source = upgrade(sourceEntries)
        const atom = createBardLoreEntry(legacy('bard-atom-shuji', '이쿠츠키 슈지', '슈지: 학교 이사장.'))
        atom.bard = {
            ...atom.bard,
            sourceLegacyId: 'roster',
            derivedFromId: 'roster',
            kind: 'character',
            aliases: ['슈지'],
            facets: [{ key: 'role', value: 'chairman', aliases: ['이사장'] }],
        }
        source.derivedEntries.push(atom)
        const exported = exportBardLoreMetadata(source, sourceEntries)
        const targetEntries = [legacy('roster-copy', '주요 인물 명부', '긴 명부 본문\n슈지: 학교 이사장.')]
        const target = upgrade(targetEntries)

        const result = importBardLoreMetadata(target, targetEntries, exported, () => 'imported-shuji')
        const derived = result.state.derivedEntries.find((entry): entry is BardLoreEntry => entry.id === 'bard-atom-shuji')

        expect(exported).not.toContain('긴 명부 본문')
        expect(result.report.createdDerived).toBe(1)
        expect(derived).toMatchObject({
            comment: '이쿠츠키 슈지',
            content: '슈지: 학교 이사장.',
            bard: {
                sourceLegacyId: 'roster-copy',
                derivedFromId: 'roster-copy',
                kind: 'character',
                aliases: ['슈지'],
            },
        })
    })

    it('does not reuse a colliding derived ID when its quoted content differs', () => {
        const sourceEntries = [legacy('roster', 'Roster', 'Imported quote. Existing quote.')]
        const source = upgrade(sourceEntries)
        const importedAtom = createBardLoreEntry(legacy('shared-id', 'Imported', 'Imported quote.'))
        importedAtom.bard = {
            ...importedAtom.bard,
            sourceLegacyId: 'roster',
            derivedFromId: 'roster',
            summary: 'imported metadata',
        }
        source.derivedEntries.push(importedAtom)

        const targetEntries = [legacy('roster', 'Roster', 'Imported quote. Existing quote.')]
        const target = upgrade(targetEntries)
        const existingAtom = createBardLoreEntry(legacy('shared-id', 'Existing', 'Existing quote.'))
        existingAtom.bard = {
            ...existingAtom.bard,
            sourceLegacyId: 'roster',
            derivedFromId: 'roster',
            summary: 'existing metadata',
        }
        target.derivedEntries.push(existingAtom)

        const result = importBardLoreMetadata(
            target,
            targetEntries,
            exportBardLoreMetadata(source, sourceEntries),
            () => 'collision-safe-id',
        )

        expect(result.state.derivedEntries).toHaveLength(2)
        expect(result.state.derivedEntries.find((entry) => entry.id === 'shared-id')?.bard.summary).toBe('existing metadata')
        expect(result.state.derivedEntries.find((entry) => entry.id === 'collision-safe-id')?.bard.summary).toBe('imported metadata')
    })

    it('rejects malformed packages without mutating the current Bard state', () => {
        const state = upgrade([legacy('one', 'One', 'content')])
        const before = structuredClone(state)

        expect(() => importBardLoreMetadata(state, [legacy('one', 'One', 'content')], '{"type":"wrong"}', () => 'new')).toThrow(BardLorePortableError)
        expect(state).toEqual(before)
    })

    it('never maps two portable entries onto the same destination entry', () => {
        const sourceEntries = [
            legacy('duplicate-a', '같은 항목', '동일 본문'),
            legacy('duplicate-b', '같은 항목', '동일 본문'),
        ]
        const source = upgrade(sourceEntries)
        source.metadata[0].summary = '첫 번째 메타데이터'
        source.metadata[1].summary = '두 번째 메타데이터'
        const targetEntries = [legacy('only-target', '같은 항목', '동일 본문')]
        const target = upgrade(targetEntries)

        const result = importBardLoreMetadata(target, targetEntries, exportBardLoreMetadata(source, sourceEntries), () => 'unused')

        expect(result.report).toMatchObject({ applied: 1, skipped: 1 })
        expect(result.state.metadata[0].summary).toBe('첫 번째 메타데이터')
    })

    it('preserves an analysis draft when no portable entry matches', () => {
        const sourceEntries = [legacy('source', 'Source', 'source content')]
        const source = upgrade(sourceEntries)
        const targetEntries = [legacy('target', 'Target', 'different content')]
        const target = upgrade(targetEntries)
        const analysisRun = { status: 'paused', batches: [] } as unknown as NonNullable<typeof target.analysisRun>
        target.analysisRun = analysisRun

        const result = importBardLoreMetadata(target, targetEntries, exportBardLoreMetadata(source, sourceEntries), () => 'unused')

        expect(result.report.applied).toBe(0)
        expect(result.state.analysisRun).toEqual(analysisRun)
    })

    it('cleanses only Bard Lore state and preserves the legacy lorebook byte-for-byte', () => {
        const globalLore = [legacy('one', 'One', 'legacy content')]
        const owner: { globalLore: loreBook[]; bardLore?: ReturnType<typeof upgrade> } = {
            globalLore,
            bardLore: upgrade(globalLore),
        }
        const before = JSON.stringify(globalLore)

        const removed = cleanseBardLoreMetadata(owner)

        expect(removed).toBe(true)
        expect(owner.bardLore).toBeUndefined()
        expect(owner.globalLore).toBe(globalLore)
        expect(JSON.stringify(owner.globalLore)).toBe(before)
    })
})
