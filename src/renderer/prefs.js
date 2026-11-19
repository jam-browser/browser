'use strict';
/* global JamPrefs, jamApp */
// 세부 설정 (shared/prefs.js 목록으로 설정 창에 페이지를 만들어 붙임)
//  - 이 PC 의 localStorage 에만 저장, 바뀔 때마다 메인 프로세스로 보냄 (호스트 Jam 서버 · 근처 찾기 · 보안 처리에 바로 적용)
//  - 보안 항목을 끄면 경고 문구를 보여 줌

const prefs = (() => {
  const P = JamPrefs;
  const KEY = 'jam-prefs';
  let values = (() => {
    try {
      return P.clean(JSON.parse(localStorage.getItem(KEY)) || {});
    } catch {
      return P.clean({});
    }
  })();
  const listeners = new Set();

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(values));
    } catch {}
  }
  function push() {
    return jamApp.setPrefs ? jamApp.setPrefs(values).catch(() => null) : Promise.resolve(null);
  }
  function set(key, v) {
    const next = P.clean({ ...values, [key]: v });
    if (next[key] === values[key]) return;
    values = next;
    persist();
    push();
    for (const fn of listeners) {
      try {
        fn(key, values[key]);
      } catch (e) {
        console.error(`prefs listener: ${e && e.message}`);
      }
    }
    renderRow(key);
  }
  function setMany(obj) {
    values = P.clean({ ...values, ...obj });
    persist();
    push();
    for (const s of P.SCHEMA) renderRow(s.key);
    for (const fn of listeners) fn(null, null);
  }

  // ---------- 설정 창 ----------
  const rows = new Map();
  function control(s) {
    let input;
    if (s.type === 'bool') {
      input = el('input', { type: 'checkbox', 'data-pref': s.key });
      input.addEventListener('change', () => set(s.key, input.checked));
      return el('label', { class: 'toggle pref-toggle' }, input, el('span', {}, ''));
    }
    if (s.type === 'select') {
      input = el('select', { 'data-pref': s.key }, ...s.options.map(([v, t]) => el('option', { value: v }, t)));
      input.addEventListener('change', () => set(s.key, input.value));
      return input;
    }
    input = el('input', { type: 'number', min: s.min, max: s.max, step: s.step || 1, 'data-pref': s.key, class: 'pref-num' });
    input.addEventListener('change', () => set(s.key, Number(input.value)));
    return el('span', { class: 'pref-numwrap' }, input, s.unit ? el('span', { class: 'muted small' }, s.unit) : null);
  }
  function renderRow(key) {
    const r = rows.get(key);
    if (!r) return;
    const s = r.s;
    const v = values[key];
    const input = r.row.querySelector('[data-pref]');
    if (s.type === 'bool') input.checked = !!v;
    else input.value = String(v);
    if (s.locked) input.disabled = true;
    const off = s.type === 'bool' && !v && s.warnOff;
    r.warn.hidden = !off;
    r.warn.textContent = off ? `⚠️ ${s.warnOff}` : '';
    r.row.classList.toggle('pref-changed', JSON.stringify(v) !== JSON.stringify(s.def));
  }
  function build() {
    const dlg = $('#settings-dialog');
    if (!dlg || dlg.querySelector('[data-page="set-jam"]')) return;
    const nav = dlg.querySelector('.set-nav');
    const pages = dlg.querySelector('.set-pages');
    const before = nav.querySelector('[data-page="set-advanced"]');
    for (const pg of P.PAGES) {
      const btn = el('button', { 'data-page': pg.id }, pg.label);
      btn.addEventListener('click', () => {
        nav.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
        dlg.querySelectorAll('.set-page').forEach((p) => (p.hidden = p.id !== pg.id));
      });
      nav.insertBefore(btn, before);
      const sec = el('section', { id: pg.id, class: 'set-page pref-page', hidden: true });
      let group = null;
      for (const s of P.SCHEMA.filter((x) => x.page === pg.id)) {
        if (s.group !== group) {
          group = s.group;
          sec.appendChild(el('div', { class: 'pref-group' }, group));
        }
        const warn = el('div', { class: 'pref-warn small', hidden: true });
        const row = el(
          'div',
          { class: 'set-row pref-row' },
          el('div', { class: 'pref-label' }, el('span', {}, s.label), s.help ? el('div', { class: 'muted small' }, s.help) : null, warn),
          control(s)
        );
        rows.set(s.key, { s, row, warn });
        sec.appendChild(row);
      }
      sec.appendChild(
        el('div', { class: 'btn-row' }, el('button', {
          class: 'secondary-btn small-btn',
          onclick: () => setMany(Object.fromEntries(P.SCHEMA.filter((x) => x.page === pg.id).map((x) => [x.key, x.def]))),
        }, '이 페이지 기본값으로'))
      );
      pages.appendChild(sec);
    }
    for (const s of P.SCHEMA) renderRow(s.key);
  }

  build();
  push(); // 시작할 때 메인 프로세스에 알림
  listeners.add((key) => {
    if (!key || key.startsWith('ping')) pushPingConfig(); // 핑 설정은 탭에 바로
  });

  return {
    get: (k) => values[k],
    all: () => ({ ...values }),
    set,
    setMany,
    onChange: (fn) => listeners.add(fn),
  };
})();
window.prefs = prefs;
