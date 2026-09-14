# Gmail → Google Drive 주간 백업 앱 설계

날짜: 2026-09-11
대상 계정: kumhwa_dev@spris.com (Google Workspace)
저장소: https://github.com/KUMHWA-DEV/google-mailbackup

## 배경과 목표

회사 Gmail은 45일 보존 정책으로 메일이 자동 삭제된다. 삭제 전에 메일을 Google Drive에
원본 그대로(다운로드한 것과 동일한 형태로) 보관하고, 보낸편지함·카테고리·라벨 구분을
유지한 채로 검색·필터링할 수 있어야 한다. 백업은 45일 주기가 아니라 **매주** 실행되어
새 메일만 증분으로 추가한다.

## 결정 사항 (자율 실행 중 내린 가정)

1. **플랫폼: Google Apps Script(V8) + clasp.** Workspace 내부에 웹앱으로 배포할 수
   있고 Gmail/Drive 권한을 별도 OAuth 서버 없이 쓸 수 있다. Node 서버형 대안은
   호스팅이 필요해 제외했다.
2. **저장 형식: 메일당 `.eml`(RFC822 원본) 1개 + 첨부파일 별도 저장.** `.eml`은 어떤
   메일 클라이언트에서도 열리며 첨부까지 포함한다. 첨부는 Drive에서 바로 미리보기
   되도록 `_attachments/<messageId>/`에 한 번 더 저장한다(설정으로 끌 수 있음).
3. **폴더 구조: `<루트>/<카테고리>/<날짜시각>_<제목>_<id>.eml` (2026-09-14 변경).**
   실행마다 폴더를 새로 만들지 않고 같은 카테고리 폴더에 계속 누적한다(사용자 요청).
   파일명이 날짜로 시작해 이름순이 시간순이다. 스크립트 속성 `FOLDER_LAYOUT`으로
   `yearly`/`monthly` 하위 폴더를 선택할 수 있다.
   카테고리 우선순위: 사용자 라벨 > 보낸편지함 > 임시보관함 > Gmail 카테고리
   (프로모션/소셜/업데이트/포럼) > 받은편지함 > 보관됨. 여러 라벨이 있어도 폴더는
   하나이며, 전체 라벨 목록은 인덱스에 기록한다.
3-1. **통계 (2026-09-14 추가).** 실행 커서에 감지 건수·신규·중복·오류·용량·메일 날짜 범위를
   누적하고, 완료 시 `RUN_HISTORY_JSON`에 최근 12회를 보관한다. 웹앱 `getStatus`는 인덱스
   전체 요약(`summarizeRecords`: 건수, 총 용량, 가장 오래된/최신 메일, 카테고리별)을 함께 준다.
4. **인덱스: 루트 폴더의 Google Sheet `Mail Backup Index`.** 열: id, threadId, date,
   category, labels, from, to, cc, subject, snippet, sizeBytes, attachments,
   driveFileId, driveUrl, backedUpAt. 시트 자체로도 필터링이 되고, 웹앱 검색 UI가
   이 시트를 읽는다. 중복 백업 방지에도 id 열을 쓴다.
5. **"개인 Google Drive"는 스크립트 속성 `BACKUP_FOLDER_ID`로 지정한다.** 미설정 시
   실행 계정 내 드라이브에 `Mail Backup` 폴더를 만든다. 진짜 개인 Gmail 계정의
   드라이브에 넣으려면 그 계정에서 폴더를 만들어 kumhwa_dev@spris.com 에 편집자로
   공유하고 그 폴더 ID를 넣는다. (파일 소유자는 생성자인 회사 계정이 되므로, 회사
   계정이 삭제되면 파일도 사라질 수 있다는 점은 README에 명시.)
6. **증분 동기화: 스크립트 속성 `LAST_SYNC_EPOCH` 기준 `after:` 쿼리 + 2일 겹침 +
   id 중복 제거.** 첫 실행은 전체 메일. 스팸/휴지통은 제외.
7. **6분 실행 제한 대응: 4분 30초마다 커서(pageToken)를 저장하고 1분 뒤 이어서
   실행되는 일회성 트리거를 만든다.** 주간 트리거는 월요일 03~04시.
8. **로컬 확인: `npm run dev`가 웹앱 UI를 로컬 HTTP 서버로 띄우고, `google.script.run`
   을 샘플 인덱스 JSON으로 대체하는 shim을 주입한다.** Apps Script 자체는 로컬에서
   실행할 수 없으므로 순수 로직(분류·파일명·쿼리·인덱스 행 생성)은 Node에서
   vitest로 테스트한다.
9. **배포: `clasp push` + `clasp deploy`(웹앱, 실행자=배포자, 접근=spris.com 도메인).**
   GitHub 푸시는 `npm run release` 스크립트에 포함. GitHub Actions는 테스트만 실행.

## 구성 요소

| 파일 | 역할 |
|---|---|
| `src/appsscript.json` | 매니페스트: Gmail 고급 서비스, 스코프, 웹앱 설정, 시간대 |
| `src/lib/categorize.js` | labelIds + 라벨명 맵 → 카테고리 폴더명 (순수) |
| `src/lib/naming.js` | 파일명/폴더 경로 생성, 파일명 안전화 (순수) |
| `src/lib/query.js` | 마지막 동기화 시각 → Gmail 검색 쿼리 (순수) |
| `src/lib/index_row.js` | 메시지 메타 → 인덱스 시트 행, 검색 필터 (순수) |
| `src/gmail_source.js` | Gmail 고급 서비스 호출: 목록, raw 가져오기, 라벨 맵 |
| `src/drive_store.js` | 폴더 캐시, .eml/첨부 저장, 인덱스 시트 읽기/쓰기 |
| `src/backup.js` | 실행 오케스트레이션: 커서, 시간 제한, 트리거 재예약, 상태 기록 |
| `src/triggers.js` | 주간 트리거 설치/제거 |
| `src/webapp.js` | `doGet`, `searchMessages`, `getStatus`, `runBackupNow` |
| `src/ui/index.html` | 검색/필터 UI (카테고리, 발신자, 기간, 키워드, 페이지) |
| `dev/server.js` | 로컬 미리보기 서버 + shim 주입 |
| `dev/fixtures/index.json` | 로컬 미리보기용 샘플 인덱스 |
| `test/*.test.js` | 순수 로직 단위 테스트 |

순수 로직 파일은 Apps Script 전역 스코프와 Node 양쪽에서 쓰기 위해 파일 끝에
`if (typeof module !== 'undefined') module.exports = {...}` 를 둔다.

## 데이터 흐름

1. 트리거 → `runBackup()` → 커서 로드(없으면 새 실행: 쿼리 생성, 시작 시각 기록)
2. `Gmail.Users.Messages.list(q, pageToken)` → id 목록 → 인덱스 id 집합으로 중복 제거
3. 각 메시지: `Messages.get(format=raw)` → labelIds → 카테고리 → 폴더 확보 →
   `.eml` 생성 → (옵션) 첨부 저장 → 인덱스 행 추가
4. 시간 초과 시 커서 저장 + 1분 뒤 트리거. 페이지 소진 시 `LAST_SYNC_EPOCH` 갱신,
   커서 삭제, 상태 기록.

## 오류 처리

- 메시지 1건 실패는 로그 + 상태의 `errors` 카운트만 올리고 계속 진행한다.
- 인덱스 시트가 없으면 생성한다. 루트 폴더 ID가 잘못되면 명확한 오류로 중단한다.
- 재실행은 항상 안전하다(id 중복 제거).

## 테스트

- vitest: categorize, naming, query, index_row(검색 필터 포함).
- 로컬 dev 서버로 UI 육안 확인.
- 실제 Apps Script 동작은 `clasp push` 후 편집기에서 `runBackup` 1회 수동 실행으로 확인.

## 2026-09-14 추가: AI Studio 레퍼런스(gstudio/) 반영

사용자가 Google AI Studio로 만든 React 예시(`gstudio/email-backup-to-google-drive.zip`)의
UI·기능 의도를 반영했다. 레퍼런스는 브라우저에서 OAuth 토큰으로 Gmail API를 직접 호출해
JSON/MD 파일 1개를 Drive에 올리는 구조였고, 본 앱은 Apps Script 서버 측에서 .eml 원본을
저장하는 구조를 유지한 채 다음을 가져왔다.

- **4개 탭 구조**: 백업 대시보드 / 메일 탐색기(Gmail 뷰) / 백업 주기 및 알림 설정 / 백업 실행 이력
- **주기 현황 카드**: 정책 배지, 진행 상태(도래/최신), 최근 완료, 다음 예정일, 알림 수신처, 진행률 바
  (`lib/schedule.js` `computeSchedule`)
- **실행 전 확인 모달**과 "원본 훼손 없음" 안내
- **안건별 분류(agenda)**: 제목·요약 키워드로 회의/일정, 업무보고/공지, 계약/재무/발주,
  업무요청/협조, 중요업무, 일반업무/기타 (`lib/agenda.js`). 인덱스 열 `agenda`로 저장하고
  탐색기 칩으로 필터. 설정 `FOLDER_BY=agenda`면 Drive 폴더도 이 기준으로 구성
- **탐색기 분할 뷰**: 좌측 목록(수신/발신 태그, 이름, 날짜, 제목, 요약, 분류·첨부 태그) +
  우측 리더(메타, Drive 원본 링크, 본문 미리보기). 본문은 백업 시 `bodyPreview` 열(최대 20,000자)에
  저장하고 열람 시 그 행만 읽는다(`loadBodyPreview_`). 목록 조회는 이 열을 제외한다.
- **설정 화면**: `lib/settings.js` 스키마(주기, 시작 기준일, 보낸편지함 포함, 첨부 저장, 회당 최대 건수,
  추가 검색 조건, 폴더 ID, 하위 폴더, 폴더 구성 기준, 알림 이메일, 완료 알림). 스크립트 속성에 저장.
  주기를 바꾸면 트리거를 다시 예약(`everyDays(n)`, 7일이면 월요일 주간 트리거).
- **완료 알림 메일**: `lib/notify.js`가 요약 보고서 HTML/텍스트를 만들고 `MailApp.sendEmail`로 발송
  (스코프 `script.send_mail`). 이력에 `notifiedTo` 기록.
- **회당 최대 건수**: 제한에 걸리면 `LAST_SYNC_EPOCH`를 올리지 않아 다음 실행이 이어받는다.

가져오지 않은 것: 브라우저 OAuth 로그인(Apps Script가 대신), JSON/MD 패키지 파일(개별 .eml이 더 유용),
localStorage 이력(스크립트 속성으로 대체), 45일 고정 주기(설정으로 일반화).

## 2026-09-14 추가: 감지 미리보기, 백그라운드 진행률, Gmail 애드온

- **감지(previewBackup)**: 실제 백업과 같은 쿼리로 새 메일 id를 세고(인덱스 중복 제거), 최대 300건은
  `format=metadata`로 라벨·크기·날짜·보낸사람을 읽어 `lib/preview.js` `aggregatePreview`로 라벨별·보낸사람별
  집계. 300건 초과면 비율로 추정(`estimated`). 결과의 newCount를 `PREVIEW_JSON`에 저장해 실행 시
  `expectedTotal`로 쓴다. 시간 예산 40초.
- **진행률**: 커서에 `expectedTotal`, `cats`(라벨별 분포), `chunkStartedAt`, `resumeAt`, `manual`을 두고
  20건 저장마다 STATUS_JSON을 갱신. `getDashboard.currentRun.progress`(`runProgress`: %, 경과, 처리율, ETA).
  웹앱은 실행 중 8초마다 폴링해 상태 카드와 이력 맨 위 "진행 중" 행을 갱신. 이력 항목에 `byCategory`,
  `manual`, `expectedTotal` 저장.
- **주기 상한 제거**: intervalDays 1 이상 (트리거는 7일이면 주간, 아니면 everyDays(n)).
- **Gmail 애드온**(`src/addon.js`, 매니페스트 `addOns`): 홈 카드(상태·보관 현황·지금 백업·앱 열기·Drive·최근 3회),
  메일 열람 시 컨텍스트 카드(백업 여부, Drive 원본, .eml, 첨부 다운로드). 스코프
  `gmail.addons.execute`, `gmail.addons.current.message.metadata` 추가. 배포 절차는 README 2-2.
