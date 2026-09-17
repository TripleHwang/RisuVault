import { describe, expect, it } from 'vitest'
import {
    buildBardLoreAnalysisLanguageInstruction,
    normalizeBardLoreAnalysisLanguage,
    resolveBardLoreAnalysisLanguage,
} from './bardLoreLanguage'

describe('Grimoire analysis language', () => {
    it('defaults invalid and missing settings to the BardWiki language', () => {
        expect(normalizeBardLoreAnalysisLanguage(undefined)).toBe('follow-bardwiki')
        expect(normalizeBardLoreAnalysisLanguage('invalid')).toBe('follow-bardwiki')
        expect(resolveBardLoreAnalysisLanguage('follow-bardwiki', 'ko')).toBe('ko')
        expect(resolveBardLoreAnalysisLanguage('follow-bardwiki', 'en')).toBe('en')
        expect(resolveBardLoreAnalysisLanguage('follow-bardwiki', 'ja')).toBe('ja')
        expect(resolveBardLoreAnalysisLanguage('follow-bardwiki', 'zh-Hans')).toBe('zh-Hans')
    })

    it('keeps explicit English, Korean, and bilingual selections independent of BardWiki', () => {
        expect(resolveBardLoreAnalysisLanguage('en', 'ko')).toBe('en')
        expect(resolveBardLoreAnalysisLanguage('ko', 'en')).toBe('ko')
        expect(resolveBardLoreAnalysisLanguage('bilingual', 'ko')).toBe('bilingual')
    })

    it('builds distinct language contracts for searchable metadata', () => {
        const english = buildBardLoreAnalysisLanguageInstruction('en', 'ko')
        const korean = buildBardLoreAnalysisLanguageInstruction('ko', 'en')
        const bilingual = buildBardLoreAnalysisLanguageInstruction('bilingual', 'ko')

        expect(english).toContain('Write all human-readable retrieval metadata in English')
        expect(korean).toContain('사람이 읽고 검색하는 모든 메타데이터를 한국어로 작성하세요')
        expect(bilingual).toContain('both English and Korean')
        expect(bilingual).toContain('Korean sentence followed by its English counterpart')
        expect(new Set([english, korean, bilingual]).size).toBe(3)
    })

    it('builds a shared metadata contract for new BardWiki locales', () => {
        expect(buildBardLoreAnalysisLanguageInstruction('follow-bardwiki', 'ja'))
            .toContain('Japanese (ja)')
        expect(buildBardLoreAnalysisLanguageInstruction('follow-bardwiki', 'zh-Hant'))
            .toContain('Traditional Chinese (zh-Hant)')
    })
})
