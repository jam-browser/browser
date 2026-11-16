'use strict';
/**
 * Jam 동기화 서버
 *  - 앱 안에서 "내 PC에서 호스트"로 실행되거나
 *  - `node server/jam-server.js [port]` 로 단독 실행(클라우드 배포용)할 수 있다. (shared/ 폴더도 함께 올릴 것)
 *
 * 권한 규칙
 *  - 같은 사이트 안에서의 페이지 이동: 누구나
 *  - 다른 사이트로 이동: 호스트, 또는 호스트가 권한을 준 사람(개별 / 전체 허용)
 *  - 로그인·인증·결제 주소(isSensitiveUrl)는 절대 공유하지 않는다
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { sameSite, isSensitiveUrl } = require('../shared/site');
const { deriveKeys, checkProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');

const MAX_FAILURES = 8; // 잘못된 초대 코드 8번 → 10분 차단
const MAX_CONNS_PER_IP = 10;
const MAX_PENDING = 5;
const AUTH_TIMEOUT = 10000; // 접속 후 10초 안에 인증 못 하면 끊음
const APPROVAL_TIMEOUT = 120000; // 호스트 승인 대기 2분
const RESUME_TTL = 5 * 60e3; // 끊긴 뒤 5분 안에는 승인 없이 복귀
const RATE_PER_SEC = 100;
const RATE_BURST = 200;

const COLORS = ['#2ee6a6', '#ff6b6b', '#4dabf7', '#ffd43b', '#cc5de8', '#ff922b', '#20c997', '#f06595'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REACTIONS = ['👍', '😂', '😮', '❤️', '🔥', '👏'];
const MAX_MEMBERS = 16;
const MAX_QUEUE = 50;

function isWebUrl(u) {
  if (typeof u !== 'string' || u.length > 4096) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}
const isShareable = (u) => isWebUrl(u) && !isSensitiveUrl(u);

function ratio(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
function int(n, max) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, n));
}
// 화면 위치 앵커: { p: 요소 경로, fx/fy: 요소 안 위치 비율, off: 화면 가장자리에서 떨어진 px }
function anchor(a) {
  if (!a || typeof a !== 'object' || typeof a.p !== 'string' || !a.p || a.p.length > 600) return null;
  return { p: a.p, fx: ratio(a.fx), fy: ratio(a.fy), off: int(a.off, 2000) };
}
function cleanText(s, max) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function makeCode(rooms) {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

/**
 * @param localCreateOnly true 면 같은 PC(127.0.0.1)에서만 방을 만들 수 있다 — 앱의 "내 PC에서 호스트" 모드 기본값
 * @param relayKey        중계 터널(server/relay-tunnel.js)만 아는 값. 이 값을 함께 보낸 같은 PC 연결은
 *                        x-jam-relay-ip 헤더의 손님 IP 를 믿고, 차단·표시에 그 IP 를 쓴다
 */
function createJamServer({ port = 3030, host = '0.0.0.0', localCreateOnly = false, relayKey = null, log = () => {} } = {}) {
  const rooms = new Map();
  let nextId = 1;
  let nextItemId = 1;

  // ---------- 침입 방어 ----------
  const failures = new Map(); // ip → { n, first, blockedUntil } : 잘못된 초대 코드 시도
  const connsPerIp = new Map();
  const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const isBlocked = (ip) => (failures.get(ip)?.blockedUntil || 0) > Date.now();
  const sameSecret = (a, b) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  };
  // 중계로 들어온 손님은 터널이 알려 준 실제 IP 로 구분한다 ('relay:1.2.3.4')
  const clientIp = (req) => {
    const raw = req.socket.remoteAddress || '';
    const fwd = req.headers['x-jam-relay-ip'];
    if (relayKey && fwd && isLoopback(raw) && sameSecret(req.headers['x-jam-relay-key'], relayKey)) {
      return `relay:${String(fwd).slice(0, 64)}`;
    }
    return raw;
  };
  function recordFailure(ip) {
    const now = Date.now();
    let f = failures.get(ip);
    if (!f || now - f.first > 10 * 60e3) f = { n: 0, first: now, blockedUntil: 0 };
    f.n++;
    if (f.n >= MAX_FAILURES) f.blockedUntil = now + 10 * 60e3; // 10분 차단
    failures.set(ip, f);
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Jam server\n');
  });
  const wss = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    // 웹페이지(http/https 출처)가 이 서버에 접속하는 것을 막는다. Jam Browser 앱(file://)과 출처 없는 클라이언트만 허용
    verifyClient: ({ origin, req }, cb) => {
      const ip = clientIp(req);
      if (origin && origin !== 'file://' && origin !== 'null') return cb(false, 403, 'Forbidden');
      if (isBlocked(ip)) return cb(false, 429, 'Too many attempts');
      if ((connsPerIp.get(ip) || 0) >= MAX_CONNS_PER_IP) return cb(false, 429, 'Too many connections');
      cb(true);
    },
  });

  // 인증 전에는 평문(JSON), 인증 뒤에는 방 키로 암호화한 바이너리 프레임만 주고받는다
  const send = (ws, msg) => {
    if (ws.readyState !== 1) return;
    if (ws.keys) ws.send(seal(ws.keys, msg, S2C));
    else ws.send(JSON.stringify(msg));
  };
  const broadcast = (room, msg, except) => {
    for (const m of room.members.values()) if (m.ws !== except) send(m.ws, msg);
  };
  const publicMember = (m) => ({
    id: m.id, name: m.name, color: m.color, canCrossSite: m.canCrossSite, presence: m.presence, view: m.view,
  });
  const publicMembers = (room) => [...room.members.values()].map(publicMember);
  const mediaOut = (room) => (room.media ? { ...room.media, age: Date.now() - room.media.at } : null);
  const snapshot = (room) => ({
    code: room.code,
    hostId: room.hostId,
    members: publicMembers(room),
    queue: room.queue,
    current: room.current,
    settings: room.settings,
    media: mediaOut(room),
  });
  const pushMembers = (room) => broadcast(room, { type: 'members', members: publicMembers(room), hostId: room.hostId });

  const canCrossSite = (room, m) => m.id === room.hostId || room.settings.allowAllCrossSite || m.canCrossSite;
  const canGo = (room, m, url) => canCrossSite(room, m) || !room.current || sameSite(url, room.current.url);
  const NO_CROSS = { type: 'error', code: 'no-cross-site', message: '다른 사이트로 이동하려면 호스트의 권한이 필요해요.' };

  function playItem(room, item, by) {
    room.queue = room.queue.filter((q) => q.id !== item.id);
    room.current = { url: item.url, title: item.title, by: by.id };
    broadcast(room, { type: 'navigate', url: item.url, title: item.title, by: by.id });
    broadcast(room, { type: 'queue', queue: room.queue });
    broadcast(room, { type: 'system', text: `${by.name}님이 대기열에서 "${item.title || item.url}" 페이지를 열었어요` });
  }

  const hostOf = (room) => room.members.get(room.hostId);
  function sendJoinRequests(room) {
    const host = hostOf(room);
    if (!host) return;
    for (const p of room.pending.values()) send(host.ws, { type: 'join-request', id: p.id, name: p.name, ip: p.ip });
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    let room = null;
    let me = null;
    let pending = null; // { room, entry } : 호스트 승인 대기 중
    let tokens = RATE_BURST;
    let lastRefill = Date.now();
    let drops = 0;

    // 일회용 nonce: 참여자는 이 값에 비밀키로 서명해서 "키를 안다"는 것만 증명한다 (키 자체는 전송 안 함)
    const nonce = crypto.randomBytes(16).toString('base64url');
    send(ws, { type: 'hello', nonce, v: 1 });
    const authTimer = setTimeout(() => !ws.keys && ws.close(), AUTH_TIMEOUT);

    function deny(code, message) {
      send(ws, { type: 'error', code, message });
      ws.close();
    }

    function enterRoom(target, name, kind) {
      room = target;
      me = {
        id: String(nextId++),
        name,
        color: COLORS[room.colorIndex++ % COLORS.length],
        ws,
        canCrossSite: false,
        presence: { url: null, title: '', ad: false, private: false, away: false },
        view: null,
        resume: crypto.randomBytes(24).toString('base64url'), // 잠깐 끊겼다 다시 들어올 때 승인 없이 복귀용
      };
      room.members.set(me.id, me);
      if (!room.hostId) room.hostId = me.id;
      send(ws, { type: 'welcome', you: publicMember(me), resume: me.resume, room: snapshot(room) });
      broadcast(room, { type: 'members', members: publicMembers(room), hostId: room.hostId }, ws);
      if (kind === 'join') broadcast(room, { type: 'system', text: `${me.name}님이 Jam에 참여했어요` }, ws);
    }

    function authenticate(msg) {
      let name = cleanText(msg.name, 24) || '익명';
      if (msg.type === 'create') {
        // 내 PC 호스트 모드: 방은 같은 PC(앱 자신)에서만 만들 수 있다
        if (localCreateOnly && !isLoopback(ip)) return deny('forbidden', '이 서버에서는 Jam을 만들 수 없어요.');
        let keys;
        try {
          keys = deriveKeys(msg.secret);
        } catch {
          return deny('bad-secret', '잘못된 요청이에요.');
        }
        const target = {
          code: makeCode(rooms),
          keys,
          hostId: null,
          members: new Map(),
          pending: new Map(),
          resumes: new Map(),
          queue: [],
          current: isShareable(msg.url) ? { url: msg.url, title: cleanText(msg.title, 200), by: null } : null,
          settings: { allowAllCrossSite: false, requireApproval: true },
          media: null,
          colorIndex: 0,
        };
        rooms.set(target.code, target);
        log(`room ${target.code} created`);
        ws.keys = keys;
        clearTimeout(authTimer);
        return enterRoom(target, name, 'create');
      }

      // join: 방 코드 + 비밀키 증명. 틀리면 이유를 구분하지 않고 거절 (코드 존재 여부를 알려주지 않음)
      const target = rooms.get(cleanText(msg.code, 10).toUpperCase());
      if (!target || !checkProof(target.keys, nonce, target.code, msg.proof)) {
        recordFailure(ip);
        log(`bad invite from ${ip}`);
        return deny('bad-invite', '초대 코드가 올바르지 않거나 Jam이 끝났어요.');
      }
      // 이름·재접속 토큰은 방 키로 암호화해서 온다 (중계 서버가 이름을 볼 수 없게). 예전 방식(평문)도 받아준다
      let resumeToken = typeof msg.resume === 'string' ? msg.resume : null;
      if (typeof msg.p === 'string') {
        let inner;
        try {
          inner = open(target.keys, Buffer.from(msg.p, 'base64'), C2S);
        } catch {
          recordFailure(ip);
          return deny('bad-invite', '초대 코드가 올바르지 않거나 Jam이 끝났어요.');
        }
        name = cleanText(inner.name, 24) || '익명';
        resumeToken = typeof inner.resume === 'string' ? inner.resume : null;
      }
      ws.keys = target.keys;
      clearTimeout(authTimer);
      if (target.members.size + target.pending.size >= MAX_MEMBERS) return deny('full', 'Jam 인원이 가득 찼어요.');

      // 방금 끊겼던 사람(재접속)은 승인 없이 복귀
      const resume = resumeToken && target.resumes.get(resumeToken);
      if (resume && resume.expires > Date.now()) {
        target.resumes.delete(resumeToken);
        return enterRoom(target, name, 'join');
      }
      if (!target.settings.requireApproval) return enterRoom(target, name, 'join');

      // 호스트 승인 대기
      if (target.pending.size >= MAX_PENDING) return deny('busy', '참여 요청이 너무 많아요. 잠시 후 다시 시도하세요.');
      const entry = {
        id: `p${nextId++}`,
        name,
        ip: ip.replace(/^::ffff:/, ''),
        accept: () => {
          pending = null;
          enterRoom(target, name, 'join');
        },
        reject: (reason) => {
          pending = null;
          deny('rejected', reason);
        },
      };
      entry.timer = setTimeout(() => {
        if (!target.pending.delete(entry.id)) return;
        const host = hostOf(target);
        if (host) send(host.ws, { type: 'join-cancel', id: entry.id });
        entry.reject('호스트가 응답하지 않아 참여 요청이 취소됐어요.');
      }, APPROVAL_TIMEOUT);
      target.pending.set(entry.id, entry);
      pending = { room: target, entry };
      send(ws, { type: 'pending' });
      sendJoinRequests(target);
    }

    function leave() {
      if (pending) {
        const { room: r, entry } = pending;
        pending = null;
        clearTimeout(entry.timer);
        if (r.pending.delete(entry.id)) {
          const host = hostOf(r);
          if (host) send(host.ws, { type: 'join-cancel', id: entry.id });
        }
      }
      if (!room || !me) return;
      const r = room;
      r.members.delete(me.id);
      room = null;
      if (!me.kicked) r.resumes.set(me.resume, { expires: Date.now() + RESUME_TTL });
      if (r.members.size === 0) {
        for (const p of r.pending.values()) {
          clearTimeout(p.timer);
          p.reject('Jam이 끝났어요.');
        }
        rooms.delete(r.code);
        log(`room ${r.code} closed`);
        return;
      }
      if (r.hostId === me.id) {
        r.hostId = r.members.keys().next().value;
        broadcast(r, { type: 'system', text: `호스트가 나가서 ${r.members.get(r.hostId).name}님이 새 호스트가 되었어요` });
        sendJoinRequests(r);
      }
      broadcast(r, { type: 'left', id: me.id });
      pushMembers(r);
      broadcast(r, { type: 'system', text: `${me.name}님이 나갔어요` });
    }

    ws.on('message', (raw, isBinary) => {
      // 메시지 폭주 방지 (초당 100개, 순간 200개까지)
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
      lastRefill = now;
      if (tokens < 1) {
        if (++drops > 500) ws.close();
        return;
      }
      tokens--;

      let msg;
      if (!ws.keys) {
        if (isBinary) return;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg && (msg.type === 'create' || msg.type === 'join')) authenticate(msg);
        return;
      }
      if (!isBinary) return; // 인증 뒤에는 암호화된 메시지만 받는다
      try {
        msg = open(ws.keys, raw, C2S); // 키가 없거나 내용이 바뀌었으면 여기서 실패 → 무시
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string' || !room || !me) return;
      const isHost = me.id === room.hostId;

      switch (msg.type) {
        case 'navigate': {
          if (!isShareable(msg.url)) return;
          if (!canGo(room, me, msg.url)) return send(ws, NO_CROSS);
          room.current = { url: msg.url, title: cleanText(msg.title, 200), by: me.id };
          broadcast(room, { type: 'navigate', url: msg.url, title: room.current.title, by: me.id }, ws);
          break;
        }
        case 'title': {
          if (room.current && room.current.url === msg.url) {
            room.current.title = cleanText(msg.title, 200);
            broadcast(room, { type: 'current', current: room.current }, ws);
          }
          break;
        }
        case 'presence': {
          const priv = !!msg.private || (msg.url != null && !isShareable(msg.url));
          me.presence = {
            url: !priv && isShareable(msg.url) ? msg.url : null,
            title: priv ? '' : cleanText(msg.title, 200),
            ad: !!msg.ad,
            private: priv,
            away: !!msg.away,
          };
          broadcast(room, { type: 'presence', id: me.id, presence: me.presence }, ws);
          break;
        }
        case 'viewport': {
          if (msg.url == null) {
            me.view = null;
            return broadcast(room, { type: 'viewport', by: me.id, url: null }, ws);
          }
          if (!isShareable(msg.url)) return;
          me.view = {
            url: msg.url, vx: ratio(msg.vx), vy: ratio(msg.vy), vw: ratio(msg.vw), vh: ratio(msg.vh),
            top: anchor(msg.top), bot: anchor(msg.bot),
            w: int(msg.w, 20000), h: int(msg.h, 20000),
            z: Math.min(8, Math.max(0.25, Number(msg.z) || 1)),
          };
          broadcast(room, { type: 'viewport', by: me.id, ...me.view }, ws);
          break;
        }
        case 'scroll': {
          if (!isShareable(msg.url)) return;
          broadcast(room, { type: 'scroll', by: me.id, url: msg.url, x: ratio(msg.x), y: ratio(msg.y), top: anchor(msg.top) }, ws);
          break;
        }
        case 'cursor': {
          if (msg.x == null) return broadcast(room, { type: 'cursor', by: me.id, x: null }, ws);
          if (!isShareable(msg.url)) return;
          broadcast(room, { type: 'cursor', by: me.id, url: msg.url, x: ratio(msg.x), y: ratio(msg.y), a: anchor(msg.a) }, ws);
          break;
        }
        case 'click': {
          if (!isShareable(msg.url)) return;
          broadcast(room, { type: 'click', by: me.id, url: msg.url, x: ratio(msg.x), y: ratio(msg.y), a: anchor(msg.a) }, ws);
          break;
        }
        case 'media': {
          if (!isShareable(msg.url)) return;
          const time = Number(msg.time);
          if (!Number.isFinite(time) || time < 0 || time > 1e7) return;
          const rate = Math.min(4, Math.max(0.25, Number(msg.rate) || 1));
          room.media = { url: msg.url, playing: !!msg.playing, time, rate, by: me.id, at: Date.now() };
          broadcast(room, { type: 'media', ...mediaOut(room) }, ws);
          break;
        }
        case 'chat': {
          const text = cleanText(msg.text, 500);
          if (!text) return;
          broadcast(room, { type: 'chat', by: me.id, name: me.name, color: me.color, text, at: Date.now() });
          break;
        }
        case 'reaction': {
          if (!REACTIONS.includes(msg.emoji)) return;
          broadcast(room, { type: 'reaction', by: me.id, emoji: msg.emoji, color: me.color });
          break;
        }
        case 'queue:add': {
          if (!isShareable(msg.url)) return;
          if (room.queue.length >= MAX_QUEUE)
            return send(ws, { type: 'error', code: 'queue-full', message: '대기열이 가득 찼어요.' });
          const item = {
            id: String(nextItemId++),
            url: msg.url,
            title: cleanText(msg.title, 200),
            addedBy: me.id,
            addedByName: me.name,
            color: me.color,
          };
          room.queue.push(item);
          broadcast(room, { type: 'queue', queue: room.queue });
          broadcast(room, { type: 'system', text: `${me.name}님이 대기열에 "${item.title || item.url}"을(를) 추가했어요` }, ws);
          break;
        }
        case 'queue:remove': {
          const item = room.queue.find((q) => q.id === msg.id);
          if (!item || (!isHost && item.addedBy !== me.id)) return;
          room.queue = room.queue.filter((q) => q.id !== item.id);
          broadcast(room, { type: 'queue', queue: room.queue });
          break;
        }
        case 'queue:play':
        case 'queue:next': {
          const item = msg.type === 'queue:next' ? room.queue[0] : room.queue.find((q) => q.id === msg.id);
          if (!item) return;
          if (!canGo(room, me, item.url)) return send(ws, NO_CROSS);
          playItem(room, item, me);
          break;
        }
        case 'settings': {
          if (!isHost) return;
          if (typeof msg.allowAllCrossSite === 'boolean' && msg.allowAllCrossSite !== room.settings.allowAllCrossSite) {
            room.settings.allowAllCrossSite = msg.allowAllCrossSite;
            broadcast(room, {
              type: 'system',
              text: room.settings.allowAllCrossSite
                ? '이제 모든 참여자가 다른 사이트로 이동할 수 있어요'
                : '이제 권한을 받은 사람만 다른 사이트로 이동할 수 있어요',
            });
          }
          if (typeof msg.requireApproval === 'boolean') room.settings.requireApproval = msg.requireApproval;
          broadcast(room, { type: 'settings', settings: room.settings });
          break;
        }
        case 'approve': {
          if (!isHost) return;
          const entry = room.pending.get(String(msg.id));
          if (!entry) return;
          room.pending.delete(entry.id);
          clearTimeout(entry.timer);
          if (msg.ok) entry.accept();
          else entry.reject('호스트가 참여를 거절했어요.');
          break;
        }
        case 'perm': {
          const target = room.members.get(String(msg.id));
          if (!isHost || !target || target.id === room.hostId) return;
          target.canCrossSite = !!msg.canCrossSite;
          pushMembers(room);
          broadcast(room, {
            type: 'system',
            text: target.canCrossSite
              ? `${target.name}님에게 다른 사이트 이동 권한을 줬어요`
              : `${target.name}님의 다른 사이트 이동 권한을 거뒀어요`,
          });
          break;
        }
        case 'kick': {
          const target = room.members.get(String(msg.id));
          if (!isHost || !target || target.id === me.id) return;
          target.kicked = true; // 재접속 토큰도 무효
          send(target.ws, { type: 'kicked' });
          target.ws.close();
          break;
        }
        case 'end': {
          if (!isHost) return;
          const r = room;
          broadcast(r, { type: 'ended' });
          for (const m of r.members.values()) if (m.ws !== ws) m.ws.close();
          for (const p of r.pending.values()) {
            clearTimeout(p.timer);
            p.reject('Jam이 끝났어요.');
          }
          r.pending.clear();
          r.resumes.clear();
          r.members.clear();
          rooms.delete(r.code);
          room = null;
          log(`room ${r.code} ended by host`);
          break;
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      const n = (connsPerIp.get(ip) || 1) - 1;
      if (n <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n);
      leave();
    });
    ws.on('error', () => {});
  });

  // 끊긴 연결 정리 + 만료된 재접속 토큰/차단 기록 정리
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) for (const [t, v] of r.resumes) if (v.expires < now) r.resumes.delete(t);
    for (const [ip, f] of failures) if (f.blockedUntil < now && now - f.first > 10 * 60e3) failures.delete(ip);
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      // 지정한 포트가 사용 중이면 아무 빈 포트로 다시 시도
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        server.once('error', reject);
        server.listen(0, host);
      } else {
        reject(err);
      }
    };
    server.on('error', onError);
    server.on('listening', () => {
      server.removeAllListeners('error');
      server.on('error', (e) => log(`server error: ${e.message}`));
      resolve({ port: server.address().port, close, rooms });
    });
    server.listen(port, host);
  });
}

module.exports = { createJamServer, isWebUrl };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 3030);
  createJamServer({ port, log: (m) => console.log(`[jam] ${m}`) }).then(({ port: p }) => {
    console.log(`[jam] Jam 서버가 포트 ${p}에서 실행 중입니다`);
  });
}
