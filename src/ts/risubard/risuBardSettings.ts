import { buildWikiWritingLanguageGuard, normalizeWikiWritingLanguage, type WikiWritingLanguage } from './wikiWritingLanguage'

export const RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT = 8_192
export const RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT = 1
export const RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT = 8
/**
 * Canonical rewrite batches of one memory update are independent model
 * requests over the same fixed input, so several may be in flight at once.
 * Three keeps a typical update (2-4 batches) to one or two round trips
 * without stacking enough parallel requests to trip provider rate limits.
 * A limit of 1 is the strictly sequential order the runner used before.
 */
export const RISUBARD_CANONICAL_CONCURRENCY_LIMIT_DEFAULT = 3
export const RISUBARD_CANONICAL_CONCURRENCY_LIMIT_MAXIMUM = 8
export const RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT = 2_000
export const RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT = 6_000
export const RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT = 'concise' as const
export const RISUBARD_CANONICAL_CUSTOM_STYLE_MAX_LENGTH = 1_000

export type RisuBardCanonicalWritingStyle =
    | 'standard'
    | 'concise'
    | 'ultra-concise'
    | 'custom'

export interface RisuBardChatSettings {
    risuBardModelMode?: 'memory' | 'model'
    showRequestStatus?: boolean
    risuBardInquiryTargetTokenBudget?: number
    risuBardInquiryMaximumTokenBudget?: number
    risuBardAnalysisTokenLimit?: number
    risuBardAdditionalSearchLimit?: number
    risuBardCanonicalTargetLimit?: number
    risuBardCanonicalConcurrencyLimit?: number
    risuBardRecentMessageCount?: number
    risuBardResponseMessageCount?: number
    risuBardResponseExcludeUserMessages?: boolean
    risuBardCanonicalWritingStyle?: RisuBardCanonicalWritingStyle
    risuBardCanonicalCustomStyle?: string
    risuBardWikiWritingLanguage?: WikiWritingLanguage
    bardChatIncludeWiki?: boolean
    bardChatIncludeChat?: boolean
    bardChatIncludeSystemPrompt?: boolean
    bardChatIncludeCharacterDescription?: boolean
    bardChatIncludePersona?: boolean
    bardChatIncludeCharacterLorebook?: boolean
    bardChatIncludeModuleLorebook?: boolean
}

export interface ResolvedRisuBardChatSettings {
    risuBardModelMode: 'memory' | 'model'
    showRequestStatus: boolean
    risuBardInquiryTargetTokenBudget: number
    risuBardInquiryMaximumTokenBudget: number
    risuBardAnalysisTokenLimit: number
    risuBardAdditionalSearchLimit: number
    risuBardCanonicalTargetLimit: number
    risuBardCanonicalConcurrencyLimit: number
    risuBardRecentMessageCount: number
    risuBardResponseMessageCount: number
    risuBardResponseExcludeUserMessages: boolean
    risuBardCanonicalWritingStyle: RisuBardCanonicalWritingStyle
    risuBardCanonicalCustomStyle: string
    risuBardWikiWritingLanguage: WikiWritingLanguage
    bardChatIncludeWiki: boolean
    bardChatIncludeChat: boolean
    bardChatIncludeSystemPrompt: boolean
    bardChatIncludeCharacterDescription: boolean
    bardChatIncludePersona: boolean
    bardChatIncludeCharacterLorebook: boolean
    bardChatIncludeModuleLorebook: boolean
}

function boundedInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER
): number {
    if (!Number.isFinite(value) || typeof value !== 'number') return fallback
    const rounded = Math.round(value)
    if (!Number.isSafeInteger(rounded)) return fallback
    return Math.max(minimum, Math.min(maximum, rounded))
}

export function resolveRisuBardChatSettings(
    global: RisuBardChatSettings,
    chat?: RisuBardChatSettings,
): ResolvedRisuBardChatSettings {
    const value = <K extends keyof RisuBardChatSettings>(key: K) =>
        chat?.[key] ?? global[key]
    const inquiry = normalizeRisuBardInquiryTokenBudget(
        value('risuBardInquiryTargetTokenBudget'),
        value('risuBardInquiryMaximumTokenBudget'),
    )
    return {
        risuBardModelMode: value('risuBardModelMode') === 'model' ? 'model' : 'memory',
        showRequestStatus: value('showRequestStatus') !== false,
        risuBardInquiryTargetTokenBudget: inquiry.target,
        risuBardInquiryMaximumTokenBudget: inquiry.maximum,
        risuBardAnalysisTokenLimit: normalizeRisuBardAnalysisTokenLimit(
            value('risuBardAnalysisTokenLimit')
        ),
        risuBardAdditionalSearchLimit: normalizeRisuBardAdditionalSearchLimit(
            value('risuBardAdditionalSearchLimit')
        ),
        risuBardCanonicalTargetLimit: normalizeRisuBardCanonicalTargetLimit(
            value('risuBardCanonicalTargetLimit')
        ),
        risuBardCanonicalConcurrencyLimit:
            normalizeRisuBardCanonicalConcurrencyLimit(
                value('risuBardCanonicalConcurrencyLimit')
            ),
        risuBardRecentMessageCount: boundedInteger(
            value('risuBardRecentMessageCount'), 12, 1
        ),
        risuBardResponseMessageCount: boundedInteger(
            value('risuBardResponseMessageCount'), 12, 1
        ),
        risuBardResponseExcludeUserMessages:
            value('risuBardResponseExcludeUserMessages') === true,
        risuBardCanonicalWritingStyle: normalizeRisuBardCanonicalWritingStyle(
            value('risuBardCanonicalWritingStyle')
        ),
        risuBardCanonicalCustomStyle: normalizeRisuBardCanonicalCustomStyle(
            value('risuBardCanonicalCustomStyle')
        ),
        risuBardWikiWritingLanguage: normalizeWikiWritingLanguage(value('risuBardWikiWritingLanguage')),
        bardChatIncludeWiki: value('bardChatIncludeWiki') !== false,
        bardChatIncludeChat: value('bardChatIncludeChat') === true,
        bardChatIncludeSystemPrompt:
            value('bardChatIncludeSystemPrompt') === true,
        bardChatIncludeCharacterDescription:
            value('bardChatIncludeCharacterDescription') === true,
        bardChatIncludePersona: value('bardChatIncludePersona') === true,
        bardChatIncludeCharacterLorebook:
            value('bardChatIncludeCharacterLorebook') === true,
        bardChatIncludeModuleLorebook:
            value('bardChatIncludeModuleLorebook') === true,
    }
}

export function normalizeRisuBardAnalysisTokenLimit(value: unknown): number {
    return boundedInteger(
        value,
        RISUBARD_ANALYSIS_TOKEN_LIMIT_DEFAULT,
        3_072
    )
}

export function normalizeRisuBardAdditionalSearchLimit(value: unknown): number {
    return boundedInteger(
        value,
        RISUBARD_ADDITIONAL_SEARCH_LIMIT_DEFAULT,
        0
    )
}

export function normalizeRisuBardCanonicalTargetLimit(value: unknown): number {
    return boundedInteger(
        value,
        RISUBARD_CANONICAL_TARGET_LIMIT_DEFAULT,
        1
    )
}

export function normalizeRisuBardCanonicalConcurrencyLimit(
    value: unknown
): number {
    return boundedInteger(
        value,
        RISUBARD_CANONICAL_CONCURRENCY_LIMIT_DEFAULT,
        1,
        RISUBARD_CANONICAL_CONCURRENCY_LIMIT_MAXIMUM
    )
}

export function normalizeRisuBardInquiryTokenBudget(
    target: unknown,
    maximum: unknown
): { target: number; maximum: number } {
    const normalizedMaximum = boundedInteger(
        maximum,
        RISUBARD_INQUIRY_MAXIMUM_TOKEN_BUDGET_DEFAULT,
        256
    )
    return {
        target: boundedInteger(
            target,
            RISUBARD_INQUIRY_TARGET_TOKEN_BUDGET_DEFAULT,
            256,
            normalizedMaximum
        ),
        maximum: normalizedMaximum,
    }
}

export function normalizeRisuBardCanonicalWritingStyle(
    value: unknown
): RisuBardCanonicalWritingStyle {
    return value === 'standard'
        || value === 'concise'
        || value === 'ultra-concise'
        || value === 'custom'
        ? value
        : RISUBARD_CANONICAL_WRITING_STYLE_DEFAULT
}

export function normalizeRisuBardCanonicalCustomStyle(value: unknown): string {
    return typeof value === 'string'
        ? value.trim().slice(0, RISUBARD_CANONICAL_CUSTOM_STYLE_MAX_LENGTH)
        : ''
}

const CONCISE_CANONICAL_STYLE = [
    '장식적 설명과 기존 사실의 반복을 제거한다.',
    '사실 하나당 한 문장을 사용한다.',
    '주체, 대상, 부정, 시간과 인물별 지식 경계는 생략하지 않는다.',
    '임의의 약어를 만들지 않는다.',
].join(' ')

function resolveRisuBardWritingStyleInstruction(
    style: unknown,
    customStyle: unknown,
    language: WikiWritingLanguage = 'ko'
): string {
    const normalizedStyle = normalizeRisuBardCanonicalWritingStyle(style)
    const normalizedCustom = normalizeRisuBardCanonicalCustomStyle(customStyle)
    if (language === 'en') {
        if (normalizedStyle === 'custom' && normalizedCustom) return `User style preference: ${normalizedCustom}`
        if (normalizedStyle === 'standard') return 'Use natural, complete short sentences without unnecessary embellishment or repetition.'
        if (normalizedStyle === 'ultra-concise') return 'Use telegraphic sentences and stable field labels, one atomic fact per line. Explicitly preserve subjects, objects, negation, time and character knowledge boundaries. Do not invent abbreviations.'
        return 'Remove decorative prose and repeated facts. Use one sentence per fact. Preserve subjects, objects, negation, time and character knowledge boundaries. Do not invent abbreviations.'
    }
    const styleInstruction = normalizedStyle === 'standard'
        ? '자연스럽고 완결된 짧은 문장을 사용하되 불필요한 수식과 반복을 피한다.'
        : normalizedStyle === 'ultra-concise'
            ? '전보체에 가까운 짧은 문장과 안정된 필드 표현을 사용한다. 원자적 사실 하나당 한 줄을 사용하고 주체, 대상, 부정, 시간과 인물별 지식 경계는 반드시 명시한다. 임의의 약어를 만들지 않는다.'
            : normalizedStyle === 'custom' && normalizedCustom.length > 0
                ? `사용자 문체 선호: ${normalizedCustom}`
                : CONCISE_CANONICAL_STYLE
    return styleInstruction
}

export function buildRisuBardEventWritingPolicy(
    style: unknown,
    customStyle: unknown,
    language: WikiWritingLanguage = 'ko'
): string {
    if (language === 'en') return [
        '## Canonical writing policy',
        resolveRisuBardWritingStyleInstruction(style, customStyle, language),
        'When compressing, do not invent action targets or locations, turn temporal order into causation, or cross character knowledge boundaries at the time of an event.',
        'Preserve observed puzzle elements, order, spatial layout, pairings, blanks, mechanism positions and attempt outcomes. Separate observations from inferred rules or solutions; retain unresolved clues as open continuity.',
        'Style affects expression only; it cannot change fact selection, evidence, structure or safety rules.',
        buildWikiWritingLanguageGuard(language),
    ].join('\n')
    return [
        '## 정본 집필 정책',
        '사건 이야기 요약과 정본 Markdown 본문은 한국어로 작성한다.',
        resolveRisuBardWritingStyleInstruction(style, customStyle),
        '압축할 때도 원문에 없는 행동 대상이나 장소를 보충하지 않는다. 시간적 선후를 인과로 바꾸지 않는다. 사건 당시 인물별 지식 경계를 유지한다.',
        '퍼즐, 암호, 의식, 조합 장치나 규칙 기반 단서는 관찰된 요소, 순서, 공간 배치, 짝, 빈칸, 장치 위치와 시도 결과를 보존한다. 확정 관찰과 추론한 규칙·정답을 분리하고 미해결 부분은 연속성으로 남긴다.',
        '이 문체 정책은 표현 형식에만 적용하며 사실 선택, 근거, 구조 및 안전 규칙을 변경하지 않는다.',
        buildWikiWritingLanguageGuard(language),
    ].join('\n')
}

export function buildRisuBardCanonicalWritingPolicy(
    style: unknown,
    customStyle: unknown,
    language: WikiWritingLanguage = 'ko'
): string {
    if (language === 'en') return [
        buildRisuBardEventWritingPolicy(style, customStyle, language),
        'Every character document must summarize verified current facts in a self-contained `### Current State` section near the top.',
        'Every character document must include a `### Story History` section with at most 16 chronological bullets for causally necessary turning points.',
        'Merge older consecutive turning points into larger causal units when necessary; do not accumulate a turn-by-turn action log.',
        'Link corresponding event documents with exact [[event document titles]]. Preserve unrelated established facts.',
        'When new facts replace old ones, do not present both states as current. Keep detailed history in event documents instead of duplicating it in character canon.',
    ].join('\n')
    return [
        buildRisuBardEventWritingPolicy(style, customStyle, language),
        '모든 캐릭터 정본은 문서 상단의 `### 현재 상태` 절에 확인된 현재 사실을 자족적으로 요약한다.',
        '모든 캐릭터 정본에는 `### 작중 행적` 절을 두고, 인과에 필요한 전환점만 시간순으로 최대 16개 글머리표에 압축한다.',
        '새 전환점으로 16개를 넘으면 오래된 연속 전환점을 더 큰 인과 단위로 합치며 턴별 행동 기록을 누적하지 않는다.',
        '대응하는 사건 문서가 있으면 행적 글머리표에 `[[사건 문서 제목]]` 링크를 사용한다.',
        '새 사실이 기존 사실을 대체하면 이전 상태를 현재 사실처럼 병기하지 않는다.',
        '상세 과거 행적은 사건 문서에 근거로 남기고 캐릭터 정본에 중복 복사하지 않는다.',
    ].join('\n')
}
