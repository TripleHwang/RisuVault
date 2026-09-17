import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sidebar = readFileSync(
    resolve(process.cwd(), 'src/lib/SideBars/Sidebar.svelte'),
    'utf8',
)

function keyframes(name: string): string {
    const match = sidebar.match(new RegExp(`@keyframes ${name}\\s*{([\\s\\S]*?)\\n  }`))
    expect(match, `missing ${name} keyframes`).not.toBeNull()
    return match![1]
}

describe('responsive sidebar animation', () => {
    test('moves the mobile sidebar without animating its layout width', () => {
        for (const name of ['sidebar-transition', 'sidebar-transition-close']) {
            const animation = keyframes(name)
            expect(animation).toContain('transform:')
            expect(animation).not.toMatch(/\b(?:min-)?width\s*:/)
        }
    })
})
