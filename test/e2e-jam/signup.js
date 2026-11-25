// E2E 공통: 첫 화면에서 서버 계정 가입 (v0.6.0 부터 계정은 서버 계정만 — run.ps1 이 가입 열린 중계 서버를 띄움)
//   X: target() 이 돌려준 { ev }, relayPort: 중계 서버 포트
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `document.querySelector(${JSON.stringify(s)})`;
const set = (sel, v) => `${q(sel)}.value = ${JSON.stringify(v)};`;

async function waitFor(X, label, expr, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await X.ev(expr);
    } catch (e) {
      last = e.message;
    }
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timeout: ${label} (${JSON.stringify(last)})`);
}

async function signup(X, { relayPort, id, name, pw, remember = true }) {
  if (!relayPort) throw new Error('signup: 중계 서버가 필요해요 (-Relay)');
  await waitFor(X, 'welcome', `typeof account==='object' && !${q('#ls-welcome')}.hidden`);
  await X.ev(`${q('#ls-go-signup')}.click(); 1`);
  await waitFor(X, 'signup form', `!${q('#ls-signup')}.hidden`);
  await X.ev(
    `${set('#ls-su-srv', `127.0.0.1:${relayPort}`)} ${set('#ls-su-id', id)} ${set('#ls-su-name', name)} ${set('#ls-su-pw', pw)} ${set('#ls-su-pw2', pw)} ${q('#ls-su-remember')}.checked = ${!!remember}; ${q('#ls-signup')}.requestSubmit(); 1`
  );
  await waitFor(X, `${id} signed up`, `${q('#lock-screen')}.hidden && account.isUnlocked()`, 40000);
}

// 잠금 화면에서 비밀번호로 다시 열기 (서버를 거침)
async function unlock(X, pw) {
  await waitFor(X, 'unlock screen', `!${q('#ls-unlock')}.hidden`);
  await X.ev(`${set('#ls-unlock-pw', pw)} ${q('#ls-unlock')}.requestSubmit(); 1`);
  await waitFor(X, 'unlocked', `${q('#lock-screen')}.hidden && account.isUnlocked()`, 40000);
}

module.exports = { signup, unlock };
