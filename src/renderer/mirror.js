'use strict';
/* global JamMirror, jamApp */
// 화면 미러링 (설계안 2단계)
//  호스트: 그 탭(webview)만 잡은 화면 → WebCodecs (H.264 하드웨어, 안 되면 VP8) → 32KB 조각 → Jam 키로 암호화 → 참여자
//  참여자: 조각 모으기 → VideoDecoder → canvas, 권한이 있으면 마우스 · 키를 호스트로
//  호스트: 받은 조작을 메인 프로세스가 그 탭에만 넣음 (개인정보 버튼 · 비밀 칸이면 안 넣음, 다른 사이트 · 로그인 화면이면 회수)
//
// 화질 조절 (2 ~ 20Mbps, 세션 전체 200Mbps 안에서)
//  서버가 1초마다 밀림 · 버림 · 참여자 지연을 알려 주면
//   나빠질 때: ① 초당 장수 30→24→15→10  ② 비트레이트 ×0.7 (2Mbps 까지)  ③ 5fps  ④ 해상도 75% → 50%
//   좋아지면 거꾸로 되돌림 (글자가 읽히도록 해상도는 마지막까지 지킴)
//
// 호스트 입력 숨기기: 호스트가 글자 칸에 입력하는 동안 · 비밀 칸(비밀번호 등)에 있는 동안 · 로그인/결제 화면에서는 영상을 멈춤
// (app.js 의 $, el, toast, jam, prettyUrl, sameSite, isSensitiveUrl, isWebUrl, renderMembers 를 쓴다)

const mirror = (() => {
  const M = JamMirror;
  const PIECE = 32 * 1024;
  const TYPES = { mv: 'mouseMove', dn: 'mouseDown', up: 'mouseUp', wh: 'mouseWheel' };
  const FPS = [30, 24, 15, 10, 5];
  const FPS10 = FPS.indexOf(10);
  const RATE_MIN = 2e6;
  const RATE_MAX = 20e6;
  const RATE_START = 8e6;
  const OVERHEAD = 1.4; // base64 + 암호화 + JSON 덧붙임
  const KEY_EVERY = 4000; // ms 마다 키프레임
  const PAUSE_TEXT = {
    typing: '⌨ 호스트가 입력 중이라 화면을 잠시 멈췄어요',
    secret: '🔒 호스트가 비밀 입력 칸에 있어서 화면을 멈췄어요 · 키 입력도 막혀요',
    page: '🔒 로그인 · 결제 화면이라 화면을 멈췄어요',
  };

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
  const mbps = (r) => `${(r / 1e6).toFixed(r < 1e7 ? 1 : 0)}Mbps`;
  const codecName = (c) => (c && c.startsWith('avc1') ? 'H.264' : 'VP8');

  // ================= 호스트 =================
  let host = null;
  let guardTimer = null;

  // 하드웨어 H.264 인코더가 있으면 그걸로 (CPU 부담 적음), 없으면 VP8
  async function pickCodec(w, h) {
    const base = { width: w, height: h, bitrate: RATE_START, framerate: 24, latencyMode: 'realtime' };
    const tries = [
      { codec: 'avc1.640028', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' },
      { codec: 'vp8' },
    ];
    if (window.__mirrorCodec === 'vp8') tries.shift();
    for (const c of tries) {
      try {
        const e = await VideoEncoder.isConfigSupported({ ...base, ...c });
        const d = await VideoDecoder.isConfigSupported({ codec: c.codec, codedWidth: w, codedHeight: h });
        if (e.supported && d.supported) return c;
      } catch {}
    }
    return { codec: 'vp8' };
  }

  async function start(tab = jam.tab) {
    if (!jam.active || !jam.isHost() || host) return;
    if (!tab?.webview || !tab.ready) return toast('탭이 아직 준비되지 않았어요');
    if (!('VideoEncoder' in window) || !('MediaStreamTrackProcessor' in window)) return toast('이 버전에서는 화면 미러링을 쓸 수 없어요');
    if (!window.__mirrorNoConfirm && !confirm('지금 탭의 화면을 Jam 참여자에게 영상으로 보여 줄까요?\n\n· 이 탭에 로그인한 화면이 그대로 보여요\n· 다른 탭 · 앱 화면 · 바탕화면은 보이지 않아요\n· 소리는 보내지 않아요\n· 글자 칸에 입력하는 동안 · 비밀번호 칸 · 로그인/결제 화면에서는 영상이 잠시 멈춰요')) return;
    try {
      const id = await jamApp.mirrorSourceId(tab.webview.getWebContentsId());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 } },
      });
      const track = stream.getVideoTracks()[0];
      const s = track.getSettings();
      const codec = await pickCodec((s.width || 1280) & ~1, (s.height || 720) & ~1);
      const h = {
        sid: randomId(), tab, stream, track, codec, seq: 0, needKey: true, startUrl: tab.url, encoder: null, w: 0, h: 0, frames: 0, sent: 0,
        q: { fpsI: 1, rate: RATE_START, scale: 1, good: 0, lastChange: 0, cap: RATE_MAX },
        lastEncTs: -1e12, lastKeyAt: 0, lastFrame: null, tsOffset: 0, localDrops: 0, reconf: false,
        paused: null, secret: false, focus: null, typingUntil: 0, stat: null, kickTimer: null, typeTimer: null, canvas: null,
        lastBlock: new Map(),
      };
      host = h;
      h.onReady = () => tab.webview.send('jam:mirror-mode', true);
      tab.webview.addEventListener('dom-ready', h.onReady);
      tab.webview.send('jam:mirror-mode', true);
      jam.send({ type: 'mirror-start', sid: h.sid, w: s.width || 1280, h: s.height || 720, title: tab.title || prettyUrl(tab.url) });
      pump(h);
      clearInterval(guardTimer);
      guardTimer = setInterval(guard, 1000);
      updatePrivacy(h);
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
        h.tsOffset = frame.timestamp - performance.now() * 1000;
        try { h.lastFrame?.close(); } catch {}
        h.lastFrame = frame.clone(); // 화면이 멈춰 있을 때 키프레임을 다시 만들 수 있게
        if (h.paused) {
          h.needKey = true; // 멈춘 동안은 보내지 않음 → 다시 시작할 때 키프레임부터
          continue;
        }
        const gap = 1e6 / FPS[h.q.fpsI];
        if (!h.needKey && frame.timestamp - h.lastEncTs < gap * 0.85) continue; // 초당 장수 맞추기
        encodeFrame(h, frame);
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

  function encodeFrame(h, frame) {
    const sw = frame.displayWidth & ~1;
    const sh = frame.displayHeight & ~1;
    const scaled = h.q.scale < 1;
    const w = scaled ? Math.max(16, Math.round(sw * h.q.scale) & ~1) : sw;
    const ht = scaled ? Math.max(16, Math.round(sh * h.q.scale) & ~1) : sh;
    if (!h.encoder || h.encoder.state === 'closed' || w !== h.w || ht !== h.h || h.reconf) configure(h, w, ht);
    if (h.encoder.encodeQueueSize > 2) {
      h.needKey = true; // 인코더가 밀림 → 건너뜀
      h.localDrops++;
      return;
    }
    let input = frame;
    if (scaled) {
      // 마지막 단계(해상도 낮추기)에서만 캔버스로 줄임
      if (!h.canvas || h.canvas.width !== w || h.canvas.height !== ht) h.canvas = new OffscreenCanvas(w, ht);
      h.canvas.getContext('2d').drawImage(frame, 0, 0, w, ht);
      input = new VideoFrame(h.canvas, { timestamp: frame.timestamp });
    }
    const now = performance.now();
    const key = h.needKey || now - h.lastKeyAt > KEY_EVERY;
    if (key) h.lastKeyAt = now;
    h.needKey = false;
    try {
      h.encoder.encode(input, { keyFrame: key });
    } finally {
      if (input !== frame) input.close();
    }
    h.lastEncTs = frame.timestamp;
    h.frames++;
  }

  function configure(h, w, ht) {
    h.w = w;
    h.h = ht;
    h.reconf = false;
    if (!h.encoder || h.encoder.state === 'closed') {
      h.encoder = new VideoEncoder({
        output: (chunk) => sendChunk(h, chunk),
        error: (e) => {
          console.error(e);
          if (host !== h) return;
          if (h.codec.codec !== 'vp8') {
            // 하드웨어 인코더가 실패하면 VP8 로 다시
            h.codec = { codec: 'vp8' };
            h.encoder = null;
            h.needKey = true;
            return;
          }
          toast('영상 인코더 오류로 화면 미러링을 멈췄어요');
          stop();
        },
      });
    }
    const cfg = { codec: h.codec.codec, width: w, height: ht, bitrate: Math.round(h.q.rate), framerate: FPS[h.q.fpsI], latencyMode: 'realtime', bitrateMode: 'variable' };
    if (h.codec.avc) cfg.avc = h.codec.avc;
    if (h.codec.hardwareAcceleration) cfg.hardwareAcceleration = h.codec.hardwareAcceleration;
    h.encoder.configure(cfg);
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
      if (k && i === 0) Object.assign(m, { w: h.w, h: h.h, c: h.codec.codec });
      jam.send(m);
    }
    h.sent++;
  }

  // 화면이 그대로라 새 프레임이 안 올 때도 키프레임을 보낼 수 있게 (새 참여자 · 다시 시작)
  function kick(h) {
    h.needKey = true;
    clearTimeout(h.kickTimer);
    h.kickTimer = setTimeout(() => {
      if (host !== h || !h.needKey || h.paused || !h.lastFrame) return;
      try {
        const f = new VideoFrame(h.lastFrame, { timestamp: Math.round(performance.now() * 1000 + h.tsOffset) });
        encodeFrame(h, f);
        f.close();
      } catch (e) {
        console.error(e);
      }
    }, 250);
  }

  // ---- 서버가 알려 준 전송 상태로 프레임 · 화질 조절 ----
  function adapt(h, st) {
    const q = h.q;
    const now = performance.now();
    h.stat = st;
    const viewers = Math.max(1, Number(st.viewers) || 1);
    q.cap = Math.max(RATE_MIN, Math.min(RATE_MAX, ((Number(st.cap) || 25e6) * 8 * 0.9) / viewers / OVERHEAD));
    let changed = false;
    if (q.rate > q.cap) {
      q.rate = q.cap; // 참여자가 늘어 세션 한도(200Mbps)에 걸림
      changed = true;
    }
    if (st.bad && h.codec.codec !== 'vp8') {
      h.codec = { codec: 'vp8' }; // 참여자 중에 H.264 를 못 푸는 사람이 있음
      try { h.encoder?.close(); } catch {}
      h.encoder = null;
      changed = true;
    }
    const congested = st.drops > 0 || st.backlog > 1e6 || st.late > 600 || h.localDrops > 0;
    h.localDrops = 0;
    if (!h.paused && st.viewers > 0) {
      if (congested) {
        q.good = 0;
        if (now - q.lastChange > 1500) {
          if (q.fpsI < FPS10) q.fpsI++; // ① 초당 장수 먼저
          else if (q.rate > RATE_MIN) q.rate = Math.max(RATE_MIN, q.rate * 0.7); // ② 화질(비트레이트)
          else if (q.fpsI < FPS.length - 1) q.fpsI++; // ③ 5fps
          else if (q.scale > 0.5) q.scale -= 0.25; // ④ 해상도
          q.lastChange = now;
          changed = true;
        }
      } else if (++q.good >= 3 && now - q.lastChange > 3000) {
        let up = true;
        if (q.scale < 1) q.scale = Math.min(1, q.scale + 0.25);
        else if (q.fpsI > FPS10) q.fpsI--;
        else if (q.rate < q.cap) q.rate = Math.min(q.cap, q.rate * 1.3);
        else if (q.fpsI > 0) q.fpsI--;
        else up = false;
        if (up) {
          q.lastChange = now;
          q.good = 0;
          changed = true;
        }
      }
    }
    if (changed) h.reconf = true;
    render();
  }

  function stop(silent = false) {
    const h = host;
    host = null;
    clearInterval(guardTimer);
    if (h) {
      clearTimeout(h.kickTimer);
      clearTimeout(h.typeTimer);
      try { h.reader?.cancel(); } catch {}
      try { h.track.stop(); } catch {}
      try { h.encoder?.close(); } catch {}
      try { h.lastFrame?.close(); } catch {}
      try {
        h.tab.webview?.removeEventListener('dom-ready', h.onReady);
        h.tab.webview?.send('jam:mirror-mode', false);
      } catch {}
      jamApp.mirrorEnd().catch(() => {});
      if (!silent && jam.active) jam.send({ type: 'mirror-stop' });
    }
    $('#mirror-ctrl').hidden = true;
    render();
  }

  // ---- 호스트 입력 숨기기 ----
  function privacyReason(h) {
    const u = h.tab?.url || '';
    if (isWebUrl(u) && isSensitiveUrl(u)) return 'page';
    if (h.focus && M.isSecretField(h.focus)) return 'secret';
    if (performance.now() < h.typingUntil) return 'typing';
    return null;
  }
  function updatePrivacy(h) {
    if (host !== h) return;
    const why = privacyReason(h);
    const secret = why === 'secret' || why === 'page';
    if (why === h.paused && secret === h.secret) return;
    const resumed = !!h.paused && !why;
    h.paused = why;
    h.secret = secret;
    if (jam.active) jam.send({ type: 'mstate', paused: why, secret });
    if (resumed) kick(h);
    render();
  }
  function onPageEvent(tab, channel, arg) {
    const h = host;
    if (!h || h.tab !== tab) return;
    if (channel === 'mirror:focus') {
      h.focus = arg && typeof arg === 'object' ? arg : null;
      updatePrivacy(h);
    } else if (channel === 'mirror:typing') {
      h.typingUntil = performance.now() + 1000;
      updatePrivacy(h);
      clearTimeout(h.typeTimer);
      h.typeTimer = setTimeout(() => updatePrivacy(h), 1050);
    }
  }

  // 미러링 탭이 다른 사이트 · 로그인/결제 화면으로 가면 조작 권한을 모두 회수
  function unsafe(h) {
    const u = h.tab?.url || '';
    return isSensitiveUrl(u) || !sameSite(u, h.startUrl);
  }
  function guard() {
    if (!host || !jam.active) return;
    updatePrivacy(host);
    if (unsafe(host) && jam.room.members.some((m) => m.id !== jam.you.id && M.canControl(m.control))) {
      revokeAll('미러링 탭이 다른 사이트나 로그인 · 결제 화면으로 바뀌어서 조작 권한을 모두 회수했어요');
    }
  }
  function revokeAll(reason) {
    if (!jam.active || !jam.isHost()) return;
    let any = false;
    for (const m of jam.room.members) {
      if (m.id !== jam.you.id && M.canControl(m.control)) {
        jam.send({ type: 'control', id: m.id, control: { ...M.VIEW } });
        any = true;
      }
    }
    if (any && reason) toast(`🛑 ${reason}`);
  }
  function grant(id, control) {
    if (!jam.active || !jam.isHost() || !host) return;
    jam.send({ type: 'control', id, control: M.normControl(control) });
  }

  // ---- 참여자의 조작 넣기 (메인 프로세스가 그 탭에만, 개인정보 버튼 · 비밀 칸이면 거절) ----
  let ctrlTimer = null;
  let inputChain = Promise.resolve();
  function blocked(h, by, reason) {
    const now = Date.now();
    if (now - (h.lastBlock.get(by) || 0) < 2000) return;
    h.lastBlock.set(by, now);
    jam.send({ type: 'mblock', id: by, reason });
    const who = jam.member(by);
    toast(`🛑 ${who?.name || '참여자'}님의 조작을 막았어요: ${M.BLOCK_REASON[reason] || reason}`);
  }
  function applyInput(msg) {
    const h = host;
    if (!h || !jam.active) return;
    const who = jam.member(msg.by);
    const c = M.normControl(who?.control);
    if (!M.canControl(c)) return;
    const tab = h.tab;
    if (!tab?.webview || !tab.ready) return;
    if (unsafe(h)) return guard();
    const wv = tab.webview;
    const evs = [];
    let code = '';
    if (msg.k === 'm') {
      if (!M.canMouse(c)) return;
      const e = M.cleanMouse(msg);
      if (!e) return;
      const ev = { type: TYPES[e.t], x: Math.round(e.x * wv.clientWidth), y: Math.round(e.y * wv.clientHeight) };
      if (e.b) Object.assign(ev, { button: e.b, clickCount: e.c });
      if (e.t === 'wh') Object.assign(ev, { deltaX: -e.dx, deltaY: -e.dy });
      evs.push(ev);
    } else if (msg.k === 'k') {
      if (h.secret) return; // 비밀 칸 · 로그인 화면이면 키는 받지 않음
      if (!M.allowKey(c.k, msg.code)) return;
      const keyCode = M.electronKey(msg.code);
      if (!keyCode) return;
      code = msg.code;
      const modifiers = msg.shift ? ['shift'] : [];
      evs.push({ type: msg.t === 'd' ? 'keyDown' : 'keyUp', keyCode, modifiers });
      if (msg.t === 'd' && c.k === 'full' && typeof msg.key === 'string' && [...msg.key].length === 1) evs.push({ type: 'char', keyCode: msg.key, modifiers });
    } else return;
    inputChain = inputChain.then(async () => {
      for (const ev of evs) {
        if (host !== h) return;
        const r = await jamApp.mirrorInput(ev, code).catch(() => ({ ok: false, reason: 'off' }));
        if (!r || !r.ok) {
          if (r && r.reason && r.reason !== 'off' && r.reason !== 'bad') blocked(h, msg.by, r.reason);
          return;
        }
      }
    });
    if (msg.k === 'm' && msg.t === 'mv') return; // 움직임만으로는 표시하지 않음
    const label = $('#mirror-ctrl');
    label.textContent = `${msg.k === 'k' ? (c.k === 'full' ? '⌨' : '🎮') : '🖱'} ${who.name}님이 조작 중`;
    label.style.borderColor = who.color;
    label.hidden = false;
    clearTimeout(ctrlTimer);
    ctrlTimer = setTimeout(() => (label.hidden = true), 1500);
  }

  // ================= 참여자 =================
  let view = null;
  let fbTimer = null;

  function openView(m) {
    if (view && view.sid === m.sid) return;
    closeView();
    view = {
      sid: m.sid, by: m.by, title: m.title, configured: false, codec: '', w: 0, h: 0, waitingKey: true, lastF: -1, parts: new Map(), hidden: false,
      frames: 0, lastReq: 0, offs: [], late: 0, bad: false, paused: m.paused || null, secret: !!m.secret, fps: 0, fpsCount: 0, fpsAt: performance.now(),
    };
    newDecoder();
    $('#mirror-wait').hidden = false;
    requestKey(true);
    clearInterval(fbTimer);
    fbTimer = setInterval(feedback, 1000);
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
        v.fpsCount++;
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
    clearInterval(fbTimer);
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
  // 1초마다: 받는 지연을 호스트에게 (호스트가 화질 조절), 받는 초당 장수 표시
  function feedback() {
    const v = view;
    if (!v) return;
    const now = performance.now();
    v.fps = Math.round((v.fpsCount * 1000) / Math.max(1, now - v.fpsAt));
    v.fpsCount = 0;
    v.fpsAt = now;
    if (jam.active && v.frames > 0 && !v.hidden) jam.send({ type: 'mfb', late: Math.round(v.late), bad: v.bad });
    v.late = 0;
    $('#mirror-q').textContent = v.w ? `${v.w}×${v.h} · ${v.fps}fps` : '';
  }
  function onChunk(msg) {
    const v = view;
    if (!v || msg.sid !== v.sid) return;
    let p = v.parts.get(msg.f);
    if (!p) {
      p = { f: msg.f, n: msg.n, got: 0, k: !!msg.k, ts: msg.ts, pieces: new Array(msg.n) };
      v.parts.set(msg.f, p);
    }
    if (msg.k && msg.i === 0) Object.assign(p, { w: msg.w, h: msg.h, c: msg.c || 'vp8' });
    if (!p.pieces[msg.i]) {
      p.pieces[msg.i] = unb64(msg.d);
      p.got++;
    }
    if (p.got < p.n) return;
    v.parts.delete(p.f);
    for (const k of v.parts.keys()) if (k < p.f) v.parts.delete(k); // 덜 온 옛 프레임은 버림
    // 지연 재기: (도착 시각 - 찍은 시각) 이 최근 가장 짧았던 때보다 얼마나 늘었나 (두 컴퓨터 시계 차이는 빠짐)
    const now = performance.now();
    const off = now * 1000 - p.ts;
    v.offs.push([now, off]);
    while (v.offs.length && now - v.offs[0][0] > 15000) v.offs.shift();
    let min = Infinity;
    for (const x of v.offs) if (x[1] < min) min = x[1];
    v.late = Math.max(v.late, (off - min) / 1000);
    decode(v, p);
  }
  function decode(v, p) {
    if (p.k) {
      if (!v.configured || p.w !== v.w || p.h !== v.h || p.c !== v.codec) {
        if (v.configured) newDecoder();
        try {
          v.decoder.configure({ codec: p.c, codedWidth: p.w, codedHeight: p.h, optimizeForLatency: true });
        } catch (e) {
          console.error(e);
          v.bad = true; // 이 영상 형식을 못 풂 → 호스트가 VP8 로 바꿈
          return requestKey();
        }
        Object.assign(v, { configured: true, w: p.w, h: p.h, codec: p.c });
      }
      v.waitingKey = false;
    } else if (v.waitingKey || !v.configured || p.f !== v.lastF + 1) {
      v.waitingKey = true; // 중간이 빠졌으면 다음 키프레임까지 기다림
      return requestKey();
    }
    if (v.decoder.decodeQueueSize > 6) {
      v.waitingKey = true;
      v.late = Math.max(v.late, 1000); // 내 컴퓨터가 못 따라감 → 호스트에게 낮춰 달라고
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
  const myControl = () => M.normControl(jam.me()?.control);
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
  let secretHintAt = 0;
  function sendMouse(t, e, extra = {}) {
    if (!view || !M.canMouse(myControl())) return;
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
        if (!view || !M.canMouse(myControl())) return;
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
      const c2 = myControl();
      const mods = { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey };
      if (!M.allowKey(c2.k, e.code, mods)) return; // 허용 안 된 키는 내 앱이 평소처럼 처리 (호스트로 안 감)
      e.preventDefault();
      e.stopPropagation();
      if (view.secret) {
        // 호스트가 비밀 입력 칸 · 로그인 화면에 있음 → 내 키는 아예 내 컴퓨터 밖으로 보내지 않음
        if (t === 'd' && Date.now() - secretHintAt > 3000) {
          secretHintAt = Date.now();
          toast('🔒 호스트 화면이 비밀 입력 칸이라 키를 보내지 않았어요');
        }
        return;
      }
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
    $('#mirror-req').addEventListener('click', () => {
      if (!view || !jam.active) return;
      jam.send({ type: 'control-req' });
      const b = $('#mirror-req');
      b.disabled = true;
      b.textContent = '✋ 요청함';
      setTimeout(() => {
        b.disabled = false;
        b.textContent = '✋ 조작 요청';
      }, 15000);
      toast('호스트에게 화면 조작을 요청했어요');
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
    const stat = $('#mirror-stat');
    stat.hidden = !host;
    if (host) {
      const q = host.q;
      const st = host.stat;
      stat.textContent = host.paused
        ? `⏸ ${{ typing: '입력 중이라', secret: '비밀 입력 칸이라', page: '로그인 · 결제 화면이라' }[host.paused]} 영상을 멈춤`
        : `📶 ${host.w || '…'}×${host.h || '…'} · ${FPS[q.fpsI]}fps · 최대 ${mbps(q.rate)} · ${codecName(host.codec.codec)}${st ? ` · 참여자 ${st.viewers}명 · 실제 ${mbps((st.out || 0) * 8)}` : ''}`;
    }
    const showView = !!(active && view && !view.hidden);
    $('#mirror-view').hidden = !showView;
    $('#ov-mirror').hidden = !(active && view && view.hidden);
    if (view) {
      const owner = jam.member(view.by);
      $('#mirror-title').textContent = `🖥 ${owner?.name || '호스트'}님의 화면${view.title ? ` · ${view.title}` : ''}`;
      const c = myControl();
      const can = M.canControl(c);
      $('#mirror-level').textContent = can ? `${M.controlLabel(c)} 가능 · 화면을 누른 뒤 조작` : '보기만';
      $('#mirror-canvas').classList.toggle('can-control', can);
      $('#mirror-req').hidden = can;
      const pause = $('#mirror-pause');
      pause.hidden = !view.paused;
      pause.textContent = view.paused ? PAUSE_TEXT[view.paused] || '' : '';
    }
  }

  // 호스트: 참여자 목록의 조작 권한 (🖱 마우스 켜기 + 보낼 수 있는 키)
  function controlSelect(m) {
    if (!jam.active || !jam.isHost() || !host || m.id === jam.you.id) return null;
    const c = M.normControl(m.control);
    const box = el('input', { type: 'checkbox', class: 'mirror-mouse' });
    box.checked = c.m;
    const sel = el('select', { class: 'mirror-keys', title: '보낼 수 있는 키' }, ...M.KEYSETS.map((k) => el('option', { value: k }, M.KEY_LABEL[k])));
    sel.value = c.k;
    const update = () => {
      const next = { m: box.checked, k: sel.value };
      if (next.k === 'full' && c.k !== 'full' && !window.__mirrorNoConfirm && !confirm(`${m.name}님에게 키보드 전체 입력을 허락할까요?\n\n이 탭에 글자를 입력할 수 있게 돼요 (게시글 · 메시지 등). Ctrl/Alt 조합, F 키, 우클릭, 비밀 입력 칸, 개인정보 · 결제 버튼은 그래도 막혀요.`)) {
        sel.value = c.k;
        return;
      }
      jam.send({ type: 'control', id: m.id, control: next });
    };
    box.addEventListener('change', update);
    sel.addEventListener('change', update);
    return el('div', { class: 'mirror-ctl', title: '화면 미러링 조작 권한' }, el('label', {}, box, '🖱 마우스'), sel);
  }

  let mblockAt = 0;
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
        if (host) kick(host);
        break;
      case 'mi':
        applyInput(msg);
        break;
      case 'mstat':
        if (host) adapt(host, msg);
        break;
      case 'mstate':
        if (view && msg.sid === view.sid) {
          view.paused = msg.paused || null;
          view.secret = !!msg.secret;
          if (view.secret) releaseKeys();
          render();
        }
        break;
      case 'mblock':
        if (Date.now() - mblockAt > 2000) {
          mblockAt = Date.now();
          toast(`🛑 ${M.BLOCK_REASON[msg.reason] || '보호된 곳'}이라 원격 조작이 막혔어요`);
        }
        break;
      case 'control-req': {
        if (!host) break;
        const who = jam.member(msg.id);
        if (!who) break;
        toast(`✋ ${who.name}님이 화면 조작을 요청했어요`, [
          { label: '🖱 마우스', fn: () => grant(msg.id, { m: true, k: 'none' }) },
          { label: '🖱+🎮 게임 키', fn: () => grant(msg.id, { m: true, k: 'game' }) },
          { label: '🖱+🎮 2P', fn: () => grant(msg.id, { m: true, k: 'game2' }) },
          { label: '거절', fn: () => {} },
        ]);
        break;
      }
      case 'control': {
        const c = M.normControl(msg.control);
        if (!M.canControl(c)) releaseKeys();
        toast(M.canControl(c) ? `호스트가 화면 조작을 허락했어요: ${M.controlLabel(c)} — 화면을 누르고 조작하세요` : '화면 조작 권한이 없어졌어요');
        render();
        break;
      }
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
  return {
    start, stop, handle, onWelcome, reset, render, controlSelect, revokeAll, onPageEvent,
    ownsTab: (tab) => !!host && host.tab === tab,
    isMirroring: () => !!host,
    stats: () => ({
      host: host && { frames: host.frames, sent: host.sent, w: host.w, h: host.h, fps: FPS[host.q.fpsI], rate: Math.round(host.q.rate), scale: host.q.scale, codec: host.codec.codec, paused: host.paused, secret: host.secret, cap: Math.round(host.q.cap), stat: host.stat },
      view: view && { frames: view.frames, w: view.w, h: view.h, waitingKey: view.waitingKey, fps: view.fps, codec: view.codec, paused: view.paused, secret: view.secret },
    }),
  };
})();
window.mirror = mirror;
