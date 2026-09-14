# google-mailbackup

회사 Gmail(45일 보존 정책)을 **매주** Google Drive에 원본(.eml)으로 백업하고,
보낸편지함·카테고리·라벨 구분을 유지한 채 검색·필터링할 수 있는 Google Apps Script 앱.

- 배포 계정: `kumhwa_dev@spris.com` (스크립트 소유자). **실행은 접속한 사용자 각자의 권한**으로 되며,
  직원마다 자기 Gmail을 읽어 **자기 내 드라이브**의 `Mail Backup` 폴더와 인덱스 시트에 저장합니다.
  설정·이력·자동 백업 트리거도 사용자별로 따로 있습니다(`PropertiesService.getUserProperties`).
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
  첨부 이름, 첨부 Drive 파일 ID(JSON), 용량, Drive 링크, 본문 미리보기 …). 시트 자체로도 필터링 가능
- 웹앱 (최대 1440px 가운데 정렬, 4개 탭, `gstudio/` 레퍼런스의 기능 의도를 따르되 설명 문구 대신 아이콘·상태 표시)
  - **첫 백업**: 마지막 백업 기록이 없으면 모달 상단에 "🎉 첫 백업이신가요?" — 📦 지금 있는 메일 전부(메일함 총 건수는 Gmail
    프로필에서 즉시, 용량은 표본 추정, 예상 소요 시간 표시) 또는 📅 특정 날짜부터(시작일 설정에 저장) 선택.
    전체 백업은 백그라운드에서 1분 간격 여러 구간으로 나눠 돌고 창을 닫아도 계속됨
  - **지금 백업**: 누르면 먼저 **감지** — 새로 저장될 메일 수, 용량, 기간, 감지/이미 있음, 라벨별 건수·용량, 보낸사람 상위
    (300건 초과 시 표본 추정 ≈ 표시) → "백업 시작 · N건". 실행은 **백그라운드 큐**(트리거)로 돌고 창을 닫아도 계속됨.
    진행 중에는 상태 카드에 저장 n/m · % · 용량 · 구간 · 경과 · 남은 시간 · 라벨 칩이 8초마다 갱신되고,
    이력 맨 위에 ⚙️ 진행 중 행이 보임. 완료된 실행은 라벨별 분포(어디서 몇 건, 용량)와 🖱 수동/⏱ 자동 표시를 기록
  - **대시보드**: 상태 줄 + 자동 백업 스위치 + "지금 백업"(감지 모달), KPI(마지막/다음/주기/알림), 주기 진행률,
    보관 메일(수신·발신·첨부)·용량·보관 기간·최근 실행 타일, 라벨별/안건별 분포 막대(클릭하면 메일함 필터),
    현재 정책 칩(클릭하면 설정), 최근 실행 5건
  - **메일함**: Gmail 화면 구성 — 검색바, 필터 칩(보낸사람·받는사람·날짜·첨부파일·라벨·안건·크기·정렬, Gmail처럼
    검색창에 연산자를 넣고 빼는 방식), ⚙️ 고급 검색 패널, 좌측 내비(전체/받은편지함/보낸편지함/중요/임시보관함/첨부파일,
    라벨, 안건, 백업 회차), 메일 행(별표, 보낸사람, 라벨 칩, 제목 – 요약, 📎, 용량, 날짜, 50건 페이지),
    읽기창(이전/다음, 👤 같은 사람 메일, ⬇ .eml, ↗ Drive, 아바타, 받는사람 펼침, 본문, 첨부 카드 ⬇ 다운로드).
    단축키: `/` 검색, `j`/`k` 다음/이전 메일, `Esc` 닫기
  - **검색 연산자** (`src/lib/search.js`, 서버·클라이언트 공용): `from:` `to:` `cc:` `subject:` `label:` `agenda:`
    `filename:` `has:attachment` `in:inbox|sent|drafts` `is:important` `after:`/`before:` (YYYY-MM-DD)
    `larger:`/`smaller:` (예: 1M, 500K) `"구문"` `-제외어`
  - **설정**: 주기(1일 이상), 시작일(첫 백업만, 시작일 포함), 회당 최대(0=무제한), 스위치 3개(보낸편지함 포함·첨부 별도 저장·완료 알림),
    알림 주소, 추가 Gmail 검색 조건, Drive 폴더 ID, 폴더 기준(라벨/안건), 하위 폴더(없음/연도/연·월)
  - **이력**: 최근 12회 — ✅/⚠️ 상태, 시작, 소요, 감지/신규/중복/오류, 용량, 메일 기간, 알림 여부, 해당 회차 메일 보기(📬)
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
2. **웹앱 배포**: `npm run deploy` (또는 편집기 > 배포 > 새 배포 > 웹 앱). 매니페스트가 이미
   **실행 = 웹 앱에 액세스하는 사용자, 액세스 = spris.com 사용자**로 설정돼 있습니다. 출력된 URL이 앱 주소입니다.
   이후 코드 변경은 `npm run deploy` 로 재배포(URL 유지).
3. **각 사용자가 할 일 (본인 포함)**: URL 접속 → 첫 방문 시 권한 승인(Gmail 읽기, Drive, Sheets, 트리거, 메일 발송)
   → 대시보드에서 **▶ 지금 백업**(첫 실행은 전체) 또는 **자동 백업** 스위치. 메일이 많으면 1분 간격으로 이어서 실행됩니다.
   설정한 주기(기본 7일 = 매주 월요일)마다 새벽 3시(KST)에 그 사용자 계정으로 실행됩니다.

## 2-0. 회사 전체 배포 체크리스트 (관리자)

- **URL 공유만으로 끝납니다.** 웹앱 URL을 공지하면 직원마다 자기 계정으로 권한을 승인하고 자기 드라이브에 백업합니다.
  스크립트 소유자(kumhwa_dev)는 다른 직원의 메일이나 백업 파일에 접근하지 않습니다.
- **"확인되지 않은 앱" 경고가 뜨면**: 관리 콘솔 > 보안 > API 제어 > 앱 액세스 제어에서 이 Apps Script 프로젝트를
  **신뢰할 수 있는 앱**으로 추가하거나, GCP 표준 프로젝트를 연결해 OAuth 동의 화면을 **내부**로 설정합니다.
  같은 도메인 사용자에게는 보통 경고 없이 표준 동의 화면만 나옵니다.
- **앱 런처(9점 메뉴) 노출을 원하면** 2-1의 3번(Marketplace 비공개 앱 + Universal Navigation), Gmail 사이드바까지 원하면 2-2.
- **퇴사자 처리**: 백업 파일 소유자는 각 직원이므로, 일반 Drive 파일과 같이 관리 콘솔에서 소유권 이전으로 보존합니다.
- **한도**: 트리거는 사용자당 스크립트별 20개(이 앱은 1~2개 사용), 완료 알림 메일은 사용자당 하루 1,500통(Workspace) 한도 안입니다.

## 2-1. Google Workspace 안에서 "앱"으로 쓰는 방법 · 깔끔한 링크

배포 URL(`https://script.google.com/a/macros/spris.com/s/AKfy…/exec`)은 바꿀 수 없습니다. 짧고 기억하기 쉬운 주소가 필요하면:

- **Google Sites (권장, 관리자 불필요)**: sites.google.com 에서 새 사이트 → 주소를 `spris.com/mail-backup` 처럼 지정 →
  삽입 > 삽입 코드에 `<iframe src="<웹앱 URL>" style="width:100%;height:100vh;border:0"></iframe>` → 게시(spris.com 사용자).
  결과 주소는 `https://sites.google.com/spris.com/mail-backup` 이며 그 안에서 앱이 그대로 동작합니다.
- **애드온 아이콘**: 링크를 외울 필요 없이 Gmail 사이드바에서 시작하는 것이 가장 자연스럽습니다(2-2). 애드온의 "앱 열기" 버튼이 웹앱으로 연결됩니다.
- **앱 런처**: 아래 3번(Marketplace 비공개 앱)을 하면 9점 메뉴에도 아이콘이 생깁니다.


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
4. **Gmail 안에서 앱으로 쓰기 (애드온)** — 아래 2-2 참고. 코드는 이미 들어 있습니다(`src/addon.js`).

## 2-2. Gmail 앱(애드온)으로 쓰기 — AI Studio 앱처럼 Gmail 안에서

같은 스크립트가 **Google Workspace 애드온**으로도 동작합니다(`appsscript.json`의 `addOns`).
설치하면 Gmail 오른쪽 사이드바에 ☁️ Mail Backup 아이콘이 생기고,

- 처음이면 **온보딩 카드**: 한 줄 설명 → 📦 전체 메일 / 📅 날짜부터 선택 → ⏱ 자동 백업 스위치 → ▶ 백업 시작. 소개받은 직원이 아이콘 한 번 눌러 바로 시작하는 흐름
- 이후 **홈 카드**: 상태(최신/백업 필요/진행 중 n/m), 보관 메일 수·용량, ▶ 지금 백업, **⚙️ 빠른 설정**(자동 백업, 주기, 첨부 저장, 완료 알림 → 저장),
  최근 실행 3건, 🌐 앱 열기 · 심화 설정(폴더 기준, 검색 조건, 회당 최대, 알림 주소 등은 웹앱에서), 📁 Drive
- **메일을 열면**: 그 메일이 백업됐는지(✅ 백업 시각 · 폴더 · 용량), ↗ Drive 원본, ⬇ .eml, 첨부파일 목록(클릭하면 다운로드).
  아직 백업 전이면 다음 자동 백업 시각과 ▶ 지금 백업 버튼

### A. 내 계정에서 바로 써보기 (테스트 배포, 5분)

```bash
npm run push            # addon.js 와 매니페스트 업로드
npx clasp open-script
```

1. 편집기 오른쪽 위 **배포 ▾ > 테스트 배포** → "설치" 클릭 (애플리케이션: Gmail).
2. Gmail 새로고침 → 오른쪽 사이드바 맨 아래에 애드온 아이콘이 보입니다. 처음 클릭 시 권한 승인
   (Gmail 읽기, 애드온 실행, Drive, Sheets, 메일 발송).
3. 테스트 배포는 **설치한 계정에만** 보이며, 코드를 `npm run push` 할 때마다 즉시 반영됩니다.

### B. spris.com 전체에 배포 (관리자 1회)

Gmail 애드온을 다른 직원에게도 배포하려면 Google Workspace Marketplace **비공개(도메인 내) 목록**이 필요합니다.

1. **GCP 표준 프로젝트 연결**: https://console.cloud.google.com 에서 프로젝트 생성 →
   `API 및 서비스 > OAuth 동의 화면`: 사용자 유형 **내부**, 앱 이름 Mail Backup, 범위에 매니페스트의 스코프 추가 →
   `API 및 서비스 > 라이브러리`에서 **Gmail API**, **Google Workspace Marketplace SDK** 사용 설정.
   Apps Script 편집기 > ⚙ 프로젝트 설정 > "Google Cloud Platform(GCP) 프로젝트" > 프로젝트 번호 입력.
2. **버전 배포**: 편집기 > 배포 > 새 배포 > 유형 "애드온" → 배포 ID 복사 (웹앱 배포와는 별개).
3. **Marketplace SDK 구성**: GCP 콘솔 > Google Workspace Marketplace SDK > "앱 구성":
   앱 공개 상태 **비공개(Private)**, 설치 설정 "관리자 설치", 앱 통합에서 **Google Workspace 부가기능** 체크 →
   "Apps Script 프로젝트 배포 ID"에 2번 ID 입력, Gmail 체크. "스토어 등록정보"에 이름·아이콘(128px)·설명 입력 → 게시.
4. **관리 콘솔 설치**: https://admin.google.com > 앱 > Google Workspace Marketplace 앱 > 앱 추가 →
   내부 앱 목록에서 Mail Backup → "모든 사용자" 또는 특정 조직 단위에 설치. 몇 분 뒤 모든 직원 Gmail에 아이콘이 생깁니다.

애드온도 웹앱과 같은 사용자별 상태를 씁니다. 여는 사람의 계정으로 실행되어 그 사람의 백업 현황과 폴더가 보이고,
▶ 지금 백업도 그 사람 메일을 그 사람 드라이브에 저장합니다. 웹앱을 먼저 한 번 열어 권한을 승인해 두면 애드온에서
추가 승인 없이 바로 동작합니다(같은 스크립트, 같은 스코프).

### C. AI Studio 앱처럼 독립 사이트로

AI Studio 예시는 별도 사이트에서 Google 로그인 후 쓰는 형태였습니다. 이 앱의 웹앱 URL(2번에서 배포)이 그 역할이며,
로그인은 Google Workspace 세션을 그대로 씁니다. 회사 계정 외 접근을 막는 것도 매니페스트 `access: DOMAIN`이 처리합니다.
Chrome "바로가기 만들기 > 창으로 열기"로 설치하면 독립 앱처럼 Dock에 아이콘이 생깁니다.

## 3. 백업 위치

기본값은 **접속한 사용자 본인의 내 드라이브**에 `Mail Backup` 폴더를 만드는 것입니다(사용자마다 따로).
회사 밖 개인 Gmail 계정의 드라이브에 넣고 싶은 사용자는:

1. 개인 계정 Drive에서 폴더를 만들고 자기 회사 계정에 **편집자**로 공유
2. 폴더 URL의 ID(`/folders/<이 부분>`)를 복사
3. 웹앱 설정 탭 > 📁 Drive 폴더에 붙여넣고 저장

주의: 공유 폴더에 만들어진 파일의 **소유자는 만든 계정(회사 계정)** 입니다. 회사 계정이 삭제되면 파일도
사라질 수 있으므로 개인 계정에서 주기적으로 "사본 만들기" 하거나 관리자가 소유권을 이전해야 합니다.
용량은 회사 계정 쪽이 소모됩니다.

## 4. 설정 (웹앱 설정 탭 = 사용자 속성, 사용자마다 별도)

| 설정 | 속성 키 | 기본값 | 설명 |
|---|---|---|---|
| 백업 주기(일) | `BACKUP_INTERVAL_DAYS` | `7` | 1일 이상, 상한 없음 (7일이면 매주 월요일, 그 외는 N일마다) |
| 시작 기준일 | `INITIAL_START_DATE` | (없음) | 첫 실행에서 이 날짜(포함) 이후만. 이후는 증분 |
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

내부용(자동 관리, 사용자별): `LAST_SYNC_EPOCH`, `CURSOR_JSON`, `STATUS_JSON`, `RUN_HISTORY_JSON`, `PREVIEW_JSON`, `INDEX_SHEET_ID`, `WEEKLY_TRIGGER_ID`.
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
