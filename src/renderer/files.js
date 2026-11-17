'use strict';
/* global jamApp */
// 같이 보는 파일 (설계안 3단계)
//  호스트: 📎 파일 공유 → 메인이 파일을 메모리에 묶음(pack)으로 보관 → 여기서 32KB 조각으로 Jam 서버에 올림 (Jam 키로 암호화)
//  참여자: 목록에서 "받기" → 서버가 조금씩 내려보냄 → SHA-256 확인 → 메인 메모리에 보관 → jamfile://<ID>/ 로 열기
//  Jam 탭이 jamfile:// 주소로 가면 주소 미러링 그대로 따라감 (스크롤 · 커서 · 쪽 동기화). 아직 안 받았으면 "받아서 열기" 를 물어봄
//  받은 파일은 메모리에만 (다운로드 폴더 X), Jam 을 나가면 지움
// (app.js 의 $, el, toast, jam, createTab, navigateTab, activateTab, followNavigate, activeTab, isWebUrl 를 씀)

const jamFiles = (() => {
  const PIECE = 32 * 1024;
  const KIND_ICON = { pdf: '📄', html: '🌐', image: '🖼', text: '📝', swf: '🎮' };
  const files = new Map(); // fid → { fid, name, kind, size, sha, entry, count, by, ready, local, up, dl, bytes }
  const urlOf = (fid) => `jamfile://${fid}/`;
  const fidOf = (u) => (/^jamfile:\/\/([a-z0-9]{16})(\/|$)/.exec(String(u || '')) || [])[1] || null;
  const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let renderTimer = null;
  const renderSoon = () => {
    if (!renderTimer) renderTimer = setTimeout(() => ((renderTimer = null), render()), 150);
  };

  // ================= 호스트: 공유 =================
  async function share(meta) {
    if (!meta) return;
    if (meta.error) return toast(`📎 ${meta.error}`);
    if (!jam.active || !jam.isHost()) return;
    const bytes = await jamApp.fileBytes(meta.fid);
    if (!bytes) return toast('📎 파일을 읽지 못했어요');
    const n = Math.ceil(meta.size / PIECE);
    const f = { ...meta, by: jam.you.id, ready: false, local: true, bytes: new Uint8Array(bytes), up: { sent: 0, n, rounds: 0 } };
    files.set(meta.fid, f);
    jam.send({ type: 'file-offer', fid: meta.fid, name: meta.name, kind: meta.kind, size: meta.size, sha: meta.sha, entry: meta.entry, count: meta.count });
    render();
    await upload(f, [...Array(n).keys()]);
  }
  async function upload(f, list) {
    let t0 = performance.now();
    let k = 0;
    for (const i of list) {
      if (!jam.active || files.get(f.fid) !== f || f.ready) return;
      while ((jam.ws?.bufferedAmount || 0) > 1e6) await sleep(20);
      jam.send({ type: 'file-up', fid: f.fid, i, d: b64(f.bytes.subarray(i * PIECE, (i + 1) * PIECE)) });
      f.up.sent = Math.min(f.up.n, f.up.sent + 1);
      // 초당 100조각(약 3.2MB/s) 정도로 — 서버의 바이트 한도 안
      if (++k % 10 === 0) {
        await jam.outQueue;
        const wait = 100 - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
        t0 = performance.now();
        renderSoon();
      }
    }
    await jam.outQueue;
    jam.send({ type: 'file-up-end', fid: f.fid });
  }
  async function pickAndShare() {
    if (!jam.active || !jam.isHost()) return;
    share(await jamApp.filePick());
  }
  async function shareWebPdf() {
    const t = activeTab;
    if (!jam.active || !jam.isHost() || !t || !isWebPdf(t.url)) return;
    toast('📄 PDF 를 받는 중…');
    share(await jamApp.fileFromWeb(t.url));
  }
  const isWebPdf = (u) => isWebUrl(u) && /\.pdf($|[?#])/i.test(u);
  function openInJam(fid) {
    if (!jam.active || !jam.tab) return;
    activateTab(jam.tab);
    navigateTab(jam.tab, urlOf(fid));
  }
  function remove(fid) {
    if (!jam.active || !jam.isHost()) return;
    jam.send({ type: 'file-remove', fid });
  }

  // ================= 참여자: 받기 =================
  function download(fid, open = false) {
    const f = files.get(fid);
    if (!f || !f.ready || !jam.active) return;
    if (f.local) return open && openLocal(f);
    if (f.dl) {
      f.dl.open = f.dl.open || open;
      return;
    }
    f.dl = { n: Math.ceil(f.size / PIECE), got: 0, parts: [], open };
    jam.send({ type: 'file-get', fid });
    render();
  }
  async function onDown(msg) {
    const f = files.get(msg.fid);
    const d = f && f.dl;
    if (!d || msg.n !== d.n || !Number.isInteger(msg.i) || msg.i < 0 || msg.i >= d.n) return;
    if (!d.parts[msg.i]) {
      d.parts[msg.i] = unb64(msg.d);
      d.got++;
      renderSoon();
    }
    if (d.got < d.n) return;
    f.dl = null;
    const all = new Uint8Array(f.size);
    let o = 0;
    for (const p of d.parts) {
      if (o + p.length > all.length) return toast('📎 받은 파일 크기가 맞지 않아요');
      all.set(p, o);
      o += p.length;
    }
    if (o !== f.size || hex(await crypto.subtle.digest('SHA-256', all)) !== f.sha) {
      render();
      return toast('📎 받은 파일이 손상됐어요 (해시 불일치). 다시 받아 주세요');
    }
    const r = await jamApp.fileStore({ fid: f.fid, name: f.name, kind: f.kind, size: f.size, sha: f.sha }, all);
    if (!r || r.error) {
      render();
      return toast(`📎 ${r?.error || '파일을 열 수 없어요'}`);
    }
    f.local = true;
    render();
    if (d.open) openLocal(f);
    else toast(`📎 받았어요: ${f.name}`);
  }
  function openLocal(f) {
    const cur = jam.room?.current?.url;
    if (jam.follow && fidOf(cur) === f.fid) followNavigate(cur); // 호스트가 Jam 에서 열어 둔 파일 → 같이 보기
    else activateTab(createTab(urlOf(f.fid))); // 아니면 내 탭에서
  }

  /** Jam 이 이 주소로 가려고 할 때: 받은 파일이면 true, 아니면 받을지 묻고 false */
  let askedFor = null;
  function gate(url) {
    const fid = fidOf(url);
    if (!fid) return true;
    const f = files.get(fid);
    if (f && f.local) return true;
    if (askedFor !== fid) {
      askedFor = fid;
      const by = f && jam.member(f.by);
      const what = f ? `${KIND_ICON[f.kind] || '📎'} ${f.name} (${fmt(f.size)})` : '공유 파일';
      toast(`📎 ${by?.name || '호스트'}님이 ${what} 을(를) 열었어요`, [{ label: '받아서 열기', fn: () => download(fid, true) }]);
    }
    render();
    return false;
  }

  // ================= 메시지 =================
  function handle(msg) {
    switch (msg.type) {
      case 'file': {
        const m = msg.file;
        if (!m || !m.fid) return;
        const old = files.get(m.fid);
        const f = Object.assign(old || {}, m);
        files.set(m.fid, f);
        if (m.ready && (!old || !old.ready)) {
          if (f.by === jam.you.id) {
            f.bytes = null; // 다 올렸으면 앱 화면 쪽 사본은 버림 (메인 메모리에만)
            toast(`📎 공유 준비 완료: ${f.name}`, [{ label: 'Jam 탭에서 열기', fn: () => openInJam(f.fid) }]);
          } else if (!f.local) {
            const by = jam.member(f.by);
            toast(`📎 ${by?.name || '호스트'}님이 파일을 공유했어요: ${KIND_ICON[f.kind] || ''} ${f.name} (${fmt(f.size)})`, [{ label: '받기', fn: () => download(f.fid) }]);
          }
          // 이미 Jam 이 이 파일을 열어 둔 상태였으면 다시 물어봄
          if (fidOf(jam.room?.current?.url) === f.fid && !f.local) {
            askedFor = null;
            gate(jam.room.current.url);
          }
        }
        render();
        break;
      }
      case 'file-removed':
        files.delete(msg.fid);
        jamApp.fileDrop(msg.fid);
        render();
        break;
      case 'file-down':
        onDown(msg);
        break;
      case 'file-missing': {
        const f = files.get(msg.fid);
        if (!f || !f.bytes || !Array.isArray(msg.list)) return;
        if (!msg.list.length) return;
        if (++f.up.rounds > 5) return toast('📎 파일을 다 올리지 못했어요. 다시 공유해 주세요');
        upload(f, msg.list.filter((i) => Number.isInteger(i) && i >= 0 && i < f.up.n));
        break;
      }
    }
  }
  async function onWelcome(room) {
    files.clear();
    for (const m of room.files || []) files.set(m.fid, { ...m, local: false });
    render();
    for (const f of files.values()) f.local = !!(await jamApp.fileHas(f.fid));
    render();
  }
  function reset() {
    for (const f of files.values()) if (f.by !== jam.you?.id) jamApp.fileDrop(f.fid); // 받은 파일은 메모리에서 지움
    files.clear();
    askedFor = null;
    render();
  }

  // ================= 화면 =================
  function row(f) {
    const mine = jam.isHost() && f.by === jam.you.id;
    const by = jam.member(f.by);
    let status;
    const actions = [];
    if (mine) {
      if (!f.ready) status = `올리는 중 ${Math.round((100 * (f.up?.sent || 0)) / Math.max(1, f.up?.n || 1))}%`;
      else {
        status = '공유 중';
        actions.push(el('button', { class: 'text-btn small', title: 'Jam 탭에서 이 파일 열기 (참여자도 따라와요)', onclick: () => openInJam(f.fid) }, 'Jam 탭에서 열기'));
      }
      actions.push(el('button', { class: 'text-btn small danger', title: '공유 취소 · 목록에서 지우기', onclick: () => remove(f.fid) }, '지우기'));
    } else if (!f.ready) status = '올리는 중…';
    else if (f.dl) status = `받는 중 ${Math.round((100 * f.dl.got) / Math.max(1, f.dl.n))}%`;
    else if (f.local) {
      status = '받음';
      actions.push(el('button', { class: 'text-btn small', onclick: () => openLocal(f) }, '열기'));
    } else {
      status = `${by?.name || '호스트'}님 공유`;
      actions.push(el('button', { class: 'text-btn small', onclick: () => download(f.fid, true) }, '받아서 열기'));
    }
    return el(
      'div',
      { class: 'file-row', 'data-fid': f.fid },
      el('span', { class: 'file-icon' }, KIND_ICON[f.kind] || '📎'),
      el('div', { class: 'file-main' }, el('div', { class: 'file-name', title: f.name }, f.name), el('div', { class: 'muted small' }, `${fmt(f.size)}${f.count > 1 ? ` · 파일 ${f.count}개` : ''} · ${status}`)),
      el('div', { class: 'file-actions' }, actions)
    );
  }
  function render() {
    const sec = $('#files-section');
    if (!sec) return;
    const active = !!(jam.active && jam.room);
    sec.hidden = !active;
    if (!active) return;
    const host = jam.isHost();
    $('#files-actions').hidden = !host;
    $('#file-share-pdf').hidden = !(host && activeTab && isWebPdf(activeTab.url));
    const list = [...files.values()];
    $('#files-list').replaceChildren(...(list.length ? list.map(row) : [el('div', { class: 'muted small' }, host ? '로컬 PDF · HTML · 이미지 · 텍스트 · SWF 를 같이 볼 수 있어요. 파일은 메모리에만 있고 Jam 이 끝나면 지워져요.' : '호스트가 공유한 파일이 여기 보여요.')]));
  }

  $('#file-share').addEventListener('click', pickAndShare);
  $('#file-share-pdf').addEventListener('click', shareWebPdf);

  return {
    handle, onWelcome, reset, render, gate, share, download, openInJam, remove,
    list: () => [...files.values()].map((f) => ({ fid: f.fid, name: f.name, kind: f.kind, size: f.size, ready: !!f.ready, local: !!f.local, dl: f.dl ? f.dl.got / f.dl.n : null, up: f.up ? f.up.sent / f.up.n : null })),
  };
})();
window.jamFiles = jamFiles;
