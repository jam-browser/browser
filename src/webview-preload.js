'use strict';
/**
 * 각 웹페이지 안에서 실행되는 스크립트 (페이지 JS와는 분리된 격리 환경)
 *  - 내 화면 영역(뷰포트) / 스크롤 / 마우스 / 클릭 / 동영상 상태를 앱(host)으로 보낸다
 *  - 다른 참여자의 커서, 보고 있는 영역(색 사각형 + 해상도), 클릭 표시를 페이지 위에 그린다
 *  - 다른 사이트 이동 권한이 없으면 다른 사이트로 가는 링크를 잠근다
 *  - 동영상 재생 위치를 맞춘다 (유튜브 광고 중에는 맞추지 않고, 광고가 끝나면 따라간다)
 *
 * 페이지의 CSP / Trusted Types에 막히지 않도록 innerHTML, <style> 없이 DOM API와 인라인 스타일만 쓴다.
 */
const { ipcRenderer, webFrame } = require('electron');

const send = (channel, data) => ipcRenderer.sendToHost(channel, data);

// ======================================================================
// 클립보드 감시: 사이트가 클립보드에 무언가를 넣으면 앱에 알린다
//  (가짜 "인증" 화면이 명령어를 복사시킨 뒤 Win+R 에 붙여넣게 하는 수법 대비)
// ======================================================================
// 페이지 쪽(main world)의 복사 함수를 감싸서, 호출되면 DOM 이벤트로 알려준다
webFrame
  .executeJavaScript(`(() => {
    if (window.__jamClipboardHooked) return; window.__jamClipboardHooked = true;
    const fire = (kind, text) => { try { document.dispatchEvent(new CustomEvent('__jam_clipboard__', { detail: JSON.stringify({ kind, text: typeof text === 'string' ? text.slice(0, 4000) : null }) })); } catch (e) {} };
    const c = navigator.clipboard;
    if (c && c.writeText) { const wt = c.writeText.bind(c); c.writeText = function (t) { fire('writeText', String(t)); return wt(t); }; }
    if (c && c.write) { const w = c.write.bind(c); c.write = function (items) { fire('write', null); return w(items); }; }
    const ex = Document.prototype.execCommand;
    Document.prototype.execCommand = function (cmd) { const k = String(cmd).toLowerCase(); if (k === 'copy' || k === 'cut') fire('execCommand', null); return ex.apply(this, arguments); };
  })()`)
  .catch(() => {});

function reportClipboard(kind, text) {
  const selection = String(window.getSelection ? window.getSelection() : '').slice(0, 4000);
  // 실제로 클립보드에 써진 뒤에 확인하도록 조금 기다린다
  setTimeout(() => send('jam:clipboard', { kind, text, selection }), 150);
}
document.addEventListener('__jam_clipboard__', (e) => {
  try {
    const d = JSON.parse(e.detail);
    reportClipboard(d.kind, d.text);
  } catch {}
});
// Ctrl+C 나 페이지의 copy 이벤트 → 앱이 "내가 선택한 글자와 클립보드 내용이 같은지" 비교한다
document.addEventListener('copy', () => reportClipboard('copy-event', null), true);
document.addEventListener('cut', () => reportClipboard('copy-event', null), true);

// 접속했을 때: 페이지 안에 클립보드 복사 코드가 있는지 훑어본다 (외부 스크립트는 위의 감시로 잡는다)
function scanForClipboardCode() {
  const re = /clipboard\s*\.\s*write(Text)?\s*\(|execCommand\s*\(\s*['"](copy|cut)['"]/i;
  for (const s of document.querySelectorAll('script:not([src])')) {
    if (re.test(s.textContent || '')) return send('jam:clipboard-site', { where: 'script' });
  }
  for (const el of document.querySelectorAll('[onclick],[onmousedown],[onmouseup],[onkeydown]')) {
    for (const attr of ['onclick', 'onmousedown', 'onmouseup', 'onkeydown']) {
      if (re.test(el.getAttribute(attr) || '')) return send('jam:clipboard-site', { where: 'attribute' });
    }
  }
}
window.addEventListener('load', () => setTimeout(scanForClipboardCode, 500));

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, wait);
    }
  };
}

// shared/site.js 의 siteOf 와 같은 규칙 (샌드박스라 파일을 불러올 수 없어 복사)
const SECOND_LEVEL = new Set(['co', 'or', 'go', 'ac', 'ne', 're', 'pe', 'com', 'net', 'org', 'gov', 'edu', 'mil']);
function siteOf(u) {
  let host;
  try {
    const p = new URL(u, location.href);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    host = p.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = parts.length;
  const take = parts[n - 1].length === 2 && SECOND_LEVEL.has(parts[n - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

const docEl = () => document.scrollingElement || document.documentElement;
const docSize = () => {
  const el = docEl();
  return { w: Math.max(el.scrollWidth, 1), h: Math.max(el.scrollHeight, 1) };
};

function css(el, styles) {
  for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, 'important');
  return el;
}

// ======================================================================
// 앵커: 해상도·창 크기·확대 배율이 달라도 "같은 내용"을 가리키기 위한 좌표
//  - 화면의 한 점을 "그 점에 있는 페이지 요소(경로) + 요소 안에서의 위치(비율)"로 표현한다
//  - 받는 쪽은 자기 화면에서 같은 요소를 찾아 위치를 계산한다 (글줄이 다르게 접혀도 같은 내용을 가리킴)
//  - 요소를 못 찾으면 문서 전체 대비 비율(fallback)을 쓴다
// ======================================================================
function pathOf(el) {
  const parts = [];
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + el.id).length === 1) {
      parts.unshift('#' + el.id);
      break;
    }
    let i = 1;
    let sib = el;
    while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
    parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${i})`);
    el = el.parentElement;
  }
  return parts.join('>');
}

function isPinned(el) {
  // 화면에 고정된 요소(상단 고정 메뉴 등)는 스크롤 위치를 나타내지 못하므로 제외
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const pos = getComputedStyle(e).position;
    if (pos === 'fixed' || pos === 'sticky') return true;
  }
  return false;
}

function anchorAt(x, y, { skipPinned = false } = {}) {
  let el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement || el === document.body) return null;
  if (skipPinned && isPinned(el)) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const p = pathOf(el);
  if (!p || p.length > 600) return null;
  return { p, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
}

// 앵커 → 내 문서 좌표 (px). 못 찾으면 null
function resolveAnchor(a) {
  if (!a || typeof a.p !== 'string') return null;
  let el;
  try {
    el = document.querySelector(a.p);
  } catch {
    return null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return null;
  return { x: r.left + window.scrollX + a.fx * r.width, y: r.top + window.scrollY + a.fy * r.height };
}

// 내 화면 위/아래 가장자리를 가리키는 앵커 (가운데 열에서 고정 메뉴를 피해 찾는다)
function edgeAnchor(edge) {
  const xs = [0.5, 0.35, 0.65, 0.2, 0.8].map((f) => window.innerWidth * f);
  for (let step = 0; step < 12; step++) {
    const off = 4 + step * 24;
    const y = edge === 'top' ? off : window.innerHeight - off;
    if (y < 0 || y > window.innerHeight) break;
    for (const x of xs) {
      const a = anchorAt(x, y, { skipPinned: true });
      if (a) return { ...a, off: edge === 'top' ? off : window.innerHeight - y };
    }
  }
  return null;
}

// ======================================================================
// 내 화면 영역 / 스크롤
// ======================================================================
let suppressScrollUntil = 0;

function viewport(user) {
  const el = docEl();
  const { w: W, h: H } = docSize();
  const maxX = el.scrollWidth - window.innerWidth;
  const maxY = el.scrollHeight - window.innerHeight;
  return {
    sx: maxX > 0 ? window.scrollX / maxX : 0, // 비율 (앵커를 못 쓸 때 대비)
    sy: maxY > 0 ? window.scrollY / maxY : 0,
    vx: window.scrollX / W,
    vy: window.scrollY / H,
    vw: Math.min(window.innerWidth / W, 1),
    vh: Math.min(window.innerHeight / H, 1),
    top: edgeAnchor('top'), // 내 화면 맨 위에 보이는 내용
    bot: edgeAnchor('bottom'), // 내 화면 맨 아래에 보이는 내용
    w: window.innerWidth, // 내 화면 해상도 (CSS 픽셀)
    h: window.innerHeight,
    z: Math.round(window.devicePixelRatio * 100) / 100, // 확대 배율 × 화면 배율
    user,
  };
}

let lastViewKey = '';
function sendViewport(user) {
  const v = viewport(user);
  const key = JSON.stringify([v.top, v.bot, v.vy, v.w, v.h, v.z]);
  if (!user && key === lastViewKey) return;
  lastViewKey = key;
  send('jam:viewport', v);
}

// "내가 직접 스크롤했는지"는 실제 입력(휠·키보드·스크롤바 클릭·터치)이 방금 있었는지로 판단한다.
// (시간만 보면, 따라가기 자동 스크롤과 내 스크롤이 겹칠 때 내 스크롤을 놓친다)
let lastUserInput = 0;
for (const type of ['wheel', 'keydown', 'mousedown', 'touchstart', 'touchmove']) {
  window.addEventListener(type, (e) => e.isTrusted && (lastUserInput = Date.now()), { capture: true, passive: true });
}
const isUserScroll = () => Date.now() - lastUserInput < 1000 && Date.now() >= suppressScrollUntil;

window.addEventListener('scroll', throttle(() => sendViewport(isUserScroll()), 100), { passive: true });
window.addEventListener('resize', throttle(() => sendViewport(false), 200));
window.addEventListener('DOMContentLoaded', () => sendViewport(false));
// 무한 스크롤 등으로 문서 길이가 바뀌는 경우
setInterval(() => sendViewport(false), 1500);

// 상대의 "화면 맨 위 내용"이 내 화면 맨 위에 오도록 스크롤 (못 찾으면 비율로)
function scrollToAnchor(top, x, y, behavior) {
  const el = docEl();
  suppressScrollUntil = Date.now() + (behavior === 'smooth' ? 900 : 400);
  const pos = resolveAnchor(top);
  window.scrollTo({
    left: x * Math.max(el.scrollWidth - window.innerWidth, 0),
    top: pos ? pos.y - (top.off || 0) : y * Math.max(el.scrollHeight - window.innerHeight, 0),
    behavior,
  });
}
ipcRenderer.on('jam:scroll-to', (_e, { x, y, top }) => scrollToAnchor(top, x, y, 'instant'));
// 사람 따라가기: 상대 화면 맨 위 내용이 내 화면 맨 위에 오도록 계속 맞춘다
ipcRenderer.on('jam:follow-view', (_e, d) => scrollToAnchor(d.top, 0, d.vy / Math.max(1 - (d.vh || 0), 0.0001), 'instant'));
// 다른 사람이 보는 곳으로 내 화면 옮기기 (나만 이동, 다른 사람에게 퍼지지 않음)
ipcRenderer.on('jam:scroll-to-view', (_e, v) => {
  const view = views_.get(v.id);
  const d = view ? view.data : v;
  scrollToAnchor(d.top, 0, d.vy / Math.max(1 - (d.vh || 0), 0.0001), 'smooth');
});

// ======================================================================
// 내 커서 / 클릭 (창 밖으로 나가면 숨김)
// ======================================================================
let pointerInside = false;
const sendCursor = throttle((e) => {
  const { w, h } = docSize();
  send('jam:cursor', { x: e.pageX / w, y: e.pageY / h, a: anchorAt(e.clientX, e.clientY) });
}, 40);
const hideCursor = () => {
  if (!pointerInside) return;
  pointerInside = false;
  send('jam:cursor', null);
};

document.addEventListener(
  'mousemove',
  (e) => {
    pointerInside = true;
    sendCursor(e);
  },
  { passive: true, capture: true }
);
document.addEventListener('mouseout', (e) => !e.relatedTarget && hideCursor(), { capture: true });
document.addEventListener('mouseleave', hideCursor, { capture: true });
window.addEventListener('blur', hideCursor);
document.addEventListener('visibilitychange', () => document.hidden && hideCursor());
window.addEventListener('pagehide', hideCursor);

document.addEventListener(
  'mousedown',
  (e) => {
    const { w, h } = docSize();
    send('jam:click', { x: e.pageX / w, y: e.pageY / h, a: anchorAt(e.clientX, e.clientY) });
  },
  { capture: true, passive: true }
);

// ======================================================================
// 오버레이 레이어 (다른 사람 커서 / 화면 사각형 / 클릭 / 잠금 안내)
// ======================================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
let layer = null;

function getLayer() {
  if (layer && layer.host.isConnected) return layer;
  const host = css(document.createElement('jam-presence'), {
    position: 'absolute', top: '0', left: '0', width: '0', height: '0', overflow: 'visible',
    'z-index': '2147483647', 'pointer-events': 'none', display: 'block',
  });
  const root = host.attachShadow({ mode: 'closed' });
  const views = document.createElement('div'); // 사각형은 커서 아래에
  const cursorsBox = document.createElement('div');
  root.append(views, cursorsBox);
  (document.body || document.documentElement).appendChild(host);
  layer = { host, root, views, cursorsBox };
  if (typeof applyMirrorLayer === 'function') applyMirrorLayer();
  // 레이어가 새로 만들어지면 (페이지가 body를 갈아끼운 경우) 기존 요소를 다시 붙인다
  for (const c of cursors.values()) cursorsBox.appendChild(c.el);
  for (const v of views_.values()) views.appendChild(v.el);
  return layer;
}

// ---------- 다른 사람 커서 ----------
const cursors = new Map();

function buildCursor() {
  const el = css(document.createElement('div'), {
    position: 'absolute', left: '0', top: '0', transition: 'transform 80ms linear', 'will-change': 'transform',
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '22');
  svg.setAttribute('viewBox', '0 0 18 22');
  css(svg, { display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' });
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1 1 L1 17 L5.5 13 L8.5 20.5 L11.5 19.2 L8.6 12 L15 12 Z');
  path.setAttribute('stroke', '#fff');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  const label = css(document.createElement('div'), {
    position: 'absolute', left: '14px', top: '16px', padding: '2px 8px', 'border-radius': '10px',
    font: '600 12px/1.4 "Segoe UI","Malgun Gothic",sans-serif', color: '#111', 'white-space': 'nowrap',
    'box-shadow': '0 1px 3px rgba(0,0,0,.3)',
  });
  el.append(svg, label);
  return { el, path, label, data: null };
}

function layoutCursor(c) {
  const { w, h } = docSize();
  const pos = resolveAnchor(c.data.a) || { x: c.data.x * w, y: c.data.y * h };
  c.pos = pos;
  css(c.el, { transform: `translate(${pos.x}px, ${pos.y}px)` });
}

function upsertCursor(data) {
  const { cursorsBox } = getLayer();
  let c = cursors.get(data.id);
  if (!c) {
    c = buildCursor();
    cursors.set(data.id, c);
  }
  if (!c.el.isConnected) cursorsBox.appendChild(c.el);
  c.data = data;
  c.path.setAttribute('fill', data.color);
  c.label.textContent = data.name;
  css(c.label, { background: data.color });
  layoutCursor(c);
}

function removeCursor(id) {
  const c = cursors.get(id);
  if (!c) return;
  c.el.remove();
  cursors.delete(id);
}

// ---------- 다른 사람이 보고 있는 영역 (사각형 + 해상도) ----------
const views_ = new Map();

function buildView() {
  const el = css(document.createElement('div'), {
    position: 'absolute', 'box-sizing': 'border-box', 'border-radius': '8px', 'border-width': '2px',
    'border-style': 'solid', transition: 'left 120ms, top 120ms, width 120ms, height 120ms',
  });
  const label = css(document.createElement('div'), {
    position: 'absolute', left: '-2px', top: '-2px', padding: '2px 8px', 'border-radius': '8px 0 8px 0',
    font: '600 11px/1.5 "Segoe UI","Malgun Gothic",sans-serif', color: '#111', 'white-space': 'nowrap',
  });
  el.appendChild(label);
  return { el, label, data: null };
}

function layoutView(v) {
  const { w, h } = docSize();
  const d = v.data;
  // 세로: 상대 화면 맨 위/맨 아래에 보이던 내용이 내 문서의 어디인지로 계산
  const t = resolveAnchor(d.top);
  const b = resolveAnchor(d.bot);
  let top = d.vy * h;
  let height = d.vh * h;
  if (t && b && b.y > t.y) {
    top = t.y - (d.top.off || 0);
    height = b.y + (d.bot.off || 0) - top;
  } else if (t) {
    top = t.y - (d.top.off || 0);
  } else if (b) {
    top = b.y + (d.bot.off || 0) - height;
  }
  // 가로: 상대에게 가로 스크롤이 없으면 페이지 전체 폭을 보고 있는 것
  const fullWidth = d.vw >= 0.99;
  const left = fullWidth ? 0 : d.vx * w;
  const width = fullWidth ? w : d.vw * w;
  v.pos = { top, height, left, width };
  css(v.el, {
    left: `${left}px`, top: `${top}px`,
    width: `${Math.max(width, 40)}px`, height: `${Math.max(height, 30)}px`,
  });
  // 미니맵이 내 문서 기준 위치를 쓰도록 앱에 알려준다
  const key = [top, height].map(Math.round).join(',');
  if (v.posKey !== key) {
    v.posKey = key;
    send('jam:view-pos', { id: d.id, vx: left / w, vy: top / h, vw: Math.min(width / w, 1), vh: Math.min(height / h, 1) });
  }
}

function upsertView(data) {
  const { views } = getLayer();
  let v = views_.get(data.id);
  if (!v) {
    v = buildView();
    views_.set(data.id, v);
  }
  if (!v.el.isConnected) views.appendChild(v.el);
  v.data = data;
  css(v.el, { 'border-color': data.color, background: `${data.color}14` });
  css(v.label, { background: data.color });
  v.label.textContent = `${data.name} · ${data.w}×${data.h}${data.z && data.z !== 1 ? ` · ${Math.round(data.z * 100)}%` : ''}`;
  layoutView(v);
}

function removeView(id) {
  const v = views_.get(id);
  if (!v) return;
  v.el.remove();
  views_.delete(id);
}

// 창 크기나 문서 길이가 바뀌면 비율 기준으로 다시 배치
const relayout = () => {
  for (const c of cursors.values()) layoutCursor(c);
  for (const v of views_.values()) layoutView(v);
};
window.addEventListener('resize', throttle(relayout, 100));
setInterval(relayout, 1500);

ipcRenderer.on('jam:cursor', (_e, data) => upsertCursor(data));
ipcRenderer.on('jam:cursor-remove', (_e, id) => removeCursor(id));
ipcRenderer.on('jam:view', (_e, data) => upsertView(data));
ipcRenderer.on('jam:view-remove', (_e, id) => removeView(id));
ipcRenderer.on('jam:clear', () => {
  for (const id of [...cursors.keys()]) removeCursor(id);
  for (const id of [...views_.keys()]) removeView(id);
  locked = false;
});
// 테스트용: 다른 사람 사각형/커서가 내 문서의 어디에 그려졌는지 알려준다
ipcRenderer.on('jam:debug-req', () => {
  send('jam:debug', {
    views: [...views_.entries()].map(([id, v]) => ({ id, ...v.pos })),
    cursors: [...cursors.entries()].map(([id, c]) => ({ id, ...c.pos })),
    scrollY: window.scrollY,
  });
});

ipcRenderer.on('jam:click', (_e, { color, x, y, a }) => {
  const { root } = getLayer();
  const { w, h } = docSize();
  const pos = resolveAnchor(a) || { x: x * w, y: y * h };
  const p = css(document.createElement('div'), {
    position: 'absolute', left: `${pos.x}px`, top: `${pos.y}px`, width: '28px', height: '28px',
    margin: '-14px 0 0 -14px', 'border-radius': '50%', border: `3px solid ${color}`, 'box-sizing': 'border-box',
  });
  root.appendChild(p);
  p.animate(
    [
      { transform: 'scale(.3)', opacity: 1 },
      { transform: 'scale(1.8)', opacity: 0 },
    ],
    { duration: 700, easing: 'ease-out', fill: 'forwards' }
  );
  setTimeout(() => p.remove(), 750);
});

// ======================================================================
// 다른 사이트로 가는 링크 잠금 (권한이 없을 때)
// ======================================================================
let locked = false;
ipcRenderer.on('jam:policy', (_e, p) => {
  locked = !!p.locked;
});

function blockedLink(target) {
  if (!locked) return null;
  const a = target && target.closest ? target.closest('a[href]') : null;
  if (!a || a.target === '_blank') return null; // 새 탭(개인 탭)으로 여는 건 허용
  const s = siteOf(a.href);
  if (!s || s === siteOf(location.href)) return null;
  return a;
}

let tip = null;
function showTip(x, y) {
  const { root } = getLayer();
  if (!tip) {
    tip = css(document.createElement('div'), {
      position: 'absolute', padding: '5px 10px', 'border-radius': '8px', background: 'rgba(20,20,20,.92)',
      color: '#fff', font: '600 12px/1.4 "Segoe UI","Malgun Gothic",sans-serif', 'white-space': 'nowrap',
      'box-shadow': '0 4px 14px rgba(0,0,0,.3)',
    });
    tip.textContent = '🔒 다른 사이트 이동은 호스트의 권한이 필요해요';
  }
  if (!tip.isConnected) root.appendChild(tip);
  css(tip, { left: `${x + 14}px`, top: `${y + 18}px` });
}
const hideTip = () => tip && tip.remove();

document.addEventListener(
  'mouseover',
  (e) => {
    const a = blockedLink(e.target);
    if (!a) return;
    if (!a.dataset.jamCursor) a.dataset.jamCursor = a.style.cursor || 'unset';
    a.style.setProperty('cursor', 'not-allowed', 'important');
  },
  { capture: true, passive: true }
);
document.addEventListener(
  'mousemove',
  (e) => {
    if (blockedLink(e.target)) showTip(e.pageX, e.pageY);
    else hideTip();
  },
  { capture: true, passive: true }
);
document.addEventListener(
  'click',
  (e) => {
    const a = blockedLink(e.target);
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send('jam:blocked', a.href);
  },
  { capture: true }
);

// ======================================================================
// 동영상 재생 맞추기 (+ 유튜브 광고 예외)
// ======================================================================
let video = null;
let adShowing = false;
let ignoreLocalUntil = 0; // 이 시간 전에는 내 쪽 재생 이벤트를 보내지 않는다 (동기화로 생긴 이벤트, 자동재생 등)
let localTimer = null;
let initTimer = null;
const MEDIA_EVENTS = ['play', 'pause', 'seeked', 'ratechange'];

function isAd() {
  return !!document.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting');
}

function pickVideo() {
  let best = null;
  let bestArea = 40000; // 너무 작은 미리보기 영상은 무시
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

const mediaState = () => ({ playing: !video.paused && !video.ended, time: video.currentTime, rate: video.playbackRate });

function onLocalMedia() {
  if (Date.now() < ignoreLocalUntil) return;
  clearTimeout(localTimer);
  // 광고가 막 시작될 때의 이벤트를 걸러내려고 잠깐 기다렸다가 다시 확인한다
  localTimer = setTimeout(() => {
    if (!video || adShowing || isAd() || Date.now() < ignoreLocalUntil) return;
    send('jam:media', mediaState());
  }, 350);
}

function attachVideo(v) {
  if (video) MEDIA_EVENTS.forEach((ev) => video.removeEventListener(ev, onLocalMedia));
  video = v;
  clearTimeout(initTimer);
  if (!v) return;
  MEDIA_EVENTS.forEach((ev) => v.addEventListener(ev, onLocalMedia));
  // 새 영상: 자동재생 이벤트는 무시하고, 앱에 "Jam 재생 위치 알려줘" 요청
  ignoreLocalUntil = Date.now() + 2000;
  send('jam:media-ready');
  initTimer = setTimeout(() => {
    if (video === v && !adShowing && !isAd()) send('jam:media-init', mediaState());
  }, 2200);
}

setInterval(() => {
  const v = pickVideo();
  if (v !== video) attachVideo(v);
  const ad = !!video && isAd();
  if (ad !== adShowing) {
    adShowing = ad;
    send('jam:ad', ad);
    if (!ad && video) {
      // 광고가 끝나면 유튜브가 영상을 다시 트는 이벤트는 무시하고, Jam 재생 위치로 따라간다
      ignoreLocalUntil = Date.now() + 1500;
      send('jam:media-ready');
    }
  }
  if (video && !adShowing && !video.paused) send('jam:media-tick', mediaState());
}, 1000);

ipcRenderer.on('jam:media-apply', (_e, s) => {
  if (!video || adShowing || isAd()) return; // 광고 중이면 무시 → 광고가 끝나면 media-ready로 다시 받는다
  ignoreLocalUntil = Date.now() + 800;
  const tolerance = s.playing ? 1.0 : 0.3;
  if (Math.abs(video.currentTime - s.time) > tolerance) video.currentTime = s.time;
  if (s.rate && video.playbackRate !== s.rate) video.playbackRate = s.rate;
  if (s.playing && video.paused) video.play().catch(() => {});
  if (!s.playing && !video.paused) video.pause();
});

// ======================================================================
// 비밀번호 뱅크: 로그인 칸 찾기 · 🔑 버튼 · 직접 눌렀을 때만 채우기 · 저장 제안
//  - 메인 프로세스와 바로 주고받고, 앱 화면에는 비밀번호가 가지 않는다
//  - 채우기는 지금 사이트와 저장된 사이트의 출처(https://host:port)가 정확히 같을 때만 (메인이 확인)
//  - 진짜 사용자 클릭(isTrusted)일 때만 채운다 → 페이지가 몰래 채우게 만들 수 없음
// ======================================================================
let pwFields = null; // { pw, user, form }
let pwState = { unlocked: false, locked: false, accounts: [] };
let pwBubble = null;
let pwMenu = null;
let lastCaptureKey = '';
let lastCaptureAt = 0;

const isVisible = (el) => {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
};

function findLoginFields() {
  const pw = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
  if (!pw) return null;
  const scope = pw.form || pw.closest('form') || document;
  const before = [...scope.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')]
    .filter((i) => isVisible(i) && i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  return { pw, user: before.pop() || null, form: pw.form || pw.closest('form') };
}

function setFieldValue(el, value) {
  if (!el) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value); // React 같은 프레임워크도 값이 바뀐 걸 알게
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function hidePwUi() {
  if (pwBubble) pwBubble.remove();
  if (pwMenu) pwMenu.remove();
  const had = !!pwMenu;
  pwMenu = null;
  if (had && typeof reportFocus === 'function') setTimeout(reportFocus, 0);
}

function showPwBubble() {
  hidePwUi();
  if (!pwFields || !isVisible(pwFields.pw)) return;
  const n = pwState.accounts.length;
  if (!n && !pwState.locked) return; // 저장된 게 없으면 조용히
  const { root } = getLayer();
  const r = pwFields.pw.getBoundingClientRect();
  pwBubble = css(document.createElement('div'), {
    position: 'absolute', left: `${r.right + window.scrollX - 30}px`, top: `${r.top + window.scrollY + (r.height - 24) / 2}px`,
    width: '24px', height: '24px', 'border-radius': '6px', background: '#2ee6a6', color: '#062a1f',
    display: 'grid', 'place-items': 'center', font: '14px/1 "Segoe UI Emoji",sans-serif', cursor: 'pointer',
    'pointer-events': 'auto', 'box-shadow': '0 1px 4px rgba(0,0,0,.35)',
  });
  pwBubble.textContent = pwState.locked ? '🔒' : '🔑';
  pwBubble.title = pwState.locked ? 'Jam Browser 계정이 잠겨 있어요 (잠금을 풀면 저장된 로그인을 쓸 수 있어요)' : `저장된 로그인 ${n}개`;
  pwBubble.addEventListener('mousedown', (e) => e.preventDefault(), true);
  pwBubble.addEventListener('click', (e) => {
    if (!e.isTrusted || pwState.locked) return;
    e.preventDefault();
    e.stopPropagation();
    showPwMenu();
  });
  root.appendChild(pwBubble);
}

function showPwMenu() {
  if (pwMenu) pwMenu.remove();
  const { root } = getLayer();
  const r = pwFields.pw.getBoundingClientRect();
  pwMenu = css(document.createElement('div'), {
    position: 'absolute', left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY + 4}px`, 'min-width': `${Math.max(200, r.width)}px`,
    background: '#1b1b1b', color: '#f2f2f2', 'border-radius': '8px', padding: '4px', 'box-shadow': '0 8px 24px rgba(0,0,0,.4)',
    font: '13px/1.4 "Segoe UI","Malgun Gothic",sans-serif', 'pointer-events': 'auto',
  });
  const head = css(document.createElement('div'), { padding: '4px 8px', color: '#a7a7a7', 'font-size': '11px' });
  head.textContent = 'Jam Browser 비밀번호 뱅크';
  pwMenu.appendChild(head);
  for (const acc of pwState.accounts) {
    const item = css(document.createElement('div'), { padding: '7px 10px', 'border-radius': '6px', cursor: 'pointer' });
    item.textContent = `🔑 ${acc.username || '(아이디 없음)'}`;
    item.addEventListener('mouseenter', () => css(item, { background: '#2e2e2e' }));
    item.addEventListener('mouseleave', () => css(item, { background: 'transparent' }));
    item.addEventListener('mousedown', (e) => e.preventDefault(), true);
    item.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send('pw:fill-request', { id: acc.id });
      hidePwUi();
    });
    pwMenu.appendChild(item);
  }
  root.appendChild(pwMenu);
  if (typeof reportFocus === 'function') reportFocus(); // 미러링 중이면 영상을 잠시 멈추도록
}

document.addEventListener('mousedown', (e) => {
  // 닫힌 shadow 안의 요소는 document 쪽에서 보면 host 로만 보인다 → host 를 눌렀으면 메뉴(또는 🔑) 안쪽
  if (pwMenu && e.target !== layer?.host) {
    pwMenu.remove();
    pwMenu = null;
    if (typeof reportFocus === 'function') setTimeout(reportFocus, 0);
  }
}, true);

ipcRenderer.on('pw:available', (_e, s) => {
  pwState = { unlocked: !!s.unlocked, locked: !!s.locked, accounts: Array.isArray(s.accounts) ? s.accounts : [] };
  showPwBubble();
});
ipcRenderer.on('pw:fill', (_e, { username, password }) => {
  if (!pwFields) return;
  if (pwFields.user && username) setFieldValue(pwFields.user, username);
  setFieldValue(pwFields.pw, password);
});

// 로그인할 때(제출 · Enter · 버튼) 아이디/비밀번호를 메인으로 보내 저장을 제안 (계정이 열려 있을 때만)
function captureLogin() {
  if (!pwFields || !pwState.unlocked) return;
  if (remoteTouched) return; // 다른 컴퓨터의 입력(화면 미러링 조작)이 들어온 페이지면 저장 제안 안 함
  const password = pwFields.pw.value;
  if (!password) return;
  const username = pwFields.user ? pwFields.user.value : '';
  const key = `${username}\u0000${password}`;
  if (key === lastCaptureKey && Date.now() - lastCaptureAt < 3000) return;
  lastCaptureKey = key;
  lastCaptureAt = Date.now();
  ipcRenderer.send('pw:captured', { username, password });
}

function watchLoginFields(f) {
  if (f.form) f.form.addEventListener('submit', captureLogin, true);
  f.pw.addEventListener('keydown', (e) => e.key === 'Enter' && captureLogin(), true);
  const scope = f.form || f.pw.parentElement?.parentElement || document;
  for (const b of scope.querySelectorAll('button, input[type="submit"]')) b.addEventListener('click', captureLogin, true);
}

const scanLoginFields = throttle(() => {
  const f = findLoginFields();
  if (!f) {
    pwFields = null;
    hidePwUi();
    return;
  }
  if (!pwFields || f.pw !== pwFields.pw) {
    pwFields = f;
    watchLoginFields(f);
    ipcRenderer.send('pw:form-found');
  } else showPwBubble();
}, 600);
window.addEventListener('DOMContentLoaded', () => {
  scanLoginFields();
  new MutationObserver(scanLoginFields).observe(document.documentElement, { childList: true, subtree: true });
});
window.addEventListener('resize', scanLoginFields);

// ======================================================================
// 화면 미러링 (호스트 쪽 탭)
//  - 메인이 원격 조작을 넣기 전에 "그 자리에 뭐가 있나"를 물어보면, 요소 정보만 알려 준다 (입력값은 절대 안 보냄)
//    판단은 메인이 shared/mirror.js 로 한다. 넣기로 하면 그 요소에 대해서만 잠깐 허락(arm)해 두고,
//    그 사이 다른 요소로 가는 누르기 · 키는 막는다 (페이지가 그 사이 바뀐 경우 대비)
//  - 다른 컴퓨터의 입력이 한 번이라도 들어온 페이지에서는 비밀번호 저장을 제안하지 않는다
//  - 호스트가 글자 칸에 입력하거나 비밀 칸 · 🔑 메뉴에 있으면 앱에 알린다 → 앱이 영상을 잠시 멈춤
// ======================================================================
let mirrorMode = false;
let remoteTouched = false;
let armed = null; // { kind: 'mouse' | 'key', el, until }

const ACT_SEL = 'a[href],button,input,select,textarea,label,summary,option,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"],[onclick],[contenteditable=""],[contenteditable="true"]';
const NON_TEXT_INPUT = /^(button|submit|reset|image|checkbox|radio|range|color|file|hidden)$/i;

function deepAt(x, y) {
  let el = document.elementFromPoint(x, y);
  for (let i = 0; i < 8 && el; i++) {
    if (el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
    }
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let doc = null;
      try {
        doc = el.contentDocument; // 같은 출처 iframe 만 안을 볼 수 있음
      } catch {}
      if (doc) {
        const r = el.getBoundingClientRect();
        x -= r.left + el.clientLeft;
        y -= r.top + el.clientTop;
        const inner = doc.elementFromPoint(x, y);
        if (inner) {
          el = inner;
          continue;
        }
      }
    }
    break;
  }
  return el;
}
function deepActive() {
  let a = document.activeElement;
  for (let i = 0; i < 8 && a; i++) {
    if (a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    else if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
      let d = null;
      try {
        d = a.contentDocument;
      } catch {}
      if (d && d.activeElement && d.activeElement !== d.body) a = d.activeElement;
      else break;
    } else break;
  }
  return a;
}
const cut = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
/** 요소 정보 (입력칸의 값은 절대 담지 않음) */
function describe(el) {
  if (!el || !el.tagName) return null;
  if (layer && el === layer.host) return { pwLayer: true };
  const tag = el.tagName.toLowerCase();
  if (tag === 'iframe' || tag === 'frame' || tag === 'embed' || tag === 'object') {
    return { tag, frame: cut(`${el.src || el.data || ''} ${el.name || ''} ${el.title || ''}`, 400) };
  }
  let act = el.closest ? el.closest(ACT_SEL) : null;
  if (!act) {
    try {
      if (getComputedStyle(el).cursor === 'pointer') act = el;
    } catch {}
  }
  const t = act || el;
  const ttag = t.tagName.toLowerCase();
  const editable = !!(t.isContentEditable || (ttag === 'input' && !NON_TEXT_INPUT.test(t.type || '')) || ttag === 'textarea');
  const form = t.form || (t.closest && t.closest('form'));
  const inLogin = !!(form && form.querySelector('input[type="password"]')) || !!(pwFields && (t === pwFields.user || t === pwFields.pw));
  const attr = (n) => (t.getAttribute ? t.getAttribute(n) : '') || '';
  let text = '';
  if (!editable) {
    try {
      text = ttag === 'input' ? String(t.value || '') : String(t.innerText || t.textContent || '');
    } catch {}
  }
  const img = t.querySelector ? t.querySelector('img[alt]') : null;
  const link = t.closest ? t.closest('a[href]') : null;
  return {
    tag: ttag,
    type: cut(String(t.type || ''), 20).toLowerCase(),
    act: !!act,
    editable,
    ac: cut(attr('autocomplete'), 60),
    name: cut(attr('name'), 80),
    id: cut(String(t.id || ''), 80),
    ph: cut(attr('placeholder'), 80),
    aria: cut(attr('aria-label'), 120),
    title: cut(attr('title'), 120),
    alt: cut((img && img.alt) || attr('alt'), 80),
    text: cut(text.trim(), 200),
    href: cut(link ? link.href : '', 300),
    action: cut(form ? form.getAttribute('action') || '' : '', 200),
    formPw: inLogin,
  };
}

ipcRenderer.on('mirror:probe', (_e, q) => {
  let d = null;
  let el = null;
  const mouse = String(q.kind || '').startsWith('mouse');
  try {
    el = mouse ? deepAt(Number(q.x), Number(q.y)) : deepActive();
    d = describe(el);
  } catch {}
  armed = { kind: mouse ? 'mouse' : 'key', el, until: Date.now() + 300 };
  remoteTouched = true; // 이 페이지엔 다른 컴퓨터의 입력이 들어옴 → 비밀번호 저장 제안 안 함
  ipcRenderer.send('mirror:probe-result', { id: q.id, d });
});
ipcRenderer.on('mirror:disarm', () => (armed = null));

const related = (a, b) => !!a && !!b && (a === b || (a.contains && a.contains(b)) || (b.contains && b.contains(a)));
function armedFor(kind) {
  if (!armed || armed.kind !== kind) return null;
  if (Date.now() > armed.until) {
    armed = null;
    return null;
  }
  return armed;
}
// 원격 누르기 · 키가 허락된 요소가 아닌 곳으로 가면 막는다
function guardRemote(kind) {
  return (e) => {
    const a = armedFor(kind);
    if (!a || !e.isTrusted) return;
    const target = (e.composedPath && e.composedPath()[0]) || e.target;
    if (kind === 'key' ? target === a.el || related(a.el, target) : related(a.el, target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
}
for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick']) window.addEventListener(t, guardRemote('mouse'), true);
for (const t of ['keydown', 'keypress', 'keyup']) window.addEventListener(t, guardRemote('key'), true);

// ---- 호스트가 입력 중 · 비밀 칸에 있는지 앱에 알림 (미러링 중일 때만) ----
let lastFocusKey = '';
function reportFocus() {
  if (!mirrorMode) return;
  let d = null;
  try {
    const a = deepActive();
    d = a && a !== document.body && a !== document.documentElement ? describe(a) : null;
  } catch {}
  if (pwMenu) d = { pwMenu: true };
  const key = JSON.stringify(d);
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  send('mirror:focus', d);
}
const reportFocusSoon = () => setTimeout(reportFocus, 0);
document.addEventListener('focusin', reportFocusSoon, true);
document.addEventListener('focusout', reportFocusSoon, true);
const sendTyping = throttle(() => send('mirror:typing', {}), 150);
window.addEventListener(
  'keydown',
  (e) => {
    if (!mirrorMode || !e.isTrusted || armedFor('key')) return; // 원격 키는 호스트 입력이 아님
    const a = deepActive();
    if (!a) return;
    const d = describe(a);
    if (d && d.editable) sendTyping();
  },
  true
);

ipcRenderer.on('jam:mirror-mode', (_e, on) => {
  mirrorMode = !!on;
  lastFocusKey = '';
  applyMirrorLayer();
  if (mirrorMode) reportFocus();
});
// 미러링 중엔 참여자 커서 · 화면 사각형을 숨긴다 (영상에 같이 찍히지 않게)
function applyMirrorLayer() {
  if (!layer) return;
  try {
    void mirrorMode;
  } catch {
    return; // 아직 초기화 전
  }
  layer.views.style.display = mirrorMode ? 'none' : '';
  layer.cursorsBox.style.display = mirrorMode ? 'none' : '';
}
