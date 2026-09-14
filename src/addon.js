/**
 * Gmail 애드온(사이드바) 카드. 같은 스크립트를 Google Workspace 애드온으로 배포하면
 * Gmail 오른쪽 패널에 나타난다 (appsscript.json의 addOns 참고).
 *
 *  - 첫 실행: 온보딩 카드 — 📦 전체 메일 백업 / 📅 날짜부터, 자동 백업 스위치
 *  - 이후 홈 카드: 상태, 보관 현황, ▶ 지금 백업, 빠른 설정(자동 백업·주기·첨부·알림), 🌐 심화 설정은 앱에서
 *  - 메일을 열었을 때: 그 메일이 백업됐는지, Drive 원본·첨부 링크
 */
function onAddonHomepage() {
  return buildAddonHomeCard_();
}

function onAddonMessageOpen(e) {
  var messageId = e && e.gmail && e.gmail.messageId;
  return buildAddonMessageCard_(messageId);
}

function onAddonRefresh() {
  return addonUpdate_('', buildAddonHomeCard_());
}

/** 온보딩/홈에서 ▶ 백업 시작. formInputs.scope = all | since, sinceDate = ms epoch (DatePicker). */
function onAddonRunBackup(e) {
  var f = addonInputs_(e);
  if (f.scope === 'since' && f.sinceDate) {
    var d = new Date(Number(f.sinceDate));
    saveSettings_(Object.assign({}, getSettings_(), { initialStartDate: Utilities.formatDate(d, CONFIG.TIME_ZONE, 'yyyy-MM-dd') }));
  } else if (f.scope === 'all') {
    saveSettings_(Object.assign({}, getSettings_(), { initialStartDate: '' }));
  }
  if (f.autoOn === 'on' && !scheduledTriggerInstalled_()) setupScheduledTrigger();
  runBackupNow();
  return addonUpdate_('⏳ 백업을 대기열에 넣었습니다. 백그라운드에서 진행됩니다.', buildAddonHomeCard_());
}

/** 빠른 설정 저장. */
function onAddonSaveQuick(e) {
  var f = addonInputs_(e), s = getSettings_();
  var next = Object.assign({}, s, {
    intervalDays: f.intervalDays || s.intervalDays,
    saveAttachments: f.saveAttachments === 'on',
    notifyOnComplete: f.notifyOnComplete === 'on',
  });
  saveSettings_(next);
  var wantAuto = f.autoOn === 'on', hasAuto = scheduledTriggerInstalled_();
  if (wantAuto && (!hasAuto || next.intervalDays !== s.intervalDays)) setupScheduledTrigger();
  if (!wantAuto && hasAuto) removeScheduledTrigger();
  return addonUpdate_('✔ 저장됨', buildAddonHomeCard_());
}

// ---------- helpers ----------

function addonInputs_(e) {
  var out = {};
  var fi = e && e.commonEventObject && e.commonEventObject.formInputs;
  if (fi) {
    Object.keys(fi).forEach(function (k) {
      var v = fi[k];
      if (v.stringInputs && v.stringInputs.value) out[k] = v.stringInputs.value[0];
      else if (v.dateInput && v.dateInput.msSinceEpoch) out[k] = v.dateInput.msSinceEpoch;
    });
  }
  var legacy = e && e.formInput;
  if (legacy) Object.keys(legacy).forEach(function (k) { if (out[k] == null) out[k] = legacy[k]; });
  return out;
}
function addonUpdate_(msg, card) {
  var b = CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card));
  if (msg) b.setNotification(CardService.newNotification().setText(msg));
  return b.build();
}
function addonFmtBytes_(n) {
  n = Number(n) || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}
function addonFmtDate_(iso) {
  if (!iso) return '-';
  return Utilities.formatDate(new Date(iso), CONFIG.TIME_ZONE, 'MM.dd HH:mm');
}
function addonSwitch_(name, label, on) {
  return CardService.newDecoratedText().setText(label)
    .setSwitchControl(CardService.newSwitch().setFieldName(name).setValue('on').setSelected(!!on));
}
function addonLinkButtons_(d) {
  var b = CardService.newButtonSet();
  if (d.webAppUrl) b.addButton(CardService.newTextButton().setText('🌐 앱 열기 · 심화 설정').setOpenLink(CardService.newOpenLink().setUrl(d.webAppUrl)));
  if (d.folderUrl) b.addButton(CardService.newTextButton().setText('📁 Drive').setOpenLink(CardService.newOpenLink().setUrl(d.folderUrl)));
  return b;
}

// ---------- cards ----------

function buildAddonHomeCard_() {
  var d = getDashboard();
  var s = d.settings || {}, sch = d.schedule || {}, sum = d.summary || {}, r = d.currentRun || {};
  var running = d.state === 'running' || d.state === 'queued';
  var card = CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup').setSubtitle(d.user || ''));

  // 첫 실행: 온보딩
  if (!d.lastSyncAt && !running) {
    var ob = CardService.newCardSection().setHeader('🎉 첫 백업')
      .addWidget(CardService.newTextParagraph().setText('회사 메일은 45일 뒤 지워집니다. 내 드라이브에 원본(.eml)으로 보관하고, 이후엔 새 메일만 자동으로 추가합니다.'))
      .addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.RADIO_BUTTON).setFieldName('scope').setTitle('범위')
        .addItem('📦 지금 있는 메일 전부', 'all', !s.initialStartDate)
        .addItem('📅 아래 날짜부터', 'since', !!s.initialStartDate))
      .addWidget(CardService.newDatePicker().setFieldName('sinceDate').setTitle('시작일 (날짜부터 선택 시)')
        .setValueInMsSinceEpoch(s.initialStartDate ? new Date(s.initialStartDate + 'T00:00:00+09:00').getTime() : Date.now() - 45 * 86400000))
      .addWidget(addonSwitch_('autoOn', '⏱ 자동 백업 (' + s.intervalDays + '일마다)', true))
      .addWidget(CardService.newButtonSet().addButton(CardService.newTextButton().setText('▶ 백업 시작')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName('onAddonRunBackup'))))
      .addWidget(CardService.newTextParagraph().setText('<font color="#5f6368">백그라운드에서 진행되며 Gmail을 닫아도 계속됩니다. 메일이 많으면 몇 시간 걸릴 수 있습니다.</font>'));
    card.addSection(ob);
    card.addSection(CardService.newCardSection().addWidget(addonLinkButtons_(d)));
    return card.build();
  }

  var stateText = running ? '⚙️ 백업 진행 중' + (r.expectedTotal ? ' ' + r.processed + ' / ' + r.expectedTotal : ' ' + r.processed + '건') : (sch.isDue ? '🟠 백업할 때가 됐어요' : '🟢 최신 상태');
  var status = CardService.newCardSection()
    .addWidget(CardService.newDecoratedText().setTopLabel('상태').setText(stateText)
      .setBottomLabel(running ? (d.message || '') : ('마지막 ' + addonFmtDate_(d.lastSyncAt) + ' · 다음 ' + (d.triggerInstalled ? addonFmtDate_(new Date(sch.nextRunEpoch * 1000).toISOString()) : '자동 꺼짐'))))
    .addWidget(CardService.newDecoratedText().setTopLabel('보관 메일').setText(String(sum.total || 0) + '건 · ' + addonFmtBytes_(sum.totalBytes))
      .setBottomLabel('📥 ' + (sum.receivedCount || 0) + ' · 📤 ' + (sum.sentCount || 0) + ' · 📎 ' + (sum.withAttachments || 0)));
  var runBtns = CardService.newButtonSet();
  if (!running) {
    runBtns.addButton(CardService.newTextButton().setText('▶ 지금 백업').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onAddonRunBackup')));
  } else {
    runBtns.addButton(CardService.newTextButton().setText('⟳ 새로고침').setOnClickAction(CardService.newAction().setFunctionName('onAddonRefresh')));
  }
  status.addWidget(runBtns);
  card.addSection(status);

  // 빠른 설정 (심화 설정은 앱에서)
  var quick = CardService.newCardSection().setHeader('⚙️ 빠른 설정').setCollapsible(true).setNumUncollapsibleWidgets(0)
    .addWidget(addonSwitch_('autoOn', '⏱ 자동 백업', d.triggerInstalled))
    .addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('intervalDays').setTitle('주기')
      .addItem('매일', '1', s.intervalDays === 1).addItem('3일마다', '3', s.intervalDays === 3).addItem('매주', '7', s.intervalDays === 7)
      .addItem('2주마다', '14', s.intervalDays === 14).addItem('30일마다', '30', s.intervalDays === 30)
      .addItem(String(s.intervalDays) + '일마다 (현재)', String(s.intervalDays), [1, 3, 7, 14, 30].indexOf(s.intervalDays) < 0))
    .addWidget(addonSwitch_('saveAttachments', '📎 첨부 별도 저장', s.saveAttachments))
    .addWidget(addonSwitch_('notifyOnComplete', '📨 완료 알림 메일', s.notifyOnComplete))
    .addWidget(CardService.newButtonSet().addButton(CardService.newTextButton().setText('저장')
      .setOnClickAction(CardService.newAction().setFunctionName('onAddonSaveQuick'))));
  card.addSection(quick);

  var hist = (d.history || []).slice(0, 3);
  if (hist.length) {
    var sec = CardService.newCardSection().setHeader('최근 실행').setCollapsible(true).setNumUncollapsibleWidgets(1);
    hist.forEach(function (h) {
      sec.addWidget(CardService.newDecoratedText()
        .setText((h.errors ? '⚠️ ' : '✅ ') + addonFmtDate_(h.startedAt) + ' · +' + h.processed + '건 · ' + addonFmtBytes_(h.bytes))
        .setBottomLabel((h.byCategory || []).slice(0, 3).map(function (c) { return c.name + ' ' + c.count; }).join(' · ')));
    });
    card.addSection(sec);
  }
  card.addSection(CardService.newCardSection().addWidget(addonLinkButtons_(d)));
  return card.build();
}

function buildAddonMessageCard_(messageId) {
  var rec = messageId ? loadRecordById_(messageId) : null;
  var sec = CardService.newCardSection();
  if (rec) {
    sec.addWidget(CardService.newDecoratedText().setTopLabel('이 메일').setText('✅ 백업됨 · ' + addonFmtDate_(rec.backedUpAt))
      .setBottomLabel('📁 ' + (rec.category || '') + (rec.agenda ? ' · 💼 ' + rec.agenda : '') + ' · ' + addonFmtBytes_(rec.sizeBytes)));
    var b = CardService.newButtonSet();
    if (rec.driveUrl) b.addButton(CardService.newTextButton().setText('↗ Drive 원본').setOpenLink(CardService.newOpenLink().setUrl(rec.driveUrl)));
    if (rec.driveFileId) b.addButton(CardService.newTextButton().setText('⬇ .eml').setOpenLink(CardService.newOpenLink().setUrl(driveDownloadUrl(rec.driveFileId))));
    sec.addWidget(b);
    var atts = parseAttachmentFiles(rec);
    if (atts.length) {
      var asec = CardService.newCardSection().setHeader('📎 첨부 ' + atts.length + '개');
      atts.forEach(function (a) {
        var w = CardService.newDecoratedText().setText(a.name).setBottomLabel(a.size ? addonFmtBytes_(a.size) : '');
        if (a.fileId) w.setOpenLink(CardService.newOpenLink().setUrl(driveDownloadUrl(a.fileId)));
        asec.addWidget(w);
      });
      return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup')).addSection(sec).addSection(asec).build();
    }
  } else {
    var d = getDashboard();
    sec.addWidget(CardService.newDecoratedText().setTopLabel('이 메일').setText(d.lastSyncAt ? '⏳ 아직 백업 전' : '🎉 아직 백업을 시작하지 않았어요')
      .setBottomLabel(d.triggerInstalled ? '다음 자동 백업 ' + addonFmtDate_(new Date((d.schedule || {}).nextRunEpoch * 1000).toISOString()) : '홈 카드에서 시작할 수 있습니다'));
    sec.addWidget(CardService.newButtonSet().addButton(CardService.newTextButton().setText(d.lastSyncAt ? '▶ 지금 백업' : '🏠 홈에서 시작')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName(d.lastSyncAt ? 'onAddonRunBackup' : 'onAddonGoHome'))));
  }
  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup')).addSection(sec).build();
}

function onAddonGoHome() {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(buildAddonHomeCard_())).build();
}
