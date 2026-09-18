import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('SQL mutation persistence contracts', () => {
    it('persists scripting edits and whole-history replacements by stable message id', () => {
        const scripting = source('src/ts/process/scriptings.ts')

        expect(scripting).toMatch(/declareAPI\('setChat'[\s\S]*?markSqlMessageDirty\(ScriptingEngineState\.chat\.id!, message\.chatId!\)/)
        expect(scripting).toMatch(/declareAPI\('setChatRole'[\s\S]*?markSqlMessageDirty\(ScriptingEngineState\.chat\.id!, message\.chatId!\)/)
        expect(scripting).toMatch(/declareAPI\('cutChat'[\s\S]*?markSqlMessageDeleted/)
        expect(scripting).toMatch(/declareAPI\('setFullChatMain'[\s\S]*?chatId: v4\(\)[\s\S]*?markSqlMessageDeleted[\s\S]*?markSqlMessageDirty/)
    })

    it('persists legacy and v2 trigger edits and cuts by explicit message id, never by manifest', () => {
        const triggers = source('src/ts/process/triggers.ts')

        expect(triggers).toMatch(/case 'modifychat':[\s\S]*?markSqlMessageDirty\(chat\.id!, chat\.message\[index\]\.chatId!\)/)
        expect(triggers).toMatch(/case 'v2ModifyChat':[\s\S]*?markSqlMessageDirty\(chat\.id!, chat\.message\[index\]\.chatId!\)/)
        expect(triggers).toMatch(/case 'cutchat':[\s\S]*?markSqlMessageDeleted/)
        expect(triggers).toMatch(/case 'v2CutChat':[\s\S]*?markSqlMessageDeleted/)
        // A manifest is "delete every row not in my array", and the array is
        // only what this tab has loaded; it deleted messages another device
        // wrote. The removals above already name every id a cut drops.
        expect(triggers).not.toMatch(/markSqlMessageManifestDirty/)
    })

    it('persists bookmark metadata through the owning chat row', () => {
        const chat = source('src/lib/ChatScreens/Chat.svelte')

        expect(chat).toMatch(/async function toggleBookmark\(\)[\s\S]*?chat\.bookmarks = \[\.\.\.chat\.bookmarks\];[\s\S]*?markSqlChatDirty\(currentCharacter\.chaId, chat\.id!\)/)
    })
})
