'use strict';
// 브라우저 계정 (로그인) · 비밀번호 뱅크 · 친구
// 금고 열쇠와 사이트 비밀번호는 메인 프로세스에만 있다. 이 화면은 목록과 상태만 받는다.
// (app.js 의 $, el, toast, jam, faviconFor 를 쓴다)

const account = (() => {
  let state = { exists: false, unlocked: false, name: null, hasSecretKeyHere: false };
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
    } else friendsCache = [];
    updateAccessHint();
    return state;
  }

  // ---------- 잠금 화면 ----------
  function showStep(id) {
    $('#lock-screen').hidden = !id;
    for (const s of document.querySelectorAll('.ls-step')) s.hidden = s.id !== id;
    const focus = { 'ls-create': '#ls-name', 'ls-unlock': '#ls-unlock-pw' }[id];
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
    $('#ls-sk-row').hidden = state.hasSecretKeyHere;
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
          : `비밀번호${$('#ls-sk-row').hidden ? '' : ' 또는 비밀 키'}가 틀렸어요`;
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
  async function renderLogins() {
    loginsCache = await jamVault.logins().catch(() => []);
    const q = $('#login-q').value.trim().toLowerCase();
    const list = loginsCache.filter((l) => !q || `${l.origin} ${l.title} ${l.username}`.toLowerCase().includes(q));
    $('#login-empty').hidden = loginsCache.length > 0;
    $('#login-list').replaceChildren(
      ...list.map((l) => {
        const pwSpan = el('span', { class: 'l-pw', hidden: true });
        return el(
          'li',
          { class: 'login-row' },
          el('img', { src: faviconFor(l.origin), alt: '' }),
          el('div', { class: 'l-main' }, el('span', { class: 'l-site', title: l.origin }, l.title || l.origin), el('span', { class: 'l-user' }, `${l.username || '(아이디 없음)'} · ${l.origin}`), pwSpan),
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
          el('span', {}, '⭐'),
          el('b', {}, f.name),
          el('code', { title: '신원 지문' }, fpPretty(f.fp)),
          el('button', {
            class: 'mini-btn danger',
            onclick: async () => {
              if (!confirm(`${f.name}님을 친구에서 뺄까요? "친구만" Jam 에 더 이상 바로 들어오지 못해요`)) return;
              await jamVault.removeFriend(f.fp);
              await renderFriends();
              pushAllow();
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
    } catch (err) {
      toast(errText(err));
    }
  });

  // ---------- 계정 · 보안 ----------
  async function renderAccount() {
    await refresh();
    $('#acc-name').textContent = state.name || '';
    $('#acc-autolock').value = state.autoLockMinutes || 10;
  }
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
