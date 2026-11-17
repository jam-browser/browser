'use strict';
/* global JamMirror, jamApp */
// 화면 미러링 (설계안 2단계)
//  호스트: 그 탭(webview)만 잡은 화면 → WebCodecs VP8 → 32KB 조각 → Jam 키로 암호화 → 참여자
//  참여자: 조각 모으기 → VideoDecoder → canvas, 권한이 있으면 마우스 · 키를 호스트로
//  호스트: 받은 조작을 그 탭 webview 에만 sendInputEvent (다른 사이트 · 로그인 화면이면 회수)
// (app.js 의 $, el, toast, jam, prettyUrl, sameSite, isSensitiveUrl 를 쓴다)

const mirror = (() => {
  const M = JamMirror;
  const PIECE = 32 * 1024;
  const TYPES = { mv: 'mouseMove', dn: 'mouseDown', up: 'mouseUp', wh: 'mouseWheel' };

  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 56]).join('');

  // ================= 호스트 =================
  let host = null; // { sid, tab, stream, track, reader, encoder, seq, needKey, startUrl, w, h, frames, sent }
  let guardTimer = null;

  async function start(tab = jam.tab) {
    if (!jam.active || !jam.isHost() || host) return;
    if (!tab?.webview || !tab.ready) return toast('탭이 아직 준비되지 않았어요');
    if (!('VideoEncoder' in window) || !('MediaStreamTrackProcessor' in window)) return toast('이 버전에서는 화면 미러링을 쓸 수 없어요');
    if (!window.__mirrorNoConfirm && !confirm('지금 탭의 화면을 Jam 참여자에게 영상으로 보여 줄까요?\n\n· 이 탭에 로그인한 화면이 그대로 보여요\n· 다른 탭 · 앱 화면 · 바탕화면은 보이지 않아요\n· 소리는 보내지 않아요')) return;
    try {
      const id = await jamApp.mirrorSourceId(tab.webview.getWebContentsId());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: 1280, maxHeight: 720, maxFrameRate: 24 } },
      });
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      const h = { sid: randomId(), tab, stream, track, seq: 0, needKey: true, startUrl: tab.url, encoder: null, w: 0, h: 0, frames: 0, sent: 0 };
      host = h;
      jam.send({ type: 'mirror-start', sid: h.sid, w: s.width || 1280, h: s.height || 720, title: tab.title || prettyUrl(tab.url) });
      pump(h);
      clearInterval(guardTimer);
      guardTimer = setInterval(guard, 1000);
      render();
    } catch (e) {
      console.error(e);
      toast(`화면 미러링을 시작하지 못했어요: ${e.message}`);
      stop();
    }
  }

  async function pump(h) {
    let reader;
    try {
      reader = new MediaStreamTrackProcessor({ track: h.track }).readable.getReader();
    } catch (e) {
      console.error(e);
      return stop();
    }
    h.reader = reader;
    while (host === h) {
      let r;
      try {
        r = await reader.read();
      } catch {
        break;
      }
      if (r.done) break;
      const frame = r.value;
      try {
        if (host !== h) break;
        const w = frame.displayWidth & ~1;
        const ht = frame.displayHeight & ~1;
        if (!h.encoder || w !== h.w || ht !== h.h) configure(h, w, ht);
        // 네트워크가 밀리면 이 프레임은 건너뛰고, 다음은 키프레임으로
        if ((jam.ws?.bufferedAmount || 0) > 2e6 || h.encoder.encodeQueueSize > 2) {
          h.needKey = true;
          continue;
        }
        const key = h.needKey || h.frames % 96 === 0;
        h.needKey = false;
        h.encoder.encode(frame, { keyFrame: key });
        h.frames++;
      } catch (e) {
        console.error(e);
      } finally {
        frame.close();
      }
    }
    if (host === h) {
      toast('미러링하던 탭이 닫혀서 화면 미러링을 멈췄어요');
      stop();
    }
  }

  function configure(h, w, ht) {
    try { h.encoder?.close(); } catch {}
    h.w = w;
    h.h = ht;
    h.encoder = new VideoEncoder({
      output: (chunk) => sendChunk(h, chunk),
      error: (e) => {
        console.error(e);
        if (host === h) {
          toast('영상 인코더 오류로 화면 미러링을 멈췄어요');
          stop();
        }
      },
    });
    h.encoder.configure({ codec: 'vp8', width: w, height: ht, bitrate: 2_000_000, framerate: 24, latencyMode: 'realtime' });
    h.needKey = true;
  }

  function sendChunk(h, chunk) {
    if (host !== h) return;
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    const f = h.seq++;
    const n = Math.max(1, Math.ceil(buf.length / PIECE));
    if (n > 64) return void (h.needKey = true);
    const k = chunk.type === 'key';
    for (let i = 0; i < n; i++) {
      const m = { type: 'mv', sid: h.sid, f, k, i, n, ts: chunk.timestamp, d: b64(buf.subarray(i * PIECE, (i + 1) * PIECE)) };
      if (k && i === 0) Object.assign(m, { w: h.w, h: h.h });
      jam.send(m);
    }
    h.sent++;
  }

  function stop(silent = false) {
    const h = host;
    host = null;
    clearInterval(guardTimer);
    if (h) {
      try { h.reader?.cancel(); } catch {}
      try { h.track.stop(); } catch {}
      try { h.encoder?.close(); } catch {}
      if (!silent && jam.active) jam.send({ type: 'mirror-stop' });
    }
    render();
  }

  // 미러링 탭이 다른 사이트 · 로그인/결제 화면으로 가면 조작 권한을 모두 회수
  function unsafe(h) {
    const u = h.tab?.url || '';
    return isSensitiveUrl(u) || !sameSite(u, h.startUrl);
  }
  function guard() {
    if (!host || !jam.active) return;
    if (unsafe(host) && jam.room.members.some((m) => m.control && m.control !== 'view')) {
      revokeAll('미러링 탭이 다른 사이트나 로그인 · 결제 화면으로 바뀌어서 조작 권한을 모두 회수했어요');
    }
  }
  function revokeAll(reason) {
    if (!jam.active || !jam.isHost()) return;
    let any = false;
    for (const m of jam.room.members) {
      if (m.id !== jam.you.id && m.control && m.control !== 'view') {
        jam.send({ type: 'control', id: m.id, level: 'view' });
        any = true;
      }
    }
    if (any && reason) toast(`🛑 ${reason}`);
  }

  let ctrlTimer = null;
  function applyInput(msg) {
    const h = host;
    if (!h || !jam.active) return;
    const who = jam.member(msg.by);
    const level = who?.control || 'view';
    if (level === 'view') return;
    const tab = h.tab;
    if (!tab?.webview || !tab.ready) return;
    if (unsafe(h)) return guard();
    const wv = tab.webview;
    if (msg.k === 'm') {
      if (!M.canMouse(level)) return;
      const e = M.cleanMouse(msg);
      if (!e) return;
      const ev = { type: TYPES[e.t], x: Math.round(e.x * wv.clientWidth), y: Math.round(e.y * wv.clientHeight) };
      if (e.b) Object.assign(ev, { button: e.b, clickCount: e.c });
      if (e.t === 'wh') Object.assign(ev, { deltaX: -e.dx, deltaY: -e.dy, canScroll: true });
      wv.sendInputEvent(ev);
    } else if (msg.k === 'k') {
      if (!M.allowKey(level, msg.code)) return;
      const keyCode = M.electronKey(msg.code);
      if (!keyCode) return;
      const modifiers = msg.shift ? ['shift'] : [];
      wv.sendInputEvent({ type: msg.t === 'd' ? 'keyDown' : 'keyUp', keyCode, modifiers });
      if (msg.t === 'd' && level === 'full' && typeof msg.key === 'string' && [...msg.key].length === 1) {
        wv.sendInputEvent({ type: 'char', keyCode: msg.key, modifiers });
      }
    }
    const label = $('#mirror-ctrl');
    label.textContent = `${level === 'full' ? '⌨' : msg.k === 'k' ? '🎮' : '🖱'} ${who.name}님이 조작 중`;
    label.style.borderColor = who.color;
    label.hidden = false;
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(() => (label.hidden = true), 1500);
  }

  // ================= 참여자 =================
  let view = null; // { sid, by, decoder, configured, w, h, waitingKey, lastF, parts, hidden, frames, lastReq }

  function openView(m) {
    if (view && view.sid === m.sid) return;
    closeView();
    view = { sid: m.sid, by: m.by, title: m.title, configured: false, w: 0, h: 0, waitingKey: true, lastF: -1, parts: new Map(), hidden: false, frames: 0, lastReq: 0 };
    newDecoder();
    $('#mirror-wait').hidden = false;
    requestKey(true);
    render();
  }
  function newDecoder() {
    try { view.decoder?.close(); } catch {}
    const v = view;
    v.configured = false;
    v.decoder = new VideoDecoder({
      output: (frame) => {
        if (view !== v) return frame.close();
        const c = $('#mirror-canvas');
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth;
          c.height = frame.displayHeight;
        }
        c.getContext('2d').drawImage(frame, 0, 0);
        frame.close();
        v.frames++;
        if (v.frames === 1) $('#mirror-wait').hidden = true;
      },
      error: (e) => {
        console.error(e);
        if (view === v) {
          newDecoder();
          v.waitingKey = true;
          requestKey();
        }
      },
    });
  }
  function closeView() {
    if (!view) return;
    try { view.decoder.close(); } catch {}
    releaseKeys();
    view = null;
    const c = $('#mirror-canvas');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    render();
  }
  function requestKey(force) {
    if (!view) return;
    const now = Date.now();
    if (!force && now - view.lastReq < 1000) return;
    view.lastReq = now;
    jam.send({ type: 'mkey' });
  }
  function onChunk(msg) {
    const v = view;
    if (!v || msg.sid !== v.sid) return;
    let p = v.parts.get(msg.f);
    if (!p) {
      p = { f: msg.f, n: msg.n, got: 0, k: !!msg.k, ts: msg.ts, pieces: new Array(msg.n) };
      v.parts.set(msg.f, p);
    }
    if (msg.k && msg.i === 0) Object.assign(p, { w: msg.w, h: msg.h });
    if (!p.pieces[msg.i]) {
      p.pieces[msg.i] = unb64(msg.d);
      p.got++;
    }
    if (p.got < p.n) return;
    v.parts.delete(p.f);
    for (const k of v.parts.keys()) if (k < p.f) v.parts.delete(k); // 덜 온 옛 프레임은 버림
    decode(v, p);
  }
  function decode(v, p) {
    if (p.k) {
      if (!v.configured || p.w !== v.w || p.h !== v.h) {
        if (v.configured) newDecoder();
        v.decoder.configure({ codec: 'vp8', codedWidth: p.w, codedHeight: p.h, optimizeForLatency: true });
        Object.assign(v, { configured: true, w: p.w, h: p.h });
      }
      v.waitingKey = false;
    } else if (v.waitingKey || !v.configured || p.f !== v.lastF + 1) {
      v.waitingKey = true; // 중간이 빠졌으면 다음 키프레임까지 기다림
      return requestKey();
    }
    if (v.decoder.decodeQueueSize > 6) {
      v.waitingKey = true;
      return requestKey();
    }
    const total = p.pieces.reduce((s, x) => s + x.length, 0);
    const data = new Uint8Array(total);
    let o = 0;
    for (const x of p.pieces) {
      data.set(x, o);
      o += x.length;
    }
    try {
      v.decoder.decode(new EncodedVideoChunk({ type: p.k ? 'key' : 'delta', timestamp: p.ts, data }));
      v.lastF = p.f;
    } catch (e) {
      console.error(e);
      v.waitingKey = true;
      requestKey();
    }
  }

  // ---- 참여자 조작 → 호스트 ----
  const myLevel = () => jam.me()?.control || 'view';
  function point(e) {
    const c = $('#mirror-canvas');
    const r = c.getBoundingClientRect();
    if (!c.width || !c.height || !r.width || !r.height) return null;
    const scale = Math.min(r.width / c.width, r.height / c.height);
    const dw = c.width * scale;
    const dh = c.height * scale;
    const x = (e.clientX - r.left - (r.width - dw) / 2) / dw;
    const y = (e.clientY - r.top - (r.height - dh) / 2) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }
  let lastMove = 0;
  let wheel = { dx: 0, dy: 0, timer: null, p: null };
  const held = new Set();
  function sendMouse(t, e, extra = {}) {
    if (!view || !M.canMouse(myLevel())) return;
    const p = point(e);
    if (!p) return;
    jam.send({ type: 'mi', k: 'm', t, ...p, ...extra });
  }
  function bindInput() {
    const c = $('#mirror-canvas');
    c.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - lastMove < 33) return;
      lastMove = now;
      sendMouse('mv', e);
    });
    c.addEventListener('mousedown', (e) => {
      c.focus();
      if (e.button === 2) return;
      e.preventDefault();
      sendMouse('dn', e, { b: e.button === 1 ? 'middle' : 'left', c: e.detail || 1 });
    });
    c.addEventListener('mouseup', (e) => {
      if (e.button === 2) return;
      sendMouse('up', e, { b: e.button === 1 ? 'middle' : 'left', c: e.detail || 1 });
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener(
      'wheel',
      (e) => {
        if (!view || !M.canMouse(myLevel())) return;
        e.preventDefault();
        wheel.dx += e.deltaX;
        wheel.dy += e.deltaY;
        wheel.p = point(e);
        if (wheel.timer) return;
        wheel.timer = setTimeout(() => {
          if (wheel.p) jam.send({ type: 'mi', k: 'm', t: 'wh', ...wheel.p, dx: wheel.dx, dy: wheel.dy });
          wheel = { dx: 0, dy: 0, timer: null, p: null };
        }, 40);
      },
      { passive: false }
    );
    const onKey = (t) => (e) => {
      if (!view) return;
      const level = myLevel();
      const mods = { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey };
      if (!M.allowKey(level, e.code, mods)) return; // 허용 안 된 키는 내 앱이 평소처럼 처리
      e.preventDefault();
      e.stopPropagation();
      if (t === 'd') held.add(e.code);
      else held.delete(e.code);
      jam.send({ type: 'mi', k: 'k', t, code: e.code, key: e.key, mods });
    };
    c.addEventListener('keydown', onKey('d'));
    c.addEventListener('keyup', onKey('u'));
    c.addEventListener('blur', releaseKeys);
    $('#mirror-hide').addEventListener('click', () => {
      if (!view) return;
      view.hidden = true;
      releaseKeys();
      render();
    });
    $('#ov-mirror').addEventListener('click', () => {
      if (!view) return;
      view.hidden = false;
      render();
      requestKey(true);
    });
    $('#mirror-toggle').addEventListener('click', () => (host ? stop() : start(activeTab && activeTab === jam.tab ? jam.tab : activeTab || jam.tab)));
  }
  function releaseKeys() {
    if (!jam.active) return held.clear();
    for (const code of held) jam.send({ type: 'mi', k: 'k', t: 'u', code, key: '', mods: {} });
    held.clear();
  }

  // ================= 화면 =================
  function render() {
    const active = jam.active && jam.room;
    const isHost = active && jam.isHost();
    $('#mirror-section').hidden = !isHost;
    const btn = $('#mirror-toggle');
    btn.textContent = host ? '■ 화면 미러링 멈추기' : '🖥 지금 탭 화면 미러링';
    btn.classList.toggle('danger', !!host);
    $('#mirror-hint').textContent = host
      ? `"${host.tab.title || prettyUrl(host.tab.url)}" 화면을 보내는 중 · 참여자별 조작 권한은 아래 참여자 목록에서 · Esc 를 길게 누르면 모두 회수`
      : '로컬 파일 · 로그인한 화면 · 2인용 게임처럼 같은 화면을 봐야 할 때. 참여자는 영상으로 보고, 허락한 사람만 조작할 수 있어요.';
    const showView = !!(active && view && !view.hidden);
    $('#mirror-view').hidden = !showView;
    $('#ov-mirror').hidden = !(active && view && view.hidden);
    if (view) {
      const owner = jam.member(view.by);
      $('#mirror-title').textContent = `🖥 ${owner?.name || '호스트'}님의 화면${view.title ? ` · ${view.title}` : ''}`;
      const lv = myLevel();
      $('#mirror-level').textContent = lv === 'view' ? '보기만' : `${M.LEVEL_LABEL[lv]} 가능 · 화면을 누른 뒤 조작`;
      $('#mirror-canvas').classList.toggle('can-control', lv !== 'view');
    }
  }

  // 호스트: 참여자 목록의 조작 권한 선택
  function controlSelect(m) {
    if (!jam.active || !jam.isHost() || !host || m.id === jam.you.id) return null;
    const sel = el('select', { class: 'mirror-level', title: '화면 미러링 조작 권한' }, ...M.LEVELS.map((lv) => el('option', { value: lv }, M.LEVEL_LABEL[lv])));
    sel.value = m.control || 'view';
    sel.addEventListener('change', () => {
      const level = sel.value;
      if (level === 'full' && !confirm(`${m.name}님에게 키보드 전체 입력을 허락할까요?\n\n이 탭에 글자를 입력할 수 있게 돼요 (게시글 · 메시지 등). Ctrl/Alt 조합, F 키, 우클릭은 그래도 막혀요.`)) {
        sel.value = m.control || 'view';
        return;
      }
      jam.send({ type: 'control', id: m.id, level });
    });
    return sel;
  }

  function handle(msg) {
    switch (msg.type) {
      case 'mirror':
        jam.room.mirror = msg.mirror;
        if (!msg.mirror) {
          closeView();
          if (host) stop(true);
        } else if (msg.mirror.by !== jam.you.id) openView(msg.mirror);
        render();
        renderMembers(true);
        break;
      case 'mv':
        onChunk(msg);
        break;
      case 'mkey':
        if (host) host.needKey = true;
        break;
      case 'mi':
        applyInput(msg);
        break;
      case 'control':
        if (msg.level === 'view') releaseKeys();
        toast(msg.level === 'view' ? '화면 조작 권한이 없어졌어요' : `호스트가 화면 조작을 허락했어요: ${M.LEVEL_LABEL[msg.level]} — 화면을 누르고 조작하세요`);
        render();
        break;
    }
  }

  function onWelcome(room) {
    if (room.mirror && room.mirror.by !== jam.you.id) openView(room.mirror);
    render();
  }
  function reset() {
    stop(true);
    closeView();
  }

  bindInput();
  return { start, stop, handle, onWelcome, reset, render, controlSelect, revokeAll, isMirroring: () => !!host, stats: () => ({ host: host && { frames: host.frames, sent: host.sent, w: host.w, h: host.h }, view: view && { frames: view.frames, w: view.w, h: view.h, waitingKey: view.waitingKey } }) };
})();
window.mirror = mirror;
