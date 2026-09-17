# 플러그인 제공자 UI 호환성

RisuVault는 모델 요청이 진행되는 동안 우측 상단에 단계, 주입 컨텍스트와 토큰 사용량을 보여 주는 고급 요청 상태 창을 기본으로 표시합니다. 플러그인 제공자가 자체 생성 정보 창을 함께 띄우면 두 창이 중복될 수 있습니다.

## 생성 정보 창 오버라이드

플러그인의 생성 정보 창이 RisuVault 요청 상태 창을 완전히 대신할 때만 제공자 등록 옵션에 `overrideRequestStatus: true`를 지정합니다.

```ts
await Risuai.addProvider('Yumi', requestWithYumi, {
    overrideRequestStatus: true,
})
```

- 옵션을 생략하거나 `false`로 두면 RisuVault 요청 상태 창이 계속 표시됩니다.
- `true`일 때는 해당 플러그인 제공자의 요청에서 RisuVault 창만 숨깁니다. 플러그인의 생성 정보 창을 표시하고 닫는 책임은 플러그인에 있습니다.
- 자체 생성 정보 UI가 없는 플러그인은 이 옵션을 켜지 않습니다.
- 실행 중 선택을 바꿔야 하면 동기 `() => boolean` 또는 비동기 `() => Promise<boolean>` 콜백을 사용할 수 있습니다. RisuVault는 콜백 결과를 기다린 뒤 요청 상태 창 표시 여부를 결정합니다.

```ts
await Risuai.addProvider('Yumi', requestWithYumi, {
    overrideRequestStatus: () => usePluginGenerationWindow,
})
```

이 계약은 플러그인 API v2와 v3 제공자에 모두 적용됩니다. 이전의 역방향 옵션인 `hostRequestStatus: false`도 호환을 위해 유지되지만, 새 플러그인은 의도가 분명한 `overrideRequestStatus: true`를 사용하세요.

## 구조화 JSON 출력

JSON schema를 공급자 API에 직접 전달할 수 있는 플러그인은 제공자 등록 옵션에 `structuredOutput: true`를 지정합니다.

```ts
await Risuai.addProvider('Yumi', requestWithYumi, {
    structuredOutput: true,
})
```

- 구조화 출력 요청에서는 `args.structured_output`이 `true`이고, 네이티브 전달을 시도하는 호출에는 `args.response_schema`가 함께 제공됩니다.
- `response_schema`는 `{ name, strict, schema }`이며 플러그인이 각 공급자의 네이티브 형식으로 변환해야 합니다. `strict`는 사용자의 기존 Strict JSON Schema 설정을 따릅니다.
- 호스트는 호환용 JSON schema 프롬프트도 유지합니다. 공급자가 네이티브 schema 필드를 거부하면 그 필드만 제거해 한 번 재시도하며, 이때도 `structured_output`은 `true`입니다.
- 구조화 출력 응답에는 줄바꿈 복원 같은 일반 텍스트 후처리를 적용하지 마세요. JSON 문자열 안의 escape가 손상될 수 있습니다.
- 네이티브 schema를 지원하지 않는 플러그인은 옵션을 생략하면 기존 프롬프트 방식만 사용합니다.
