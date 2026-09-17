import type { CanonicalSectionPatch } from './risubard-memory-writer'

interface MarkdownLine {
    start: number
    contentEnd: number
    end: number
    text: string
}

interface MarkdownHeading {
    level: number
    text: string
    line: MarkdownLine
}

interface CanonicalSection extends MarkdownHeading {
    end: number
}

interface ParsedCanonicalMarkdown {
    markdown: string
    newline: string
    title: MarkdownHeading
    sections: CanonicalSection[]
}

export function normalizeCanonicalSectionHeading(value: string): string {
    return value.normalize('NFKC').toLowerCase().trim()
}

function markdownLines(value: string): MarkdownLine[] {
    const lines: MarkdownLine[] = []
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gu
    for (const match of value.matchAll(pattern)) {
        if (match[0].length === 0) break
        const start = match.index ?? 0
        lines.push({
            start,
            contentEnd: start + match[1].length,
            end: start + match[0].length,
            text: match[1],
        })
    }
    return lines
}

function headingFrom(line: MarkdownLine): MarkdownHeading | undefined {
    const match = /^ {0,3}(#{1,6})(?:[ \t]+)(.*)$/u.exec(line.text)
    if (!match) return undefined
    const text = match[2].replace(/[ \t]+#+[ \t]*$/u, '').trim()
    if (!text) return undefined
    return { level: match[1].length, text, line }
}

function headingsOutsideFences(value: string): MarkdownHeading[] {
    const headings: MarkdownHeading[] = []
    let fence: { marker: '`' | '~'; length: number } | undefined
    for (const line of markdownLines(value)) {
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.text)
        if (fenceMatch) {
            const marker = fenceMatch[1][0] as '`' | '~'
            if (!fence) {
                fence = { marker, length: fenceMatch[1].length }
                continue
            }
            if (marker === fence.marker
                && fenceMatch[1].length >= fence.length
                && fenceMatch[2].trim().length === 0) {
                fence = undefined
            }
            continue
        }
        if (fence) continue
        const heading = headingFrom(line)
        if (heading) headings.push(heading)
    }
    return headings
}

function parseCanonicalMarkdown(markdown: string): ParsedCanonicalMarkdown {
    if (!markdown) throw new Error('Canonical Markdown is empty')
    const headings = headingsOutsideFences(markdown)
    const title = headings[0]
    if (!title || title.line.start !== 0 || title.level < 1 || title.level > 2) {
        throw new Error('Canonical Markdown must start with an H1 or H2 title')
    }
    if (headings.slice(1).some((heading) => heading.level <= title.level)) {
        throw new Error('Canonical Markdown contains an additional title-level heading')
    }
    const sectionLevel = title.level + 1
    const sectionHeadings = headings.filter((heading) =>
        heading.line.start > title.line.start
        && heading.level === sectionLevel)
    const seen = new Set<string>()
    const sections = sectionHeadings.map((heading, index) => {
        const key = normalizeCanonicalSectionHeading(heading.text)
        if (seen.has(key)) {
            throw new Error(`Canonical Markdown has a duplicate section heading: ${heading.text}`)
        }
        seen.add(key)
        return {
            ...heading,
            end: sectionHeadings[index + 1]?.line.start ?? markdown.length,
        }
    })
    return {
        markdown,
        newline: markdown.includes('\r\n') ? '\r\n' : '\n',
        title,
        sections,
    }
}

export function parseCanonicalSectionPatchMarkdown(
    value: string,
): CanonicalSectionPatch[] {
    if (!value.trim()) throw new Error('Canonical Markdown patch is empty')
    if (value.length > 12_000) {
        throw new Error('Canonical Markdown patch is too long')
    }
    const headings = headingsOutsideFences(value)
    if (headings.length === 0 || headings[0].line.start !== 0) {
        throw new Error('Canonical Markdown patch must start with a direct H3 section')
    }
    if (headings.length > 24 || headings.some((heading) => heading.level !== 3)) {
        throw new Error('Canonical Markdown patch may contain only direct H3 sections')
    }
    const seen = new Set<string>()
    return headings.map((heading, index) => {
        const key = normalizeCanonicalSectionHeading(heading.text)
        if (!key || heading.text.length > 160 || seen.has(key)) {
            throw new Error(`Canonical Markdown patch has an invalid section: ${heading.text}`)
        }
        seen.add(key)
        const content = value.slice(
            heading.line.end,
            headings[index + 1]?.line.start ?? value.length,
        ).trim()
        if (!content) {
            throw new Error(`Canonical Markdown patch has invalid content: ${heading.text}`)
        }
        return { heading: heading.text, operation: 'upsert', content }
    })
}

export function hasCanonicalSection(
    markdown: string,
    headings: readonly string[],
): boolean {
    const expected = new Set(headings.map(normalizeCanonicalSectionHeading))
    return parseCanonicalMarkdown(markdown).sections.some((section) =>
        expected.has(normalizeCanonicalSectionHeading(section.text)))
}

function replacementSection(
    parsed: ParsedCanonicalMarkdown,
    heading: string,
    content: string,
    existing?: CanonicalSection,
    hasFollowingSection = false,
): string {
    const hashes = '#'.repeat(parsed.title.level + 1)
    const headingLine = existing?.line.text ?? `${hashes} ${heading.trim()}`
    return `${headingLine}${parsed.newline}${parsed.newline}${content.trim()}${
        hasFollowingSection ? `${parsed.newline}${parsed.newline}` : ''
    }`
}

function validatePatchContent(
    parsed: ParsedCanonicalMarkdown,
    content: string,
): void {
    if (headingsOutsideFences(content).some((heading) =>
        heading.level <= parsed.title.level + 1)) {
        throw new Error('Canonical section content cannot contain a title or peer heading')
    }
}

function appendSection(
    parsed: ParsedCanonicalMarkdown,
    heading: string,
    content: string,
): string {
    const { markdown, newline } = parsed
    const hasTwoBreaks = markdown.endsWith(`${newline}${newline}`)
    const hasOneBreak = !hasTwoBreaks && markdown.endsWith(newline)
    const separator = hasTwoBreaks ? '' : hasOneBreak ? newline : `${newline}${newline}`
    return markdown + separator + replacementSection(parsed, heading, content)
}

export function applyCanonicalSectionPatches(input: {
    markdown?: string
    title: string
    patches: readonly CanonicalSectionPatch[]
}): string {
    const title = input.title.trim()
    if (!title || /[\r\n]/u.test(title)) {
        throw new Error('Canonical title is invalid')
    }
    let markdown = input.markdown ?? `## ${title}`

    for (const patch of input.patches) {
        const parsed = parseCanonicalMarkdown(markdown)
        validatePatchContent(parsed, patch.content)
        const key = normalizeCanonicalSectionHeading(patch.heading)
        if (key.length === 0) {
            const start = parsed.title.line.contentEnd
            const end = parsed.sections[0]?.line.start ?? markdown.length
            const existing = markdown.slice(start, end).trim()
            if (patch.operation === 'delete') {
                if (!existing) throw new Error('Canonical preamble does not exist')
                markdown = markdown.slice(0, start)
                    + (parsed.sections.length > 0
                        ? `${parsed.newline}${parsed.newline}`
                        : '')
                    + markdown.slice(end)
            }
            else {
                markdown = markdown.slice(0, start)
                    + `${parsed.newline}${parsed.newline}${patch.content.trim()}`
                    + (parsed.sections.length > 0
                        ? `${parsed.newline}${parsed.newline}`
                        : '')
                    + markdown.slice(end)
            }
            continue
        }

        const index = parsed.sections.findIndex((section) =>
            normalizeCanonicalSectionHeading(section.text) === key)
        const existing = parsed.sections[index]
        if (patch.operation === 'delete') {
            if (!existing) {
                throw new Error(`Canonical section does not exist: ${patch.heading}`)
            }
            markdown = markdown.slice(0, existing.line.start)
                + markdown.slice(existing.end)
        }
        else if (existing) {
            markdown = markdown.slice(0, existing.line.start)
                + replacementSection(
                    parsed,
                    patch.heading,
                    patch.content,
                    existing,
                    index < parsed.sections.length - 1,
                )
                + markdown.slice(existing.end)
        }
        else {
            markdown = appendSection(parsed, patch.heading, patch.content)
        }
    }

    const parsed = parseCanonicalMarkdown(markdown)
    const preamble = markdown.slice(
        parsed.title.line.contentEnd,
        parsed.sections[0]?.line.start ?? markdown.length,
    ).trim()
    if (!preamble && parsed.sections.length === 0) {
        throw new Error('Canonical section patches produced an empty document')
    }
    return markdown
}
