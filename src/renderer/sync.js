'use strict';
/* global jamVault, account, prefs, settings, bookmarks, save, load, applyLook, renderBookmarks, renderStartPage, renderSiteCss, toast */
// 서버 계정 동기화: 북마크 · 꾸미기 설정 · 세부 설정을 계정 문서(암호화)에 넣어 다른 기기와 같이 씀
//  - 키마다 나중에 바뀐 쪽 (처음 맞출 때 북마크는 주소 기준으로 합침)
//  - 이 PC 계정(서버 없음) · 계정 없음이면 아무것도 안 함

const jamSync = (() => {
  const KEYS = { 'jam-bookmarks': 'bookmarks', 'jam-settings': 'look', 'jam-prefs': 'prefs' };
  const stampKey = (k) => `jam-sync-at:${k}`;
  const stamp = (k) => Number(localStorage.getItem(stampKey(k))) || 0;
  const setStamp = (k, at) => {
    try {
      localStorage.setItem(stampKey(k), String(at));
    } catch {}
  };
  const on = () => account.isUnlocked() && !!account.server();
  let applying = false;
  const timers = {};

  // 지금 값 (저장소가 아니라 앱이 쓰는 값 — 꾸미기 설정은 아직 한 번도 저장 안 했으면 저장소가 비어 있음)
  function current(lsKey) {
    if (lsKey === 'jam-prefs') return prefs.all();
    if (lsKey === 'jam-settings') return { ...settings };
    return Array.isArray(bookmarks) ? bookmarks.slice() : load(lsKey, []);
  }
  function push(lsKey) {
    if (!on() || applying) return;
    clearTimeout(timers[lsKey]);
    timers[lsKey] = setTimeout(() => {
      const key = KEYS[lsKey];
      jamVault
        .syncPut(key, current(lsKey))
        .then(() => setStamp(key, Date.now()))
        .catch(() => {});
    }, 800);
  }

  function apply(key, value) {
    applying = true;
    try {
      if (key === 'bookmarks' && Array.isArray(value)) {
        bookmarks = value; // customize.js 의 전역
        save('jam-bookmarks', value);
        renderBookmarks();
        if (typeof renderStartPage === 'function') renderStartPage();
      } else if (key === 'look' && value && typeof value === 'object' && Object.keys(value).length) {
        Object.assign(settings, value); // 없는 항목은 이 기기 값(기본값) 그대로
        save('jam-settings', settings);
        applyLook();
        if (typeof renderSiteCss === 'function') renderSiteCss();
        if (typeof renderStartPage === 'function') renderStartPage();
      } else if (key === 'prefs' && value && typeof value === 'object') {
        prefs.setMany(value);
      }
    } finally {
      applying = false;
    }
  }

  // 서버(계정 문서)에서 받은 것과 맞추기
  async function reconcile() {
    if (!on()) return;
    const remote = (await jamVault.syncGet().catch(() => null)) || {};
    for (const [lsKey, key] of Object.entries(KEYS)) {
      try {
        reconcileKey(lsKey, key, remote[key]);
      } catch (e) {
        console.error(`동기화 적용 실패 (${key}):`, e && e.message);
      }
    }
  }
  function reconcileKey(lsKey, key, r) {
    {
      const mine = stamp(key);
      if (r && r.at > mine) {
        let v = r.v;
        // 이 기기에서 처음 맞출 때: 북마크는 주소 기준으로 합침 (이 기기 것도 살림)
        if (key === 'bookmarks' && !mine && Array.isArray(v)) {
          const local = current(lsKey);
          const urls = new Set(v.map((b) => b && b.url));
          const extra = (Array.isArray(local) ? local : []).filter((b) => b && b.url && !urls.has(b.url));
          if (extra.length) {
            v = [...v, ...extra];
            apply(key, v);
            setStamp(key, r.at);
            push(lsKey);
            return;
          }
        }
        apply(key, v);
        setStamp(key, r.at);
      } else if (!r || mine > r.at) {
        push(lsKey); // 서버에 없거나 이 기기 것이 더 새것
      }
    }
  }

  // 이 기기에서 바뀌면 올림: customize.js 의 save · prefs 변경을 지켜봄
  const origSave = save;
  save = function (key, value) {
    origSave(key, value);
    if (KEYS[key]) push(key);
  };
  prefs.onChange(() => push('jam-prefs'));
  document.addEventListener('jam-account-unlocked', () => reconcile());
  jamVault.onChanged(() => reconcile());

  return { reconcile };
})();
window.jamSync = jamSync;
