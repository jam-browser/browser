'use strict';
// 브라우저 계정 (로그인) · 비밀번호 뱅크 · 친구
// 금고 열쇠와 사이트 비밀번호는 메인 프로세스에만 있다. 이 화면은 목록과 상태만 받는다.
// (app.js 의 $, el, toast, jam, faviconFor 를 쓴다)

const account = (() => {
  let state = { exists: false, unlocked: false, name: null, hasSecretKeyHere: false };
  let selfFp = null; // 내 계정 신원 지문 (다른 기기에서 이어 보기: 호스트가 같은 계정 기기를 바로 들여보냄)
  let friendsCache = [];
  let gateResolve = null;
  let revealTimer = null;

  const errText = (e) =>
    String(e?.message || e || '')
      .replace(/^Error invoking remote method '[^']+':\s*/, '')
      .replace(/^(\w*Error):\s*/, '');
  const secs = (ms) => Math.max(1, Math.ceil(ms / 1000));
  const fpPretty = (fp) => String(fp || '').replace(/(.{4})(?=.)/g, '$1 ');

  // ---------- 비밀번호 세기 (대략적인 경우의 수, bit) ----------
  function strength(pw) {
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/\d/.test(pw)) pool += 10;
    if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
    const unique = new Set(pw).size;
    let bits = Math.min(pw.length, unique * 2) * Math.log2(pool || 1);
    if (/^(.)\1+$/.test(pw) || /^(0123|1234|abcd|qwer|asdf|password|비밀번호)/i.test(pw)) bits = Math.min(bits, 20);
    if (bits < 45) return { bits, level: 0, text: '너무 쉬워요', color: 'var(--danger)' };
    if (bits < 60) return { bits, level: 1, text: '보통', color: '#ffd43b' };
    if (bits < 80) return { bits, level: 2, text: '강해요', color: 'var(--accent)' };
    return { bits, level: 3, text: '아주 강해요', color: 'var(--accent)' };
  }

  async function refresh() {
    const wasUnlocked = state.unlocked;
    try {
      state = await jamVault.status();
    } catch {}
    const btn = $('#account-btn');
    btn.textContent = state.exists && !state.unlocked ? '🔒' : '👤';
    btn.title = state.unlocked
      ? `${state.name} · 비밀번호 뱅크 · 친구 (Ctrl+Shift+P)`
      : state.exists
        ? '브라우저 계정이 잠겨 있어요'
        : '브라우저 계정 만들기 · 비밀번호 뱅크';
    if (state.unlocked) {
      friendsCache = await jamVault.friends().catch(() => []);
      const nameInput = $('#name');
      if (nameInput && !nameInput.value.trim()) nameInput.value = state.name || '';
      selfFp = (await jamVault.identity().catch(() => null))?.fp || null;
    } else {
      friendsCache = [];
      selfFp = null;
    }
    updateAccessHint();
    if (state.unlocked && !wasUnlocked) document.dispatchEvent(new Event('jam-account-unlocked'));
    return state;
  }

  // ---------- 잠금 화면 ----------
  function showStep(id) {
    $('#lock-screen').hidden = !id;
    for (const s of document.querySelectorAll('.ls-step')) s.hidden = s.id !== id;
    const focus = { 'ls-create': '#ls-name', 'ls-unlock': '#ls-unlock-pw', 'ls-login': '#ls-id', 'ls-signup': '#ls-su-id' }[id];
    if (focus) setTimeout(() => $(focus).focus(), 30);
  }
  function finishGate() {
    showStep(null);
    if (gateResolve) {
      gateResolve();
      gateResolve = null;
    }
  }
  function showUnlock(reasonText = '') {
    $('#ls-unlock-title').textContent = state.name ? `${state.name}님, 잠금 해제` : '잠금 해제';
    $('#ls-unlock-reason').textContent = reasonText;
    // 서버 계정: 아이디 @ 서버, 비밀 키 없음
    $('#ls-unlock-acct').hidden = !state.account;
    $('#ls-unlock-acct').textContent = state.account ? `🌐 ${state.account.id} @ ${prettyServer(state.account.server)}` : '';
    $('#ls-sk-row').hidden = !!state.account || state.hasSecretKeyHere;
    $('#ls-unlock-pw').value = '';
    $('#ls-unlock-sk').value = '';
    $('#ls-unlock-msg').textContent = state.waitMs > 0 ? `여러 번 틀려서 ${secs(state.waitMs)}초 뒤에 다시 시도할 수 있어요` : '';
    $('#ls-forgot-box').hidden = true;
    showStep('ls-unlock');
  }

  // 시작할 때: 계정이 있으면 잠금을 풀어야 브라우저(탭 복원 등)가 시작된다
  async function gate() {
    await refresh();
    if (state.unlocked) return;
    let skipped = false;
    try { skipped = localStorage.getItem('jam-account-skip') === '1'; } catch {}
    if (!state.exists && skipped) return;
    await new Promise((resolve) => {
      gateResolve = resolve;
      if (state.exists) showUnlock();
      else showStep('ls-welcome');
    });
  }

  // ---------- 서버 계정: 로그인 · 가입 ----------
  const prettyServer = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '');
  // 기본 서버 주소: 마지막에 쓴 계정 서버 → Jam 의 중계 서버 목록 첫 줄
  function defaultServer() {
    try {
      const last = localStorage.getItem('jam-account-server');
      if (last) return last;
    } catch {}
    const first = ($('#server-url')?.value || '').split(/[\s,]+/).find(Boolean);
    return first || '';
  }
  // 인터넷 주소를 암호화 없이(http) 쓰면 알림 (같은 네트워크 · 내 PC 는 괜찮음)
  function insecureNote(addr) {
    const a = String(addr || '').trim();
    if (!a || /^(wss|https):\/\//i.test(a)) return '';
    const host = a.replace(/^(wss?|https?):\/\//i, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const local = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|f[cd])/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /\.(local|localhost)$/.test(host);
    return local ? '' : '⚠️ 암호화 안 된 주소예요. 데이터는 이미 암호화돼 있지만, 인터넷에서는 wss:// (TLS) 주소를 권해요';
  }
  function rememberServer(addr) {
    try {
      localStorage.setItem('jam-account-server', addr);
    } catch {}
    // Jam 중계 서버 목록이 비어 있으면 같은 서버를 넣어 둠
    const box = $('#server-url');
    if (box && !box.value.trim()) {
      box.value = addr;
      try {
        localStorage.setItem('jam-server', addr);
      } catch {}
    }
  }
  function openLogin() {
    $('#ls-srv').value = $('#ls-srv').value || defaultServer();
    $('#ls-login-msg').textContent = '';
    $('#ls-login-warn').textContent = insecureNote($('#ls-srv').value);
    showStep('ls-login');
  }
  function openSignup() {
    $('#ls-su-srv').value = $('#ls-su-srv').value || $('#ls-srv').value || defaultServer();
    if (!$('#ls-su-id').value) $('#ls-su-id').value = $('#ls-id').value;
    $('#ls-su-msg').textContent = '';
    $('#ls-su-warn').textContent = insecureNote($('#ls-su-srv').value);
    showStep('ls-signup');
  }
  $('#ls-go-login').addEventListener('click', openLogin);
  $('#ls-go-signup').addEventListener('click', openSignup);
  $('#ls-login-to-signup').addEventListener('click', openSignup);
  $('#ls-srv').addEventListener('input', () => ($('#ls-login-warn').textContent = insecureNote($('#ls-srv').value)));
  $('#ls-su-srv').addEventListener('input', () => ($('#ls-su-warn').textContent = insecureNote($('#ls-su-srv').value)));
  $('#ls-su-pw').addEventListener('input', () => {
    const pw = $('#ls-su-pw').value;
    const st = strength(pw);
    Object.assign($('#ls-su-meter-bar').style, { width: pw ? `${Math.min(100, (st.bits / 90) * 100)}%` : '0', background: st.color });
    $('#ls-su-meter-text').textContent = pw ? `${st.text}${pw.length < 10 ? ' · 10자 이상 필요' : ''}` : '';
  });
  async function serverDone(r, server, verb) {
    try {
      localStorage.removeItem('jam-account-skip');
    } catch {}
    rememberServer(server);
    await refresh();
    finishGate();
    toast(`${state.name}님, ${verb} 🔐 비밀번호 뱅크 · 친구 · 북마크 · 설정이 이 아이디로 동기화돼요`);
    if (r.insecure) toast('⚠️ 암호화 안 된 중계 서버 주소(ws://)예요. 인터넷에서는 wss:// 를 쓰는 게 안전해요');
  }
  $('#ls-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#ls-login-msg');
    const server = $('#ls-srv').value.trim();
    const id = $('#ls-id').value.trim().toLowerCase();
    const pw = $('#ls-login-pw').value;
    if (!server) return (msg.textContent = '중계 서버 주소를 입력하세요');
    if (!id || !pw) return (msg.textContent = '아이디와 비밀번호를 입력하세요');
    const btn = $('#ls-login-btn');
    btn.disabled = true;
    btn.textContent = '로그인 중… (암호화 열쇠 만드는 중)';
    msg.textContent = '';
    try {
      const r = await jamVault.serverLogin({ server, id, password: pw });
      $('#ls-login-pw').value = '';
      await serverDone(r, server, '로그인했어요');
    } catch (err) {
      msg.textContent = errText(err);
      $('#ls-login-pw').select();
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  });
  $('#ls-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#ls-su-msg');
    const server = $('#ls-su-srv').value.trim();
    const id = $('#ls-su-id').value.trim().toLowerCase();
    const name = $('#ls-su-name').value.trim();
    const pw = $('#ls-su-pw').value;
    if (!server) return (msg.textContent = '중계 서버 주소를 입력하세요');
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(id)) return (msg.textContent = '아이디는 영어 소문자 · 숫자 · . _ - 로 3~32자예요 (첫 글자는 영어나 숫자)');
    if (!name) return (msg.textContent = '이름을 입력하세요');
    if (pw.length < 10) return (msg.textContent = '비밀번호는 10자 이상이어야 해요');
    if (strength(pw).level < 1) return (msg.textContent = '너무 쉬운 비밀번호예요. 더 길게, 여러 종류의 글자를 섞어 주세요');
    if (pw !== $('#ls-su-pw2').value) return (msg.textContent = '비밀번호 확인이 달라요');
    const btn = $('#ls-su-btn');
    btn.disabled = true;
    btn.textContent = '만드는 중… (암호화 열쇠 만드는 중)';
    msg.textContent = '';
    try {
      const r = await jamVault.serverCreate({ server, id, name, password: pw, invite: $('#ls-su-invite').value.trim() });
      $('#ls-su-pw').value = $('#ls-su-pw2').value = '';
      await serverDone(r, server, '계정을 만들었어요');
    } catch (err) {
      msg.textContent = errText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '만들기';
    }
  });

  $('#ls-go-create').addEventListener('click', () => {
    $('#ls-create-msg').textContent = '';
    showStep('ls-create');
  });
  $('#ls-skip').addEventListener('click', () => {
    try { localStorage.setItem('jam-account-skip', '1'); } catch {}
    finishGate();
  });
  document.querySelectorAll('.ls-back').forEach((b) => b.addEventListener('click', () => showStep('ls-welcome')));
  $('#ls-go-import').addEventListener('click', async () => {
    try {
      if (!(await jamVault.importBackup())) return;
      await refresh();
      showUnlock('백업을 불러왔어요. 계정 비밀번호와 비밀 키를 입력하세요');
    } catch (e) {
      toast(errText(e));
    }
  });

  $('#ls-pw').addEventListener('input', () => {
    const pw = $('#ls-pw').value;
    const s = strength(pw);
    Object.assign($('#ls-meter-bar').style, { width: pw ? `${Math.min(100, (s.bits / 90) * 100)}%` : '0', background: s.color });
    $('#ls-meter-text').textContent = pw ? `${s.text}${pw.length < 10 ? ' · 10자 이상 필요' : ''}` : '';
  });

  $('#ls-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#ls-name').value.trim();
    const pw = $('#ls-pw').value;
    const msg = $('#ls-create-msg');
    if (!name) return (msg.textContent = '이름을 입력하세요');
    if (pw.length < 10) return (msg.textContent = '비밀번호는 10자 이상이어야 해요');
    if (strength(pw).level < 1) return (msg.textContent = '너무 쉬운 비밀번호예요. 더 길게, 여러 종류의 글자를 섞어 주세요');
    if (pw !== $('#ls-pw2').value) return (msg.textContent = '비밀번호 확인이 달라요');
    const btn = $('#ls-create-btn');
    btn.disabled = true;
    btn.textContent = '암호화 열쇠 만드는 중…';
    try {
      const r = await jamVault.create(name, pw);
      $('#ls-pw').value = $('#ls-pw2').value = '';
      $('#ls-secret-text').textContent = r.secretKey;
      $('#ls-secret-ok').checked = false;
      $('#ls-secret-done').disabled = true;
      if (!r.storedHere) toast('⚠️ 이 PC 에 비밀 키를 저장하지 못했어요. 잠금을 풀 때마다 비밀 키를 입력해야 해요');
      try { localStorage.removeItem('jam-account-skip'); } catch {}
      await refresh();
      showStep('ls-secret');
    } catch (err) {
      msg.textContent = errText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '만들기';
    }
  });
  $('#ls-secret-copy').addEventListener('click', async () => {
    await jamApp.copy($('#ls-secret-text').textContent);
    toast('비밀 키를 복사했어요. 안전한 곳에 붙여 넣은 뒤 클립보드를 비우세요');
  });
  $('#ls-secret-ok').addEventListener('change', (e) => ($('#ls-secret-done').disabled = !e.target.checked));
  $('#ls-secret-done').addEventListener('click', () => {
    $('#ls-secret-text').textContent = '';
    finishGate();
    toast(`${state.name}님, 브라우저 계정을 만들었어요 🔐`);
  });

  $('#ls-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#ls-unlock-msg');
    const btn = $('#ls-unlock-btn');
    btn.disabled = true;
    btn.textContent = '확인 중…';
    msg.textContent = '';
    try {
      const sk = $('#ls-sk-row').hidden ? undefined : $('#ls-unlock-sk').value.trim() || undefined;
      const r = await jamVault.unlock($('#ls-unlock-pw').value, sk);
      if (r.ok) {
        $('#ls-unlock-pw').value = '';
        $('#ls-unlock-sk').value = '';
        await refresh();
        finishGate();
        return;
      }
      if (r.error === 'wait') msg.textContent = `여러 번 틀려서 ${secs(r.waitMs)}초 뒤에 다시 시도할 수 있어요`;
      else if (r.error === 'need-secret-key') {
        $('#ls-sk-row').hidden = false;
        msg.textContent = '이 PC 에 비밀 키가 없어요. 계정을 만들 때 받은 비밀 키를 입력하세요';
      } else if (r.error === 'bad-secret-key') msg.textContent = '비밀 키 형식이 올바르지 않아요 (JK1-XXXX-…)';
      else if (r.error === 'no-vault') {
        await refresh();
        showStep('ls-welcome');
      } else {
        msg.textContent = r.waitMs > 0
          ? `비밀번호가 틀렸어요. ${secs(r.waitMs)}초 뒤에 다시 시도할 수 있어요`
          : `비밀번호${$('#ls-sk-row').hidden ? '' : ' 또는 비밀 키'}가 틀렸어요${state.account ? ' (다른 기기에서 바꿨다면 새 비밀번호로 — 서버에서 확인해요)' : ''}`;
      }
      $('#ls-unlock-pw').select();
    } catch (err) {
      msg.textContent = errText(err);
    } finally {
      btn.disabled = false;
      btn.textContent = '잠금 해제';
    }
  });
  $('#ls-forgot').addEventListener('click', () => ($('#ls-forgot-box').hidden = !$('#ls-forgot-box').hidden));
  async function deleteAccount() {
    try {
      if (!(await jamVault.deleteAccount())) return false;
      await refresh();
      $('#vault-dialog').close();
      toast('브라우저 계정을 삭제했어요');
      showStep('ls-welcome');
      return true;
    } catch (e) {
      toast(errText(e));
      return false;
    }
  }
  $('#ls-delete').addEventListener('click', deleteAccount);

  jamVault.onLocked(async (info) => {
    for (const d of ['#vault-dialog', '#pw-ask-dialog']) if ($(d).open) $(d).close();
    await refresh();
    if (info?.reason === 'deleted') return;
    const reason = {
      idle: '한동안 사용하지 않아서 잠겼어요',
      'os-lock': 'Windows 화면이 잠겨서 함께 잠겼어요',
      suspend: '절전 모드로 들어가서 잠겼어요',
      manual: '',
    }[info?.reason] ?? '';
    showUnlock(reason);
  });

  // ---------- 사이트 로그인 저장 제안 ----------
  // 저장한 로그인 사이트와 비슷한 가짜 주소에서 로그인 칸이 보이면 경고
  jamVault.onLookalike((info) => {
    toast(`⚠️ 주의: 지금 사이트(${info.host})는 저장한 로그인 사이트 ${info.like} 와 비슷한 다른 주소예요. 피싱일 수 있어요. 🔑 자동 입력은 하지 않아요`);
  });
  jamVault.onOfferSave((info) => {
    let host = info.origin;
    try { host = new URL(info.origin).host; } catch {}
    let done = false;
    const answer = async (save) => {
      if (done) return;
      done = true;
      t.remove();
      try {
        if (save && (await jamVault.saveCapture(info.captureId))) toast(`🔑 ${host} 로그인을 비밀번호 뱅크에 저장했어요`);
        else if (!save) await jamVault.discardCapture(info.captureId);
      } catch (e) {
        toast(errText(e));
      }
    };
    const t = el(
      'div',
      { class: 'toast save-toast' },
      el('span', {}, `🔑 ${host} 의 "${info.username || '(아이디 없음)'}" 로그인을 ${info.update ? '새 비밀번호로 바꿀까요?' : '비밀번호 뱅크에 저장할까요?'}`),
      el('button', { class: 'toast-btn', onclick: () => answer(true) }, info.update ? '바꾸기' : '저장'),
      el('button', { class: 'toast-btn', onclick: () => answer(false) }, '안 함')
    );
    $('#toasts').append(t);
    setTimeout(() => answer(false), 45000);
  });

  // ---------- 계정 비밀번호 다시 묻기 ----------
  function askPassword(title) {
    const d = $('#pw-ask-dialog');
    $('#pw-ask-title').textContent = title;
    $('#pw-ask-input').value = '';
    $('#pw-ask-msg').textContent = '';
    d.showModal();
    setTimeout(() => $('#pw-ask-input').focus(), 30);
    return new Promise((resolve) => {
      const finish = (v) => {
        $('#pw-ask-form').removeEventListener('submit', onSubmit);
        $('#pw-ask-cancel').removeEventListener('click', onCancel);
        d.removeEventListener('close', onClose);
        if (d.open) d.close();
        $('#pw-ask-input').value = '';
        resolve(v);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        finish($('#pw-ask-input').value);
      };
      const onCancel = () => finish(null);
      const onClose = () => finish(null);
      $('#pw-ask-form').addEventListener('submit', onSubmit);
      $('#pw-ask-cancel').addEventListener('click', onCancel);
      d.addEventListener('close', onClose);
    });
  }

  // ---------- 비밀번호 뱅크 창 ----------
  function showPage(page) {
    document.querySelectorAll('#vault-nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
    document.querySelectorAll('#vault-dialog .set-page').forEach((p) => (p.hidden = p.id !== page));
    if (page === 'vault-logins') renderLogins();
    if (page === 'vault-friends') renderFriends();
    if (page === 'vault-account') renderAccount();
  }
  document.querySelectorAll('#vault-nav button').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));

  async function open(page = 'vault-logins') {
    await refresh();
    if (!state.exists) {
      // 계정 없이 쓰는 중: 만들기 화면 (닫으면 그대로 계속)
      showStep('ls-welcome');
      return;
    }
    if (!state.unlocked) return showUnlock();
    $('#vault-title').textContent = `${state.name} · 내 계정`;
    if (!$('#vault-dialog').open) $('#vault-dialog').showModal();
    showPage(page);
  }

  let loginsCache = [];
  // 비밀번호 점검 결과 (약함 · 재사용 · 유출) — 계산은 메인 프로세스, 여기엔 결과만
  let healthCache = {};
  const needsFix = (h) => h && (h.weak || h.reusedWith.length || h.breached > 0);
  function healthTags(l) {
    const h = healthCache[l.id];
    if (!h) return [];
    const tags = [];
    if (h.breached > 0) tags.push(el('span', { class: 'pw-tag bad', title: `알려진 유출 목록에 ${h.breached.toLocaleString()}번 나온 비밀번호예요. 바꾸세요` }, '⚠ 유출됨'));
    if (h.reusedWith.length) {
      const others = h.reusedWith.map((id) => loginsCache.find((x) => x.id === id)).filter(Boolean).map((x) => x.title || x.origin);
      tags.push(el('span', { class: 'pw-tag bad', title: `같은 비밀번호: ${others.join(', ')}` }, `재사용 ${h.reusedWith.length + 1}곳`));
    }
    if (h.weak) tags.push(el('span', { class: 'pw-tag warn', title: h.reasons.join(' · ') || '추측하기 쉬워요' }, `약함${h.reasons[0] ? ' · ' + h.reasons[0] : ''}`));
    if (h.breached === 0) tags.push(el('span', { class: 'pw-tag', title: '마지막 유출 확인에서 나오지 않았어요' }, '유출 없음'));
    return tags;
  }
  function renderHealthBar() {
    const vals = loginsCache.map((l) => healthCache[l.id]).filter(Boolean);
    $('#pw-health').hidden = !loginsCache.length;
    const weak = vals.filter((h) => h.weak).length;
    const reused = vals.filter((h) => h.reusedWith.length).length;
    const br = vals.filter((h) => h.breached > 0).length;
    const parts = [];
    if (br) parts.push(`⚠ 유출 ${br}`);
    if (reused) parts.push(`재사용 ${reused}`);
    if (weak) parts.push(`약함 ${weak}`);
    $('#pw-health-text').textContent = parts.length ? `비밀번호 점검: ${parts.join(' · ')} — 바꾸기를 권해요` : `비밀번호 점검: ${vals.length}개 모두 괜찮아요`;
    $('#pw-health-text').className = parts.length ? 'pw-bad' : '';
  }
  $('#pw-health-only').addEventListener('change', () => renderLogins(true));
  $('#pw-breach').addEventListener('click', async () => {
    const btn = $('#pw-breach');
    btn.disabled = true;
    btn.textContent = '확인 중…';
    try {
      const r = await jamVault.breachCheck();
      toast(r.found ? `⚠ ${r.checked}개 중 ${r.found}개가 알려진 유출 목록에 있어요. 바꾸세요` : `${r.checked}개 모두 알려진 유출 목록에 없어요`);
      await renderLogins();
    } catch (e) {
      toast('유출 확인 실패: ' + errText(e));
    } finally {
      btn.disabled = false;
      btn.textContent = '유출 확인';
    }
  });

  async function renderLogins(cached) {
    if (!cached) {
      loginsCache = await jamVault.logins().catch(() => []);
      healthCache = await jamVault.health().catch(() => ({}));
    }
    renderHealthBar();
    const q = $('#login-q').value.trim().toLowerCase();
    const only = $('#pw-health-only').checked;
    const list = loginsCache.filter((l) => (!q || `${l.origin} ${l.title} ${l.username}`.toLowerCase().includes(q)) && (!only || needsFix(healthCache[l.id])));
    $('#login-empty').hidden = loginsCache.length > 0;
    $('#login-list').replaceChildren(
      ...list.map((l) => {
        const pwSpan = el('span', { class: 'l-pw', hidden: true });
        return el(
          'li',
          { class: 'login-row' },
          el('img', { src: faviconFor(l.origin), alt: '' }),
          el('div', { class: 'l-main' }, el('span', { class: 'l-site', title: l.origin }, l.title || l.origin), el('span', { class: 'l-user' }, `${l.username || '(아이디 없음)'} · ${l.origin}`), el('div', { class: 'l-health' }, ...healthTags(l)), pwSpan),
          el('button', {
            class: 'mini-btn',
            title: '비밀번호 복사 (20초 뒤 클립보드에서 지워져요)',
            onclick: async () => {
              if (await jamVault.copyPassword(l.id).catch(() => false)) toast('비밀번호를 복사했어요 · 20초 뒤 클립보드에서 지워져요');
            },
          }, '복사'),
          el('button', {
            class: 'mini-btn',
            title: '계정 비밀번호를 다시 확인한 뒤 보여 줘요',
            onclick: async () => {
              const pw = await askPassword(`${l.title || l.origin} 비밀번호 보기 · 계정 비밀번호 확인`);
              if (pw === null) return;
              const r = await jamVault.revealPassword(l.id, pw).catch((e) => ({ ok: false, error: errText(e) }));
              if (!r.ok) return toast(r.waitMs > 0 ? `계정 비밀번호가 틀렸어요 (${secs(r.waitMs)}초 뒤 다시)` : r.error || '계정 비밀번호가 틀렸어요');
              pwSpan.textContent = r.password;
              pwSpan.hidden = false;
              clearTimeout(revealTimer);
              revealTimer = setTimeout(() => {
                pwSpan.textContent = '';
                pwSpan.hidden = true;
              }, 15000);
            },
          }, '보기'),
          el('button', { class: 'mini-btn', onclick: () => editLogin(l) }, '수정'),
          el('button', {
            class: 'mini-btn danger',
            onclick: async () => {
              if (!confirm(`${l.title || l.origin} 의 "${l.username}" 로그인을 삭제할까요?`)) return;
              await jamVault.deleteLogin(l.id);
              renderLogins();
            },
          }, '삭제')
        );
      })
    );
  }
  $('#login-q').addEventListener('input', () => renderLogins());

  function editLogin(l) {
    const f = $('#login-form');
    f.hidden = false;
    $('#lf-id').value = l?.id || '';
    $('#lf-origin').value = l?.origin || (activeTab && /^https?:/.test(activeTab.url) ? new URL(activeTab.url).origin : '');
    $('#lf-user').value = l?.username || '';
    $('#lf-pw').value = '';
    $('#lf-pw').type = 'password';
    $('#lf-pw-note').textContent = l ? '(비워 두면 그대로)' : '';
    $(l ? '#lf-pw' : '#lf-origin').focus();
  }
  function closeLoginForm() {
    $('#login-form').hidden = true;
    $('#lf-pw').value = '';
  }
  $('#login-add').addEventListener('click', () => editLogin(null));
  $('#lf-cancel').addEventListener('click', closeLoginForm);
  $('#lf-gen').addEventListener('click', async () => {
    $('#lf-pw').value = await jamVault.generate(20);
    $('#lf-pw').type = 'text';
  });
  $('#lf-show').addEventListener('click', () => ($('#lf-pw').type = $('#lf-pw').type === 'password' ? 'text' : 'password'));
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let origin = $('#lf-origin').value.trim();
    if (origin && !/^https?:\/\//i.test(origin)) origin = 'https://' + origin;
    try {
      await jamVault.saveLogin({ id: $('#lf-id').value || undefined, origin, username: $('#lf-user').value.trim(), password: $('#lf-pw').value });
      closeLoginForm();
      toast('저장했어요 (이중 암호화)');
      renderLogins();
    } catch (err) {
      toast(errText(err));
    }
  });

  // ---------- 친구 ----------
  function pushAllow() {
    if (typeof jam !== 'undefined' && jam.active && jam.isHost() && state.unlocked) {
      jam.send({ type: 'settings', allow: friendsCache.map((f) => f.fp) });
    }
  }
  async function renderFriends() {
    const me = await jamVault.identity().catch(() => null);
    $('#my-friend-code').textContent = me?.friendCode || '';
    $('#my-fp').textContent = fpPretty(me?.fp);
    friendsCache = await jamVault.friends().catch(() => []);
    $('#friend-empty').hidden = friendsCache.length > 0;
    $('#friend-list').replaceChildren(
      ...friendsCache.map((f) =>
        el(
          'li',
          {},
          el('span', { title: '친구 상태 (👥)' }, window.jamFriendStatus ? window.jamFriendStatus.dot(f.fp) : '⭐'),
          el('b', {}, f.name),
          f.hideStatus ? el('span', { class: 'muted small', title: '이 친구에게는 내 상태가 오프라인으로 보여요 (👥 에서 바꾸기)' }, '🙈 숨김') : null,
          el('code', { title: '신원 지문' }, fpPretty(f.fp)),
          el('button', {
            class: 'mini-btn danger',
            onclick: async () => {
              if (!confirm(`${f.name}님을 친구에서 뺄까요? "친구만" Jam 에 더 이상 바로 들어오지 못해요`)) return;
              await jamVault.removeFriend(f.fp);
              await renderFriends();
              pushAllow();
              jamFriends.refresh().catch(() => {});
            },
          }, '삭제')
        )
      )
    );
  }
  $('#copy-friend-code').addEventListener('click', async () => {
    await jamApp.copy($('#my-friend-code').textContent);
    toast('친구 코드를 복사했어요. 친구에게 보내고, 친구의 코드도 받아서 추가하세요');
  });
  $('#friend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await jamVault.addFriend($('#friend-code').value.trim(), $('#friend-name').value.trim());
      $('#friend-code').value = $('#friend-name').value = '';
      toast(`⭐ ${r.name}님을 친구로 추가했어요`);
      await renderFriends();
      pushAllow();
      jamFriends.refresh().catch(() => {});
    } catch (err) {
      toast(errText(err));
    }
  });

  // ---------- 계정 · 보안 ----------
  const SYNC_TEXT = { ok: '✓ 동기화됨', syncing: '동기화 중…', offline: '서버에 연결할 수 없어요 (다시 연결되면 이어서 해요)', error: '동기화 오류', relogin: '다시 로그인 필요', off: '' };
  function renderSync(sync) {
    const st = sync || state.sync || { state: 'off' };
    const el2 = $('#acc-sync-state');
    if (!el2) return;
    const when = st.at ? ` · ${new Date(st.at).toLocaleTimeString()}` : '';
    el2.textContent = `${SYNC_TEXT[st.state] || st.state}${st.message && st.state !== 'ok' ? ` — ${st.message}` : ''}${st.state === 'ok' ? when : ''}`;
    el2.classList.toggle('err', ['error', 'relogin'].includes(st.state));
  }
  async function renderAccount() {
    await refresh();
    $('#acc-name').textContent = state.name || '';
    $('#acc-autolock').value = state.autoLockMinutes || 10;
    const a = state.account;
    $('#acc-server-on').hidden = !a;
    $('#acc-upload').hidden = !!a;
    if (a) {
      $('#acc-server-who').textContent = `🌐 ${a.id} @ ${prettyServer(a.server)}`;
      renderSync();
    } else {
      $('#acc-up-srv').value = $('#acc-up-srv').value || defaultServer();
    }
  }
  $('#acc-sync-now').addEventListener('click', async () => {
    renderSync({ state: 'syncing' });
    try {
      renderSync(await jamVault.syncNow());
    } catch (e) {
      renderSync({ state: 'error', message: errText(e) });
    }
  });
  jamVault.onSync((st) => {
    state.sync = st;
    renderSync(st);
    if (st.state === 'relogin') toast('🌐 ' + st.message);
  });
  // 다른 기기에서 바뀐 것을 받으면 목록 다시 그리기
  jamVault.onChanged(() => {
    if ($('#vault-dialog').open) {
      renderLogins();
      renderFriends();
    }
    refresh();
  });
  $('#acc-upload').addEventListener('submit', async (e) => {
    e.preventDefault();
    const server = $('#acc-up-srv').value.trim();
    const id = $('#acc-up-id').value.trim().toLowerCase();
    const pw = $('#acc-up-pw').value;
    if (!server || !id || !pw) return toast('서버 주소 · 아이디 · 지금 계정 비밀번호를 입력하세요');
    try {
      const r = await jamVault.serverUpload({ server, id, password: pw, invite: $('#acc-up-invite').value.trim() });
      if (!r.ok) return toast(r.waitMs > 0 ? `계정 비밀번호가 틀렸어요 (${secs(r.waitMs)}초 뒤 다시)` : '계정 비밀번호가 틀렸어요');
      $('#acc-up-pw').value = '';
      rememberServer(server);
      toast(`🌐 서버 계정 "${id}" 로 올렸어요. 다른 기기에서 이 아이디 · 비밀번호로 로그인하세요`);
      if (r.insecure) toast('⚠️ 암호화 안 된 중계 서버 주소(ws://)예요. 인터넷에서는 wss:// 를 쓰는 게 안전해요');
      renderAccount();
    } catch (err) {
      toast(errText(err));
    }
  });
  $('#acc-autolock-save').addEventListener('click', async () => {
    try {
      const s = await jamVault.setAutoLock(Number($('#acc-autolock').value));
      $('#acc-autolock').value = s.autoLockMinutes;
      toast(`${s.autoLockMinutes}분 동안 사용하지 않으면 잠가요`);
    } catch (e) {
      toast(errText(e));
    }
  });
  $('#acc-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPw = $('#acc-pw-old').value;
    const nw = $('#acc-pw-new').value;
    if (nw.length < 10) return toast('새 비밀번호는 10자 이상이어야 해요');
    if (strength(nw).level < 1) return toast('너무 쉬운 비밀번호예요');
    if (nw !== $('#acc-pw-new2').value) return toast('새 비밀번호 확인이 달라요');
    try {
      const r = await jamVault.changePassword(oldPw, nw);
      if (!r.ok) return toast('지금 비밀번호가 틀렸어요');
      for (const id of ['#acc-pw-old', '#acc-pw-new', '#acc-pw-new2']) $(id).value = '';
      toast('계정 비밀번호를 바꿨어요 (새 솔트로 다시 암호화)');
    } catch (err) {
      toast(errText(err));
    }
  });
  $('#acc-export').addEventListener('click', async () => {
    try {
      const p = await jamVault.exportBackup();
      if (p) toast('백업 파일을 저장했어요. 열 때 계정 비밀번호와 비밀 키가 필요해요');
    } catch (e) {
      toast(errText(e));
    }
  });
  $('#acc-delete').addEventListener('click', async () => {
    const pw = await askPassword('계정 삭제 · 계정 비밀번호 확인');
    if (pw === null) return;
    const r = await jamVault.verify(pw).catch(() => ({ ok: false }));
    if (!r.ok) return toast(r.waitMs > 0 ? `계정 비밀번호가 틀렸어요 (${secs(r.waitMs)}초 뒤 다시)` : '계정 비밀번호가 틀렸어요');
    deleteAccount();
  });
  async function lockNow() {
    await refresh();
    if (!state.unlocked) return;
    await jamVault.lock();
  }
  $('#vault-lock').addEventListener('click', lockNow);
  $('#vault-close').addEventListener('click', () => $('#vault-dialog').close());
  $('#vault-dialog').addEventListener('close', () => {
    closeLoginForm();
    clearTimeout(revealTimer);
    $('#login-list').replaceChildren();
  });
  $('#account-btn').addEventListener('click', () => open());

  // ---------- Jam 입장 방식 ----------
  const ACCESS_HINT = {
    approval: '초대 링크를 가진 사람이 참여를 요청하면 내가 수락해야 들어와요. 친구는 카드에 ⭐ 로 표시돼요.',
    friends: '내 친구 목록에 있고, 브라우저 계정 서명으로 본인 확인된 사람만 바로 들어와요. 나머지는 링크가 있어도 거절돼요.',
    open: '초대 링크만 있으면 누구나 바로 들어와요. 링크를 아무 데나 올리지 마세요.',
  };
  function updateAccessHint() {
    const sel = $('#access-mode');
    if (!sel) return;
    let text = ACCESS_HINT[sel.value] || '';
    if (sel.value === 'friends' && !state.unlocked) text += ' ⚠️ 친구 목록은 브라우저 계정에 있어서, 계정에 로그인해야 쓸 수 있어요.';
    else if (sel.value === 'friends' && !friendsCache.length) text += ' ⚠️ 아직 친구가 없어요 (👤 → 친구).';
    $('#access-hint').textContent = text;
  }
  try {
    const saved = localStorage.getItem('jam-access');
    if (saved && ACCESS_HINT[saved]) $('#access-mode').value = saved;
  } catch {}
  $('#access-mode').addEventListener('change', (e) => {
    try { localStorage.setItem('jam-access', e.target.value); } catch {}
    updateAccessHint();
  });

  return {
    gate,
    open,
    lockNow,
    refresh,
    isUnlocked: () => state.unlocked,
    selfFp: () => (state.unlocked ? selfFp : null),
    server: () => (state.account ? state.account.server : null), // 서버 계정이면 서버 주소
    friendFps: () => (state.unlocked ? friendsCache.map((f) => f.fp) : []),
    friendName: (fp) => friendsCache.find((f) => f.fp === fp)?.name || null,
    fpPretty,
    accessMode: () => $('#access-mode').value,
    // 참여 서명: 계정이 열려 있을 때만 (잠겨 있거나 계정이 없으면 익명 참여)
    async signJoin(nonce, code) {
      if (!state.unlocked) return null;
      try {
        return await jamVault.signJoin(nonce, code);
      } catch {
        return null;
      }
    },
  };
})();
window.account = account;
