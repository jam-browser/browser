'use strict';
/**
 * 호스트 쪽 중계 터널 (중계 서버: https://github.com/jam-browser/backend)
 *
 *   참여자 ──(인터넷)──▶ 중계 서버 ──▶ [이 터널, 호스트 PC] ──▶ 호스트 PC 안의 Jam 서버(127.0.0.1)
 *
 * - 호스트 앱이 중계 서버에 "제어 연결"을 열고 경로 번호(route)를 받는다
 * - 손님이 오면 중계 서버가 알려 주고, 터널이 연결을 두 개 열어 그대로 이어 붙인다
 * - 데이터는 손대지 않고 넘긴다 (호스트 Jam 서버와 참여자 사이 암호화는 그대로)
 * - 손님의 실제 IP 를 Jam 서버에 알려 줘서, 잘못된 초대 코드 차단이 손님별로 동작하게 한다
 *   (relayKey 를 아는 이 터널만 IP 를 알려 줄 수 있음)
 */
const { WebSocket } = require('ws');

const MAX_QUEUE = 100;

function startRelayTunnel({ relayUrl, localPort, relayKey, log = () => {} }) {
  const base = relayUrl.replace(/\/+$/, '');
  return new Promise((resolve, reject) => {
    let route = null;
    let token = null;
    let control = null;
    let closed = false;
    let attempts = 0;
    let settled = false;
    const conns = new Set();
    let presence = null; // { id, blob } — 같은 계정의 다른 기기가 찾을 수 있게 맡긴 암호문 (다시 붙으면 다시 보냄)
    const sendPresence = () => {
      if (control && control.readyState === WebSocket.OPEN && route) {
        control.send(JSON.stringify({ type: 'presence', id: presence ? presence.id : null, blob: presence ? presence.blob : null }));
      }
    };

    const api = {
      get route() {
        return route;
      },
      // 다른 기기에서 이어 보기: { id, blob } 또는 null (지우기). 옛 중계 서버는 그냥 무시함
      setPresence(p) {
        const had = !!presence;
        presence = p && p.id && p.blob ? { id: String(p.id), blob: String(p.blob) } : null;
        if (presence || had) sendPresence();
      },
      close() {
        closed = true;
        if (control) control.close();
        for (const c of conns) c.terminate();
        conns.clear();
      },
    };

    function bridge(id, ip) {
      const remote = new WebSocket(`${base}/accept/${encodeURIComponent(route)}/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
      const local = new WebSocket(`ws://127.0.0.1:${localPort}`, {
        headers: { 'x-jam-relay-ip': String(ip || '').slice(0, 64), 'x-jam-relay-key': relayKey },
      });
      conns.add(remote);
      conns.add(local);
      const toLocal = [];
      const toRemote = [];
      // 받는 쪽이 밀리면(중계 서버가 속도를 줄이면) 보내는 쪽 읽기를 잠깐 멈춘다.
      // → 호스트 Jam 서버가 그 참여자 연결의 밀림을 보고 화면 미러링 화질 · 파일 전송 속도를 낮춤 (메모리에 무한정 쌓이지 않음)
      const HIGH = 2 * 1024 * 1024;
      const forward = (from, to, queue) =>
        from.on('message', (data, isBinary) => {
          if (to.readyState === WebSocket.OPEN) {
            to.send(data, { binary: isBinary });
            if (to.bufferedAmount > HIGH && !from.isPaused) {
              from.pause();
              const t = setInterval(() => {
                if (to.readyState !== WebSocket.OPEN || from.readyState !== WebSocket.OPEN || to.bufferedAmount < HIGH / 2) {
                  clearInterval(t);
                  if (from.readyState === WebSocket.OPEN) from.resume();
                }
              }, 50);
            }
          } else if (queue.length < MAX_QUEUE) queue.push([data, isBinary]);
        });
      forward(remote, local, toLocal);
      forward(local, remote, toRemote);
      local.on('open', () => toLocal.splice(0).forEach(([d, b]) => local.send(d, { binary: b })));
      remote.on('open', () => toRemote.splice(0).forEach(([d, b]) => remote.send(d, { binary: b })));
      const end = () => {
        for (const c of [remote, local]) {
          conns.delete(c);
          if (c.readyState === WebSocket.OPEN) c.close();
          else if (c.readyState === WebSocket.CONNECTING) c.terminate();
        }
      };
      for (const c of [remote, local]) {
        c.on('close', end);
        c.on('error', end);
      }
    }

    function openControl() {
      const q = route ? `?route=${encodeURIComponent(route)}&token=${encodeURIComponent(token)}` : '';
      const ws = new WebSocket(`${base}/host${q}`);
      control = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new Error('중계 서버에 연결할 수 없어요 (시간 초과)'));
        }
      }, 8000);
      ws.on('message', (raw) => {
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.type === 'route') {
          clearTimeout(timer);
          route = m.route;
          token = m.token;
          attempts = 0;
          log(`relay route ${route}`);
          if (presence) sendPresence();
          if (!settled) {
            settled = true;
            resolve(api);
          }
        } else if (m.type === 'incoming' && route) {
          bridge(String(m.id), m.ip);
        }
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (closed || control !== ws) return;
        if (!settled) {
          settled = true;
          return reject(new Error('중계 서버에 연결할 수 없어요'));
        }
        // 잠깐 끊기면 같은 경로로 다시 붙는다 (초대 코드는 그대로 유효)
        if (attempts++ < 60) setTimeout(() => !closed && openControl(), Math.min(10000, 1000 * attempts));
      });
      ws.on('error', () => {});
    }

    openControl();
  });
}

module.exports = { startRelayTunnel };
