# 파일 정본 사용자 데이터

RisuVault의 사용자 데이터 정본은 일반 JSON·JSONL·Markdown과 content-addressed 파일입니다. SQLite와 `database.bin`은 정본이 아닙니다. 기존 클라이언트와 RisuAI 내보내기에 필요한 `database.bin`은 파일 정본에서 다시 만들 수 있습니다.

서버 실행 전에 절대 데이터 루트를 지정할 수 있습니다.

```bash
RISUBARD_DATA_ROOT=/private/path/risubard-data node server/node/server.cjs
```

데이터 루트에는 분리된 설정·credential, 안정 ID 엔터티 파일, 캐릭터/채팅 디렉터리, append 가능한 메시지 JSONL, 요청·시스템 JSONL 로그, 작업별 state/event, 에셋과 BardWiki가 있습니다. 시작 시 작은 manifest만 읽고 본문은 실제 접근 때 로드합니다.

저장은 같은 파일시스템의 temp 작성, fsync, checksum/schema 검증, 원자 rename, 부모 디렉터리 fsync, `.bak` revision과 복구 가능한 다중 파일 journal을 사용합니다. 삭제는 `trash/`로 이동합니다. 사용자 메시지는 모델 요청 전에 fsync하며 assistant 스트리밍 초안을 복구할 수 있습니다.

기존 `.bin`과 save-folder 가져오기는 명시적인 병합 또는 교체 의미를 제공합니다. 옛 `risuai.db`는 `migration-backups/`에 복사한 뒤 한 번만 가져오며 정상 런타임은 SQLite에 의존하지 않습니다. 전체 백업은 파일 정본 트리, 에셋, BardWiki와 호환 내보내기 데이터를 포함합니다.

Termux에서는 `$HOME/.local/share/risubard` 같은 앱 내부 저장소를 사용하세요. 공유 `/sdcard`와 `/storage/emulated`는 신뢰할 수 있는 fsync·원자 rename을 보장하지 않아 정본 루트로 거부됩니다. 공유 저장소에는 완성된 백업 파일만 복사하세요.
