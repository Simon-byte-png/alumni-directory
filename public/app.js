'use strict';

const api = (pathname) => {
  const url = new URL(pathname.replace(/^\//, ''), document.baseURI);
  url.searchParams.set('_ts', Date.now());
  return url.toString();
};

const TOKEN_KEY = 'alumni_token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } };
const setToken = token => { try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {} };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} };
const $ = id => document.getElementById(id);
const drafts = window.createAsesDrafts({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: key => localStorage.removeItem(key),
});
const formValues = form => Object.fromEntries(new FormData(form).entries());
function applyDraft(form, data) {
  for (const [field, value] of Object.entries(data)) {
    const input = form.elements.namedItem(field);
    if (input && input.type !== 'password') input.value = value;
  }
}

function offerProfileDraft(profile) {
  const owner = `profile:${currentUser.id}`;
  const draft = drafts.load(owner);
  const notice = $('profileDraftNotice');
  notice.classList.add('hidden');
  if (!draft) return;
  const different = Object.entries(draft.data).some(([field, value]) => value !== String(profile[field] || ''));
  if (!different) { drafts.clear(owner); return; }
  notice.replaceChildren(document.createTextNode('此浏览器有上次未保存的内容，尚未同步到通讯录。 '));
  for (const [label, action] of [
    ['恢复草稿', () => { applyDraft(els.profileForm, draft.data); notice.textContent = '已恢复草稿，请点击“保存资料”同步到通讯录。'; }],
    ['放弃草稿', () => { drafts.clear(owner); notice.classList.add('hidden'); }],
  ]) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn-secondary'; button.textContent = label; button.onclick = action;
    notice.append(button);
  }
  notice.classList.remove('hidden');
}

function trackPageView() {
  if (!window.crypto?.getRandomValues) return;
  let visitorId = '';
  try { visitorId = localStorage.getItem('alumni_visitor_id') || ''; } catch (_) {}
  if (!/^[a-f0-9]{32}$/i.test(visitorId)) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    visitorId = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('alumni_visitor_id', visitorId); } catch (_) {}
  }
  fetch(api('/api/visit'), {
    method: 'POST', cache: 'no-store', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId }),
  }).catch(() => {});
}

const els = {
  gate: $('gate'), loginTab: $('loginTab'), registerTab: $('registerTab'),
  loginPanel: $('loginPanel'), registerPanel: $('registerPanel'),
  loginForm: $('loginForm'), loginUsername: $('loginUsername'), loginPassword: $('loginPassword'),
  loginBtn: $('loginBtn'), takeOverBtn: $('takeOverBtn'), loginErr: $('loginErr'), loginNotice: $('loginNotice'),
  registerForm: $('registerForm'), registerProfile: $('registerProfile'),
  registerName: $('registerName'), registerCohort: $('registerCohort'), quizStartBtn: $('quizStartBtn'),
  quizForm: $('quizForm'), quizQuestions: $('quizQuestions'), quizAttempts: $('quizAttempts'),
  quizFeedback: $('quizFeedback'),
  quizSubmitBtn: $('quizSubmitBtn'), registerResult: $('registerResult'), registerErr: $('registerErr'),
  registerHelp: $('registerHelp'), currentUser: $('currentUser'), adminLink: $('adminLink'),
  changePasswordBtn: $('changePasswordBtn'), passwordReminder: $('passwordReminder'), reminderChangeBtn: $('reminderChangeBtn'),
  q: $('q'), btn: $('searchBtn'), cards: $('cards'), loading: $('loading'), state: $('state'), stateText: $('stateText'),
  sample: $('sampleBadge'), fCohort: $('fCohort'), fCity: $('fCity'),
  modal: $('modal'), modalBody: $('modalBody'), modalClose: $('modalClose'), logoutLink: $('logoutLink'),
  searchView: $('searchView'), profileView: $('profileView'), searchNavBtn: $('searchNavBtn'), profileNavBtn: $('profileNavBtn'),
  profileForm: $('profileForm'), profileSaveBtn: $('profileSaveBtn'), profileMessage: $('profileMessage'),
  profileIdentityName: $('profileIdentityName'), profileIdentityUsername: $('profileIdentityUsername'),
  profileTimeline: $('profileTimeline'),
};

let currentUser = null;
let currentQuiz = null;
let config = { registrationAvailable: false, helpText: '' };
let registrationRedirectTimer = null;
let lastQueryTokens = [];
let profileLoaded = false;
let searchRequestId = 0;
let profileLoadPromise = null;
let heartbeatTimer = null;
let pendingTakeOverSessionId = '';

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeat() {
  const token = getToken();
  if (!token || document.hidden) return;
  try { await request('/api/auth/heartbeat', { method: 'POST' }); }
  catch (error) {
    if (error.status !== 401 || getToken() !== token) return;
    stopHeartbeat();
    clearToken();
    currentUser = null;
    profileLoaded = false;
    updateAccountUI();
    showGate('login');
    setError(els.loginNotice, '登录已失效，请重新登录');
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(heartbeat, 60 * 1000);
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function request(pathname, options = {}) {
  const response = await fetch(api(pathname), {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(getToken() ? { 'x-alumni-token': getToken() } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请重试');
    error.status = response.status;
    error.code = data.code;
    error.canTakeOver = data.canTakeOver;
    error.retryAfterSeconds = data.retryAfterSeconds;
    error.takeOverSessionId = data.takeOverSessionId;
    throw error;
  }
  return data;
}

function setError(element, message) {
  element.textContent = message || '';
  element.classList.toggle('hidden', !message);
}

function switchGateTab(tab) {
  if (registrationRedirectTimer) {
    clearInterval(registrationRedirectTimer);
    registrationRedirectTimer = null;
  }
  const login = tab === 'login';
  els.loginTab.classList.toggle('active', login);
  els.registerTab.classList.toggle('active', !login);
  els.loginTab.setAttribute('aria-selected', String(login));
  els.registerTab.setAttribute('aria-selected', String(!login));
  els.loginPanel.classList.toggle('hidden', !login);
  els.registerPanel.classList.toggle('hidden', login);
  setError(els.loginErr, '');
  setError(els.registerErr, '');
  if (!login) setError(els.loginNotice, '');
  if (login) setTimeout(() => {
    if (document.activeElement === document.body) els.loginUsername.focus();
  }, 50);
}

function showGate(tab = 'login') {
  els.gate.classList.remove('hidden');
  switchGateTab(tab);
}

function hideGate() { els.gate.classList.add('hidden'); }

function updateAccountUI() {
  els.currentUser.textContent = currentUser ? `${currentUser.displayName} · ${currentUser.username}` : '';
  els.adminLink.classList.toggle('hidden', !currentUser || currentUser.role !== 'admin');
  els.passwordReminder.classList.toggle('hidden', !currentUser || currentUser.passwordChanged);
}

async function loadConfig() {
  try {
    config = await request('/api/config');
    els.registerHelp.textContent = config.helpText || '不确定答案时，请询问管理员。';
    els.quizStartBtn.disabled = !config.registrationAvailable;
    if (!config.registrationAvailable) {
      setError(els.registerErr, '题库维护中，请联系管理员。');
    }
  } catch (_) { /* 登录仍可继续 */ }
}

async function performLogin(takeOver = false) {
  setError(els.loginErr, '');
  els.takeOverBtn.classList.add('hidden');
  const takeOverSessionId = takeOver ? pendingTakeOverSessionId : '';
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) return setError(els.loginErr, '请填写账号和密码');
  els.loginBtn.disabled = true;
  els.takeOverBtn.disabled = true;
  els.loginBtn.textContent = takeOver ? '切换设备中…' : '登录中…';
  try {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, takeOverSessionId }),
    });
    setToken(data.token);
    currentUser = data.user;
    startHeartbeat();
    profileLoaded = false;
    els.loginPassword.value = '';
    pendingTakeOverSessionId = '';
    hideGate();
    updateAccountUI();
    await switchView('search');
    await loadMeta();
    if (data.profileReminder) $('profileReminder').showModal();
  } catch (error) {
    if (error.code === 'account_in_use') {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds || 0) / 60));
      const wait = `如果原设备已经关闭，约 ${minutes} 分钟后可重试。`;
      const action = error.canTakeOver
        ? '确认是本人操作时，也可以点击下方按钮，让旧设备退出后在这里登录。'
        : '初始密码账号请在原设备退出，或联系管理员处理。';
      setError(els.loginErr, `${error.message} ${wait}${action}`);
      els.takeOverBtn.classList.toggle('hidden', !error.canTakeOver);
      pendingTakeOverSessionId = error.canTakeOver ? error.takeOverSessionId : '';
    } else setError(els.loginErr, error.message);
  } finally {
    els.loginBtn.disabled = false;
    els.takeOverBtn.disabled = false;
    els.loginBtn.textContent = '登录';
  }
}

function submitLogin(event) {
  event.preventDefault();
  return performLogin();
}

function renderQuiz(data) {
  currentQuiz = data;
  els.registerProfile.classList.add('hidden');
  els.registerResult.classList.add('hidden');
  els.quizForm.classList.remove('hidden');
  setError(els.quizFeedback, '');
  els.quizAttempts.textContent = `已使用 ${data.attemptsUsed} / ${config.maxRegistrationFailures || 5} 次机会`;
  els.quizQuestions.innerHTML = data.questions.map((question, questionIndex) => `
    <fieldset class="quiz-question">
      <legend>${questionIndex + 1}. ${esc(question.prompt)}</legend>
      ${question.options.map((option, optionIndex) => `
        <label class="quiz-option">
          <input type="radio" name="question-${esc(question.id)}" value="${optionIndex}">
          <span>${esc(option)}</span>
        </label>`).join('')}
    </fieldset>`).join('');
}

async function startRegistration(event, preserveMessage = false) {
  if (event) event.preventDefault();
  if (!preserveMessage) setError(els.registerErr, '');
  const profile = Object.fromEntries(new FormData(els.registerForm).entries());
  if (!String(profile.name || '').trim()) return setError(els.registerErr, '请填写真实姓名');
  if (!/^\p{Script=Han}+(?:·\p{Script=Han}+)*$/u.test(String(profile.name).trim())) {
    return setError(els.registerErr, '请只填写中文姓名，不要附英文名、数字或空格');
  }
  els.quizStartBtn.disabled = true;
  els.quizStartBtn.textContent = '正在抽题…';
  try {
    const data = await request('/api/register/start', {
      method: 'POST',
      body: JSON.stringify({ profile }),
    });
    renderQuiz(data);
    return true;
  } catch (error) {
    setError(els.registerErr, error.message);
    if (preserveMessage) {
      currentQuiz = null;
      els.quizForm.classList.add('hidden');
      els.registerProfile.classList.remove('hidden');
    }
    return false;
  } finally {
    els.quizStartBtn.disabled = !config.registrationAvailable;
    els.quizStartBtn.textContent = '资料填好了，开始答题';
  }
}

async function submitQuiz(event) {
  event.preventDefault();
  if (!currentQuiz) return;
  const answers = {};
  for (const question of currentQuiz.questions) {
    const selected = document.querySelector(`input[name="question-${CSS.escape(question.id)}"]:checked`);
    if (!selected) return setError(els.registerErr, '请回答全部 3 道题');
    answers[question.id] = Number(selected.value);
  }
  setError(els.registerErr, '');
  els.quizSubmitBtn.disabled = true;
  els.quizSubmitBtn.textContent = '正在判定…';
  try {
    const data = await request('/api/register/submit', {
      method: 'POST',
      body: JSON.stringify({ attemptId: currentQuiz.attemptId, answers }),
    });
    if (data.passed) {
      drafts.clear('registration');
      $('registerDraftNotice').classList.add('hidden');
      els.quizForm.classList.add('hidden');
      els.registerResult.classList.remove('hidden');
      els.registerResult.innerHTML = `
        <h3>答题成功，账号已开通</h3>
        <p>账号：<strong>${esc(data.username)}</strong></p>
        <p>初始密码：<strong>${esc(data.initialPassword)}</strong></p>
        <p class="gate-foot">请记住账号和初始密码，登录后立即修改密码。</p>
        <p id="registrationRedirect" class="gate-foot">8 秒后自动前往登录</p>
        <button type="button" class="btn-primary" id="goLoginBtn">立即去登录</button>`;
      const goLogin = () => {
        els.loginUsername.value = data.username;
        els.loginPassword.value = '';
        switchGateTab('login');
        setError(els.loginNotice, '答题成功，账号已开通。账号已填入，初始密码为刚才显示的中文姓名全拼；登录后请修改密码。');
      };
      $('goLoginBtn').onclick = goLogin;
      let seconds = 8;
      registrationRedirectTimer = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) goLogin();
        else $('registrationRedirect').textContent = `${seconds} 秒后自动前往登录`;
      }, 1000);
      currentQuiz = null;
      return;
    }
    if (data.locked) {
      els.quizForm.classList.add('hidden');
      els.registerResult.classList.remove('hidden');
      els.registerResult.innerHTML = `
        <h3>答题次数已用完</h3>
        <p>${esc(data.message)}</p>
        <button type="button" class="btn-primary" id="backToRegisterBtn">返回资料页</button>`;
      $('backToRegisterBtn').onclick = () => {
        els.registerResult.classList.add('hidden');
        els.registerProfile.classList.remove('hidden');
      };
      currentQuiz = null;
      return;
    }
    if (await startRegistration(null, true)) {
      setError(els.quizFeedback, `${data.message} 已重新抽取 3 道题。`);
    }
  } catch (error) {
    setError(els.registerErr, error.message);
    if (/已过期|网络发生变化|已经结束|账号冲突|已经有账号/.test(error.message)) {
      currentQuiz = null;
      els.quizForm.classList.add('hidden');
      els.registerResult.classList.add('hidden');
      els.registerProfile.classList.remove('hidden');
    }
  } finally {
    els.quizSubmitBtn.disabled = false;
    els.quizSubmitBtn.textContent = '提交答案';
  }
}

function openModal(html) {
  els.modalBody.innerHTML = html;
  els.modal.classList.remove('hidden');
}

function closeModal() {
  els.modal.classList.add('hidden');
}

function openPasswordModal() {
  openModal(`
    <div class="modal-body">
      <h3>修改密码</h3>
      <form id="passwordForm" class="stack-form">
        <label class="form-field">当前密码<input id="oldPassword" type="password" maxlength="128" autocomplete="current-password" required></label>
        <label class="form-field">新密码<input id="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="至少 8 个字符，不能与账号相同" required></label>
        <label class="form-field">确认新密码<input id="confirmPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label>
        <button class="btn-primary" type="submit">保存新密码</button>
        <p class="gate-foot">忘记当前密码？请联系管理员处理。</p>
        <p id="passwordErr" class="gate-err hidden"></p>
      </form>
    </div>`);
  $('passwordForm').onsubmit = submitPasswordChange;
  $('oldPassword').focus();
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const button = $('passwordForm').querySelector('button[type="submit"]');
  if (button.disabled) return;
  const oldPassword = $('oldPassword').value;
  const newPassword = $('newPassword').value;
  const confirmPassword = $('confirmPassword').value;
  if (newPassword !== confirmPassword) return setError($('passwordErr'), '两次输入的新密码不一致');
  if (!newPassword.trim()) return setError($('passwordErr'), '新密码不能全部为空格');
  if (newPassword.length < 8) return setError($('passwordErr'), '新密码至少需要 8 个字符');
  if (newPassword.length > 128) return setError($('passwordErr'), '新密码不能超过 128 个字符');
  const normalizedPassword = newPassword.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalizedPassword === currentUser.username) return setError($('passwordErr'), '新密码不能与账号相同');
  setError($('passwordErr'), '');
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    const data = await request('/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    });
    setToken(data.token);
    currentUser = data.user;
    updateAccountUI();
    closeModal();
  } catch (error) { setError($('passwordErr'), error.message); }
  finally {
    button.disabled = false;
    button.textContent = '保存新密码';
  }
}

function monthLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]}年${Number(match[2])}月` : '历史资料';
}

function experienceHTML(item, compact = false) {
  const details = [
    item.status && `<span>${esc(item.status)}</span>`,
    item.org && `<span>${esc(item.org)}</span>`,
    item.industry && `<span>${esc(item.industry)}</span>`,
    item.city && `<span>${esc(item.city)}</span>`,
  ].filter(Boolean).join('');
  return `<article class="timeline-item${compact ? ' compact' : ''}">
    <div class="timeline-dot" aria-hidden="true"></div>
    <div class="timeline-content">
      <div class="timeline-meta">
        <time>${monthLabel(item.recordedMonth)}</time>
        <span class="timeline-state ${item.isCurrent !== false ? 'current' : ''}">${item.isCurrent !== false ? '现在' : '过去'}</span>
        ${!compact && item.isCurrent === false ? `<button class="timeline-delete" type="button" data-experience-id="${esc(item.id)}" aria-label="删除 ${monthLabel(item.recordedMonth)}的过去经历">删除</button>` : ''}
      </div>
      ${details ? `<div class="timeline-tags">${details}</div>` : ''}
      ${item.doing ? `<p>${esc(item.doing)}</p>` : ''}
    </div>
  </article>`;
}

function renderProfileTimeline(profile) {
  const timeline = Array.isArray(profile.experiences) ? [...profile.experiences].reverse() : [];
  els.profileTimeline.innerHTML = timeline.length
    ? timeline.map(item => experienceHTML(item)).join('')
    : '<div class="timeline-empty">保存当前状态后，这里会开始记录你的经历。</div>';
}

function renderProfile(profile) {
  els.profileIdentityName.textContent = profile.name || currentUser.displayName;
  els.profileIdentityUsername.textContent = `账号：${profile.username || currentUser.username}`;
  const fields = ['edu', 'cohort', 'status', 'industry', 'org', 'doing', 'city', 'willingContact', 'contact', 'offer', 'want', 'hiring', 'message'];
  for (const field of fields) {
    const input = els.profileForm.elements.namedItem(field);
    if (input) input.value = profile[field] || '';
  }
  renderProfileTimeline(profile);
}

async function deletePastExperience(event) {
  const button = event.target.closest('[data-experience-id]');
  if (!button || !profileLoaded || button.disabled) return;
  if (!window.confirm('确定删除这段过去经历吗？删除后通讯录也会同步更新。')) return;
  const experienceId = button.dataset.experienceId;
  button.disabled = true;
  button.textContent = '删除中…';
  els.profileMessage.classList.add('hidden');
  try {
    const data = await request(`/api/profile/experiences/${encodeURIComponent(experienceId)}`, { method: 'DELETE' });
    renderProfileTimeline(data.profile);
    els.profileMessage.textContent = '过去经历已删除，通讯录也已同步更新。';
    els.profileMessage.classList.remove('error', 'hidden');
    if (els.q.value.trim() || els.fCohort.value || els.fCity.value) await doSearch();
  } catch (error) {
    els.profileMessage.textContent = error.message;
    els.profileMessage.classList.add('error');
    els.profileMessage.classList.remove('hidden');
    button.disabled = false;
    button.textContent = '删除';
  }
}

async function loadProfile(force = false) {
  if (profileLoaded && !force) return;
  if (profileLoadPromise && !force) return profileLoadPromise;
  const loadingForUserId = currentUser && currentUser.id;
  profileLoadPromise = (async () => {
    profileLoaded = false;
    els.profileSaveBtn.disabled = true;
    els.profileSaveBtn.textContent = '资料加载中…';
    els.profileTimeline.innerHTML = '<div class="timeline-empty">资料加载中…</div>';
    try {
      const data = await request('/api/profile');
      if (!currentUser || currentUser.id !== loadingForUserId) return;
      renderProfile(data.profile);
      profileLoaded = true;
      offerProfileDraft(data.profile);
    } catch (error) {
      if (currentUser && currentUser.id === loadingForUserId) {
        els.profileTimeline.innerHTML = `<div class="timeline-empty">${esc(error.message)}，请重新进入“我的资料”重试。</div>`;
      }
    } finally {
      if (currentUser && currentUser.id === loadingForUserId) {
        els.profileSaveBtn.disabled = !profileLoaded;
        els.profileSaveBtn.textContent = '保存资料';
      }
    }
  })();
  try { await profileLoadPromise; }
  finally { profileLoadPromise = null; }
}

async function switchView(view) {
  const profile = view === 'profile';
  els.searchView.classList.toggle('hidden', profile);
  els.profileView.classList.toggle('hidden', !profile);
  els.searchNavBtn.classList.toggle('active', !profile);
  els.profileNavBtn.classList.toggle('active', profile);
  els.searchNavBtn.toggleAttribute('aria-current', !profile);
  els.profileNavBtn.toggleAttribute('aria-current', profile);
  if (profile) await loadProfile();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function saveProfile(event) {
  event.preventDefault();
  if (!profileLoaded) {
    els.profileMessage.textContent = '资料还没有加载完成，请稍后再试。';
    els.profileMessage.classList.add('error');
    els.profileMessage.classList.remove('hidden');
    return;
  }
  els.profileMessage.classList.add('hidden');
  els.profileSaveBtn.disabled = true;
  els.profileSaveBtn.textContent = '保存中…';
  const profile = formValues(els.profileForm);
  const owner = `profile:${currentUser.id}`;
  drafts.save(owner, profile);
  const inputs = [...els.profileForm.querySelectorAll('input, textarea, select')];
  inputs.forEach(input => { input.disabled = true; });
  try {
    const data = await request('/api/profile', { method: 'PATCH', body: JSON.stringify(profile) });
    renderProfile(data.profile);
    drafts.clear(owner);
    $('profileDraftNotice').classList.add('hidden');
    profileLoaded = true;
    els.profileMessage.textContent = '已保存，通讯录中的资料也同步更新了。';
    els.profileMessage.classList.remove('error', 'hidden');
    await loadMeta();
    if (els.q.value.trim() || els.fCohort.value || els.fCity.value) await doSearch();
  } catch (error) {
    els.profileMessage.textContent = error.message;
    els.profileMessage.classList.add('error');
    els.profileMessage.classList.remove('hidden');
  } finally {
    inputs.forEach(input => { input.disabled = false; });
    els.profileSaveBtn.disabled = false;
    els.profileSaveBtn.textContent = '保存资料';
  }
}

function showState(text) {
  els.cards.innerHTML = '';
  els.stateText.textContent = text;
  els.state.classList.remove('hidden');
}

function hideState() { els.state.classList.add('hidden'); }

function highlight(text, tokens) {
  let output = esc(text);
  const unique = [...new Set(tokens)].filter(token => token.length >= 2 || /[a-z0-9]/i.test(token))
    .sort((a, b) => b.length - a.length).slice(0, 12);
  for (const token of unique) {
    const pattern = new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    output = output.replace(pattern, '<mark>$1</mark>');
  }
  return output;
}

function queryTokens(query) {
  const tokens = [];
  const expression = /[a-z0-9]+|[一-龥]{2,}/gi;
  let match;
  while ((match = expression.exec(query.toLowerCase())) !== null) tokens.push(match[0]);
  return tokens;
}

function fillSelect(select, values, selectedValue = select.value) {
  select.innerHTML = '<option value="">全部</option>';
  for (const value of values || []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  if ([...select.options].some(option => option.value === selectedValue)) select.value = selectedValue;
}

async function loadMeta() {
  try {
    const meta = await request('/api/meta');
    if (meta.isSample) els.sample.textContent = '⚠ 当前为示例数据，等待导入真实校友表';
    fillSelect(els.fCohort, meta.facets.cohortYear, els.fCohort.value);
    fillSelect(els.fCity, meta.facets.cityNorm, els.fCity.value);
  } catch (error) {
    if (error.status === 401) {
      clearToken();
      currentUser = null;
      showGate('login');
    }
  }
}

function field(label, value, tokens) {
  return value ? `<div class="field"><span class="lab">${label}</span>${highlight(value, tokens)}</div>` : '';
}

function cardHTML(record, tokens) {
  const tags = [];
  const cohort = record.cohortYear && /^\d+$/.test(record.cohortYear) ? `${record.cohortYear} 级` : record.cohort;
  if (cohort) tags.push(`<span class="tag cohort">${esc(cohort)}</span>`);
  if (record.city) tags.push(`<span class="tag">${esc(record.city)}</span>`);
  if (record.edu) tags.push(`<span class="tag">${esc(record.edu)}</span>`);
  const timeline = Array.isArray(record.experiences) && record.experiences.length
    ? `<div class="card-timeline">${[...record.experiences].reverse().map(item => experienceHTML(item, true)).join('')}</div>`
    : '';
  return `<div class="card">
    <div class="card-top"><div class="card-name">${esc(record.name)}</div></div>
    <div class="meta-line">${tags.join('')}</div>
    ${timeline}${field('合作需求', record.hiring, tokens)}
    ${field('希望获得', record.want, tokens)}${field('寄语', record.message, tokens)}
  </div>`;
}

async function doSearch() {
  const requestId = ++searchRequestId;
  const query = els.q.value.trim();
  const hasFilter = !!(els.fCohort.value || els.fCity.value);
  if (!query && !hasFilter) return showState('输入关键词、方向或姓名，开始检索校友');
  const queryTokenList = queryTokens(query);
  lastQueryTokens = queryTokenList;
  hideState();
  els.loading.classList.remove('hidden');
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (els.fCohort.value) params.set('cohortYear', els.fCohort.value);
  if (els.fCity.value) params.set('cityNorm', els.fCity.value);
  try {
    const data = await request(`/api/search?${params}`);
    if (requestId !== searchRequestId) return;
    if (!data.items.length) return showState('没有找到匹配的校友，换个词试试～');
    els.cards.innerHTML = data.items.map(item => cardHTML(item, queryTokenList)).join('');
  } catch (error) {
    if (requestId !== searchRequestId) return;
    if (error.status === 401) {
      clearToken();
      currentUser = null;
      showGate('login');
    } else showState('检索出错，请重试');
  } finally {
    if (requestId === searchRequestId) els.loading.classList.add('hidden');
  }
}

async function logout(event) {
  if (event) event.preventDefault();
  try { await request('/api/auth/logout', { method: 'POST' }); }
  catch (error) {
    if (error.status !== 401) return window.alert(`退出失败：${error.message}，请重试`);
  }
  stopHeartbeat();
  if (currentUser) drafts.clear(`profile:${currentUser.id}`);
  clearToken();
  currentUser = null;
  profileLoaded = false;
  updateAccountUI();
  els.cards.innerHTML = '';
  switchView('search');
  showGate('login');
}

async function boot() {
  const token = getToken();
  if (!token) {
    showGate('login');
    await loadConfig();
    return;
  }
  await loadConfig();
  try {
    const data = await request('/api/auth/session');
    if (!data.ok) {
      const error = new Error('登录已失效，请重新登录');
      error.code = 'session_expired';
      throw error;
    }
    currentUser = data.user;
    startHeartbeat();
    profileLoaded = false;
    updateAccountUI();
    hideGate();
    await switchView('search');
    await loadMeta();
  } catch (error) {
    if (error.code === 'session_expired' || error.status === 401) clearToken();
    showGate('login');
    setError(els.loginErr, error.code === 'session_expired' || error.status === 401
      ? '登录已失效，请重新登录'
      : '暂时无法确认登录状态，请刷新页面重试。');
  }
}

els.loginTab.onclick = () => switchGateTab('login');
els.registerTab.onclick = () => switchGateTab('register');
els.loginForm.addEventListener('submit', submitLogin);
els.takeOverBtn.onclick = () => performLogin(true);
els.loginForm.addEventListener('input', () => {
  pendingTakeOverSessionId = '';
  els.takeOverBtn.classList.add('hidden');
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentUser) heartbeat(); });
els.registerForm.addEventListener('submit', startRegistration);
els.quizForm.addEventListener('submit', submitQuiz);
els.changePasswordBtn.onclick = openPasswordModal;
els.reminderChangeBtn.onclick = openPasswordModal;
els.modalClose.onclick = closeModal;
els.modal.addEventListener('click', event => { if (event.target === els.modal) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
els.logoutLink.addEventListener('click', logout);
els.searchNavBtn.onclick = () => switchView('search');
els.profileNavBtn.onclick = () => switchView('profile');
els.profileForm.addEventListener('submit', saveProfile);
els.profileForm.addEventListener('input', () => {
  if (!profileLoaded || !currentUser || els.profileSaveBtn.disabled) return;
  const kept = drafts.save(`profile:${currentUser.id}`, formValues(els.profileForm));
  const notice = $('profileDraftNotice');
  notice.textContent = kept ? '未保存的修改已暂存在此浏览器，点击“保存资料”后才会同步到通讯录。' : '此浏览器无法暂存草稿，请及时点击“保存资料”。';
  notice.classList.remove('hidden');
});
els.registerForm.addEventListener('input', () => {
  const kept = drafts.save('registration', formValues(els.registerForm));
  const notice = $('registerDraftNotice');
  notice.textContent = kept ? '填写内容已暂存在此浏览器；答对 3 道题后才会完成开户。' : '此浏览器无法暂存草稿，请保持页面打开，继续完成开户。';
  notice.classList.remove('hidden');
});
const registrationDraft = drafts.load('registration');
if (registrationDraft) {
  applyDraft(els.registerForm, registrationDraft.data);
  $('registerDraftNotice').textContent = '已恢复此浏览器上次填写的资料，请核对后继续答题开户。';
  $('registerDraftNotice').classList.remove('hidden');
}
els.profileTimeline.addEventListener('click', deletePastExperience);
$('profileReminderLater').onclick = () => $('profileReminder').close();
$('profileReminderEdit').onclick = async () => {
  $('profileReminder').close();
  await switchView('profile');
  els.profileForm.querySelector('input, select, textarea')?.focus();
};
els.btn.onclick = doSearch;
els.q.addEventListener('keydown', event => { if (event.key === 'Enter') doSearch(); });
let searchTimer;
els.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 220); });
[els.fCohort, els.fCity].forEach(element => element.addEventListener('change', doSearch));

boot();
trackPageView();
