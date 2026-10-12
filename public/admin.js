'use strict';

const api = pathname => {
  const url = new URL(pathname.replace(/^\//, ''), document.baseURI);
  url.searchParams.set('_ts', Date.now());
  return url.toString();
};
const TOKEN_KEY = 'alumni_token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } };
const setToken = token => { try { localStorage.setItem(TOKEN_KEY, token); } catch (_) {} };
const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} };
const $ = id => document.getElementById(id);
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const els = {
  gate: $('adminGate'), app: $('adminApp'), loginForm: $('adminLoginForm'),
  username: $('adminUsername'), password: $('adminPassword'), loginBtn: $('adminLoginBtn'), loginErr: $('adminLoginErr'),
  identity: $('adminIdentity'), logout: $('adminLogout'), message: $('adminMessage'),
  membersPanel: $('membersPanel'), analyticsPanel: $('analyticsPanel'), rosterPanel: $('rosterPanel'), usersPanel: $('usersPanel'), questionsPanel: $('questionsPanel'), locksPanel: $('locksPanel'), registrationsPanel: $('registrationsPanel'),
  analyticsTodayViews: $('analyticsTodayViews'), analyticsTodayVisitors: $('analyticsTodayVisitors'), analyticsWeekViews: $('analyticsWeekViews'), analyticsTotalViews: $('analyticsTotalViews'),
  analyticsStatus: $('analyticsStatus'), analyticsChart: $('analyticsChart'), analyticsDays: $('analyticsDays'), refreshAnalytics: $('refreshAnalytics'),
  memberCount: $('memberCount'), memberList: $('memberList'), memberDetail: $('memberDetail'), memberSource: $('memberSource'), memberQuery: $('memberQuery'), refreshMembers: $('refreshMembers'),
  userCount: $('userCount'), usersList: $('usersList'), createUserForm: $('createUserForm'),
  newDisplayName: $('newDisplayName'), newCohort: $('newCohort'), newUsername: $('newUsername'),
  questionCount: $('questionCount'), questionsList: $('questionsList'), questionForm: $('questionForm'),
  editingQuestionId: $('editingQuestionId'), questionPrompt: $('questionPrompt'), questionOptions: $('questionOptions'),
  questionCorrectIndex: $('questionCorrectIndex'), questionNotes: $('questionNotes'), questionActive: $('questionActive'),
  cancelQuestionEdit: $('cancelQuestionEdit'), locksList: $('locksList'), refreshLocks: $('refreshLocks'),
  registrationsList: $('registrationsList'), registrationStatus: $('registrationStatus'), registrationQuery: $('registrationQuery'),
  refreshRegistrations: $('refreshRegistrations'), exportRegistrations: $('exportRegistrations'),
  rosterList: $('rosterList'), rosterSummary: $('rosterSummary'), rosterStatus: $('rosterStatus'), rosterQuery: $('rosterQuery'),
  refreshRoster: $('refreshRoster'), exportRoster: $('exportRoster'),
};

let users = [];
let questions = [];
let rosterRows = [];
let memberRows = [];
let selectedMemberId = '';
let liveRefreshTimer = null;
let heartbeatTimer = null;

const profileLabels = {
  name: '姓名', edu: '院系/校友身份', cohort: '届别', status: '当前状态',
  industry: '行业/方向', org: '公司/机构', doing: '目前在做的事', city: '所在城市',
  offer: '可以提供的帮助', want: '希望获得的帮助', hiring: '招聘/合作需求',
  message: '想说的话', willingContact: '是否愿意被联系', contact: '联系方式',
};

function setError(message) {
  els.loginErr.textContent = message || '';
  els.loginErr.classList.toggle('hidden', !message);
}

function flash(message) {
  els.message.textContent = message;
  els.message.classList.remove('hidden');
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => els.message.classList.add('hidden'), 3500);
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
    const error = new Error(data.error || '请求失败');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showGate(message = '') {
  if (liveRefreshTimer) { clearInterval(liveRefreshTimer); liveRefreshTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  els.gate.classList.remove('hidden');
  els.app.classList.add('hidden');
  setError(message);
  setTimeout(() => {
    if (document.activeElement === document.body) els.username.focus();
  }, 50);
}

function showApp(user) {
  els.gate.classList.add('hidden');
  els.app.classList.remove('hidden');
  els.identity.textContent = `${user.displayName} · ${user.username}`;
  if (!heartbeatTimer) heartbeatTimer = setInterval(async () => {
    const token = getToken();
    if (!token || document.hidden) return;
    try { await request('/api/auth/heartbeat', { method: 'POST' }); }
    catch (error) {
      if (error.status === 401 && getToken() === token) { clearToken(); showGate('登录已失效，请重新登录'); }
    }
  }, 60 * 1000);
  if (!liveRefreshTimer) {
    liveRefreshTimer = setInterval(async () => {
      if (els.app.classList.contains('hidden')) return;
      try {
        await Promise.all([loadRegistrations(), loadRoster(), loadUsers(), loadMembers()]);
      } catch (error) {
        if (error.status === 401) { clearToken(); showGate('登录已失效，请重新登录'); }
      }
    }, 10000);
  }
}

async function login(event) {
  event.preventDefault();
  setError('');
  els.loginBtn.disabled = true;
  try {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: els.username.value, password: els.password.value }),
    });
    if (data.user.role !== 'admin') throw new Error('这个账号没有管理员权限');
    setToken(data.token);
    els.password.value = '';
    showApp(data.user);
    await Promise.all([loadMembers(), loadRoster(), loadUsers(), loadQuestions(), loadLocks(), loadRegistrations()]);
  } catch (error) { setError(error.message); }
  finally { els.loginBtn.disabled = false; }
}

function switchTab(name) {
  document.querySelectorAll('.admin-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  els.membersPanel.classList.toggle('hidden', name !== 'members');
  els.analyticsPanel.classList.toggle('hidden', name !== 'analytics');
  els.rosterPanel.classList.toggle('hidden', name !== 'roster');
  els.usersPanel.classList.toggle('hidden', name !== 'users');
  els.questionsPanel.classList.toggle('hidden', name !== 'questions');
  els.locksPanel.classList.toggle('hidden', name !== 'locks');
  els.registrationsPanel.classList.toggle('hidden', name !== 'registrations');
  if (name === 'analytics') loadAnalytics();
}

async function loadAnalytics() {
  els.analyticsStatus.textContent = '正在加载访问数据…';
  try {
    const { analytics } = await request('/api/admin/analytics');
    const format = value => Number(value || 0).toLocaleString('zh-CN');
    els.analyticsTodayViews.textContent = format(analytics.today.pageViews);
    els.analyticsTodayVisitors.textContent = format(analytics.today.uniqueVisitors);
    els.analyticsWeekViews.textContent = format(analytics.last7Views);
    els.analyticsTotalViews.textContent = format(analytics.totalViews);
    els.analyticsStatus.textContent = analytics.startedAt
      ? `开始统计：${new Date(analytics.startedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      : '尚无访问记录；上线前的访问无法补算。';
    const max = Math.max(1, ...analytics.days.map(day => day.pageViews));
    els.analyticsChart.innerHTML = analytics.days.map(day => {
      const height = day.pageViews ? Math.max(4, Math.round(day.pageViews / max * 100)) : 0;
      return `<div class="analytics-bar-col" title="${esc(day.date)}：${format(day.pageViews)} 次访问">
        <span>${format(day.pageViews)}</span><div class="analytics-bar-track"><i style="height:${height}%"></i></div><small>${esc(day.date.slice(5))}</small>
      </div>`;
    }).join('');
    els.analyticsDays.innerHTML = `<div class="analytics-day analytics-day-head"><span>日期</span><span>访问次数</span><span>独立访客（估算）</span></div>${[...analytics.days].reverse().map(day => `
      <div class="analytics-day"><span>${esc(day.date)}</span><strong>${format(day.pageViews)}</strong><span>${format(day.uniqueVisitors)}</span></div>`).join('')}`;
  } catch (error) {
    els.analyticsStatus.textContent = `访问统计加载失败：${error.message}`;
  }
}

const memberGroups = [
  ['基本信息', ['name', 'cohort', 'edu', 'city']],
  ['目前情况', ['status', 'industry', 'org', 'doing']],
  ['交流与需求', ['offer', 'want', 'hiring']],
  ['联系与寄语', ['willingContact', 'contact', 'message']],
];

const isNewMember = row => ['quiz-registration', 'admin-approved-registration'].includes(row.source);
const memberDate = value => value ? new Date(value).toLocaleString('zh-CN') : '暂无记录';
const memberValue = value => String(value == null ? '' : value).trim() || '未填写';

function renderMemberDetail(row) {
  if (!row) return void (els.memberDetail.innerHTML = '<div class="admin-empty">选择左侧成员查看完整资料</div>');
  const groups = memberGroups.map(([title, fields]) => `<section class="member-section">
    <h3>${esc(title)}</h3>
    <div class="member-fields">${fields.map(field => `<div class="member-field"><span>${esc(profileLabels[field])}</span><p class="${row[field] ? '' : 'member-missing'}">${esc(memberValue(row[field]))}</p></div>`).join('')}</div>
  </section>`).join('');
  const experiences = Array.isArray(row.experiences) ? row.experiences : [];
  const history = experiences.length ? experiences.map(item => `<div class="member-history-item">
    <strong>${esc(item.recordedMonth || '时间未记录')}${item.isCurrent === false ? ' · 历史' : ' · 当前'}</strong>
    <p>${esc([item.status, item.industry, item.org, item.doing, item.city].filter(Boolean).join(' · ') || '未填写')}</p>
  </div>`).join('') : '<p class="member-missing">暂无经历记录</p>';
  els.memberDetail.innerHTML = `<div class="member-detail-header">
    <div><span class="member-eyebrow">${isNewMember(row) ? '新注册成员' : '原有成员'}</span><h2>${esc(row.displayName || row.name || '姓名未填')}</h2><p>${esc(row.accountUsername || '账号未记录')} · ${esc(row.cohort || '届别未填')}</p></div>
    <span class="status-pill ${row.active ? 'on' : 'off'}">${row.active ? '账号启用中' : '账号已停用'}</span>
  </div>
  <div class="member-timestamps">账号创建：${esc(memberDate(row.createdAt))}　资料更新：${esc(memberDate(row.profileUpdatedAt || row.profileCreatedAt))}</div>
  ${groups}
  <section class="member-section"><h3>经历记录</h3><div class="member-history">${history}</div></section>`;
}

function renderMembers() {
  const source = els.memberSource.value;
  const query = els.memberQuery.value.trim().toLocaleLowerCase('zh-CN');
  const rows = memberRows.filter(row => {
    if (source === 'quiz-registration' && !isNewMember(row)) return false;
    if (source === 'existing' && isNewMember(row)) return false;
    return !query || [row.displayName, row.accountUsername, ...Object.keys(profileLabels).map(field => row[field])]
      .some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
  });
  els.memberCount.textContent = `显示 ${rows.length} / ${memberRows.length} 人`;
  if (!rows.some(row => row.id === selectedMemberId)) selectedMemberId = rows[0]?.id || '';
  els.memberList.innerHTML = rows.length ? rows.map(row => `<button class="member-list-item ${row.id === selectedMemberId ? 'selected' : ''}" data-member-id="${esc(row.id)}" type="button" aria-pressed="${row.id === selectedMemberId}">
    <span class="member-avatar" aria-hidden="true">${esc((row.displayName || row.name || '?').slice(0, 1))}</span>
    <span class="member-list-text"><strong>${esc(row.displayName || row.name || '姓名未填')}</strong><small>${esc(row.cohort || '届别未填')} · ${esc(row.city || '城市未填')}</small><small>${isNewMember(row) ? '新注册' : '原有账号'} · ${esc(row.industry || '方向未填')}</small></span>
  </button>`).join('') : '<div class="admin-empty">没有符合条件的成员</div>';
  renderMemberDetail(rows.find(row => row.id === selectedMemberId));
}

async function loadMembers() {
  const data = await request('/api/admin/roster?status=account');
  memberRows = (data.rows || []).sort((a, b) => String(b.profileUpdatedAt || b.createdAt || '').localeCompare(String(a.profileUpdatedAt || a.createdAt || '')));
  renderMembers();
}

function renderRoster() {
  const accounts = rosterRows.filter(row => row.rosterStatus === 'account');
  const pending = rosterRows.filter(row => row.rosterStatus === 'pending');
  els.rosterSummary.textContent = `当前显示 ${rosterRows.length} 条 · 已开户 ${accounts.length} · 待核对 ${pending.length}`;
  if (!rosterRows.length) return void (els.rosterList.innerHTML = '<div class="admin-empty">暂无名单记录</div>');
  const columns = [
    ['姓名', 'displayName'], ['账号', 'accountUsername'], ['院系/校友身份', 'edu'], ['届别', 'cohort'],
    ['当前状态', 'status'], ['行业/方向', 'industry'], ['公司/机构', 'org'], ['目前在做的事', 'doing'],
    ['所在城市', 'city'], ['愿意被联系', 'willingContact'], ['联系方式', 'contact'], ['可提供帮助', 'offer'],
    ['希望获得帮助', 'want'], ['招聘/合作需求', 'hiring'], ['想说的话', 'message'], ['账号状态', 'accountStatus'],
    ['密码状态', 'passwordStatus'], ['名单状态', 'rosterStatus'], ['操作', 'actions'],
  ];
  const cell = value => `<td>${esc(value || '—')}</td>`;
  els.rosterList.innerHTML = `<table class="roster-data-table"><thead><tr>${columns.map(([label]) => `<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${rosterRows.map(row => {
    const pending = row.rosterStatus === 'pending';
    const actions = pending
      ? `<span class="admin-muted">待人工核对${row.row ? `（名单第 ${esc(row.row)} 行）` : ''}</span>`
      : `<div class="admin-actions"><button class="btn-small" data-user-action="reset" data-id="${esc(row.id)}">重置密码</button><button class="btn-small ${row.active ? 'danger' : ''}" data-user-action="toggle" data-id="${esc(row.id)}">${row.active ? '停用' : '恢复'}</button><button class="btn-small danger" data-user-action="delete" data-id="${esc(row.id)}">删除账号</button></div>`;
    return `<tr class="${pending ? 'pending' : ''}">${cell(row.displayName || row.name || '姓名待补')}${cell(row.accountUsername || row.username || '暂无法生成')}${cell(row.edu)}${cell(row.cohort)}${cell(row.status)}${cell(row.industry)}${cell(row.org)}${cell(row.doing)}${cell(row.city)}${cell(row.willingContact)}${cell(row.contact)}${cell(row.offer)}${cell(row.want)}${cell(row.hiring)}${cell(row.message)}${cell(row.accountStatus)}${cell(row.passwordStatus)}${cell(pending ? `待核对：${(row.reviewReasons || []).join('；')}` : '已开户') }<td>${actions}</td></tr>`;
  }).join('')}</tbody></table>`;
}

async function loadRoster() {
  const params = new URLSearchParams();
  if (els.rosterStatus.value) params.set('status', els.rosterStatus.value);
  if (els.rosterQuery.value.trim()) params.set('q', els.rosterQuery.value.trim());
  const data = await request(`/api/admin/roster?${params}`);
  rosterRows = data.rows || [];
  els.rosterSummary.textContent = `名单共 ${data.total || rosterRows.length} 条 · 已开户 ${data.accountCount || 0} · 待核对 ${data.pendingCount || 0}`;
  renderRoster();
}

async function exportRoster() {
  const response = await fetch(api('/api/admin/roster.csv'), { headers: { 'x-alumni-token': getToken() }, cache: 'no-store' });
  if (!response.ok) return flash('导出失败，请重新登录');
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `alumni-roster-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderUsers() {
  els.userCount.textContent = `共 ${users.length} 个账号`;
  if (!users.length) return void (els.usersList.innerHTML = '<div class="admin-empty">暂无账号</div>');
  els.usersList.innerHTML = users.map(user => `
    <div class="admin-row">
      <div class="admin-row-main"><strong>${esc(user.displayName)}</strong><small>${esc(user.username)} · ${esc(user.cohort || '未填届别')}</small></div>
      <div><span class="status-pill ${user.active ? 'on' : 'off'}">${user.active ? '已启用' : '已停用'}</span> ${user.sessionActive ? '<span class="status-pill on">登录中</span>' : ''} ${user.role === 'admin' ? '<span class="status-pill on">管理员</span>' : ''}</div>
      <div class="admin-muted">${user.passwordChanged ? '已改初始密码' : '仍用初始密码'}</div>
      <div class="admin-actions">
        <button class="btn-small" data-user-action="reset" data-id="${esc(user.id)}">重置密码</button>
        <button class="btn-small ${user.active ? 'danger' : ''}" data-user-action="toggle" data-id="${esc(user.id)}">${user.active ? '停用' : '恢复'}</button>
        ${user.sessionActive && user.role !== 'admin' ? `<button class="btn-small" data-user-action="release" data-id="${esc(user.id)}">解除登录占用</button>` : ''}
        ${user.role === 'admin' ? '' : `<button class="btn-small danger" data-user-action="delete" data-id="${esc(user.id)}">删除账号</button>`}
      </div>
    </div>`).join('');
}

async function loadUsers() {
  const data = await request('/api/admin/users');
  users = data.users;
  renderUsers();
}

async function createUser(event) {
  event.preventDefault();
  try {
    const data = await request('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        displayName: els.newDisplayName.value,
        cohort: els.newCohort.value,
        username: els.newUsername.value,
      }),
    });
    els.createUserForm.reset();
    flash(`账号已创建：${data.user.username}，初始密码同账号`);
    await Promise.all([loadUsers(), loadRoster(), loadMembers()]);
  } catch (error) { flash(error.message); }
}

async function handleUserAction(event) {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  const user = users.find(item => item.id === button.dataset.id);
  if (!user) return;
  const action = button.dataset.userAction;
  const reset = button.dataset.userAction === 'reset';
  const message = action === 'delete'
    ? `确认永久删除账号 ${user.displayName}（${user.username}）及其注册资料？此操作不可撤销。`
    : action === 'release'
      ? `解除 ${user.displayName} 当前设备的登录占用？原设备将需要重新登录。`
    : reset
      ? `把 ${user.displayName} 的密码重置为账号 ${user.username}？`
      : `${user.active ? '停用' : '恢复'}账号 ${user.username}？`;
  if (!window.confirm(message)) return;
  try {
    const data = await request(`/api/admin/users/${encodeURIComponent(user.id)}`, action === 'delete'
      ? { method: 'DELETE' }
      : {
        method: 'PATCH',
        body: JSON.stringify(action === 'release' ? { releaseSession: true } : reset ? { resetPassword: true } : { active: !user.active }),
      });
    flash(action === 'delete' ? '账号及关联注册资料已删除' : action === 'release' ? '登录占用已解除' : reset ? `密码已重置为 ${data.resetPassword}` : '账号状态已更新');
    await Promise.all([loadUsers(), loadRoster(), loadMembers(), loadRegistrations()]);
  } catch (error) { flash(error.message); }
}

function renderQuestions() {
  const active = questions.filter(question => question.active).length;
  els.questionCount.textContent = `共 ${questions.length} 道，启用 ${active} 道`;
  if (!questions.length) return void (els.questionsList.innerHTML = '<div class="admin-empty">题库为空。至少启用 3 道题后，新成员注册才会开放。</div>');
  els.questionsList.innerHTML = questions.map(question => `
    <div class="admin-row">
      <div class="admin-row-main"><strong>${esc(question.prompt)}</strong><div class="question-options-preview">${question.options.map((option, index) => `${index + 1}. ${esc(option)}`).join(' · ')}</div></div>
      <div><span class="status-pill ${question.active ? 'on' : 'off'}">${question.active ? '已启用' : '未启用'}</span></div>
      <div class="admin-muted">正确答案：${question.correctIndex + 1}</div>
      <div class="admin-actions"><button class="btn-small" data-question-edit="${esc(question.id)}">编辑</button></div>
    </div>`).join('');
}

async function loadQuestions() {
  const data = await request('/api/admin/questions');
  questions = data.questions;
  renderQuestions();
}

function resetQuestionForm() {
  els.questionForm.reset();
  els.editingQuestionId.value = '';
  els.questionCorrectIndex.value = '';
  els.cancelQuestionEdit.classList.add('hidden');
}

function editQuestion(id) {
  const question = questions.find(item => item.id === id);
  if (!question) return;
  els.editingQuestionId.value = question.id;
  els.questionPrompt.value = question.prompt;
  els.questionOptions.value = question.options.join('\n');
  els.questionCorrectIndex.value = String(question.correctIndex + 1);
  els.questionNotes.value = question.notes || '';
  els.questionActive.checked = question.active;
  els.cancelQuestionEdit.classList.remove('hidden');
  els.questionPrompt.focus();
}

async function saveQuestion(event) {
  event.preventDefault();
  const id = els.editingQuestionId.value;
  const options = els.questionOptions.value.split('\n').map(value => value.trim()).filter(Boolean);
  const body = {
    prompt: els.questionPrompt.value,
    options,
    correctIndex: Number(els.questionCorrectIndex.value) - 1,
    notes: els.questionNotes.value,
    active: els.questionActive.checked,
  };
  try {
    await request(id ? `/api/admin/questions/${encodeURIComponent(id)}` : '/api/admin/questions', {
      method: id ? 'PATCH' : 'POST', body: JSON.stringify(body),
    });
    resetQuestionForm();
    flash(id ? '题目已更新' : '题目已创建');
    await loadQuestions();
  } catch (error) { flash(error.message); }
}

function renderLocks(activity, maxAttempts) {
  if (!activity.length) return void (els.locksList.innerHTML = '<div class="admin-empty">暂无失败记录</div>');
  els.locksList.innerHTML = activity.map(item => {
    const expiry = item.locked && item.expiresAt
      ? ` · ${esc(new Date(item.expiresAt).toLocaleString('zh-CN'))} 解锁`
      : '';
    return `
    <div class="admin-row">
      <div class="admin-row-main"><strong>${esc(item.lastName || '未记录姓名')}</strong><small>最近网络：${esc(item.ip)}</small></div>
      <div><span class="status-pill ${item.locked ? 'off' : 'on'}">${item.locked ? '已锁定' : '未锁定'}</span></div>
      <div class="admin-muted">失败 ${item.attempts} / ${maxAttempts} 次${expiry}</div>
      <div class="admin-actions">${item.locked ? `<button class="btn-small" data-unlock="${esc(item.lockId)}">解除锁定</button>` : ''}</div>
    </div>`;
  }).join('');
}

async function loadLocks() {
  const data = await request('/api/admin/locks');
  renderLocks(data.activity, data.maxRegistrationFailures);
}

const registrationStatusLabels = {
  pending: ['待处理', 'on'], locked: ['答题锁定', 'off'], approved: ['已通过', 'on'], rejected: ['已拒绝', 'off'],
};

function registrationStatus(status) {
  const [label, tone] = registrationStatusLabels[status] || [status || '未知', 'off'];
  return `<span class="status-pill ${tone}">${esc(label)}</span>`;
}

function renderRegistrations(submissions, maxAttempts) {
  if (!submissions.length) return void (els.registrationsList.innerHTML = '<div class="admin-empty">暂无符合条件的申请或注册资料</div>');
  els.registrationsList.innerHTML = submissions.map(item => {
    const profile = item.profile || {};
    const fields = Object.keys(profileLabels).filter(field => String(profile[field] || '').trim());
    const actions = item.status === 'rejected'
      ? `<button class="btn-small" data-registration-action="restore" data-id="${esc(item.id)}">恢复待处理</button>`
      : item.status === 'approved'
        ? ''
        : `<span class="admin-muted">等待答题完成，答对后系统自动开户</span>`;
    const progress = item.quizPassed ? '答题已通过，系统自动开户' : '尚未答题完成';
    return `<article class="registration-card">
      <div class="profile-card-head"><div><strong>${esc(profile.name || '未填写姓名')}</strong><small>${esc(profile.cohort || '未填届别')} · ${esc(profile.city || '未填城市')} · ${esc(item.ip || '未知 IP')}</small></div><div>${registrationStatus(item.status)}<span class="admin-muted registration-date">${esc(item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '')}</span></div></div>
      <div class="registration-meta">${progress} · 答题次数：${item.attemptsUsed || 0} / ${maxAttempts} ${item.username ? `· 账号：${esc(item.username)}` : ''} ${item.reviewerNote ? `· 备注：${esc(item.reviewerNote)}` : ''}</div>
      <div class="profile-admin-grid">${fields.map(field => `<div class="profile-admin-field"><span>${esc(profileLabels[field])}</span><p>${esc(profile[field])}</p></div>`).join('')}</div>
      <div class="admin-actions registration-actions">${actions}</div>
    </article>`;
  }).join('');
}

async function loadRegistrations() {
  const params = new URLSearchParams();
  if (els.registrationStatus.value) params.set('status', els.registrationStatus.value);
  if (els.registrationQuery.value.trim()) params.set('q', els.registrationQuery.value.trim());
  const data = await request(`/api/admin/registrations?${params}`);
  renderRegistrations(data.submissions || [], data.maxRegistrationFailures);
}

async function reviewRegistration(event) {
  const button = event.target.closest('[data-registration-action]');
  if (!button) return;
  const action = button.dataset.registrationAction;
  const labels = { approve: '通过并创建账号', reject: '拒绝这份申请', restore: '恢复为待处理' };
  if (!window.confirm(`确认${labels[action] || '处理'}？`)) return;
  const note = window.prompt('审核备注（可留空）', '') || '';
  try {
    const data = await request(`/api/admin/registrations/${encodeURIComponent(button.dataset.id)}`, {
      method: 'PATCH', body: JSON.stringify({ action, note }),
    });
    flash(data.action === 'approved' ? `已通过，账号为 ${data.user.username}` : '申请状态已更新');
    await Promise.all([loadRegistrations(), loadUsers(), loadMembers()]);
  } catch (error) { flash(error.message); }
}

async function exportRegistrations() {
  try {
    const params = new URLSearchParams();
    if (els.registrationStatus.value) params.set('status', els.registrationStatus.value);
    if (els.registrationQuery.value.trim()) params.set('q', els.registrationQuery.value.trim());
    const response = await fetch(api(`/api/admin/registrations.csv?${params}`), { headers: { 'x-alumni-token': getToken() }, cache: 'no-store' });
    if (!response.ok) throw new Error('导出失败，请重新登录');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `alumni-registration-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { flash(error.message); }
}

async function unlock(event) {
  const button = event.target.closest('[data-unlock]');
  if (!button || !window.confirm('确认解除这个 IP 的答题锁定？')) return;
  try {
    await request(`/api/admin/locks/${encodeURIComponent(button.dataset.unlock)}`, { method: 'DELETE' });
    flash('锁定已解除，失败次数已清零');
    await loadLocks();
  } catch (error) { flash(error.message); }
}

async function boot() {
  if (!getToken()) return showGate();
  try {
    const data = await request('/api/auth/session');
    if (!data.ok || data.user.role !== 'admin') return showGate('请使用管理员账号登录');
    showApp(data.user);
    await Promise.all([loadMembers(), loadRoster(), loadUsers(), loadQuestions(), loadLocks(), loadRegistrations()]);
  } catch (error) { showGate(error.status === 401 || error.status === 403
    ? '管理员登录已失效，请重新登录' : '后台暂时无法加载，请刷新页面重试。'); }
}

els.loginForm.addEventListener('submit', login);
els.logout.onclick = async () => {
  try { await request('/api/auth/logout', { method: 'POST' }); }
  catch (error) {
    if (error.status !== 401) return flash(`退出失败：${error.message}，请重试`);
  }
  clearToken();
  showGate();
};
document.querySelectorAll('.admin-tab').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
els.memberList.addEventListener('click', event => {
  const button = event.target.closest('[data-member-id]');
  if (button) { selectedMemberId = button.dataset.memberId; renderMembers(); }
});
els.memberSource.onchange = renderMembers;
els.memberQuery.oninput = renderMembers;
els.refreshMembers.onclick = loadMembers;
els.refreshAnalytics.onclick = loadAnalytics;
els.createUserForm.addEventListener('submit', createUser);
els.usersList.addEventListener('click', handleUserAction);
els.rosterList.addEventListener('click', handleUserAction);
els.questionForm.addEventListener('submit', saveQuestion);
els.cancelQuestionEdit.onclick = resetQuestionForm;
els.questionsList.addEventListener('click', event => {
  const button = event.target.closest('[data-question-edit]');
  if (button) editQuestion(button.dataset.questionEdit);
});
els.refreshLocks.onclick = loadLocks;
els.locksList.addEventListener('click', unlock);
els.refreshRegistrations.onclick = loadRegistrations;
els.registrationStatus.onchange = loadRegistrations;
let registrationSearchTimer;
els.registrationQuery.oninput = () => { clearTimeout(registrationSearchTimer); registrationSearchTimer = setTimeout(loadRegistrations, 250); };
els.registrationsList.addEventListener('click', reviewRegistration);
els.exportRegistrations.onclick = exportRegistrations;
els.refreshRoster.onclick = loadRoster;
els.rosterStatus.onchange = loadRoster;
let rosterSearchTimer;
els.rosterQuery.oninput = () => { clearTimeout(rosterSearchTimer); rosterSearchTimer = setTimeout(loadRoster, 250); };
els.exportRoster.onclick = exportRoster;

boot();
