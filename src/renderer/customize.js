'use strict';
/* global $, el, toast, tabs, activeTab, createTab, activateTab, closeTab, navigateTab, renderTabs, updateToolbar, prettyUrl, faviconFor, isWebUrl, jam, jamApp, JamSite, renderJam */
/**
 * 브라우저 UI 커스터마이징 + 일반 브라우저 기능 (요즘 데스크톱 브라우저들이 흔히 제공하는 것들)
 *
 *  모양: 테마(다크/라이트/시스템), 강조색(직접 선택 / 페이지 색 따라가기), 밀도(컴팩트), 모서리 둥글기,
 *        탭 위치(위·아래·왼쪽·오른쪽 세로 탭), Jam 패널 위치, 북마크 바, 홈 버튼, 미니맵/오버레이 표시, 사용자 CSS
 *  기능: 스피드 다이얼 새 탭, 북마크(Ctrl+D), 방문 기록(Ctrl+H), 페이지 내 찾기(Ctrl+F), 확대/축소(사이트별 기억),
 *        닫은 탭 다시 열기(Ctrl+Shift+T), 탭 고정·복제·드래그 정렬·우클릭 메뉴, 분할 화면, 전체 화면(F11),
 *        시작할 때 탭 복원, 검색 엔진 선택, 사이트별 CSS(웹페이지 꾸미기), 설정 백업/복원, 스타일 프리셋
 */

const START_URL = 'about:blank#jam-start';
const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  naver: { name: '네이버', url: 'https://search.naver.com/search.naver?query=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
};
const DEFAULTS = {
  theme: 'dark', // dark | light | system
  accent: '#2ee6a6',
  accentFromPage: false, // 페이지 색을 강조색으로
  density: 'normal', // normal | compact
  radius: 10,
  tabPosition: 'top', // top | bottom | left | right
  panelSide: 'right',
  showBookmarksBar: true,
  showHomeButton: false,
  showMinimap: true,
  overlayPosition: 'bottom', // bottom | top
  newTab: 'speeddial', // speeddial | home
  homeUrl: 'https://www.google.com/',
  searchEngine: 'google',
  restoreSession: true,
  userCss: '',
  siteCss: [], // [{ site: 'youtube.com', css: '...' }]
  zoom: {}, // site → zoom factor
};
const PRESETS = {
  classic: { label: '기본 (위쪽 탭)', set: { tabPosition: 'top', density: 'normal', radius: 10, showBookmarksBar: true, showHomeButton: false, accentFromPage: false, newTab: 'speeddial' } },
  sideColor: { label: '세로 탭 + 페이지 색', set: { tabPosition: 'left', density: 'normal', radius: 8, showBookmarksBar: true, showHomeButton: true, accentFromPage: true, newTab: 'speeddial' } },
  compact: { label: '컴팩트', set: { tabPosition: 'top', density: 'compact', radius: 4, showBookmarksBar: false, showHomeButton: true, accentFromPage: false, newTab: 'speeddial' } },
  side: { label: '세로 탭', set: { tabPosition: 'left', density: 'normal', radius: 8, showBookmarksBar: true, showHomeButton: true, accentFromPage: false, newTab: 'speeddial' } },
};

// ---------- 저장소 ----------
function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const settings = { ...DEFAULTS, ...load('jam-settings', {}) };
let bookmarks = load('jam-bookmarks', []);
let history = load('jam-history', []);
const closedTabs = [];
let splitTab = null;

const saveSettings = () => save('jam-settings', settings);
const saveBookmarks = () => save('jam-bookmarks', bookmarks);
let historyTimer = null;
const saveHistory = () => {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => save('jam-history', history.slice(0, 3000)), 500);
};

const isStart = (url) => !url || url === 'about:blank' || url.startsWith(START_URL);
const siteOf = (url) => JamSite.siteOf(url);

// ======================================================================
// 모양 적용
// ======================================================================
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#111';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#111111' : '#ffffff';
}

function normalizeColor(c) {
  if (!c) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  const v = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

let pageAccent = null;
function setAccent(hex) {
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-ink', inkFor(hex));
}

function applyLook() {
  const root = document.documentElement;
  const theme = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  root.style.setProperty('--ui-radius', `${settings.radius}px`);
  setAccent(settings.accentFromPage && pageAccent ? pageAccent : settings.accent);

  const app = $('#app');
  app.dataset.tabs = settings.tabPosition;
  $('#tabbar').classList.toggle('vertical', settings.tabPosition === 'left' || settings.tabPosition === 'right');
  $('#main').classList.toggle('panel-left', settings.panelSide === 'left');
  $('#bookmarks-bar').hidden = !settings.showBookmarksBar;
  $('#home-btn').hidden = !settings.showHomeButton;
  document.body.classList.toggle('no-minimap', !settings.showMinimap);
  document.body.classList.toggle('overlay-top', settings.overlayPosition === 'top');
  $('#user-css').textContent = settings.userCss || '';
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => settings.theme === 'system' && applyLook());

// ======================================================================
// 새 탭 / 홈 / 검색
// ======================================================================
const ui = {
  START_URL,
  isStart,
  newTabUrl: () => (settings.newTab === 'speeddial' ? START_URL : settings.homeUrl),
  homeUrl: () => settings.homeUrl,
  searchUrl: (q) => (SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google).url + encodeURIComponent(q),
};
window.ui = ui;

$('#home-btn').addEventListener('click', () => activeTab && navigateTab(activeTab, settings.homeUrl));

// ---------- 스피드 다이얼 (Vivaldi 식 새 탭) ----------
function renderStartPage() {
  const show = !!activeTab && isStart(activeTab.url);
  $('#start-page').hidden = !show;
  if (!show) return;
  const tiles = bookmarks.slice(0, 24);
  const frequent = topSites(8).filter((s) => !tiles.some((b) => b.url === s.url));
  const tile = (item, removable) =>
    el(
      'a',
      {
        class: 'sd-tile',
        href: '#',
        title: item.url,
        onclick: (e) => {
          e.preventDefault();
          navigateTab(activeTab, item.url);
        },
      },
      el('img', { src: faviconFor(item.url), alt: '' }),
      el('span', {}, item.title || prettyUrl(item.url)),
      removable
        ? el('button', {
            class: 'sd-remove',
            title: '스피드 다이얼에서 빼기',
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              removeBookmark(item.url);
            },
          }, '✕')
        : null
    );
  $('#sd-tiles').replaceChildren(...tiles.map((b) => tile(b, true)));
  $('#sd-frequent').replaceChildren(...frequent.map((s) => tile(s, false)));
  $('#sd-frequent-wrap').hidden = frequent.length === 0;
  $('#sd-empty').hidden = tiles.length > 0;
  $('#sd-engine').textContent = (SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.google).name;
}
$('#sd-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#sd-q').value.trim();
  if (!q || !activeTab) return;
  $('#sd-q').value = '';
  $('#url').value = q;
  $('#url-form').requestSubmit();
});

function topSites(n) {
  const count = new Map();
  for (const h of history.slice(0, 1500)) {
    const key = h.url.split('#')[0];
    const c = count.get(key) || { url: key, title: h.title, n: 0 };
    c.n++;
    count.set(key, c);
  }
  return [...count.values()].sort((a, b) => b.n - a.n).slice(0, n);
}

// ======================================================================
// 북마크
// ======================================================================
const isBookmarked = (url) => bookmarks.some((b) => b.url === url);
function addBookmark(url, title) {
  if (!isWebUrl(url) || isBookmarked(url)) return;
  bookmarks.push({ url, title: title || prettyUrl(url) });
  saveBookmarks();
  renderBookmarks();
}
function removeBookmark(url) {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  saveBookmarks();
  renderBookmarks();
}
function toggleBookmark() {
  const t = activeTab;
  if (!t || !isWebUrl(t.url)) return;
  if (isBookmarked(t.url)) {
    removeBookmark(t.url);
    toast('북마크를 지웠어요');
  } else {
    addBookmark(t.url, t.title);
    toast('⭐ 북마크했어요');
  }
}
function renderBookmarks() {
  $('#bookmarks-bar').replaceChildren(
    ...(bookmarks.length
      ? bookmarks.map((b) =>
          el(
            'button',
            {
              class: 'bm-item',
              title: `${b.title}\n${b.url}\n(가운데 클릭: 새 탭 · 우클릭: 삭제)`,
              onclick: () => activeTab && navigateTab(activeTab, b.url),
              onauxclick: (e) => e.button === 1 && createTab(b.url),
              oncontextmenu: (e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: '새 탭에서 열기', fn: () => createTab(b.url) },
                  { label: '북마크 삭제', fn: () => removeBookmark(b.url) },
                ]);
              },
            },
            el('img', { src: faviconFor(b.url), alt: '' }),
            el('span', {}, b.title || prettyUrl(b.url))
          )
        )
      : [el('span', { class: 'muted small' }, '⭐ 를 누르거나 Ctrl+D 로 북마크를 추가하세요')])
  );
  updateStar();
  renderStartPage();
  renderBookmarkManager();
}
function updateStar() {
  const t = activeTab;
  const star = $('#bookmark-star');
  star.hidden = !t || !isWebUrl(t.url);
  star.textContent = t && isBookmarked(t.url) ? '★' : '☆';
  star.classList.toggle('on', !!t && isBookmarked(t.url));
}
$('#bookmark-star').addEventListener('click', toggleBookmark);

// ======================================================================
// 방문 기록
// ======================================================================
function recordHistory(tab, url) {
  if (!isWebUrl(url) || JamSite.isSensitiveUrl(url)) return; // 로그인·인증 주소는 기록하지 않음
  if (history[0] && history[0].url === url) return;
  history.unshift({ url, title: tab.title || '', at: Date.now() });
  if (history.length > 3000) history.length = 3000;
  saveHistory();
}
function renderHistory() {
  const q = $('#history-q').value.trim().toLowerCase();
  const list = history.filter((h) => !q || h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)).slice(0, 300);
  let lastDay = '';
  const rows = [];
  for (const h of list) {
    const d = new Date(h.at);
    const day = d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    if (day !== lastDay) {
      rows.push(el('li', { class: 'h-day' }, day));
      lastDay = day;
    }
    rows.push(
      el(
        'li',
        { class: 'h-row', onclick: () => { createTab(h.url); $('#history-dialog').close(); } },
        el('span', { class: 'h-time' }, d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })),
        el('img', { src: faviconFor(h.url), alt: '' }),
        el('span', { class: 'h-title' }, h.title || prettyUrl(h.url)),
        el('span', { class: 'h-url muted' }, prettyUrl(h.url))
      )
    );
  }
  $('#history-list').replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted' }, '기록이 없어요')]));
}
function openHistory() {
  renderHistory();
  $('#history-dialog').showModal();
  $('#history-q').focus();
}
$('#history-q').addEventListener('input', renderHistory);
$('#history-clear').addEventListener('click', () => {
  if (!confirm('방문 기록을 모두 지울까요?')) return;
  history = [];
  save('jam-history', history);
  renderHistory();
  renderStartPage();
});
$('#history-close').addEventListener('click', () => $('#history-dialog').close());

// ======================================================================
// 페이지 내 찾기 (Ctrl+F)
// ======================================================================
let findTab = null;
function openFind() {
  if (!activeTab || isStart(activeTab.url)) return;
  findTab = activeTab;
  $('#find-bar').hidden = false;
  $('#find-q').select();
  $('#find-q').focus();
}
function closeFind() {
  $('#find-bar').hidden = true;
  if (findTab?.ready) findTab.webview.stopFindInPage('clearSelection');
  findTab = null;
  $('#find-count').textContent = '';
}
function doFind(forward = true, findNext = true) {
  const q = $('#find-q').value;
  if (!findTab?.ready) return;
  if (!q) {
    findTab.webview.stopFindInPage('clearSelection');
    $('#find-count').textContent = '';
    return;
  }
  findTab.webview.findInPage(q, { forward, findNext });
}
$('#find-q').addEventListener('input', () => doFind(true, false));
$('#find-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doFind(!e.shiftKey, true);
  if (e.key === 'Escape') closeFind();
});
$('#find-prev').addEventListener('click', () => doFind(false, true));
$('#find-next').addEventListener('click', () => doFind(true, true));
$('#find-close').addEventListener('click', closeFind);

// ======================================================================
// 확대 / 축소 (사이트별 기억)
// ======================================================================
const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function currentZoom(tab) {
  return settings.zoom[siteOf(tab.url)] || 1;
}
function setZoom(tab, z) {
  if (!tab?.ready) return;
  const site = siteOf(tab.url);
  z = Math.round(z * 100) / 100;
  if (site) {
    if (z === 1) delete settings.zoom[site];
    else settings.zoom[site] = z;
    saveSettings();
  }
  tab.webview.setZoomFactor(z);
  updateZoomIndicator();
}
function stepZoom(dir) {
  const t = activeTab;
  if (!t) return;
  const z = currentZoom(t);
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  setZoom(t, next || z);
}
function updateZoomIndicator() {
  const t = activeTab;
  const z = t ? currentZoom(t) : 1;
  const ind = $('#zoom-ind');
  ind.hidden = z === 1;
  ind.textContent = `${Math.round(z * 100)}%`;
}
$('#zoom-ind').addEventListener('click', () => setZoom(activeTab, 1));

// ======================================================================
// 탭: 우클릭 메뉴, 고정, 복제, 드래그 정렬, 분할 화면, 닫은 탭 다시 열기
// ======================================================================
function openMenu(x, y, items) {
  const menu = $('#ctx-menu');
  menu.replaceChildren(
    ...items.map((it) =>
      it === '-'
        ? el('div', { class: 'ctx-sep' })
        : el('button', { class: 'ctx-item', disabled: it.disabled, onclick: () => { closeMenu(); it.fn(); } }, it.label)
    )
  );
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
function closeMenu() {
  $('#ctx-menu').hidden = true;
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#ctx-menu')) closeMenu();
});
window.addEventListener('blur', closeMenu);

function sortPinned() {
  const pinned = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  tabs.splice(0, tabs.length, ...pinned, ...rest);
}

function tabMenu(t, x, y) {
  const i = tabs.indexOf(t);
  openMenu(x, y, [
    { label: '새로고침', fn: () => t.ready && t.webview.reload() },
    { label: '탭 복제', fn: () => createTab(isStart(t.url) ? START_URL : t.url) },
    { label: t.pinned ? '고정 해제' : '탭 고정', fn: () => { t.pinned = !t.pinned; sortPinned(); renderTabs(); saveSession(); } },
    { label: t.muted ? '탭 음소거 해제' : '탭 음소거', fn: () => setTabMuted(t, !t.muted) },
    '-',
    splitTab === t
      ? { label: '분할 화면 닫기', fn: () => setSplit(null) }
      : { label: '분할 화면으로 옆에 보기', disabled: t === activeTab, fn: () => setSplit(t) },
    { label: '북마크에 추가', disabled: !isWebUrl(t.url), fn: () => addBookmark(t.url, t.title) },
    '-',
    { label: '오른쪽 탭 모두 닫기', disabled: i === tabs.length - 1, fn: () => tabs.slice(i + 1).filter((x) => !x.pinned).forEach((x) => closeTab(x)) },
    { label: '다른 탭 모두 닫기', disabled: tabs.length < 2, fn: () => tabs.filter((x) => x !== t && !x.pinned).forEach((x) => closeTab(x)) },
    { label: '탭 닫기', fn: () => closeTab(t) },
  ]);
}

let dragTab = null;
ui.decorateTab = (t, node) => {
  node.classList.toggle('pinned', !!t.pinned);
  node.classList.toggle('split', t === splitTab);
  node.draggable = true;
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    tabMenu(t, e.clientX, e.clientY);
  });
  node.addEventListener('dragstart', (e) => {
    dragTab = t;
    e.dataTransfer.effectAllowed = 'move';
  });
  node.addEventListener('dragover', (e) => {
    if (!dragTab || dragTab === t) return;
    e.preventDefault();
    node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-target');
    if (!dragTab || dragTab === t) return;
    const from = tabs.indexOf(dragTab);
    tabs.splice(from, 1);
    tabs.splice(tabs.indexOf(t) + (from <= tabs.indexOf(t) ? 1 : 0), 0, dragTab);
    dragTab.pinned = t.pinned;
    dragTab = null;
    sortPinned();
    renderTabs();
    saveSession();
  });
  node.addEventListener('dragend', () => (dragTab = null));
  if (isStart(t.url)) node.querySelector('.title').textContent = '새 탭';
};

function setSplit(t) {
  splitTab = t && t !== activeTab ? t : null;
  layoutSplit();
  renderTabs();
}
function layoutSplit() {
  const views = $('#views');
  const on = !!splitTab && tabs.includes(splitTab) && splitTab !== activeTab;
  if (!on) splitTab = null;
  views.classList.toggle('split', on);
  for (const t of tabs) {
    t.webview.classList.toggle('split-left', on && t === activeTab);
    t.webview.classList.toggle('split-right', on && t === splitTab);
    if (on && t === splitTab) t.webview.classList.remove('inactive');
  }
  $('#split-close').hidden = !on;
}
$('#split-close').addEventListener('click', () => setSplit(null));

function reopenClosedTab() {
  const last = closedTabs.pop();
  if (last) createTab(last.url);
  else toast('다시 열 탭이 없어요');
}

// ---------- 세션 복원 ----------
let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    save('jam-session', tabs.filter((t) => t !== jam.tab || !jam.active).map((t) => ({ url: isStart(t.url) ? START_URL : t.url, pinned: !!t.pinned })));
  }, 400);
}

// ======================================================================
// app.js 가 부르는 훅
// ======================================================================
ui.onNavigated = (tab, url, inPage) => {
  if (!inPage) recordHistory(tab, url);
  else if (isWebUrl(url)) recordHistory(tab, url);
  if (tab === activeTab) {
    renderStartPage();
    updateStar();
    updateZoomIndicator();
  }
  if (tab === findTab && !inPage) closeFind();
  saveSession();
};
ui.onTitle = (tab) => {
  const h = history.find((x) => x.url === tab.url);
  if (h && tab.title) {
    h.title = tab.title;
    saveHistory();
  }
};
ui.onDomReady = (tab) => {
  // 사이트별 확대 배율
  const z = currentZoom(tab);
  if (tab.webview.getZoomFactor() !== z) tab.webview.setZoomFactor(z);
  // 사이트별 사용자 CSS (웹페이지 꾸미기)
  const site = siteOf(tab.url);
  for (const rule of settings.siteCss) {
    if (rule.css && site && (rule.site === '*' || siteOf('https://' + rule.site.replace(/^https?:\/\//, '')) === site)) {
      tab.webview.insertCSS(rule.css).catch(() => {});
    }
  }
  if (tab === activeTab) updateZoomIndicator();
};
ui.onThemeColor = (tab, color) => {
  tab.themeColor = normalizeColor(color);
  if (tab === activeTab && settings.accentFromPage) {
    pageAccent = tab.themeColor;
    applyLook();
  }
};
ui.onFound = (tab, result) => {
  if (tab !== findTab) return;
  $('#find-count').textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : '0/0';
};
ui.afterActivate = (tab) => {
  if (splitTab === tab) splitTab = null;
  layoutSplit();
  renderStartPage();
  updateStar();
  updateZoomIndicator();
  if (findTab && findTab !== tab) closeFind();
  if (settings.accentFromPage) {
    pageAccent = tab.themeColor || null;
    applyLook();
  }
  if (isStart(tab.url) && document.activeElement !== $('#url')) setTimeout(() => $('#sd-q').focus(), 0);
};
ui.onClose = (tab) => {
  if (isWebUrl(tab.url)) closedTabs.push({ url: tab.url, title: tab.title });
  if (closedTabs.length > 25) closedTabs.shift();
  if (tab === splitTab) splitTab = null;
  if (tab === findTab) closeFind();
  setTimeout(() => {
    layoutSplit();
    saveSession();
  }, 0);
};
ui.toolbarUrl = (tab) => (isStart(tab.url) ? '' : tab.url);
ui.shortcut = (action) => {
  switch (action) {
    case 'bookmark': toggleBookmark(); return true;
    case 'history': openHistory(); return true;
    case 'find': openFind(); return true;
    case 'reopen-tab': reopenClosedTab(); return true;
    case 'zoom-in': stepZoom(1); return true;
    case 'zoom-out': stepZoom(-1); return true;
    case 'zoom-reset': setZoom(activeTab, 1); return true;
    case 'toggle-bookmarks':
      settings.showBookmarksBar = !settings.showBookmarksBar;
      saveSettings();
      applyLook();
      return true;
    case 'settings': openSettings(); return true;
    case 'fullscreen': jamApp.toggleFullscreen(); return true;
  }
  return false;
};
ui.handleKey = (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let action = null;
  if (ctrl && e.shiftKey && k === 't') action = 'reopen-tab';
  else if (ctrl && e.shiftKey && k === 'b') action = 'toggle-bookmarks';
  else if (ctrl && k === 'd') action = 'bookmark';
  else if (ctrl && k === 'h') action = 'history';
  else if (ctrl && k === 'f') action = 'find';
  else if (ctrl && (k === '=' || k === '+')) action = 'zoom-in';
  else if (ctrl && k === '-') action = 'zoom-out';
  else if (ctrl && k === '0') action = 'zoom-reset';
  else if (ctrl && k === ',') action = 'settings';
  else if (k === 'f11') action = 'fullscreen';
  else if (k === 'escape' && !$('#find-bar').hidden) {
    closeFind();
    return true;
  }
  if (!action) return false;
  e.preventDefault();
  return ui.shortcut(action);
};

jamApp.onFullscreen((on) => document.body.classList.toggle('fullscreen', on));

// ======================================================================
// 메뉴 (☰)
// ======================================================================
$('#menu-btn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right - 220, r.bottom + 6, [
    { label: '새 탭                         Ctrl+T', fn: () => createTab() },
    { label: '닫은 탭 다시 열기     Ctrl+Shift+T', fn: reopenClosedTab },
    '-',
    { label: '방문 기록                    Ctrl+H', fn: openHistory },
    { label: '북마크 바 보이기/숨기기  Ctrl+Shift+B', fn: () => ui.shortcut('toggle-bookmarks') },
    { label: '페이지에서 찾기            Ctrl+F', fn: openFind },
    '-',
    { label: '확대                            Ctrl++', fn: () => stepZoom(1) },
    { label: '축소                            Ctrl+-', fn: () => stepZoom(-1) },
    { label: '전체 화면                     F11', fn: () => jamApp.toggleFullscreen() },
    { label: 'Jam 패널                     Ctrl+J', fn: () => typeof togglePanel === 'function' && togglePanel() },
    '-',
    { label: '설정 · 꾸미기               Ctrl+,', fn: openSettings },
    { label: updateMenuLabel(), fn: () => (lastUpdate.state === 'ready' ? jamApp.installUpdate() : checkForUpdate()) },
  ]);
});

// ======================================================================
// 자동 업데이트 알림
// ======================================================================
let lastUpdate = { state: 'idle' };
let manualCheck = false; // 메뉴에서 직접 누른 확인만 "최신이에요" 알림을 띄운다
function updateMenuLabel() {
  if (lastUpdate.state === 'ready') return `재시작해서 ${lastUpdate.version} 로 업데이트`;
  if (lastUpdate.state === 'downloading') return `업데이트 받는 중… ${lastUpdate.percent || 0}%`;
  return '업데이트 확인';
}
function checkForUpdate() {
  jamApp.appInfo().then((info) => {
    if (!info.packaged) return toast('개발 실행(npm start)에서는 자동 업데이트가 꺼져 있어요');
    manualCheck = true;
    toast('업데이트를 확인하고 있어요…');
    jamApp.checkUpdate();
  });
}
jamApp.onUpdate((s) => {
  const prev = lastUpdate.state;
  lastUpdate = s;
  if (s.state === 'downloading' && prev !== 'downloading') toast(`⬇ 새 버전 ${s.version} 을(를) 받고 있어요`);
  if (s.state === 'ready') {
    toast(`✅ 새 버전 ${s.version} 준비 완료 · 앱을 다시 켜면 적용돼요`, [{ label: '지금 재시작', fn: () => jamApp.installUpdate() }]);
  }
  if (s.state === 'latest' && prev === 'checking' && manualCheck) toast(`최신 버전(${s.version})이에요`);
  if (s.state === 'error' && manualCheck) toast('업데이트 확인에 실패했어요');
  if (s.state !== 'checking') manualCheck = false;
  renderVersion();
});
function renderVersion() {
  jamApp.appInfo().then((info) => {
    const st = { ready: '· 재시작하면 업데이트', downloading: '· 업데이트 받는 중', latest: '· 최신 버전', error: '· 업데이트 확인 실패' }[lastUpdate.state] || '';
    $('#app-version').textContent = `Jam Browser ${info.version} ${info.packaged ? st : '(개발 실행)'}`;
  });
}

// ======================================================================
// 설정 화면
// ======================================================================
function bindSetting(id, key, { type = 'value', after } = {}) {
  const input = $(id);
  const read = () => (type === 'checked' ? input.checked : type === 'number' ? Number(input.value) : input.value);
  const write = () => {
    if (type === 'checked') input.checked = !!settings[key];
    else input.value = settings[key];
  };
  write();
  input.addEventListener(type === 'value' && input.tagName === 'INPUT' && input.type === 'text' ? 'change' : 'input', () => {
    settings[key] = read();
    saveSettings();
    applyLook();
    after?.();
  });
  return write;
}

const writers = [];
function setupSettings() {
  const segs = document.querySelectorAll('[data-setting]');
  for (const seg of segs) {
    const key = seg.dataset.setting;
    const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(settings[key])));
    seg.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        settings[key] = b.dataset.value;
        saveSettings();
        applyLook();
        sync();
        renderStartPage();
      })
    );
    writers.push(sync);
  }
  writers.push(bindSetting('#set-accent', 'accent'));
  writers.push(bindSetting('#set-accent-page', 'accentFromPage', { type: 'checked' }));
  writers.push(bindSetting('#set-radius', 'radius', { type: 'number' }));
  writers.push(bindSetting('#set-bookmarks-bar', 'showBookmarksBar', { type: 'checked' }));
  writers.push(bindSetting('#set-home-btn', 'showHomeButton', { type: 'checked' }));
  writers.push(bindSetting('#set-minimap', 'showMinimap', { type: 'checked' }));
  writers.push(bindSetting('#set-restore', 'restoreSession', { type: 'checked' }));
  writers.push(bindSetting('#set-home-url', 'homeUrl'));
  writers.push(bindSetting('#set-engine', 'searchEngine', { after: renderStartPage }));
  writers.push(bindSetting('#set-user-css', 'userCss'));

  document.querySelectorAll('.swatch').forEach((s) =>
    s.addEventListener('click', () => {
      settings.accent = s.dataset.color;
      settings.accentFromPage = false;
      saveSettings();
      applyLook();
      writers.forEach((w) => w());
    })
  );
  $('#preset-row').replaceChildren(
    ...Object.entries(PRESETS).map(([, p]) =>
      el('button', {
        class: 'secondary-btn small-btn',
        onclick: () => {
          Object.assign(settings, p.set);
          saveSettings();
          applyLook();
          writers.forEach((w) => w());
          renderStartPage();
          toast(`${p.label}로 바꿨어요`);
        },
      }, p.label)
    )
  );
  $('#site-css-add').addEventListener('click', () => {
    const site = $('#site-css-site').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const css = $('#site-css-text').value;
    if (!site || !css.trim()) return toast('사이트와 CSS를 입력하세요');
    settings.siteCss = settings.siteCss.filter((r) => r.site !== site).concat({ site, css });
    saveSettings();
    $('#site-css-site').value = '';
    $('#site-css-text').value = '';
    renderSiteCss();
    for (const t of tabs) if (t.ready && isWebUrl(t.url)) t.webview.reload();
    toast(`${site} 꾸미기를 저장했어요`);
  });
  $('#site-css-current').addEventListener('click', () => {
    if (activeTab && isWebUrl(activeTab.url)) $('#site-css-site').value = siteOf(activeTab.url);
  });
  $('#settings-export').addEventListener('click', async () => {
    await jamApp.copy(JSON.stringify({ settings, bookmarks }, null, 2));
    toast('설정과 북마크를 클립보드에 복사했어요');
  });
  $('#settings-import').addEventListener('click', () => {
    const text = prompt('내보낸 설정(JSON)을 붙여 넣으세요');
    if (!text) return;
    try {
      const data = JSON.parse(text);
      if (data.settings && typeof data.settings === 'object') {
        for (const k of Object.keys(DEFAULTS)) if (k in data.settings) settings[k] = data.settings[k];
      }
      if (Array.isArray(data.bookmarks)) bookmarks = data.bookmarks.filter((b) => b && isWebUrl(b.url)).map((b) => ({ url: b.url, title: String(b.title || '') }));
      saveSettings();
      saveBookmarks();
      applyLook();
      writers.forEach((w) => w());
      renderBookmarks();
      renderSiteCss();
      toast('설정을 가져왔어요');
    } catch {
      toast('형식이 올바르지 않아요');
    }
  });
  $('#settings-reset').addEventListener('click', () => {
    if (!confirm('모양·검색 설정을 기본값으로 되돌릴까요? (북마크와 기록은 그대로)')) return;
    Object.assign(settings, { ...DEFAULTS, zoom: settings.zoom, siteCss: settings.siteCss });
    saveSettings();
    applyLook();
    writers.forEach((w) => w());
  });
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  document.querySelectorAll('.set-nav button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.set-nav button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.set-page').forEach((p) => (p.hidden = p.id !== b.dataset.page));
    })
  );
}

function renderSiteCss() {
  $('#site-css-list').replaceChildren(
    ...(settings.siteCss.length
      ? settings.siteCss.map((r) =>
          el(
            'li',
            {},
            el('b', {}, r.site),
            el('code', {}, r.css.length > 80 ? r.css.slice(0, 80) + '…' : r.css),
            el('button', {
              class: 'mini-btn danger',
              onclick: () => {
                settings.siteCss = settings.siteCss.filter((x) => x !== r);
                saveSettings();
                renderSiteCss();
              },
            }, '삭제')
          )
        )
      : [el('li', { class: 'muted small' }, '아직 없어요')])
  );
}

function renderBookmarkManager() {
  const box = $('#bm-manage');
  if (!box) return;
  box.replaceChildren(
    ...(bookmarks.length
      ? bookmarks.map((b, i) =>
          el(
            'li',
            {},
            el('img', { src: faviconFor(b.url), alt: '' }),
            el('input', {
              type: 'text',
              value: b.title,
              onchange: (e) => {
                b.title = e.target.value;
                saveBookmarks();
                renderBookmarks();
              },
            }),
            el('button', { class: 'mini-btn', disabled: i === 0, onclick: () => { bookmarks.splice(i - 1, 0, bookmarks.splice(i, 1)[0]); saveBookmarks(); renderBookmarks(); } }, '↑'),
            el('button', { class: 'mini-btn danger', onclick: () => removeBookmark(b.url) }, '삭제')
          )
        )
      : [el('li', { class: 'muted small' }, '북마크가 없어요')])
  );
}

function openSettings() {
  writers.forEach((w) => w());
  renderSiteCss();
  renderBookmarkManager();
  $('#settings-dialog').showModal();
}

// ======================================================================
// 시작
// ======================================================================
ui.boot = () => {
  setupSettings();
  applyLook();
  renderBookmarks();
  renderVersion();
  const session = settings.restoreSession ? load('jam-session', []) : [];
  if (session.length) {
    for (const s of session) {
      const t = createTab(s.url || START_URL, { activate: false });
      t.pinned = !!s.pinned;
    }
    sortPinned();
    activateTab(tabs[0]);
  } else {
    createTab(ui.newTabUrl());
  }
};
