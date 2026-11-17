'use strict';
/**
 * 근처 찾기 (같은 네트워크, 서버 없이) — UDP 3032
 *  - 호스트: 2초마다 "여기 Jam 있어요" 알림을 같은 네트워크에만 보낸다 (사설 IP 네트워크 카드의 브로드캐스트 주소 + 이 PC)
 *  - 참여자: 알림을 모아 목록으로 보여 준다 (7초 동안 안 들리면 목록에서 뺌)
 * 알림에는 비밀키를 넣지 않는다. 방 코드만으로는 들어올 수 없다 (증명 · 페어링 필요).
 */
const dgram = require('dgram');
const os = require('os');
const { isPrivateIp } = require('./jam-server');

const NEARBY_PORT = 3032;
const ACCESS = new Set(['approval', 'friends', 'open']);
const EXPIRE_MS = 7000;
const MAX_ENTRIES = 64;

function broadcastAddresses() {
  const out = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateIp(a.address) || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((x, i) => (x & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 받은 알림 검사 (형식이 하나라도 틀리면 null) */
function parseBeacon(buf) {
  if (!buf || buf.length > 600) return null;
  let m;
  try {
    m = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!m || m.t !== 'jam-nearby' || m.v !== 1) return null;
  const port = Number(m.port);
  const n = Number(m.n);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(String(m.id))) return null;
  if (!/^[A-Z0-9]{4,8}$/.test(String(m.code))) return null;
  if (!ACCESS.has(m.access)) return null;
  if (!Number.isInteger(n) || n < 0 || n > 64) return null;
  return { id: m.id, name: clean(m.name, 24) || '이름 없음', port, code: m.code, access: m.access, n, app: clean(m.app, 16) };
}

/** 호스트: getRooms() → [{ code, name, access, n }] 을 주기적으로 알린다 */
function startBeacon({ id, port: tcpPort, getRooms, appVersion = '', udpPort = NEARBY_PORT, intervalMs = 2000, log = () => {} }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;
  let closed = false;
  sock.on('error', (e) => log(`beacon: ${e.message}`));
  sock.bind(0, () => {
    try {
      sock.setBroadcast(true);
    } catch {}
    const tick = () => {
      if (closed) return;
      const rooms = getRooms() || [];
      const targets = broadcastAddresses();
      for (const r of rooms) {
        const msg = Buffer.from(
          JSON.stringify({ t: 'jam-nearby', v: 1, app: appVersion, id, name: clean(r.name, 24), port: tcpPort, code: r.code, access: r.access, n: r.n })
        );
        for (const addr of targets) sock.send(msg, udpPort, addr, () => {});
      }
    };
    tick();
    timer = setInterval(tick, intervalMs);
  });
  return {
    close() {
      closed = true;
      clearInterval(timer);
      try { sock.close(); } catch {}
    },
  };
}

/** 참여자: 근처 알림을 모아 onChange(list) 로 알려 준다 */
function startScanner({ onChange, udpPort = NEARBY_PORT, log = () => {} }) {
  const seen = new Map(); // key → { ...beacon, ip, at }
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let lastKey = '';
  const list = () =>
    [...seen.values()].map(({ at, ...rest }) => rest).sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip));
  const emit = () => {
    const l = list();
    const key = JSON.stringify(l);
    if (key !== lastKey) {
      lastKey = key;
      onChange(l);
    }
  };
  sock.on('error', (e) => log(`scanner: ${e.message}`));
  sock.on('message', (buf, rinfo) => {
    if (!isPrivateIp(rinfo.address)) return;
    const b = parseBeacon(buf);
    if (!b) return;
    const ip = rinfo.address.replace(/^::ffff:/, '');
    // 같은 호스트가 브로드캐스트 · 이 PC(127.0.0.1) 두 길로 들리면 하나로 (같은 네트워크 주소를 우선)
    const key = `${b.id}:${b.code}`;
    const prev = seen.get(key);
    if (!prev && seen.size >= MAX_ENTRIES) return;
    const now = Date.now();
    const keepIp = prev && prev.ip !== ip && /^127\./.test(ip) && !/^127\./.test(prev.ip) && now - prev.at < EXPIRE_MS;
    seen.set(key, { ...b, ip: keepIp ? prev.ip : ip, at: now });
    emit();
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of seen) if (now - v.at > EXPIRE_MS) seen.delete(k);
    emit();
  }, 1000);
  let listening = false;
  sock.bind({ port: udpPort, exclusive: false }, () => {
    listening = true;
    log(`scanner listening on udp ${udpPort}`);
  });
  return {
    list,
    get listening() {
      return listening;
    },
    close() {
      clearInterval(sweep);
      try { sock.close(); } catch {}
    },
  };
}

module.exports = { NEARBY_PORT, startBeacon, startScanner, parseBeacon, broadcastAddresses };
