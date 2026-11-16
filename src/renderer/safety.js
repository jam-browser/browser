'use strict';
/* global jamApp, $, el, toast, tabs, activeTab, createTab, prettyUrl */
/**
 * 보안 기능 화면
 *  1) 클립보드 경고: 사이트가 클립보드에 무언가를 넣으면 내용을 보여주고 "명령어라면 절대 실행하지 마세요" 경고
 *  2) 다운로드 목록 + 확인 전 보관: 설치/실행 파일은 '이름.다운로드확인전' 으로 저장되어 실행되지 않음, 사용자가 직접 풀어야 사용 가능
 */

// ======================================================================
// 1) 클립보드 경고
// ======================================================================
const COMMAND_RE =
  /(powershell|pwsh|cmd(\.exe)?\s*\/[ck]|mshta|wscript|cscript|rundll32|regsvr32|certutil|bitsadmin|msiexec|curl\s+|wget\s+|\biwr\b|\birm\b|invoke-webrequest|invoke-restmethod|invoke-expression|\biex\b|start-process|-enc(odedcommand)?\b|frombase64string|\|\s*(ba)?sh\b|\bsudo\s|\bchmod\s|net\s+user|reg\s+add|schtasks|\.(ps1|bat|cmd|vbs|hta|exe|msi)\b|https?:\/\/\S+\s*\|)/i;

let lastClipboard = null;
let lastWarnAt = 0;
let lastWarnText = null;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function refreshClipboardBaseline() {
  try {
    lastClipboard = await jamApp.readClipboard();
  } catch {}
}
// 다른 프로그램에서 복사하고 돌아온 경우는 사이트 탓이 아니므로 기준을 새로 잡는다
window.addEventListener('focus', refreshClipboardBaseline);
refreshClipboardBaseline();

async function checkClipboard(tab, info) {
  let text;
  try {
    text = await jamApp.readClipboard();
  } catch {
    return;
  }
  const changed = text !== lastClipboard;
  lastClipboard = text;
  if (!text) return;
  // 내가 직접 드래그해서 복사한 글자와 같으면 정상 복사 → 경고하지 않음
  if (info.kind === 'copy-event' && norm(text) === norm(info.selection)) return;
  // 권한 요청 경로(iframe 등)는 클립보드가 실제로 바뀌었을 때만
  if (info.kind === 'permission' && !changed) return;
  if (text === lastWarnText && Date.now() - lastWarnAt < 4000) return;
  lastWarnText = text;
  lastWarnAt = Date.now();
  showClipboardWarning(tab, text);
}

function showClipboardWarning(tab, text) {
  const dlg = $('#clip-modal');
  const isCmd = COMMAND_RE.test(text) || /^\s*[$>#]\s/m.test(text);
  $('#clip-site').textContent = prettyUrl(tab?.url || '') || '알 수 없는 사이트';
  $('#clip-text').textContent = text.length > 600 ? text.slice(0, 600) + '…' : text;
  $('#clip-danger').hidden = !isCmd;
  dlg.classList.toggle('danger', isCmd);
  if (!dlg.open) dlg.showModal();
}

$('#clip-clear').addEventListener('click', async () => {
  await jamApp.clearClipboard();
  lastClipboard = '';
  $('#clip-modal').close();
  toast('클립보드를 비웠어요');
});
$('#clip-ok').addEventListener('click', () => $('#clip-modal').close());

// 접속한 사이트에 클립보드 복사 코드가 있으면 상단에 안내
function updateClipSiteBanner() {
  const t = activeTab;
  $('#clip-site-banner').hidden = !(t && t.clipboardSite && !t.clipboardSiteDismissed);
}
$('#clip-site-close').addEventListener('click', () => {
  if (activeTab) activeTab.clipboardSiteDismissed = true;
  updateClipSiteBanner();
});

// app.js 의 탭 이벤트에서 호출된다 (모든 탭 대상)
function onSafetyPageEvent(tab, channel, data) {
  if (channel === 'jam:clipboard') checkClipboard(tab, data || {});
  else if (channel === 'jam:clipboard-site') {
    tab.clipboardSite = true;
    tab.clipboardSiteDismissed = false;
    updateClipSiteBanner();
  }
}
function onSafetyNavigated(tab) {
  tab.clipboardSite = false;
  if (tab === activeTab) updateClipSiteBanner();
}

jamApp.onClipboardWritten((wcId) => {
  const tab = tabs.find((t) => t.ready && t.webview.getWebContentsId() === wcId);
  if (tab) checkClipboard(tab, { kind: 'permission' });
});

// ======================================================================
// 2) 다운로드 + 격리
// ======================================================================
const downloadList = new Map();

function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function renderDownloads() {
  const items = [...downloadList.values()].sort((a, b) => b.at - a.at);
  const active = items.filter((r) => r.state === 'progressing').length;
  const quarantined = items.filter((r) => r.quarantined && r.state === 'completed').length;
  const badge = $('#downloads-badge');
  badge.hidden = !(active || quarantined);
  badge.textContent = active ? String(active) : '🛡';
  $('#downloads-empty').hidden = items.length > 0;
  $('#downloads-list').replaceChildren(
    ...items.map((r) => {
      const pct = r.total ? Math.round((r.received / r.total) * 100) : 0;
      let status;
      if (r.state === 'progressing') status = `${formatBytes(r.received)} / ${r.total ? formatBytes(r.total) : '?'} · ${pct}%`;
      else if (r.state === 'cancelled') status = '취소됨';
      else if (r.state === 'interrupted') status = '중단됨';
      else if (r.quarantined) status = '🛡️ 확인 전 보관 중 · 이름 끝에 .다운로드확인전 이 붙어 실행되지 않아요';
      else if (r.released) status = '실행 가능하게 풀림 · 다운로드 폴더';
      else status = `완료 · ${formatBytes(r.received)}`;
      return el(
        'li',
        { class: `dl-item${r.quarantined ? ' quarantined' : ''}` },
        el('div', { class: 'dl-name', title: r.url }, r.name),
        el('div', { class: 'dl-status' }, status),
        r.state === 'progressing' ? el('div', { class: 'dl-bar' }, el('i', { style: { width: `${pct}%` } })) : null,
        el(
          'div',
          { class: 'dl-actions' },
          r.state === 'progressing'
            ? el('button', { class: 'mini-btn', onclick: () => jamApp.deleteDownload(r.id) }, '취소')
            : null,
          r.quarantined && r.state === 'completed'
            ? el('button', { class: 'mini-btn warn', onclick: () => jamApp.releaseDownload(r.id) }, '실행 가능하게 풀기')
            : null,
          r.state === 'completed' && !r.quarantined && !r.released
            ? el('button', { class: 'mini-btn', onclick: () => jamApp.openDownload(r.id) }, '열기')
            : null,
          r.state === 'completed' ? el('button', { class: 'mini-btn', onclick: () => jamApp.showDownload(r.id) }, '폴더') : null,
          r.state !== 'progressing'
            ? el('button', { class: 'mini-btn danger', onclick: () => jamApp.deleteDownload(r.id) }, '삭제')
            : null
        )
      );
    })
  );
}

jamApp.onDownload((r) => {
  if (r.removed) downloadList.delete(r.id);
  else {
    const prev = downloadList.get(r.id);
    downloadList.set(r.id, r);
    if (!prev) {
      if (r.quarantined) toast(`🛡️ "${r.name}"은(는) 설치·실행 파일이라 실행되지 않는 이름(.다운로드확인전)으로 받고 있어요`);
      else toast(`⬇ "${r.name}" 다운로드를 시작했어요`);
    } else if (prev.state !== 'completed' && r.state === 'completed' && r.quarantined) {
      toast(`🛡️ "${r.name}" 받기 완료 · 아직 실행되지 않는 상태예요. 쓰려면 다운로드 목록에서 직접 풀어주세요`, [
        { label: '목록 보기', fn: () => $('#downloads-pop').classList.add('open') },
      ]);
    }
  }
  renderDownloads();
});

jamApp.onDownloadBlocked(({ name }) => {
  toast(`🛡️ Jam이 이동한 링크가 파일 다운로드("${name}")여서 받지 않았어요. 필요하면 직접 받으세요`);
});

$('#downloads-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#downloads-pop').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#downloads-pop')) $('#downloads-pop').classList.remove('open');
});

jamApp.listDownloads().then((list) => {
  for (const r of list) downloadList.set(r.id, r);
  renderDownloads();
});
