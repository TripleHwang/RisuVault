import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'postcss'
import { describe, expect, test } from 'vitest'

const tooltip = readFileSync(join(process.cwd(), 'src/ts/gui/tooltip.ts'), 'utf8')
const themePath = join(process.cwd(), 'src/styles/tooltip-theme.css')
const css = existsSync(themePath) ? readFileSync(themePath, 'utf8') : ''
const themeSelector = ".tippy-box[data-theme~='risubard']"

function declarations(selector: string): Record<string, string> {
    const rule = parse(css).nodes.find((node) => node.type === 'rule' && node.selector === selector)
    expect(rule, `Missing scoped tooltip rule: ${selector}`).toBeDefined()
    if (rule?.type !== 'rule') return {}
    return Object.fromEntries(rule.nodes.flatMap((node) =>
        node.type === 'decl' ? [[node.prop, node.value]] : []))
}

describe('theme-aware Tippy tooltips', () => {
    test('keeps structural CSS and uses the local theme for all tooltip actions', () => {
        expect(tooltip).toContain("import 'tippy.js/dist/tippy.css'")
        expect(tooltip).toContain("import '../../styles/tooltip-theme.css'")
        expect(tooltip).not.toContain('themes/translucent.css')
        expect(tooltip).not.toContain("theme: 'translucent'")
        expect(tooltip.match(/theme: 'risubard'/g)).toHaveLength(3)
    })

    test('uses editable tokens for the opaque surface, text, border and shadow', () => {
        const surface = declarations(themeSelector)
        expect(surface['background-color']).toBe('var(--color-darkbg)')
        expect(surface.color).toBe('var(--color-textcolor)')
        expect(surface.border).toBe('1px solid var(--color-darkborderc)')
        expect(surface['box-shadow']).toContain('var(--color-shadow)')
    })

    test('overrides all arrow directions plus backdrop and SVG arrow colors', () => {
        expect(declarations(`${themeSelector} > .tippy-arrow`).color).toBe('var(--color-darkbg)')
        for (const placement of ['top', 'bottom', 'left', 'right']) {
            const arrow = declarations(`${themeSelector}[data-placement^='${placement}'] > .tippy-arrow::before`)
            expect(arrow[`border-${placement}-color`]).toBe('var(--color-darkbg)')
        }
        expect(declarations(`${themeSelector} > .tippy-backdrop`)['background-color']).toBe('var(--color-darkbg)')
        expect(declarations(`${themeSelector} > .tippy-svg-arrow`).fill).toBe('var(--color-darkbg)')
    })

    test('scopes every override to the application theme without fixed color literals', () => {
        expect(css).not.toBe('')
        for (const node of parse(css).nodes) {
            if (node.type === 'rule') expect(node.selector.startsWith(themeSelector)).toBe(true)
        }
        expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[\d.]|:\s*(?:white|black)\b/i)
        expect(css).not.toMatch(/var\(--(?:darkbg|textcolor|darkborderc|shadow)\b/)
    })
})
