/**
 * 🗳️ 클릭 투표 (이상형 월드컵처럼): 호스트가 화면에 "누를 곳" 을 2~6개 그리고, 모두가 어디를 누를지 투표
 *  - 자리는 호스트 화면(탭이 보이는 영역)의 비율 { x, y, w, h } (0~1). 화면 미러링과 같이 쓰면 모두에게 정확히 같은 자리
 *  - 투표는 한 사람에 한 표 (바꿀 수 있음). 1등이 여럿이면 호스트가 고른 쪽, 호스트가 그중에 없으면 무작위
 *  - 서버(server/jam-server.js) · 앱 화면(src/renderer/vote.js) · 테스트가 함께 씀
 */
(function (root) {
  'use strict';
  const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const MIN_SIZE = 0.03; // 너무 작은 칸은 안 받음 (화면의 3%)
  const SECS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];

  const num = (n) => {
    n = Number(n);
    return Number.isFinite(n) ? n : NaN;
  };
  const clip = (n) => Math.min(1, Math.max(0, n));
  const text = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  /** 칸 목록 정리: 2~6개, 비율 좌표 · 최소 크기 · 이름 20자. 이상하면 null */
  function cleanOpts(opts) {
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > KEYS.length) return null;
    const out = [];
    for (let i = 0; i < opts.length; i++) {
      const o = opts[i] || {};
      let x = num(o.x);
      let y = num(o.y);
      let w = num(o.w);
      let h = num(o.h);
      if ([x, y, w, h].some(Number.isNaN)) return null;
      x = clip(x);
      y = clip(y);
      w = Math.min(clip(w), 1 - x);
      h = Math.min(clip(h), 1 - y);
      if (w < MIN_SIZE || h < MIN_SIZE) return null;
      const r = (v) => Math.round(v * 10000) / 10000;
      out.push({ k: KEYS[i], x: r(x), y: r(y), w: r(w), h: r(h), label: text(o.label, 20) });
    }
    return out;
  }

  /** 호스트가 보낸 투표 설정 정리 → { title, opts, sec, live, auto, endAll, series } | null */
  function cleanSetup(m) {
    if (!m || typeof m !== 'object') return null;
    const opts = cleanOpts(m.opts);
    if (!opts) return null;
    const sec = Math.round(num(m.sec));
    return {
      title: text(m.title, 60),
      opts,
      sec: SECS.includes(sec) ? sec : 15,
      live: m.live !== false, // 투표하는 동안 표 수 보여 주기
      auto: m.auto !== false, // 끝나면 호스트 화면에서 이긴 곳을 자동으로 누르기
      endAll: m.endAll !== false, // 모두 투표하면 바로 끝
      series: !!m.series, // 누른 뒤 같은 칸으로 다음 라운드 (월드컵)
    };
  }

  /** 표 세기: ballots = Map | { 사람 → 칸 } */
  function tally(ballots, opts) {
    const counts = {};
    for (const o of opts) counts[o.k] = 0;
    const list = ballots instanceof Map ? [...ballots.values()] : Object.values(ballots || {});
    for (const k of list) if (k in counts) counts[k]++;
    return counts;
  }

  /** 이긴 칸 → { winner, tie, how: 'votes' | 'host' | 'random' | 'none', top } */
  function pickWinner(counts, hostChoice, rand = Math.random) {
    const keys = Object.keys(counts);
    const top = Math.max(0, ...keys.map((k) => counts[k]));
    if (top === 0) return { winner: null, tie: false, how: 'none', top: 0 };
    const best = keys.filter((k) => counts[k] === top);
    if (best.length === 1) return { winner: best[0], tie: false, how: 'votes', top };
    if (hostChoice && best.includes(hostChoice)) return { winner: hostChoice, tie: true, how: 'host', top };
    return { winner: best[Math.floor(rand() * best.length) % best.length], tie: true, how: 'random', top };
  }

  /** 비율 좌표 (px, py) 가 들어가는 칸 (겹치면 작은 칸) */
  function hit(opts, px, py) {
    let found = null;
    for (const o of opts || []) {
      if (px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h) {
        if (!found || o.w * o.h < found.w * found.h) found = o;
      }
    }
    return found ? found.k : null;
  }
  const center = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 });

  // 자주 쓰는 배치
  const PRESETS = {
    halves: [{ x: 0.02, y: 0.12, w: 0.46, h: 0.76, label: '왼쪽' }, { x: 0.52, y: 0.12, w: 0.46, h: 0.76, label: '오른쪽' }],
    rows: [{ x: 0.1, y: 0.04, w: 0.8, h: 0.44, label: '위' }, { x: 0.1, y: 0.52, w: 0.8, h: 0.44, label: '아래' }],
    quad: [
      { x: 0.02, y: 0.04, w: 0.46, h: 0.44 }, { x: 0.52, y: 0.04, w: 0.46, h: 0.44 },
      { x: 0.02, y: 0.52, w: 0.46, h: 0.44 }, { x: 0.52, y: 0.52, w: 0.46, h: 0.44 },
    ],
  };

  const api = { KEYS, SECS, MIN_SIZE, cleanOpts, cleanSetup, tally, pickWinner, hit, center, PRESETS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JamVote = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
