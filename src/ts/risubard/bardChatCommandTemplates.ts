export interface BardChatCommandTemplate {
    id: string
    command: string
    title: string
    description: string
    prompt: string
}

export const BARDCHAT_COMMAND_TEMPLATES: readonly BardChatCommandTemplate[] = [{
    id: 'combine',
    command: 'COMBINE',
    title: '항목 결합',
    description: '둘 이상의 중복·별칭 문서를 하나의 정본으로 합칩니다.',
    prompt: `작업: COMBINE
대상: <결합할 문서 제목 또는 ID를 2개 이상 입력>
존속 문서: <유지할 문서 제목 또는 ID. 판단을 맡기려면 "선택"이라고 입력>
규칙:
- 대상들이 실제로 같은 실체인지 먼저 확인하고, 다르면 변경하지 마세요.
- 안정 ID를 유지할 하나를 존속 문서로 선택하세요.
- 각 문서의 확정된 사실과 출처를 보존하고, 중복·모순은 구분해 통합하세요.
- 다른 문서의 직접 위키 링크를 존속 문서로 재연결하세요.
- 모든 갱신이 끝난 뒤 중복 문서만 마지막에 휴지통으로 이동하세요.`,
}, {
    id: 'split',
    command: 'SPLIT',
    title: '항목 분리',
    description: '한 문서에 섞인 서로 다른 실체나 주제를 분리합니다.',
    prompt: `작업: SPLIT
대상: <분리할 문서 제목 또는 ID>
분리 기준: <실체·시점·주제 등 구체적인 기준>
규칙:
- 원본의 안정 ID에는 주된 실체를 남기세요.
- 새 문서는 명확히 독립된 내용에 대해서만 만드세요.
- 사실과 출처를 누락하지 말고 관련 위키 링크를 새 구조에 맞게 갱신하세요.`,
}, {
    id: 'expand',
    command: 'EXPAND',
    title: '상세 확장',
    description: '기존 사실을 유지하며 지정한 절을 더 자세히 씁니다.',
    prompt: `작업: EXPAND
대상: <문서 제목 또는 ID>
범위: <확장할 절 또는 주제>
규칙:
- 제공된 위키와 사용자 지시에 있는 사실만 사용하세요.
- 기존 사실과 지식 경계를 보존하고, 추측은 확정 사실처럼 쓰지 마세요.
- 문서 전체를 반환하되 관련 없는 절은 그대로 유지하세요.`,
}, {
    id: 'shorten',
    command: 'SHORTEN',
    title: '간결화',
    description: '의미와 현재 상태를 보존하면서 장황한 문서를 줄입니다.',
    prompt: `작업: SHORTEN
대상: <문서 제목 또는 ID>
목표 길이: <예: 현재의 60% 또는 1200자>
규칙:
- 현재 상태, 관계, 지식, 목표, 제약과 중요한 인과를 보존하세요.
- 반복 표현과 사건 문서에 이미 있는 세부만 줄이세요.
- 확정 사실을 합치거나 삭제해 의미를 바꾸지 마세요.`,
}, {
    id: 'summarize',
    command: 'SUMMARIZE',
    title: '요약',
    description: '하나 이상의 문서를 목적에 맞는 요약으로 정리합니다.',
    prompt: `작업: SUMMARIZE
대상: <문서 제목 또는 ID>
요약 목적: <현재 상태 / 관계 / 사건 흐름 / 사용자 지정>
출력 위치: <기존 절 갱신 또는 새 문서 제목>
규칙:
- 원문에 없는 인과나 결론을 만들지 마세요.
- 현재 사실과 과거 사실을 구분하고, 필요한 위키 링크를 유지하세요.`,
}, {
    id: 'reconnect',
    command: 'RECONNECT',
    title: '링크 재연결',
    description: '이름 변경·결합 뒤 끊기거나 낡은 위키 링크를 고칩니다.',
    prompt: `작업: RECONNECT
대상: <기준 문서 제목 또는 ID. 전체 검사라면 "전체">
규칙:
- 실제 문서 제목과 ID를 기준으로 직접 위키 링크를 검사하세요.
- 이름이 바뀌거나 결합된 대상을 현재 활성 문서로 재연결하세요.
- 같은 표기지만 서로 다른 실체가 모호하면 추측해 연결하지 말고 변경에서 제외하세요.
- 링크 외의 서사 내용은 바꾸지 마세요.`,
}, {
    id: 'networking',
    command: 'NETWORKING',
    title: '관계망 정리',
    description: '인물·장소·조직 사이의 확인된 관계와 링크를 정리합니다.',
    prompt: `작업: NETWORKING
대상: <중심 문서 제목 또는 ID. 전체라면 "전체">
관계 범위: <인물 / 장소 / 조직 / 물건 / 전체>
규칙:
- 문서에 명시된 관계만 사용해 양쪽 관련 문서에 필요한 직접 링크를 보강하세요.
- 관계의 방향, 인물별 지식과 현재·과거 상태를 혼동하지 마세요.
- 단순 동시 등장만으로 관계를 창작하지 마세요.`,
}, {
    id: 'deduplicate',
    command: 'DEDUPLICATE',
    title: '중복 정리',
    description: '중복 가능성이 있는 문서를 찾아 결합 후보를 안전하게 정리합니다.',
    prompt: `작업: DEDUPLICATE
범위: <문서 유형 또는 전체>
규칙:
- 제목 유사성만으로 동일 실체라고 단정하지 마세요.
- 같은 실체라는 근거가 충분한 문서만 COMBINE 규칙으로 결합하세요.
- 모호한 후보는 변경하지 말고 실행 결과의 실패 사유로 구체적으로 남기세요.`,
}, {
    id: 'reconcile',
    command: 'RECONCILE',
    title: '모순 조정',
    description: '여러 문서 사이의 충돌을 현재 정본과 사건 근거에 맞춰 정리합니다.',
    prompt: `작업: RECONCILE
대상: <서로 충돌하는 문서 제목 또는 ID>
우선 기준: <사용자 지정 사실 또는 사건 근거>
규칙:
- 현재 상태, 과거 전환, 인물의 믿음을 서로 다른 층위로 구분하세요.
- 근거 없이 한쪽을 삭제하지 말고 해결할 수 없는 충돌은 명시적으로 보존하세요.
- 사용자가 지정한 사실은 위키 내용의 최우선 권한으로 적용하세요.`,
}, {
    id: 'normalize',
    command: 'NORMALIZE',
    title: '구조 정규화',
    description: '내용은 유지하고 문서 제목과 절 구조를 정돈합니다.',
    prompt: `작업: NORMALIZE
대상: <문서 제목 또는 ID>
규칙:
- H2 문서 제목과 H3 이하 절 구조로 정리하세요.
- 현재 상태와 정체성 정보를 앞쪽에 두고 작중 행적은 시간순으로 유지하세요.
- 사실, 링크와 표현상 중요한 원문은 삭제하거나 새로 만들지 마세요.`,
}, {
    id: 'rename',
    command: 'RENAME',
    title: '이름 변경',
    description: '안정 ID를 유지하면서 문서 제목과 직접 링크를 바꿉니다.',
    prompt: `작업: RENAME
대상: <문서 제목 또는 ID>
새 제목: <변경할 제목>
규칙:
- 기존 문서의 targetDocumentId를 그대로 사용하세요.
- 본문 H2 제목을 바꾸고 다른 문서의 직접 위키 링크도 새 제목으로 갱신하세요.
- 이름 외의 서사 내용과 문서 유형은 유지하세요.`,
}, {
    id: 'reclassify',
    command: 'RECLASSIFY',
    title: '유형 변경',
    description: '기존 문서의 안정 ID와 내용을 유지하며 유형을 변경합니다.',
    prompt: `작업: RECLASSIFY
대상: <문서 제목 또는 ID>
새 유형: <character / location / scene / faction / creature / item / concept / other>
규칙:
- 기존 targetDocumentId를 사용하고 확정 내용과 링크를 보존하세요.
- 사건(event)은 다른 유형으로 바꾸거나 새로 만들지 마세요.
- 새 유형에 맞게 절 구조만 필요한 범위에서 정리하세요.`,
}, {
    id: 'extract',
    command: 'EXTRACT',
    title: '현재 대화에서 추출',
    description: '현재 메시지나 대화에서 지정한 정본을 만들거나 갱신합니다.',
    prompt: `작업: EXTRACT
출처: 현재 메시지
대상: <추출할 인물·장소·조직·물건·개념>
규칙:
- 현재 메시지에 실제로 있는 정보와 사용자 지시만 사용하세요.
- 기존 문서가 있으면 정확한 targetDocumentId로 갱신하고 중복 생성하지 마세요.
- 대상별로 독립 정본이 필요하면 각각 완전한 문서로 만드세요.`,
}, {
    id: 'timeline',
    command: 'TIMELINE',
    title: '연대기 정리',
    description: '사건이나 인물의 행적을 인과가 보이도록 시간순으로 정리합니다.',
    prompt: `작업: TIMELINE
대상: <문서 제목 또는 ID>
범위: <전체 / 특정 시점 이후 / 사용자 지정>
규칙:
- 작품 내부 연대기와 문서 생성 순서를 혼동하지 마세요.
- 확인된 사건의 순서만 사용하고 불명확한 순서는 불명확하다고 표시하세요.
- 현재 상태 절에는 현재 사실만 남기고 과거 전환은 작중 행적으로 정리하세요.`,
}]
