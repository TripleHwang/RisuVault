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
- 실행 중 선택을 바꿔야 하면 `() => boolean` 콜백을 사용할 수 있습니다.

```ts
await Risuai.addProvider('Yumi', requestWithYumi, {
    overrideRequestStatus: () => usePluginGenerationWindow,
})
```

이 계약은 플러그인 API v2와 v3 제공자에 모두 적용됩니다. 이전의 역방향 옵션인 `hostRequestStatus: false`도 호환을 위해 유지되지만, 새 플러그인은 의도가 분명한 `overrideRequestStatus: true`를 사용하세요.
