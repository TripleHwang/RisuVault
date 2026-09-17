import { describe, expect, test } from 'vitest'
import {
    buildWikiWritingLanguageGuard,
    detectWikiWritingLanguage,
    localizeWikiHeadings,
    normalizeWikiWritingLanguage,
    wikiWritingLanguageOptions,
    wikiWritingLocales,
} from './wikiWritingLanguage'

describe('BardWiki writing locales', () => {
    test('exposes one registry for every supported writing language', () => {
        expect(wikiWritingLanguageOptions).toEqual([
            { value: 'ko', label: '한국어' },
            { value: 'en', label: 'English' },
            { value: 'ja', label: '日本語' },
            { value: 'zh-Hans', label: '简体中文' },
            { value: 'zh-Hant', label: '繁體中文' },
        ])
        expect(Object.keys(wikiWritingLocales)).toEqual(
            wikiWritingLanguageOptions.map((option) => option.value)
        )
    })

    test.each(['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant'] as const)(
        'normalizes and builds a data-driven output contract for %s', (locale) => {
            expect(normalizeWikiWritingLanguage(locale)).toBe(locale)
            const guard = buildWikiWritingLanguageGuard(locale)
            expect(guard).toContain(wikiWritingLocales[locale].languageName)
            expect(guard).toContain(`(${locale})`)
            expect(guard).toContain('schema keys')
        }
    )

    test('defaults unknown locales to Korean', () => {
        expect(normalizeWikiWritingLanguage('fr')).toBe('ko')
        expect(normalizeWikiWritingLanguage(undefined)).toBe('ko')
    })

    test.each(['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant'] as const)(
        'localizes and detects program-owned headings for %s', (locale) => {
            const headings = wikiWritingLocales[locale].headings
            const localized = localizeWikiHeadings([
                '### Story Summary',
                '### Story History',
                '### Related Documents',
                '### Additional Analysis',
                '### Current State',
            ].join('\n'), locale)
            expect(localized).toBe([
                `### ${headings.summary}`,
                `### ${headings.history}`,
                `### ${headings.related}`,
                `### ${headings.additional}`,
                `### ${headings.currentState}`,
            ].join('\n'))
            expect(detectWikiWritingLanguage(`### ${headings.summary}`)).toBe(locale)
        }
    )
})
