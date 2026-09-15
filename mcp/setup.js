#!/usr/bin/env node
/**
 * Mail Backup MCP 설치 도우미. 경로 입력 없이 AI 앱 설정에 mail-backup 서버를 등록한다.
 *   npx -y -p github:KUMHWA-DEV/google-mailbackup mailbackup-setup [--ref <커밋>] [--oauth <파일|base64>] [--script-id <id>] [--apps claude-desktop,claude-code,gemini,cursor]
 *   --ref: 등록되는 실행 명령을 그 커밋으로 고정. --script-id: 실행 모드(백업 실행/설정)까지 허용, 없으면 읽기 전용.
 * 등록되는 실행 명령은 `npx -y -p github:KUMHWA-DEV/google-mailbackup mailbackup-mcp` 이라 저장소를 받거나 경로를 적을 필요가 없다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REF = opt('--ref', '');                       // 커밋 SHA/태그로 고정 (없으면 최신)
const PKG = 'github:KUMHWA-DEV/google-mailbackup' + (REF ? '#' + REF : '');
// 실행 모드(백업 실행·설정 변경)는 --script-id 를 명시할 때만. 기본은 읽기 전용(Drive/Sheets 읽기 스코프만).
const SCRIPT_ID = opt('--script-id', process.env.MAIL_BACKUP_SCRIPT_ID || '');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mail-backup-mcp');
const env = SCRIPT_ID ? { MAIL_BACKUP_SCRIPT_ID: SCRIPT_ID } : {};
const entry = { command: 'npx', args: ['-y', '-p', PKG, 'mailbackup-mcp'], env };
const log = (...a) => console.log('[mailbackup-setup]', ...a);

// 1) OAuth 클라이언트 저장
const oauth = opt('--oauth', process.env.MAIL_BACKUP_OAUTH_JSON || '');
if (oauth) {
  let raw = oauth;
  if (fs.existsSync(oauth)) raw = fs.readFileSync(oauth, 'utf8');
  else if (!oauth.trim().startsWith('{')) raw = Buffer.from(oauth, 'base64').toString('utf8');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'oauth_client.json'), JSON.stringify(JSON.parse(raw), null, 2), { mode: 0o600 });
  log('OAuth 클라이언트 저장:', path.join(CONFIG_DIR, 'oauth_client.json'));
} else if (!fs.existsSync(path.join(CONFIG_DIR, 'oauth_client.json'))) {
  log('OAuth 클라이언트가 없습니다. 웹앱 AI 연결 탭에서 내려받아 --oauth <파일> 로 넘기거나, 저장소에 동봉된 파일을 사용합니다.');
}

// 2) 앱 설정 쓰기
function upsertJson(file, mutate) {
  let obj = {};
  if (fs.existsSync(file)) { fs.copyFileSync(file, file + '.bak'); try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { obj = {}; } }
  mutate(obj);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  log('설정 갱신:', file);
}
const apps = (opt('--apps', '') || detectApps()).split(',').map(s => s.trim()).filter(Boolean);
function detectApps() {
  const found = [];
  const cd = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude') : process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Claude') : path.join(os.homedir(), '.config', 'Claude');
  if (fs.existsSync(cd)) found.push('claude-desktop');
  try { execSync('claude --version', { stdio: 'ignore' }); found.push('claude-code'); } catch (e) { /* none */ }
  if (fs.existsSync(path.join(os.homedir(), '.gemini'))) found.push('gemini');
  if (fs.existsSync(path.join(os.homedir(), '.cursor'))) found.push('cursor');
  return found.join(',');
}
if (!apps.length) log('감지된 AI 앱이 없습니다. --apps claude-desktop,claude-code,gemini,cursor 로 지정하세요.');
for (const app of apps) {
  if (app === 'claude-desktop') {
    const dir = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude') : process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Claude') : path.join(os.homedir(), '.config', 'Claude');
    upsertJson(path.join(dir, 'claude_desktop_config.json'), o => { o.mcpServers = o.mcpServers || {}; o.mcpServers['mail-backup'] = entry; });
  } else if (app === 'claude-code') {
    try { execSync(`claude mcp remove mail-backup -s user`, { stdio: 'ignore' }); } catch (e) { /* 없으면 무시 */ }
    execSync(`claude mcp add mail-backup -s user ${SCRIPT_ID ? '-e MAIL_BACKUP_SCRIPT_ID=' + SCRIPT_ID + ' ' : ''}-- npx -y -p ${PKG} mailbackup-mcp`, { stdio: 'inherit' });
    log('Claude Code 등록 완료');
  } else if (app === 'gemini') {
    upsertJson(path.join(os.homedir(), '.gemini', 'settings.json'), o => { o.mcpServers = o.mcpServers || {}; o.mcpServers['mail-backup'] = entry; });
  } else if (app === 'cursor') {
    upsertJson(path.join(os.homedir(), '.cursor', 'mcp.json'), o => { o.mcpServers = o.mcpServers || {}; o.mcpServers['mail-backup'] = entry; });
  } else log('알 수 없는 앱:', app);
}
log('완료. 앱을 완전히 종료 후 다시 실행하고, 처음 쓸 때 브라우저 로그인(회사 계정)을 한 번 하세요.');
