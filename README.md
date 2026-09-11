# google-mailbackup

회사 Gmail(45일 보존 정책)을 **매주** Google Drive에 원본(.eml)으로 백업하고,
보낸편지함·카테고리·라벨 구분을 유지한 채 검색·필터링할 수 있는 Google Apps Script 앱.

- 실행 계정: `kumhwa_dev@spris.com`
- 저장 구조: `<루트>/<카테고리>/<YYYY>/<YYYY-MM>/<날짜시각>_<제목>_<id>.eml`
  - 카테고리 우선순위: 사용자 라벨 > 보낸편지함 > 임시보관함 > 프로모션/소셜/업데이트/포럼 > 받은편지함 > 보관됨
  - 첨부파일은 `<루트>/_attachments/<메시지id>/` 에 한 번 더 저장 (미리보기용, `.eml`에도 포함)
- 인덱스: 루트 폴더의 Google Sheet `Mail Backup Index` (id, 날짜, 카테고리, 전체 라벨, 보낸사람, 제목, 첨부, Drive 링크 …)
- 웹앱: 인덱스를 검색어/카테고리/보낸사람/기간으로 필터링, 상태 확인, 수동 실행, 주간 트리거 설치
- 증분: 마지막 동기화 시각 이후만 조회(2일 겹침), 이미 저장된 id는 건너뜀. 첫 실행은 전체.
- 6분 실행 제한: 4분 30초마다 커서를 저장하고 1분 뒤 자동으로 이어서 실행

설계 문서: [docs/superpowers/specs/2026-09-11-gmail-drive-backup-design.md](docs/superpowers/specs/2026-09-11-gmail-drive-backup-design.md)

## 1. 로컬에서 UI 확인

```bash
npm install
npm test          # 순수 로직 단위 테스트 (vitest)
npm run dev       # http://localhost:8787  (샘플 데이터로 검색 UI 확인)
```

Apps Script 자체는 로컬에서 실행되지 않습니다. 로컬 서버는 `src/index.html`을 그대로 띄우고
`google.script.run`을 `dev/fixtures/index.json` 샘플 인덱스로 대체합니다. 검색/필터 로직은
실제 코드(`src/lib/index_row.js`)를 그대로 사용합니다.

## 2. Google Workspace에 배포 (최초 1회)

kumhwa_dev@spris.com 으로 로그인한 상태에서:

```bash
npx clasp login                                   # 브라우저에서 kumhwa_dev@spris.com 선택
npx clasp create --type webapp --title "Mail Backup" --rootDir src
#  → .clasp.json 이 생성됩니다 (scriptId). 이 파일은 커밋해도 됩니다.
npm run push                                      # 코드 업로드
npx clasp open-script                             # 편집기 열기
```

편집기에서 처리할 일:

1. **Apps Script API 켜기**: https://script.google.com/home/usersettings 에서 "Google Apps Script API" 사용 설정
   (`clasp push`가 403이면 이것 때문입니다).
2. **권한 승인**: 편집기에서 `runBackup` 함수를 선택해 1회 실행 → Gmail 읽기, Drive, Sheets 권한 승인.
   첫 실행이 전체 백업이며, 메일이 많으면 1분 간격으로 자동으로 이어서 실행됩니다.
3. **주간 트리거 설치**: `setupWeeklyTrigger` 함수를 1회 실행 (또는 웹앱의 "주간 트리거 설치" 버튼).
   매주 월요일 03~04시(KST)에 실행됩니다.
4. **웹앱 배포**: `npm run deploy` (또는 편집기 > 배포 > 새 배포 > 웹 앱, 실행 계정 = 나, 액세스 = spris.com 사용자).
   출력된 웹앱 URL로 접속하면 검색 화면이 뜹니다. 이후 코드 변경은 `npm run deploy` 로 재배포.

## 3. 백업 위치를 개인 Google Drive로 바꾸기 (선택)

기본값은 kumhwa_dev@spris.com 의 내 드라이브에 `Mail Backup` 폴더를 만듭니다.
개인 Gmail 계정의 드라이브에 넣으려면:

1. 개인 계정 Drive에서 폴더를 만들고 kumhwa_dev@spris.com 에 **편집자**로 공유
2. 폴더 URL의 ID(`/folders/<이 부분>`)를 복사
3. Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에 `BACKUP_FOLDER_ID` = 그 ID 추가

주의: 공유 폴더에 만들어진 파일의 **소유자는 만든 계정(kumhwa_dev@spris.com)** 입니다.
회사 계정이 삭제되면 파일도 사라질 수 있으므로, 개인 계정에서 주기적으로 "사본 만들기" 하거나
Drive 관리자가 소유권을 이전해야 합니다. 개인 Drive 용량이 아니라 회사 계정 용량이 소모됩니다.

## 4. 스크립트 속성

| 키 | 기본값 | 설명 |
|---|---|---|
| `BACKUP_FOLDER_ID` | (자동 생성) | 백업 루트 폴더 ID |
| `SAVE_ATTACHMENTS` | `true` | `false`면 첨부 별도 저장 안 함 |
| `MAX_RUN_SECONDS` | `270` | 한 구간 최대 실행 시간(초) |

내부용(자동 관리): `LAST_SYNC_EPOCH`, `CURSOR_JSON`, `STATUS_JSON`, `INDEX_SHEET_ID`, `WEEKLY_TRIGGER_ID`.
전체를 처음부터 다시 받고 싶으면 편집기에서 `resetBackupState` 실행 후 `runBackup` (이미 있는 id는 건너뜀).

## 5. 개발 명령

| 명령 | 동작 |
|---|---|
| `npm test` | 단위 테스트 |
| `npm run dev` | 로컬 미리보기 |
| `npm run push` | clasp push |
| `npm run deploy` | push + 웹앱 새 버전 배포 |
| `npm run release` | test + push + `git push origin main` |

## 파일 구조

```
src/
  appsscript.json   매니페스트 (Gmail 고급 서비스, 스코프, 웹앱 설정)
  config.js         설정/스크립트 속성 키
  lib/              순수 로직 (Node 테스트 가능): categorize, naming, query, index_row
  gmail_source.js   Gmail API + GmailApp 어댑터
  drive_store.js    폴더/파일/인덱스 시트
  backup.js         runBackup 오케스트레이션 (커서, 시간 제한, 상태)
  triggers.js       주간/이어서 실행 트리거
  webapp.js         doGet + 클라이언트 호출 함수
  index.html        검색 UI
dev/                로컬 미리보기 서버 + 샘플 데이터
test/               vitest
```
