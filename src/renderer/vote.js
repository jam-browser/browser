'use strict';
/* global JamVote, JamSite, jam, mirror, activeTab, toast, el, $ */
// 🗳️ 클릭 투표 (이상형 월드컵처럼): 호스트가 화면에 누를 곳을 그리고 → 모두가 투표 → 이긴 곳을 호스트 화면에서 자동으로 누름
//  - 칸은 호스트 탭이 보이는 영역의 비율. 참여자는 화면 미러링을 보고 있으면 그 영상 위에, 아니면 자기 Jam 탭 위에 같은 비율로
//  - 칸 · 투표 표시는 앱 화면 위에 그려서 웹페이지 · 미러링 영상에는 섞이지 않음
//  - 연속 투표(월드컵): 누른 뒤 잠깐 기다렸다가 같은 칸으로 다음 라운드

const jamVote = (() => {
  const V = JamVote;
  let vote = null; // 서버가 보낸 지금 투표 (shared/vote.js 모양)
  let endsAt = 0;
  let myPick = null;
  let editing = null; // 호스트: { opts: [], drag }
  let series = null; // 호스트: 연속 투표 중인 설정
  let resultTimer = null;
  let lastClickedId = null;

  // ---------- 화면 요소 ----------
  const layer = el('div', { id: 'vote-layer', hidden: true });
  const bar = el('div', { id: 'vote-bar', hidden: true });
  const editor = el('div', { id: 'vote-editor', hidden: true });
  document.body.append(layer, bar, editor);

  // 투표 칸을 그릴 자리 (화면 좌표): 미러링 영상(검은 여백 뺀 부분) · 아니면 Jam 탭
  function hostTab() {
    return (mirror.isMirroring() && mirror.hostTab && mirror.hostTab()) || jam.tab;
  }
  function stage() {
    if (mirror.viewing()) {
      const c = $('#mirror-canvas');
      const r = c.getBoundingClientRect();
      if (!c.width || !c.height || !r.width || !r.height) return null;
      const s = Math.min(r.width / c.width, r.height / c.height);
      const w = c.width * s;
      const h = c.height * s;
      return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    }
    const t = jam.isHost() ? hostTab() : jam.tab;
    if (!t || t !== activeTab || !t.webview) return null;
    const r = t.webview.getBoundingClientRect();
    return r.width > 50 && r.height > 50 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  }
  function place() {
    const st = stage();
    const show = !!st && (!!editing || !!vote);
    layer.hidden = !show;
    if (show) Object.assign(layer.style, { left: `${st.left}px`, top: `${st.top}px`, width: `${st.width}px`, height: `${st.height}px` });
    bar.hidden = !vote || editing != null;
    if (!bar.hidden) {
      const s = st || { left: 0, top: 60, width: window.innerWidth };
      Object.assign(bar.style, { left: `${s.left + s.width / 2}px`, top: `${(st ? st.top : 60) + 8}px` });
    }
    editor.hidden = !editing;
    if (editing && st) Object.assign(editor.style, { left: `${st.left + 12}px`, top: `${st.top + 12}px` });
  }
  setInterval(() => {
    if (!jam.active) return;
    place();
    renderBar();
  }, 250);
  window.addEventListener('resize', place);

  // ---------- 칸 그리기 ----------
  function boxEl(o, mode) {
    const counts = vote && vote.counts;
    const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
    const n = counts ? counts[o.k] || 0 : null;
    const win = vote && vote.state === 'closed' && vote.result && vote.result.winner === o.k;
    const b = el(
      'div',
      {
        class: `vote-box${mode === 'edit' ? ' edit' : ''}${myPick === o.k ? ' mine' : ''}${win ? ' win' : ''}${vote && vote.state === 'closed' && !win ? ' lose' : ''}`,
        'data-k': o.k,
        style: { left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%` },
      },
      el('div', { class: 'vote-tag' }, `${win ? '🏆 ' : ''}${o.k}${o.label ? ` · ${o.label}` : ''}${myPick === o.k ? ' ✓' : ''}`),
      n !== null ? el('div', { class: 'vote-count' }, `${n}표`, el('span', { class: 'vote-fill', style: { width: `${total ? (n / total) * 100 : 0}%` } })) : null,
      mode === 'edit'
        ? el('button', { class: 'vote-del', title: '이 칸 지우기', onclick: (e) => { e.stopPropagation(); editing.opts = editing.opts.filter((x) => x !== o); relabel(); renderLayer(); renderEditor(); } }, '×')
        : null
    );
    if (mode === 'vote') b.addEventListener('click', () => cast(o.k));
    return b;
  }
  function renderLayer() {
    layer.classList.toggle('editing', !!editing);
    layer.classList.toggle('voting', !!vote && vote.state === 'open' && !editing);
    if (editing) layer.replaceChildren(...editing.opts.map((o) => boxEl(o, 'edit')), ...(editing.drag ? [el('div', { class: 'vote-box drawing', style: rectStyle(editing.drag) })] : []));
    else if (vote) layer.replaceChildren(...vote.opts.map((o) => boxEl(o, vote.state === 'open' ? 'vote' : 'result')));
    else layer.replaceChildren();
    place();
  }
  const rectStyle = (d) => {
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.abs(d.x1 - d.x0) * 100}%`, height: `${Math.abs(d.y1 - d.y0) * 100}%` };
  };
  const secsLeft = () => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  function renderBar() {
    if (bar.hidden || !vote) return;
    const host = jam.isHost();
    const open = vote.state === 'open';
    const r = vote.result;
    const winner = r && vote.opts.find((o) => o.k === r.winner);
    const head = `🗳️ ${vote.title || '어디를 누를까요?'}${vote.round > 1 ? ` · ${vote.round}라운드` : ''}`;
    const info = open
      ? `${vote.sec ? `⏱ ${secsLeft()}초 · ` : ''}${vote.voted}/${vote.total}명 투표${myPick ? ` · 내 선택 ${myPick}` : ' · 칸을 눌러 투표'}`
      : winner
        ? `🏆 ${winner.k}${winner.label ? ` "${winner.label}"` : ''} ${r.top}표${r.how === 'host' ? ' (동점 → 호스트)' : r.how === 'random' ? ' (동점 → 무작위)' : ''}${vote.auto ? (host ? ' → 누르는 중…' : ' → 호스트 화면에서 누름') : ''}`
        : '아무도 투표하지 않았어요';
    const key = `${head}|${info}|${host}|${open}|${!!series}`;
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.replaceChildren(
      ...[
        el('b', {}, head),
        el('span', { class: 'vote-info' }, info),
        host && open ? el('button', { class: 'mini-btn', onclick: () => jam.send({ type: 'vote-close', id: vote.id }) }, '지금 끝내기') : null,
        host && series ? el('button', { class: 'mini-btn', onclick: () => stopSeries('연속 투표를 멈췄어요') }, '연속 멈추기') : null,
        host ? el('button', { class: 'mini-btn', onclick: () => { stopSeries(); jam.send({ type: 'vote-cancel' }); } }, '닫기') : null,
      ].filter(Boolean) // replaceChildren 은 null 을 "null" 글자로 넣음
    );
  }

  // ---------- 투표하기 ----------
  function cast(k) {
    if (!vote || vote.state !== 'open') return;
    myPick = myPick === k ? null : k; // 같은 칸을 다시 누르면 취소
    jam.send({ type: 'vote-cast', id: vote.id, k: myPick });
    renderLayer();
    bar.dataset.key = '';
    renderBar();
  }

  // ---------- 호스트: 칸 만들기 ----------
  const setupKey = () => {
    const t = hostTab();
    return `jam-vote:${(t && JamSite.siteOf(t.url)) || 'any'}`;
  };
  function loadSetup() {
    try {
      const s = JSON.parse(localStorage.getItem(setupKey()) || 'null');
      if (s && V.cleanSetup(s)) return s;
    } catch {}
    return { title: '', opts: V.PRESETS.halves, sec: 15, live: true, auto: true, endAll: true, series: false };
  }
  function relabel() {
    editing.opts = editing.opts.slice(0, V.KEYS.length).map((o, i) => ({ ...o, k: V.KEYS[i] }));
  }
  function openEditor() {
    if (!jam.active || !jam.isHost()) return;
    if (!stage()) return toast('🗳️ Jam 탭을 보고 있을 때 투표를 만들 수 있어요');
    const s = loadSetup();
    editing = { opts: (V.cleanOpts(s.opts) || []).map((o) => ({ ...o })), drag: null, s };
    relabel();
    renderEditor();
    renderLayer();
  }
  function closeEditor() {
    editing = null;
    renderLayer();
  }
  function renderEditor() {
    if (!editing) return;
    const s = editing.s;
    const sel = el('select', { id: 'vote-sec' }, ...V.SECS.map((n) => el('option', { value: String(n) }, n ? `${n}초` : '시간 제한 없음')));
    sel.value = String(s.sec);
    const chk = (id, label, on, title) => el('label', { class: 'vote-chk', title: title || '' }, el('input', { id, type: 'checkbox', ...(on ? { checked: true } : {}) }), el('span', {}, label));
    editor.replaceChildren(
      el('div', { class: 'pop-title' }, '🗳️ 어디를 누를지 투표'),
      el('div', { class: 'muted small' }, '페이지 위를 끌어서 누를 곳을 2~6개 그리세요 (이상형 월드컵이면 "왼쪽/오른쪽")'),
      el('input', { id: 'vote-title', type: 'text', maxlength: '60', placeholder: '제목 (예: 이상형 월드컵)', value: s.title || '' }),
      el(
        'div',
        { class: 'btn-row' },
        el('button', { class: 'mini-btn', onclick: () => preset('halves') }, '왼쪽 / 오른쪽'),
        el('button', { class: 'mini-btn', onclick: () => preset('rows') }, '위 / 아래'),
        el('button', { class: 'mini-btn', onclick: () => preset('quad') }, '4칸'),
        el('button', { class: 'mini-btn', onclick: () => preset(null) }, '모두 지우기')
      ),
      el(
        'div',
        { class: 'vote-opts' },
        ...editing.opts.map((o) =>
          el('label', { class: 'vote-opt' }, el('b', {}, o.k), el('input', { type: 'text', maxlength: '20', placeholder: '이름 (선택)', value: o.label || '', oninput: (e) => { o.label = e.target.value; renderLayer(); } }))
        )
      ),
      el('div', { class: 'vote-row' }, el('span', {}, '투표 시간'), sel),
      chk('vote-live', '투표하는 동안 표 수 보이기', s.live),
      chk('vote-auto', '끝나면 이긴 곳을 내 화면에서 자동으로 누르기', s.auto, '호스트 화면에서 진짜 클릭으로 눌러요 (로그인 · 결제 페이지에서는 안 누름)'),
      chk('vote-endall', '모두 투표하면 바로 끝', s.endAll),
      chk('vote-series', '연속 투표 (월드컵: 누른 뒤 같은 칸으로 다음 라운드)', s.series),
      el(
        'div',
        { class: 'btn-row' },
        el('button', { id: 'vote-start', class: 'primary-btn small-btn', onclick: start }, '투표 시작'),
        el('button', { class: 'text-btn small', onclick: closeEditor }, '취소')
      )
    );
    place();
  }
  function preset(name) {
    editing.opts = name ? V.PRESETS[name].map((o) => ({ ...o })) : [];
    relabel();
    renderEditor();
    renderLayer();
  }
  function readEditor() {
    return {
      title: $('#vote-title').value,
      opts: editing.opts.map(({ x, y, w, h, label }) => ({ x, y, w, h, label })),
      sec: Number($('#vote-sec').value),
      live: $('#vote-live').checked,
      auto: $('#vote-auto').checked,
      endAll: $('#vote-endall').checked,
      series: $('#vote-series').checked,
    };
  }
  function start() {
    const s = readEditor();
    const clean = V.cleanSetup(s);
    if (!clean) return toast('🗳️ 누를 곳을 2~6개 그려 주세요 (너무 작은 칸은 안 돼요)');
    try {
      localStorage.setItem(setupKey(), JSON.stringify(s));
    } catch {}
    closeEditor();
    series = clean.series ? { ...s, rounds: 0 } : null;
    jam.send({ type: 'vote-open', ...s });
  }
  // 끌어서 칸 그리기 (편집 중에만 layer 가 마우스를 받음)
  const ratioIn = (e) => {
    const r = layer.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  layer.addEventListener('mousedown', (e) => {
    if (!editing || e.button !== 0 || e.target.closest('.vote-del')) return;
    if (editing.opts.length >= V.KEYS.length) return toast('🗳️ 칸은 6개까지예요');
    const p = ratioIn(e);
    editing.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!editing || !editing.drag) return;
    const p = ratioIn(e);
    Object.assign(editing.drag, { x1: p.x, y1: p.y });
    renderLayer();
  });
  window.addEventListener('mouseup', () => {
    if (!editing || !editing.drag) return;
    const d = editing.drag;
    editing.drag = null;
    const o = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0), label: '' };
    if (o.w >= V.MIN_SIZE && o.h >= V.MIN_SIZE) {
      editing.opts.push(o);
      relabel();
      renderEditor();
    }
    renderLayer();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editing) closeEditor();
  });

  // ---------- 호스트: 끝나면 이긴 곳 누르기 · 연속 투표 ----------
  function stopSeries(text) {
    if (!series) return;
    series = null;
    if (text) toast(`🗳️ ${text}`);
    bar.dataset.key = '';
  }
  function clickWinner(v) {
    const o = v.opts.find((x) => x.k === v.result.winner);
    const t = hostTab();
    if (!o || !t || !t.webview || !t.ready) return false;
    if (JamSite.isSensitiveUrl(t.url)) {
      toast('🗳️ 로그인 · 결제 페이지라 자동으로 누르지 않았어요');
      return false;
    }
    const r = t.webview.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) {
      toast('🗳️ 투표한 탭을 보고 있어야 자동으로 눌러요');
      return false;
    }
    const c = V.center(o);
    const x = Math.round(c.x * r.width);
    const y = Math.round(c.y * r.height);
    const wv = t.webview;
    wv.sendInputEvent({ type: 'mouseMove', x, y });
    wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    (window.__voteClicks = window.__voteClicks || []).push({ id: v.id, k: o.k, x, y }); // 테스트 · 확인용
    return true;
  }
  function onClosed(v) {
    if (!jam.isHost() || lastClickedId === v.id) return;
    lastClickedId = v.id;
    const winner = v.result && v.result.winner;
    if (!winner) return stopSeries('아무도 투표하지 않아서 연속 투표를 멈췄어요');
    setTimeout(() => {
      if (!jam.active || !vote || vote.id !== v.id) return;
      const clicked = v.auto ? clickWinner(v) : false;
      if (!series) return;
      if (v.auto && !clicked) return stopSeries('누르지 못해서 연속 투표를 멈췄어요');
      if (++series.rounds >= 63) return stopSeries('64강까지 했어요! 연속 투표를 멈췄어요');
      // 페이지가 다음 라운드를 보여 줄 시간을 준 뒤 같은 칸으로 다시
      setTimeout(() => {
        if (!jam.active || !series || !vote || vote.id !== v.id) return;
        const { rounds, ...s } = series;
        void rounds;
        jam.send({ type: 'vote-open', next: true, ...s });
      }, 1800);
    }, 1300);
  }

  // ---------- 서버 메시지 ----------
  function setVote(v) {
    const prevId = vote && vote.id;
    vote = v || null;
    clearTimeout(resultTimer);
    if (!vote) {
      myPick = null;
      stopSeries();
    } else {
      if (vote.id !== prevId) myPick = null;
      endsAt = Date.now() + (vote.left || 0);
      if (vote.state === 'closed') {
        onClosed(vote);
        // 결과는 잠깐 보여 주고 치움 (연속 투표면 다음 라운드가 바로 덮어씀)
        const id = vote.id;
        resultTimer = setTimeout(() => {
          if (vote && vote.id === id && vote.state === 'closed') {
            vote = null;
            renderLayer();
          }
        }, 6000);
      }
    }
    bar.dataset.key = '';
    renderLayer();
    renderBar();
    renderButton();
  }
  function handle(msg) {
    if (msg.type === 'vote') setVote(msg.vote);
    else if (msg.type === 'vote-tally' && vote && msg.id === vote.id) {
      vote.voted = msg.voted;
      vote.total = msg.total;
      if (msg.counts) vote.counts = msg.counts;
      renderLayer();
      renderBar();
    }
  }
  function renderButton() {
    const b = $('#ov-vote');
    if (!b) return;
    b.hidden = !jam.active || !jam.isHost();
    b.classList.toggle('on', !!editing || (!!vote && vote.state === 'open'));
  }
  $('#ov-vote').addEventListener('click', () => {
    if (editing) return closeEditor();
    if (vote && vote.state === 'open') return toast('🗳️ 지금 투표 중이에요 (위쪽 막대에서 끝내기 · 닫기)');
    openEditor();
  });

  return {
    handle,
    onWelcome: (room) => setVote(room.vote || null),
    reset() {
      editing = null;
      series = null;
      setVote(null);
      layer.hidden = bar.hidden = editor.hidden = true;
    },
    render: renderButton,
    // 테스트 · 확인용
    openEditor,
    preset,
    start,
    cast,
    state: () => ({ vote, myPick, editing: !!editing, series: !!series, stage: stage(), boxes: [...layer.querySelectorAll('.vote-box')].map((b) => ({ k: b.dataset.k, cls: b.className, text: b.textContent })) }),
  };
})();
window.jamVote = jamVote;
