'use strict';
/**
 * 근처 Jam 페어링 — 참여하는 쪽 (메인 프로세스 · 테스트에서 사용)
 * 링크 없이 근처 호스트에 연결 → 6자리 확인 코드 → 호스트 수락 → 초대 비밀키 + 일회용 입장권을 받는다.
 * 받은 값으로 앱이 평소처럼(증명 + AES-GCM) 참여한다.
 */
const WebSocket = require('ws');
const PAIR = require('../shared/pairing');

/**
 * @param url     ws://IP:포트 (호스트 Jam 서버, 같은 네트워크)
 * @param signer  async (th) => ({ pub, sig }) | null   브라우저 계정이 열려 있으면 서명 (친구 확인용)
 * @param onSas   (sas) => void   6자리 확인 코드가 나오면
 * @returns { promise: Promise<{ secret, ticket }>, cancel() }
 */
function pairWithHost({ url, code, name, signer = null, onSas = () => {}, onPending = () => {}, timeoutMs = 140000 }) {
  let ws;
  let done = false;
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const fail = (message, errCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      reject(Object.assign(new Error(message), { code: errCode }));
    };
    cancel = () => fail('페어링을 취소했어요', 'cancelled');
    const timer = setTimeout(() => fail('호스트가 응답하지 않아요 (시간 초과)', 'timeout'), timeoutMs);
    try {
      ws = new WebSocket(url, { handshakeTimeout: 5000 });
    } catch {
      return fail('주소가 올바르지 않아요', 'bad-url');
    }
    const eph = PAIR.newEphemeral();
    let nonce = null;
    let key = null;
    ws.on('message', async (raw, isBinary) => {
      if (isBinary || done) return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        if (msg.type === 'hello' && typeof msg.nonce === 'string' && !nonce) {
          nonce = msg.nonce;
          ws.send(JSON.stringify({ type: 'pair', code, epk: eph.pub }));
        } else if (msg.type === 'pair-hello' && nonce && !key) {
          const th = PAIR.transcript(eph.pub, String(msg.epk || ''), nonce, code);
          const d = PAIR.derive(eph.priv, msg.epk, th);
          if (!d) return fail('호스트의 키가 올바르지 않아요', 'bad-key');
          key = d.key;
          onSas(d.sas);
          let id = null;
          if (signer) {
            try {
              id = await signer(th);
            } catch {
              id = null;
            }
          }
          ws.send(JSON.stringify({ type: 'pair-req', box: PAIR.sealBox(key, { name, id: id || undefined }) }));
        } else if (msg.type === 'pending') {
          onPending();
        } else if (msg.type === 'pair-ok' && key) {
          const inner = PAIR.openBox(key, msg.box);
          key.fill(0);
          if (!inner || !/^[A-Za-z0-9_-]{43}$/.test(String(inner.secret)) || typeof inner.ticket !== 'string') {
            return fail('호스트가 보낸 값이 올바르지 않아요', 'bad-box');
          }
          done = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ secret: inner.secret, ticket: inner.ticket });
        } else if (msg.type === 'error') {
          fail(String(msg.message || '페어링에 실패했어요'), String(msg.code || 'error'));
        }
      } catch (e) {
        fail(e.message || '페어링에 실패했어요', 'error');
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => fail('호스트에 연결할 수 없어요', 'closed'));
  });
  return { promise, cancel: () => cancel() };
}

module.exports = { pairWithHost };
