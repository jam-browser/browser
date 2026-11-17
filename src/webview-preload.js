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

// 글자 하나의 화면 위치 (안 보이거나 폭이 0 이면 null)
function charRect(node, o) {
  const range = document.createRange();
  range.setStart(node, o);
  range.setEnd(node, Math.min(o + 1, node.data.length));
  const r = range.getClientRects()[0];
  return r && r.width > 0 && r.height > 0 ? r : null;
}

// 점 아래에 실제로 있는 글자. 창 폭이 달라 글줄이 다르게 접혀도 같은 글자를 가리킬 수 있다
function charAt(x, y) {
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.data.length) return null;
  // 캐럿은 글자 사이에 놓이므로 앞뒤 글자 중 점을 덮는 쪽을 고른다
  for (const o of [range.startOffset, range.startOffset - 1]) {
    if (o < 0 || o >= node.data.length) continue;
    const r = charRect(node, o);
    if (r && x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return { node, o, r };
  }
  return null;
}

function anchorAt(x, y, { skipPinned = false } = {}) {
  const el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement || el === document.body) return null;
  if (skipPinned && isPinned(el)) return null;
  // 글자 위면 "그 글자"를 기준으로 (요소 크기 비율은 창 폭이 다르면 다른 곳을 가리킨다)
  const c = charAt(x, y);
  const parent = c?.node.parentElement;
  if (parent && el.contains(c.node)) {
    const pr = parent.getBoundingClientRect();
    const p = pathOf(parent);
    if (p && p.length <= 600 && pr.width >= 1 && pr.height >= 1) {
      return {
        p, fx: (x - pr.left) / pr.width, fy: (y - pr.top) / pr.height,
        t: [...parent.childNodes].indexOf(c.node), o: c.o, ch: c.node.data[c.o],
        cx: (x - c.r.left) / c.r.width, cy: (y - c.r.top) / c.r.height,
      };
    }
  }
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const p = pathOf(el);
  if (!p || p.length > 600) return null;
  return { p, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
}

function resolveOne(a) {
  if (!a || typeof a.p !== 'string') return null;
  let el;
  try {
    el = document.querySelector(a.p);
  } catch {
    return null;
  }
  if (!el) return null;
  // 같은 글자가 있으면 그 글자 위치
  if (Number.isInteger(a.t)) {
    const node = el.childNodes[a.t];
    if (node?.nodeType === Node.TEXT_NODE && a.o < node.data.length && (a.ch == null || node.data[a.o] === a.ch)) {
      const r = charRect(node, a.o);
      if (r) return { x: r.left + window.scrollX + (a.cx ?? 0.5) * r.width, y: r.top + window.scrollY + (a.cy ?? 0.5) * r.height };
    }
  }
  const r = el.getBoundingClientRect();
  if (r.width < 1 && r.height < 1) return null;
  return { x: r.left + window.scrollX + a.fx * r.width, y: r.top + window.scrollY + a.fy * r.height };
}

// 앵커 → 내 문서 좌표 (px) + 그 앵커의 off. 첫 앵커를 못 찾으면 예비 앵커(alt)를 차례로. 다 못 찾으면 null
function resolveAnchor(a) {
  if (!a) return null;
  for (const c of [a, ...(Array.isArray(a.alt) ? a.alt : [])]) {
    const pos = resolveOne(c);
    if (pos) return { ...pos, off: c.off || 0 };
  }
  return null;
}

// 내 화면 위/아래 가장자리를 가리키는 앵커 (가운데 열에서 고정 메뉴를 피해 찾는다).
// 상대 화면에는 같은 요소가 없을 수 있으므로 (창 폭에 따라 다른 배치, 사람마다 다른 추천 목록 등)
// 서로 다른 요소로 예비 앵커를 2개 더 붙인다
function edgeAnchor(edge) {
  const xs = [0.5, 0.35, 0.65, 0.2, 0.8].map((f) => window.innerWidth * f);
  const found = [];
  for (let step = 0; step < 12 && found.length < 3; step++) {
    const off = 4 + step * 24;
    const y = edge === 'top' ? off : window.innerHeight - off;
    if (y < 0 || y > window.innerHeight) break;
    for (const x of xs) {
      const a = anchorAt(x, y, { skipPinned: true });
      if (!a || found.some((f) => f.p === a.p)) continue;
      found.push({ ...a, off });
      if (found.length >= 3) break;
    }
  }
  if (!found.length) return null;
  const [first, ...alt] = found;
  return alt.length ? { ...first, alt } : first;
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
    top: pos ? pos.y - pos.off : y * Math.max(el.scrollHeight - window.innerHeight, 0),
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
  // 한쪽만 찾았을 때 높이는 상대 화면 높이(px)를 쓴다. 문서 길이 비율은 창 폭이 다르면 크게 틀린다
  const screenH = d.h > 0 ? d.h : d.vh * h;
  let top = d.vy * h;
  let height = d.vh * h;
  const span = t && b ? b.y + b.off - (t.y - t.off) : 0;
  if (t && b && span > screenH / 3 && span < screenH * 3) {
    top = t.y - t.off;
    height = span;
  } else if (t) {
    top = t.y - t.off;
    height = screenH;
  } else if (b) {
    height = screenH;
    top = b.y + b.off - height;
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
// 커서가 화면에 고정된 요소(상단 메뉴 등) 위에 있으면 내가 스크롤할 때 그 요소를 따라 움직여야 한다
window.addEventListener('scroll', throttle(() => { for (const c of cursors.values()) layoutCursor(c); }, 50), { passive: true });
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
    views: [...views_.entries()].map(([id, v]) => ({ id, ...v.pos, top0: v.data.top, bot0: v.data.bot })),
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
let videoPage = null; // video 를 잡았을 때의 페이지 (영상이 바뀌었는지 판단)
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

// 지금 보는 영상 페이지. shared/site.js 의 docKey 와 같은 규칙 (샌드박스라 파일을 불러올 수 없어 복사)
// 유튜브는 다음 영상(재생목록 포함)으로 넘어가도 같은 <video> 요소를 다시 쓰므로, 요소가 아니라 페이지로 새 영상을 알아챈다
function pageKey() {
  const h = location.hostname;
  if (/(^|\.)youtube\.com$/.test(h) && location.pathname === '/watch') {
    const q = new URLSearchParams(location.search);
    if (q.get('v')) return `youtube:${q.get('v')}:${q.get('list') || ''}`;
  }
  return location.href.split('#')[0].replace(/\/$/, '');
}

// 새 영상이 준비되면(광고가 끝난 뒤 포함) 앱에 알린다:
//  media-ready → Jam 재생 위치가 이 영상 것이면 따라가고, 잠시 뒤 media-init → 아무도 기준이 없으면 내가 기준이 된다
function announceVideo(v) {
  ignoreLocalUntil = Date.now() + 2000; // 자동재생 · 광고 끝난 뒤 다시 트는 이벤트는 내 조작이 아니다
  send('jam:media-ready');
  clearTimeout(initTimer);
  initTimer = setTimeout(() => {
    if (video === v && !adShowing && !isAd()) send('jam:media-init', mediaState());
  }, 2200);
}

function attachVideo(v) {
  if (video) MEDIA_EVENTS.forEach((ev) => video.removeEventListener(ev, onLocalMedia));
  video = v;
  videoPage = pageKey();
  clearTimeout(initTimer);
  if (!v) return;
  MEDIA_EVENTS.forEach((ev) => v.addEventListener(ev, onLocalMedia));
  announceVideo(v);
}

setInterval(() => {
  const v = pickVideo();
  if (v !== video) attachVideo(v);
  else if (v && pageKey() !== videoPage) {
    // 같은 <video> 요소로 다른 영상이 시작됨 (유튜브 다음 영상 · 재생목록)
    videoPage = pageKey();
    announceVideo(v);
  }
  const ad = !!video && isAd();
  if (ad !== adShowing) {
    adShowing = ad;
    send('jam:ad', ad);
    // 광고가 끝나면 유튜브가 영상을 다시 트는 이벤트는 무시하고, Jam 재생 위치로 따라간다
    // (새 영상 앞 광고였으면 아직 기준이 없을 수 있으므로 media-init 도 다시 보낸다)
    if (!ad && video) announceVideo(video);
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
