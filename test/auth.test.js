'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AuthStore,
  LoginLimiter,
  MAX_REGISTRATION_FAILURES,
  REGISTRATION_LOCK_TTL_MS,
  cleanProfile,
  usernameFromName,
} = require('../lib/auth');
const { CloudBaseStateBackend } = require('../lib/state-backends');

async function makeStore(t, seedAccounts = [], extraOptions = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alumni-auth-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const seedPath = path.join(dir, 'seed.json');
  await fs.promises.writeFile(seedPath, JSON.stringify({ accounts: seedAccounts }));
  const options = {
    statePath: path.join(dir, 'auth-state.json'),
    seedPath,
    scryptCost: 1024,
    ...extraOptions,
  };
  return { dir, options, store: await new AuthStore(options).init() };
}

function profile(name = '新成员') {
  return {
    name,
    edu: '浙江大学',
    cohort: '2026 届',
    status: '工作',
    industry: '人工智能',
    org: '测试机构',
    doing: '校友网站测试',
    city: '杭州',
    offer: '行业交流',
    want: '认识校友',
    hiring: '无',
    message: '加油',
    willingContact: '不愿意',
    contact: 'new.member@example.com',
  };
}

test('周年提醒按北京时间在导入满一年后开始，每轮前五次登录，重启和修改资料不重置', async t => {
  let clock = Date.parse('2026-07-01T00:00:00Z');
  const { options, store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }], { now: () => clock });
  clock = Date.parse('2027-06-30T15:59:59Z');
  const user = store.findUserByUsername('zhangsan');
  assert.equal(user.profileFirstFilledMonth, '2026-07');
  assert.equal(await store.recordProfileReminderLogin(user.id), null);
  clock = Date.parse('2027-06-30T16:00:00Z');
  assert.equal((await store.recordProfileReminderLogin(user.id)).loginNumber, 1);
  await store.updateOwnProfile(user.id, { city: '上海' });
  const restored = await new AuthStore({ ...options, now: () => clock }).init();
  assert.equal((await restored.recordProfileReminderLogin(user.id)).loginNumber, 2);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => restored.recordProfileReminderLogin(user.id)));
  assert.deepEqual(concurrent.filter(Boolean).map(item => item.loginNumber), [3, 4, 5]);
  clock = Date.parse('2028-06-30T15:59:59Z');
  assert.equal(await restored.recordProfileReminderLogin(user.id), null);
  clock = Date.parse('2028-06-30T16:00:00Z');
  assert.deepEqual(await restored.recordProfileReminderLogin(user.id), {
    firstFilledMonth: '2026-07', cycle: 2, loginNumber: 1, limit: 5,
  });
});

test('缺少起算月的账号按当前月份补齐，新账号使用创建月份，管理员不提醒', async t => {
  const { options, store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }]);
  delete store.findUserByUsername('zhangsan').profileFirstFilledMonth;
  await store.save();
  let clock = Date.parse('2026-09-04T00:00:00Z');
  const restored = await new AuthStore({ ...options, now: () => clock }).init();
  assert.equal(restored.findUserByUsername('zhangsan').profileFirstFilledMonth, '2026-09');
  const newUser = await restored.createUser({ displayName: '新成员', username: 'newmember' });
  const admin = await restored.createUser({ displayName: '管理员', username: 'admin', role: 'admin' });
  assert.equal(newUser.profileFirstFilledMonth, '2026-09');
  clock = Date.parse('2027-08-31T15:59:59Z');
  assert.equal(await restored.recordProfileReminderLogin(newUser.id), null);
  clock += 1000;
  assert.equal((await restored.recordProfileReminderLogin(newUser.id)).loginNumber, 1);
  assert.equal(await restored.recordProfileReminderLogin(admin.id), null);
});

test('拼音账号、重名编号和初始密码', async t => {
  assert.equal(usernameFromName('张 三'), 'zhangsan');
  const { store } = await makeStore(t, [
    { displayName: '张三', username: 'zhangsan' },
    { displayName: '张三', username: 'zhangsan2' },
  ]);
  assert.equal(store.listUsers().length, 2);
  assert.ok(await store.authenticate('zhangsan', 'zhangsan'));
  assert.ok(await store.authenticate('zhangsan2', 'zhangsan2'));
  const created = await store.createUser({ displayName: '张珊', username: 'zhangsan' });
  assert.equal(created.username, 'zhangsan3');
});

test('管理员引导只在账号不存在时创建，不覆盖后续密码', async t => {
  const { store } = await makeStore(t);
  const admin = await store.ensureAdmin({ username: 'admin', password: 'a-secure-admin-password' });
  assert.equal(admin.role, 'admin');
  assert.ok(await store.authenticate('admin', 'a-secure-admin-password'));
  const again = await store.ensureAdmin({ username: 'admin', password: 'another-password' });
  assert.equal(again.id, admin.id);
  assert.ok(await store.authenticate('admin', 'a-secure-admin-password'));
  assert.equal(await store.authenticate('admin', 'another-password'), null);
});

test('站内校友资料校验联系方式并生成检索字段', () => {
  assert.throws(() => cleanProfile({ ...profile(), contact: '微信号 only' }), /邮箱/);
  assert.throws(() => cleanProfile({ ...profile(), name: 'John Smith' }), /中文姓名/);
  for (const name of ['王小明 John', '王小明John', '王小明（John）', '王小明123', '王 小明']) {
    assert.throws(() => cleanProfile(profile(name)), /只填写中文姓名/);
  }
  for (const name of ['王小明', '欧阳小明', '阿依古丽·阿不都', '𠮷小明']) {
    assert.equal(cleanProfile(profile(name)).name, name);
  }
  const cleaned = cleanProfile({ ...profile('王小明'), city: '杭州、上海', willingContact: '不愿意' });
  assert.equal(cleaned.cohortYear, '2026');
  assert.equal(cleaned.cityNorm, '杭州');
  assert.equal(cleaned.namePinyin, 'wangxiaoming');
  assert.equal(cleaned.contact, 'new.member@example.com');
  assert.doesNotThrow(() => cleanProfile({ ...profile('李小明'), org: '', offer: '', want: '', hiring: '', message: '' }));
});

test('改密会增加令牌版本，状态重启后仍存在', async t => {
  const { options, store } = await makeStore(t, [{ displayName: '李四', username: 'lisi' }]);
  const user = store.findUserByUsername('lisi');
  const previousVersion = user.tokenVersion;
  await store.changePassword(user.id, 'lisi', 'a-new-password');
  assert.equal(user.passwordChanged, true);
  assert.equal(user.tokenVersion, previousVersion + 1);
  assert.equal(await store.authenticate('lisi', 'lisi'), null);
  assert.ok(await store.authenticate('lisi', 'a-new-password'));

  const restarted = await new AuthStore(options).init();
  assert.ok(await restarted.authenticate('lisi', 'a-new-password'));
  assert.equal(restarted.findUserByUsername('lisi').passwordChanged, true);
});

test('删除普通账号会同时清理关联资料，管理员账号不可删除', async t => {
  const { store } = await makeStore(t);
  const admin = await store.ensureAdmin({ username: 'admin', password: 'a-secure-admin-password' });
  const user = await store.createUser({ displayName: '测试删除', username: 'ceshishanchu' });
  store.state.profiles.push({ id: 'profile-delete', userId: user.id, name: user.displayName });
  store.state.registrationSubmissions.push({ id: 'registration-delete', userId: user.id, username: user.username });
  await store.save();

  const deleted = await store.deleteUser(user.id);
  assert.equal(deleted.id, user.id);
  assert.equal(store.findUserById(user.id), null);
  assert.equal(store.state.profiles.some(item => item.userId === user.id), false);
  assert.equal(store.state.registrationSubmissions.some(item => item.userId === user.id), false);
  await assert.rejects(store.deleteUser(admin.id), error => error.code === 'cannot_delete_admin');
});

test('本人更新资料会写入数据库并保留按月经历时间线', async t => {
  const { options, store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }]);
  store.now = () => Date.parse('2026-09-03T08:30:00.000Z');
  const user = store.findUserByUsername('zhangsan');
  const base = {
    id: 'a0001', name: '张三', edu: '浙江大学', cohort: '2020 届', status: '工作',
    industry: '金融', org: '量化机构', doing: '量化研究', city: '上海', want: '认识校友',
  };
  const updated = await store.updateOwnProfile(user.id, {
    ...base, industry: '人工智能', org: 'DSH', doing: '大模型产品', city: '杭州',
  }, base);
  assert.equal(updated.baseRecordId, 'a0001');
  assert.equal(updated.experiences.length, 2);
  assert.equal(updated.experiences[0].org, '量化机构');
  assert.equal(updated.experiences[0].isCurrent, false);
  assert.equal(updated.experiences[1].org, 'DSH');
  assert.equal(updated.experiences[1].recordedMonth, '2026-09');
  assert.equal(updated.experiences[1].isCurrent, true);

  const contactOnly = await store.updateOwnProfile(user.id, { ...updated, want: '行业交流' }, base);
  assert.equal(contactOnly.experiences.length, 2, '非经历字段修改不应制造重复时间线');
  assert.equal(contactOnly.want, '行业交流');

  const restarted = await new AuthStore(options).init();
  assert.equal(restarted.findProfileByUserId(user.id).experiences.length, 2);
  assert.equal(restarted.findProfileByUserId(user.id).org, 'DSH');
});

test('只能删除本人的过去经历，删除后保存资料也不会重新生成旧经历', async t => {
  const { options, store } = await makeStore(t, [
    { displayName: '张三', username: 'zhangsan' },
    { displayName: '李四', username: 'lisi' },
  ]);
  const user = store.findUserByUsername('zhangsan');
  const other = store.findUserByUsername('lisi');
  const base = { id: 'a0001', name: '张三', org: '旧机构', city: '北京' };
  const updated = await store.updateOwnProfile(user.id, { org: '新机构', city: '杭州' }, base);
  const pastId = updated.experiences[0].id;
  const currentId = updated.experiences[1].id;
  await assert.rejects(store.deleteOwnExperience(other.id, pastId), { status: 404 });
  await assert.rejects(store.deleteOwnExperience(user.id, currentId), { status: 400 });
  const deleted = await store.deleteOwnExperience(user.id, pastId);
  assert.deepEqual(deleted.experiences.map(item => item.id), [currentId]);
  await assert.rejects(store.deleteOwnExperience(user.id, pastId), { status: 404 });
  await store.updateOwnProfile(user.id, { want: '交流' }, base);
  const restarted = await new AuthStore(options).init();
  assert.deepEqual(restarted.findProfileByUserId(user.id).experiences.map(item => item.id), [currentId]);
});

test('校友基线写入状态存储并可在重启后恢复', async t => {
  const { options, store } = await makeStore(t);
  const source = [{
    id: 'a0001', name: '测试校友', cohort: '2020', city: '杭州',
    contact: 'member@example.com', experiences: [{ id: 'e1', city: '杭州' }],
  }];
  const meta = await store.replaceRosterRecords(source, {
    digest: 'test-digest', source: 'private-import.json',
  });
  assert.equal(meta.count, 1);
  assert.equal(meta.contactCount, 1);

  source[0].name = '被外部修改';
  const restarted = await new AuthStore(options).init();
  assert.equal(restarted.listRosterRecords()[0].name, '测试校友');
  assert.equal(restarted.state.rosterMeta.digest, 'test-digest');
});

test('题库种子只导入一次，后台修改不会被重启覆盖', async t => {
  const { dir, options, store } = await makeStore(t);
  const questionSeedPath = path.join(dir, 'question-seed.json');
  await fs.promises.writeFile(questionSeedPath, JSON.stringify({
    questions: [{
      id: 'feishu-test-1',
      prompt: '示例题目',
      options: ['正确', '错误'],
      correctIndex: 0,
      active: true,
    }],
  }));
  options.questionSeedPath = questionSeedPath;

  const seeded = await new AuthStore(options).init();
  assert.equal(seeded.listQuestions(true).length, 1);
  const question = seeded.listQuestions(true)[0];
  assert.equal(question.correctIndex, 0);
  await seeded.updateQuestion(question.id, { active: false });

  const restarted = await new AuthStore(options).init();
  assert.equal(restarted.listQuestions(true).length, 1);
  assert.equal(restarted.listQuestions(true)[0].active, false);
  assert.equal(store.listQuestions(true).length, 0);
});

test('题目答案不下发，连续答错五次锁定一小时且后台可解锁', async t => {
  const { options, store } = await makeStore(t);
  for (let i = 0; i < 5; i++) {
    await store.createQuestion({
      prompt: `内部题目 ${i + 1}`,
      options: ['A', 'B', 'C', 'D'],
      correctIndex: i % 4,
      active: true,
    });
  }
  const ip = '203.0.113.10';
  for (let attempt = 1; attempt <= MAX_REGISTRATION_FAILURES; attempt++) {
    const started = await store.beginRegistration({
      ip,
      profile: profile(),
    });
    assert.equal(started.questions.length, 3);
    assert.equal(Object.hasOwn(started.questions[0], 'correctIndex'), false);
    const answers = Object.fromEntries(started.questions.map(question => [question.id, -1]));
    const result = await store.submitRegistration({ ip, attemptId: started.attemptId, answers });
    assert.equal(result.passed, false);
    assert.equal(result.locked, attempt === MAX_REGISTRATION_FAILURES);
  }
  await assert.rejects(() => store.beginRegistration({
    ip,
    profile: profile(),
  }), /锁定/);
  const restarted = await new AuthStore(options).init();
  await assert.rejects(() => restarted.beginRegistration({
    ip: '203.0.113.99',
    profile: profile(),
  }), /锁定/, '换网络或重启都不能绕过该姓名的锁定');
  const lock = restarted.listRegistrationActivity().find(item => item.ip === ip);
  assert.equal(lock.attempts, MAX_REGISTRATION_FAILURES);
  assert.equal(lock.locked, true);
  assert.ok(lock.expiresAt);
  await restarted.unlockRegistration(lock.lockId);
  assert.equal(restarted.listRegistrationActivity().length, 0);
});

test('CloudBase 字段名合法，答错后持久化次数、换题，三题全对才开户', async t => {
  let saved = null;
  function validateKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.equal(key.includes('\u0000'), false, `数据库字段名不能包含 NUL: ${key}`);
      validateKeys(item);
    }
  }
  const database = { collection: () => ({ doc: () => ({
    get: async () => ({ data: saved ? [saved] : [] }),
    set: async next => { validateKeys(next); saved = structuredClone(next); },
  }) }) };
  database.runTransaction = callback => callback(database);
  const stateBackend = new CloudBaseStateBackend({ database });
  const { options, store } = await makeStore(t, [], { stateBackend, randomInt: () => 0 });
  for (let i = 0; i < 9; i++) {
    await store.createQuestion({ prompt: `持久化题 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  }
  const first = await store.beginRegistration({ ip: '203.0.113.50', profile: profile('王小明') });
  await store.save();
  const partial = Object.fromEntries(first.questions.map(q => [q.id, 0]));
  partial[first.questions[0].id] = null;
  const wrong = await store.submitRegistration({ ip: '203.0.113.50', attemptId: first.attemptId, answers: partial });
  assert.equal(wrong.passed, false);
  assert.equal(wrong.attemptsUsed, 1);
  assert.equal(store.findUserByDisplayName('王小明'), null);
  assert.equal(saved.state.registrationSubmissions[0].status, 'pending');

  const restarted = await new AuthStore(options).init();
  const second = await restarted.beginRegistration({ ip: '203.0.113.51', profile: profile('王小明') });
  assert.equal(second.attemptsUsed, 1);
  assert.equal(second.questions.some(q => first.questions.some(old => old.id === q.id)), false);
  const correct = Object.fromEntries(second.questions.map(q => [q.id, 0]));
  const passed = await restarted.submitRegistration({ ip: '203.0.113.51', attemptId: second.attemptId, answers: correct });
  assert.equal(passed.passed, true);
  assert.equal(passed.user.username, 'wangxiaoming');
  assert.ok(await restarted.authenticate('wangxiaoming', 'wangxiaoming'));
  assert.equal(Object.keys(saved.state.registrationAttempts).length, 0);
});

test('每轮从题库随机抽三题，重试时优先避开上一轮题目', async t => {
  const { store } = await makeStore(t, [], { randomInt: () => 0 });
  for (let i = 0; i < 18; i++) {
    await store.createQuestion({
      prompt: `随机题目 ${i + 1}`, options: ['正确', '错误'], correctIndex: 0, active: true,
    });
  }
  const ip = '203.0.113.55';
  const first = await store.beginRegistration({ ip, profile: profile('甲') });
  const wrong = Object.fromEntries(first.questions.map(question => [question.id, 1]));
  await store.submitRegistration({ ip, attemptId: first.attemptId, answers: wrong });
  const second = await store.beginRegistration({ ip, profile: profile('甲') });
  assert.equal(second.questions.length, 3);
  assert.equal(second.questions.some(question => first.questions.some(old => old.id === question.id)), false);
});

test('同一网络允许不同成员同时答题，同一成员不能重复开题或绕过锁定', async t => {
  const { store } = await makeStore(t);
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({ prompt: `绕过测试 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  }
  const ip = '203.0.113.30';
  const first = await store.beginRegistration({ ip, profile: profile('甲') });
  const neighbor = await store.beginRegistration({ ip, profile: profile('乙') });
  assert.equal(neighbor.questions.length, 3);
  await assert.rejects(() => store.beginRegistration({ ip, profile: profile('甲') }), /答题进行中/);
  const wrong = Object.fromEntries(first.questions.map(question => [question.id, -1]));
  for (let i = 0; i < MAX_REGISTRATION_FAILURES; i++) {
    const current = i === 0 ? first : await store.beginRegistration({ ip, profile: profile('甲') });
    const result = await store.submitRegistration({ ip, attemptId: current.attemptId, answers: wrong });
    assert.equal(result.locked, i === MAX_REGISTRATION_FAILURES - 1);
  }
  await assert.rejects(
    store.submitRegistration({ ip, attemptId: first.attemptId, answers: {} }),
    /答题已过期/,
  );
  await assert.rejects(() => store.beginRegistration({ ip, profile: profile('甲') }), /已锁定/);
});

test('答题会话过期后会被清理，锁定冷却后可重新注册', async t => {
  let clock = 1000;
  const { options } = await makeStore(t);
  options.now = () => clock;
  const store = await new AuthStore(options).init();
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({ prompt: `清理测试 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  }
  const started = await store.beginRegistration({ ip: '203.0.113.31', profile: profile('清理') });
  assert.equal(store.quizSessions.size, 1);
  clock += 15 * 60 * 1000 + 1;
  store.cleanupQuizSessions();
  assert.equal(store.quizSessions.size, 0);
  clock += 1;
  const ip = '203.0.113.32';
  for (let i = 0; i < MAX_REGISTRATION_FAILURES; i++) {
    const round = await store.beginRegistration({ ip, profile: profile('冷却') });
    const wrong = Object.fromEntries(round.questions.map(question => [question.id, -1]));
    await store.submitRegistration({ ip, attemptId: round.attemptId, answers: wrong });
  }
  await assert.rejects(() => store.beginRegistration({ ip, profile: profile('冷却') }), /已锁定/);
  clock += REGISTRATION_LOCK_TTL_MS + 1;
  const reopened = await store.beginRegistration({ ip, profile: profile('冷却') });
  assert.equal(reopened.attemptsUsed, 0);
});

test('未完成注册有持久化上限，过期且无人处理的记录会释放名额', async t => {
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const ttl = 16 * 60 * 1000;
  const { store } = await makeStore(t, [], {
    now: () => clock,
    maxPendingRegistrationSubmissions: 2,
    pendingRegistrationTtlMs: ttl,
  });
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({ prompt: `容量测试 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  }
  await store.beginRegistration({ ip: '203.0.113.40', profile: profile('甲') });
  await store.beginRegistration({ ip: '203.0.113.41', profile: profile('乙') });
  await assert.rejects(
    () => store.beginRegistration({ ip: '203.0.113.42', profile: profile('丙') }),
    error => error.code === 'registration_busy',
  );
  clock += ttl + 1;
  await assert.doesNotReject(() => store.beginRegistration({ ip: '203.0.113.42', profile: profile('丙') }));
  assert.equal(store.state.registrationSubmissions.length, 1);
});

test('登录限速表会清理过期记录并限制最大条目数', () => {
  let clock = 0;
  const limiter = new LoginLimiter({ now: () => clock, maxEntries: 2, cleanupIntervalMs: 1 });
  limiter.fail('ip-1', 'one');
  limiter.fail('ip-2', 'two');
  limiter.fail('ip-3', 'three');
  assert.ok(limiter.entries.size <= 2);
  clock += 15 * 60 * 1000 + 1;
  limiter.check('ip-3', 'three');
  assert.equal(limiter.entries.size, 0);
});

test('三题全部答对后自动创建拼音账号，账号和题库都持久化', async t => {
  const { options, store } = await makeStore(t);
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({
      prompt: `题目 ${i + 1}`,
      options: ['错误', '正确'],
      correctIndex: 1,
      active: true,
    });
  }
  const ip = '203.0.113.11';
  const started = await store.beginRegistration({
    ip,
    profile: profile('王小明'),
  });
  const answers = Object.fromEntries(started.questions.map(question => [question.id, 1]));
  const result = await store.submitRegistration({ ip, attemptId: started.attemptId, answers });
  assert.equal(result.passed, true);
  assert.equal(result.user.username, 'wangxiaoming');
  assert.equal(store.listProfiles().length, 1);
  assert.equal(store.listProfiles()[0].industry, '人工智能');
  assert.ok(await store.authenticate('wangxiaoming', 'wangxiaoming'));

  const restarted = await new AuthStore(options).init();
  assert.ok(await restarted.authenticate('wangxiaoming', 'wangxiaoming'));
  assert.equal(restarted.listQuestions(true).length, 3);
  assert.equal(restarted.listProfiles().length, 1);
});

test('自助注册遇到拼音账号冲突时转人工处理，不自动加数字', async t => {
  const { store } = await makeStore(t, [{ displayName: '王晓明', username: 'wangxiaoming' }]);
  for (let i = 0; i < 3; i++) {
    await store.createQuestion({
      prompt: `冲突测试 ${i + 1}`, options: ['正确', '错误'], correctIndex: 0, active: true,
    });
  }
  const started = await store.beginRegistration({
    ip: '203.0.113.15', profile: profile('王小明'),
  });
  const answers = Object.fromEntries(started.questions.map(question => [question.id, 0]));
  await assert.rejects(
    store.submitRegistration({ ip: '203.0.113.15', attemptId: started.attemptId, answers }),
    /拼音与现有账号冲突/,
  );
  assert.equal(store.findUserByUsername('wangxiaoming2'), null);
});

test('空题库不开放注册，已有姓名不能重复认领', async t => {
  const { store } = await makeStore(t, [{ displayName: '已有成员', username: 'yiyouchengyuan' }]);
  await assert.rejects(() => store.beginRegistration({
    ip: '203.0.113.12', profile: profile(),
  }), /题库维护中/);
  await assert.rejects(() => store.beginRegistration({
    ip: '203.0.113.12', profile: profile('已有成员'),
  }), /已经有账号/);
});

test('登录占用在重启后仍有效，释放后旧设备不能再修改资料', async t => {
  let clock = Date.parse('2026-09-29T00:00:00Z');
  const { options, store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }], { now: () => clock });
  const account = store.findUserByUsername('zhangsan');
  const first = await store.claimSession(account.id, 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000);
  const sessionId = first.user.activeSession.id;
  const restarted = await new AuthStore(options).init();
  assert.equal(restarted.findUserByUsername('zhangsan').activeSession.id, sessionId);
  await assert.rejects(restarted.claimSession(account.id, 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000), error => error.code === 'account_in_use');
  await restarted.releaseSession(account.id, sessionId);
  await assert.rejects(restarted.updateOwnProfile(account.id, { city: '上海' }, {}, sessionId), error => error.code === 'session_expired');
  assert.equal(restarted.listProfiles().length, 0);
  clock += 60 * 60 * 1000;
  assert.ok((await restarted.claimSession(account.id, 30 * 24 * 60 * 60 * 1000, 60 * 60 * 1000)).user.activeSession);
});

test('开户失败不发布账号，管理员操作失败不污染下一次成功保存', async t => {
  const { store } = await makeStore(t);
  for (let i = 0; i < 3; i++) await store.createQuestion({ prompt: `一致性 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  const started = await store.beginRegistration({ ip: '203.0.113.70', profile: profile('一致') });
  const before = structuredClone(store.state);
  const persist = store.persistSnapshot.bind(store);
  store.persistSnapshot = async () => { throw new Error('database offline'); };
  await assert.rejects(store.submitRegistration({ ip: '203.0.113.70', attemptId: started.attemptId, answers: Object.fromEntries(started.questions.map(q => [q.id, 0])) }), /无法保存/);
  assert.deepEqual(store.state, before);
  assert.ok(store.quizSessions.has(started.attemptId), '失败的答题提交仍可重试');
  await assert.rejects(store.createQuestion({ prompt: '不能偷偷保存', options: ['A', 'B'], correctIndex: 0 }), /无法保存/);
  assert.deepEqual(store.state, before);
  store.persistSnapshot = persist;
  const passed = await store.submitRegistration({ ip: '203.0.113.70', attemptId: started.attemptId, answers: Object.fromEntries(started.questions.map(q => [q.id, 0])) });
  assert.equal(passed.passed, true);
  const saved = JSON.parse(await fs.promises.readFile(store.statePath, 'utf8'));
  assert.equal(saved.users.length, 1);
  assert.equal(saved.questions.length, 3);
});

test('不同中文姓名但相同拼音的并行注册只能开户一次', async t => {
  const { store } = await makeStore(t);
  for (let i = 0; i < 3; i++) await store.createQuestion({ prompt: `重名 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  const a = await store.beginRegistration({ ip: '203.0.113.71', profile: profile('王明') });
  const b = await store.beginRegistration({ ip: '203.0.113.72', profile: profile('汪明') });
  const results = await Promise.allSettled([a, b].map((r, i) => store.submitRegistration({ ip: `203.0.113.${71 + i}`, attemptId: r.attemptId, answers: Object.fromEntries(r.questions.map(q => [q.id, 0])) })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected')[0].reason.code, 'username_conflict');
  assert.equal(store.state.users.filter(u => u.username === 'wangming').length, 1);
  assert.equal(store.state.profiles.length, 1);
});

test('保存资料与新用户开户并行时，双方的资料都保留下来', async t => {
  const { store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }]);
  for (let i = 0; i < 3; i++) await store.createQuestion({ prompt: `并行 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  const r = await store.beginRegistration({ ip: '203.0.113.73', profile: profile('李四') });
  const member = store.findUserByUsername('zhangsan');
  await Promise.all([
    store.updateOwnProfile(member.id, { city: '上海' }),
    store.submitRegistration({ ip: '203.0.113.73', attemptId: r.attemptId, answers: Object.fromEntries(r.questions.map(q => [q.id, 0])) }),
  ]);
  assert.equal(store.state.profiles.length, 2);
  assert.equal(store.state.profiles.find(p => p.userId === member.id).city, '上海');
  assert.ok(store.state.profiles.find(p => p.name === '李四'));
  const newcomer = store.findUserByUsername('lisi');
  await Promise.all([store.updateOwnProfile(member.id, { city: '北京' }), store.deleteUser(newcomer.id)]);
  assert.equal(store.state.profiles.length, 1, '后台删除的资料不得被另一个保存操作复活');
});

test('自动锁定备注不会永久占用注册容量，人工审核记录仍保留', async t => {
  let clock = Date.parse('2026-09-01T00:00:00Z');
  const { store } = await makeStore(t, [], { now: () => clock, maxPendingRegistrationSubmissions: 1, pendingRegistrationTtlMs: 16 * 60 * 1000 });
  for (let i = 0; i < 3; i++) await store.createQuestion({ prompt: `清理 ${i}`, options: ['A', 'B'], correctIndex: 0, active: true });
  for (let i = 0; i < 5; i++) {
    const r = await store.beginRegistration({ ip: '203.0.113.74', profile: profile('锁定') });
    await store.submitRegistration({ ip: '203.0.113.74', attemptId: r.attemptId, answers: Object.fromEntries(r.questions.map(q => [q.id, 1])) });
  }
  assert.ok(store.state.registrationSubmissions[0].reviewerNote);
  clock += REGISTRATION_LOCK_TTL_MS + 1;
  await store.beginRegistration({ ip: '203.0.113.75', profile: profile('后来') });
  assert.deepEqual(store.state.registrationSubmissions.map(s => s.profile.name), ['后来']);
});

test('经历达到上限后只拒绝新增历史，不丢失现有资料，删除旧经历后可继续', async t => {
  const { store } = await makeStore(t, [{ displayName: '张三', username: 'zhangsan' }]);
  const user = store.findUserByUsername('zhangsan');
  for (let i = 0; i < 20; i++) await store.updateOwnProfile(user.id, { org: `机构 ${i}` });
  const before = structuredClone(store.state.profiles);
  await assert.rejects(store.updateOwnProfile(user.id, { org: '多出来的机构' }), /20 条/);
  assert.deepEqual(store.state.profiles, before);
  await store.updateOwnProfile(user.id, { message: '仍然可以修改寄语' });
  const old = store.state.profiles[0].experiences.find(e => e.isCurrent === false);
  await store.deleteOwnExperience(user.id, old.id);
  await store.updateOwnProfile(user.id, { org: '多出来的机构' });
  assert.equal(store.state.profiles[0].experiences.length, 20);
});
