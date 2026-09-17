import { describe, expect, it } from 'vitest'
import { needsCharacterRuntimeNormalization } from './characterRuntime'

function normalizedCharacter() {
    return {
        chats: [{ message: [], note: '', id: 'chat-1', localLore: [], fmIndex: -1 }],
        chatPage: 0,
        type: 'character',
        chaId: 'char-1',
        sdData: {},
        utilityBot: false,
        triggerscript: [],
        alternateGreetings: [],
        exampleMessage: '',
        creatorNotes: '',
        systemPrompt: '',
        tags: [],
        creator: '',
        characterVersion: '',
        personality: '',
        scenario: '',
        firstMsgIndex: -1,
        additionalData: {},
        voicevoxConfig: {},
        postHistoryInstructions: '',
        additionalText: '',
        depth_prompt: {},
        hfTTS: {},
        backgroundHTML: '',
        backgroundCSS: '',
        creation_date: 1,
        globalLore: [{ bookVersion: 2 }],
        newGenData: {},
        ttsMode: '',
        customscript: [],
    }
}

describe('needsCharacterRuntimeNormalization', () => {
    it('skips characters that already satisfy runtime invariants', () => {
        expect(needsCharacterRuntimeNormalization(normalizedCharacter())).toBe(false)
    })

    it('detects legacy lorebooks and incomplete chat defaults', () => {
        expect(needsCharacterRuntimeNormalization({
            ...normalizedCharacter(),
            globalLore: [{ bookVersion: 1 }],
        })).toBe(true)
        expect(needsCharacterRuntimeNormalization({
            ...normalizedCharacter(),
            chats: [{ message: [], note: '', id: '', localLore: [], fmIndex: -1 }],
        })).toBe(true)
    })

    it('detects pending post-history instruction application', () => {
        expect(needsCharacterRuntimeNormalization({
            ...normalizedCharacter(),
            postHistoryInstructions: 'instruction',
        })).toBe(true)
    })
})
