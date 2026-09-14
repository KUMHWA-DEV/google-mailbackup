# google-mailbackup

회사 Gmail(45일 보존 정책)을 **매주** Google Drive에 원본(.eml)으로 백업하고,
보낸편지함·카테고리·라벨 구분을 유지한 채 검색·필터링할 수 있는 Google Apps Script 앱.

- 실행 계정: `kumhwa_dev@spris.com`
- 저장 구조: `<루트>/<카테고리>/<날짜시각>_<제목>_<id>.eml`
  - 폴더는 실행마다 새로 만들지 않고 **항상 같은 카테고리 폴더에 계속 쌓입니다.**
    예) `Mail Backup/받은편지함/` 에 지난 45일치와 이번 주 분이 함께 들어가며, 파일명이 날짜로
    시작하므로 이름순 정렬이 곧 시간순입니다. 파일이 너무 많아지면 스크립트 속성
    `FOLDER_LAYOUT`을 `yearly`(연도별 하위 폴더) 또는 `monthly`(연/월별)로 바꿀 수 있습니다.
  - 카테고리 우선순위: 사용자 라벨 > 보낸편지함 > 임시보관함 > 프로모션/소셜/업데이트/포럼 > 받은편지함 > 보관됨
  - 첨부파일은 `<루트>/_attachments/<메시지id>/` 에 한 번 더 저장 (미리보기용, `.eml`에도 포함)
  - 폴더 구성 기준은 설정에서 **Gmail 라벨/카테고리**(기본) 또는 **안건별 분류**(회의/일정, 업무보고/공지,
    계약/재무/발주, 업무요청/협조, 중요업무, 일반업무/기타 — 제목·요약 키워드 기반, `src/lib/agenda.js`)로 고를 수 있음
- 인덱스: 루트 폴더의 Google Sheet `Mail Backup Index` (id, 날짜, 카테고리, 안건 분류, 전체 라벨, 보낸사람, 제목,
  첨부, 용량, Drive 링크, 본문 미리보기 …). 시트 자체로도 필터링 가능
- 웹앱 (4개 탭, `gstudio/` 레퍼런스의 UI·기능 의도를 따름)
  - **백업 대시보드**: 주기 정책 배지, "지금 백업 실행"(확인 모달), 진행 상태/최근 완료/다음 예정일/알림 수신처 KPI,
    주기 진행률 바, 보관 건수(수신·발신·첨부)·총 용량·반영된 메일 기간·최근 실행 결과, 정책 요약, 최근 이력
  - **메일 탐색기 (Gmail 뷰)**: 검색, 전체/수신함/보낸편지함/첨부문서 필터, 안건별 분류 칩, Drive 폴더 칩,
    백업 회차 선택, 좌측 목록 + 우측 리더(보낸/받는 사람, 라벨, 첨부, 본문 미리보기, Drive 원본 열기)
  - **백업 주기 및 알림 설정**: 시작 기준일, 알림 이메일·완료 시 발송, 주기(1~30일), 회당 최대 건수(0=무제한),
    보낸편지함 포함, 첨부 별도 저장, Drive 폴더 ID, 폴더 구성 기준, 하위 폴더(누적/연도/연·월), 추가 Gmail 검색 조건
  - **백업 실행 이력**: 최근 12회 — 시작/종료, 구간, 감지/신규/이미 있음/오류, 용량, 반영된 메일 기간, 처리 상태,
    알림 발송처, 해당 회차 메일 탐색
- 완료 알림 메일: 실행이 끝나면 요약 보고서(감지/신규/오류/용량/기간/전체 현황 + 앱·폴더·시트 링크)를 발송
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
3. **자동 실행 켜기**: 웹앱 대시보드의 "자동 실행 켜기" 버튼 (또는 편집기에서 `setupScheduledTrigger` 실행).
   설정한 주기(기본 7일 = 매주 월요일)마다 새벽 3시(KST)에 실행됩니다. 주기를 바꾸면 자동으로 다시 예약됩니다.
4. **웹앱 배포**: `npm run deploy` (또는 편집기 > 배포 > 새 배포 > 웹 앱, 실행 계정 = 나, 액세스 = spris.com 사용자).
   출력된 웹앱 URL로 접속하면 검색 화면이 뜹니다. 이후 코드 변경은 `npm run deploy` 로 재배포.

## 2-1. Google Workspace 안에서 "앱"으로 쓰는 방법

배포가 끝나면 `https://script.google.com/a/macros/spris.com/s/<배포ID>/exec` 형태의 URL이 생깁니다.
이 URL이 곧 앱이며, spris.com 계정으로 로그인한 사람만 열 수 있습니다(매니페스트 `access: DOMAIN`).
쓰는 방식은 네 가지가 있고 위에서부터 간단한 순서입니다.

1. **URL 직접 사용 / Chrome 앱으로 설치 (권장, 바로 가능)**
   `npx clasp open-web-app` 으로 열고 북마크하거나, Chrome 메뉴 > 저장 및 공유 > 바로가기 만들기 >
   "창으로 열기"를 켜면 독립 창의 앱처럼 실행되고 Dock/런치패드에 아이콘이 생깁니다.
2. **Google Sites에 임베드 (팀 공유용)**
   Sites에서 새 사이트 > 삽입 > 삽입 코드 또는 "Apps Script" 위젯에 배포 URL을 넣으면
   사이트 안에서 그대로 동작합니다(웹앱이 iframe 삽입을 허용하도록 설정돼 있음).
   Sites는 도메인 내 공유가 쉬워 팀 포털의 한 페이지로 두기 좋습니다.
3. **Google 앱 런처(9점 메뉴)에 노출 — 관리자 필요**
   Google Cloud 프로젝트를 스크립트에 연결하고(편집기 > 프로젝트 설정 > GCP 프로젝트 변경),
   Google Workspace Marketplace SDK에서 "비공개(도메인 내) 앱"으로 등록하면서
   *Universal Navigation* 확장에 배포 URL을 넣습니다. 이후 Workspace 관리자가
   관리 콘솔에서 도메인에 설치하면 모든 직원의 앱 런처에 아이콘이 보입니다.
4. **Gmail 사이드바 애드온** — 메일 화면 옆에서 백업 상태를 보는 형태. 현재 코드에는 없고,
   필요하면 카드 UI(`CardService`)를 추가해 같은 스크립트에서 배포할 수 있습니다.

## 3. 백업 위치를 개인 Google Drive로 바꾸기 (선택)

기본값은 kumhwa_dev@spris.com 의 내 드라이브에 `Mail Backup` 폴더를 만듭니다.
개인 Gmail 계정의 드라이브에 넣으려면:

1. 개인 계정 Drive에서 폴더를 만들고 kumhwa_dev@spris.com 에 **편집자**로 공유
2. 폴더 URL의 ID(`/folders/<이 부분>`)를 복사
3. Apps Script 편집기 > 프로젝트 설정 > 스크립트 속성에 `BACKUP_FOLDER_ID` = 그 ID 추가

주의: 공유 폴더에 만들어진 파일의 **소유자는 만든 계정(kumhwa_dev@spris.com)** 입니다.
회사 계정이 삭제되면 파일도 사라질 수 있으므로, 개인 계정에서 주기적으로 "사본 만들기" 하거나
Drive 관리자가 소유권을 이전해야 합니다. 개인 Drive 용량이 아니라 회사 계정 용량이 소모됩니다.

## 4. 설정 (웹앱 설정 탭 = 스크립트 속성)

| 설정 | 속성 키 | 기본값 | 설명 |
|---|---|---|---|
| 백업 주기(일) | `BACKUP_INTERVAL_DAYS` | `7` | 1~30일 |
| 시작 기준일 | `INITIAL_START_DATE` | (없음) | 첫 실행에서 이 날짜 이후만. 이후는 증분 |
| 보낸편지함 포함 | `INCLUDE_SENT` | `true` | `false`면 수신 전용 |
| 첨부 별도 저장 | `SAVE_ATTACHMENTS` | `true` | `false`면 .eml에만 포함 |
| 회당 최대 건수 | `MAX_PER_RUN` | `0` | 0 = 무제한. 제한 시 나머지는 다음 실행 |
| 추가 검색 조건 | `FILTER_QUERY` | (없음) | Gmail 검색 문법 |
| Drive 폴더 ID | `BACKUP_FOLDER_ID` | (자동 생성) | 개인 계정 공유 폴더 ID 가능 |
| 하위 폴더 | `FOLDER_LAYOUT` | `flat` | `flat` 누적 / `yearly` / `monthly` |
| 폴더 구성 기준 | `FOLDER_BY` | `label` | `label` Gmail 라벨·카테고리 / `agenda` 안건별 |
| 알림 수신처 | `NOTIFY_EMAIL` | (실행 계정) | |
| 완료 알림 발송 | `NOTIFY_ON_COMPLETE` | `true` | |
| (고급) 구간 시간 | `MAX_RUN_SECONDS` | `270` | 한 구간 최대 실행 시간(초) |

내부용(자동 관리): `LAST_SYNC_EPOCH`, `CURSOR_JSON`, `STATUS_JSON`, `RUN_HISTORY_JSON`, `INDEX_SHEET_ID`, `WEEKLY_TRIGGER_ID`.
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
  lib/              순수 로직 (Node 테스트 가능): categorize, agenda, naming, query, index_row,
                    schedule(주기 계산), settings(설정 스키마), notify(알림 메일 본문)
  gmail_source.js   Gmail API + GmailApp 어댑터
  drive_store.js    폴더/파일/인덱스 시트
  backup.js         runBackup 오케스트레이션 (커서, 시간 제한, 상태)
  triggers.js       주간/이어서 실행 트리거
  webapp.js         doGet + 클라이언트 호출 함수
  index.html        검색 UI
dev/                로컬 미리보기 서버 + 샘플 데이터
test/               vitest
gstudio/            Google AI Studio 레퍼런스 zip (로컬 전용, Firebase 키가 들어 있어 git 제외)
```
