'use strict';
/* global jam, jamApp, account, prefs, relayList, joinJam, toast, el, $ */
// 다른 기기에서 이어 보기 (같은 브라우저 계정)
//  - 중계 서버로 Jam 을 열면: 초대 링크를 계정 키로 암호화해서 중계 서버에 맡김 (메인 프로세스가 함, Jam 이 끝나면 지움)
//  - 다른 기기에서 같은 계정 잠금을 풀면: 중계 서버마다 찾아보고 "💻 내 다른 기기의 Jam" 에 보여 줌 → 이어 보기 = 그 링크로 참여
//    (호스트는 같은 계정 서명을 보고 승인 없이 들여보냄)

const jamResume = (() => {
  let last = [];
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return !t ? '' : m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`;
  };

  async function publish(link, title) {
    if (!prefs.get('resumePublish') || !account.isUnlocked() || !/^jamrs?:\/\//.test(String(link))) return;
    const r = await jamApp.resumePublish({ link, title }).catch(() => null);
    if (r && !r.ok && r.reason !== 'off' && r.reason !== 'locked') console.warn('resume publish:', r.reason);
  }

  function render() {
    const list = last.filter((x) => !(jam.active && x.link === jam.invite));
    $('#resume-box').hidden = !account.isUnlocked() || jam.active;
    $('#resume-list').replaceChildren(
      ...list.map((x) =>
        el(
          'li',
          { class: 'nearby-item' },
          el('div', { class: 'info' }, el('div', { class: 'name' }, `💻 ${x.title || 'Jam'}`), el('div', { class: 'muted small' }, `${x.device ? x.device + ' · ' : ''}${ago(x.at)} 시작 · 승인 없이 들어가요`)),
          el('button', { class: 'mini-btn active', onclick: () => resume(x) }, '이어 보기')
        )
      )
    );
  }

  function resume(x) {
    $('#invite').value = x.link;
    joinJam();
  }

  async function find({ quiet = false } = {}) {
    if (!account.isUnlocked()) return [];
    const { urls } = relayList();
    if (!urls.length) {
      $('#resume-empty').textContent = '중계 서버 주소가 있어야 찾을 수 있어요 (아래 "중계 서버")';
      last = [];
      render();
      return last;
    }
    $('#resume-empty').textContent = '찾는 중…';
    const r = await jamApp.resumeFind({ relayUrls: urls }).catch(() => ({ found: [] }));
    last = (r.found || []).sort((a, b) => b.at - a.at);
    render();
    const shown = last.filter((x) => !(jam.active && x.link === jam.invite));
    $('#resume-empty').textContent = shown.length
      ? ''
      : r.unsupported && r.unsupported.length === urls.length
        ? '중계 서버가 아직 이 기능을 몰라요 (중계 서버 1.0.5 부터)'
        : '지금 열려 있는 내 다른 기기의 Jam 이 없어요';
    if (!quiet && shown.length && !jam.active) {
      const x = shown[0];
      toast(`💻 내 다른 기기${x.device ? `(${x.device})` : ''}에서 Jam 이 열려 있어요: ${x.title || 'Jam'}`, [{ label: '이어 보기', fn: () => resume(x) }]);
    }
    return last;
  }

  $('#resume-find').addEventListener('click', () => find({ quiet: true }));
  document.addEventListener('jam-account-unlocked', () => {
    // 이미 호스트로 Jam 중이면: 같은 계정 기기 입장 허용 + 다른 기기에서 찾을 수 있게
    if (jam.active && jam.isHost()) {
      jam.send({ type: 'settings', self: account.selfFp() });
      if (/^jamrs?:\/\//.test(String(jam.invite))) publish(jam.invite, jam.tab?.title);
    }
    render();
    if (prefs.get('resumeAutoFind') && !jam.active) find();
  });
  // Jam 을 나가거나 들어가면 상자 보이기 · 숨기기
  setInterval(() => {
    const want = !account.isUnlocked() || jam.active;
    if ($('#resume-box').hidden !== want) render();
  }, 1000);

  return { publish, find, list: () => last.slice() };
})();
window.jamResume = jamResume;
