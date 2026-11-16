'use strict';
/**
 * Jam 중계 서버 (라우팅 전용)
 *
 * 호스트 PC와 참여자 사이에 "길만 이어주는" 서버예요.
 *  - 호스트 앱이 먼저 중계 서버에 접속해 경로 번호(route)를 받는다           →  /host
 *  - 참여자는 초대 코드에 들어 있는 경로로 접속한다                       →  /join/<route>
 *  - 중계 서버가 호스트에게 "손님 왔어요" 알림 → 호스트가 연결을 하나 더 열어 받는다 →  /accept/<route>/<id>
 *  - 그 뒤로는 두 연결 사이에서 데이터를 **그대로** 넘겨줄 뿐이에요
 *
 * 내용은 호스트와 참여자 사이에서 이미 암호화되어 있고(초대 코드의 비밀키), 중계 서버는 키가 없어서 볼 수 없어요.
 * 아무것도 저장하지 않아요. 기록하는 것은 접속/종료 로그(시간, IP 일부)뿐이에요.
 *
 * 실행:  node jam-relay.js            (기본 포트 3031)
 * 환경 변수:
 *   PORT=3031                         포트
 *   JAM_RELAY_PFX=C:\certs\relay.pfx  (선택) TLS 인증서(PFX) → wss:// 로 동작
 *   JAM_RELAY_PFX_PASS=비밀번호        (선택) PFX 비밀번호
 *   JAM_RELAY_CERT / JAM_RELAY_KEY    (선택) PEM 인증서/키 파일 경로
 *   JAM_RELAY_MAX_ROUTES=200          동시에 열 수 있는 Jam 수
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const MAX_GUESTS_PER_ROUTE = 16;
const MAX_CONNS_PER_IP = 30;
const MAX_PAYLOAD = 64 * 1024;
const ROUTE_GRACE = 2 * 60e3; // 호스트가 잠깐 끊겨도 2분은 경로 유지
const PENDING_TIMEOUT = 15000; // 호스트가 15초 안에 받지 않으면 손님 연결 종료
const MAX_BUFFER = 64; // 짝이 맺어지기 전에 쌓아 둘 메시지 수
const RATE_PER_SEC = 200; // 연결 하나당 초당 메시지 (커서 등)
const RATE_BURST = 400;

const b32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomId = (n) => Array.from(crypto.randomBytes(n), (x) => b32[x % b32.length]).join('');
const maskIp = (ip) => String(ip || '').replace(/^::ffff:/, '').replace(/\.\d+$/, '.x');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function createRelay({ port = 3031, host = '0.0.0.0', tls = null, maxRoutes = 200, log = () => {}, onFrame = null } = {}) {
  const routes = new Map(); // route → { token, control, guests: Map(id → guest), closeTimer }
  const connsPerIp = new Map();
  let nextGuestId = 1;

  const handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Jam relay\n');
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const realIp = (req) => req.socket.remoteAddress || '';
  const sendJson = (ws, obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

  function limiter(ws) {
    let tokens = RATE_BURST;
    let last = Date.now();
    return () => {
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - last) / 1000) * RATE_PER_SEC);
      last = now;
      if (tokens < 1) return false;
      tokens--;
      return true;
    };
  }

  function closeRoute(route, reason) {
    const r = routes.get(route);
    if (!r) return;
    routes.delete(route);
    clearTimeout(r.closeTimer);
    for (const g of r.guests.values()) g.ws.close(4410, reason);
    log(`route ${route} closed (${reason})`);
  }

  // 두 연결을 이어서 데이터를 그대로 넘긴다 (텍스트/바이너리 구분 유지)
  function pipe(a, b, label) {
    const okA = limiter(a);
    const okB = limiter(b);
    a.on('message', (data, isBinary) => {
      if (!okA()) return;
      if (onFrame) onFrame(label, 'up', data, isBinary);
      if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary });
    });
    b.on('message', (data, isBinary) => {
      if (!okB()) return;
      if (onFrame) onFrame(label, 'down', data, isBinary);
      if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary });
    });
    const end = () => {
      if (a.readyState <= WebSocket.OPEN) a.close();
      if (b.readyState <= WebSocket.OPEN) b.close();
    };
    a.on('close', end);
    b.on('close', end);
    a.on('error', end);
    b.on('error', end);
  }

  server.on('upgrade', (req, socket, head) => {
    const ip = realIp(req);
    const origin = req.headers.origin;
    // 웹페이지(http/https 출처)는 중계 서버에 접속할 수 없다. Jam Browser 앱(file://)만 허용
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
      socket.destroy();
    };
    if (origin && origin !== 'file://' && origin !== 'null') return reject(403, 'Forbidden');
    if ((connsPerIp.get(ip) || 0) >= MAX_CONNS_PER_IP) return reject(429, 'Too Many');

    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return reject(400, 'Bad Request');
    }
    const parts = url.pathname.split('/').filter(Boolean);

    wss.handleUpgrade(req, socket, head, (ws) => {
      connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
      ws.on('close', () => {
        const n = (connsPerIp.get(ip) || 1) - 1;
        if (n <= 0) connsPerIp.delete(ip);
        else connsPerIp.set(ip, n);
      });
      ws.on('error', () => {});
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));

      // ---------- 호스트 제어 연결 ----------
      if (parts[0] === 'host' && parts.length === 1) {
        const want = url.searchParams.get('route');
        const token = url.searchParams.get('token');
        let route;
        const existing = want && routes.get(want);
        if (existing && safeEq(existing.token, token)) {
          route = want; // 호스트 재접속: 같은 경로 유지
          clearTimeout(existing.closeTimer);
          if (existing.control && existing.control !== ws) existing.control.close();
          existing.control = ws;
        } else {
          if (routes.size >= maxRoutes) return ws.close(4429, 'relay full');
          do route = randomId(10);
          while (routes.has(route));
          routes.set(route, { token: crypto.randomBytes(24).toString('base64url'), control: ws, guests: new Map(), closeTimer: null });
          log(`route ${route} opened by ${maskIp(ip)}`);
        }
        const r = routes.get(route);
        sendJson(ws, { type: 'route', route, token: r.token });
        ws.on('message', () => {}); // 제어 연결로는 따로 받을 것이 없다 (핑 용도)
        ws.on('close', () => {
          const cur = routes.get(route);
          if (!cur || cur.control !== ws) return;
          cur.control = null;
          cur.closeTimer = setTimeout(() => closeRoute(route, 'host gone'), ROUTE_GRACE);
        });
        return;
      }

      // ---------- 참여자 ----------
      if (parts[0] === 'join' && parts.length === 2) {
        const r = routes.get(parts[1]);
        if (!r || !r.control) return ws.close(4404, 'no such jam');
        if (r.guests.size >= MAX_GUESTS_PER_ROUTE) return ws.close(4429, 'jam full');
        const id = String(nextGuestId++);
        const guest = { ws, buffer: [], paired: false };
        r.guests.set(id, guest);
        const take = (data, isBinary) => {
          if (guest.buffer.length < MAX_BUFFER) guest.buffer.push([data, isBinary]);
        };
        ws.on('message', take);
        guest.take = take;
        guest.timer = setTimeout(() => !guest.paired && ws.close(4408, 'host did not answer'), PENDING_TIMEOUT);
        ws.on('close', () => {
          clearTimeout(guest.timer);
          r.guests.delete(id);
        });
        // 손님 IP 는 호스트에게만 알려준다 (호스트 화면의 참여 요청 카드에 표시, 잘못된 코드 차단용)
        sendJson(r.control, { type: 'incoming', id, ip: ip.replace(/^::ffff:/, '') });
        return;
      }

      // ---------- 호스트가 손님 연결을 받는 데이터 연결 ----------
      if (parts[0] === 'accept' && parts.length === 3) {
        const r = routes.get(parts[1]);
        if (!r || !safeEq(r.token, url.searchParams.get('token'))) {
          return ws.close(4403, 'bad token');
        }
        const guest = r.guests.get(parts[2]);
        if (!guest || guest.paired || guest.ws.readyState !== WebSocket.OPEN) return ws.close(4404, 'guest gone');
        guest.paired = true;
        clearTimeout(guest.timer);
        guest.ws.off('message', guest.take);
        pipe(guest.ws, ws, `${parts[1]}#${parts[2]}`);
        for (const [data, isBinary] of guest.buffer) ws.send(data, { binary: isBinary });
        guest.buffer = [];
        return;
      }

      ws.close(4400, 'unknown path');
    });
  });

  const heartbeat = setInterval(() => {
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
    for (const route of [...routes.keys()]) closeRoute(route, 'relay stopping');
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ port: server.address().port, close, routes });
    });
  });
}

function tlsFromEnv() {
  const { JAM_RELAY_PFX, JAM_RELAY_PFX_PASS, JAM_RELAY_CERT, JAM_RELAY_KEY } = process.env;
  if (JAM_RELAY_PFX) return { pfx: fs.readFileSync(JAM_RELAY_PFX), passphrase: JAM_RELAY_PFX_PASS || undefined };
  if (JAM_RELAY_CERT && JAM_RELAY_KEY) return { cert: fs.readFileSync(JAM_RELAY_CERT), key: fs.readFileSync(JAM_RELAY_KEY) };
  return null;
}

module.exports = { createRelay };

if (require.main === module) {
  const port = Number(process.env.PORT || process.argv[2] || 3031);
  const tls = tlsFromEnv();
  createRelay({
    port,
    tls,
    maxRoutes: Number(process.env.JAM_RELAY_MAX_ROUTES || 200),
    log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
  })
    .then(({ port: p }) => console.log(`Jam relay listening on ${tls ? 'wss' : 'ws'}://0.0.0.0:${p}`))
    .catch((e) => {
      console.error('failed to start:', e.message);
      process.exit(1);
    });
}
