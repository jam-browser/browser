'use strict';
/* global jamSite, activeTab, tabs, tabWcId, tabByWcId, el, $, toast, prefs */
// 사이트 보호 (앱 화면)
//  - 주소창 🛡 : 이 페이지에서 막은 추적기 수 · 사이트마다 차단 끄기 · 서드파티 쿠키 허용 · 이 사이트 권한
//  - 사이트가 위치 · 알림 · 카메라 · 마이크 등을 요청하면 위쪽에 묻는 줄 (그 탭을 볼 때만, 원격 참여자는 누를 수 없음)
//  - 설정 → 보안 · 개인정보 아래에 "사이트별 설정" 목록

(() => {
  const counts = new Map(); // wcId → 막은 수
  const asks = []; // { id, wcId, origin, labels }
  let info = null;

  const hostOf = (o) => {
    try {
      return new URL(o).host;
    } catch {
      return o;
    }
  };
  const httpTab = (t) => t && /^https?:/i.test(t.url || '');

  // ---------- 🛡 버튼 ----------
  function updateShield() {
    const t = activeTab;
    const show = httpTab(t);
    $('#shield-wrap').hidden = !show;
    if (!show) {
      $('#shield-pop').classList.remove('open');
      return renderAsk();
    }
    const n = counts.get(tabWcId(t)) || 0;
    $('#shield-count').hidden = !n;
    $('#shield-count').textContent = n > 99 ? '99+' : String(n);
    $('#shield-btn').title = n ? `사이트 보호 · 이 페이지에서 추적 · 광고 ${n}개를 막았어요` : '사이트 보호 · 권한';
    renderAsk();
  }
  window.updateShield = updateShield;

  async function renderPop() {
    const t = activeTab;
    const id = t && tabWcId(t);
    if (id == null) return;
    info = await jamSite.info(id).catch(() => null);
    if (!info || !info.site) return;
    $('#shield-site').textContent = info.site;
    const mode = info.mode === 'off' ? '차단 꺼짐 (설정)' : info.shieldOff ? '이 사이트에서는 차단 안 함' : info.blocked ? `이 페이지에서 ${info.mode === 'ads' ? '추적기 · 광고' : '추적기'} ${info.blocked}개를 막았어요` : info.ready ? '이 페이지에서 막은 추적기가 없어요' : '차단 목록을 받는 중이에요';
    $('#shield-summary').textContent = mode;
    $('#shield-hosts').replaceChildren(...(info.shieldOff ? [] : info.hosts).map(([h, c]) => el('li', {}, el('span', {}, h), el('span', { class: 'muted' }, String(c)))));
    $('#shield-on').checked = info.mode !== 'off' && !info.shieldOff;
    $('#shield-on').disabled = info.mode === 'off';
    $('#shield-cookies').checked = info.cookiesMode === 'block' && !info.cookies3p;
    $('#shield-cookies').disabled = info.cookiesMode !== 'block';
    const kinds = Object.keys(info.perms);
    $('#shield-perms').replaceChildren(
      ...(kinds.length ? [el('div', { class: 'pref-group' }, `${hostOf(info.origin)} 권한`)] : []),
      ...kinds.map((k) => permRow(info.origin, k, info.perms[k], info.labels, renderPop))
    );
  }
  function permRow(origin, kind, v, labels, after) {
    const sel = el('select', {}, el('option', { value: 'allow' }, '허용'), el('option', { value: 'deny' }, '차단'), el('option', { value: '' }, '다시 묻기'));
    sel.value = v;
    sel.addEventListener('change', async () => {
      await jamSite.set({ origin, key: 'perm', value: { kind, v: sel.value || null } });
      after();
    });
    return el('div', { class: 'shield-row' }, el('span', {}, labels[kind] || kind), sel);
  }
  async function setSite(key, value) {
    if (!info) return;
    await jamSite.set({ site: info.site, key, value });
    $('#shield-reload').hidden = false;
    renderPop();
  }
  $('#shield-on').addEventListener('change', () => setSite('shieldOff', !$('#shield-on').checked));
  $('#shield-cookies').addEventListener('change', () => setSite('cookies3p', !$('#shield-cookies').checked));
  $('#shield-reload').addEventListener('click', () => {
    $('#shield-reload').hidden = true;
    $('#shield-pop').classList.remove('open');
    if (activeTab && activeTab.webview) activeTab.webview.reload();
  });
  $('#shield-all').addEventListener('click', () => {
    $('#shield-pop').classList.remove('open');
    openSiteSettings();
  });
  $('#shield-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const pop = $('#shield-pop');
    pop.classList.toggle('open');
    $('#shield-reload').hidden = true;
    if (pop.classList.contains('open')) renderPop();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#shield-pop') && !e.target.closest('#shield-btn')) $('#shield-pop').classList.remove('open');
  });
  jamSite.onCount(({ wcId, n }) => {
    if (n) counts.set(wcId, n);
    else counts.delete(wcId);
    if (activeTab && tabWcId(activeTab) === wcId) {
      updateShield();
      if ($('#shield-pop').classList.contains('open')) renderPop();
    }
  });

  // ---------- 권한 묻기 ----------
  function renderAsk() {
    const t = activeTab;
    const id = t && tabWcId(t);
    const a = asks.find((x) => x.wcId === id);
    $('#perm-banner').hidden = !a;
    if (!a) return;
    $('#perm-text').textContent = `🔐 ${hostOf(a.origin)} 이(가) ${a.labels.join(' · ')} 권한을 요청해요`;
    $('#perm-banner').dataset.id = String(a.id);
  }
  function answer(decision) {
    const id = Number($('#perm-banner').dataset.id);
    const i = asks.findIndex((x) => x.id === id);
    if (i < 0) return;
    const a = asks.splice(i, 1)[0];
    jamSite.answer(id, decision);
    if (decision === 'allow') toast(`${hostOf(a.origin)}: ${a.labels.join(' · ')} 허용 · 주소창 🛡 에서 바꿀 수 있어요`);
    renderAsk();
  }
  $('#perm-allow').addEventListener('click', () => answer('allow'));
  $('#perm-once').addEventListener('click', () => answer('once'));
  $('#perm-deny').addEventListener('click', () => answer('deny'));
  jamSite.onAsk((a) => {
    asks.push(a);
    renderAsk();
    const t = tabByWcId(a.wcId);
    if (t && t !== activeTab) toast(`🔐 다른 탭에서 ${hostOf(a.origin)} 이(가) ${a.labels.join(' · ')} 권한을 요청해요 (그 탭에서 답하기)`);
  });
  jamSite.onClosed(({ id }) => {
    const i = asks.findIndex((x) => x.id === id);
    if (i >= 0) asks.splice(i, 1);
    renderAsk();
  });

  // ---------- 설정: 사이트별 설정 목록 ----------
  function openSiteSettings() {
    const dlg = $('#settings-dialog');
    if (!dlg.open) dlg.showModal();
    const btn = dlg.querySelector('.set-nav [data-page="set-security"]');
    if (btn) btn.click();
    const box = $('#site-guard-list');
    if (box) box.scrollIntoView({ block: 'start' });
  }
  window.openSiteSettings = openSiteSettings;
  async function renderList() {
    const box = $('#site-guard-list');
    if (!box) return;
    const r = await jamSite.list().catch(() => null);
    if (!r) return;
    const rows = [];
    for (const [site, e] of Object.entries(r.sites).sort()) {
      const what = [e.shieldOff ? '차단 끔' : null, e.cookies3p ? '서드파티 쿠키 허용' : null].filter(Boolean).join(' · ');
      rows.push(
        el('li', { class: 'set-row' }, el('span', {}, `${site} — ${what}`), el('button', {
          class: 'mini-btn',
          onclick: async () => {
            await jamSite.set({ site, key: 'shieldOff', value: false });
            await jamSite.set({ site, key: 'cookies3p', value: false });
            renderList();
          },
        }, '기본으로'))
      );
    }
    for (const [origin, perms] of Object.entries(r.perms).sort()) {
      for (const k of Object.keys(perms)) rows.push(el('li', { class: 'set-row' }, el('span', {}, hostOf(origin)), permRow(origin, k, perms[k], r.labels, renderList)));
    }
    box.replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted small' }, '아직 사이트별로 바꾼 설정이 없어요')]));
  }
  // 설정 창의 보안 페이지 아래에 붙임 (페이지는 prefs.js 가 만듦)
  (function mount() {
    const sec = $('#set-security');
    if (!sec || $('#site-guard-list')) return;
    const last = sec.querySelector('.btn-row:last-child');
    const wrap = el(
      'div',
      { class: 'site-guard-box' },
      el('div', { class: 'pref-group' }, '사이트별 설정 (🛡 예외 · 권한)'),
      el('ul', { id: 'site-guard-list', class: 'set-list' }),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'secondary-btn small-btn',
          onclick: async () => {
            if (!confirm('사이트별 예외와 권한을 모두 지울까요? (다음에 다시 물어봐요)')) return;
            await jamSite.clearAll();
            renderList();
          },
        }, '모두 지우기'),
        el('button', {
          class: 'secondary-btn small-btn',
          onclick: async (e) => {
            e.target.disabled = true;
            const r = await jamSite.refreshLists().catch(() => ({ ok: false }));
            e.target.disabled = false;
            toast(r.ok ? '차단 목록을 새로 받았어요' : '차단 목록을 받지 못했어요 (가지고 있는 목록으로 계속)');
          },
        }, '차단 목록 지금 받기'))
    );
    sec.insertBefore(wrap, last);
    const btn = $('#settings-dialog .set-nav [data-page="set-security"]');
    if (btn) btn.addEventListener('click', renderList);
  })();

  updateShield();
})();
