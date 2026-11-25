'use strict';
/**
 * 친구 상태 (메인 프로세스): 내 상태를 친구마다 따로 암호화해서 중계 서버에 맡기고, 친구들 것을 찾아서 풀어 봄
 *
 *  - 앱 화면이 "친구에게 보여 줄 사이트" 를 정해서 보냄 (이상한 사이트는 이미 다른 사이트로 바뀐 채 — shared/decoy.js)
 *  - 여기서 친구마다 둘만 아는 키로 암호화 → 1분마다 · 바뀔 때 올림 (3분 안 올리면 서버에서 사라짐 = 오프라인)
 *  - 숨기기: 전체(설정) 또는 친구마다 → 올린 것을 바로 지움
 *  - 계정 신원 키 · 둘만 아는 비밀은 이 프로세스 밖으로 나가지 않음. 앱 화면에는 친구 이름 · 상태만
 */
const FS = require('../shared/friend-status');

const TICK_MS = 60e3;
const MAX_RELAYS = 3;

function setupFriendStatus({ ipcMain, vaultApi, getPrefs, powerMonitor, fromApp, send, fetch: fetchImpl, now = Date.now }) {
  let mine = { site: null, jam: false }; // 앱 화면이 정해 준 것
  let relays = [];
  let published = new Map(); // relay → Set(id) 지금 올려 둔 ID (숨길 때 지우려고)
  let friends = new Map(); // fp → { st, site, jam, at }
  let lastSeen = new Map(); // fp → 마지막으로 온라인이던 때 (이 앱이 켜져 있는 동안)
  let relayState = {}; // relay → 'ok' | 'old' | 'down'
  let timer = null;
  let pushTimer = null;
  let running = null;
  let lastRun = 0;

  async function post(url, body) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (r.status === 200 && !json) return { old: true }; // 예전 중계 서버 ("Jam relay")
      return { status: r.status, json };
    } catch {
      return { down: true };
    }
  }

  function myState() {
    const p = getPrefs();
    let idle = 0;
    try {
      idle = powerMonitor.getSystemIdleTime();
    } catch {}
    const o = { st: idle >= (Number(p.friendAwayMin) || 10) * 60 ? 'away' : 'online', at: now() };
    if (p.friendStatus === 'site' && mine.site) o.site = mine.site;
    if (p.friendStatus === 'site' && p.friendShowJam && mine.jam) o.jam = true;
    return o;
  }

  async function run() {
    const t = now();
    const p = getPrefs();
    const k = vaultApi.friendPairs();
    const list = relays.slice(0, MAX_RELAYS);
    const share = k && p.friendStatus !== 'hidden';
    const st = share ? myState() : null;
    const nextPub = new Map();
    const got = new Map();
    await Promise.all(list.map(async (relay) => {
      const putUrl = FS.endpoint(relay, 'put');
      const getUrl = FS.endpoint(relay, 'get');
      if (!putUrl) return;
      // 올리기 (숨기면 지난번에 올린 것을 지움)
      const items = [];
      if (share) {
        for (const f of k.pairs) {
          if (f.hide) continue;
          const o = FS.outbox(f.ss, k.me, f.pub, t);
          items.push({ id: o.id, blob: FS.seal(o.key, st) });
          o.key.fill(0);
        }
      }
      const keep = new Set(items.map((x) => x.id));
      const drop = [...(published.get(relay) || [])].filter((id) => !keep.has(id)).slice(0, 256);
      if (items.length || drop.length) {
        const r = await post(putUrl, { items: items.slice(0, 256), drop });
        relayState[relay] = r.old || r.status === 404 ? 'old' : r.down ? 'down' : r.status === 200 ? 'ok' : `error ${r.status}`;
        if (r.status === 200) nextPub.set(relay, keep);
        else nextPub.set(relay, new Set([...(published.get(relay) || []), ...keep])); // 다음에 다시 지움
      } else nextPub.set(relay, keep);
      // 찾기
      if (!k || !k.pairs.length || !getUrl) return;
      const want = [];
      for (const f of k.pairs) {
        const ib = FS.inbox(f.ss, k.me, f.pub, t);
        for (const id of ib.ids) want.push({ id, fp: f.fp, key: ib.key });
      }
      for (let i = 0; i < want.length; i += 510) {
        const part = want.slice(i, i + 510);
        const r = await post(getUrl, { ids: part.map((w) => w.id) });
        if (r.old || r.status === 404) relayState[relay] = 'old';
        else if (r.down) relayState[relay] = 'down';
        else if (r.status === 200) relayState[relay] = relayState[relay] === 'old' ? 'old' : 'ok';
        const found = (r.json && r.json.found) || {};
        for (const w of part) {
          if (typeof found[w.id] !== 'string') continue;
          const o = FS.open(w.key, found[w.id]);
          if (!o) continue;
          const prev = got.get(w.fp);
          if (!prev || o.at > prev.at) got.set(w.fp, o);
        }
      }
      for (const w of want) w.key.fill(0);
    }));
    published = nextPub;
    for (const relay of Object.keys(relayState)) if (!list.includes(relay)) delete relayState[relay];
    friends = got;
    for (const [fp, o] of got) lastSeen.set(fp, Math.max(lastSeen.get(fp) || 0, Math.min(o.at, t)));
    lastRun = t;
    send('fstatus:update', snapshot());
  }

  function snapshot() {
    const k = vaultApi.friendPairs();
    const p = getPrefs();
    return {
      unlocked: !!k,
      mode: p.friendStatus,
      mine: k && p.friendStatus !== 'hidden' ? myState() : null,
      relays: { ...relayState },
      at: lastRun,
      friends: k
        ? k.pairs.map((f) => {
            const o = friends.get(f.fp);
            return { fp: f.fp, name: f.name, hide: f.hide, online: !!o, st: o ? o.st : 'offline', site: o && o.site ? o.site : null, jam: !!(o && o.jam), lastSeen: lastSeen.get(f.fp) || 0 };
          })
        : [],
    };
  }

  function tick() {
    if (running) return running;
    running = run()
      .catch((e) => console.error('friend status:', e && e.message))
      .finally(() => (running = null));
    return running;
  }
  function soon(ms = 1500) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(tick, ms);
  }
  function start() {
    if (!timer) timer = setInterval(tick, TICK_MS);
  }

  const handle = (ch, fn) =>
    ipcMain.handle(ch, (e, arg = {}) => {
      if (!fromApp(e)) throw new Error('forbidden');
      return fn(arg || {});
    });
  // 앱 화면: 친구에게 보여 줄 사이트 (이미 바꿔 보여 주기가 적용된 사이트 이름만) · Jam 중인지
  handle('fstatus:set', ({ site, jam }) => {
    const s = typeof site === 'string' && /^[a-z0-9.-]{1,80}(:\d{1,5})?$/.test(site) ? site : null;
    const next = { site: s, jam: jam === true };
    if (next.site !== mine.site || next.jam !== mine.jam) {
      mine = next;
      soon();
    }
    return true;
  });
  handle('fstatus:config', ({ relayUrls }) => {
    const list = (Array.isArray(relayUrls) ? relayUrls : []).filter((u) => typeof u === 'string' && FS.endpoint(u, 'put')).slice(0, MAX_RELAYS);
    const changed = list.join('\n') !== relays.join('\n');
    // 목록에서 빠진 중계 서버에 올려 둔 것은 그대로 두면 3분 뒤 사라짐
    relays = list;
    start();
    if (changed) soon(200);
    return true;
  });
  // 지금 바로 (친구 창을 열 때 · 숨기기를 바꿀 때). 너무 자주는 안 함
  handle('fstatus:refresh', async () => {
    if (now() - lastRun < 2500 && !running) return snapshot();
    await tick();
    return snapshot();
  });
  handle('fstatus:get', () => snapshot());

  return {
    // 설정(숨기기) · 계정 잠금이 바뀌면
    changed: () => soon(300),
    // 앱을 닫을 때: 올려 둔 것을 지워서 바로 오프라인으로 (기다리지 않음)
    goodbye() {
      clearInterval(timer);
      clearTimeout(pushTimer);
      const jobs = [];
      for (const [relay, ids] of published) {
        const u = FS.endpoint(relay, 'put');
        if (u && ids.size) jobs.push(post(u, { drop: [...ids].slice(0, 256) }));
      }
      published = new Map();
      return Promise.all(jobs);
    },
    _snapshot: snapshot,
    _tick: tick,
  };
}

module.exports = { setupFriendStatus };
