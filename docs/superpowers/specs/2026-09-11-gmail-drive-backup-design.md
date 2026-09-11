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
3. **폴더 구조: `<루트>/<카테고리>/<YYYY>/<YYYY-MM>/<날짜시각>_<제목>_<id>.eml`.**
   카테고리 우선순위: 사용자 라벨 > 보낸편지함 > 임시보관함 > Gmail 카테고리
   (프로모션/소셜/업데이트/포럼) > 받은편지함 > 보관됨. 여러 라벨이 있어도 폴더는
   하나이며, 전체 라벨 목록은 인덱스에 기록한다.
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
