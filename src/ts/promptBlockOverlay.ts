import type { PromptItem } from './process/prompt'

export type PromptBlockOverlayPlacement = 'before' | 'replace' | 'after'

export interface PromptBlockOverlayReference {
    index: number
    name: string
    type: PromptItem['type']
}

export interface PromptBlockOverlayRule {
    source: PromptBlockOverlayReference
    target: PromptBlockOverlayReference
    placement: PromptBlockOverlayPlacement
}

export interface PromptBlockOverlayProfileSettings {
    enabled: boolean
    includeReferencedToggles: boolean
    rules: PromptBlockOverlayRule[]
}

export interface PromptBlockOverlayConfig extends PromptBlockOverlayProfileSettings {
    profileId: string
    applicationPresetId?: string
    profileSettings?: Record<string, PromptBlockOverlayProfileSettings>
}

export interface PromptBlockOverlayApplicationPreset extends PromptBlockOverlayProfileSettings {
    id: string
    name: string
    profileId: string
}

export interface PromptBlockOverlayProfile {
    id: string
    name: string
    promptTemplate: PromptItem[]
    customPromptTemplateToggle?: string
}

export interface PromptBlockOverlayPresetSource {
    name?: string
    promptTemplate?: PromptItem[] | null
    customPromptTemplateToggle?: string
}

const promptItemTypes = new Set<PromptItem['type']>([
    'plain', 'jailbreak', 'cot', 'chatML', 'persona', 'description', 'lorebook',
    'postEverything', 'memory', 'authornote', 'chat', 'cache',
])

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function normalizeReference(value: unknown): PromptBlockOverlayReference | null {
    const source = record(value)
    if (!source || !Number.isInteger(source.index) || Number(source.index) < 0) return null
    if (typeof source.name !== 'string' || typeof source.type !== 'string') return null
    if (!promptItemTypes.has(source.type as PromptItem['type'])) return null
    return {
        index: Number(source.index),
        name: source.name,
        type: source.type as PromptItem['type'],
    }
}

function normalizeRules(value: unknown): PromptBlockOverlayRule[] {
    return Array.isArray(value)
        ? value.flatMap((entry): PromptBlockOverlayRule[] => {
            const candidate = record(entry)
            const sourceRef = normalizeReference(candidate?.source)
            const targetRef = normalizeReference(candidate?.target)
            const placement = candidate?.placement
            if (!sourceRef || !targetRef || (placement !== 'before' && placement !== 'replace' && placement !== 'after')) {
                return []
            }
            return [{ source: sourceRef, target: targetRef, placement }]
        })
        : []
}

function normalizeProfileSettings(value: unknown): PromptBlockOverlayProfileSettings | null {
    const source = record(value)
    if (!source) return null
    return {
        enabled: Boolean(source.enabled),
        includeReferencedToggles: Boolean(source.includeReferencedToggles),
        rules: normalizeRules(source.rules),
    }
}

export function normalizePromptBlockOverlay(value: unknown): PromptBlockOverlayConfig | null {
    const source = record(value)
    if (!source) return null
    const profileId = typeof source.profileId === 'string'
        ? source.profileId.trim()
        : ''
    const applicationPresetId = typeof source.applicationPresetId === 'string'
        ? source.applicationPresetId.trim()
        : ''
    const profileSettings = record(source.profileSettings)
    const normalizedSettings = profileSettings
        ? Object.fromEntries(Object.entries(profileSettings).flatMap(([id, settings]) => {
            const normalized = normalizeProfileSettings(settings)
            const normalizedId = id.trim()
            return normalized && normalizedId ? [[normalizedId, normalized]] : []
        }))
        : undefined
    return {
        enabled: Boolean(source.enabled),
        profileId,
        ...(applicationPresetId ? { applicationPresetId } : {}),
        includeReferencedToggles: Boolean(source.includeReferencedToggles),
        rules: normalizeRules(source.rules),
        ...(normalizedSettings ? { profileSettings: normalizedSettings } : {}),
    }
}

function cloneRule(rule: PromptBlockOverlayRule): PromptBlockOverlayRule {
    return {
        source: { ...rule.source },
        target: { ...rule.target },
        placement: rule.placement,
    }
}

export function createPromptBlockOverlayApplicationPreset(
    config: PromptBlockOverlayConfig,
    id: string,
    name: string,
): PromptBlockOverlayApplicationPreset {
    return {
        id: id.trim(),
        name: name.trim(),
        profileId: config.profileId,
        enabled: config.enabled,
        includeReferencedToggles: config.includeReferencedToggles,
        rules: config.rules.map(cloneRule),
    }
}

export function normalizePromptBlockOverlayApplicationPresets(value: unknown): PromptBlockOverlayApplicationPreset[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    return value.flatMap((entry): PromptBlockOverlayApplicationPreset[] => {
        const source = record(entry)
        const id = typeof source?.id === 'string' ? source.id.trim() : ''
        const name = typeof source?.name === 'string' ? source.name.trim() : ''
        const profileId = typeof source?.profileId === 'string' ? source.profileId.trim() : ''
        const settings = normalizeProfileSettings(source)
        if (!id || !name || !profileId || !settings || ids.has(id)) return []
        ids.add(id)
        return [{ id, name, profileId, ...settings }]
    })
}

export function applyPromptBlockOverlayApplicationPreset(
    config: PromptBlockOverlayConfig,
    preset: PromptBlockOverlayApplicationPreset,
): PromptBlockOverlayConfig {
    return updatePromptBlockOverlayConfig({
        ...config,
        applicationPresetId: preset.id,
        profileId: preset.profileId,
        enabled: preset.enabled,
        includeReferencedToggles: preset.includeReferencedToggles,
        rules: preset.rules.map(cloneRule),
    }, {})
}

export function overwritePromptBlockOverlayApplicationPreset(
    presets: PromptBlockOverlayApplicationPreset[],
    id: string,
    config: PromptBlockOverlayConfig,
): PromptBlockOverlayApplicationPreset[] {
    return presets.map(preset => preset.id === id
        ? createPromptBlockOverlayApplicationPreset(config, preset.id, preset.name)
        : preset)
}

export function renamePromptBlockOverlayApplicationPreset(
    presets: PromptBlockOverlayApplicationPreset[],
    id: string,
    name: string,
): PromptBlockOverlayApplicationPreset[] {
    const nextName = name.trim()
    if (!nextName) return presets
    return presets.map(preset => preset.id === id
        ? { ...preset, name: nextName, rules: preset.rules.map(cloneRule) }
        : preset)
}

export function deletePromptBlockOverlayApplicationPreset(
    presets: PromptBlockOverlayApplicationPreset[],
    id: string,
): PromptBlockOverlayApplicationPreset[] {
    return presets.filter(preset => preset.id !== id)
}

function currentProfileSettings(config: PromptBlockOverlayConfig): PromptBlockOverlayProfileSettings {
    return {
        enabled: config.enabled,
        includeReferencedToggles: config.includeReferencedToggles,
        rules: config.rules,
    }
}

export function updatePromptBlockOverlayConfig(
    value: PromptBlockOverlayConfig,
    patch: Partial<PromptBlockOverlayProfileSettings>,
): PromptBlockOverlayConfig {
    const next = { ...value, ...patch }
    if (!next.profileId) return next
    return {
        ...next,
        profileSettings: {
            ...value.profileSettings,
            [next.profileId]: currentProfileSettings(next),
        },
    }
}

export function selectPromptBlockOverlayProfile(
    value: PromptBlockOverlayConfig,
    profileId: string,
): PromptBlockOverlayConfig {
    const saved = updatePromptBlockOverlayConfig(value, {})
    const nextId = profileId.trim()
    if (!nextId) {
        return { ...saved, enabled: false, profileId: '', rules: [] }
    }
    const restored = saved.profileSettings?.[nextId] ?? {
        enabled: true,
        includeReferencedToggles: true,
        rules: [],
    }
    return updatePromptBlockOverlayConfig({ ...saved, profileId: nextId, ...restored }, {})
}

export function promptBlockOverlayReference(item: PromptItem, index: number): PromptBlockOverlayReference {
    return { index, name: item.name ?? '', type: item.type }
}

export function resolvePromptBlockOverlayReference(items: PromptItem[], reference: PromptBlockOverlayReference): number {
    const indexed = items[reference.index]
    if (indexed && indexed.type === reference.type && (indexed.name ?? '') === reference.name) {
        return reference.index
    }
    const matches = items.flatMap((item, index) => (
        item.type === reference.type && (item.name ?? '') === reference.name ? [index] : []
    ))
    return matches.length === 1 ? matches[0] : -1
}

const cloneItem = (item: PromptItem): PromptItem => ({ ...item } as PromptItem)

export function renamePromptBlockOverlayProfile(
    profiles: PromptBlockOverlayProfile[],
    profileId: string,
    name: string,
): PromptBlockOverlayProfile[] {
    const nextName = name.trim()
    if (!nextName) return profiles
    return profiles.map(profile => profile.id === profileId
        ? { ...profile, name: nextName, promptTemplate: profile.promptTemplate.map(cloneItem) }
        : profile)
}

export function deletePromptBlockOverlayProfile(
    profiles: PromptBlockOverlayProfile[],
    profileId: string,
): PromptBlockOverlayProfile[] {
    return profiles.filter(profile => profile.id !== profileId)
}

export function updatePromptBlockItemText(item: PromptItem, text: string): PromptItem {
    switch (item.type) {
        case 'plain':
        case 'jailbreak':
        case 'cot':
        case 'chatML':
            return { ...item, text }
        case 'persona':
        case 'description':
        case 'lorebook':
        case 'postEverything':
        case 'memory':
        case 'authornote':
            return { ...item, innerFormat: text }
        default:
            return cloneItem(item)
    }
}

export function updatePromptBlockOverlayProfileBlockText(
    profile: PromptBlockOverlayProfile,
    index: number,
    text: string,
): PromptBlockOverlayProfile {
    const promptTemplate = profile.promptTemplate.map(cloneItem)
    const item = promptTemplate[index]
    if (!item) return { ...profile, promptTemplate }

    promptTemplate[index] = updatePromptBlockItemText(item, text)
    return { ...profile, promptTemplate }
}

export function replacePromptBlockOverlayProfileBlock(
    profile: PromptBlockOverlayProfile,
    index: number,
    item: PromptItem,
): PromptBlockOverlayProfile {
    const promptTemplate = profile.promptTemplate.map(cloneItem)
    if (index >= 0 && index < promptTemplate.length) promptTemplate[index] = cloneItem(item)
    return { ...profile, promptTemplate }
}

export function insertPromptBlockOverlayProfileBlock(
    profile: PromptBlockOverlayProfile,
    afterIndex: number,
    item: PromptItem,
): PromptBlockOverlayProfile {
    const promptTemplate = profile.promptTemplate.map(cloneItem)
    if (afterIndex < 0 || afterIndex >= promptTemplate.length) return { ...profile, promptTemplate }
    promptTemplate.splice(afterIndex + 1, 0, cloneItem(item))
    return { ...profile, promptTemplate }
}

export function duplicatePromptBlockOverlayProfileBlock(
    profile: PromptBlockOverlayProfile,
    index: number,
    copySuffix: string,
): PromptBlockOverlayProfile {
    const promptTemplate = profile.promptTemplate.map(cloneItem)
    const source = promptTemplate[index]
    if (!source) return { ...profile, promptTemplate }

    const baseName = `${source.name?.trim() || 'Untitled'} ${copySuffix.trim() || 'copy'}`
    const usedNames = new Set(promptTemplate.map(item => item.name ?? ''))
    let name = baseName
    let number = 2
    while (usedNames.has(name)) name = `${baseName} ${number++}`
    promptTemplate.splice(index + 1, 0, { ...source, name } as PromptItem)
    return { ...profile, promptTemplate }
}

export function deletePromptBlockOverlayProfileBlock(
    profile: PromptBlockOverlayProfile,
    index: number,
): PromptBlockOverlayProfile {
    return {
        ...profile,
        promptTemplate: profile.promptTemplate.filter((_, itemIndex) => itemIndex !== index).map(cloneItem),
    }
}

export function movePromptBlockOverlayProfileBlock(
    profile: PromptBlockOverlayProfile,
    fromIndex: number,
    toIndex: number,
): PromptBlockOverlayProfile {
    const promptTemplate = profile.promptTemplate.map(cloneItem)
    if (fromIndex < 0 || fromIndex >= promptTemplate.length || toIndex < 0 || toIndex >= promptTemplate.length) {
        return { ...profile, promptTemplate }
    }
    const [item] = promptTemplate.splice(fromIndex, 1)
    promptTemplate.splice(toIndex, 0, item)
    return { ...profile, promptTemplate }
}

export function remapPromptBlockOverlayRules(
    rules: PromptBlockOverlayRule[],
    currentItems: PromptItem[],
    nextItems: PromptItem[],
    removedIndex = -1,
    replacedIndex = -1,
): PromptBlockOverlayRule[] {
    return rules.flatMap(rule => {
        const currentIndex = resolvePromptBlockOverlayReference(currentItems, rule.source)
        if (currentIndex < 0) return [rule]
        if (currentIndex === removedIndex) return []
        if (currentIndex === replacedIndex && nextItems[replacedIndex]) {
            return [{
                ...rule,
                source: promptBlockOverlayReference(nextItems[replacedIndex], replacedIndex),
            }]
        }
        const currentItem = currentItems[currentIndex]
        const nextIndex = nextItems.findIndex(item =>
            item.type === currentItem.type && (item.name ?? '') === (currentItem.name ?? ''))
        return nextIndex < 0 ? [rule] : [{
            ...rule,
            source: promptBlockOverlayReference(nextItems[nextIndex], nextIndex),
        }]
    })
}

export function promptBlockMatchesExtractionText(item: PromptItem, extractionText: string): boolean {
    return extractionText.length > 0 && (item.name ?? '').includes(extractionText)
}

export function createPromptBlockOverlayProfileFromPreset(
    preset: PromptBlockOverlayPresetSource,
    id: string,
    extractionText = '📙',
): PromptBlockOverlayProfile {
    return {
        id,
        name: preset.name?.trim() || '추출 블록',
        promptTemplate: Array.isArray(preset.promptTemplate)
            ? preset.promptTemplate.filter(item => promptBlockMatchesExtractionText(item, extractionText)).map(cloneItem)
            : [],
        customPromptTemplateToggle: preset.customPromptTemplateToggle ?? '',
    }
}

export function appendPromptBlockOverlayProfileFromPreset(
    profile: PromptBlockOverlayProfile,
    preset: PromptBlockOverlayPresetSource,
    extractionText = '📙',
): PromptBlockOverlayProfile {
    const additions = Array.isArray(preset.promptTemplate)
        ? preset.promptTemplate
            .filter(item => promptBlockMatchesExtractionText(item, extractionText))
            .map(cloneItem)
        : []
    const currentToggles = profile.customPromptTemplateToggle.trimEnd()
    const addedToggles = (preset.customPromptTemplateToggle ?? '').trim()
    return {
        ...profile,
        promptTemplate: [...profile.promptTemplate.map(cloneItem), ...additions],
        customPromptTemplateToggle: [currentToggles, addedToggles].filter(Boolean).join('\n'),
    }
}

export function normalizePromptBlockOverlayProfiles(value: unknown): PromptBlockOverlayProfile[] {
    if (!Array.isArray(value)) return []
    const ids = new Set<string>()
    return value.flatMap((entry): PromptBlockOverlayProfile[] => {
        const source = record(entry)
        const id = typeof source?.id === 'string' ? source.id.trim() : ''
        if (!id || ids.has(id) || !Array.isArray(source?.promptTemplate)) return []
        ids.add(id)
        return [{
            id,
            name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '추출 블록',
            promptTemplate: (source.promptTemplate as PromptItem[]).map(cloneItem),
            customPromptTemplateToggle: typeof source.customPromptTemplateToggle === 'string'
                ? source.customPromptTemplateToggle
                : '',
        }]
    })
}

function resolveOverlay(
    profiles: PromptBlockOverlayProfile[],
    value: PromptBlockOverlayConfig | null | undefined,
): { config: PromptBlockOverlayConfig; profile: PromptBlockOverlayProfile; items: PromptItem[] } | null {
    const config = normalizePromptBlockOverlay(value)
    if (!config?.profileId) return null
    const profile = profiles.find(candidate => candidate?.id === config.profileId)
    const items = profile?.promptTemplate
    if (!profile || !Array.isArray(items)) return null
    return { config, profile, items }
}

export function composePromptBlockOverlay(
    baseItems: PromptItem[] | null | undefined,
    profiles: PromptBlockOverlayProfile[],
    value: PromptBlockOverlayConfig | null | undefined,
): PromptItem[] | null | undefined {
    if (!Array.isArray(baseItems)) return baseItems
    const overlay = resolveOverlay(profiles, value)
    if (!overlay) return baseItems.map(cloneItem)

    const grouped = new Map<number, Record<PromptBlockOverlayPlacement, PromptItem[]>>()
    for (const rule of [...overlay.config.rules].sort((left, right) => left.source.index - right.source.index)) {
        const sourceIndex = resolvePromptBlockOverlayReference(overlay.items, rule.source)
        const targetIndex = resolvePromptBlockOverlayReference(baseItems, rule.target)
        if (sourceIndex < 0 || targetIndex < 0) continue
        const placements = grouped.get(targetIndex) ?? { before: [], replace: [], after: [] }
        placements[rule.placement].push(cloneItem(overlay.items[sourceIndex]))
        grouped.set(targetIndex, placements)
    }

    return baseItems.flatMap((item, index) => {
        const placements = grouped.get(index)
        if (!placements) return [cloneItem(item)]
        return [
            ...placements.before,
            ...(placements.replace.length > 0 ? placements.replace : [cloneItem(item)]),
            ...placements.after,
        ]
    })
}

export function promptBlockOverlayItemText(item: PromptItem): string {
    if ('text' in item) return item.text ?? ''
    if ('innerFormat' in item) return item.innerFormat ?? ''
    if ('defaultText' in item) return item.defaultText ?? ''
    return ''
}

function referencedToggleKeys(items: PromptItem[]): Set<string> {
    const keys = new Set<string>()
    const expression = /getglobalvar::toggle_([^}:\r\n]+)|#when::toggle::([^}:\r\n]+)/gi
    for (const item of items) {
        for (const match of promptBlockOverlayItemText(item).matchAll(expression)) {
            const key = (match[1] ?? match[2] ?? '').replace(/^toggle_/i, '')
            if (key) keys.add(key)
        }
    }
    return keys
}

interface PortableToggleDefinition {
    key: string
    line: string
}

function portableToggleDefinitions(template: string): PortableToggleDefinition[] {
    return template.split(/\r?\n/).flatMap(rawLine => {
        const line = rawLine.trim()
        const [key, value, type] = line.split('=')
        if (!key || !value || type === 'group' || type === 'groupEnd' || type === 'caption' || type === 'divider') {
            return []
        }
        return [{ key, line }]
    })
}

export function getEffectivePromptToggleTemplate(
    baseTemplate: string | null | undefined,
    profiles: PromptBlockOverlayProfile[],
    value: PromptBlockOverlayConfig | null | undefined,
): string {
    const base = baseTemplate ?? ''
    const overlay = resolveOverlay(profiles, value)
    if (!overlay?.config.includeReferencedToggles) return base

    const selectedItems = overlay.config.rules.flatMap(rule => {
        const index = resolvePromptBlockOverlayReference(overlay.items, rule.source)
        return index < 0 ? [] : [overlay.items[index]]
    })
    const referenced = referencedToggleKeys(selectedItems)
    const existing = new Set(portableToggleDefinitions(base).map(toggle => toggle.key))
    const additions = portableToggleDefinitions(overlay.profile.customPromptTemplateToggle ?? '')
        .flatMap(toggle => {
            if (!referenced.has(toggle.key) || existing.has(toggle.key)) return []
            existing.add(toggle.key)
            return [toggle.line]
        })
    if (additions.length === 0) return base

    const profileName = overlay.profile.name?.trim() || '추출 블록'
    return [base.trimEnd(), `=🧩 ${profileName}=group`, ...additions, '==groupEnd']
        .filter(Boolean)
        .join('\n')
}
