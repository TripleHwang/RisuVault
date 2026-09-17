import { safeStructuredClone } from '../polyfill'
import type { loreBook } from '../storage/database.svelte'
import {
    applyMaterializedBardLoreEntries,
    createBardLoreEntry,
    createBardLoreSettings,
    materializeBardLoreEntries,
    normalizeBardLoreState,
    type BardLoreEntry,
    type BardLoreMetadata,
    type BardLoreState,
} from './bardLore'

export const BARD_LORE_PORTABLE_TYPE = 'risubard-bard-lore-metadata'
export const BARD_LORE_PORTABLE_VERSION = 1

interface PortableDerivedEntry {
    key: string
    secondkey: string
    insertorder: number
    comment: string
    content: string
}

interface PortableLink {
    targetHandle: string
    relation: string
    retrieval: BardLoreMetadata['links'][number]['retrieval']
}

interface PortableMetadata extends Omit<BardLoreMetadata, 'sourceLegacyId' | 'sourceHash' | 'derivedFromId' | 'links'> {
    links: PortableLink[]
}

interface PortableEntry {
    handle: string
    sourceLegacyId: string
    sourceHash: string
    derivedFromHandle?: string
    derived?: PortableDerivedEntry
    metadata: PortableMetadata
}

export interface BardLorePortablePackage {
    type: typeof BARD_LORE_PORTABLE_TYPE
    version: typeof BARD_LORE_PORTABLE_VERSION
    characterName?: string
    exportedAt: string
    entries: PortableEntry[]
}

export interface BardLoreMetadataImportReport {
    applied: number
    createdDerived: number
    skipped: number
    unresolvedLinks: number
}

export interface BardLoreMetadataImportResult {
    state: BardLoreState
    report: BardLoreMetadataImportReport
}

export class BardLorePortableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BardLorePortableError'
    }
}

function portableMetadata(entry: BardLoreEntry, validIds: Set<string>): PortableMetadata {
    return {
        kind: entry.bard.kind,
        activation: entry.bard.activation,
        aliases: [...entry.bard.aliases],
        tags: [...entry.bard.tags],
        summary: entry.bard.summary,
        facets: safeStructuredClone(entry.bard.facets),
        injection: entry.bard.injection,
        links: entry.bard.links.flatMap((link) => validIds.has(link.targetId)
            ? [{ targetHandle: link.targetId, relation: link.relation, retrieval: link.retrieval }]
            : []),
    }
}

export function exportBardLoreMetadata(
    state: BardLoreState,
    legacyEntries: loreBook[],
    characterName?: string,
): string {
    const materialized = materializeBardLoreEntries(state, legacyEntries)
    const validIds = new Set(materialized.map((entry) => entry.id))
    const entries = materialized.map((entry): PortableEntry => ({
        handle: entry.id,
        sourceLegacyId: entry.bard.sourceLegacyId,
        sourceHash: entry.bard.sourceHash,
        ...(entry.bard.derivedFromId
            ? {
                derivedFromHandle: entry.bard.derivedFromId,
                derived: {
                    key: entry.key,
                    secondkey: entry.secondkey,
                    insertorder: entry.insertorder,
                    comment: entry.comment,
                    content: entry.content,
                },
            }
            : {}),
        metadata: portableMetadata(entry, validIds),
    }))
    const portable: BardLorePortablePackage = {
        type: BARD_LORE_PORTABLE_TYPE,
        version: BARD_LORE_PORTABLE_VERSION,
        ...(characterName?.trim() ? { characterName: characterName.trim() } : {}),
        exportedAt: new Date().toISOString(),
        entries,
    }
    return JSON.stringify(portable, null, 2)
}

function parsePortable(value: string | unknown): BardLorePortablePackage {
    let parsed: unknown = value
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value)
        }
        catch {
            throw new BardLorePortableError('Grimoire metadata file is not valid JSON.')
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BardLorePortableError('Grimoire metadata package must be an object.')
    }
    const raw = parsed as Record<string, unknown>
    if (raw.type !== BARD_LORE_PORTABLE_TYPE || raw.version !== BARD_LORE_PORTABLE_VERSION || !Array.isArray(raw.entries)) {
        throw new BardLorePortableError('Unsupported Grimoire metadata package.')
    }
    if (raw.characterName !== undefined && typeof raw.characterName !== 'string') {
        throw new BardLorePortableError('Invalid Grimoire character name.')
    }
    if (typeof raw.exportedAt !== 'string') {
        throw new BardLorePortableError('Invalid Grimoire export timestamp.')
    }

    const handles = new Set<string>()
    const provisional: Array<PortableEntry & { rawMetadata: Record<string, unknown> }> = []
    for (const valueEntry of raw.entries) {
        if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) {
            throw new BardLorePortableError('Invalid Grimoire metadata entry.')
        }
        const item = valueEntry as Record<string, unknown>
        if (
            typeof item.handle !== 'string'
            || !item.handle.trim()
            || handles.has(item.handle)
            || typeof item.sourceLegacyId !== 'string'
            || typeof item.sourceHash !== 'string'
            || !item.metadata
            || typeof item.metadata !== 'object'
            || Array.isArray(item.metadata)
            || (item.derivedFromHandle !== undefined && typeof item.derivedFromHandle !== 'string')
        ) throw new BardLorePortableError('Invalid or duplicate Grimoire metadata identity.')
        handles.add(item.handle)
        const derivedFromHandle = typeof item.derivedFromHandle === 'string'
            ? item.derivedFromHandle
            : undefined
        let derived: PortableDerivedEntry | undefined
        if (item.derived !== undefined) {
            if (!item.derived || typeof item.derived !== 'object' || Array.isArray(item.derived)) {
                throw new BardLorePortableError('Invalid Grimoire derived entry.')
            }
            const rawDerived = item.derived as Record<string, unknown>
            if (
                typeof rawDerived.key !== 'string'
                || typeof rawDerived.secondkey !== 'string'
                || typeof rawDerived.insertorder !== 'number'
                || !Number.isFinite(rawDerived.insertorder)
                || typeof rawDerived.comment !== 'string'
                || typeof rawDerived.content !== 'string'
                || !rawDerived.content
            ) throw new BardLorePortableError('Invalid Grimoire derived entry fields.')
            derived = rawDerived as unknown as PortableDerivedEntry
        }
        if (Boolean(derivedFromHandle) !== Boolean(derived)) {
            throw new BardLorePortableError('Derived Grimoire entries require both parent and source quote.')
        }
        provisional.push({
            handle: item.handle,
            sourceLegacyId: item.sourceLegacyId,
            sourceHash: item.sourceHash,
            ...(derivedFromHandle ? { derivedFromHandle } : {}),
            ...(derived ? { derived } : {}),
            metadata: undefined as never,
            rawMetadata: item.metadata as Record<string, unknown>,
        })
    }

    for (const item of provisional) {
        if (item.derivedFromHandle && !handles.has(item.derivedFromHandle)) {
            throw new BardLorePortableError('Derived Grimoire parent is missing from the package.')
        }
        const links = item.rawMetadata.links
        if (!Array.isArray(links)) throw new BardLorePortableError('Invalid Grimoire metadata links.')
        for (const valueLink of links) {
            if (!valueLink || typeof valueLink !== 'object' || Array.isArray(valueLink)) {
                throw new BardLorePortableError('Invalid Grimoire metadata link.')
            }
            const link = valueLink as Record<string, unknown>
            if (typeof link.targetHandle !== 'string' || !handles.has(link.targetHandle)) {
                throw new BardLorePortableError('Grimoire metadata link target is missing from the package.')
            }
        }
    }

    const validationState = normalizeBardLoreState({
        schemaVersion: 1,
        mode: 'legacy',
        settings: createBardLoreSettings(),
        entries: provisional.map((item) => ({
            id: item.handle,
            key: item.derived?.key ?? '',
            secondkey: item.derived?.secondkey ?? '',
            insertorder: item.derived?.insertorder ?? 0,
            comment: item.derived?.comment ?? item.handle,
            content: item.derived?.content ?? '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
            bard: {
                ...item.rawMetadata,
                sourceLegacyId: item.sourceLegacyId,
                sourceHash: item.sourceHash,
                ...(item.derivedFromHandle ? { derivedFromId: item.derivedFromHandle } : {}),
                links: (item.rawMetadata.links as Array<Record<string, unknown>>).map((link) => ({
                    targetId: link.targetHandle,
                    relation: link.relation,
                    retrieval: link.retrieval,
                })),
            },
        })),
    })
    if (!validationState) throw new BardLorePortableError('Grimoire metadata package failed schema validation.')
    const normalizedByHandle = new Map<string, BardLoreMetadata>()
    const baseItems = provisional.filter((item) => !item.derivedFromHandle)
    baseItems.forEach((item, index) => normalizedByHandle.set(item.handle, validationState.metadata[index]))
    validationState.derivedEntries.forEach((entry) => normalizedByHandle.set(entry.id, entry.bard))
    const entries = provisional.map((item): PortableEntry => {
        const normalized = normalizedByHandle.get(item.handle)!
        return {
            handle: item.handle,
            sourceLegacyId: item.sourceLegacyId,
            sourceHash: item.sourceHash,
            ...(item.derivedFromHandle ? { derivedFromHandle: item.derivedFromHandle } : {}),
            ...(item.derived ? { derived: safeStructuredClone(item.derived) } : {}),
            metadata: {
                kind: normalized.kind,
                activation: normalized.activation,
                aliases: [...normalized.aliases],
                tags: [...normalized.tags],
                summary: normalized.summary,
                facets: safeStructuredClone(normalized.facets),
                injection: normalized.injection,
                links: normalized.links.map((link) => ({
                    targetHandle: link.targetId,
                    relation: link.relation,
                    retrieval: link.retrieval,
                })),
            },
        }
    })
    return {
        type: BARD_LORE_PORTABLE_TYPE,
        version: BARD_LORE_PORTABLE_VERSION,
        ...(raw.characterName ? { characterName: raw.characterName as string } : {}),
        exportedAt: raw.exportedAt,
        entries,
    }
}

function uniqueMatch(entries: BardLoreEntry[], predicate: (entry: BardLoreEntry) => boolean): BardLoreEntry | undefined {
    const matches = entries.filter(predicate)
    return matches.length === 1 ? matches[0] : undefined
}

export function importBardLoreMetadata(
    current: BardLoreState,
    legacyEntries: loreBook[],
    input: string | unknown,
    createId: () => string,
): BardLoreMetadataImportResult {
    const portable = parsePortable(input)
    const entries = materializeBardLoreEntries(current, legacyEntries)
    const report: BardLoreMetadataImportReport = { applied: 0, createdDerived: 0, skipped: 0, unresolvedLinks: 0 }
    const resolved = new Map<string, BardLoreEntry>()
    const usedTargetIds = new Set<string>()
    const baseEntries = entries.filter((entry) => !entry.bard.derivedFromId)
    const baseItems = portable.entries.filter((item) => !item.derivedFromHandle)
    const derivedItems = portable.entries.filter((item) => item.derivedFromHandle)

    for (const item of baseItems) {
        const exact = uniqueMatch(baseEntries, (entry) =>
            !usedTargetIds.has(entry.id)
            && entry.bard.sourceLegacyId === item.sourceLegacyId
            && entry.bard.sourceHash === item.sourceHash,
        )
        const target = exact ?? uniqueMatch(baseEntries, (entry) =>
            !usedTargetIds.has(entry.id) && entry.bard.sourceHash === item.sourceHash,
        )
        if (target) {
            resolved.set(item.handle, target)
            usedTargetIds.add(target.id)
        }
        else report.skipped += 1
    }

    const usedIds = new Set(entries.map((entry) => entry.id))
    for (const item of derivedItems) {
        const parent = resolved.get(item.derivedFromHandle!)
        if (!parent || !item.derived || !parent.content.includes(item.derived.content)) {
            report.skipped += 1
            continue
        }
        const matchesDerived = (entry: BardLoreEntry) =>
            entry.bard.derivedFromId === parent.id
            && (
                entry.bard.sourceHash === item.sourceHash
                || (entry.comment === item.derived!.comment && entry.content === item.derived!.content)
            )
        const existingMatches = entries.filter(matchesDerived)
        let target = uniqueMatch(existingMatches, (entry) => !usedTargetIds.has(entry.id))
        if (!target && existingMatches.length > 0) {
            report.skipped += 1
            continue
        }
        if (!target) {
            let id = !usedIds.has(item.handle) ? item.handle : createId().trim()
            while (!id || usedIds.has(id)) id = createId().trim()
            target = createBardLoreEntry({
                id,
                key: item.derived.key,
                secondkey: item.derived.secondkey,
                insertorder: item.derived.insertorder,
                comment: item.derived.comment,
                content: item.derived.content,
                mode: 'normal',
                alwaysActive: false,
                selective: false,
            })
            target.bard.sourceLegacyId = parent.bard.sourceLegacyId
            target.bard.derivedFromId = parent.id
            entries.push(target)
            usedIds.add(id)
            report.createdDerived += 1
        }
        resolved.set(item.handle, target)
        usedTargetIds.add(target.id)
    }

    for (const item of portable.entries) {
        const target = resolved.get(item.handle)
        if (!target) continue
        const links = item.metadata.links.flatMap((link) => {
            const linkTarget = resolved.get(link.targetHandle)
            if (!linkTarget) {
                report.unresolvedLinks += 1
                return []
            }
            return [{ targetId: linkTarget.id, relation: link.relation, retrieval: link.retrieval }]
        })
        target.bard = {
            ...target.bard,
            kind: item.metadata.kind,
            activation: item.metadata.activation,
            aliases: [...item.metadata.aliases],
            tags: [...item.metadata.tags],
            summary: item.metadata.summary,
            facets: safeStructuredClone(item.metadata.facets),
            injection: item.metadata.injection,
            links,
        }
        report.applied += 1
    }
    if (report.applied === 0 && report.createdDerived === 0) {
        return { state: safeStructuredClone(current), report }
    }
    const state = applyMaterializedBardLoreEntries(current, legacyEntries, entries).state
    if (report.applied > 0) delete state.analysisRun
    return { state, report }
}

export function cleanseBardLoreMetadata<Owner extends { bardLore?: BardLoreState }>(owner: Owner): boolean {
    if (!owner.bardLore) return false
    delete owner.bardLore
    return true
}
