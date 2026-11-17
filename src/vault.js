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
 * - 아무것도 외부 서버로 보내지 않는다. Jam 상대에게는 친구 확인용 공개 키 + 서명만 (방 키로 암호화된 채)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const V = require('./vault-crypto');
const ID = require('../shared/identity');

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

function setupVault({ app, ipcMain, safeStorage, clipboard, dialog, powerMonitor, getWindow, remoteTouched = () => false }) {
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
  function persist() {
    file = V.saveVault(session, file);
    writeVaultFile(file);
  }
  function lock(reason) {
    if (!session) return;
    V.wipeSession(session);
    session = null;
    for (const c of captures.values()) c.password = '';
    captures.clear();
    send('vault:locked', { reason });
  }
  async function verifyMaster(password) {
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
      autoLockMinutes: session ? session.doc.settings.autoLockMinutes : null,
      dpapi: dpapi(),
      waitMs: Math.max(0, (a.nextAt || 0) - Date.now()),
    };
  }

  // ---------- 계정 ----------
  handle('vault:status', () => status());

  handle('vault:create', async ({ name, password }) => {
    if (fs.existsSync(FILE)) throw new Error('이미 이 PC 에 계정이 있어요');
    const doc = {
      profile: { name: clean(name, 24) || '나', createdAt: Date.now() },
      identity: ID.newIdentity(),
      friends: [],
      logins: [],
      settings: { autoLockMinutes: 10 },
    };
    const r = await V.createVault({ password, doc });
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
    persist();
    return session.doc.settings;
  });

  // 백업: Windows 계정 암호화를 뺀 금고 파일 (이중 암호화는 그대로). 다른 PC 에서는 비밀 키 + 비밀번호로 연다
  handle('vault:export', async () => {
    requireUnlocked();
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
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
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
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
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'warning',
      message: '이 PC 의 브라우저 계정을 삭제할까요?',
      detail: '저장한 비밀번호, 친구 목록, 내 신원 키가 모두 지워지고 되돌릴 수 없어요. 백업 파일이 있으면 나중에 불러올 수 있어요.\n\n안전을 위해 웹사이트 로그인 상태(쿠키 · 사이트 저장소)도 함께 지워져요. 계정 비밀번호를 모르는 사람이 계정을 지우고 내 사이트 로그인을 쓰지 못하게 하기 위해서예요.',
      buttons: ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
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
  handle('vault:login-delete', ({ id }) => {
    requireUnlocked();
    session.doc.logins = session.doc.logins.filter((l) => l.id !== id);
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
  handle('friends:list', () => (session ? session.doc.friends.map(({ fp, name, addedAt }) => ({ fp, name, addedAt })) : []));
  handle('friends:add', ({ code, name }) => {
    requireUnlocked();
    const p = ID.parseFriendCode(code);
    if (!p) throw new Error('친구 코드 형식이 아니에요 (jamfriend:… )');
    if (p.pub === session.doc.identity.pub) throw new Error('내 친구 코드예요');
    const nm = clean(name, 24) || p.name || '친구';
    const existing = session.doc.friends.find((f) => f.fp === p.fp);
    if (existing) existing.name = nm;
    else session.doc.friends.push({ fp: p.fp, pub: p.pub, name: nm, addedAt: Date.now() });
    persist();
    return { fp: p.fp, name: nm };
  });
  handle('friends:remove', ({ fp }) => {
    requireUnlocked();
    session.doc.friends = session.doc.friends.filter((f) => f.fp !== fp);
    persist();
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
    e.sender.send('pw:available', { origin, unlocked: true, locked: false, accounts });
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
  };
}

module.exports = { setupVault };
