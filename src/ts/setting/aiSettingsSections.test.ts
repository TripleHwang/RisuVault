import { describe, expect, test } from 'vitest'
import { SettingsRoute } from '../routing'
import {
    aiSettingsSections,
    getAISettingsSection,
    isAISettingsRoute,
} from './aiSettingsSections'

describe('AI settings section registry', () => {
    test('maps all existing AI routes to one in-page section each', () => {
        expect(aiSettingsSections.map((section) => section.route)).toEqual([
            SettingsRoute.ModelPreset,
            SettingsRoute.ChatBot,
            SettingsRoute.OtherBots,
        ])

        for (const section of aiSettingsSections) {
            expect(getAISettingsSection(section.route)).toBe(section)
            expect(isAISettingsRoute(section.route)).toBe(true)
        }
    })

    test('keeps the public AI settings tabs in task order', () => {
        expect(aiSettingsSections.map((section) => section.id)).toEqual([
            'model-presets',
            'legacy-model',
            'auxiliary-ai',
        ])
    })

    test('does not absorb unrelated settings routes', () => {
        expect(getAISettingsSection(SettingsRoute.Display)).toBeUndefined()
        expect(getAISettingsSection(SettingsRoute.PromptPreset)).toBeUndefined()
        expect(isAISettingsRoute(SettingsRoute.Display)).toBe(false)
        expect(isAISettingsRoute(SettingsRoute.PromptPreset)).toBe(false)
    })
})
