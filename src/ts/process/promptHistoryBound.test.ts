import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The preload's target, and the two ways a target that is too tight shows up.
 *
 * Before this change the prompt-history preload walked back until the resident
 * history was worth the WHOLE request budget -- 65,000 tokens on a ModelPreset
 * -- which put a measured 1200-message chat at 740 resident, 2.3x
 * `MAX_RESIDENT_MESSAGES`, to build a prompt whose history is capped at twelve
 * assistant turns -- about two dozen messages -- by
 * `selectNarrativeWorkingMessages`. `resolvePromptHistoryBound` replaces that
 * with a figure derived from the consumers.
 *
 * A bound that is too generous costs memory. A bound that is too tight costs
 * correctness, invisibly -- a prompt built from a history shorter than it
 * should be, sent with nothing to say so. So the two tests that matter most
 * here are the ones that would catch a target set too low, and both are driven
 * against the REAL consumers rather than a stub of them:
 *
 *  - a lorebook entry carrying `@@scan_depth 150` is run through the real
 *    `loadLoreBookV3Prompt`, with the real decorator parser and the real
 *    `messages.slice(len - scanDepth, len)`, and must still find its key;
 *  - a raised `risuBardResponseMessageCount` is run through the real
 *    `selectNarrativeWorkingMessages`, the function `sendChat` itself calls at
 *    `index.svelte.ts:2549`, and must still come away with a full working set.
 *    The setting counts ASSISTANT TURNS and the selection pulls each turn's
 *    user messages in with it, so a full working set of N turns is 2N
 *    messages of an alternating history, 2N + 1 when the newest message is
 *    the user's; a bound that still treated the setting as a message count
 *    prepared half of what the prompt then read.
 *
 * Both fail if the target ignores the term they cover; both are shown failing
 * at the old opening-page window of 40 in the same test, so the assertion is
 * not vacuously true.
 */

const { mockDBState, mockModuleSources } = vi.hoisted(() => ({
    mockDBState: { db: {} as any },
    mockModuleSources: [] as Array<{ scopeId: string; entry: any }>,
}))

// The peripheral modules `lorebook.svelte.ts` reaches for. The lorebook itself,
// its decorator parsing and its history slice are the real ones -- those are
// what this file is testing.
vi.mock('../stores.svelte', () => ({
    DBState: mockDBState,
    selectedCharID: writable(0),
}))
vi.mock('../tokenizer', () => ({
    tokenize: vi.fn(async (text: string) => Math.ceil(String(text).length / 4)),
}))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (value: string) => value,
}))
vi.mock('../util', () => ({
    findCharacterbyId: vi.fn(),
    pickHashRand: vi.fn(() => 1),
    selectSingleFile: vi.fn(),
}))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('../../lang', () => ({
    getCurrentLocale: () => 'en',
    language: {},
}))
vi.mock('../globalApi.svelte', () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}))
vi.mock('./modules', () => ({
    getModuleLorebooks: () => mockModuleSources.map((source) => source.entry),
    getModuleLorebooksWithSources: () => mockModuleSources,
}))

import {
    PROMPT_HISTORY_CEILING_MESSAGES,
    PROMPT_HISTORY_FLOOR_MESSAGES,
    resolvePromptHistoryBound,
} from './promptHistoryBound'
import { loadLoreBookV3Prompt } from './lorebook.svelte'
import {
    normalizeNarrativeWorkingMessageLimit,
    selectNarrativeWorkingMessages,
} from '../risubard/narrativeContext'
import { resolveRisuBardChatSettings } from '../risubard/risuBardSettings'
import { setSqlWindow } from '../storage/sql/sqlRuntimeWindow'

const HISTORY_LENGTH = 1_200
const NEEDLE = 'brackwater'

function lore(comment: string, key: string, content: string, extra: Record<string, unknown> = {}) {
    return {
        comment,
        key,
        content,
        mode: 'normal',
        insertorder: 100,
        alwaysActive: false,
        secondkey: '',
        selective: false,
        useRegex: false,
        ...extra,
    } as any
}

/**
 * A conversation of `HISTORY_LENGTH` messages with one distinctive word placed
 * exactly `needleFromEnd` messages from the newest end, alternating user/char
 * the way a real chat does.
 */
function history(needleFromEnd: number): any[] {
    return Array.from({ length: HISTORY_LENGTH }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'char',
        data: index === HISTORY_LENGTH - needleFromEnd
            ? `we finally reached ${NEEDLE} at dusk`
            : `ordinary message number ${index}`,
        chatId: `msg-${String(index).padStart(4, '0')}`,
    }))
}

/** What a chat holds after the preload has loaded `resident` messages. */
function newest(messages: any[], resident: number): any[] {
    return messages.slice(Math.max(0, messages.length - resident))
}

function makeCharacter(options: {
    globalLore?: any[]
    resident: any[]
    loreScanDepth?: number
    risuBardSettings?: Record<string, unknown>
}) {
    return {
        chaId: 'char-bound',
        type: 'character',
        name: 'Ada',
        chatPage: 0,
        globalLore: options.globalLore ?? [],
        loreSettings: options.loreScanDepth === undefined
            ? undefined
            : { scanDepth: options.loreScanDepth, recursiveScanning: false, maxRecursionSteps: 1 },
        chats: [{
            id: 'chat-bound',
            name: 'Chat 0',
            note: '',
            localLore: [],
            fmIndex: -1,
            message: options.resident,
            ...(options.risuBardSettings ? { risuBardSettings: options.risuBardSettings } : {}),
        }],
    } as any
}

function baseDatabase(overrides: Record<string, unknown> = {}) {
    return {
        username: 'reporter',
        loreBookDepth: 5,
        loreBookToken: 4_000,
        maxContext: 4_000,
        ...overrides,
    } as any
}

beforeEach(() => {
    mockModuleSources.splice(0, mockModuleSources.length)
})

describe('how far back a send has to load', () => {
    it('stays inside the page a chat opens on at default settings', () => {
        const character = makeCharacter({ resident: [] })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())

        // Every term at its default: a twelve-TURN narrative working set and a
        // twelve-turn recent-memory projection, 25 messages each in an
        // alternating chat whose newest message is the one being sent, a scan
        // depth of five, a three-message confirmed turn. The 25 the prompt must
        // see fit inside the page a chat opens on, and so does the raw guess at
        // what holds them (`25 + 8 = 33`), so the floor is the answer and a
        // default send makes no storage request. That zero is the property the
        // preload was measured on -- a 1200-message chat at 40 resident and 0
        // requests -- and a multiplier on the guess (`25 x 2 + 8 = 58`) is what
        // would put one 18-message page back on every chat's first send.
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
        expect(bound.unboundedReason).toBeUndefined()
        expect(bound.terms.map((term) => term.messages)).toEqual([25, 25, 5, 4])
        // What the prompt must be able to SEE, separately from how many array
        // slots that is guessed to take.
        expect(bound.targetEnabledMessages).toBe(25)
        expect(bound.residentCeiling).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('keeps the visible requirement separate from the guess at its raw cost', () => {
        // `targetMessages` is `enabled + 8`, a guess made without reading a
        // single message. On a chat with two of every three recent messages
        // disabled it holds a third of what it guesses, so the visible figure
        // travels with it and the preload checks the guess against what it
        // actually holds. Measured before this pair existed, on the old doubled
        // guess: 43 visible where 60 were asked for -- a multiplier does not
        // close the gap either, which is why the guess no longer carries one.
        // Thirty turns is 61 messages of an alternating history that ends on
        // the message being sent, and 69 slots to guess at.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 30 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetEnabledMessages).toBe(61)
        expect(bound.targetMessages).toBe(69)

        const history = Array.from({ length: 400 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `m${index}`,
            ...(index % 3 !== 0 ? { disabled: true } : {}),
        }))
        const atGuess = history.slice(history.length - bound.targetMessages!)
        expect(atGuess.filter((message) => message.disabled !== true).length)
            .toBeLessThan(bound.targetEnabledMessages!)
    })

    it('never asks to see more than the residency bound can hold', () => {
        // A visible target the ceiling cannot satisfy must not become an
        // unbounded walk; the ceiling is the answer.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 5_000 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetEnabledMessages).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
        expect(bound.residentCeiling).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('never asks for less than the window a chat opens on', () => {
        // The floor is what stops this change being a silent loss. Consumers
        // that cannot be bounded before the send -- a trigger script indexing
        // message 30, `{{history}}` inside a lorebook entry -- got 40 messages
        // before the preload existed, and must not get fewer now.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 1, risuBardRecentMessageCount: 1 },
        })
        const bound = resolvePromptHistoryBound(
            character,
            character.chats[0],
            baseDatabase({ loreBookDepth: 1 }),
        )
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
    })

    it('never asks for more than the residency bound allows', () => {
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 5_000 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('reaches two messages per configured turn, with or without the user filter', () => {
        // `selectNarrativeWorkingMessages` walks back to the `limit`-th newest
        // char message and opens the slice on the user messages before it, so
        // `limit` turns of an alternating history is `2 x limit` messages, and
        // one more for the user message being sent. The user filter runs on
        // that slice AFTERWARDS: it shrinks the working set without moving
        // where it starts, so it must not change the reach.
        const includingCharacter = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 60 },
        })
        const including = resolvePromptHistoryBound(
            includingCharacter,
            includingCharacter.chats[0],
            baseDatabase(),
        )
        const excludingCharacter = makeCharacter({
            resident: [],
            risuBardSettings: {
                risuBardResponseMessageCount: 60,
                risuBardResponseExcludeUserMessages: true,
            },
        })
        const excluding = resolvePromptHistoryBound(
            excludingCharacter,
            excludingCharacter.chats[0],
            baseDatabase(),
        )
        expect(including.terms[0].messages).toBe(121)
        expect(excluding.terms[0].messages).toBe(121)
        expect(excluding.targetMessages!).toBe(including.targetMessages!)
    })

    it('reads the deepest scan any activatable entry asks for, not one global setting', () => {
        const character = makeCharacter({
            resident: [],
            loreScanDepth: 20,
            globalLore: [
                lore('shallow', 'anything', 'plain entry'),
                lore('deep', NEEDLE, `@@scan_depth 150\nthe deep entry`),
                lore('disabled but deep', NEEDLE, '@@scan_depth 900\nnever runs', { enabled: false }),
            ],
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        // The 150 counts; the 900 on a disabled entry does not, because a
        // disabled entry never reaches the scan.
        expect(bound.targetMessages).toBe(150)
    })

    it('reads module lorebooks too, which the same scan loads', () => {
        mockModuleSources.push({
            scopeId: 'module:deep',
            entry: lore('module deep', 'anything', '@@scan_depth 200\nmodule entry'),
        })
        const character = makeCharacter({ resident: [] })
        const bound = resolvePromptHistoryBound(
            character,
            character.chats[0],
            baseDatabase(),
            () => mockModuleSources,
        )
        expect(bound.targetMessages).toBe(200)

        // Left out, the module's 200 is invisible and the target is short. That
        // is why `sendChat` handing the getter over is asserted from source
        // below rather than assumed.
        expect(resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
            .targetMessages).toBeLessThan(200)
    })

    it('refuses to invent a number for a scan depth that does not parse', () => {
        // `lorebook.svelte.ts:379` is `scanDepth = parseInt(arg[0])` with no NaN
        // guard -- unlike the `depth` case directly above it -- and
        // `slice(len - NaN, len)` is `slice(0, len)`, the whole resident array.
        // An entry written that way is asking for everything, so the bound
        // stands aside and lets the token budget be the only stop, which is
        // exactly what every send did before this change.
        const character = makeCharacter({
            resident: [],
            globalLore: [lore('all', NEEDLE, '@@scan_depth all\nthe whole thing')],
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetMessages).toBeUndefined()
        // Nothing is bounded, so the visible figure has nothing to extend.
        expect(bound.targetEnabledMessages).toBeUndefined()
        expect(bound.unboundedReason).toContain('scan_depth')
    })
})

describe('a target too tight to serve the consumers', () => {
    it('still lets a deep @@scan_depth entry find its key, through the real lorebook', async () => {
        const messages = history(150)
        const globalLore = [lore('deep', NEEDLE, '@@scan_depth 150\nTHE DEEP LORE FIRED')]

        // The bound, computed the way `sendChat` computes it, before anything
        // is loaded.
        const planning = makeCharacter({ resident: [], globalLore, loreScanDepth: 5 })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())
        expect(bound.targetMessages).toBe(150)

        // The chat as it stands once the preload has loaded that many. This is
        // the real `loadLoreBookV3Prompt`: the real decorator parser sets
        // `scanDepth`, and the real `messages.slice(len - scanDepth, len)` does
        // the scanning.
        const loaded = makeCharacter({
            resident: newest(messages, bound.targetMessages!),
            globalLore,
            loreScanDepth: 5,
        })
        mockDBState.db = baseDatabase({ characters: [loaded] })
        const activated = await loadLoreBookV3Prompt()
        expect(activated.actives.map((active) => active.prompt).join('\n'))
            .toContain('THE DEEP LORE FIRED')

        // ...and would NOT have, on the window a chat opens with. Without this
        // the assertion above could pass for the wrong reason.
        const openingPage = makeCharacter({
            resident: newest(messages, PROMPT_HISTORY_FLOOR_MESSAGES),
            globalLore,
            loreScanDepth: 5,
        })
        mockDBState.db = baseDatabase({ characters: [openingPage] })
        const missed = await loadLoreBookV3Prompt()
        expect(missed.actives.map((active) => active.prompt).join('\n'))
            .not.toContain('THE DEEP LORE FIRED')
    })

    it('still fills a raised risuBardResponseMessageCount, through the real narrowing', () => {
        const risuBardSettings = { risuBardResponseMessageCount: 100 }
        const messages = history(1)

        const planning = makeCharacter({ resident: [], risuBardSettings })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())
        // A hundred turns of an alternating history is two hundred messages.
        expect(bound.targetMessages!).toBeGreaterThanOrEqual(200)

        // `selectNarrativeWorkingMessages` is the function `sendChat` calls at
        // `index.svelte.ts:2549`, on the enabled messages of `chat.message`. A
        // preload that stopped short here would hand it fewer messages than the
        // reader configured and nothing downstream would say so.
        const loaded = newest(messages, bound.targetMessages!)
        expect(selectNarrativeWorkingMessages(loaded, 100, true)).toHaveLength(200)

        // Short by 160 on the window a chat opens with: 40 messages is 20 turns.
        const openingPage = newest(messages, PROMPT_HISTORY_FLOOR_MESSAGES)
        expect(selectNarrativeWorkingMessages(openingPage, 100, true)).toHaveLength(
            PROMPT_HISTORY_FLOOR_MESSAGES,
        )
    })

    it('fills it even when the working set excludes user messages', () => {
        const risuBardSettings = {
            risuBardResponseMessageCount: 60,
            risuBardResponseExcludeUserMessages: true,
        }
        const messages = history(1)
        const planning = makeCharacter({ resident: [], risuBardSettings })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())

        // Sixty turns of a strictly alternating history is 120 raw messages,
        // and the user filter then keeps the 60 char messages plus the newest
        // user one. The per-turn factor in the bound is what pays for the 120.
        const loaded = newest(messages, bound.targetMessages!)
        const selected = selectNarrativeWorkingMessages(loaded, 60, false)
        expect(selected.length).toBeGreaterThanOrEqual(60)
        expect(selected.filter((message: any) => message.role === 'char')).toHaveLength(60)
    })
})

/**
 * The comparison the bound has to survive: not "does it match what the bound
 * expects" but "does the prompt still contain what a FULLY RESIDENT history
 * would have put in it".
 *
 * For each configuration this builds the two things that decide the prompt's
 * history -- the lorebook entries that activate, and the narrative working set
 * `sendChat` hands to the request -- at the resident count the bound produces
 * and at full residency, and requires them to be identical. Both are the real
 * functions; `makeMs` is the only thing reproduced here, because it is a
 * closure inside `sendChat`.
 */
describe('the same prompt history a fully resident chat would have built', () => {
    /** `index.svelte.ts:1905`, which is not exported. */
    function makeMs(messages: any[]): any[] {
        const mss: any[] = []
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]
            if (message.disabled === true) continue
            if (message.disabled === 'allBefore') break
            mss.unshift(message)
        }
        return mss
    }

    const DEEP = 'deepwater'

    /**
     * `HISTORY_LENGTH` messages, one needle 150 back and one 260 back.
     *
     * Roles alternate along the VISIBLE messages, not the raw index, which
     * also puts a user message newest whenever anything is disabled -- the
     * shape of a real send -- while the undisabled conversation ends on a
     * char message, the shape of a continue. The
     * working set is counted in assistant turns and opens on the user messages
     * before its oldest turn, so what the bound has to cover is a visible
     * history of one user message per char message -- the shape every ordinary
     * chat has once its disabled messages are skipped. Alternating by raw index
     * would break that shape twice over: an even stride would leave only user
     * messages visible, and the always-visible newest four would put two user
     * messages back to back. Either is a turn that costs more than two visible
     * slots, which `MESSAGES_PER_TURN` in the bound documents as the one shape
     * a settings-derived figure cannot cover; it is not what this comparison
     * is measuring.
     */
    function conversation(disabledEvery?: number): any[] {
        let visibleOrdinal = 0
        return Array.from({ length: HISTORY_LENGTH }, (_, index) => {
            // The newest four are always visible so the turn projections have
            // something to read.
            const visible = !disabledEvery
                || index % disabledEvery === 0
                || index >= HISTORY_LENGTH - 4
            const ordinal = visible ? visibleOrdinal++ : index
            return {
                role: ordinal % 2 === 0 ? 'user' : 'char',
                data: index === HISTORY_LENGTH - 150
                    ? `we finally reached ${NEEDLE} at dusk`
                    : index === HISTORY_LENGTH - 260
                        ? `the ${DEEP} signal was heard`
                        : `ordinary message number ${index}`,
                chatId: `m${String(index).padStart(4, '0')}`,
                ...(visible ? {} : { disabled: true }),
            }
        })
    }

    function windowed(char: any, resident: any[]) {
        char.chats[0].message = resident
        setSqlWindow(char.chats[0], {
            before: null,
            nextBefore: 0,
            total: HISTORY_LENGTH,
            hasOlder: resident.length < HISTORY_LENGTH,
            hasNewer: false,
            nextAfter: null,
            nextPosition: HISTORY_LENGTH,
        })
        return char
    }

    async function activeComments(char: any) {
        mockDBState.db = baseDatabase({ characters: [char] })
        const result = await loadLoreBookV3Prompt()
        return result.actives.map((active: any) => active.comment ?? active.source).sort()
    }

    async function compare(options: {
        globalLore?: any[]
        localLore?: any[]
        moduleLore?: any[]
        loreScanDepth?: number
        risuBardSettings?: Record<string, unknown>
        disabledEvery?: number
    }) {
        mockModuleSources.splice(0, mockModuleSources.length)
        for (const entry of options.moduleLore ?? []) {
            mockModuleSources.push({ scopeId: 'module:m', entry })
        }
        const build = (resident: any[]) => {
            const char = makeCharacter({
                resident,
                globalLore: options.globalLore,
                loreScanDepth: options.loreScanDepth,
                risuBardSettings: options.risuBardSettings,
            })
            char.chats[0].localLore = options.localLore ?? []
            return windowed(char, resident)
        }

        const messages = conversation(options.disabledEvery)
        const bound = resolvePromptHistoryBound(
            build([]), build([]).chats[0], baseDatabase(), () => mockModuleSources,
        )
        expect(bound.targetMessages).toBeTypeOf('number')

        // The preload's stop rule, reproduced: the raw target, then as much
        // further as the visible target needs, and never past the ceiling.
        let resident = bound.targetMessages!
        while (
            resident < bound.residentCeiling
            && resident < HISTORY_LENGTH
            && makeMs(newest(messages, resident)).length < (bound.targetEnabledMessages ?? 0)
        ) resident += 1

        const atBound = build(newest(messages, resident))
        const full = build(messages.slice())

        expect(await activeComments(atBound)).toEqual(await activeComments(full))

        const settings = resolveRisuBardChatSettings(
            baseDatabase(), options.risuBardSettings as any,
        )
        const limit = normalizeNarrativeWorkingMessageLimit(settings.risuBardResponseMessageCount)
        const include = !settings.risuBardResponseExcludeUserMessages
        const workingSet = (char: any) =>
            selectNarrativeWorkingMessages(makeMs(char.chats[0].message), limit, include)
                .map((message: any) => message.chatId)
        expect(workingSet(atBound)).toEqual(workingSet(full))
        return { resident, bound, actives: await activeComments(atBound) }
    }

    it('at default settings', async () => {
        // Twelve turns, 25 messages, guessed at 33 slots: under the 40 a chat
        // opens on, so the floor is the bound and nothing is paged in. The
        // prompt built from those 40 must still be the one a fully resident
        // chat builds -- that is what makes the zero-request default safe.
        expect((await compare({})).resident).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
    })

    it('with a character scan depth of 20 and an entry at @@scan_depth 150', async () => {
        const result = await compare({
            loreScanDepth: 20,
            globalLore: [
                lore('deep', NEEDLE, '@@scan_depth 150\nDEEP'),
                lore('shallow', `ordinary message number ${HISTORY_LENGTH - 1}`, 'SHALLOW'),
            ],
        })
        expect(result.resident).toBe(150)
        expect(result.actives).toEqual(['deep', 'shallow'])
    })

    it('with the deep entry in the CHAT-LOCAL lorebook', async () => {
        const result = await compare({
            localLore: [lore('localdeep', DEEP, '@@scan_depth 260\nLOCAL')],
        })
        expect(result.resident).toBe(260)
        expect(result.actives).toEqual(['localdeep'])
    })

    it('with the deep entry in a MODULE lorebook', async () => {
        const result = await compare({
            moduleLore: [lore('moduledeep', DEEP, '@@scan_depth 260\nMODULE')],
        })
        expect(result.resident).toBe(260)
        expect(result.actives).toEqual(['moduledeep'])
    })

    it('with a working set of 60', async () => {
        // Sixty turns is 121 messages; `121 + 8` slots.
        expect((await compare({
            risuBardSettings: { risuBardResponseMessageCount: 60 },
        })).resident).toBe(129)
    })

    it('with a working set of 100', async () => {
        // A hundred turns is 201 messages; `201 + 8` slots, inside the
        // residency bound. The doubled guess put this configuration at the
        // ceiling (`201 x 2 + 8 = 410`); the prompt it builds is the same.
        expect((await compare({
            risuBardSettings: { risuBardResponseMessageCount: 100 },
        })).resident).toBe(209)
    })

    it('with the largest working set the residency bound can hold whole', async () => {
        // `2 x 155 + 1 + 8` is 319, one under the ceiling. Past this the ceiling
        // clamps the target and the prompt is short BY DESIGN -- the memory
        // bound wins -- so this is the last configuration for which bounded and
        // fully resident builds can be required to agree.
        expect((await compare({
            risuBardSettings: { risuBardResponseMessageCount: 155 },
        })).resident).toBe(PROMPT_HISTORY_CEILING_MESSAGES - 1)
    })

    it('with a working set of 100 that excludes user messages', async () => {
        await compare({
            risuBardSettings: {
                risuBardResponseMessageCount: 100,
                risuBardResponseExcludeUserMessages: true,
            },
        })
    })

    it('with a recent-memory projection of 80', async () => {
        await compare({ risuBardSettings: { risuBardRecentMessageCount: 80 } })
    })

    it('with two of every three recent messages disabled', async () => {
        // The case the raw target alone gets wrong: thirty turns is 61 visible
        // messages, guessed at 69 slots, and 69 slots of this chat hold 26
        // visible messages (23 at the one-in-three stride plus the newest
        // three the fixture keeps visible). Only the visible target closes it,
        // and it closes it from a guess of 69 exactly as it did from the old
        // doubled guess of 130: the raw figure decides where the walk opens,
        // the visible one decides where it stops.
        const result = await compare({
            disabledEvery: 3,
            risuBardSettings: { risuBardResponseMessageCount: 30 },
        })
        expect(result.bound.targetMessages).toBe(69)
        expect(result.resident).toBeGreaterThan(69)
        expect(result.resident).toBeLessThanOrEqual(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('with four of every five recent messages disabled', async () => {
        // Fifteen turns is 31 visible messages, guessed at 39 slots and so
        // floored to 40; at one visible in five, 40 slots hold 12 and the 31
        // take about 150. The visible target is what pays for the difference.
        const result = await compare({
            disabledEvery: 5,
            risuBardSettings: { risuBardResponseMessageCount: 15 },
        })
        expect(result.bound.targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
        expect(result.resident).toBeGreaterThan(result.bound.targetMessages!)
    })
})

describe('decorators that want the conversation length, not a depth', () => {
    /**
     * `@@activate_only_after N` asks "are we N messages into this conversation
     * yet?" and the lorebook used to answer with `currentChat.length` -- the
     * RESIDENT slice. So the same entry fired or did not depending on how far
     * the reader had scrolled, and on how far the preload had walked. Nothing
     * the preload can load fixes that; the count it needs is the persisted
     * total, which the hydration window knows.
     *
     * This is the one thing tightening the preload's bound would otherwise have
     * made measurably worse -- at 740 accidental resident messages the entry
     * fired, at 40 it would have stopped -- so it is fixed here rather than
     * left to be discovered as a silent behaviour change.
     */
    async function activatesAfter100(resident: number, total: number | null) {
        const messages = history(1)
        const character = makeCharacter({
            resident: newest(messages, resident),
            globalLore: [lore('late', NEEDLE, '@@activate_only_after 100\nLATE LORE FIRED', {
                alwaysActive: true,
            })],
        })
        if (total !== null) {
            setSqlWindow(character.chats[0], {
                before: null,
                nextBefore: 0,
                total,
                hasOlder: resident < total,
                hasNewer: false,
                nextAfter: null,
                nextPosition: total,
            })
        }
        mockDBState.db = baseDatabase({ characters: [character] })
        const activated = await loadLoreBookV3Prompt()
        return activated.actives.map((active) => active.prompt).join('\n')
    }

    it('fires on a long conversation even when only its opening page is resident', async () => {
        expect(await activatesAfter100(PROMPT_HISTORY_FLOOR_MESSAGES, 1_200))
            .toContain('LATE LORE FIRED')
    })

    it('still does not fire on a conversation that really is short', async () => {
        expect(await activatesAfter100(20, 20)).not.toContain('LATE LORE FIRED')
    })

    it('falls back to the resident slice for a chat that was never windowed', async () => {
        // A legacy full load or a non-SQL backend: there is no window to
        // consult and `chat.message` IS the history.
        expect(await activatesAfter100(150, null)).toContain('LATE LORE FIRED')
        expect(await activatesAfter100(20, null)).not.toContain('LATE LORE FIRED')
    })
})

describe('sendChat passes the derived bound to the preload', () => {
    const source = readFileSync(
        resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
        'utf8',
    )
    const sendChatStart = source.indexOf('export async function sendChat(')

    it('computes the bound before the preload and hands it over', () => {
        const boundCall = source.indexOf('resolvePromptHistoryBound(', sendChatStart)
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        expect(boundCall).toBeGreaterThan(sendChatStart)
        expect(preloadCall).toBeGreaterThan(boundCall)
        expect(source.slice(preloadCall, preloadCall + 1_800))
            .toContain('targetMessages: historyBound.targetMessages')
    })

    it('hands over the visible target and the ceiling, not just the raw guess', () => {
        // Passing `targetMessages` alone is the shape that loads short on a
        // heavily disabled history, so the other two travelling with it is
        // asserted rather than assumed.
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        const call = source.slice(preloadCall, preloadCall + 1_800)
        expect(call).toContain('targetEnabledMessages: historyBound.targetEnabledMessages')
        expect(call).toContain('residentCeiling: historyBound.residentCeiling')
    })

    it('hands the module lorebooks over, since the bound cannot import them', () => {
        const boundCall = source.indexOf('resolvePromptHistoryBound(', sendChatStart)
        expect(source.slice(boundCall, boundCall + 400))
            .toContain('getModuleLorebooksWithSources')
    })

    it('keeps the token budget as a ceiling rather than dropping it', () => {
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        expect(source.slice(preloadCall, preloadCall + 1_200))
            .toContain('budgetTokens: resolvePromptContextBudget(selectedConversation).maxContextTokens')
    })

    it('still narrows the prompt history with the limit the bound is derived from', () => {
        // If this ever stops being the cap on prompt history, the first term of
        // the bound stops being the right term and this file is what should
        // fail.
        expect(source).toContain('ms = selectNarrativeWorkingMessages(')
        expect(source).toContain('resolvedRisuBardSettings(currentChat).risuBardResponseMessageCount')
    })
})
