/**
 * 화면 미러링 · 조작 권한 규칙 (서버 · 앱 화면이 함께 씀)
 *
 * 권한 (참여자마다, 호스트가 정함)
 *   view  : 보기만 (기본)
 *   mouse : 클릭 · 스크롤 · 드래그
 *   game  : 마우스 + 정해진 게임 키만 (글자 입력 불가)
 *   game2 : game + 참여자의 WASD 를 방향키로 바꿔서 (한 키보드 2인용 게임의 2P)
 *   full  : 마우스 + 키보드 전체 (호스트가 경고를 보고 켬)
 *
 * 어떤 권한이어도 Ctrl · Alt · Win 조합, F 키, Win 키, 메뉴 키, PrintScreen 은 보내지 않는다.
 * 조작은 호스트의 미러링 탭(webview) 안에만 들어간다 (운영체제 · 앱 화면 · 다른 탭에는 못 감).
 */
(function (root) {
  'use strict';

  const LEVELS = ['view', 'mouse', 'game', 'game2', 'full'];
  const LEVEL_LABEL = { view: '보기만', mouse: '🖱 마우스', game: '🎮 게임 키', game2: '🎮 게임 키 (WASD→방향키, 2P)', full: '⌨ 키보드 전체' };

  const GAME_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyI', 'KeyJ', 'KeyK', 'KeyL',
    'Space', 'Enter', 'ShiftLeft', 'ShiftRight', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  ]);
  const REMAP_2P = { KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight' };
  const NEVER = /^(F\d{1,2}|MetaLeft|MetaRight|OSLeft|OSRight|ContextMenu|PrintScreen|ControlLeft|ControlRight|AltLeft|AltRight|Pause|ScrollLock|LaunchApp\d|LaunchMail|BrowserBack|BrowserForward|BrowserHome|BrowserRefresh|BrowserSearch|Power|Sleep|WakeUp|Eject)$/;

  const canMouse = (level) => level === 'mouse' || level === 'game' || level === 'game2' || level === 'full';

  /** 이 권한으로 이 키를 보낼 수 있나 (mods: { ctrl, alt, meta }) */
  function allowKey(level, code, mods) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,24}$/.test(code)) return false;
    if (mods && (mods.ctrl || mods.alt || mods.meta)) return false;
    if (NEVER.test(code)) return false;
    if (level === 'game' || level === 'game2') return GAME_KEYS.has(code);
    if (level === 'full') return true;
    return false;
  }

  /** 권한에 따라 키 바꾸기 (game2: WASD → 방향키) */
  function mapKey(level, code) {
    return level === 'game2' && REMAP_2P[code] ? REMAP_2P[code] : code;
  }

  // KeyboardEvent.code → Electron sendInputEvent keyCode
  const NAMED = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', CapsLock: 'CapsLock',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  function electronKey(code) {
    if (NAMED[code]) return NAMED[code];
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1].toLowerCase();
    m = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (m) return m[1];
    return null;
  }

  /** 보낼 마우스 이벤트 정리 (좌표는 0~1 비율) — 이상하면 null */
  function cleanMouse(e) {
    if (!e || typeof e !== 'object') return null;
    const t = { mv: 'mouseMove', dn: 'mouseDown', up: 'mouseUp', wh: 'mouseWheel' }[e.t];
    if (!t) return null;
    const x = Number(e.x);
    const y = Number(e.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const out = { t: e.t, x, y };
    if (t === 'mouseDown' || t === 'mouseUp') {
      out.b = e.b === 'middle' ? 'middle' : 'left'; // 우클릭(메뉴)은 보내지 않음
      out.c = Math.min(3, Math.max(1, Math.round(Number(e.c) || 1)));
    }
    if (t === 'mouseWheel') {
      out.dx = Math.max(-2000, Math.min(2000, Math.round(Number(e.dx) || 0)));
      out.dy = Math.max(-2000, Math.min(2000, Math.round(Number(e.dy) || 0)));
    }
    return out;
  }

  const api = { LEVELS, LEVEL_LABEL, GAME_KEYS, canMouse, allowKey, mapKey, electronKey, cleanMouse };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamMirror = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
