import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { languageEnglish } from 'src/lang/en'
import { languageKorean } from 'src/lang/ko'

const componentPath = resolve(process.cwd(), 'src/lib/Setting/Pages/DeveloperSettings.svelte')

describe('privacy-safe developer diagnostics page', () => {
    it('provides English and Korean copy for the public diagnostics page', () => {
        for (const copy of [languageEnglish, languageKorean] as any[]) {
            expect(copy.storageDiagnosticsTitle).toBeTypeOf('string')
            expect(copy.storageDiagnosticsDownload).toBeTypeOf('string')
            expect(copy.storageDiagnosticsCopy).toBeTypeOf('string')
            expect(copy.storageDiagnosticsPrivacy).toBeTypeOf('string')
            expect(copy.storageDiagnosticsDirectWriteSuccess).toBeTypeOf('string')
            expect(copy.storageDiagnosticsDirectWriteFallback).toBeTypeOf('string')
        }
    })

    it('offers aggregate storage statistics with download and clipboard actions', () => {
        expect(existsSync(componentPath)).toBe(true)
        if (!existsSync(componentPath)) return

        const source = readFileSync(componentPath, 'utf8')
        expect(source).toContain('<SettingPage')
        expect(source).toContain("fetch('/api/storage-diagnostics/report'")
        expect(source).toContain('downloadFile')
        expect(source).toContain('navigator.clipboard.writeText')
        expect(source).toContain('language.storageDiagnosticsDownload')
        expect(source).toContain('language.storageDiagnosticsCopy')
        expect(source).toContain('report.directWrites.successes')
        expect(source).toContain('report.directWrites.fallbacks')
        expect(source).not.toContain('storage-observation.jsonl')
    })
})
