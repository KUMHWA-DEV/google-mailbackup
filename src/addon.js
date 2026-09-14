/**
 * Gmail 애드온(사이드바) 카드. 같은 스크립트를 Google Workspace 애드온으로 배포하면
 * Gmail 오른쪽 패널에 나타난다 (appsscript.json의 addOns 참고).
 *
 *  - 첫 실행: 온보딩 카드 — 저장 위치, 📦 전체 메일 / 📅 날짜부터, 자동 백업 주기, ▶ 백업 시작
 *  - 이후 홈 카드: 상태, 저장 위치, 보관 현황, ▶ 지금 백업, 빠른 설정(자동 백업·주기(일)·첨부·알림), 🤖 AI 연결, 🌐 앱
 *  - 메일을 열었을 때: 그 메일이 백업됐는지, Drive 원본·첨부 링크
 */
function onAddonHomepage() { return buildAddonHomeCard_(); }
function onAddonMessageOpen(e) { return buildAddonMessageCard_(e && e.gmail && e.gmail.messageId); }
function onAddonStop() { stopBackup(); return addonUpdate_('⏹ 중지 요청', buildAddonHomeCard_()); }
function onAddonResume() { resumeBackup(); return addonUpdate_('▶ 이어서 실행', buildAddonHomeCard_()); }
function onAddonCancel() { cancelBackup(); return addonUpdate_('취소됨', buildAddonHomeCard_()); }
function onAddonRefresh() { return addonUpdate_('', buildAddonHomeCard_()); }
function onAddonGoHome() { return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(buildAddonHomeCard_())).build(); }

/** 온보딩/홈에서 ▶ 백업 시작. formInputs: scope = all|since, sinceDate(ms), autoOn, intervalDays */
function onAddonRunBackup(e) {
  var f = addonInputs_(e), s = getSettings_(), patch = {};
  if (f.scope === 'since' && f.sinceDate) patch.initialStartDate = Utilities.formatDate(new Date(Number(f.sinceDate)), CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  else if (f.scope === 'all') patch.initialStartDate = '';
  if (f.intervalDays) patch.intervalDays = f.intervalDays;
  if (Object.keys(patch).length) s = saveSettings_(Object.assign({}, s, patch));
  if (f.autoOn === 'on' && !scheduledTriggerInstalled_()) setupScheduledTrigger();
  previewBackup({ scope: f.scope === 'since' ? 'since' : (f.scope === 'all' ? 'all' : undefined), sinceDate: patch.initialStartDate || '' });
  var d = runBackupNow();
  var pv = loadPreview_();
  return addonUpdate_('⏳ 백업 시작' + (pv && pv.newCount ? ' · ' + pv.newCount + '건 예상' : '') + ' · 백그라운드 진행', buildAddonHomeCard_());
}

/** 빠른 설정 저장. */
function onAddonSaveQuick(e) {
  var f = addonInputs_(e), s = getSettings_();
  var next = saveSettings_(Object.assign({}, s, {
    intervalDays: f.intervalDays || s.intervalDays,
    saveAttachments: f.saveAttachments === 'on',
    notifyOnComplete: f.notifyOnComplete === 'on',
  }));
  var wantAuto = f.autoOn === 'on', hasAuto = scheduledTriggerInstalled_();
  if (wantAuto && (!hasAuto || next.intervalDays !== s.intervalDays)) setupScheduledTrigger();
  if (!wantAuto && hasAuto) removeScheduledTrigger();
  return addonUpdate_('✔ 저장됨 · ' + (wantAuto ? next.intervalDays + '일마다 자동 백업' : '자동 백업 꺼짐'), buildAddonHomeCard_());
}

// ---------- helpers ----------
function addonInputs_(e) {
  var out = {};
  var fi = e && e.commonEventObject && e.commonEventObject.formInputs;
  if (fi) Object.keys(fi).forEach(function (k) { var v = fi[k]; if (v.stringInputs && v.stringInputs.value) out[k] = v.stringInputs.value[0]; else if (v.dateInput && v.dateInput.msSinceEpoch) out[k] = v.dateInput.msSinceEpoch; });
  var legacy = e && e.formInput;
  if (legacy) Object.keys(legacy).forEach(function (k) { if (out[k] == null) out[k] = legacy[k]; });
  return out;
}
function addonUpdate_(msg, card) {
  var b = CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card));
  if (msg) b.setNotification(CardService.newNotification().setText(msg));
  return b.build();
}
function fmtB_(n) { n = Number(n) || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i]; }
function fmtD_(iso) { return iso ? Utilities.formatDate(new Date(iso), CONFIG.TIME_ZONE, 'M월 d일 HH:mm') : '-'; }
function ic_(name) { return CardService.newIconImage().setIcon(CardService.Icon[name]); }
function kv_(icon, top, text, bottom) { var w = CardService.newDecoratedText().setStartIcon(ic_(icon)).setText(text); if (top) w.setTopLabel(top); if (bottom) w.setBottomLabel(bottom); return w; }
function sw_(name, label, on, icon) { var w = CardService.newDecoratedText().setText(label).setSwitchControl(CardService.newSwitch().setFieldName(name).setValue('on').setSelected(!!on)); if (icon) w.setStartIcon(ic_(icon)); return w; }
function btn_(text, fn, filled) { var b = CardService.newTextButton().setText(text).setOnClickAction(CardService.newAction().setFunctionName(fn)); if (filled) b.setTextButtonStyle(CardService.TextButtonStyle.FILLED); return b; }
function link_(text, url) { return CardService.newTextButton().setText(text).setOpenLink(CardService.newOpenLink().setUrl(url)); }
function aiSection_(d) {
  var sec = CardService.newCardSection().setHeader('🤖 AI 연결').setCollapsible(true).setNumUncollapsibleWidgets(1)
    .addWidget(CardService.newTextParagraph().setText('Claude · ChatGPT · Gemini 등 MCP 지원 AI에서 백업 메일을 검색하고 첨부를 읽게 할 수 있습니다.'))
    .addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">예: "지난달 거래처가 보낸 계약서 첨부 요약해줘", "9월 정산 관련 메일 찾아줘"</font>'));
  var b = CardService.newButtonSet();
  if (d.webAppUrl) b.addButton(link_('연결 방법 보기', d.webAppUrl + '#ai'));
  b.addButton(link_('설정 파일(GitHub)', 'https://github.com/KUMHWA-DEV/google-mailbackup#7-aimcp로-백업-메일-조회하기'));
  return sec.addWidget(b);
}
function linkSection_(d) {
  var b = CardService.newButtonSet();
  if (d.webAppUrl) b.addButton(link_('🌐 앱 열기 · 심화 설정', d.webAppUrl));
  if (d.folderUrl) b.addButton(link_('📁 백업 폴더', d.folderUrl));
  if (d.indexSheetUrl) b.addButton(link_('📊 인덱스', d.indexSheetUrl));
  return CardService.newCardSection().addWidget(b);
}

// ---------- cards ----------
function buildAddonHomeCard_() {
  var d = getDashboard();
  var s = d.settings || {}, sch = d.schedule || {}, sum = d.summary || {}, r = d.currentRun || {};
  var running = d.state === 'running' || d.state === 'queued' || d.state === 'stopping', failed = d.state === 'error', paused = d.state === 'paused';
  var card = CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup').setSubtitle(d.user || '')
    .setImageUrl('https://www.gstatic.com/images/icons/material/system/2x/cloud_upload_black_24dp.png').setImageStyle(CardService.ImageStyle.CIRCLE));

  // 첫 실행: 온보딩
  if (!d.lastSyncAt && !running && !failed && !paused) {
    card.addSection(CardService.newCardSection().setHeader('🎉 첫 백업')
      .addWidget(CardService.newTextParagraph().setText('회사 메일은 45일 뒤 지워집니다. 원본(.eml)과 첨부를 아래 위치에 보관하고, 이후엔 새 메일만 자동으로 추가합니다.'))
      .addWidget(kv_('BOOKMARK', '저장 위치 (본인 드라이브)', d.folderPath || '내 드라이브 › Mail Backup', '라벨별 폴더 · 인덱스 시트 자동 생성'))
      .addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON).setFieldName('scope').setTitle('범위')
        .addItem('📦 지금 있는 메일 전부', 'all', !s.initialStartDate).addItem('📅 아래 날짜부터', 'since', !!s.initialStartDate))
      .addWidget(CardService.newDatePicker().setFieldName('sinceDate').setTitle('시작일 (날짜부터 선택 시)')
        .setValueInMsSinceEpoch(s.initialStartDate ? new Date(s.initialStartDate + 'T00:00:00+09:00').getTime() : Date.now() - 45 * 86400000))
      .addWidget(sw_('autoOn', '자동 백업 켜기', true, 'CLOCK'))
      .addWidget(CardService.newTextInput().setFieldName('intervalDays').setTitle('자동 백업 주기 (일)').setValue(String(s.intervalDays)).setHint('예: 7 = 매주, 1 = 매일 · 새벽 3시'))
      .addWidget(CardService.newButtonSet().addButton(btn_('▶ 백업 시작', 'onAddonRunBackup', true)))
      .addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">백그라운드에서 진행되며 Gmail을 닫아도 계속됩니다. 진행 상황은 이 카드와 웹앱에서 확인합니다.</font>')));
    card.addSection(aiSection_(d));
    card.addSection(linkSection_(d));
    return card.build();
  }

  // 상태
  var p = r.progress || {};
  var pct = p.percent != null ? p.percent : (r.expectedTotal ? Math.min(100, Math.round(r.processed / r.expectedTotal * 100)) : null);
  var stateText = running ? (d.state === 'queued' ? '⏳ 대기열 · 곧 시작' : d.state === 'stopping' ? '⏹ 중지 중' : '⚙️ 백업 진행 중') + (r.startedAt ? ' · ' + r.processed + (r.expectedTotal ? ' / ' + r.expectedTotal : '') + '건' + (pct != null ? ' (' + pct + '%)' : '') : '')
    : paused ? '⏸ 중지됨 · ' + (r.processed || 0) + '건 저장'
    : failed ? '⚠️ 백업 실패' : (sch.isDue ? '🟠 백업할 때가 됐어요' : '🟢 최신 상태');
  var stateSub = running ? ((r.startedAt ? '시작 ' + fmtD_(r.startedAt) + ' · 경과 ' + Math.round((p.elapsedSeconds || 0) / 60) + '분 · ' + fmtB_(r.bytes || 0) + ' · ' : '') + (d.message || ''))
    : paused ? '"이어서"를 누르면 이 위치부터 계속합니다'
    : failed ? (d.lastError || d.message) : ('마지막 ' + fmtD_(d.lastSyncAt) + ' · 다음 ' + (d.triggerInstalled ? fmtD_(new Date(sch.nextRunEpoch * 1000).toISOString()) : '자동 꺼짐'));
  var st = CardService.newCardSection()
    .addWidget(kv_(running ? 'CLOCK' : paused ? 'CLOCK' : failed ? 'STAR' : 'CONFIRMATION_NUMBER_ICON', '상태', stateText, stateSub));
  if (running && pct != null) st.addWidget(CardService.newTextParagraph().setText('<b>' + '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5)) + '</b> ' + pct + '%' + (p.etaSeconds != null ? ' · 남은 약 ' + Math.max(1, Math.round(p.etaSeconds / 60)) + '분' : '')));
  if (running && (r.byCategory || []).length) st.addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">' + r.byCategory.slice(0, 4).map(function (c) { return c.name + ' ' + c.count; }).join(' · ') + '</font>'));
  st
    .addWidget(kv_('BOOKMARK', '저장 위치 (본인 드라이브)', d.folderPath || '내 드라이브 › Mail Backup', '📥 ' + (sum.receivedCount || 0) + ' · 📤 ' + (sum.sentCount || 0) + ' · 📎 ' + (sum.withAttachments || 0) + ' · ' + fmtB_(sum.totalBytes)))
    .addWidget(kv_('EMAIL', '보관 메일', String(sum.total || 0) + '건', sum.oldestDate ? fmtD_(sum.oldestDate).replace(/ \d\d:\d\d$/, '') + ' ~ ' + fmtD_(sum.newestDate).replace(/ \d\d:\d\d$/, '') : ''));
  var rb = CardService.newButtonSet();
  if (running) rb.addButton(btn_('⏹ 중지', 'onAddonStop'));
  else if (paused) { rb.addButton(btn_('▶ 이어서', 'onAddonResume', true)); rb.addButton(btn_('✕ 취소', 'onAddonCancel')); }
  else rb.addButton(btn_(failed ? '↻ 다시 시도' : '▶ 지금 백업', 'onAddonRunBackup', true));
  rb.addButton(btn_('⟳ 새로고침', 'onAddonRefresh'));
  if (running) st.addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">카드는 자동 갱신되지 않습니다. ⟳ 새로고침으로 진행 상황을 다시 불러오세요.</font>'));
  st.addWidget(rb);
  card.addSection(st);

  // 빠른 설정
  card.addSection(CardService.newCardSection().setHeader('⚙️ 빠른 설정').setCollapsible(true).setNumUncollapsibleWidgets(0)
    .addWidget(sw_('autoOn', '자동 백업', d.triggerInstalled, 'CLOCK'))
    .addWidget(CardService.newTextInput().setFieldName('intervalDays').setTitle('주기 (일)').setValue(String(s.intervalDays)).setHint('1 이상 정수 · 7 = 매주 월요일, 그 외 N일마다 새벽 3시'))
    .addWidget(sw_('saveAttachments', '첨부 별도 저장', s.saveAttachments, 'DESCRIPTION'))
    .addWidget(sw_('notifyOnComplete', '완료 알림 메일' + (s.notifyEmail ? ' → ' + s.notifyEmail : ''), s.notifyOnComplete, 'EMAIL'))
    .addWidget(CardService.newButtonSet().addButton(btn_('저장', 'onAddonSaveQuick', true)))
    .addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">폴더 기준·하위 폴더·검색 조건·회당 최대·알림 주소는 앱에서 설정합니다.</font>')));

  // 최근 실행
  var hist = (d.history || []).slice(0, 3);
  if (hist.length) {
    var sec = CardService.newCardSection().setHeader('🕘 최근 실행').setCollapsible(true).setNumUncollapsibleWidgets(1);
    hist.forEach(function (h) {
      sec.addWidget(CardService.newDecoratedText().setStartIcon(ic_(h.errors ? 'STAR' : 'CONFIRMATION_NUMBER_ICON'))
        .setText(fmtD_(h.startedAt) + ' · +' + h.processed + '건 · ' + fmtB_(h.bytes))
        .setBottomLabel((h.byCategory || []).slice(0, 3).map(function (c) { return c.name + ' ' + c.count; }).join(' · ') + (h.manual ? ' · 수동' : ' · 자동')));
    });
    card.addSection(sec);
  }
  card.addSection(aiSection_(d));
  card.addSection(linkSection_(d));
  return card.build();
}

function buildAddonMessageCard_(messageId) {
  var rec = messageId ? loadRecordById_(messageId) : null;
  var card = CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup').setSubtitle('이 메일'));
  var sec = CardService.newCardSection();
  if (rec) {
    sec.addWidget(kv_('CONFIRMATION_NUMBER_ICON', '백업됨', fmtD_(rec.backedUpAt), '📁 ' + (rec.category || '') + ' · ' + fmtB_(rec.sizeBytes)));
    var b = CardService.newButtonSet();
    if (rec.driveUrl) b.addButton(link_('↗ Drive 원본', rec.driveUrl));
    if (rec.driveFileId) b.addButton(link_('⬇ .eml', driveDownloadUrl(rec.driveFileId)));
    sec.addWidget(b);
    card.addSection(sec);
    var atts = parseAttachmentFiles(rec);
    if (atts.length) {
      var asec = CardService.newCardSection().setHeader('📎 첨부 ' + atts.length + '개');
      atts.forEach(function (a) {
        var w = CardService.newDecoratedText().setStartIcon(ic_('DESCRIPTION')).setText(a.name).setBottomLabel(a.size ? fmtB_(a.size) + ' · 클릭하면 다운로드' : '');
        if (a.fileId) w.setOpenLink(CardService.newOpenLink().setUrl(driveDownloadUrl(a.fileId)));
        asec.addWidget(w);
      });
      card.addSection(asec);
    }
  } else {
    var d = getDashboard();
    sec.addWidget(kv_('CLOCK', '이 메일', d.lastSyncAt ? '⏳ 아직 백업 전' : '🎉 아직 백업을 시작하지 않았어요', d.triggerInstalled ? '다음 자동 백업 ' + fmtD_(new Date((d.schedule || {}).nextRunEpoch * 1000).toISOString()) : '홈 카드에서 시작할 수 있습니다'));
    sec.addWidget(CardService.newButtonSet().addButton(btn_(d.lastSyncAt ? '▶ 지금 백업' : '🏠 홈에서 시작', d.lastSyncAt ? 'onAddonRunBackup' : 'onAddonGoHome', true)));
    card.addSection(sec);
  }
  return card.build();
}
