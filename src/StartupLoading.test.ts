import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { languageEnglish } from './lang/en'
import { languageKorean } from './lang/ko'

const app = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8')
const bootstrap = readFileSync(resolve(process.cwd(), 'src/ts/bootstrap.ts'), 'utf8')
const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8')
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')

describe('localized startup screen', () => {
    test('applies the saved language before mounting and localizes every bootstrap status', () => {
        expect(main.indexOf('applyEarlyLanguage()')).toBeLessThan(main.indexOf('mount(App'))
        expect(bootstrap).not.toMatch(/LoadingStatusState\.text\s*=\s*[`\"](?:Loading|Decoding|Reading|Checking|Updating)/)
        expect(languageEnglish.startupLoading.localSave).toBe('Loading local save file...')
        expect(languageKorean.startupLoading?.localSave).toBe('로컬 저장 파일을 불러오는 중...')
    })

    test('carries no startup image on the critical path', () => {
        // The wordmark was a 13 KB image decoded synchronously before first
        // paint, in both the static preloader and the app's own loading
        // screen. Neither phase references it now, and the asset is gone so
        // nothing can quietly reintroduce it by path.
        expect(app).not.toContain('risubard-startup')
        expect(html).not.toContain('risubard-startup')
        expect(html).not.toContain('rel="preload" as="image"')
        expect(existsSync(resolve(process.cwd(), 'public/assets/risubard-startup.webp'))).toBe(false)
        expect(html).toContain("localStorage.getItem('risu-lang') === 'ko'")
    })

    test('shows the package version in both loading phases', () => {
        expect(viteConfig).toContain("html.replaceAll('__RISUBARD_APP_VERSION__', pkg.version)")
        expect(html).toMatch(/<span[^>]*data-startup-version[^>]*>v__RISUBARD_APP_VERSION__<\/span>/)
        expect(app).toMatch(/import\s*\{[^}]*nodeOnlyVer[^}]*\}\s*from '\.\/ts\/storage\/database\.svelte'/)
        expect(app).toMatch(/<span[^>]*data-startup-version[^>]*>v\{nodeOnlyVer\}<\/span>/)
    })
})
