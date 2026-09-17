export interface CanonicalAuditDocument {
    id: string
    type: string
    status: string
    title: string
    content: string
    sourceMessageIds: readonly string[]
    reviewStatus?: string
    relativePath?: string
    links?: readonly string[]
    contextMode?: string
    contentHash?: string
}

export interface UnresolvedCanonicalCandidate {
    eventId: string
    type: 'character' | 'location' | 'scene' | 'faction' | 'item'
        | 'creature' | 'concept' | 'other'
    title: string
    reason: string
    conflict: boolean
}

const candidatePattern = /^- (character|location|scene|faction|creature|item|concept|other) \[\[([^\]]+)\]\]: (.+)$/gm

function eventCandidates(document: CanonicalAuditDocument) {
    const heading = document.content.indexOf('## 정본 갱신 후보')
    if (heading < 0) return []
    const tail = document.content.slice(heading + '## 정본 갱신 후보'.length)
    const nextHeading = tail.search(/^##\s+/m)
    const section = nextHeading < 0 ? tail : tail.slice(0, nextHeading)
    return [...section.matchAll(candidatePattern)].map((match) => ({
        type: match[1] as UnresolvedCanonicalCandidate['type'],
        title: match[2].trim(),
        reason: match[3].trim(),
    }))
}

export function collectCanonicalAudit(
    documents: readonly CanonicalAuditDocument[]
): {
    attentionCount: number
    unreviewedCount: number
    unresolvedCandidates: UnresolvedCanonicalCandidate[]
} {
    const active = documents.filter((document) => document.status === 'active')
    const canonicals = active.filter((document) => document.type !== 'event')
    const unreviewedCount = canonicals.filter((document) =>
        document.reviewStatus === 'unreviewed'
    ).length
    const unresolvedCandidates = active
        .filter((document) => document.type === 'event')
        .flatMap((event) => eventCandidates(event).flatMap((candidate) => {
            const normalizedTitle = candidate.title.normalize('NFKC')
                .toLocaleLowerCase()
            const matches = canonicals.filter((document) =>
                document.type === candidate.type
                && (candidate.type === 'scene'
                    || document.title.normalize('NFKC').toLocaleLowerCase()
                        === normalizedTitle)
            )
            const resolved = matches.length === 1
                && event.sourceMessageIds.every((id) =>
                    matches[0].sourceMessageIds.includes(id)
                )
            return resolved ? [] : [{
                eventId: event.id,
                ...candidate,
                conflict: matches.length > 1,
            }]
        }))
    return {
        attentionCount: unreviewedCount + unresolvedCandidates.length,
        unreviewedCount,
        unresolvedCandidates,
    }
}
