import type { OpenAIChat } from "src/ts/process/index.svelte";
import type { requestDataResponse, RequestDataArgumentExtended } from "src/ts/process/request/request";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { collectStreamingText } from "src/ts/process/request/shared";
import type { ModelPreset } from "src/ts/preset/types";

/**
 * Host-only model access for trusted built-in plugins.
 *
 * `runLLMModel` answers with whatever the user's main or sub model is, which
 * is right for a translator and wrong for a built-in that the user configures
 * per ModelPreset: Persona Binder runs its adaptation pass against a preset
 * the user picks in its own panel, the way a chat is bound to one. Naming a
 * preset by id and routing through `requestChatData` with an explicit
 * `modelBindingTarget` is the same contract a non-chat workspace uses, so the
 * request gets the preset's credentials, parameters, retries, logging and
 * status card without a second dispatch path.
 *
 * Kept apart from `v3.svelte.ts` and given `requestChatData` as a dependency
 * so it can be tested against a fake without the request module's graph. The
 * trust gate (which plugin may call this) belongs to the caller.
 */

export type PluginModelPresetSummary = { id: string; name: string }

export type PluginRunModelPresetMessage = {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export type PluginRunModelPresetOptions = {
    presetId: string
    messages: PluginRunModelPresetMessage[]
    /** Only the main-slot mode is offered; it is what the preset was bound for. */
    mode?: 'model'
    maxTokens?: number
    temperature?: number
    /** The real `chat.id` to associate the request log with, when there is one. */
    chatId?: string
}

/** Never rejects for a model failure: plugin code reads one shape either way. */
export type PluginRunModelPresetResult = {
    success: boolean
    content: string
    error?: string
}

type PluginModelPresetDatabase = {
    modelPresets?: ModelPreset[]
    nodeOnlyModelModeLock?: 'legacy' | 'preset' | 'none'
}

export type PluginModelPresetRequest = (
    arg: RequestDataArgumentExtended,
    model: ModelModeExtended,
    abortSignal?: AbortSignal,
) => Promise<requestDataResponse>

// User-facing through the plugin's own panel, which is Korean, so these are
// too; the plugin shows `error` verbatim.
const PRESETS_LOCKED_TO_LEGACY = '모델 프리셋이 비활성화되어 있습니다(레거시 모델 모드 고정). 설정에서 모델 프리셋 모드를 허용해 주세요.'
const PRESET_NOT_FOUND = '선택한 모델 프리셋을 찾을 수 없습니다. 프리셋을 다시 선택해 주세요.'
const MESSAGES_INVALID = '요청 메시지 형식이 올바르지 않습니다.'
const RESPONSE_NOT_TEXT = '모델 응답을 텍스트로 받지 못했습니다.'

const PLUGIN_MESSAGE_ROLES = new Set(['system', 'user', 'assistant'])

export function listPluginModelPresets(db: PluginModelPresetDatabase): PluginModelPresetSummary[] {
    return (db.modelPresets ?? [])
        .filter((preset) => typeof preset?.id === 'string' && preset.id.length > 0)
        .map((preset) => ({ id: preset.id, name: typeof preset.name === 'string' ? preset.name : '' }))
}

function toFormated(messages: unknown): OpenAIChat[] | null {
    if (!Array.isArray(messages) || messages.length === 0) return null
    const formated: OpenAIChat[] = []
    for (const message of messages) {
        const role = (message as PluginRunModelPresetMessage)?.role
        const content = (message as PluginRunModelPresetMessage)?.content
        if (!PLUGIN_MESSAGE_ROLES.has(role) || typeof content !== 'string') return null
        formated.push({ role, content })
    }
    return formated
}

const failure = (error: string): PluginRunModelPresetResult => ({ success: false, content: '', error })

export async function runPluginModelPreset(
    options: PluginRunModelPresetOptions,
    deps: { db: PluginModelPresetDatabase; request: PluginModelPresetRequest; abortSignal?: AbortSignal },
): Promise<PluginRunModelPresetResult> {
    const { db, request, abortSignal } = deps
    // `resolveChatModelBinding` would silently take the classic path under a
    // legacy lock, answering from the user's global model as if it were the
    // preset the plugin named. Say so instead.
    if (db.nodeOnlyModelModeLock === 'legacy') return failure(PRESETS_LOCKED_TO_LEGACY)
    const presetId = typeof options?.presetId === 'string' ? options.presetId : ''
    const preset = presetId ? listPluginModelPresets(db).find((entry) => entry.id === presetId) : undefined
    if (!preset) return failure(PRESET_NOT_FOUND)
    const formated = toFormated(options.messages)
    if (!formated) return failure(MESSAGES_INVALID)

    try {
        const response = await request({
            formated,
            bias: {},
            maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : undefined,
            temperature: typeof options.temperature === 'number' ? options.temperature : undefined,
            realChatId: typeof options.chatId === 'string' && options.chatId ? options.chatId : undefined,
            modelBindingTarget: {
                useModelPreset: true,
                modelBinding: { main: presetId, sub: presetId, separateAux: false, aux: {} },
            },
            useStreaming: false,
            noMultiGen: true,
            blockPlugins: true,
            logSource: 'plugin',
            // Without this `requestChatData` hands the request the user's MCP
            // tools, and a preset with tool use on runs the tool loop over a
            // plugin's background prompt: a persona rewrite that writes a
            // file. Same as every other internal request (BardWiki memory,
            // wiki, reranker): a text answer only.
            tools: [],
        }, options.mode ?? 'model', abortSignal)

        if (response.type === 'success') return { success: true, content: response.result }
        if (response.type === 'fail') return failure(response.result)
        if (response.type === 'streaming') return { success: true, content: await collectStreamingText(response.result) }
        return failure(RESPONSE_NOT_TEXT)
    } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
    }
}
