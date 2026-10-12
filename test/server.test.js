'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server');

async function setup(t, options = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alumni-server-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'alumni.json');
  const seedPath = path.join(dir, 'seed.json');
  const rosterReviewPath = path.join(dir, 'pending-account-review.json');
  await fs.promises.writeFile(dataPath, JSON.stringify({
    _note: '测试数据',
    records: [{
      id: 'a0001', name: '张三', cohort: '2020', cohortYear: '2020',
      edu: '浙江大学', city: '杭州', cityNorm: '杭州', status: '工作', industry: 'AI', org: '量化机构', doing: '测试',
      want: '', hiring: '', message: '', contact: '', willingContact: '',
    }],
  }));
  await fs.promises.writeFile(seedPath, JSON.stringify({
    accounts: [{ displayName: '张三', username: 'zhangsan' }],
  }));
  await fs.promises.writeFile(rosterReviewPath, JSON.stringify({
    pending: [{ row: 2, displayName: '待核对', username: 'daihedui', reasons: ['测试原因'] }],
  }));
  const app = await createApp({
    dataPath,
    publicDir: path.join(__dirname, '..', 'public'),
    stateDir: path.join(dir, 'state'),
    seedPath,
    rosterReviewPath,
    questionSeedPath: null,
    sessionSecret: 'test-session-secret-that-is-at-least-32-bytes',
    scryptCost: 1024,
    trustProxy: true,
    logger: null,
    ...options,
  });
  const admin = await app.store.createUser({
    displayName: '管理员', username: 'admin', password: 'admin-password-123',
    role: 'admin', allowSuffix: false,
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const address = app.server.address();
  return { ...app, admin, base: `http://127.0.0.1:${address.port}` };
}

async function call(base, pathname, options = {}) {
  const response = await fetch(base + pathname, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { 'x-alumni-token': options.token } : {}),
      ...(options.ip ? { 'x-forwarded-for': options.ip } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, data: await response.json() };
}

async function login(base, username, password, ip = '203.0.113.20') {
  return call(base, '/api/auth/login', {
    method: 'POST', ip, body: JSON.stringify({ username, password }),
  });
}

test('只有成功登录消耗周年提醒次数，刷新会话不消耗，第六次不弹窗', async t => {
  let clock = Date.parse('2026-07-01T00:00:00Z');
  const { base, store } = await setup(t, { now: () => clock });
  clock = Date.parse('2027-07-01T00:00:00Z');
  const user = store.findUserByUsername('zhangsan');
  const denied = await login(base, 'zhangsan', 'wrong');
  assert.equal(denied.response.status, 401);
  assert.equal(user.profileReminderLoginCount, undefined);
  for (let i = 1; i <= 6; i++) {
    const result = await login(base, 'zhangsan', 'zhangsan');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.profileReminder?.loginNumber ?? null, i <= 5 ? i : null);
    const session = await call(base, '/api/auth/session', { token: result.data.token });
    assert.equal(session.data.ok, true);
    assert.equal(session.data.profileReminder, undefined);
    assert.equal(user.profileReminderLoginCount, Math.min(i, 5));
    assert.equal((await call(base, '/api/auth/logout', { method: 'POST', token: result.data.token })).response.status, 200);
  }
  clock = Date.parse('2028-07-01T00:00:00Z');
  assert.equal((await login(base, 'zhangsan', 'zhangsan')).data.profileReminder.loginNumber, 1);
});

test('未登录不能读取校友数据，使用初始密码登录后可以检索', async t => {
  const { base } = await setup(t);
  const denied = await call(base, '/api/search?q=AI');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.data.needAuth, true);

  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  assert.equal(signedIn.response.status, 200);
  const search = await call(base, '/api/search?q=AI', { token: signedIn.data.token });
  assert.equal(search.response.status, 200);
  assert.equal(search.data.items.length, 1);
  assert.equal(Object.hasOwn(search.data.items[0], 'contact'), false);
  assert.equal(Object.hasOwn(search.data.items[0], 'contactable'), false);
  assert.equal(search.data.items[0].experiences[0].recordedMonth, '');
  assert.equal(search.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(search.response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});

test('访问统计按北京时间累计页面访问并估算每日独立访客，只有管理员可查看', async t => {
  let clock = Date.parse('2026-09-29T15:59:00Z');
  const { base, analyticsStore } = await setup(t, { now: () => clock });
  const first = 'a'.repeat(32);
  const second = 'b'.repeat(32);
  const visit = id => call(base, '/api/visit', { method: 'POST', body: JSON.stringify({ visitorId: id }) });
  assert.equal((await visit(first)).response.status, 200);
  assert.equal((await visit(first)).response.status, 200);
  assert.equal((await visit(second)).response.status, 200);
  assert.equal((await visit('bad')).response.status, 400);
  assert.equal((await call(base, '/api/admin/analytics')).response.status, 401);
  const member = await login(base, 'zhangsan', 'zhangsan');
  assert.equal((await call(base, '/api/admin/analytics', { token: member.data.token })).response.status, 403);
  const admin = await login(base, 'admin', 'admin-password-123', '203.0.113.22');
  let report = await call(base, '/api/admin/analytics', { token: admin.data.token });
  assert.equal(report.response.status, 200);
  assert.equal(report.data.analytics.today.date, '2026-09-29');
  assert.equal(report.data.analytics.today.pageViews, 3);
  assert.equal(report.data.analytics.today.uniqueVisitors, 2);
  assert.equal(report.data.analytics.totalViews, 3);
  assert.equal(report.data.analytics.last7Views, 3);
  assert.equal(analyticsStore.state.daily['2026-09-29'].visitorBits.length > 0, true);
  assert.equal(JSON.stringify(analyticsStore.state).includes(first), false, '原始访客标识不得写入数据库');

  clock = Date.parse('2026-09-29T16:01:00Z');
  assert.equal((await visit(first)).response.status, 200);
  report = await call(base, '/api/admin/analytics', { token: admin.data.token });
  assert.equal(report.data.analytics.today.date, '2026-09-30');
  assert.equal(report.data.analytics.today.pageViews, 1);
  assert.equal(report.data.analytics.today.uniqueVisitors, 1);
  assert.equal(report.data.analytics.last7Views, 4);
  assert.equal(report.data.analytics.totalViews, 4);
});

test('拒绝长度不足 32 字节的固定会话密钥', async t => {
  await assert.rejects(setup(t, { sessionSecret: 'too-short' }), /至少需要 32 字节/);
});

test('CloudBase 模式只从数据库读取校友基线，空基线拒绝启动', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alumni-cloudbase-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  let state = {
    version: 1, users: [], questions: [], profiles: [], rosterRecords: [],
    registrationSubmissions: [], registrationAttempts: {}, registrationLocks: [],
  };
  const backend = {
    async load() { return JSON.parse(JSON.stringify(state)); },
    async save(next) { state = JSON.parse(JSON.stringify(next)); },
  };
  const options = {
    rootDir: path.join(__dirname, '..'),
    publicDir: path.join(__dirname, '..', 'public'),
    stateDir: path.join(dir, 'state'),
    storageDriver: 'cloudbase',
    stateBackend: backend,
    analyticsBackend: { async load() { return null; }, async save() {} },
    seedPath: null,
    questionSeedPath: null,
    sessionSecret: 'test-session-secret-that-is-at-least-32-bytes',
    logger: null,
  };
  await assert.rejects(createApp(options), /尚无校友基线/);

  state.rosterRecords = [{ id: 'a0001', name: '数据库校友', city: '杭州' }];
  const app = await createApp(options);
  assert.equal(app.store.listRosterRecords()[0].name, '数据库校友');
});

test('改密后旧令牌立即失效', async t => {
  const { base } = await setup(t);
  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  const changed = await call(base, '/api/auth/change-password', {
    method: 'POST', token: signedIn.data.token,
    body: JSON.stringify({ oldPassword: 'zhangsan', newPassword: 'new-password-123' }),
  });
  assert.equal(changed.response.status, 200);
  const oldSession = await call(base, '/api/meta', { token: signedIn.data.token });
  assert.equal(oldSession.response.status, 401);
  const newSession = await call(base, '/api/meta', { token: changed.data.token });
  assert.equal(newSession.response.status, 200);
  const duplicate = await login(base, 'zhangsan', 'new-password-123', '203.0.113.29');
  assert.equal(duplicate.response.status, 409, '改密后仍应保留原设备的登录占用');
  assert.equal(duplicate.data.canTakeOver, true);
  assert.ok(duplicate.data.takeOverSessionId);
  const takeover = await call(base, '/api/auth/login', {
    method: 'POST', ip: '203.0.113.29',
    body: JSON.stringify({
      username: 'zhangsan', password: 'new-password-123',
      takeOverSessionId: duplicate.data.takeOverSessionId,
    }),
  });
  assert.equal(takeover.response.status, 200);
  assert.equal((await call(base, '/api/meta', { token: changed.data.token })).response.status, 401);
  assert.equal((await call(base, '/api/meta', { token: takeover.data.token })).response.status, 200);
  const staleTakeover = await call(base, '/api/auth/login', {
    method: 'POST', ip: '203.0.113.30',
    body: JSON.stringify({
      username: 'zhangsan', password: 'new-password-123',
      takeOverSessionId: duplicate.data.takeOverSessionId,
    }),
  });
  assert.equal(staleTakeover.response.status, 409, '过期的接管确认不能踢掉新设备');
  assert.equal((await call(base, '/api/meta', { token: takeover.data.token })).response.status, 200);
});

test('同一账号先登录者保留访问，第二设备被拒，主动退出后才可登录', async t => {
  const { base } = await setup(t);
  const first = await login(base, 'zhangsan', 'zhangsan', '203.0.113.31');
  assert.equal(first.response.status, 200);
  const second = await login(base, 'zhangsan', 'zhangsan', '203.0.113.32');
  assert.equal(second.response.status, 409);
  assert.equal(second.data.code, 'account_in_use');
  assert.equal(second.data.canTakeOver, false, '初始密码账号不能被其他人直接接管');
  assert.equal((await call(base, '/api/meta', { token: first.data.token })).response.status, 200);
  assert.equal((await call(base, '/api/auth/logout', { method: 'POST', token: first.data.token })).response.status, 200);
  assert.equal((await call(base, '/api/meta', { token: first.data.token })).response.status, 401);
  const afterLogout = await login(base, 'zhangsan', 'zhangsan', '203.0.113.32');
  assert.equal(afterLogout.response.status, 200);
});

test('并发抢同一账号只有一个成功；管理员可解除意外残留的占用', async t => {
  const { base } = await setup(t);
  const results = await Promise.all([
    login(base, 'zhangsan', 'zhangsan', '203.0.113.41'),
    login(base, 'zhangsan', 'zhangsan', '203.0.113.42'),
  ]);
  assert.deepEqual(results.map(item => item.response.status).sort(), [200, 409]);
  const winner = results.find(item => item.response.status === 200);
  const admin = await login(base, 'admin', 'admin-password-123', '203.0.113.43');
  const listing = await call(base, '/api/admin/users', { token: admin.data.token });
  const account = listing.data.users.find(item => item.username === 'zhangsan');
  assert.equal(account.sessionActive, true);
  const released = await call(base, `/api/admin/users/${account.id}`, {
    method: 'PATCH', token: admin.data.token, body: JSON.stringify({ releaseSession: true }),
  });
  assert.equal(released.response.status, 200);
  assert.equal((await call(base, '/api/meta', { token: winner.data.token })).response.status, 401);
  assert.equal((await login(base, 'zhangsan', 'zhangsan', '203.0.113.42')).response.status, 200);
});

test('页面续期保留先登录者；停止续期后五分钟内自动释放账号', async t => {
  let clock = Date.parse('2026-09-29T00:00:00Z');
  const { base } = await setup(t, { now: () => clock });
  const first = await login(base, 'zhangsan', 'zhangsan', '203.0.113.51');
  assert.equal(first.response.status, 200);
  clock += 3 * 60 * 1000;
  assert.equal((await call(base, '/api/auth/heartbeat', { method: 'POST', token: first.data.token })).response.status, 200);
  clock += 4 * 60 * 1000;
  assert.equal((await call(base, '/api/meta', { token: first.data.token })).response.status, 200);
  assert.equal((await login(base, 'zhangsan', 'zhangsan', '203.0.113.52')).response.status, 409);
  clock += 2 * 60 * 1000;
  assert.equal((await call(base, '/api/meta', { token: first.data.token })).response.status, 401);
  assert.equal((await login(base, 'zhangsan', 'zhangsan', '203.0.113.52')).response.status, 200);
});

test('登录占用写入失败时不发令牌，也不阻碍后续重试', async t => {
  const { base, store } = await setup(t);
  const persist = store.persistSnapshot.bind(store);
  store.persistSnapshot = async () => { throw new Error('simulated database failure'); };
  const failed = await login(base, 'zhangsan', 'zhangsan');
  assert.equal(failed.response.status, 503);
  assert.equal(failed.data.token, undefined);
  assert.equal(store.findUserByUsername('zhangsan').activeSession, undefined);
  store.persistSnapshot = persist;
  assert.equal((await login(base, 'zhangsan', 'zhangsan')).response.status, 200);
});

test('改密保存失败返回503且保留旧会话，重试成功后才切换会话', async t => {
  const { base, store } = await setup(t);
  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  const persist = store.persistSnapshot.bind(store);
  store.persistSnapshot = async () => { throw new Error('simulated database failure'); };
  const request = {
    method: 'POST', token: signedIn.data.token,
    body: JSON.stringify({ oldPassword: 'zhangsan', newPassword: 'new-password-123' }),
  };
  const failed = await call(base, '/api/auth/change-password', request);
  assert.equal(failed.response.status, 503);
  assert.equal(failed.data.token, undefined);
  assert.equal((await call(base, '/api/meta', { token: signedIn.data.token })).response.status, 200);
  assert.ok(await store.authenticate('zhangsan', 'zhangsan'));
  store.persistSnapshot = persist;
  const changed = await call(base, '/api/auth/change-password', request);
  assert.equal(changed.response.status, 200);
  assert.equal((await call(base, '/api/meta', { token: signedIn.data.token })).response.status, 401);
  assert.equal((await call(base, '/api/meta', { token: changed.data.token })).response.status, 200);
});

test('校友可修改本人资料，检索立即刷新且历史经历不会被覆盖', async t => {
  const { base, store } = await setup(t);
  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  const before = await call(base, '/api/profile', { token: signedIn.data.token });
  assert.equal(before.response.status, 200);
  assert.equal(before.data.profile.name, '张三');
  assert.equal(before.data.profile.org, '量化机构');
  assert.equal(before.data.profile.username, 'zhangsan');
  assert.equal(before.data.profile.experiences[0].recordedMonth, store.findUserByUsername('zhangsan').profileFirstFilledMonth);

  const saved = await call(base, '/api/profile', {
    method: 'PATCH', token: signedIn.data.token,
    body: JSON.stringify({
      ...before.data.profile,
      status: '创业', industry: '人工智能', org: 'DSH', doing: '大模型产品', city: '上海',
      name: '不能改名', username: 'cannot-change',
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.profile.name, '张三');
  assert.equal(saved.data.profile.username, 'zhangsan');
  assert.equal(saved.data.profile.experiences.length, 2);
  assert.equal(saved.data.profile.experiences[0].org, '量化机构');
  assert.equal(saved.data.profile.experiences[0].isCurrent, false);
  assert.equal(saved.data.profile.experiences[1].org, 'DSH');
  assert.match(saved.data.profile.experiences[1].recordedMonth, /^\d{4}-\d{2}$/);

  const search = await call(base, '/api/search?q=DSH', { token: signedIn.data.token });
  assert.equal(search.response.status, 200);
  assert.equal(search.data.items.length, 1);
  assert.equal(search.data.items[0].name, '张三');
  assert.equal(search.data.items[0].org, 'DSH');
  assert.equal(search.data.items[0].experiences.length, 2);
  const meta = await call(base, '/api/meta', { token: signedIn.data.token });
  assert.equal(meta.data.total, 1, '数据库中的更新资料应覆盖旧名单，而不是生成重复校友');

  const savedAgain = await call(base, '/api/profile', {
    method: 'PATCH', token: signedIn.data.token,
    body: JSON.stringify({ ...saved.data.profile, want: '行业交流' }),
  });
  assert.equal(savedAgain.data.profile.experiences.length, 2);
  assert.equal(savedAgain.data.profile.want, '行业交流');

  const pastId = savedAgain.data.profile.experiences[0].id;
  const currentId = savedAgain.data.profile.experiences[1].id;
  const cannotDeleteCurrent = await call(base, `/api/profile/experiences/${currentId}`, {
    method: 'DELETE', token: signedIn.data.token,
  });
  assert.equal(cannotDeleteCurrent.response.status, 400);
  const deleted = await call(base, `/api/profile/experiences/${pastId}`, {
    method: 'DELETE', token: signedIn.data.token,
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.data.profile.experiences.map(item => item.id), [currentId]);
  const afterDeleteSearch = await call(base, '/api/search?q=DSH', { token: signedIn.data.token });
  assert.deepEqual(afterDeleteSearch.data.items[0].experiences.map(item => item.id), [currentId]);
  assert.equal(Object.hasOwn(afterDeleteSearch.data.items[0], 'relevance'), false);
  assert.equal(Object.hasOwn(afterDeleteSearch.data.items[0], 'reasons'), false);
  const unauthorizedDelete = await call(base, `/api/profile/experiences/${currentId}`, { method: 'DELETE' });
  assert.equal(unauthorizedDelete.response.status, 401);
});

test('连续错误登录会触发限速', async t => {
  const { base } = await setup(t);
  for (let i = 0; i < 5; i++) {
    const wrong = await login(base, 'zhangsan', 'wrong', '203.0.113.21');
    assert.equal(wrong.response.status, 401);
  }
  const blocked = await login(base, 'zhangsan', 'zhangsan', '203.0.113.21');
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.data.code, 'login_rate_limited');
});

test('注册开始接口按来源限速', async t => {
  const { base, store } = await setup(t, { registrationIpLimit: 2, registrationGlobalLimit: 10 });
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({ prompt: `限速题 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  }
  const request = name => call(base, '/api/register/start', {
    method: 'POST', ip: '203.0.113.50',
    body: JSON.stringify({ profile: {
      name, edu: '浙江大学', cohort: '2026 届', status: '工作',
      industry: '人工智能', org: '', doing: '测试', city: '杭州',
      willingContact: '不愿意', contact: `${name.charCodeAt(0)}@example.com`,
    } }),
  });
  assert.equal((await request('甲')).response.status, 200);
  assert.equal((await request('乙')).response.status, 200);
  const blocked = await request('丙');
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.data.code, 'registration_rate_limited');
});

test('管理员维护题库，公开答题接口不泄露答案', async t => {
  const { base, store } = await setup(t);
  const adminLogin = await login(base, 'admin', 'admin-password-123');
  for (let i = 0; i < 3; i++) {
    const created = await call(base, '/api/admin/questions', {
      method: 'POST', token: adminLogin.data.token,
      body: JSON.stringify({
        prompt: `内部题 ${i + 1}`, options: ['错误', '正确'], correctIndex: 1, active: true,
      }),
    });
    assert.equal(created.response.status, 201);
  }
  const config = await call(base, '/api/config');
  assert.equal(config.data.registrationAvailable, true);

  const started = await call(base, '/api/register/start', {
    method: 'POST', ip: '203.0.113.22',
    body: JSON.stringify({ profile: {
      name: '新同学', edu: '浙江大学', cohort: '2026 届', status: '工作',
      industry: '人工智能', org: '测试机构', doing: '测试网站', city: '杭州',
      willingContact: '愿意', contact: 'new.member@example.com', offer: '行业交流',
      want: '认识校友', hiring: '无', message: '加油',
    } }),
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.data.questions.length, 3);
  assert.equal(Object.hasOwn(started.data.questions[0], 'correctIndex'), false);
  const pendingRegistrations = await call(base, '/api/admin/registrations?status=pending', { token: adminLogin.data.token });
  assert.equal(pendingRegistrations.response.status, 200);
  assert.equal(pendingRegistrations.data.submissions.length, 1);
  assert.equal(pendingRegistrations.data.submissions[0].profile.contact, 'new.member@example.com');
  const correctById = new Map(store.listQuestions(true).map(question => [question.id, question.correctIndex]));
  const wrongAnswers = Object.fromEntries(started.data.questions.map(question => [question.id, 0]));
  const wrong = await call(base, '/api/register/submit', {
    method: 'POST', ip: '203.0.113.22',
    body: JSON.stringify({ attemptId: started.data.attemptId, answers: wrongAnswers }),
  });
  assert.equal(wrong.data.passed, false);
  const restarted = await call(base, '/api/register/start', {
    method: 'POST', ip: '203.0.113.22',
    body: JSON.stringify({ profile: started.data.questions && pendingRegistrations.data.submissions[0].profile }),
  });
  const stillOneRegistration = await call(base, '/api/admin/registrations?status=pending', { token: adminLogin.data.token });
  assert.equal(stillOneRegistration.data.submissions.length, 1, '重试答题不应留下重复申请');
  const retryAnswers = Object.fromEntries(restarted.data.questions.map(question => [question.id, correctById.get(question.id)]));
  const retrySubmitted = await call(base, '/api/register/submit', {
    method: 'POST', ip: '203.0.113.22',
    body: JSON.stringify({ attemptId: restarted.data.attemptId, answers: retryAnswers }),
  });
  assert.equal(retrySubmitted.response.status, 201);
  assert.equal(retrySubmitted.data.username, 'xintongxue');
  const newLogin = await login(base, 'xintongxue', 'xintongxue', '203.0.113.23');
  assert.equal(newLogin.response.status, 200);
  const newSearch = await call(base, '/api/search?q=人工智能', { token: newLogin.data.token });
  const newProfile = newSearch.data.items.find(item => item.name === '新同学');
  assert.ok(newProfile);
  assert.equal(Object.hasOwn(newProfile, 'contact'), false);

  const profiles = await call(base, '/api/admin/profiles', { token: adminLogin.data.token });
  assert.equal(profiles.response.status, 200);
  assert.equal(profiles.data.profiles.length, 1);
  assert.equal(profiles.data.profiles[0].name, '新同学');
  assert.equal(profiles.data.profiles[0].contact, 'new.member@example.com');
  assert.equal(Object.hasOwn(profiles.data.profiles[0], 'namePinyin'), false);
  const memberRoster = await call(base, '/api/admin/roster?status=account', { token: adminLogin.data.token });
  const memberRow = memberRoster.data.rows.find(row => row.accountUsername === 'xintongxue');
  assert.ok(memberRow, '已开户的新成员应出现在成员资料列表');
  for (const [field, value] of Object.entries({
    offer: '行业交流', want: '认识校友', hiring: '无', message: '加油',
    contact: 'new.member@example.com', willingContact: '愿意',
  })) assert.equal(memberRow[field], value, `${field} 应向管理员显示`);
  assert.equal(memberRow.source, 'quiz-registration');
  assert.ok(memberRow.profileUpdatedAt);
  assert.equal(memberRow.experiences.length, 1);
  const privateRoster = await call(base, '/api/admin/roster?status=account', { token: newLogin.data.token });
  assert.equal(privateRoster.response.status, 403, '普通成员不能读取后台完整资料');
  const approvedRegistrations = await call(base, '/api/admin/registrations?status=approved', { token: adminLogin.data.token });
  assert.equal(approvedRegistrations.data.submissions.length, 1);
  assert.equal(approvedRegistrations.data.submissions[0].username, 'xintongxue');
});

test('注册接口答错五次才锁定姓名，锁定后换网络也不能继续', async t => {
  const { base, store } = await setup(t);
  for (let i = 0; i < 9; i++) {
    await store.createQuestion({ prompt: `锁定题 ${i}`, options: ['正确', '错误'], correctIndex: 0, active: true });
  }
  const member = {
    name: '锁定测试', edu: '浙江大学', cohort: '2026 届', status: '在校',
    industry: '测试', doing: '注册流程测试', city: '杭州',
    willingContact: '不愿意', contact: 'lock-test@example.com',
  };
  for (let count = 1; count <= 5; count++) {
    const started = await call(base, '/api/register/start', {
      method: 'POST', ip: '203.0.113.60', body: JSON.stringify({ profile: member }),
    });
    assert.equal(started.response.status, 200);
    assert.equal(started.data.attemptsUsed, count - 1);
    const wrong = await call(base, '/api/register/submit', {
      method: 'POST', ip: '203.0.113.60',
      body: JSON.stringify({
        attemptId: started.data.attemptId,
        answers: Object.fromEntries(started.data.questions.map(q => [q.id, 1])),
      }),
    });
    assert.equal(wrong.response.status, 200);
    assert.equal(wrong.data.passed, false);
    assert.equal(wrong.data.attemptsUsed, count);
    assert.equal(wrong.data.locked, count === 5);
    assert.equal(store.findUserByDisplayName(member.name), null);
  }
  const blocked = await call(base, '/api/register/start', {
    method: 'POST', ip: '203.0.113.61', body: JSON.stringify({ profile: member }),
  });
  assert.equal(blocked.response.status, 423);
  assert.equal(blocked.data.code, 'registration_locked');
  const otherMember = await call(base, '/api/register/start', {
    method: 'POST', ip: '203.0.113.60',
    body: JSON.stringify({ profile: { ...member, name: '另一成员' } }),
  });
  assert.equal(otherMember.response.status, 200);
});

test('普通用户不能进入管理接口', async t => {
  const { base } = await setup(t);
  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  const admin = await call(base, '/api/admin/users', { token: signedIn.data.token });
  assert.equal(admin.response.status, 403);
  const profiles = await call(base, '/api/admin/profiles', { token: signedIn.data.token });
  assert.equal(profiles.response.status, 403);
});

test('管理员可查看已有账号与待核对名单，并导出名单', async t => {
  const { base } = await setup(t);
  const memberLogin = await login(base, 'zhangsan', 'zhangsan');
  const profile = await call(base, '/api/profile', { token: memberLogin.data.token });
  await call(base, '/api/profile', {
    method: 'PATCH', token: memberLogin.data.token,
    body: JSON.stringify({ ...profile.data.profile, message: '=HYPERLINK("https://example.com")' }),
  });
  const adminLogin = await login(base, 'admin', 'admin-password-123');
  const roster = await call(base, '/api/admin/roster', { token: adminLogin.data.token });
  assert.equal(roster.response.status, 200);
  assert.equal(roster.data.total, 2);
  assert.equal(roster.data.accountCount, 1);
  assert.equal(roster.data.pendingCount, 1);
  const accountRow = roster.data.rows.find(row => row.rosterStatus === 'account');
  const pendingRow = roster.data.rows.find(row => row.rosterStatus === 'pending');
  assert.equal(accountRow.username, 'zhangsan');
  assert.equal(accountRow.accountUsername, 'zhangsan');
  assert.ok(Object.hasOwn(accountRow, 'industry'));
  assert.equal(pendingRow.displayName, '待核对');
  assert.ok(Object.hasOwn(pendingRow, 'contact'));
  const csv = await fetch(`${base}/api/admin/roster.csv`, { headers: { 'x-alumni-token': adminLogin.data.token } });
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /待核对/);
  assert.match(csvText, /联系方式/);
  assert.match(csvText, /'\=HYPERLINK/);
  assert.equal(csv.headers.get('x-content-type-options'), 'nosniff');
});

test('管理员可删除普通账号但不能删除管理员账号', async t => {
  const { base, store, admin } = await setup(t);
  const created = await store.createUser({ displayName: '测试删除', username: 'ceshishanchu' });
  const adminLogin = await login(base, 'admin', 'admin-password-123');
  const deleted = await call(base, `/api/admin/users/${encodeURIComponent(created.id)}`, {
    method: 'DELETE', token: adminLogin.data.token,
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.data.user.username, 'ceshishanchu');
  const users = await call(base, '/api/admin/users', { token: adminLogin.data.token });
  assert.equal(users.data.users.some(user => user.username === 'ceshishanchu'), false);

  const protectedAdmin = await call(base, `/api/admin/users/${encodeURIComponent(admin.id)}`, {
    method: 'DELETE', token: adminLogin.data.token,
  });
  assert.equal(protectedAdmin.response.status, 409);
  assert.equal(protectedAdmin.data.code, 'cannot_delete_admin');
});

test('并行错误密码请求在计算密码前就限速，不能靠同时发送绕过次数限制', async t => {
  const { base, store } = await setup(t);
  const original = store.authenticate.bind(store);
  let hashes = 0;
  store.authenticate = async (...args) => {
    hashes++;
    await new Promise(resolve => setTimeout(resolve, 50));
    return original(...args);
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => login(base, 'zhangsan', 'wrong')));
  assert.equal(hashes, 5);
  assert.equal(results.filter(r => r.response.status === 401).length, 5);
  assert.equal(results.filter(r => r.response.status === 429).length, 15);
});

test('JSON 空值和数组返回明确错误，不进入注册和改密逻辑', async t => {
  const { base } = await setup(t);
  for (const body of ['null', '[]', '"text"']) {
    const result = await call(base, '/api/auth/login', { method: 'POST', body });
    assert.equal(result.response.status, 400);
    assert.equal(result.data.error, '请求格式不正确');
  }
});

test('其他进程撤销的令牌会在下次请求时失效，无令牌的访问不读取私有数据库', async t => {
  let saved = null;
  let reads = 0;
  const backend = {
    async load() { reads++; return structuredClone(saved); },
    async save(state) { saved = structuredClone(state); },
  };
  const { base } = await setup(t, { stateBackend: backend });
  const signedIn = await login(base, 'zhangsan', 'zhangsan');
  assert.equal(signedIn.response.status, 200);
  const token = signedIn.data.token;
  const beforeReads = reads;
  assert.equal((await call(base, '/api/search?q=AI')).response.status, 401);
  assert.equal(reads, beforeReads);
  saved.users.find(u => u.username === 'zhangsan').tokenVersion++;
  const result = await call(base, '/api/search?q=AI', { token });
  assert.equal(result.response.status, 401);
  assert.ok(reads > beforeReads);
});
