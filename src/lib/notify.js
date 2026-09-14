/**
 * 백업 완료 알림 메일 본문 생성. 순수 함수.
 */
function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtBytes_(n) {
  n = Number(n) || 0;
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
}
function fmtDay_(iso) { return iso ? String(iso).slice(0, 10) : '-'; }
function fmtDateTime_(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 16) + ' UTC' : '-'; }

/**
 * @param {Object} run 실행 요약 (found, processed, skipped, errors, bytes, mailFrom, mailTo, startedAt, finishedAt)
 * @param {Object} summary 인덱스 전체 요약 (total, totalBytes, oldestDate, newestDate)
 * @param {{folderUrl?:string, indexSheetUrl?:string, webAppUrl?:string}} links
 * @param {string} account 실행 계정
 * @returns {{subject:string, htmlBody:string, textBody:string}}
 */
function buildCompletionEmail(run, summary, links, account) {
  run = run || {}; summary = summary || {}; links = links || {};
  var range = run.mailFrom ? fmtDay_(run.mailFrom) + ' ~ ' + fmtDay_(run.mailTo) : '신규 없음';
  var total = summary.oldestDate ? fmtDay_(summary.oldestDate) + ' ~ ' + fmtDay_(summary.newestDate) : '-';
  var status = run.errors ? '부분 완료 (오류 ' + run.errors + '건)' : '정상 완료';
  var subject = '[메일 백업 완료] 신규 ' + (run.processed || 0) + '건 저장 · ' + status;

  var rows = [
    ['계정', account || '-'],
    ['실행 시간', fmtDateTime_(run.startedAt) + ' → ' + fmtDateTime_(run.finishedAt)],
    ['감지된 메일', (run.found || 0) + '건'],
    ['신규 저장', (run.processed || 0) + '건 (' + fmtBytes_(run.bytes) + ')'],
    ['이미 있음', (run.skipped || 0) + '건'],
    ['오류', (run.errors || 0) + '건'],
    ['이번에 반영된 메일 기간', range],
    ['전체 보관 현황', (summary.total || 0) + '건, ' + fmtBytes_(summary.totalBytes) + ', ' + total],
  ];

  var html = '<div style="font-family:-apple-system,\'Apple SD Gothic Neo\',sans-serif;line-height:1.6;color:#1e293b;max-width:620px;margin:0 auto;padding:20px;border:1px solid #e2e8f0;border-radius:12px">' +
    '<h2 style="color:#2563eb;margin-top:0">메일 백업 ' + escapeHtml_(status) + '</h2>' +
    '<p>주기 백업이 실행되어 Google Drive에 저장되었습니다.</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:13px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">' +
    rows.map(function (r) {
      return '<tr><td style="padding:6px 10px;color:#64748b;white-space:nowrap">' + escapeHtml_(r[0]) + '</td><td style="padding:6px 10px"><strong>' + escapeHtml_(r[1]) + '</strong></td></tr>';
    }).join('') +
    '</table>' +
    (run.lastError ? '<p style="color:#b91c1c;font-size:12px">마지막 오류: ' + escapeHtml_(run.lastError) + '</p>' : '') +
    '<p style="margin-top:18px">' +
    (links.webAppUrl ? '<a href="' + escapeHtml_(links.webAppUrl) + '" style="display:inline-block;background:#2563eb;color:#fff;padding:9px 16px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:8px">백업 앱 열기</a>' : '') +
    (links.folderUrl ? '<a href="' + escapeHtml_(links.folderUrl) + '" style="display:inline-block;background:#e2e8f0;color:#1e293b;padding:9px 16px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:8px">Drive 폴더</a>' : '') +
    (links.indexSheetUrl ? '<a href="' + escapeHtml_(links.indexSheetUrl) + '" style="display:inline-block;background:#e2e8f0;color:#1e293b;padding:9px 16px;text-decoration:none;border-radius:6px;font-weight:bold">인덱스 시트</a>' : '') +
    '</p>' +
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:22px 0">' +
    '<p style="font-size:11px;color:#64748b">이 메일은 Mail Backup 앱이 자동 발송했습니다.</p></div>';

  var text = subject + '\n\n' + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n') +
    (links.webAppUrl ? '\n\n백업 앱: ' + links.webAppUrl : '') +
    (links.folderUrl ? '\nDrive 폴더: ' + links.folderUrl : '') +
    (links.indexSheetUrl ? '\n인덱스 시트: ' + links.indexSheetUrl : '');

  return { subject: subject, htmlBody: html, textBody: text };
}

if (typeof module !== 'undefined') {
  module.exports = { buildCompletionEmail: buildCompletionEmail, fmtBytes: fmtBytes_ };
}
