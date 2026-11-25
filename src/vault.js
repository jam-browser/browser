'use strict';
/**
 * 브라우저 계정 · 비밀번호 뱅크 · 친구 (메인 프로세스)
 *
 * 저장 위치: %APPDATA%\Jam Browser\vault\
 *   profile.jvault   금고 (vault-crypto.js 의 이중 암호화 + 바깥에 Windows 계정 암호화(DPAPI) 한 겹 더)
 *   secret-key.dat   개인 비밀 키 (DPAPI 로 암호화. 이 Windows 계정에서만 풀림 → 이 PC 에서는 비밀번호만으로 로그인)
 *   attempts.json    틀린 횟수 (연속으로 틀리면 기다리는 시간이 늘어남)
 *
 * 원칙
 * - 금고를 푸는 키, 사이트 비밀번호, 신원 비밀 키는 메인 프로세스 밖으로 나가지 않는다
 *   (앱 화면에는 목록만, 비밀번호는 클립보드 복사·재인증 후 보기·해당 사이트 페이지에 직접 채우기로만)
 * - 이 PC 계정: 아무것도 외부 서버로 보내지 않는다. Jam 상대에게는 친구 확인용 공개 키 + 서명만 (방 키로 암호화된 채)
 * - 서버 계정(아이디 · 비밀번호): 중계 서버에 "암호화된 금고 파일" 과 "로그인 확인 값(auth)" 만 보낸다.
 *   비밀번호 · 금고 열쇠 · 사이트 비밀번호 평문은 보내지 않음 → 서버(운영자)도 내용을 볼 수 없음.
 *   다른 기기에서 같은 아이디로 로그인하면 금고를 받아서 이 PC 에서 풀고, 바뀐 것은 항목마다 합쳐서 서로 올림
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./vault-crypto');
const ID = require('../shared/identity');
const API = require('./account-api');
const { mergeDocs } = require('../shared/vault-merge');

const DPAPI_MAGIC = 'JVDP1\n';
const CAPTURE_TTL = 2 * 60e3;
const CLIPBOARD_CLEAR_MS = 20000;

const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

function setupVault({ app, ipcMain, safeStorage, clipboard, dialog, powerMonitor, getWindow, remoteTouched = () => false, getPrefs = () => ({}), fetch: fetchImpl = globalThis.fetch, onFriendsChanged = () => {} }) {
  const SITE = require('../shared/site');
  const { domainToUnicode } = require('url');
  const warnedHosts = new Set();
  const dir = path.join(app.getPath('userData'), 'vault');
  const FILE = path.join(dir, 'profile.jvault');
  const SK_FILE = path.join(dir, 'secret-key.dat');
  const ATTEMPTS_FILE = path.join(dir, 'attempts.json');
  fs.mkdirSync(dir, { recursive: true });

  let file = null; // 디스크의 금고 (암호문)
  let session = null; // 풀린 상태 (DEK + 문서. 사이트 비밀번호는 여전히 항목별 암호문)
  let lastActivity = Date.now();
  const captures = new Map(); // 저장 제안을 기다리는 로그인 (2분)

  // ---------- 디스크 ----------
  const dpapi = () => {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  function writeAtomic(target, text) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  }
  const wrap = (text) => (dpapi() ? DPAPI_MAGIC + safeStorage.encryptString(text).toString('base64') : text);
  function unwrap(raw) {
    if (!raw.startsWith(DPAPI_MAGIC)) return raw;
    return safeStorage.decryptString(Buffer.from(raw.slice(DPAPI_MAGIC.length), 'base64'));
  }
  function readVaultFile() {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(unwrap(fs.readFileSync(FILE, 'utf8')));
  }
  const writeVaultFile = (obj) => writeAtomic(FILE, wrap(JSON.stringify(obj)));
  function readSecretKey() {
    try {
      return V.parseSecretKey(unwrap(fs.readFileSync(SK_FILE, 'utf8')));
    } catch {
      return null;
    }
  }
  function storeSecretKey(buf) {
    if (!dpapi()) return false; // Windows 계정 암호화를 못 쓰면 저장하지 않고 매번 입력받는다
    writeAtomic(SK_FILE, wrap(V.formatSecretKey(buf)));
    return true;
  }

  // ---------- 틀린 횟수 제한 ----------
  const readAttempts = () => {
    try {
      return JSON.parse(fs.readFileSync(ATTEMPTS_FILE, 'utf8'));
    } catch {
      return { fails: 0, nextAt: 0 };
    }
  };
  function registerFail() {
    const a = readAttempts();
    a.fails += 1;
    a.nextAt = a.fails >= 3 ? Date.now() + Math.min(5 * 60e3, 1000 * 2 ** (a.fails - 3)) : 0;
    writeAtomic(ATTEMPTS_FILE, JSON.stringify(a));
    return Math.max(0, a.nextAt - Date.now());
  }
  const resetAttempts = () => writeAtomic(ATTEMPTS_FILE, JSON.stringify({ fails: 0, nextAt: 0 }));

  // ---------- 공통 ----------
  const send = (ch, data) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, data);
  };
  // 앱 화면(내 창)에서 온 요청만 받는다. 웹페이지는 이 채널을 쓸 수 없다
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (e, arg = {}) => {
      const w = getWindow();
      if (!w || e.sender !== w.webContents) throw new Error('forbidden');
      return fn(arg);
    });
  const requireUnlocked = () => {
    if (!session) throw new Error('locked');
  };
  function persist({ push = true } = {}) {
    file = V.saveVault(session, file);
    writeVaultFile(file);
    if (push && acct) schedulePush();
  }
  const pairCache = new Map(); // 친구 공개 키 → 둘만 아는 비밀 (잠그면 지움)
  function lock(reason) {
    if (!session) return;
    stopSync();
    for (const ss of pairCache.values()) ss.fill(0);
    pairCache.clear();
    V.wipeSession(session);
    session = null;
    for (const c of captures.values()) c.password = '';
    captures.clear();
    send('vault:locked', { reason });
    onFriendsChanged(); // 친구 상태: 올려 둔 것을 바로 지움 (오프라인)
  }
  async function verifyMaster(password) {
    if (file && file.account) {
      const r = await V.unlockAccountVault(file, password, file.account.id); // 틀리면 throw
      r.auth.fill(0);
      return V.wipeSession(r.session);
    }
    const sk = readSecretKey();
    if (!sk) throw new Error('need-secret-key');
    const check = await V.unlockVault(file, password, sk); // 틀리면 throw
    V.wipeSession(check);
  }
  function status() {
    const a = readAttempts();
    return {
      exists: fs.existsSync(FILE),
      unlocked: !!session,
      name: session ? session.doc.profile.name : null,
      hasSecretKeyHere: !!readSecretKey(),
      account: accountMeta(), // 서버 계정이면 { server, id }
      sync: syncState,
      autoLockMinutes: session ? session.doc.settings.autoLockMinutes : null,
      dpapi: dpapi(),
      waitMs: Math.max(0, (a.nextAt || 0) - Date.now()),
    };
  }

  // ---------- 서버 계정 (중계 서버) · 동기화 ----------
  let acct = null; // 풀린 동안만: { api, id, server, auth(Buffer), token, rev }
  let syncState = { state: 'off' };
  let pushTimer = null;
  let pullTimer = null;
  let syncing = Promise.resolve();
  function accountMeta() {
    try {
      const f = file || readVaultFile();
      return f && f.account ? { server: f.account.server, id: f.account.id } : null;
    } catch {
      return null;
    }
  }
  const uploadable = (f) => {
    const { account, ...v } = f;
    return v;
  };
  function setSync(state, extra = {}) {
    syncState = { state, at: Date.now(), ...extra };
    send('vault:sync', syncState);
  }
  function startSync(a) {
    acct = a;
    clearInterval(pullTimer);
    pullTimer = setInterval(() => queueSync(pull), 60e3);
    queueSync(acct.token ? pull : loginAndMerge);
  }
  function stopSync() {
    clearTimeout(pushTimer);
    clearInterval(pullTimer);
    pushTimer = pullTimer = null;
    if (acct) {
      if (acct.token) acct.api.logout(acct.token);
      acct.auth.fill(0);
    }
    acct = null;
    syncState = { state: 'off' };
  }
  // 동기화 작업은 하나씩 차례로
  const queueSync = (fn) => (syncing = syncing.then(() => (acct && session ? fn() : null)).catch((e) => syncError(e)));
  function syncError(e) {
    if (!acct) return;
    if (e && e.code === 'bad-login') {
      // 다른 기기에서 비밀번호를 바꿨음 → 새 비밀번호로 다시 로그인해야 함
      setSync('relogin', { message: '다른 기기에서 계정 비밀번호가 바뀌었어요. 잠근 뒤 새 비밀번호로 다시 열어 주세요' });
      clearInterval(pullTimer);
      return;
    }
    setSync(e && e.code === 'offline' ? 'offline' : 'error', { message: (e && e.message) || String(e) });
  }
  async function withToken(fn) {
    if (!acct.token) await loginAndMerge();
    try {
      return await fn(acct.token);
    } catch (e) {
      if (e.code !== 'bad-token') throw e;
      acct.token = null; // 서버가 다시 켜졌거나 만료 → 다시 로그인
      await loginAndMerge();
      return fn(acct.token);
    }
  }
  async function loginAndMerge() {
    setSync('syncing');
    const r = await acct.api.login(acct.id, acct.auth);
    acct.token = r.token;
    await applyRemote(r.vault, r.rev);
  }
  async function pull() {
    setSync('syncing');
    const r = await withToken((t) => acct.api.getVault(t, acct.rev));
    if (r) await applyRemote(r.vault, r.rev);
    else setSync('ok');
  }
  // 서버 사본을 이 기기 것과 합치고, 서버가 뒤처졌으면 올림
  async function applyRemote(remote, rev) {
    if (!session || !acct) return;
    let remoteDoc;
    try {
      remoteDoc = V.openDocWith(session, remote);
    } catch {
      throw new Error('서버의 계정 데이터를 풀 수 없어요 (다른 계정의 데이터?)');
    }
    const m = mergeDocs(session.doc, remoteDoc);
    if (m.localChanged) {
      session.doc = m.doc;
      send('vault:changed', { sync: session.doc.sync || {} });
      onFriendsChanged();
    }
    // 다른 기기에서 비밀번호를 바꿨으면 금고 열쇠 포장(kdf · dek)은 서버 것을 씀
    if (remote.kdf && remote.dek && (remote.kdf.salt !== file.kdf.salt || JSON.stringify(remote.dek) !== JSON.stringify(file.dek))) {
      file = { ...file, kdf: remote.kdf, dek: remote.dek };
    }
    acct.rev = rev;
    file = { ...V.saveVault(session, file), account: { ...file.account, rev } };
    writeVaultFile(file);
    if (m.remoteBehind) await push();
    else setSync('ok');
  }
  async function push() {
    setSync('syncing');
    try {
      const r = await withToken((t) => acct.api.putVault(t, acct.rev, uploadable(file)));
      acct.rev = r.rev;
      file = { ...file, account: { ...file.account, rev: r.rev } };
      writeVaultFile(file);
      setSync('ok');
    } catch (e) {
      if (e.code === 'conflict' && e.body && e.body.vault) return applyRemote(e.body.vault, e.body.rev); // 합쳐서 다시
      throw e;
    }
  }
  // 이 PC 의 금고가 옛 비밀번호로 감싸져 있을 때: 새 비밀번호로 서버에 로그인해서 받은 금고로 바꾸고, 이 PC 문서는 합침
  async function serverRelogin(local, password) {
    const api = API.client(local.account.server);
    const id = local.account.id;
    const kdf = await api.prelogin(id);
    const auth = await V.accountAuth(password, kdf, id);
    let res;
    try {
      res = await api.login(id, auth);
    } finally {
      auth.fill(0);
    }
    const u = await V.unlockAccountVault(res.vault, password, id);
    try {
      u.session.doc = mergeDocs(V.openDocWith(u.session, local), u.session.doc).doc;
    } catch {}
    file = { ...V.saveVault(u.session, res.vault), account: { ...local.account, rev: res.rev } };
    writeVaultFile(file);
    return { r: u, token: res.token };
  }
  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => queueSync(push), 1500);
  }
  const newDoc = (name) => ({
    profile: { name: clean(name, 24) || '나', createdAt: Date.now(), updatedAt: Date.now() },
    identity: ID.newIdentity(),
    friends: [],
    logins: [],
    settings: { autoLockMinutes: 10 },
    tomb: {},
    sync: {},
  });
  function checkServerInput(server, id) {
    const base = API.serverBase(server);
    if (!base) throw new Error('중계 서버 주소가 올바르지 않아요 (예: relay.example.com:3031)');
    const nid = V.normId(id);
    if (!API.ID_RE.test(nid)) throw new Error('아이디는 영어 소문자 · 숫자 · . _ - 로 3~32자예요 (첫 글자는 영어나 숫자)');
    return { base, nid };
  }

  // 새 서버 계정 만들기
  handle('vault:server-create', async ({ server, id, name, password, invite }) => {
    if (fs.existsSync(FILE)) throw new Error('이미 이 PC 에 계정이 있어요');
    const { base, nid } = checkServerInput(server, id);
    const api = API.client(base);
    const r = await V.createAccountVault({ id: nid, password, doc: newDoc(name) });
    let reg;
    try {
      reg = await api.register(nid, r.auth, r.file, String(invite || '').trim());
    } catch (e) {
      V.wipeSession(r.session);
      r.auth.fill(0);
      throw e;
    }
    file = { ...r.file, account: { server: base, id: nid, rev: reg.rev } };
    session = r.session;
    writeVaultFile(file);
    resetAttempts();
    lastActivity = Date.now();
    startSync({ api, id: nid, server: base, auth: r.auth, token: reg.token, rev: reg.rev });
    return { ok: true, name: session.doc.profile.name, insecure: API.insecureInternet(base) };
  });

  // 다른 기기에서 만든 서버 계정으로 로그인 (이 PC 에는 아직 계정이 없을 때)
  handle('vault:server-login', async ({ server, id, password }) => {
    if (fs.existsSync(FILE)) throw new Error('이미 이 PC 에 계정이 있어요');
    const { base, nid } = checkServerInput(server, id);
    const api = API.client(base);
    const kdf = await api.prelogin(nid);
    const auth = await V.accountAuth(String(password || ''), kdf, nid);
    let r;
    try {
      r = await api.login(nid, auth);
    } finally {
      auth.fill(0);
    }
    const u = await V.unlockAccountVault(r.vault, String(password || ''), nid);
    file = { ...r.vault, account: { server: base, id: nid, rev: r.rev } };
    session = u.session;
    writeVaultFile(file);
    resetAttempts();
    lastActivity = Date.now();
    startSync({ api, id: nid, server: base, auth: u.auth, token: r.token, rev: r.rev });
    return { ok: true, name: session.doc.profile.name, insecure: API.insecureInternet(base) };
  });

  // 이 PC 계정을 서버 계정으로 올리기 (계정 비밀번호를 확인한 뒤, 그 비밀번호로 서버 계정을 만듦)
  handle('vault:server-upload', async ({ server, id, password, invite }) => {
    requireUnlocked();
    if (file.account) throw new Error('이미 서버 계정이에요');
    const { base, nid } = checkServerInput(server, id);
    try {
      await verifyMaster(String(password || ''));
    } catch {
      return { ok: false, error: 'wrong', waitMs: registerFail() };
    }
    resetAttempts();
    const api = API.client(base);
    if (!session.doc.tomb) session.doc.tomb = {};
    if (!session.doc.sync) session.doc.sync = {};
    const r = await V.rewrapForAccount(session, file, { id: nid, password: String(password) });
    let reg;
    try {
      reg = await api.register(nid, r.auth, r.file, String(invite || '').trim());
    } catch (e) {
      r.auth.fill(0);
      throw e;
    }
    file = { ...r.file, account: { server: base, id: nid, rev: reg.rev } };
    writeVaultFile(file);
    fs.rmSync(SK_FILE, { force: true }); // 서버 계정은 비밀 키를 쓰지 않음
    startSync({ api, id: nid, server: base, auth: r.auth, token: reg.token, rev: reg.rev });
    return { ok: true, insecure: API.insecureInternet(base) };
  });

  handle('vault:sync-now', () => {
    requireUnlocked();
    if (!acct) return syncState;
    return queueSync(pull).then(() => syncState);
  });
  // 동기화할 앱 데이터 (북마크 · 설정 등): 계정 문서 안에 암호화돼서 같이 다님
  handle('vault:sync-get', () => (session ? session.doc.sync || {} : null));
  handle('vault:sync-put', ({ key, value }) => {
    requireUnlocked();
    if (!/^[a-z][a-zA-Z0-9-]{1,31}$/.test(String(key))) throw new Error('bad key');
    const text = JSON.stringify(value === undefined ? null : value);
    if (text.length > 2 * 1024 * 1024) throw new Error('너무 커요');
    if (!session.doc.sync) session.doc.sync = {};
    const cur = session.doc.sync[key];
    if (cur && JSON.stringify(cur.v) === text) return true;
    session.doc.sync[key] = { v: JSON.parse(text), at: Date.now() };
    persist();
    return true;
  });

  // ---------- 계정 ----------
  handle('vault:status', () => status());

  handle('vault:create', async ({ name, password }) => {
    if (fs.existsSync(FILE)) throw new Error('이미 이 PC 에 계정이 있어요');
    const r = await V.createVault({ password, doc: newDoc(name) });
    file = r.file;
    session = r.session;
    writeVaultFile(file);
    const storedHere = storeSecretKey(r.secretKey);
    const shown = V.formatSecretKey(r.secretKey);
    r.secretKey.fill(0);
    resetAttempts();
    lastActivity = Date.now();
    return { secretKey: shown, storedHere };
  });

  handle('vault:unlock', async ({ password, secretKey }) => {
    const wait = Math.max(0, (readAttempts().nextAt || 0) - Date.now());
    if (wait > 0) return { ok: false, error: 'wait', waitMs: wait };
    file = readVaultFile();
    if (!file) return { ok: false, error: 'no-vault' };
    if (file.account) {
      let r;
      let token = null;
      try {
        r = await V.unlockAccountVault(file, String(password || ''), file.account.id);
      } catch (e) {
        if (e.code !== 'auth') throw e;
        // 다른 기기에서 비밀번호를 바꿨을 수 있음 → 이 비밀번호로 서버에 로그인해서 새 금고를 받아 봄 (이 PC 데이터는 합침)
        const fresh = await serverRelogin(file, String(password || '')).catch(() => null);
        if (!fresh) return { ok: false, error: 'wrong', waitMs: registerFail() };
        ({ r, token } = fresh);
      }
      session = r.session;
      resetAttempts();
      lastActivity = Date.now();
      startSync({ api: API.client(file.account.server), id: file.account.id, server: file.account.server, auth: r.auth, token, rev: file.account.rev || 0 });
      if (token) schedulePush(); // 이 PC 에만 있던 변경을 합친 것 올리기
      return { ok: true, name: session.doc.profile.name };
    }
    const typed = secretKey ? V.parseSecretKey(secretKey) : null;
    if (secretKey && !typed) return { ok: false, error: 'bad-secret-key' };
    const sk = typed || readSecretKey();
    if (!sk) return { ok: false, error: 'need-secret-key' };
    try {
      session = await V.unlockVault(file, String(password || ''), sk);
    } catch (e) {
      if (e.code === 'auth') return { ok: false, error: 'wrong', waitMs: registerFail() };
      throw e;
    }
    resetAttempts();
    if (typed && !readSecretKey()) storeSecretKey(typed);
    lastActivity = Date.now();
    return { ok: true, name: session.doc.profile.name };
  });

  handle('vault:lock', () => lock('manual'));
  handle('vault:activity', () => {
    lastActivity = Date.now();
  });

  handle('vault:change-password', async ({ oldPassword, newPassword }) => {
    requireUnlocked();
    try {
      await verifyMaster(oldPassword);
    } catch {
      return { ok: false, error: 'wrong' };
    }
    if (file.account) {
      if (!acct) throw new Error('서버 계정 연결이 없어요');
      const r = await V.rewrapForAccount(session, file, { id: file.account.id, password: newPassword });
      // 서버에 먼저 (실패하면 이 PC 도 그대로)
      const res = await withToken((t) => acct.api.password(t, acct.auth, r.auth, acct.rev, uploadable(r.file)));
      acct.auth.fill(0);
      acct.auth = r.auth;
      acct.rev = res.rev;
      file = { ...r.file, account: { ...file.account, rev: res.rev } };
      writeVaultFile(file);
      setSync('ok');
      return { ok: true };
    }
    file = await V.changePassword(session, file, newPassword, readSecretKey());
    writeVaultFile(file);
    return { ok: true };
  });

  // 중요한 동작(계정 삭제 등) 전에 계정 비밀번호를 다시 확인
  handle('vault:verify', async ({ password }) => {
    requireUnlocked();
    try {
      await verifyMaster(String(password || ''));
    } catch {
      return { ok: false, waitMs: registerFail() };
    }
    resetAttempts();
    return { ok: true };
  });

  handle('vault:settings', ({ autoLockMinutes }) => {
    requireUnlocked();
    session.doc.settings.autoLockMinutes = Math.min(240, Math.max(1, Math.round(Number(autoLockMinutes) || 10)));
    session.doc.settings.updatedAt = Date.now();
    persist();
    return session.doc.settings;
  });

  // 백업: Windows 계정 암호화를 뺀 금고 파일 (이중 암호화는 그대로). 다른 PC 에서는 비밀 키 + 비밀번호로 연다
  // 테스트(화면 밖 실행)에서만: 파일 창 대신 정해 둔 경로 (JAM_TEST_DIALOG_FILE)
  const testFile = () => (process.env.JAM_TEST_OFFSCREEN === '1' && process.env.JAM_TEST_DIALOG_FILE) || null;
  handle('vault:export', async () => {
    requireUnlocked();
    const { canceled, filePath } = testFile() ? { canceled: false, filePath: testFile() } : await dialog.showSaveDialog(getWindow(), {
      title: '브라우저 계정 백업',
      defaultPath: 'jam-account-backup.jvault',
      filters: [{ name: 'Jam 계정 백업', extensions: ['jvault'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, JSON.stringify(file));
    return filePath;
  });

  handle('vault:import', async () => {
    if (fs.existsSync(FILE)) throw new Error('이미 이 PC 에 계정이 있어요');
    const { canceled, filePaths } = testFile() ? { canceled: false, filePaths: [testFile()] } : await dialog.showOpenDialog(getWindow(), {
      title: '브라우저 계정 백업 불러오기',
      filters: [{ name: 'Jam 계정 백업', extensions: ['jvault'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return false;
    const obj = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (obj.format !== 'jam-vault' || !obj.dek || !obj.data || !obj.kdf) throw new Error('Jam 계정 백업 파일이 아니에요');
    writeVaultFile(obj);
    file = obj;
    return true;
  });

  handle('vault:delete-account', async () => {
    const server = file && file.account;
    const { response, checkboxChecked } = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      message: '이 PC 의 브라우저 계정을 삭제할까요?',
      ...(server ? { checkboxLabel: `중계 서버(${server.server.replace(/^https?:\/\//, '')})에서도 계정 "${server.id}" 를 지우기 — 다른 기기에서도 더 이상 로그인할 수 없어요`, checkboxChecked: false } : {}),
      detail: '저장한 비밀번호, 친구 목록, 내 신원 키가 모두 지워지고 되돌릴 수 없어요. 백업 파일이 있으면 나중에 불러올 수 있어요.\n\n안전을 위해 웹사이트 로그인 상태(쿠키 · 사이트 저장소)도 함께 지워져요. 계정 비밀번호를 모르는 사람이 계정을 지우고 내 사이트 로그인을 쓰지 못하게 하기 위해서예요.',
      buttons: ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    if (server && checkboxChecked) {
      if (!acct) throw new Error('잠금을 푼 상태에서만 서버 계정을 지울 수 있어요');
      await withToken((t) => acct.api.remove(t, acct.auth)); // 실패하면 이 PC 계정도 그대로
      acct.token = null;
    }
    lock('deleted');
    for (const f of [FILE, SK_FILE, ATTEMPTS_FILE]) fs.rmSync(f, { force: true });
    file = null;
    try {
      await require('electron').session.fromPartition('persist:jam').clearStorageData();
    } catch {}
    return true;
  });

  // ---------- 비밀번호 뱅크 ----------
  const listLogins = () =>
    session.doc.logins
      .map((l) => ({ id: l.id, origin: l.origin, title: l.title, username: l.username, updatedAt: l.updatedAt }))
      .sort((a, b) => a.origin.localeCompare(b.origin));

  function upsertLogin({ id, origin, title, username, password }) {
    const o = originOf(origin);
    if (!o) throw new Error('사이트 주소가 올바르지 않아요 (https://… )');
    const user = clean(username, 200);
    let entry = id ? session.doc.logins.find((l) => l.id === id) : session.doc.logins.find((l) => l.origin === o && l.username === user);
    if (!entry) {
      entry = { id: crypto.randomUUID(), createdAt: Date.now() };
      session.doc.logins.push(entry);
    }
    Object.assign(entry, { origin: o, title: clean(title, 100) || new URL(o).hostname, username: user, updatedAt: Date.now() });
    if (password !== undefined && password !== null && password !== '') entry.pw = V.sealField(session, entry.id, String(password).slice(0, 1000));
    if (!entry.pw) throw new Error('비밀번호를 입력하세요');
    persist();
    return entry.id;
  }

  handle('vault:logins', () => {
    requireUnlocked();
    return listLogins();
  });
  handle('vault:login-save', (arg) => {
    requireUnlocked();
    return upsertLogin(arg);
  });
  // 지운 것 기록 (서버 계정: 다른 기기에서 되살아나지 않게)
  const bury = (key) => {
    if (!session.doc.tomb) session.doc.tomb = {};
    session.doc.tomb[key] = Date.now();
  };
  handle('vault:login-delete', ({ id }) => {
    requireUnlocked();
    session.doc.logins = session.doc.logins.filter((l) => l.id !== id);
    bury(`l:${id}`);
    persist();
    return true;
  });
  // 복사: 앱 화면을 거치지 않고 클립보드로. 20초 뒤 그대로 남아 있으면 지운다
  handle('vault:login-copy', async ({ id }) => {
    requireUnlocked();
    const l = session.doc.logins.find((x) => x.id === id);
    if (!l) return false;
    const pw = V.openField(session, l.id, l.pw);
    await clipboard.writeText(pw);
    setTimeout(async () => {
      try {
        if ((await clipboard.readText()) === pw) await clipboard.clear();
      } catch {}
    }, CLIPBOARD_CLEAR_MS);
    lastActivity = Date.now();
    return true;
  });
  // 보기: 마스터 비밀번호를 한 번 더 확인한 뒤에만
  handle('vault:login-reveal', async ({ id, password }) => {
    requireUnlocked();
    try {
      await verifyMaster(password);
    } catch {
      return { ok: false, waitMs: registerFail() };
    }
    resetAttempts();
    const l = session.doc.logins.find((x) => x.id === id);
    return l ? { ok: true, password: V.openField(session, l.id, l.pw) } : { ok: false };
  });
  handle('vault:generate', ({ length }) => V.generatePassword(length));

  // ---------- 비밀번호 점검 ----------
  // 약함 · 재사용은 이 PC 안에서만 계산 (앱 화면에는 결과만, 비밀번호는 안 감)
  const HEALTH = require('../shared/password-health');
  const breached = new Map(); // id → { count, tag } (비밀번호가 바뀌면 tag 가 달라져 무효)
  const pwTag = (pw) => crypto.createHash('sha256').update(pw).digest('hex').slice(0, 16);
  function openAll() {
    return session.doc.logins.map((l) => ({ id: l.id, origin: l.origin, username: l.username, pw: l.pw ? V.openField(session, l.id, l.pw) : '' }));
  }
  handle('vault:health', () => {
    requireUnlocked();
    const all = openAll();
    const r = HEALTH.review(all);
    for (const l of all) {
      const b = breached.get(l.id);
      if (r[l.id]) r[l.id].breached = b && b.tag === pwTag(l.pw) ? b.count : null;
      l.pw = '';
    }
    return r;
  });
  // 유출 확인 (사용자가 눌렀을 때만): Have I Been Pwned 에 SHA-1 앞 5자리만 보내고(k-익명성),
  // 돌아온 목록에서 이 PC 가 직접 찾음. 비밀번호 · 아이디 · 사이트는 보내지 않음. 응답 크기도 섞음(Add-Padding)
  handle('vault:breach-check', async () => {
    requireUnlocked();
    const all = openAll();
    const byPrefix = new Map();
    for (const l of all) {
      if (!l.pw) continue;
      const { prefix, suffix } = HEALTH.hibpPrefix(l.pw);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push({ id: l.id, suffix, tag: pwTag(l.pw) });
      l.pw = '';
    }
    let checked = 0;
    let found = 0;
    for (const [prefix, items] of byPrefix) {
      const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' } });
      if (!res.ok) throw new Error(`유출 확인 서버 오류 (${res.status})`);
      const body = await res.text();
      for (const it of items) {
        const count = HEALTH.hibpCount(body, it.suffix);
        breached.set(it.id, { count, tag: it.tag });
        checked++;
        if (count) found++;
      }
    }
    return { checked, found };
  });

  // ---------- 신원 · 친구 ----------
  handle('identity:get', () => {
    if (!session) return null;
    const { pub } = session.doc.identity;
    const name = session.doc.profile.name;
    return { name, fp: ID.fingerprint(pub), friendCode: ID.friendCode(pub, name) };
  });
  // 친구만 Jam 에 들어갈 때: 정해진 형식의 메시지에만 서명 (아무 내용에나 서명해 주는 일이 없게)
  handle('identity:sign-join', ({ nonce, code }) => {
    if (!session) return null;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce)) || !/^[A-Za-z0-9]{4,8}$/.test(String(code))) return null;
    const { pub, priv } = session.doc.identity;
    lastActivity = Date.now();
    return { pub, sig: ID.signJoin(priv, nonce, code) };
  });
  handle('friends:list', () => (session ? session.doc.friends.map(({ fp, name, addedAt, hideStatus }) => ({ fp, name, addedAt, hideStatus: !!hideStatus })) : []));
  // 이 친구에게는 내 상태 숨기기 (그 친구에게만 오프라인으로 보임). 계정에 들어가서 내 다른 기기에도 같이
  handle('friends:set-hide', ({ fp, hide }) => {
    requireUnlocked();
    const f = session.doc.friends.find((x) => x.fp === fp);
    if (!f) throw new Error('친구 목록에 없어요');
    if (hide) f.hideStatus = true;
    else delete f.hideStatus;
    f.updatedAt = Date.now();
    persist();
    onFriendsChanged();
    return true;
  });
  handle('friends:add', ({ code, name }) => {
    requireUnlocked();
    const p = ID.parseFriendCode(code);
    if (!p) throw new Error('친구 코드 형식이 아니에요 (jamfriend:… )');
    if (p.pub === session.doc.identity.pub) throw new Error('내 친구 코드예요');
    const nm = clean(name, 24) || p.name || '친구';
    const existing = session.doc.friends.find((f) => f.fp === p.fp);
    if (existing) Object.assign(existing, { name: nm, updatedAt: Date.now() });
    else session.doc.friends.push({ fp: p.fp, pub: p.pub, name: nm, addedAt: Date.now(), updatedAt: Date.now() });
    if (session.doc.tomb) delete session.doc.tomb[`f:${p.fp}`];
    persist();
    onFriendsChanged();
    return { fp: p.fp, name: nm };
  });
  handle('friends:remove', ({ fp }) => {
    requireUnlocked();
    session.doc.friends = session.doc.friends.filter((f) => f.fp !== fp);
    bury(`f:${fp}`);
    persist();
    onFriendsChanged();
    return true;
  });

  // ---------- 웹페이지 자동 입력 · 저장 제안 (웹페이지 안 스크립트 ↔ 메인, 앱 화면을 거치지 않음) ----------
  const fromWebview = (e) => e.sender && e.sender.getType && e.sender.getType() === 'webview';

  ipcMain.on('pw:form-found', (e) => {
    if (!fromWebview(e)) return;
    const origin = originOf(e.sender.getURL());
    if (!origin) return;
    if (!session) return e.sender.send('pw:available', { origin, unlocked: false, locked: fs.existsSync(FILE), accounts: [] });
    const accounts = session.doc.logins.filter((l) => l.origin === origin).map((l) => ({ id: l.id, username: l.username }));
    // 저장한 사이트와 비슷한 가짜 주소인지 (저장한 계정이 없는 사이트에서만): 경고 + 🔑 채우기 없음
    let warn = null;
    if (!accounts.length && getPrefs().lookalikeWarn !== false) {
      try {
        const host = domainToUnicode(new URL(origin).hostname) || new URL(origin).hostname;
        const saved = [...new Set(session.doc.logins.map((l) => SITE.siteOf(l.origin)).filter(Boolean))];
        warn = SITE.lookalikeOf(host, saved);
        if (warn && !warnedHosts.has(host)) {
          warnedHosts.add(host);
          send('pw:lookalike', { host, like: warn });
        }
      } catch {}
    }
    e.sender.send('pw:available', { origin, unlocked: true, locked: false, accounts, warn });
  });

  ipcMain.on('pw:fill-request', (e, arg) => {
    if (!fromWebview(e) || !session) return;
    // 방금(3초 안) 다른 컴퓨터의 조작(화면 미러링)이 들어온 탭이면 채우지 않음 → 참여자가 🔑 를 눌러 채우게 만들 수 없음
    if (remoteTouched(e.sender.id, e.sender.getURL(), 3000)) return;
    const origin = originOf(e.sender.getURL());
    const l = session.doc.logins.find((x) => x.id === arg?.id);
    if (!l || l.origin !== origin) return; // 지금 보고 있는 사이트(정확히 같은 출처)에만
    lastActivity = Date.now();
    e.sender.send('pw:fill', { username: l.username, password: V.openField(session, l.id, l.pw) });
  });

  ipcMain.on('pw:captured', (e, arg) => {
    if (!fromWebview(e) || !session) return;
    // 이 사이트에 다른 컴퓨터의 입력(화면 미러링 조작)이 들어왔으면 저장 제안을 띄우지 않음 (30분)
    if (remoteTouched(e.sender.id, e.sender.getURL())) return;
    const origin = originOf(e.sender.getURL());
    const username = clean(arg?.username, 200);
    const password = String(arg?.password || '').slice(0, 1000);
    if (!origin || !password) return;
    const existing = session.doc.logins.find((l) => l.origin === origin && l.username === username);
    if (existing && V.openField(session, existing.id, existing.pw) === password) return; // 이미 저장된 그대로
    for (const [k, c] of captures) if (Date.now() - c.at > CAPTURE_TTL) captures.delete(k);
    const captureId = crypto.randomUUID();
    captures.set(captureId, { origin, username, password, at: Date.now() });
    send('pw:offer-save', { captureId, origin, username, update: !!existing });
  });

  handle('pw:save-capture', ({ captureId }) => {
    requireUnlocked();
    const c = captures.get(captureId);
    captures.delete(captureId);
    if (!c || Date.now() - c.at > CAPTURE_TTL) return false;
    upsertLogin({ origin: c.origin, username: c.username, password: c.password });
    c.password = '';
    return true;
  });
  handle('pw:discard-capture', ({ captureId }) => {
    const c = captures.get(captureId);
    if (c) c.password = '';
    captures.delete(captureId);
    return true;
  });

  // ---------- 자동 잠금 ----------
  setInterval(() => {
    if (!session) return;
    // 브라우저 창을 보면서 방금 마우스·키보드를 쓴 경우 = 사용 중 (웹페이지 안의 움직임도 포함)
    const w = getWindow();
    try {
      if (w && !w.isDestroyed() && w.isFocused() && powerMonitor && powerMonitor.getSystemIdleTime() < 20) lastActivity = Date.now();
    } catch {}
    const minutes = session.doc.settings.autoLockMinutes || 10;
    if (Date.now() - lastActivity > minutes * 60e3) lock('idle');
  }, 15000).unref?.();
  if (powerMonitor) {
    powerMonitor.on('lock-screen', () => lock('os-lock'));
    powerMonitor.on('suspend', () => lock('suspend'));
  }

  return {
    isUnlocked: () => !!session,
    lock,
    // 근처 페어링: 그 연결의 기록(th, SHA-256 hex)에만 서명. 잠겨 있으면 null (익명 페어링)
    signPair(th) {
      if (!session || !/^[0-9a-f]{64}$/.test(String(th))) return null;
      const { pub, priv } = session.doc.identity;
      lastActivity = Date.now();
      return { pub, sig: ID.signPair(priv, th) };
    },
    // 다른 기기에서 이어 보기: 계정 개인 키에서 만든 { id, key } (메인 프로세스 안에서만 씀). 잠겨 있으면 null
    presence() {
      if (!session) return null;
      return require('../shared/presence').derive(session.doc.identity.priv);
    },
    selfFp: () => (session ? ID.fingerprint(session.doc.identity.pub) : null),
    // 친구 상태: 친구마다 둘만 아는 비밀 (메인 프로세스 안에서만 씀). 잠겨 있으면 null
    friendPairs() {
      if (!session) return null;
      const FS = require('../shared/friend-status');
      const { pub, priv } = session.doc.identity;
      const pairs = [];
      for (const f of session.doc.friends) {
        const k = `${pub}|${f.pub}`;
        let ss = pairCache.get(k);
        if (!ss) {
          ss = FS.pairSecret(priv, f.pub);
          if (!ss) continue;
          pairCache.set(k, ss);
        }
        pairs.push({ fp: f.fp, name: f.name, pub: f.pub, hide: !!f.hideStatus, ss });
      }
      return { me: pub, pairs };
    },
  };
}

module.exports = { setupVault };
