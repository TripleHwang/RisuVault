import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const processSource = readFileSync(resolve(
    process.cwd(), 'src/ts/process/index.svelte.ts'
), 'utf8')
const lifecycleSource = readFileSync(resolve(
    process.cwd(), 'src/ts/process/wikiRebootLifecycle.ts'
), 'utf8')
const chatSource = readFileSync(resolve(
    process.cwd(), 'src/lib/ChatScreens/DefaultChatScreen.svelte'
), 'utf8')
const wikiSource = readFileSync(resolve(
    process.cwd(), 'src/lib/Others/RisuBardMemoryWiki.svelte'
), 'utf8')
const koSource = readFileSync(resolve(process.cwd(), 'src/lang/ko.ts'), 'utf8')
const enSource = readFileSync(resolve(process.cwd(), 'src/lang/en.ts'), 'utf8')

describe('BardWiki reboot connections', () => {
    test('checkpoints the batch before analysis and replaces only at completion', () => {
        const runner = processSource.slice(
            processSource.indexOf('async function runWikiReboot'),
            processSource.indexOf('export async function startCurrentWikiReboot')
        )
        expect(runner.indexOf('job.inFlightAssistantMessageIds ='))
            .toBeLessThan(runner.indexOf('storedResponseMemoryAnalysis.confirm'))
        expect(runner).toContain('recoverWikiRebootBatch')
        expect(runner.match(/completeWikiRebootBatch/g)).toHaveLength(2)
        const recoveredApply = runner.indexOf(
            'applyWikiRebootBatchReceipt(chat, batch, recovered)'
        )
        const recoveredPersist = runner.indexOf(
            'await persistWikiReboot', recoveredApply
        )
        expect(recoveredPersist).toBeLessThan(runner.indexOf(
            'await completeWikiRebootBatch', recoveredPersist
        ))

        const finalize = processSource.slice(
            processSource.indexOf('async function finalizeWikiReboot'),
            processSource.indexOf('async function runWikiReboot')
        )
        expect(finalize.indexOf('prepareWikiRebootReplacement'))
            .toBeLessThan(finalize.indexOf("action: 'finalize'"))
        expect(finalize.indexOf("action: 'finalize'"))
            .toBeLessThan(finalize.indexOf('delete chat.risuBardWikiReboot'))
    })

    test('blocks response paths only for reboot and shares the wiki generation indicator', () => {
        expect(chatSource).toContain('wikiRebootBlocksGeneration')
        expect(chatSource).toContain('if (wikiRebootBlocksGeneration)')
        expect(chatSource).toContain('disabled={wikiRebootBlocksGeneration}')
        expect(chatSource).toContain('class:wiki-generating={$isWikiGenerating}')
    })

    test('records reboot failures in the BardWiki work log', () => {
        const runner = processSource.slice(
            processSource.indexOf('async function runWikiReboot'),
            processSource.indexOf('export async function startCurrentWikiReboot')
        )
        const failure = runner.slice(
            runner.lastIndexOf('catch (error)'),
            runner.lastIndexOf('finally')
        )

        expect(failure).toContain('publishRisuBardMemoryActivity')
        expect(failure).toContain("operation: 'error'")
        expect(failure).toContain('위키 리부트 실패:')
    })

    test('allows responses during ordinary BardWiki work while still blocking reboot', () => {
        const sendChat = processSource.slice(
            processSource.indexOf('export async function sendChat'),
            processSource.indexOf('const stageTimings =',
                processSource.indexOf('export async function sendChat'))
        )
        expect(sendChat).not.toContain('get(isWikiGenerating)')
        expect(sendChat).toContain('selectedConversation?.risuBardWikiReboot')
        expect(sendChat.indexOf('selectedConversation?.risuBardWikiReboot'))
            .toBeLessThan(sendChat.indexOf('chatProcessStage.set(0)'))

        expect(chatSource).not.toContain('let wikiBlocksGeneration = $derived(')
        expect(chatSource).toContain('if (wikiRebootBlocksGeneration)')
        expect(chatSource).toContain('disabled={wikiRebootBlocksGeneration}')
        expect(chatSource).toContain('{#if $isWikiGenerating}')
    })

    test('offers text lifecycle controls and one-turn or two-turn choices', () => {
        expect(wikiSource).toContain('data-risubard-wiki-reboot')
        expect(wikiSource).toContain('{rebootButtonLabel}')
        expect(wikiSource).toContain('startReboot(1)')
        expect(wikiSource).toContain('startReboot(2)')
        expect(wikiSource).toContain('risuBardWikiRebootOneTurnTooltip')
        expect(wikiSource).toContain('risuBardWikiRebootTwoTurnTooltip')
        expect(wikiSource).toContain('onCancelWikiReboot')
    })

    test('accepts a chat index in the whole conversation and starts from it', () => {
        expect(wikiSource).toContain('data-risubard-wiki-reboot-start-index')
        expect(wikiSource).toContain('risuBardWikiRebootStartChatIndex')
        expect(wikiSource).toContain('onStartWikiReboot?.(batchSize, rebootStartChatIndex)')
        expect(processSource).toContain('startChatIndex: number = 0')
        expect(lifecycleSource).toContain(
            'projectWikiRebootTurns(chat.message, input.startChatIndex)'
        )
        // The index the reader picks is a position in the conversation, so the
        // range offered is the conversation's length and not the resident
        // window's. `chat.message.length` here offered "0 to 39" on a
        // 400-message chat and rejected message 200 as out of range.
        expect(wikiSource).toContain(
            'let rebootLastChatIndex = $derived(conversationMessageCount(currentChat) - 1)'
        )
        expect(koSource).toContain('시작 챗 인덱스')
        expect(enSource).toContain('Starting chat index')
    })

    /**
     * The three orderings from the wedge report, asserted where they are wired.
     *
     * The orderings themselves are executed against a real hydrated chat in
     * `src/ts/process/wikiRebootLifecycleLive.svelte.test.ts`; these check that
     * `index.svelte.ts` still routes through them rather than growing its own
     * copy back.
     */
    test('starts a reboot through the lifecycle module, never job-first', () => {
        const start = processSource.slice(
            processSource.indexOf('export async function startCurrentWikiReboot'),
            processSource.indexOf('export function recoverStalledCurrentWikiReboot')
        )
        expect(start).toContain('beginWikiReboot({')
        expect(start).toContain('saveChat: (chat) => saveChatToServer(')
        expect(start).toContain('run: (chat) => runWikiReboot(')
        // The job is created inside the lifecycle module, between the load and
        // the save, and rolled back if the save refuses. Assigning it here
        // again would restore the wedge.
        expect(start).not.toContain('createWikiRebootJob')
        expect(start).not.toContain('risuBardWikiReboot =')
        // Validating the start index against the resident array is what
        // rejected a position that was in the conversation all along.
        expect(start).not.toContain('current.chat.message.length')
        expect(lifecycleSource).toContain('loadEntireHistory: true')
        const begin = lifecycleSource.slice(
            lifecycleSource.indexOf('export async function beginWikiReboot'),
            lifecycleSource.indexOf('export interface ResumeWikiRebootInput')
        )
        expect(begin.indexOf('await ensureWikiRebootHistoryResident'))
            .toBeLessThan(begin.indexOf('chat.risuBardWikiReboot = job'))
        expect(begin.indexOf('chat.risuBardWikiReboot = job'))
            .toBeLessThan(begin.indexOf('await input.saveChat(chat)'))
        expect(begin).toContain('delete chat.risuBardWikiReboot')
        // The pin covers the run, not just the load: a whole history is over
        // the residency bound and the trim releases the newest end.
        expect(begin).toContain('return await input.run(chat)')
        expect(begin).toContain('endResidencyPin(input.chatId)')
    })

    test('resumes and cancels only over a whole history', () => {
        const resume = processSource.slice(
            processSource.indexOf('export async function resumeCurrentWikiReboot'),
            processSource.indexOf('export async function cancelCurrentWikiReboot')
        )
        expect(resume).toContain('resumeWikiReboot({')
        expect(resume).not.toContain("job.status = 'running'")
        const cancel = processSource.slice(
            processSource.indexOf('export async function cancelCurrentWikiReboot'),
            processSource.indexOf('export async function executeCurrentNarrativeWikiCommand')
        )
        expect(cancel.indexOf('await ensureWikiRebootHistoryResident'))
            .toBeLessThan(cancel.indexOf('completeMemoryWikiFork'))
        expect(cancel.indexOf('await ensureWikiRebootHistoryResident'))
            .toBeLessThan(cancel.indexOf('delete chat.risuBardWikiReboot'))
        expect(cancel).toContain('endResidencyPin(chatId)')
    })

    test('recovers a job no runner can advance when the chat comes on screen', () => {
        const recovery = processSource.slice(
            processSource.indexOf('export function recoverStalledCurrentWikiReboot'),
            processSource.indexOf('export async function stopCurrentWikiReboot')
        )
        // A live runner is the evidence, and it covers a reboot that is still
        // starting as well as one already looping -- otherwise the recovery
        // pass could pause a job during the await between assigning it and
        // handing it to the runner. Read synchronously with the write below it.
        expect(recovery).toContain('wikiRebootHasRunner(operationId)')
        expect(recovery).toContain('recoverStalledWikiRebootJob(job,')
        // The chat this recovers is frequently windowed -- that is what made the
        // original save throw -- so the persist cannot be allowed to throw.
        expect(recovery).toContain('.catch((error) => {')
        expect(chatSource).toContain('recoverStalledCurrentWikiReboot()')
        expect(chatSource).toContain(
            "if (status !== 'running' && status !== 'stop-requested') return"
        )
    })

    test('loads and refreshes the visible staging wiki during reboot', () => {
        expect(wikiSource).toContain('resolveWikiRebootViewChatId')
        expect(wikiSource).toContain('let wikiChatId = $derived(')
        expect(wikiSource).toContain('chatId: wikiChatId')
        expect(wikiSource).toContain('detail.chatId !== wikiChatId')
        expect(wikiSource).toContain('locked={Boolean(rebootJob)}')
        expect(wikiSource).toContain('{#if onExecuteWikiCommand && !rebootJob}')
    })

    test('describes two-turn mode as reducing semantic analysis calls', () => {
        expect(koSource).toContain('의미 분석 호출 수와 반복 프롬프트 토큰')
        expect(enSource).toContain('semantic-analysis calls and repeated prompt tokens')
    })

    test('shows the active analysis token limit before choosing a batch size', () => {
        expect(wikiSource).toContain('resolveRisuBardChatSettings')
        expect(wikiSource).toContain('data-risubard-wiki-reboot-token-budget')
        expect(wikiSource).toContain('risuBardWikiRebootTokenBudget(')
        expect(koSource).toContain('정본 갱신 배치가 이 한도를 넘을 것으로 예상되면 문서 단위로 자동 분할됩니다')
        expect(enSource).toContain('Canonical update batches are automatically split by document')
    })
})
