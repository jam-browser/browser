'use strict';
/* global jamFriends, jamVault, jamSite, JamDecoy, account, prefs, activeTab, history, jam, relayList, normalizeRelay, createTab, toast, el, $ */
// 👥 친구 상태: 친구들의 온라인 · 자리 비움 · 오프라인 · 보는 사이트, 내 상태(숨기기 포함)
//  - 친구에게 보여 줄 사이트는 여기서 정함 (shared/decoy.js): 보여 주기 곤란한 사이트는 자주 가는 다른 사이트로
//  - 암호화 · 중계 서버와 주고받기는 메인 프로세스(src/friend-status.js) 가 함. 여기는 사이트 이름 · 친구 이름 · 상태만

const jamFriendStatus = (() => {
  const decoy = JamDecoy.createState();
  let hidden = new Set(); // 🛡 에서 "친구에게 숨기기" 한 사이트
  let frequent = [];
  let frequentAt = 0;
  let shown = { site: null, decoy: false };
  let lastSent = null;
  let lastRelays = null;
  let snap = null;
  let prevOnline = null; // 알림용: 지난번에 온라인이던 친구
  const SEEN_KEY = 'jam-friends-seen';
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {};
  } catch {}

  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    if (m < 48 * 60) return `${Math.round(m / 60)}시간 전`;
    return `${Math.round(m / 1440)}일 전`;
  };

  async function reloadHidden() {
    const r = await jamSite.list().catch(() => null);
    hidden = new Set(Object.entries((r && r.sites) || {}).filter(([, e]) => e && e.friendHide).map(([s]) => s));
    frequentAt = 0;
    lastSent = null;
    update();
  }
  function frequentSites() {
    if (Date.now() - frequentAt > 10 * 60e3) {
      frequent = JamDecoy.frequentSites(typeof history !== 'undefined' && Array.isArray(history) ? history : [], { hidden });
      frequentAt = Date.now();
    }
    return frequent;
  }

  // 지금 친구에게 보여 줄 것 → 바뀌었을 때만 메인 프로세스로
  function update() {
    if (!account.isUnlocked()) return;
    const url = activeTab && activeTab.url;
    shown = JamDecoy.shownSite(decoy, url, { frequent: frequentSites(), hidden, mode: prefs.get('friendDecoy') });
    const jamOn = typeof jam !== 'undefined' && !!jam.active;
    const key = `${shown.site}|${jamOn}`;
    if (key !== lastSent) {
      lastSent = key;
      jamFriends.set(shown.site, jamOn).catch(() => {});
    }
    renderMe();
  }

  // 중계 서버: 서버 계정의 서버 + Jam 중계 서버 목록 (앞에서 3개)
  function relays() {
    const out = [];
    const srv = account.server && account.server();
    if (srv) {
      const u = normalizeRelay(String(srv));
      if (u) out.push(u);
    }
    for (const u of relayList().urls) if (!out.includes(u)) out.push(u);
    return out.slice(0, 3);
  }
  function configure() {
    const r = relays();
    const k = r.join('\n');
    if (k === lastRelays) return;
    lastRelays = k;
    jamFriends.config(r).catch(() => {});
  }

  const RANK = { online: 0, away: 1, offline: 2 };
  const DOT = { online: '🟢', away: '🌙', offline: '⚫' };
  function statusOf(fp) {
    const f = snap && snap.friends.find((x) => x.fp === fp);
    return f ? f.st : 'offline';
  }

  function renderMe() {
    const mode = prefs.get('friendStatus');
    if ($('#fr-mode').value !== mode) $('#fr-mode').value = mode;
    $('#fr-mode').disabled = !account.isUnlocked();
    let line;
    if (!account.isUnlocked()) line = '브라우저 계정에 로그인하면 친구 상태를 주고받아요';
    else if (mode === 'hidden') line = '🙈 친구들에게 오프라인으로 보여요';
    else if (mode === 'online') line = '친구에게 "온라인" 으로만 보여요 (사이트 숨김)';
    else if (!shown.site) line = '친구에게 "온라인" 으로 보여요 (지금은 웹사이트를 안 보는 중)';
    else line = `친구에게 보이는 사이트: ${shown.site}${shown.decoy ? ' (대신 보여 주는 중 🎭)' : ''}`;
    $('#fr-me-line').textContent = line;
  }

  function render() {
    renderMe();
    const unlocked = account.isUnlocked();
    const list = unlocked && snap ? snap.friends.slice() : [];
    list.sort((a, b) => RANK[a.st] - RANK[b.st] || a.name.localeCompare(b.name, 'ko'));
    const online = list.filter((f) => f.st !== 'offline').length;
    $('#friends-badge').hidden = !online;
    $('#friends-badge').textContent = String(online);
    $('#fr-list').replaceChildren(
      ...list.map((f) => {
        const last = Math.max(f.lastSeen || 0, seen[f.fp] || 0);
        let sub;
        if (f.st === 'offline') sub = last ? `오프라인 · ${ago(last)} 접속` : '오프라인';
        else sub = `${f.st === 'away' ? '자리 비움' : '온라인'}${f.site ? ` · ${f.site} 보는 중` : ''}${f.jam ? ' · 🎉 Jam 중' : ''}`;
        return el(
          'li',
          { class: `fr-row ${f.st}`, 'data-fp': f.fp },
          el('span', { class: 'fr-dot', title: f.st }, DOT[f.st]),
          el('div', { class: 'fr-info' }, el('b', {}, f.name), el('div', { class: 'muted small fr-sub' }, sub)),
          f.site && f.st !== 'offline'
            ? el('button', { class: 'mini-btn', title: `${f.site} 열기`, onclick: () => { createTab(`https://${f.site}/`); $('#friends-pop').classList.remove('open'); } }, '열기')
            : null,
          el('button', {
            class: `mini-btn fr-hide${f.hide ? ' active' : ''}`,
            title: f.hide ? '이 친구에게 숨기는 중 (오프라인으로 보여요). 누르면 다시 보여요' : '이 친구에게만 내 상태 숨기기 (오프라인으로 보여요)',
            onclick: async () => {
              try {
                await jamVault.setFriendHide(f.fp, !f.hide);
                snap = await jamFriends.refresh();
                render();
                toast(f.hide ? `👁 ${f.name}님에게 다시 내 상태가 보여요` : `🙈 ${f.name}님에게는 오프라인으로 보여요`);
              } catch (e) {
                toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
              }
            },
          }, f.hide ? '🙈 숨김' : '👁 보임')
        );
      })
    );
    let note = '';
    if (!unlocked) note = '친구 목록은 브라우저 계정에 있어요. 👤 로 로그인하세요';
    else if (!list.length) note = '아직 친구가 없어요. 👤 → 친구에서 친구 코드를 주고받으세요 (서로 추가해야 보여요)';
    else if (!relays().length) note = '중계 서버 주소가 있어야 친구 상태를 주고받아요';
    else if (snap) {
      const st = Object.values(snap.relays || {});
      if (st.length && st.every((x) => x === 'old')) note = '중계 서버가 아직 친구 상태를 몰라요 (중계 서버 1.2.0 부터)';
      else if (st.length && st.every((x) => x === 'down')) note = '중계 서버에 연결할 수 없어요';
      else if (!online) note = '서로 친구로 추가했고 같은 중계 서버를 쓰는 친구만 보여요';
    }
    $('#fr-empty').hidden = !note;
    $('#fr-empty').textContent = note;
  }

  function onSnapshot(s) {
    snap = s;
    if (!s || !s.unlocked) {
      prevOnline = null;
      return render();
    }
    let dirty = false;
    for (const f of s.friends) {
      if (f.lastSeen && f.lastSeen > (seen[f.fp] || 0)) {
        seen[f.fp] = f.lastSeen;
        dirty = true;
      }
    }
    if (dirty) {
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
      } catch {}
    }
    const now = new Set(s.friends.filter((f) => f.st !== 'offline').map((f) => f.fp));
    if (prevOnline && prefs.get('friendNotify')) {
      for (const f of s.friends) if (now.has(f.fp) && !prevOnline.has(f.fp)) toast(`🟢 ${f.name}님이 온라인이에요${f.site ? ` (${f.site})` : ''}`);
    }
    prevOnline = now;
    render();
  }

  // ---------- 이벤트 ----------
  jamFriends.onUpdate(onSnapshot);
  $('#friends-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const pop = $('#friends-pop');
    pop.classList.toggle('open');
    if (!pop.classList.contains('open')) return;
    render();
    configure();
    update();
    onSnapshot(await jamFriends.refresh().catch(() => snap));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#friends-pop')) $('#friends-pop').classList.remove('open');
  });
  $('#fr-mode').addEventListener('change', async (e) => {
    prefs.set('friendStatus', e.target.value);
    renderMe();
    setTimeout(async () => onSnapshot(await jamFriends.refresh().catch(() => snap)), 600);
  });
  $('#fr-add').addEventListener('click', () => {
    $('#friends-pop').classList.remove('open');
    account.open('vault-friends');
  });
  $('#fr-settings').addEventListener('click', () => {
    $('#friends-pop').classList.remove('open');
    const dlg = $('#settings-dialog');
    if (!dlg.open) dlg.showModal();
    const btn = dlg.querySelector('.set-nav [data-page="set-friends"]');
    if (btn) btn.click();
  });
  prefs.onChange(() => {
    lastSent = null;
    update();
  });
  document.addEventListener('jam-account-unlocked', async () => {
    lastSent = null;
    lastRelays = null;
    await reloadHidden();
    configure();
    onSnapshot(await jamFriends.refresh().catch(() => null));
  });
  jamVault.onLocked(async () => {
    lastSent = null;
    onSnapshot(await jamFriends.refresh().catch(() => null)); // 메인 프로세스가 올려 둔 것을 지움
  });
  jamVault.onChanged(() => jamFriends.refresh().then(onSnapshot).catch(() => {})); // 다른 기기에서 친구가 바뀜

  // 탭 · 주소 · Jam 상태는 2초마다 확인 (바뀔 때만 보냄)
  setInterval(() => {
    configure();
    update();
  }, 2000);
  reloadHidden();
  jamFriends.get().then(onSnapshot).catch(() => {});

  return { reloadHidden, statusOf, dot: (fp) => DOT[statusOf(fp)], shown: () => ({ ...shown }), snapshot: () => snap };
})();
window.jamFriendStatus = jamFriendStatus;
