/**
 * Gmail 애드온(사이드바) 카드. 같은 스크립트를 Google Workspace 애드온으로 배포하면
 * Gmail 오른쪽 패널에 나타난다 (appsscript.json의 addOns 참고).
 *
 *  - 홈 카드: 상태, 보관 현황, ▶ 지금 백업, 🌐 앱 열기, 📁 Drive 폴더
 *  - 메일을 열었을 때: 그 메일이 백업됐는지, Drive 원본·첨부 링크
 */
function onAddonHomepage() {
  return buildAddonHomeCard_();
}

function onAddonMessageOpen(e) {
  var messageId = e && e.gmail && e.gmail.messageId;
  return buildAddonMessageCard_(messageId);
}

function onAddonRunBackup() {
  runBackupNow();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('⏳ 백업을 대기열에 넣었습니다. 백그라운드에서 진행됩니다.'))
    .setNavigation(CardService.newNavigation().updateCard(buildAddonHomeCard_()))
    .build();
}

function onAddonRefresh() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(buildAddonHomeCard_()))
    .build();
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

function buildAddonHomeCard_() {
  var d = getDashboard();
  var sch = d.schedule || {}, sum = d.summary || {}, r = d.currentRun || {};
  var running = d.state === 'running' || d.state === 'queued';
  var stateText = running ? '⚙️ 백업 진행 중' + (r.expectedTotal ? ' ' + r.processed + ' / ' + r.expectedTotal : '') : (sch.isDue ? '🟠 백업할 때가 됐어요' : '🟢 최신 상태');

  var status = CardService.newCardSection()
    .addWidget(CardService.newDecoratedText().setTopLabel('상태').setText(stateText)
      .setBottomLabel(running ? (d.message || '') : ('마지막 ' + addonFmtDate_(d.lastSyncAt) + ' · 다음 ' + (d.triggerInstalled ? addonFmtDate_(new Date(sch.nextRunEpoch * 1000).toISOString()) : '자동 꺼짐'))))
    .addWidget(CardService.newDecoratedText().setTopLabel('보관 메일').setText(String(sum.total || 0) + '건 · ' + addonFmtBytes_(sum.totalBytes))
      .setBottomLabel('📥 ' + (sum.receivedCount || 0) + ' · 📤 ' + (sum.sentCount || 0) + ' · 📎 ' + (sum.withAttachments || 0)));

  var buttons = CardService.newButtonSet();
  if (!running) {
    buttons.addButton(CardService.newTextButton().setText('▶ 지금 백업')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onAddonRunBackup')));
  } else {
    buttons.addButton(CardService.newTextButton().setText('⟳ 새로고침')
      .setOnClickAction(CardService.newAction().setFunctionName('onAddonRefresh')));
  }
  if (d.webAppUrl) buttons.addButton(CardService.newTextButton().setText('🌐 앱 열기').setOpenLink(CardService.newOpenLink().setUrl(d.webAppUrl)));
  if (d.folderUrl) buttons.addButton(CardService.newTextButton().setText('📁 Drive').setOpenLink(CardService.newOpenLink().setUrl(d.folderUrl)));
  status.addWidget(buttons);

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Mail Backup').setSubtitle(d.user || ''))
    .addSection(status);

  var hist = (d.history || []).slice(0, 3);
  if (hist.length) {
    var sec = CardService.newCardSection().setHeader('최근 실행');
    hist.forEach(function (h) {
      sec.addWidget(CardService.newDecoratedText()
        .setText((h.errors ? '⚠️ ' : '✅ ') + addonFmtDate_(h.startedAt) + ' · +' + h.processed + '건 · ' + addonFmtBytes_(h.bytes))
        .setBottomLabel((h.byCategory || []).slice(0, 3).map(function (c) { return c.name + ' ' + c.count; }).join(' · ')));
    });
    card.addSection(sec);
  }
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
    sec.addWidget(CardService.newDecoratedText().setTopLabel('이 메일').setText('⏳ 아직 백업 전')
      .setBottomLabel(d.triggerInstalled ? '다음 자동 백업 ' + addonFmtDate_(new Date((d.schedule || {}).nextRunEpoch * 1000).toISOString()) : '자동 백업 꺼짐'));
    sec.addWidget(CardService.newButtonSet().addButton(CardService.newTextButton().setText('▶ 지금 백업')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onAddonRunBackup'))));
  }
  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Mail Backup')).addSection(sec).build();
}
