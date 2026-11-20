/**
 * 서버 계정 동기화: 두 기기의 계정 문서(풀린 상태)를 합치기
 *  - 항목마다 나중에 바뀐 쪽 (로그인: updatedAt, 친구: updatedAt|addedAt, 이름 · 설정: updatedAt, 동기화 묶음: at)
 *  - 지운 것은 tomb 에 { 'l:<id>' | 'f:<지문>': 지운 시각 } 으로 남겨서 다른 기기에서 되살아나지 않게 (90일 지나면 정리)
 *  - 사이트 비밀번호(pw)는 항목별 암호문 그대로 옮김 (같은 계정이라 같은 데이터 키)
 * mergeDocs(local, remote) → { doc, localChanged, remoteBehind }
 *  localChanged: 합친 결과가 local 과 다름 (이 기기에 반영할 것 있음)
 *  remoteBehind: 합친 결과가 remote 와 다름 (서버에 올릴 것 있음)
 */
'use strict';

const TOMB_KEEP_MS = 90 * 24 * 3600e3;
const ts = (x) => Number(x) || 0;

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function pickNewer(a, b, at) {
  if (!a) return b;
  if (!b) return a;
  return at(b) > at(a) ? b : a; // 같으면 이 기기 것
}

function mergeList(la = [], lb = [], key, at, tomb, prefix) {
  const map = new Map();
  for (const x of la) if (x && x[key] != null) map.set(x[key], x);
  for (const y of lb) if (y && y[key] != null) map.set(y[key], pickNewer(map.get(y[key]), y, at));
  const out = [];
  for (const [k, v] of map) {
    const dead = ts(tomb[`${prefix}:${k}`]);
    if (dead && dead >= at(v)) continue;
    out.push(v);
  }
  return out;
}

function mergeDocs(local, remote, now = Date.now()) {
  if (!remote) return { doc: local, localChanged: false, remoteBehind: true };
  if (!local) return { doc: remote, localChanged: true, remoteBehind: false };
  const tomb = {};
  for (const t of [local.tomb || {}, remote.tomb || {}]) {
    for (const [k, v] of Object.entries(t)) if (now - ts(v) < TOMB_KEEP_MS) tomb[k] = Math.max(ts(tomb[k]), ts(v));
  }
  const loginAt = (l) => ts(l.updatedAt) || ts(l.createdAt);
  const friendAt = (f) => ts(f.updatedAt) || ts(f.addedAt);
  const sync = { ...(local.sync || {}) };
  for (const [k, v] of Object.entries(remote.sync || {})) sync[k] = pickNewer(sync[k], v, (x) => ts(x && x.at));
  const doc = {
    ...remote,
    ...local,
    profile: pickNewer(local.profile, remote.profile, (p) => ts(p.updatedAt) || ts(p.createdAt)),
    identity: local.identity || remote.identity,
    settings: pickNewer(local.settings, remote.settings, (s) => ts(s.updatedAt)),
    logins: mergeList(local.logins, remote.logins, 'id', loginAt, tomb, 'l'),
    friends: mergeList(local.friends, remote.friends, 'fp', friendAt, tomb, 'f'),
    tomb,
    sync,
  };
  const norm = (d) => stable({ ...d, logins: [...(d.logins || [])].sort((a, b) => String(a.id).localeCompare(b.id)), friends: [...(d.friends || [])].sort((a, b) => String(a.fp).localeCompare(b.fp)) });
  const n = norm(doc);
  return { doc, localChanged: n !== norm(local), remoteBehind: n !== norm(remote) };
}

module.exports = { mergeDocs, stable, TOMB_KEEP_MS };
