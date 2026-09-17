import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('chat reroll hotkey contract', () => {
    it('targets the regenerate control instead of the next-swipe control', () => {
        const hotkey = readFileSync('src/ts/hotkey.ts', 'utf8')
        const chat = readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8')
        const nextSwipeCall = chat.indexOf('onNextSwipe()')
        const regenerateCall = chat.indexOf('language.rerollConfirm')
        const nextSwipeStart = chat.lastIndexOf('<button', nextSwipeCall)
        const regenerateStart = chat.lastIndexOf('<button', regenerateCall)

        expect(hotkey).toContain("clickQuery('[data-hotkey-action=\"reroll\"]')")
        expect(nextSwipeStart).toBeGreaterThan(-1)
        expect(regenerateStart).toBeGreaterThan(nextSwipeStart)
        expect(chat.slice(nextSwipeStart, nextSwipeCall)).not.toContain('data-hotkey-action="reroll"')
        expect(chat.slice(regenerateStart, regenerateCall)).toContain('data-hotkey-action="reroll"')
    })
})
