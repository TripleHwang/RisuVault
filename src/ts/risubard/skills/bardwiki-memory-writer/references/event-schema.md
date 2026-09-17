# 사건 초안 필드 계약

- `title`: 사건이나 변화 하나를 식별하는 짧은 제목. Markdown 표식을 넣지 않는다.
- `establishedEvents`: 확정 본문에서 실제로 일어난 사건. 시간 순서대로 최대 12개. 이 배열만 이어 읽어도 이야기 흐름이 자연스러워야 하며 상태 관리, 미완성 플롯 관리, 정본 갱신 제안은 넣지 않는다.
- `stateChanges`: `subject`, `before`, `after`. `before`가 근거에 없으면 `null`.
- `characterKnowledge`: `character`, `fact`, `stance`. `stance`는 직접 안 사실인 `knows` 또는 사실 여부와 무관한 믿음인 `believes`.
- `persistentFacts`: 이후 장면에도 유지되어야 할 현재 사실.
- `openContinuity`: 아직 해결되지 않았지만 이후 일관성에 필요한 질문·약속·위험.
- `canonicalUpdateCandidates`: 정본 후보의 `type`, `title`, `aliases`, `reason`, `action`, `targetDocumentId`, `confidence`. 자동 반영하지 않는다.

모든 문자열은 한 항목당 500자 이하로 간결하게 쓴다. 같은 사실을 여러 배열에 불필요하게 복제하지 않는다. 기록할 만한 사실이 하나도 없으면 저장 가능한 초안을 꾸미지 말고 빈 의미 배열을 반환한다. 프로그램이 이를 거부하거나 무변화로 처리한다.
