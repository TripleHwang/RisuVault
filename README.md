<p align="center">
  <a href="README.en.md">English</a> · <strong>한국어</strong>
</p>

<h1 align="center">RisuVault</h1>

<p align="center">
  대화가 길어져도 무너지지 않는 셀프 호스팅 AI 캐릭터 채팅 프론트엔드
</p>

<p align="center">
  <a href="https://github.com/TripleHwang/RisuVault/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/TripleHwang/RisuVault?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="라이선스: GPL-3.0-only" src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg"></a>
</p>

<p align="center">
  <strong><a href="https://github.com/TripleHwang/RisuVault/releases">다운로드</a></strong> ·
  <a href="docs/ko/install.md">설치</a> ·
  <a href="docs/ko/migration.md">RisuAI에서 이전</a> ·
  <a href="https://github.com/TripleHwang/RisuVault/issues">이슈</a>
</p>

---

## 무엇인가

RisuVault는 RisuAI 생태계의 캐릭터·CHARX 카드·로어북·모듈·프롬프트 프리셋·모델 제공자·플러그인을 그대로 쓰면서, **수천 개 메시지가 쌓인 대화를 실제로 감당하는 것**을 목표로 하는 프론트엔드입니다.

모델을 포함하거나 호스팅하지 않습니다. 사용자가 준비한 로컬 모델이나 원격 제공자를 연결해 씁니다.

## 왜 만들었나

캐릭터 채팅에는 서로 다른 두 한계가 있습니다.

**모델의 컨텍스트 창.** 대화가 길어지면 모델이 앞부분을 못 봅니다. [RisuBard](https://github.com/rpaddict/RisuBard)가 이 문제를 다룹니다 — 원본 대화는 근거로 남기고, 장기 서사는 Obsidian 호환 Markdown(BardWiki)에 기록하고, 매 요청에는 관련된 기억만 정해진 예산 안에서 넣습니다.

**앱 자신의 한계.** 이건 별개입니다. 대화 전체를 메모리에 올리고, 저장할 때마다 전부 훑고, 화면에 전부 그리는 구조는 메시지 수가 늘면 그냥 무너집니다. 느려지는 게 아니라 저장이 실패하고 브라우저가 죽습니다.

RisuVault는 RisuBard를 포크해서 **두 번째 문제**를 파고든 갈래입니다. 대화를 파일과 관계형 데이터베이스에 흩어 두고, 화면과 프롬프트에는 그때 필요한 만큼만 올립니다.

## 무엇이 달라졌나

측정값입니다. 전부 실제 조건에서 잰 것입니다.

| | 이전 | 지금 |
|---|---|---|
| 메시지 1,200개 대화, 전송 준비 | 740개 로드 · 요청 7회 | **40개 · 요청 0회** |
| 에셋 4,000개 캐릭터, 메시지 20개 화면 | 1,248ms | **41ms** |
| 플러그인 저장소 293MB, 앱 시작 | 482ms · 586MB | **키 하나당 1.9ms** |
| 렌더당 강제 레이아웃 계산 | 62회 | **0회** |
| 스크롤 중 최악 프레임 | 99ms | **19ms** |
| 포터블 설치 용량 | 750MB | **46MB** |

용량 감축 방식은 [PocketRisu](https://github.com/PocketRisu/PocketRisu)에서 가져왔습니다. 두 프로젝트 모두 GPL-3.0-only입니다.

## 작동 방식

**정본은 파일입니다.** 사용자 데이터의 원본은 일반 JSON·JSONL·Markdown과 content-addressed 파일입니다. SQLite와 `database.bin`은 정본이 아니라 파생물이며, 언제든 파일에서 다시 만들 수 있습니다. 기존 클라이언트나 RisuAI로 내보낼 때만 필요합니다.

**저장은 원자적입니다.** 같은 파일시스템에 임시 파일로 쓰고, fsync, 체크섬·스키마 검증, 원자적 rename, 부모 디렉터리 fsync를 거칩니다. `.bak` 리비전과 복구 가능한 저널을 남기고, 삭제는 지우지 않고 `trash/`로 옮깁니다. 사용자 메시지는 모델에 요청을 보내기 **전에** fsync하므로, 중간에 끊겨도 답변 초안까지 복구됩니다.

**필요한 만큼만 올립니다.** 화면에는 읽고 있는 구간의 메시지만 붙이고, 스크롤을 따라 창을 옮깁니다. 프롬프트에 넣을 개수는 응답 메시지 수·최근 기억 수·로어북 항목별 검색 깊이를 미리 훑어서 정합니다. 설정이 실제로 읽는 만큼만 불러옵니다.

**기억은 읽을 수 있는 형태로 남습니다.** BardWiki는 Obsidian 호환 Markdown입니다. 앱 없이도 열리고, 고치면 그대로 반영됩니다.

## 주요 기능

- RisuAI 캐릭터·CHARX 카드·로어북·모듈·프롬프트 프리셋 호환
- 고정 예산 서사 메모리 (BardWiki) — 절 단위 갱신, 자동 작성 제어, 작업 취소
- 파일 정본 저장 + 관계형 SQLite, 다중 탭·다중 기기 쓰기 조정
- 긴 대화용 창 단위 로딩 — 메시지 수천 개에서도 열리고 저장됨
- 요청 한도(429)에 걸리면 대기 후 재시도, 남은 시간 표시와 즉시 취소
- 플러그인 API v1·v2·v2.1·v3 지원, v3 전용 환경에서는 저장소를 키 단위로 읽음
- 원격 접속, Termux(안드로이드) 실행
- Windows · macOS(Apple Silicon) · Linux(x64/ARM) 포터블, Docker 이미지

## 빠른 시작

가장 간단한 방법은 포터블 패키지입니다. Node.js가 필요 없습니다.

[Releases](https://github.com/TripleHwang/RisuVault/releases)에서 OS에 맞는 파일을 받아 압축을 풀고 실행하면 됩니다.

| OS | 파일 |
|---|---|
| Windows (x64) | `RisuVault-vX.X.X-win-x64.zip` |
| macOS (Apple Silicon) | `RisuVault-vX.X.X-macos-arm64.tar.gz` |
| Linux (x64) | `RisuVault-vX.X.X-linux-x64.tar.gz` |
| Linux (ARM64) | `RisuVault-vX.X.X-linux-arm64.tar.gz` |

Docker, 설치 스크립트, 소스 빌드는 [설치 가이드](docs/ko/install.md)를 참고하세요. 소스에서 빌드하려면 Node.js 22.12 이상이 필요합니다.

데이터 저장 위치는 실행 전에 지정할 수 있습니다.

```bash
RISUBARD_DATA_ROOT=/원하는/경로 node server/node/server.cjs
```

## 이전과 호환성

RisuAI의 `database.bin`, save-folder, 옛 `risuai.db`를 가져올 수 있습니다. 병합과 교체 중 어느 쪽인지 명시적으로 고를 수 있고, 옛 `risuai.db`는 `migration-backups/`에 복사한 뒤 한 번만 읽습니다. 이후 정상 동작에는 SQLite가 필요 없습니다.

캐릭터·CHARX·로어북·모듈·프리셋은 그대로 쓰입니다. 자세한 절차는 [이전 가이드](docs/ko/migration.md)에 있습니다.

## 데이터와 개인정보

모든 데이터는 사용자가 지정한 디렉터리에 남습니다. RisuVault는 어디에도 데이터를 보내지 않으며, 텔레메트리가 없습니다. 네트워크 요청은 사용자가 직접 설정한 모델 제공자로만 나갑니다.

## 문서

- [설치](docs/ko/install.md)
- [RisuAI에서 이전](docs/ko/migration.md)
- [파일 정본 저장 구조](docs/ko/file-native-storage.md)
- [BardWiki 메모리](docs/ko/memory-wiki.md)
- [긴 대화 메모리 실험 기록](docs/ko/memory-wiki-long-chat-experiment.md)
- [원격 접속](docs/ko/remote.md)
- [Termux (안드로이드)](docs/ko/termux.md)
- [플러그인·제공자 호환성](docs/ko/plugin-provider-compatibility.md)

## 프로젝트 상태

활발히 개발 중입니다. 0.3.x 계열은 저장 신뢰성과 긴 대화 성능에 집중하고 있으며, 안정화가 끝나면 0.4.0을 LTS로 낼 계획입니다.

버그 제보와 재현 조건은 [이슈](https://github.com/TripleHwang/RisuVault/issues)로 받습니다. 성능 문제는 어떤 상황에서 느려지는지(대화 길이, 에셋 수, 플러그인 유무) 함께 적어주시면 도움이 됩니다.

## 계보와 라이선스

```
RisuAI
  └─ PocketRisu
       └─ RisuBard
            └─ RisuVault
```

여기에 더해 관계형 SQL 저장 구조는 [HaejeokRisuai](https://github.com/nevaeh5379/HaejeokRisuai)에서, 포터블 의존성 축소는 [PocketRisu](https://github.com/PocketRisu/PocketRisu)에서 가져와 이 저장소의 구조에 맞게 다시 만들었습니다.

전부 GPL-3.0-only입니다. 상위 프로젝트들의 라이선스 의무와 저작자 표시를 유지하며, 가져온 코드는 파일 헤더와 [NOTICE.md](NOTICE.md)에 출처를 남깁니다.

이 저장소는 **GNU General Public License v3.0 only**로 배포됩니다. [LICENSE](LICENSE)와 [NOTICE.md](NOTICE.md)를 참고하세요.
