export type AutomaticWikiDocumentType = 'character' | 'location' | 'scene'
    | 'faction' | 'creature' | 'item' | 'concept' | 'other'

export interface AutomaticWikiDocumentDescriptor {
    id: string
    type: AutomaticWikiDocumentType | 'event'
    title: string
    aliases?: string[]
}

export interface AutomaticWikiTarget {
    documentId?: string
    type: AutomaticWikiDocumentType
    title: string
}

const canonicalTypes = new Set<AutomaticWikiDocumentType>([
    'character', 'location', 'scene', 'faction', 'creature', 'item',
    'concept', 'other',
])

export function parseAutomaticWikiTargets(
    output: string,
    documents: readonly AutomaticWikiDocumentDescriptor[]
): AutomaticWikiTarget[] {
    if (typeof output !== 'string' || output.trim() === 'NONE') return []
    const known = new Map(documents
        .filter((document) => document.type !== 'event')
        .map((document) => [document.id, document]))
    const targets: AutomaticWikiTarget[] = []
    const seen = new Set<string>()
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim()
        const update = line.match(/^UPDATE\s+(\S+)$/)
        if (update) {
            const document = known.get(update[1])
            if (!document || seen.has(`id:${document.id}`)) continue
            seen.add(`id:${document.id}`)
            targets.push({
                documentId: document.id,
                type: document.type as AutomaticWikiDocumentType,
                title: document.title,
            })
        }
        const create = line.match(/^CREATE\s+(\S+)\s+(.{1,160})$/)
        if (create && canonicalTypes.has(create[1] as AutomaticWikiDocumentType)) {
            const type = create[1] as AutomaticWikiDocumentType
            const title = create[2].trim()
            const key = `new:${type}:${title.normalize('NFKC').toLocaleLowerCase()}`
            if (title && !seen.has(key)) {
                seen.add(key)
                targets.push({ type, title })
            }
        }
        if (targets.length >= 8) break
    }
    return targets
}
