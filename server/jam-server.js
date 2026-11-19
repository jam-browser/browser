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
const { sameSite, sameDoc, isSensitiveUrl } = require('../shared/site');
const { deriveKeys, checkProof, seal, open, C2S, S2C } = require('../shared/jam-crypto');
const ID = require('../shared/identity');
const PAIR = require('../shared/pairing');
const MIRROR = require('../shared/mirror');

// 입장 방식: approval = 링크 + 호스트 승인(기본) · friends = 링크를 가진 친구만(자동 입장) · open = 링크만 있으면 자유 입장
const ACCESS = new Set(['approval', 'friends', 'open']);
const cleanAllow = (list) => new Set((Array.isArray(list) ? list : []).filter((x) => /^[A-Z0-9]{24}$/.test(String(x))).slice(0, 500));

const MAX_CONNS_PER_IP = 10;
const AUTH_TIMEOUT = 10000; // 접속 후 10초 안에 인증 못 하면 끊음
const RATE_PER_SEC = 100;
const RATE_BURST = 200;
// 화면 미러링 영상처럼 큰 메시지(4KB 넘음)는 개수 대신 바이트로 제한 (연결 하나당 초당 4MB, 순간 8MB)
const BIG_MSG = 4096;
const BYTE_RATE = 4 * 1024 * 1024;
const BYTE_BURST = 8 * 1024 * 1024;
const MIRROR_BACKLOG = 8 * 1024 * 1024; // 받는 쪽에 이만큼 쌓이면 영상 조각을 건너뛰고 다음 키프레임부터
// 미러링하는 사람은 영상을 올려야 하니 한도를 더 줌 (최대 20Mbps 영상 + base64 · 암호화 덧붙임)
const OWNER_BYTE_RATE = 64 * 1024 * 1024;
const OWNER_BYTE_BURST = 128 * 1024 * 1024;
const PAIR_TIMEOUT = 30000; // 페어링: 키 교환 뒤 요청까지
const TICKET_TTL = 60e3; // 페어링으로 받은 일회용 입장권 유효 시간

// 같은 네트워크(사설 · 링크 로컬 · 이 PC) 주소인지. 근처 페어링은 여기서 온 직접 연결만 받는다 (중계 서버 경유 X)
function isPrivateIp(raw) {
  const ip = String(raw || '').replace(/^::ffff:/, '');
  if (ip.startsWith('relay:')) return false;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return ip === '::1' || /^(fc|fd|fe80)/i.test(ip);
}

const COLORS = ['#2ee6a6', '#ff6b6b', '#4dabf7', '#ffd43b', '#cc5de8', '#ff922b', '#20c997', '#f06595'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PING_KINDS = new Set(['here', 'look', 'warn']);
const REACTIONS = ['👍', '😂', '😮', '❤️', '🔥', '👏'];

function isWebUrl(u) {
  if (typeof u !== 'string' || u.length > 4096) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}
// 같이 보는 파일: jamfile://<파일ID>/... (호스트가 공유한 파일, 각자 PC 메모리에서 열림)
const FID_RE = /^[a-z0-9]{16}$/;
const isJamFileUrl = (u) => typeof u === 'string' && u.length < 2048 && /^jamfile:\/\/[a-z0-9]{16}(\/\S*)?$/.test(u);
const fidOf = (u) => (isJamFileUrl(u) ? u.slice(10, 26) : null);
const isShareable = (u) => (isWebUrl(u) && !isSensitiveUrl(u)) || isJamFileUrl(u);
const FILE_PIECE = 32 * 1024;
const FILE_KINDS = new Set(['pdf', 'html', 'image', 'text', 'swf']);
const FILE_BACKLOG = 512 * 1024;

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
// 화면 위치 앵커: { p: 요소 경로, fx/fy: 요소 안 위치 비율, off: 화면 가장자리에서 떨어진 px,
//   t/o/ch/cx/cy: 그 요소의 t번째 글자 노드의 o번째 글자(ch)와 글자 안 위치 비율, alt: 예비 앵커 }
function anchor(a, nested = false) {
  if (!a || typeof a !== 'object' || typeof a.p !== 'string' || !a.p || a.p.length > 600) return null;
  const out = { p: a.p, fx: ratio(a.fx), fy: ratio(a.fy), off: int(a.off, 2000) };
  if (Number.isInteger(a.t) && Number.isInteger(a.o) && a.t >= 0 && a.t < 10000 && a.o >= 0 && a.o < 1e6) {
    Object.assign(out, { t: a.t, o: a.o, cx: ratio(a.cx), cy: ratio(a.cy) });
    if (typeof a.ch === 'string') out.ch = a.ch.slice(0, 2);
  }
  if (!nested && Array.isArray(a.alt)) {
    const alt = a.alt.slice(0, 3).map((x) => anchor(x, true)).filter(Boolean);
    if (alt.length) out.alt = alt;
  }
  return out;
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
// 설정으로 바꿀 수 있는 한도 (shared/prefs.js 의 serverLimits 와 같은 이름). 기본은 넉넉하게
const DEFAULT_LIMITS = {
  maxMembers: 64,
  maxPending: 10,
  approvalMs: 120000,
  resumeMs: 5 * 60e3,
  maxQueue: 200,
  maxFailures: 8,
  blockMs: 10 * 60e3,
  mirrorRate: 0, // 한 Jam 영상 합계 (초당 바이트), 0 = 제한 없음
  fileMax: 2048 * 1024 * 1024,
  fileRoomMax: 8192 * 1024 * 1024,
  fileMaxCount: 100,
  filePerTick: 4,
};
const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
function cleanLimits(o = {}) {
  const d = DEFAULT_LIMITS;
  return {
    maxMembers: num(o.maxMembers, d.maxMembers, 2, 64),
    maxPending: num(o.maxPending, d.maxPending, 1, 50),
    approvalMs: num(o.approvalMs, d.approvalMs, 5000, 3600e3),
    resumeMs: num(o.resumeMs, d.resumeMs, 0, 24 * 3600e3),
    maxQueue: num(o.maxQueue, d.maxQueue, 1, 5000),
    maxFailures: num(o.maxFailures, d.maxFailures, 1, 1000),
    blockMs: num(o.blockMs, d.blockMs, 1000, 7 * 24 * 3600e3),
    mirrorRate: num(o.mirrorRate, d.mirrorRate, 0, 1e12),
    fileMax: num(o.fileMax, d.fileMax, 1024, 64 * 1024 ** 3),
    fileRoomMax: num(o.fileRoomMax, d.fileRoomMax, 1024, 1024 ** 4),
    fileMaxCount: num(o.fileMaxCount, d.fileMaxCount, 1, 10000),
    filePerTick: num(o.filePerTick, d.filePerTick, 1, 64),
  };
}

function createJamServer({ port = 3030, host = '0.0.0.0', localCreateOnly = false, relayKey = null, log = () => {}, mirrorRate, limits = {} } = {}) {
  const L = cleanLimits({ ...limits, ...(mirrorRate !== undefined ? { mirrorRate } : {}) });
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
    if (f.n >= L.maxFailures) f.blockedUntil = now + L.blockMs; // 설정한 시간 동안 차단
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
    verified: !!m.fp, // 브라우저 계정 서명으로 신원이 확인됨
    control: MIRROR.normControl(m.control), // 화면 미러링 조작 권한 { m: 마우스, k: 키 묶음 }
    friend: !!m.friend, // 호스트의 친구 목록에 있음
  });
  // 설정은 참여자에게 보낼 때 호스트의 친구 목록(allow)을 빼고 보낸다
  const publicSettings = (room) => ({
    allowAllCrossSite: room.settings.allowAllCrossSite,
    access: room.settings.access,
    requireApproval: room.settings.access === 'approval',
  });
  const publicMembers = (room) => [...room.members.values()].map(publicMember);
  const mediaOut = (room) => (room.media ? { ...room.media, age: Date.now() - room.media.at } : null);
  const snapshot = (room) => ({
    code: room.code,
    hostId: room.hostId,
    members: publicMembers(room),
    queue: room.queue,
    current: room.current,
    settings: publicSettings(room),
    media: mediaOut(room),
    mirror: room.mirror || null,
    files: [...room.files.values()].map(publicFile),
  });
  const publicFile = (f) => ({ ...f.meta, ready: !!f.ready });
  // 파일 내려보내기: 참여자마다 줄을 세워 조금씩 (밀리면 기다림)
  let filePump = null;
  function pumpFiles() {
    let busy = false;
    for (const r of rooms.values()) {
      for (const m of r.members.values()) {
        const q = m.fileQ;
        if (!q || !q.length) continue;
        busy = true;
        for (let k = 0; k < L.filePerTick && q.length; k++) {
          if (m.ws.readyState !== 1) {
            q.length = 0;
            break;
          }
          if (m.ws.bufferedAmount > FILE_BACKLOG) break;
          const job = q[0];
          const f = r.files.get(job.fid);
          if (!f || !f.ready) {
            q.shift();
            continue;
          }
          const piece = f.data.subarray(job.i * FILE_PIECE, (job.i + 1) * FILE_PIECE);
          send(m.ws, { type: 'file-down', fid: job.fid, i: job.i, n: f.n, d: piece.toString('base64') });
          if (++job.i >= f.n) q.shift();
        }
      }
    }
    if (!busy) {
      clearInterval(filePump);
      filePump = null;
    }
  }
  const startFilePump = () => {
    if (!filePump) filePump = setInterval(pumpFiles, 20);
  };
  function removeFile(room, fid) {
    if (!room.files.delete(fid)) return;
    for (const m of room.members.values()) if (m.fileQ) m.fileQ = m.fileQ.filter((j) => j.fid !== fid);
    broadcast(room, { type: 'file-removed', fid });
  }
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
  // 미러링하는 사람에게 키프레임 요청 (방마다 1초에 한 번까지)
  function askKeyframe(room, force) {
    const owner = room.mirror && room.members.get(room.mirror.by);
    if (!owner) return;
    const now = Date.now();
    if (!force && now - room.lastKeyReq < 1000) return;
    room.lastKeyReq = now;
    send(owner.ws, { type: 'mkey' });
  }
  // 세션 영상 한도 (200Mbps) — 넘으면 그 참여자는 다음 키프레임까지 건너뜀
  function roomBudget(room, size) {
    const now = Date.now();
    const rate = L.mirrorRate;
    if (!rate) return true; // 제한 없음
    const b = room.mbudget || (room.mbudget = { bytes: rate, at: now });
    b.bytes = Math.min(rate, b.bytes + ((now - b.at) / 1000) * rate); // 순간 한도도 1초 분량
    b.at = now;
    if (b.bytes < size) return false;
    b.bytes -= size;
    return true;
  }
  // 미러링하는 사람에게 1초마다 전송 상태를 알려 줌 → 앱이 프레임 · 화질을 조절
  function mirrorStat(room, owner) {
    const now = Date.now();
    const st = room.mstat || (room.mstat = { at: now, out: 0, drops: 0 });
    if (now - st.at < 1000) return;
    let backlog = 0;
    let late = 0;
    let viewers = 0;
    let bad = false;
    for (const m of room.members.values()) {
      if (m === owner) continue;
      viewers++;
      backlog = Math.max(backlog, m.ws.bufferedAmount || 0);
      if (now - (m.mfbAt || 0) < 5000) {
        late = Math.max(late, m.mlate || 0);
        bad = bad || !!m.mbad;
      }
    }
    send(owner.ws, { type: 'mstat', viewers, backlog, late, bad, drops: st.drops, out: Math.round((st.out * 1000) / (now - st.at)), cap: L.mirrorRate });
    room.mstat = { at: now, out: 0, drops: 0 };
  }
  function endMirror(room) {
    if (!room.mirror) return;
    room.mirror = null;
    room.mstat = null;
    for (const m of room.members.values()) {
      m.control = { ...MIRROR.VIEW };
      m.needKey = true;
      m.lastCtrlReq = 0;
    }
    broadcast(room, { type: 'mirror', mirror: null });
    pushMembers(room);
  }
  function sendJoinRequests(room) {
    const host = hostOf(room);
    if (!host) return;
    for (const p of room.pending.values()) {
      send(host.ws, { type: 'join-request', id: p.id, name: p.name, ip: p.ip, fp: p.fp, friend: p.friend, pair: !!p.pair, sas: p.sas || null });
    }
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    let room = null;
    let me = null;
    let pending = null; // { room, entry } : 호스트 승인 대기 중
    let pairState = null; // 근처 페어링 중: { target, th, key, sas }
    let tokens = RATE_BURST;
    let lastRefill = Date.now();
    let bytes = BYTE_BURST;
    let drops = 0;

    // 일회용 nonce: 참여자는 이 값에 비밀키로 서명해서 "키를 안다"는 것만 증명한다 (키 자체는 전송 안 함)
    const nonce = crypto.randomBytes(16).toString('base64url');
    send(ws, { type: 'hello', nonce, v: 1 });
    let authTimer = setTimeout(() => !ws.keys && ws.close(), AUTH_TIMEOUT);

    function deny(code, message) {
      send(ws, { type: 'error', code, message });
      ws.close();
    }

    function enterRoom(target, name, kind, who = {}) {
      room = target;
      me = {
        id: String(nextId++),
        name,
        fp: who.fp || null,
        friend: !!who.friend,
        color: COLORS[room.colorIndex++ % COLORS.length],
        ws,
        canCrossSite: false,
        presence: { url: null, title: '', ad: false, private: false, away: false },
        view: null,
        control: { ...MIRROR.VIEW },
        needKey: true, // 화면 미러링: 키프레임부터 받아야 함
        resume: crypto.randomBytes(24).toString('base64url'), // 잠깐 끊겼다 다시 들어올 때 승인 없이 복귀용
      };
      room.members.set(me.id, me);
      if (!room.hostId) room.hostId = me.id;
      send(ws, { type: 'welcome', you: publicMember(me), resume: me.resume, room: snapshot(room) });
      broadcast(room, { type: 'members', members: publicMembers(room), hostId: room.hostId }, ws);
      if (kind === 'join') broadcast(room, { type: 'system', text: `${me.name}님이 Jam에 참여했어요` }, ws);
      if (room.mirror) askKeyframe(room, true); // 새로 온 사람도 바로 화면을 볼 수 있게
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
          secret: String(msg.secret), // 근처 페어링으로 수락한 사람에게만 (페어링 키로 암호화해서) 건네준다
          tickets: new Map(), // 페어링 수락 → 일회용 입장권
          hostId: null,
          members: new Map(),
          pending: new Map(),
          resumes: new Map(),
          queue: [],
          current: isShareable(msg.url) ? { url: msg.url, title: cleanText(msg.title, 200), by: null } : null,
          settings: { allowAllCrossSite: false, access: ACCESS.has(msg.access) ? msg.access : 'approval' },
          allow: cleanAllow(msg.allow), // 호스트의 친구 지문 목록 (호스트 PC 안에서만, 참여자에게 보내지 않음)
          media: null,
          mirror: null, // 화면 미러링: { sid, by, w, h, title, at }
          files: new Map(), // 같이 보는 파일: fid → { meta, n, chunks, got, ready, data }
          lastKeyReq: 0,
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
      let who = {};
      let ticket = null;
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
        ticket = typeof inner.ticket === 'string' ? inner.ticket : null;
        // 브라우저 계정 신원: 이 연결의 nonce + 방 코드에 대한 서명이어야 한다 (사칭 · 재사용 방지)
        if (inner.id) {
          if (!ID.verifyJoin(inner.id.pub, inner.id.sig, nonce, target.code)) {
            return deny('bad-identity', '신원 확인에 실패했어요.');
          }
          who = { fp: ID.fingerprint(inner.id.pub) };
          who.friend = target.allow.has(who.fp);
        }
      }
      ws.keys = target.keys;
      clearTimeout(authTimer);
      if (target.members.size + target.pending.size >= L.maxMembers) return deny('full', 'Jam 인원이 가득 찼어요.');

      // 방금 끊겼던 사람(재접속)은 승인 없이 복귀
      const resume = resumeToken && target.resumes.get(resumeToken);
      if (resume && resume.expires > Date.now()) {
        target.resumes.delete(resumeToken);
        return enterRoom(target, name, 'join', who);
      }
      // 근처 페어링에서 호스트가 이미 수락한 사람 (일회용)
      const t = ticket && target.tickets.get(ticket);
      if (t) {
        target.tickets.delete(ticket);
        if (t.exp > Date.now()) return enterRoom(target, name, 'join', who.fp ? who : t.who);
      }
      const access = target.settings.access;
      if (access === 'friends') {
        if (!who.friend) {
          return deny('not-friend', '이 Jam 은 호스트의 친구만 들어올 수 있어요. 브라우저 계정에 로그인하고 호스트와 친구 코드를 주고받았는지 확인하세요.');
        }
        return enterRoom(target, name, 'join', who); // 친구는 승인 없이 바로
      }
      if (access === 'open') return enterRoom(target, name, 'join', who);

      // 호스트 승인 대기
      return requestApproval(target, name, who, {}, () => enterRoom(target, name, 'join', who));
    }

    function requestApproval(target, name, who, extra, onAccept) {
      if (target.pending.size >= L.maxPending) return deny('busy', '참여 요청이 너무 많아요. 잠시 후 다시 시도하세요.');
      const entry = {
        id: `p${nextId++}`,
        name,
        ip: ip.replace(/^::ffff:/, ''),
        fp: who.fp || null,
        friend: !!who.friend,
        ...extra,
        accept: () => {
          pending = null;
          onAccept();
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
      }, L.approvalMs);
      target.pending.set(entry.id, entry);
      pending = { room: target, entry };
      send(ws, { type: 'pending' });
      sendJoinRequests(target);
    }

    // ---------- 근처 페어링 (초대 링크 없이, 같은 네트워크에서) ----------
    function pairStart(msg) {
      if (pairState || ws.keys) return;
      if (!isPrivateIp(ip)) return deny('forbidden', '근처 페어링은 같은 네트워크에서만 할 수 있어요.');
      const target = rooms.get(cleanText(msg.code, 10).toUpperCase());
      if (!target) {
        recordFailure(ip);
        return deny('bad-invite', '초대 코드가 올바르지 않거나 Jam이 끝났어요.');
      }
      const eph = PAIR.newEphemeral();
      const th = PAIR.transcript(String(msg.epk || ''), eph.pub, nonce, target.code);
      const d = PAIR.derive(eph.priv, msg.epk, th);
      if (!d) return deny('bad-request', '잘못된 요청이에요.');
      pairState = { target, th, key: d.key, sas: d.sas };
      clearTimeout(authTimer);
      authTimer = setTimeout(() => !ws.keys && !pending && ws.close(), PAIR_TIMEOUT);
      send(ws, { type: 'pair-hello', epk: eph.pub });
    }

    function pairRequest(msg) {
      const ps = pairState;
      if (!ps || ps.requested) return;
      ps.requested = true;
      const inner = PAIR.openBox(ps.key, msg.box);
      if (!inner || typeof inner !== 'object') return deny('bad-request', '잘못된 요청이에요.');
      const target = ps.target;
      if (rooms.get(target.code) !== target) return deny('bad-invite', '초대 코드가 올바르지 않거나 Jam이 끝났어요.');
      let who = {};
      if (inner.id) {
        if (!ID.verifyPair(inner.id.pub, inner.id.sig, ps.th)) return deny('bad-identity', '신원 확인에 실패했어요.');
        who = { fp: ID.fingerprint(inner.id.pub) };
        who.friend = target.allow.has(who.fp);
      }
      const name = cleanText(inner.name, 24) || '익명';
      if (target.members.size + target.pending.size >= L.maxMembers) return deny('full', 'Jam 인원이 가득 찼어요.');
      // 수락 → 이 연결의 페어링 키로 초대 비밀키 + 일회용 입장권을 암호화해서 건넨다
      const grant = () => {
        const ticket = crypto.randomBytes(24).toString('base64url');
        target.tickets.set(ticket, { who, exp: Date.now() + TICKET_TTL });
        send(ws, { type: 'pair-ok', box: PAIR.sealBox(ps.key, { secret: target.secret, ticket }) });
        ps.key.fill(0);
        setTimeout(() => ws.close(), 2000);
      };
      clearTimeout(authTimer);
      if (target.settings.access === 'friends') {
        if (!who.friend) {
          return deny('not-friend', '이 Jam 은 호스트의 친구만 들어올 수 있어요. 브라우저 계정에 로그인하고 호스트와 친구 코드를 주고받았는지 확인하세요.');
        }
        return grant(); // 친구는 서명으로 확인됐으니 바로
      }
      // 링크 없이 온 요청은 "자유 입장" 이어도 호스트가 확인 코드를 보고 수락해야 한다
      return requestApproval(target, name, who, { pair: true, sas: ps.sas }, grant);
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
      if (r.mirror && r.mirror.by === me.id) endMirror(r); // 미러링하던 사람이 나가면 미러링 끝
      room = null;
      if (!me.kicked && L.resumeMs > 0) r.resumes.set(me.resume, { expires: Date.now() + L.resumeMs });
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
      const dt = (now - lastRefill) / 1000;
      tokens = Math.min(RATE_BURST, tokens + dt * RATE_PER_SEC);
      const owner = !!(room && me && ((room.mirror && room.mirror.by === me.id) || room.hostId === me.id));
      bytes = Math.min(owner ? OWNER_BYTE_BURST : BYTE_BURST, bytes + dt * (owner ? OWNER_BYTE_RATE : BYTE_RATE));
      lastRefill = now;
      const size = raw.length || raw.byteLength || 0;
      if (size > BIG_MSG) {
        if (bytes < size) {
          if (++drops > 500) ws.close();
          return;
        }
        bytes -= size;
      } else {
        if (tokens < 1) {
          if (++drops > 500) ws.close();
          return;
        }
        tokens--;
      }

      let msg;
      if (!ws.keys) {
        if (isBinary) return;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (msg && (msg.type === 'create' || msg.type === 'join')) authenticate(msg);
        else if (msg && msg.type === 'pair') pairStart(msg);
        else if (msg && msg.type === 'pair-req') pairRequest(msg);
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
        // ---------- 화면 미러링 ----------
        case 'mirror-start': {
          if (!isHost) return;
          const sid = String(msg.sid || '');
          const w = int(msg.w, 4096);
          const h = int(msg.h, 4096);
          if (!/^[A-Za-z0-9]{6,24}$/.test(sid) || w < 16 || h < 16) return;
          room.mirror = { sid, by: me.id, w, h, title: cleanText(msg.title, 200), at: Date.now(), paused: null, secret: false };
          room.mstat = null;
          for (const m of room.members.values()) {
            m.control = { ...MIRROR.VIEW };
            m.needKey = true;
          }
          broadcast(room, { type: 'mirror', mirror: room.mirror });
          broadcast(room, { type: 'system', text: `${me.name}님이 화면 미러링을 시작했어요 (${room.mirror.title || '탭'})` });
          pushMembers(room);
          break;
        }
        case 'mirror-stop': {
          if (!room.mirror || (room.mirror.by !== me.id && !isHost)) return;
          endMirror(room);
          broadcast(room, { type: 'system', text: '화면 미러링이 끝났어요' });
          break;
        }
        case 'mv': {
          // 영상 조각: 미러링하는 사람만 보낼 수 있고, 다른 참여자에게 그대로 전달
          const mir = room.mirror;
          if (!mir || mir.by !== me.id || msg.sid !== mir.sid) return;
          const fr = Number(msg.f);
          const i = Number(msg.i);
          const n = Number(msg.n);
          if (!Number.isInteger(fr) || fr < 0 || !Number.isInteger(n) || n < 1 || n > 256 || !Number.isInteger(i) || i < 0 || i >= n) return;
          if (typeof msg.d !== 'string' || msg.d.length > 45000 || !Number.isFinite(Number(msg.ts))) return;
          const key = !!msg.k;
          const out = { type: 'mv', sid: mir.sid, f: fr, k: key, i, n, ts: Number(msg.ts), d: msg.d };
          if (key && i === 0) {
            out.w = int(msg.w, 4096);
            out.h = int(msg.h, 4096);
            out.c = /^(vp8|avc1\.[0-9A-Fa-f]{6})$/.test(String(msg.c || '')) ? msg.c : 'vp8'; // 영상 형식
            mir.w = out.w || mir.w;
            mir.h = out.h || mir.h;
          }
          let wantKey = false;
          const st = room.mstat || (room.mstat = { at: Date.now(), out: 0, drops: 0 });
          const size = msg.d.length + 200;
          for (const m of room.members.values()) {
            if (m.ws === ws) continue;
            if (m.ws.bufferedAmount > MIRROR_BACKLOG) {
              m.needKey = true; // 너무 밀림 → 건너뛰고 다음 키프레임부터
              wantKey = true;
              st.drops++;
              continue;
            }
            if (m.needKey) {
              if (!(key && i === 0)) {
                wantKey = true;
                continue;
              }
            }
            if (!roomBudget(room, size)) {
              m.needKey = true; // 세션 한도(200Mbps)를 넘음 → 이 참여자는 다음 키프레임부터
              wantKey = true;
              st.drops++;
              continue;
            }
            m.needKey = false;
            st.out += size;
            send(m.ws, out);
          }
          if (wantKey) askKeyframe(room, false);
          mirrorStat(room, me);
          break;
        }
        case 'mkey': {
          if (!room.mirror || room.mirror.by === me.id) return;
          me.needKey = true;
          askKeyframe(room, false);
          break;
        }
        case 'mfb': {
          // 참여자가 알려 주는 영상 지연(ms) → 미러링하는 사람의 화질 조절에 씀
          if (!room.mirror || room.mirror.by === me.id) return;
          const late = Number(msg.late);
          if (!Number.isFinite(late)) return;
          me.mlate = Math.max(0, Math.min(60000, Math.round(late)));
          me.mbad = msg.bad === true; // 이 영상 형식을 못 풂
          me.mfbAt = Date.now();
          break;
        }
        case 'mblock': {
          // 미러링하는 사람 → 그 참여자에게만: 조작이 개인정보 버튼 · 비밀 칸이라 막혔음
          const mir = room.mirror;
          if (!mir || mir.by !== me.id) return;
          const target = room.members.get(String(msg.id));
          const reason = ['pw', 'frame', 'secret', 'login', 'button', 'unknown'].includes(msg.reason) ? msg.reason : 'unknown';
          if (target && target !== me) send(target.ws, { type: 'mblock', reason });
          break;
        }
        case 'mstate': {
          // 미러링하는 사람: 영상 잠시 멈춤 (호스트가 입력 중 · 비밀 입력 칸 · 로그인 화면) 상태를 알림
          const mir = room.mirror;
          if (!mir || mir.by !== me.id) return;
          const why = ['typing', 'secret', 'page'].includes(msg.paused) ? msg.paused : null;
          mir.paused = why;
          mir.secret = !!msg.secret;
          broadcast(room, { type: 'mstate', sid: mir.sid, paused: why, secret: mir.secret }, ws);
          break;
        }
        case 'control': {
          // 호스트가 참여자의 조작 권한을 정함 { m: 마우스, k: 키 묶음 }
          if (!isHost || !room.mirror) return;
          const target = room.members.get(String(msg.id));
          if (!target || target.id === room.mirror.by) return;
          target.control = MIRROR.normControl(msg.control);
          send(target.ws, { type: 'control', control: target.control });
          pushMembers(room);
          break;
        }
        case 'control-req': {
          // 참여자가 조작을 요청 → 호스트에게만 (15초에 한 번)
          if (!room.mirror || isHost || room.mirror.by === me.id) return;
          const now = Date.now();
          if (now - (me.lastCtrlReq || 0) < 15000) return;
          me.lastCtrlReq = now;
          const h = hostOf(room);
          if (h) send(h.ws, { type: 'control-req', id: me.id, name: me.name });
          break;
        }
        case 'mi': {
          // 참여자의 조작 → 미러링하는 사람에게만 (권한 안에서, 서버에서도 한 번 거름)
          const mir = room.mirror;
          const c = MIRROR.normControl(me.control);
          if (!mir || mir.by === me.id || !MIRROR.canControl(c)) return;
          const owner = room.members.get(mir.by);
          if (!owner) return;
          if (msg.k === 'm') {
            if (!MIRROR.canMouse(c)) return;
            const mouse = MIRROR.cleanMouse(msg);
            if (mouse) send(owner.ws, { type: 'mi', by: me.id, k: 'm', ...mouse });
          } else if (msg.k === 'k') {
            if (mir.secret) return; // 호스트가 비밀 입력 칸에 있으면 키는 받지 않음
            if ((msg.t !== 'd' && msg.t !== 'u') || !MIRROR.allowKey(c.k, msg.code, msg.mods)) return;
            const ch = c.k === 'full' && typeof msg.key === 'string' && [...msg.key].length === 1 ? msg.key : undefined;
            send(owner.ws, { type: 'mi', by: me.id, k: 'k', t: msg.t, code: MIRROR.mapKey(c.k, msg.code), key: ch, shift: !!(msg.mods && msg.mods.shift) });
          }
          break;
        }
        // ---------- 같이 보는 파일 ----------
        case 'file-offer': {
          // 호스트만. 파일 정보 → 다들 목록에 표시, 내용은 file-up 으로 이어서 옴
          if (!isHost) return;
          const fid = String(msg.fid || '');
          const size = Number(msg.size);
          const count = Number(msg.count);
          if (!FID_RE.test(fid) || room.files.has(fid) || !FILE_KINDS.has(msg.kind)) return;
          if (!Number.isInteger(size) || size < 8 || size > L.fileMax || !/^[0-9a-f]{64}$/.test(String(msg.sha))) return;
          if (!Number.isInteger(count) || count < 1 || count > 500) return;
          let total = size;
          for (const f of room.files.values()) total += f.meta.size;
          if (room.files.size >= L.fileMaxCount || total > L.fileRoomMax) {
            return send(ws, { type: 'error', code: 'file-limit', message: `공유 파일은 한 Jam 에 ${L.fileMaxCount}개 · 합계 ${Math.round(L.fileRoomMax / 1024 / 1024)}MB 까지예요 (설정 → 같이 보는 파일). 안 쓰는 파일을 지워 주세요.` });
          }
          const meta = { fid, name: cleanText(msg.name, 120) || 'file', kind: msg.kind, size, sha: msg.sha, entry: cleanText(msg.entry, 300), count, by: me.id, net: msg.kind === 'html' && msg.net === true };
          const n = Math.ceil(size / FILE_PIECE);
          room.files.set(fid, { meta, n, chunks: new Array(n), got: 0, ready: false, data: null });
          broadcast(room, { type: 'file', file: publicFile(room.files.get(fid)) });
          broadcast(room, { type: 'system', text: `${me.name}님이 파일을 공유하는 중: ${meta.name}` });
          break;
        }
        case 'file-up': {
          if (!isHost) return;
          const f = room.files.get(String(msg.fid));
          const i = Number(msg.i);
          if (!f || f.ready || !Number.isInteger(i) || i < 0 || i >= f.n || typeof msg.d !== 'string' || msg.d.length > 44000) return;
          const buf = Buffer.from(msg.d, 'base64');
          const want = i < f.n - 1 ? FILE_PIECE : f.meta.size - FILE_PIECE * (f.n - 1);
          if (buf.length !== want) return;
          if (!f.chunks[i]) {
            f.chunks[i] = buf;
            f.got++;
          }
          if (f.got < f.n) return;
          const all = Buffer.concat(f.chunks);
          f.chunks = null;
          if (crypto.createHash('sha256').update(all).digest('hex') !== f.meta.sha) {
            removeFile(room, f.meta.fid);
            return send(ws, { type: 'error', code: 'file-bad', message: '올린 파일이 손상돼서 공유를 취소했어요 (해시 불일치)' });
          }
          f.data = all;
          f.ready = true;
          broadcast(room, { type: 'file', file: publicFile(f) });
          break;
        }
        case 'file-up-end': {
          // 호스트가 다 보냈다고 알림 → 빠진 조각이 있으면 번호를 돌려줌 (다시 보내게)
          if (!isHost) return;
          const f = room.files.get(String(msg.fid));
          if (!f || f.ready) return;
          const missing = [];
          for (let i = 0; i < f.n && missing.length < 2000; i++) if (!f.chunks[i]) missing.push(i);
          send(ws, { type: 'file-missing', fid: f.meta.fid, list: missing });
          break;
        }
        case 'file-get': {
          // 참여자가 "받기" → 이 사람에게만 조금씩 내려보냄
          const f = room.files.get(String(msg.fid));
          if (!f || !f.ready) return;
          me.fileQ = me.fileQ || [];
          if (me.fileQ.some((j) => j.fid === f.meta.fid) || me.fileQ.length >= 3) return;
          me.fileQ.push({ fid: f.meta.fid, i: 0 });
          startFilePump();
          break;
        }
        case 'file-remove': {
          if (!isHost) return;
          removeFile(room, String(msg.fid));
          break;
        }
        case 'navigate': {
          if (!isShareable(msg.url)) return;
          if (isJamFileUrl(msg.url) && !room.files.get(fidOf(msg.url))?.ready) return; // 공유가 끝난 파일만
          if (!canGo(room, me, msg.url)) return send(ws, NO_CROSS);
          room.current = { url: msg.url, title: cleanText(msg.title, 200), by: me.id };
          broadcast(room, { type: 'navigate', url: msg.url, title: room.current.title, by: me.id }, ws);
          break;
        }
        case 'title': {
          if (room.current && sameDoc(room.current.url, msg.url)) {
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
        // ---------- 핑: 화면의 한 곳을 모두에게 표시 (📍 여기 · 👀 봐요 · ⚠️ 조심) ----------
        case 'ping':
        case 'mping': {
          // 도배 방지: 순간 6개, 초당 2개
          const now = Date.now();
          me.pingTokens = Math.min(6, (me.pingTokens ?? 6) + ((now - (me.pingAt || now)) / 1000) * 2);
          me.pingAt = now;
          if (me.pingTokens < 1) return;
          me.pingTokens--;
          const k = PING_KINDS.has(msg.k) ? msg.k : 'here';
          if (msg.type === 'ping') {
            if (!isShareable(msg.url)) return;
            broadcast(room, { type: 'ping', by: me.id, url: msg.url, x: ratio(msg.x), y: ratio(msg.y), a: anchor(msg.a), k }, ws);
          } else {
            // 화면 미러링을 보는 사람의 핑 → 미러링하는 사람에게 (그 탭 위에 그려져서 영상으로 모두에게 보임)
            const mir = room.mirror;
            const owner = mir && room.members.get(mir.by);
            if (!owner || owner === me) return;
            const x = Number(msg.x);
            const y = Number(msg.y);
            if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
            send(owner.ws, { type: 'mping', by: me.id, x, y, k });
          }
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
          if (room.queue.length >= L.maxQueue)
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
          if (typeof msg.requireApproval === 'boolean') room.settings.access = msg.requireApproval ? 'approval' : 'open'; // 예전 설정 방식
          if (ACCESS.has(msg.access) && msg.access !== room.settings.access) {
            room.settings.access = msg.access;
            const label = { approval: '링크 + 호스트 승인', friends: '링크를 가진 친구만', open: '링크만 있으면 자유 입장' }[msg.access];
            broadcast(room, { type: 'system', text: `입장 방식이 "${label}" 으로 바뀌었어요` });
          }
          if (Array.isArray(msg.allow)) {
            room.allow = cleanAllow(msg.allow);
            for (const m of room.members.values()) m.friend = !!m.fp && room.allow.has(m.fp);
            pushMembers(room);
          }
          broadcast(room, { type: 'settings', settings: publicSettings(room) });
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
    for (const r of rooms.values()) {
      for (const [t, v] of r.resumes) if (v.expires < now) r.resumes.delete(t);
      for (const [t, v] of r.tickets) if (v.exp < now) r.tickets.delete(t);
    }
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
    clearInterval(filePump);
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
      resolve({
        port: server.address().port,
        close,
        rooms,
        limits: () => ({ ...L }),
        setLimits: (o) => Object.assign(L, cleanLimits({ ...L, ...o })), // 설정을 바꾸면 바로 적용
      });
    });
    server.listen(port, host);
  });
}

module.exports = { createJamServer, isWebUrl, isPrivateIp, isJamFileUrl, DEFAULT_LIMITS, cleanLimits };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 3030);
  createJamServer({ port, log: (m) => console.log(`[jam] ${m}`) }).then(({ port: p }) => {
    console.log(`[jam] Jam 서버가 포트 ${p}에서 실행 중입니다`);
  });
}
