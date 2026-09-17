import { describe, expect, test } from 'vitest'
import type { PromptItem } from './process/prompt'
import * as promptBlockOverlayModule from './promptBlockOverlay'
import {
    composePromptBlockOverlay,
    applyPromptBlockOverlayApplicationPreset,
    appendPromptBlockOverlayProfileFromPreset,
    createPromptBlockOverlayApplicationPreset,
    deletePromptBlockOverlayApplicationPreset,
    deletePromptBlockOverlayProfile,
    deletePromptBlockOverlayProfileBlock,
    duplicatePromptBlockOverlayProfileBlock,
    createPromptBlockOverlayProfileFromPreset,
    getEffectivePromptToggleTemplate,
    normalizePromptBlockOverlay,
    normalizePromptBlockOverlayApplicationPresets,
    overwritePromptBlockOverlayApplicationPreset,
    movePromptBlockOverlayProfileBlock,
    promptBlockMatchesExtractionText,
    promptBlockOverlayItemText,
    remapPromptBlockOverlayRules,
    resolvePromptBlockOverlayReference,
    selectPromptBlockOverlayProfile,
    renamePromptBlockOverlayProfile,
    updatePromptBlockOverlayProfileBlockText,
    updatePromptBlockItemText,
    updatePromptBlockOverlayConfig,
    type PromptBlockOverlayConfig,
} from './promptBlockOverlay'

const plain = (name: string, text = name): PromptItem => ({
    type: 'plain', type2: 'normal', role: 'system', name, text,
})

const sourceProfile = {
    id: 'memo-profile',
    name: '비망록 source',
    promptTemplate: [
        plain('📙 Open', '{{#when::toggle::commonplace_book}}OPEN{{/when}}'),
        plain('📙 Reply', '{{getglobalvar::toggle_termination}} REPLY'),
        plain('Unused', '{{getglobalvar::toggle_unused}}'),
    ],
    customPromptTemplateToggle: [
        'commonplace_book=비망록 활성화',
        'termination=비망록 탈옥 강화',
        'unused=사용하지 않는 토글',
    ].join('\n'),
}

const config: PromptBlockOverlayConfig = {
    enabled: true,
    profileId: 'memo-profile',
    includeReferencedToggles: true,
    rules: [
        {
            source: { index: 0, name: '📙 Open', type: 'plain' },
            target: { index: 0, name: 'System', type: 'plain' },
            placement: 'before',
        },
        {
            source: { index: 1, name: '📙 Reply', type: 'plain' },
            target: { index: 1, name: 'Reply', type: 'plain' },
            placement: 'replace',
        },
    ],
}

describe('prompt block overlay', () => {
    test('inserts and replaces source blocks in rule order without mutating either preset', () => {
        const base = [plain('System'), plain('Reply'), plain('Tail')]
        const sourceBefore = structuredClone(sourceProfile.promptTemplate)

        const result = composePromptBlockOverlay(base, [sourceProfile], config)

        expect(result.map(item => item.name)).toEqual(['📙 Open', 'System', '📙 Reply', 'Tail'])
        expect(base.map(item => item.name)).toEqual(['System', 'Reply', 'Tail'])
        expect(sourceProfile.promptTemplate).toEqual(sourceBefore)
        expect(result[0]).not.toBe(sourceProfile.promptTemplate[0])
    })

    test('keeps multiple replacements at one target as an ordered replacement sequence', () => {
        const base = [plain('System'), plain('Reply')]
        const multi: PromptBlockOverlayConfig = {
            ...config,
            rules: [
                { ...config.rules[0], target: { index: 1, name: 'Reply', type: 'plain' }, placement: 'replace' },
                { ...config.rules[1], target: { index: 1, name: 'Reply', type: 'plain' }, placement: 'replace' },
            ],
        }

        expect(composePromptBlockOverlay(base, [sourceProfile], multi).map(item => item.name)).toEqual([
            'System', '📙 Open', '📙 Reply',
        ])
    })

    test('preserves source-preset order when mappings were configured out of order', () => {
        const base = [plain('Reply')]
        const reversed: PromptBlockOverlayConfig = {
            ...config,
            rules: [
                { ...config.rules[1], target: { index: 0, name: 'Reply', type: 'plain' }, placement: 'replace' },
                { ...config.rules[0], target: { index: 0, name: 'Reply', type: 'plain' }, placement: 'replace' },
            ],
        }

        expect(composePromptBlockOverlay(base, [sourceProfile], reversed).map(item => item.name)).toEqual([
            '📙 Open', '📙 Reply',
        ])
    })

    test('skips stale mappings and composes whenever a profile is selected', () => {
        const base = [plain('System'), plain('Reply')]
        const stale: PromptBlockOverlayConfig = {
            ...config,
            rules: [{
                source: { index: 0, name: 'Missing source', type: 'plain' },
                target: { index: 0, name: 'Missing target', type: 'plain' },
                placement: 'after',
            }],
        }

        expect(composePromptBlockOverlay(base, [sourceProfile], stale)).toEqual(base)
        expect(composePromptBlockOverlay(base, [sourceProfile], { ...config, enabled: false })
            .map(item => item.name)).toEqual(['📙 Open', 'System', '📙 Reply'])
        expect(composePromptBlockOverlay(base, [], config)).toEqual(base)
    })

    test('merges only referenced source toggles and preserves target definitions on conflicts', () => {
        const template = getEffectivePromptToggleTemplate(
            'termination=대상 프리셋의 탈옥\nbase=기본 옵션',
            [sourceProfile],
            config,
        )

        expect(template).toContain('termination=대상 프리셋의 탈옥')
        expect(template).toContain('commonplace_book=비망록 활성화')
        expect(template.match(/^termination=/gm)).toHaveLength(1)
        expect(template).not.toContain('unused=사용하지 않는 토글')
        expect(template).toContain('=🧩 비망록 source=group')
        expect(template).toContain('==groupEnd')
    })

    test('normalizes imported overlay data and rejects invalid rules', () => {
        expect(normalizePromptBlockOverlay({
            enabled: 1,
            profileId: ' memo-profile ',
            includeReferencedToggles: 'yes',
            rules: [
                config.rules[0],
                { source: { index: -1 }, target: { index: 0 }, placement: 'after' },
                { source: { index: 0 }, target: { index: 0 }, placement: 'sideways' },
            ],
        })).toEqual({
            enabled: true,
            profileId: 'memo-profile',
            includeReferencedToggles: true,
            rules: [config.rules[0]],
        })
        expect(normalizePromptBlockOverlay(null)).toBeNull()
    })

    test('extracts only blocks whose names contain the requested text into a detached profile', () => {
        const preset = {
            id: 'installed-preset',
            name: '누렁이 블록',
            promptTemplate: [
                plain('Ordinary'),
                plain('📙 지침'),
                plain('Inject: Style'),
                plain('inject: style'),
            ],
            customPromptTemplateToggle: 'style=문체 활성화',
        }

        const profile = createPromptBlockOverlayProfileFromPreset(preset, 'standalone-id', 'Inject:')
        preset.promptTemplate[2] = plain('Changed later')

        expect(profile).toEqual({
            id: 'standalone-id',
            name: '누렁이 블록',
            promptTemplate: [plain('Inject: Style')],
            customPromptTemplateToggle: 'style=문체 활성화',
        })
        expect(promptBlockMatchesExtractionText(plain('📙 지침'), '📙')).toBe(true)
        expect(promptBlockMatchesExtractionText(plain('📙 지침'), '')).toBe(false)
    })

    test('uses the book symbol as the default extraction text', () => {
        const profile = createPromptBlockOverlayProfileFromPreset({
            name: '기본 추출',
            promptTemplate: [plain('📙 지침'), plain('비망록만 적힌 이름')],
        }, 'default-id')

        expect(profile.promptTemplate.map(item => item.name)).toEqual(['📙 지침'])
    })

    test('appends extracted blocks and toggle definitions to the current profile immutably', () => {
        const preset = {
            name: '추가 원본',
            promptTemplate: [plain('Ordinary'), plain('ADD · Style'), plain('ADD · Ending')],
            customPromptTemplateToggle: 'style=문체\nending=마무리',
        }

        const appended = appendPromptBlockOverlayProfileFromPreset(sourceProfile, preset, 'ADD ·')
        preset.promptTemplate[1] = plain('Changed later')

        expect(appended.promptTemplate.map(item => item.name)).toEqual([
            '📙 Open', '📙 Reply', 'Unused', 'ADD · Style', 'ADD · Ending',
        ])
        expect(appended.customPromptTemplateToggle).toContain('commonplace_book=비망록 활성화')
        expect(appended.customPromptTemplateToggle).toContain('style=문체')
        expect(sourceProfile.promptTemplate).toHaveLength(3)
    })

    test('edits a standalone prompt block without mutating the original', () => {
        const original = plain('Base', 'before')
        const edited = updatePromptBlockItemText(original, 'after')

        expect(promptBlockOverlayItemText(edited)).toBe('after')
        expect(promptBlockOverlayItemText(original)).toBe('before')
    })

    test('preserves settings per profile when the selected commonplace profile changes', () => {
        const switched = selectPromptBlockOverlayProfile(config, 'second-profile')

        expect(switched.profileId).toBe('second-profile')
        expect(switched.rules).toEqual([])
        expect(switched.profileSettings?.['memo-profile']).toEqual({
            enabled: true,
            includeReferencedToggles: true,
            rules: config.rules,
        })

        const configuredSecond = updatePromptBlockOverlayConfig(switched, {
            enabled: true,
            includeReferencedToggles: false,
            rules: [{ ...config.rules[0], placement: 'after' }],
        })
        const restored = selectPromptBlockOverlayProfile(configuredSecond, 'memo-profile')

        expect(restored.enabled).toBe(true)
        expect(restored.includeReferencedToggles).toBe(true)
        expect(restored.rules).toEqual(config.rules)
        expect(restored.profileSettings?.['second-profile']?.rules[0].placement).toBe('after')
    })

    test('resolves moved targets by stable signature and reports missing or ambiguous targets', () => {
        const reference = { index: 0, name: 'Reply', type: 'plain' } as const

        expect(resolvePromptBlockOverlayReference([plain('System'), plain('Reply')], reference)).toBe(1)
        expect(resolvePromptBlockOverlayReference([plain('System')], reference)).toBe(-1)
        expect(resolvePromptBlockOverlayReference([plain('Reply'), plain('Reply')], { ...reference, index: 3 })).toBe(-1)
    })

    test('creates, applies, overwrites, and normalizes standalone application presets', () => {
        const preset = createPromptBlockOverlayApplicationPreset(config, 'apply-1', '내 비망록 배치')
        expect(preset).toEqual({
            id: 'apply-1',
            name: '내 비망록 배치',
            profileId: 'memo-profile',
            enabled: true,
            includeReferencedToggles: true,
            rules: config.rules,
        })

        const applied = applyPromptBlockOverlayApplicationPreset(
            selectPromptBlockOverlayProfile(config, 'second-profile'),
            preset,
        )
        expect(applied.applicationPresetId).toBe('apply-1')
        expect(applied.profileId).toBe('memo-profile')
        expect(applied.rules).toEqual(config.rules)

        const overwritten = overwritePromptBlockOverlayApplicationPreset(
            [preset],
            'apply-1',
            { ...applied, includeReferencedToggles: false },
        )
        expect(overwritten[0].includeReferencedToggles).toBe(false)
        expect(overwritten[0].name).toBe('내 비망록 배치')
        expect(deletePromptBlockOverlayApplicationPreset(overwritten, 'apply-1')).toEqual([])

        expect(normalizePromptBlockOverlayApplicationPresets([preset, { ...preset }, { id: '', name: 'bad' }]))
            .toEqual([preset])
    })

    test('renames an application preset without changing its stable ID or settings', () => {
        const rename = (promptBlockOverlayModule as Record<string, unknown>)
            .renamePromptBlockOverlayApplicationPreset
        expect(rename).toBeTypeOf('function')
        if (typeof rename !== 'function') return

        const preset = createPromptBlockOverlayApplicationPreset(config, 'apply-1', '이전 이름')
        const renamed = rename([preset], 'apply-1', '  새 이름  ') as typeof preset[]
        expect(renamed[0]).toEqual({ ...preset, name: '새 이름' })
        expect(renamed[0].id).toBe('apply-1')
        expect(preset.name).toBe('이전 이름')
    })

    test('renames and deletes extracted profiles without mutating the source list', () => {
        const renamed = renamePromptBlockOverlayProfile([sourceProfile], 'memo-profile', '새 비망록 이름')
        expect(renamed[0].id).toBe('memo-profile')
        expect(renamed[0].name).toBe('새 비망록 이름')
        expect(sourceProfile.name).toBe('비망록 source')

        expect(deletePromptBlockOverlayProfile(renamed, 'memo-profile')).toEqual([])
    })

    test('edits, duplicates, deletes, and reorders profile blocks immutably', () => {
        const edited = updatePromptBlockOverlayProfileBlockText(sourceProfile, 0, 'EDITED')
        expect(promptBlockOverlayItemText(edited.promptTemplate[0])).toBe('EDITED')
        expect(promptBlockOverlayItemText(sourceProfile.promptTemplate[0])).not.toBe('EDITED')

        const duplicated = duplicatePromptBlockOverlayProfileBlock(edited, 0, '복사본')
        expect(duplicated.promptTemplate.map(item => item.name)).toEqual([
            '📙 Open', '📙 Open 복사본', '📙 Reply', 'Unused',
        ])
        expect(duplicated.promptTemplate[1]).not.toBe(duplicated.promptTemplate[0])

        const moved = movePromptBlockOverlayProfileBlock(duplicated, 1, 3)
        expect(moved.promptTemplate.map(item => item.name)).toEqual([
            '📙 Open', '📙 Reply', 'Unused', '📙 Open 복사본',
        ])

        const deleted = deletePromptBlockOverlayProfileBlock(moved, 2)
        expect(deleted.promptTemplate.map(item => item.name)).toEqual([
            '📙 Open', '📙 Reply', '📙 Open 복사본',
        ])
        expect(sourceProfile.promptTemplate).toHaveLength(3)
    })

    test('inserts a new plain block after the selected block and replaces block metadata immutably', () => {
        const insert = (promptBlockOverlayModule as Record<string, unknown>)
            .insertPromptBlockOverlayProfileBlock
        const replace = (promptBlockOverlayModule as Record<string, unknown>)
            .replacePromptBlockOverlayProfileBlock
        expect(insert).toBeTypeOf('function')
        expect(replace).toBeTypeOf('function')
        if (typeof insert !== 'function' || typeof replace !== 'function') return

        const inserted = insert(sourceProfile, 0, plain('새 블록', '')) as typeof sourceProfile
        expect(inserted.promptTemplate.map(item => item.name)).toEqual([
            '📙 Open', '새 블록', '📙 Reply', 'Unused',
        ])
        expect(sourceProfile.promptTemplate).toHaveLength(3)

        const replacement = { ...inserted.promptTemplate[1], name: '인라인 이름', type: 'jailbreak' } as PromptItem
        const replaced = replace(inserted, 1, replacement) as typeof sourceProfile
        expect(replaced.promptTemplate[1]).toEqual(replacement)
        expect(inserted.promptTemplate[1].name).toBe('새 블록')
    })

    test('remaps saved rules when profile blocks move or are deleted', () => {
        const moved = movePromptBlockOverlayProfileBlock(sourceProfile, 1, 0)
        const movedRules = remapPromptBlockOverlayRules(config.rules, sourceProfile.promptTemplate, moved.promptTemplate)
        expect(movedRules.find(rule => rule.source.name === '📙 Reply')?.source.index).toBe(0)
        expect(movedRules.find(rule => rule.source.name === '📙 Open')?.source.index).toBe(1)

        const deleted = deletePromptBlockOverlayProfileBlock(sourceProfile, 0)
        const deletedRules = remapPromptBlockOverlayRules(config.rules, sourceProfile.promptTemplate, deleted.promptTemplate, 0)
        expect(deletedRules.map(rule => rule.source.name)).toEqual(['📙 Reply'])
        expect(deletedRules[0].source.index).toBe(0)
    })
})
