/**
 * 화면 미러링 · 조작 권한 규칙 (서버 · 앱 화면이 함께 씀)
 *
 * 권한 (참여자마다, 호스트가 정함) = { m: 마우스 허용 여부, k: 키 묶음 }
 *   k = none  : 키 입력 없음 (기본)
 *       game  : 정해진 게임 키만 (글자 입력 불가)
 *       game2 : game + 참여자의 WASD 를 방향키로 바꿔서 (한 키보드 2인용 게임의 2P)
 *       full  : 키보드 전체 (호스트가 경고를 보고 켬)
 *   기본은 { m: false, k: 'none' } = 보기만
 *
 * 어떤 권한이어도 Ctrl · Alt · Win 조합, F 키, Win 키, 메뉴 키, PrintScreen 은 보내지 않는다.
 * 조작은 호스트의 미러링 탭(webview) 안에만 들어간다 (운영체제 · 앱 화면 · 다른 탭에는 못 감).
 */
(function (root) {
  'use strict';

  const KEYSETS = ['none', 'game', 'game2', 'full'];
  const KEY_LABEL = { none: '키 없음', game: '🎮 게임 키', game2: '🎮 게임 키 (WASD→방향키, 2P)', full: '⌨ 키보드 전체' };
  const VIEW = Object.freeze({ m: false, k: 'none' });

  /** 어떤 값이 와도 { m, k } 로 정리 */
  function normControl(c) {
    if (!c || typeof c !== 'object') return { m: false, k: 'none' };
    return { m: c.m === true, k: KEYSETS.includes(c.k) ? c.k : 'none' };
  }
  const canControl = (c) => !!c && (c.m === true || (KEYSETS.includes(c.k) && c.k !== 'none'));
  const canMouse = (c) => !!c && c.m === true;
  const sameControl = (a, b) => { a = normControl(a); b = normControl(b); return a.m === b.m && a.k === b.k; };
  function controlLabel(c) {
    c = normControl(c);
    const parts = [];
    if (c.m) parts.push('🖱 마우스');
    if (c.k !== 'none') parts.push(KEY_LABEL[c.k]);
    return parts.length ? parts.join(' + ') : '보기만';
  }

  const GAME_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyI', 'KeyJ', 'KeyK', 'KeyL',
    'Space', 'Enter', 'ShiftLeft', 'ShiftRight', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  ]);
  const REMAP_2P = { KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight' };
  const NEVER = /^(F\d{1,2}|MetaLeft|MetaRight|OSLeft|OSRight|ContextMenu|PrintScreen|ControlLeft|ControlRight|AltLeft|AltRight|Pause|ScrollLock|LaunchApp\d|LaunchMail|BrowserBack|BrowserForward|BrowserHome|BrowserRefresh|BrowserSearch|Power|Sleep|WakeUp|Eject)$/;

  /** 이 키 묶음(keys = none/game/game2/full)으로 이 키를 보낼 수 있나 (mods: { ctrl, alt, meta }) */
  function allowKey(keys, code, mods) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,24}$/.test(code)) return false;
    if (mods && (mods.ctrl || mods.alt || mods.meta)) return false;
    if (NEVER.test(code)) return false;
    if (keys === 'game' || keys === 'game2') return GAME_KEYS.has(code);
    if (keys === 'full') return true;
    return false;
  }

  /** 키 묶음에 따라 키 바꾸기 (game2: WASD → 방향키) */
  function mapKey(keys, code) {
    return keys === 'game2' && REMAP_2P[code] ? REMAP_2P[code] : code;
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
  const ELECTRON_KEYS = new Set([...Object.values(NAMED), ...'abcdefghijklmnopqrstuvwxyz0123456789']);
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

  // ---------- 개인정보 버튼 판별 (조작 권한이 있어도 원격 클릭 · 키는 막음) ----------
  // 버튼 · 링크의 글자 / aria-label / title / name / id / href / 폼 주소에 이런 말이 있으면 개인정보 · 돈 · 계정 쪽으로 본다
  // (한국어 | 영어)
  const SENSITIVE_WORDS = new RegExp(
    [
      /로그인|로그아웃|회원\s*가입|비밀\s*번호|패스워드|계정|내\s*정보|개인\s*정보|회원\s*정보|마이\s*페이지|프로필|설정|보안|본인\s*(?:확인|인증)|인증\s*(?:번호|하기|요청)/,
      /결제|구매|주문|송금|이체|출금|입금|충전|환불|카드\s*(?:번호|등록|결제|정보)|계좌|은행|주소|연락처|전화\s*번호|휴대\s*(?:폰|전화)|이메일|주민|탈퇴|구독|해지|선물하기|권한|연동|비번/,
      /log\s*-?\s*(?:in|out|off)|sign\s*-?\s*(?:in|up|out|on)|passw|passcode|account|profile|my\s*page|settings?\b|preferences|security|privacy|personal|verif|2fa|\botp\b/,
      /payment|\bpay\b|checkout|purchase|buy\s*now|place\s*order|billing|credit\s*card|card\s*number|\bbank|transfer|withdraw|deposit|wallet|refund|subscri|address|phone/,
      /e-?mail|delete|unsubscribe|permission|oauth|authori[sz]e|api\s*key|\btoken/,
    ].map((r) => r.source).join('|'),
    'i'
  );
  // 결제 · 로그인 위젯이 들어 있는 iframe 주소
  const SENSITIVE_FRAME = /(pay|checkout|billing|stripe|paypal|toss|kakao|naver|inicis|nicepay|kcp|danal|accounts\.|login|signin|auth|oauth|captcha|wallet|bank)/i;
  // 비밀 입력 칸 (호스트가 여기 있으면 영상을 멈추고, 참여자 키는 아예 보내지 않음)
  const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-|username|email|tel)/i;
  const SECRET_NAME = /(pass|pwd|otp|cvc|cvv|card|pin\b|ssn|secret|token|주민|비밀|비번|인증)/i;

  const isSensitiveText = (t) => typeof t === 'string' && t.length > 0 && SENSITIVE_WORDS.test(t.slice(0, 400));

  /**
   * d = 그 탭 안 스크립트가 알려 준 요소 정보 (입력값은 절대 담지 않음)
   *   { tag, type, act(눌러서 동작하는 요소), editable, ac(autocomplete), name, id, ph, aria, title, alt, text, href, action, formPw, frame, pwLayer, pwMenu }
   */
  function isSecretField(d) {
    if (!d) return false;
    if (d.pwMenu || d.pwLayer) return true; // 🔑 비밀번호 뱅크 메뉴
    if (!d.editable) return false;
    if (d.type === 'password' || d.type === 'email' || d.type === 'tel') return true;
    if (d.ac && SECRET_AUTOCOMPLETE.test(d.ac)) return true;
    if (SECRET_NAME.test(`${d.name || ''} ${d.id || ''} ${d.ph || ''} ${d.aria || ''}`)) return true;
    return !!d.formPw; // 로그인 폼 안의 칸 (아이디 등)
  }
  const describeText = (d) => [d.text, d.aria, d.title, d.alt, d.name, d.id, d.href, d.action].filter((x) => typeof x === 'string' && x).join(' ');
  const ACTIVATE_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);

  /** 원격 조작을 그 자리에 넣어도 되나 → { ok, reason } (reason: pw · frame · secret · login · button · unknown) */
  function remoteVerdict(d, kind, code) {
    const no = (reason) => ({ ok: false, reason });
    if (!d || typeof d !== 'object') return no('unknown');
    if (d.pwLayer || d.pwMenu) return no('pw');
    if (d.frame && SENSITIVE_FRAME.test(d.frame)) return no('frame');
    if (kind === 'keyDown' || kind === 'keyUp' || kind === 'char') {
      if (d.editable) return isSecretField(d) ? no('secret') : { ok: true };
      if (d.act && (kind === 'char' || ACTIVATE_KEYS.has(code)) && (d.formPw || isSensitiveText(describeText(d)))) return no('button');
      return { ok: true };
    }
    if (d.editable && isSecretField(d)) return no('secret');
    if (d.act && d.formPw) return no('login');
    if (d.act && isSensitiveText(describeText(d))) return no('button');
    return { ok: true };
  }
  const BLOCK_REASON = {
    pw: '비밀번호 뱅크',
    frame: '결제 · 로그인 창',
    secret: '비밀 입력 칸',
    login: '로그인 양식',
    button: '개인정보 · 결제 · 계정 관련 버튼',
    unknown: '확인할 수 없는 곳',
  };

  const api = { KEYSETS, KEY_LABEL, VIEW, GAME_KEYS, normControl, canControl, canMouse, sameControl, controlLabel, allowKey, mapKey, electronKey, cleanMouse,
    SENSITIVE_WORDS, SENSITIVE_FRAME, SECRET_AUTOCOMPLETE, SECRET_NAME, isSensitiveText, isSecretField, remoteVerdict, BLOCK_REASON, ELECTRON_KEYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamMirror = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
