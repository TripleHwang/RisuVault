import { SettingsRoute, type SettingsRouteValue } from '../routing'

export type AISettingsSectionId =
    | 'model-presets'
    | 'legacy-model'
    | 'auxiliary-ai'

export interface AISettingsSection {
    id: AISettingsSectionId
    route: SettingsRouteValue
    status?: 'recommended' | 'legacy'
}

export const aiSettingsSections: AISettingsSection[] = [
    { id: 'model-presets', route: SettingsRoute.ModelPreset, status: 'recommended' },
    { id: 'legacy-model', route: SettingsRoute.ChatBot, status: 'legacy' },
    { id: 'auxiliary-ai', route: SettingsRoute.OtherBots },
]

export function getAISettingsSection(route: SettingsRouteValue): AISettingsSection | undefined {
    return aiSettingsSections.find((section) => section.route === route)
}

export function isAISettingsRoute(route: SettingsRouteValue): boolean {
    return getAISettingsSection(route) !== undefined
}
