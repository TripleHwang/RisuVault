import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const legacyTokens = [
    {
        value: ['jel', 'ly'].join(''),
        contentExceptions: new Set([
            'src/ts/plugins/providerRequestStatus.test.ts',
            'src/ts/plugins/providerRequestStatus.ts',
        ]),
    },
    {
        value: ['pocket', 'risu'].join(''),
        contentExceptions: new Set([
            // Legal attribution must preserve the upstream project's name.
            'NOTICE.md',
            'README.en.md',
            'README.md',
            // Upstream release announcements, carried in verbatim. Their header
            // credits the project RisuBard itself forked from, which is the same
            // attribution the files above are excepted for. 0.9.3-arca.txt was
            // superseded upstream by 0.9.4-arca.txt; the entry is kept because
            // the exception set is matched by path, not by what exists today.
            'patchnote/0.8.14-arca.txt',
            'patchnote/0.9.3-arca.txt',
            // 0.9.31 and 0.9.32 describe upstream's backup compatibility with the
            // project it forked from; the notes are upstream's text, carried in
            // verbatim like the announcements above.
            'patchnote/0.9.31.md',
            'patchnote/0.9.32-arca.txt',
            // Ported GPLv3 source. Its header must name the project it came
            // from and that project's licence; NOTICE.md carries the same
            // attribution.
            'scripts/portable/gen-server-deps.cjs',
            // The 0.3.16 note credits the upstream project the portable
            // dependency manifest came from. Attribution belongs where the user
            // reads it, not only in a file header they never open.
            'src/etc/patchNote.ts',
        ]),
    },
]
const excludedPrefixes = ['public/token/']

function ownedFiles(): string[] {
    return execFileSync('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
    ], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
        .filter((path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix)))
        .filter(existsSync)
}

describe('brand boundary', () => {
    // Upstream pins its backup-choice guidance to the sibling product a full
    // backup is meant for. Here the sibling is another RisuVault installation,
    // so the guidance must name this product and never the legacy ones.
    test('names this product in backup compatibility guidance', () => {
        const compatibilityGuides = [
            'src/lang/en.ts',
            'src/lang/ko.ts',
            'src/lang/zh-Hant.ts',
        ]

        for (const path of compatibilityGuides) {
            const source = readFileSync(path, 'utf8')
            const guidance = source.match(/saveBackupForUpstreamConfirm"?:\s*\r?\n?\s*"((?:[^"\\]|\\.)*)"/)
            expect(guidance, `${path} has no saveBackupForUpstreamConfirm string`).not.toBeNull()
            expect(guidance![1]).toContain('RisuVault')
            for (const { value } of legacyTokens) {
                expect(guidance![1].toLowerCase()).not.toContain(value)
            }
        }
    })

    test('owned paths and UTF-8 text contain no legacy brand tokens', () => {
        const violations: string[] = []

        for (const path of ownedFiles()) {
            if (legacyTokens.some(({ value }) => path.toLowerCase().includes(value))) {
                violations.push(`path:${path}`)
            }

            const content = readFileSync(path)
            if (!content.includes(0) && legacyTokens.some(({ value, contentExceptions }) => (
                !contentExceptions.has(path) && content.toString('utf8').toLowerCase().includes(value)
            ))) {
                violations.push(`content:${path}`)
            }
        }

        expect(violations).toEqual([])
    }, 30_000)
})
