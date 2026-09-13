import { describe, expect, test } from 'vitest'
import { projectPendingWikiBatch } from './wikiBatchAnalysis'

const messages = [
    { role: 'user', data: 'context user', chatId: 'u0' },
    { role: 'char', data: 'context assistant', chatId: 'a0', risubardMemoryConfirmed: true },
    { role: 'user', data: 'first target user', chatId: 'u1' },
    { role: 'char', data: 'first target assistant', chatId: 'a1' },
    { role: 'user', data: 'bridge user', chatId: 'u2' },
    { role: 'char', data: 'bridge assistant', chatId: 'a2', risubardMemoryConfirmed: true },
    { role: 'user', data: 'second target user', chatId: 'u3' },
    { role: 'char', data: 'second target assistant', chatId: 'a3' },
    { role: 'user', data: 'later user', chatId: 'u4' },
] as const

describe('BardWiki pending Batch analysis projection', () => {
    test('fixes every unconfirmed assistant target and adds preceding context turns', () => {
        const projected = projectPendingWikiBatch(messages, 1, true)

        expect(projected?.assistantMessageIds).toEqual(['a1', 'a3'])
        expect(projected?.eventTurns).toEqual([
            { assistantMessageId: 'a1', sourceMessageIds: ['u1', 'a1'] },
            { assistantMessageId: 'a3', sourceMessageIds: ['u3', 'a3'] },
        ])
        expect(projected?.messages.map((message) => message.messageId)).toEqual([
            'u0', 'a0', 'u1', 'a1', 'u2', 'a2', 'u3', 'a3',
        ])
    })

    test('removes every user message from analysis inputs and event evidence', () => {
        const projected = projectPendingWikiBatch(messages, 1, false)

        expect(projected?.eventTurns).toEqual([
            { assistantMessageId: 'a1', sourceMessageIds: ['a1'] },
            { assistantMessageId: 'a3', sourceMessageIds: ['a3'] },
        ])
        expect(projected?.messages.map((message) => message.messageId)).toEqual([
            'a0', 'a1', 'a2', 'a3',
        ])
    })
})
