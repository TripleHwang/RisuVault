# BardWiki 플러그인 API 레퍼런스

RisuBard의 Plugin API v3는 현재 채팅의 BardWiki 컨텍스트와 문서를 읽고 수정할 수 있는 `Risuai.bardWiki` API를 제공합니다. 기존 장기기억 필드를 읽는 플러그인은 코드를 바꾸지 않아도 BardWiki 컨텍스트를 받을 수 있습니다.

## 기존 장기기억 플러그인 호환

플러그인이 `Risuai.getCharacter()`, `Risuai.getChar()`, 인덱스 기반 캐릭터 또는 채팅 getter, 권한이 있는 데이터베이스 getter로 채팅을 읽으면 RisuBard가 다음 필드에 같은 가상 컨텍스트를 제공합니다.

- `chat.hypaV3Data.summaries`
- `chat.hypaV2Data.mainChunks`
- `chat.supaMemoryData`

가상 컨텍스트에는 조회된 BardWiki 문서와 BardWiki 응답 설정에 따른 최근 메시지가 함께 들어갑니다. `응답 최근 메시지 수`가 범위를 정하고, 과거 사용자 메시지 제외가 켜져 있어도 현재 입력에 해당하는 가장 최근 사용자 메시지는 유지됩니다.

이 데이터는 Plugin API가 반환하는 복제본에만 존재합니다. 플러그인이 받은 캐릭터, 채팅 또는 데이터베이스 객체를 다시 저장해도 가상 컨텍스트는 제거되므로 실제 Hypa 또는 Supa 메모리 데이터에 기록되지 않습니다. BardWiki 조회가 실패해도 getter는 원래 플러그인 데이터를 반환합니다.

플러그인이 장기기억과 별도로 대화 전문을 모델에 보내는 옵션을 제공한다면, 토큰을 줄이려면 그 대화 전문 옵션을 끄는 것이 좋습니다. BardWiki 가상 컨텍스트 자체에 설정된 범위의 최근 메시지가 이미 포함됩니다.

## API 찾기

Plugin API v3 타입 선언은 `src/ts/plugins/apiV3/risuai.d.ts`에 있습니다. 플러그인에서는 소문자와 대문자 전역 객체를 모두 사용할 수 있습니다.

```typescript
const context = await Risuai.bardWiki.getContext();
// risuai.bardWiki.getContext()도 동일합니다.
```

모든 BardWiki API는 현재 선택된 캐릭터와 저장된 채팅으로 범위가 제한됩니다. 플러그인이 임의의 서버 경로나 다른 채팅 ID를 지정할 수 없습니다.

## 컨텍스트 읽기

```typescript
const context = await Risuai.bardWiki.getContext();

console.log(context.content);
console.log(context.sources);
console.log(context.recentMessages);
console.log(context.metrics);
```

특정 작업을 위한 조회어를 지정할 수도 있습니다.

```typescript
const context = await Risuai.bardWiki.getContext({
  query: '주인공이 봉인된 문을 마지막으로 조사한 사건',
});
```

`content`는 모델 입력에 바로 넣을 수 있는 문자열입니다. `sources`는 선택된 BardWiki 근거, `recentMessages`는 현재 응답 설정으로 제한한 최근 대화, `metrics`는 조회 통계입니다. 조회어를 생략하면 최근 사용자 메시지를 사용합니다.

## 문서 목록 읽기

```typescript
const events = await Risuai.bardWiki.getDocuments({
  types: ['event', 'scene'],
  statuses: ['active'],
});
```

필터를 생략하면 현재 채팅의 모든 BardWiki 문서를 반환합니다. 반환 문서에는 `id`, `type`, `status`, `title`, `aliases`, `content`, `links`, `contextMode`, `contentHash` 등이 포함됩니다. 서버의 실제 `wikiPath`는 노출하지 않습니다.

지원 문서 타입은 다음과 같습니다.

```typescript
type BardWikiDocumentType =
  | 'event'
  | 'character'
  | 'location'
  | 'scene'
  | 'faction'
  | 'creature'
  | 'item'
  | 'concept'
  | 'other';
```

읽기 메서드는 별도 권한을 요구하지 않습니다. 플러그인은 이미 현재 캐릭터와 채팅 원문을 읽을 수 있으므로 BardWiki 읽기도 같은 범위로 취급합니다.

## 문서 생성과 수정

```typescript
const created = await Risuai.bardWiki.saveDocument({
  type: 'concept',
  title: '봉인의 규칙',
  aliases: ['봉인 규칙'],
  markdown: '# 봉인의 규칙\n\n봉인은 세 개의 열쇠가 모두 있어야 열린다.',
});
```

기존 문서를 수정할 때는 문서 ID와 마지막으로 읽은 내용 해시를 함께 보냅니다.

```typescript
const updated = await Risuai.bardWiki.saveDocument({
  documentId: document.id,
  type: document.type,
  title: document.title,
  aliases: document.aliases,
  markdown: nextMarkdown,
  expectedContentHash: document.contentHash,
});
```

`expectedContentHash`는 플러그인이 문서를 읽은 뒤 사용자가 먼저 수정한 내용을 덮어쓰지 않게 하는 낙관적 동시성 검사입니다. 해시가 오래되었으면 저장이 실패하므로 문서를 다시 읽고 변경 내용을 합쳐야 합니다.

## 컨텍스트 모드 변경

```typescript
const updated = await Risuai.bardWiki.setContextMode({
  documentId: document.id,
  contextMode: 'always',
  expectedContentHash: document.contentHash,
});
```

`contextMode`는 다음 값을 사용합니다.

- `always`: 매 조회에서 항상 포함
- `auto`: 현재 입력과 관련 있을 때 포함
- `never`: 자동 컨텍스트에서 제외

## 문서 삭제

```typescript
const result = await Risuai.bardWiki.trashDocument(document.id);
```

문서는 즉시 영구 삭제되지 않고 BardWiki 휴지통으로 이동합니다.

## 쓰기 권한과 오류 처리

`saveDocument`, `setContextMode`, `trashDocument`를 처음 호출하면 현재 플러그인에 BardWiki 쓰기 권한을 줄지 묻습니다. 사용자가 거부하면 메서드는 `null`을 반환합니다. 읽기 메서드는 권한 창을 열지 않습니다.

저장된 채팅이 선택되지 않았거나 서버 검증, 내용 해시, 입력 길이 등의 조건을 통과하지 못하면 메서드는 오류를 던집니다. 네트워크 및 검증 오류는 플러그인에서 처리해야 합니다.

```typescript
try {
  const saved = await Risuai.bardWiki.saveDocument(draft);
  if (saved === null) {
    console.log('사용자가 BardWiki 쓰기 권한을 허용하지 않았습니다.');
  }
} catch (error) {
  console.error('BardWiki 저장 실패', error);
}
```

기존 장기기억 호환 getter만 사용하는 플러그인은 BardWiki 조회 실패를 따로 처리할 필요가 없습니다. 그 경로는 실패 시 원래 채팅 데이터를 그대로 반환합니다.
