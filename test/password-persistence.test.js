'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AuthStore } = require('../lib/auth');
const clone = value => JSON.parse(JSON.stringify(value));

async function setup() {
  let saved = null;
  let fail = false;
  const backend = {
    async load() { return clone(saved); },
    async save(state) {
      if (fail) throw new Error('database unavailable');
      saved = clone(state);
    },
  };
  const options = { stateBackend: backend, scryptCost: 1024 };
  const store = await new AuthStore(options).init();
  const user = await store.createUser({ displayName: '改密测试', username: 'passwordtest' });
  return { store, user, backend, options, fail(value) { fail = value; } };
}

test('改密写入失败不改变密码和会话版本，恢复后可重试且重载后新密码有效', async () => {
  const ctx = await setup();
  const before = clone(ctx.user);
  ctx.fail(true);
  await assert.rejects(ctx.store.changePassword(ctx.user.id, 'passwordtest', 'new-password-123'), { status: 503 });
  assert.deepEqual(ctx.user, before);
  assert.ok(await ctx.store.authenticate('passwordtest', 'passwordtest'));
  assert.equal(await ctx.store.authenticate('passwordtest', 'new-password-123'), null);
  assert.deepEqual((await ctx.backend.load()).users[0], before);
  ctx.fail(false);
  await ctx.store.changePassword(ctx.user.id, 'passwordtest', 'new-password-123');
  const restarted = await new AuthStore(ctx.options).init();
  assert.equal(await restarted.authenticate('passwordtest', 'passwordtest'), null);
  assert.ok(await restarted.authenticate('passwordtest', 'new-password-123'));
  assert.equal(restarted.findUserById(ctx.user.id).tokenVersion, before.tokenVersion + 1);
});

test('后台重置失败不影响当前密码或登录状态，后续重置可成功', async () => {
  const ctx = await setup();
  await ctx.store.changePassword(ctx.user.id, 'passwordtest', 'changed-password');
  const before = clone(ctx.user);
  ctx.fail(true);
  await assert.rejects(ctx.store.updateUser(ctx.user.id, { resetPassword: true }), { status: 503 });
  assert.deepEqual(ctx.user, before);
  ctx.fail(false);
  await ctx.store.updateUser(ctx.user.id, { resetPassword: true });
  assert.ok(await ctx.store.authenticate('passwordtest', 'passwordtest'));
  assert.equal(await ctx.store.authenticate('passwordtest', 'changed-password'), null);
});

test('改密等待数据库时仍使用原密码，后续普通保存不会覆盖新密码', async () => {
  const ctx = await setup();
  const originalSave = ctx.backend.save;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  ctx.backend.save = async state => { entered(); await blocked; return originalSave(state); };
  const changed = ctx.store.changePassword(ctx.user.id, 'passwordtest', 'new-password-123');
  await started;
  assert.ok(await ctx.store.authenticate('passwordtest', 'passwordtest'));
  assert.equal(await ctx.store.authenticate('passwordtest', 'new-password-123'), null);
  ctx.store.state.rosterReview.pending.push({ displayName: '并发更新' });
  const queuedSave = ctx.store.save();
  release();
  await Promise.all([changed, queuedSave]);
  const restarted = await new AuthStore(ctx.options).init();
  assert.ok(await restarted.authenticate('passwordtest', 'new-password-123'));
  assert.equal(restarted.state.rosterReview.pending.length, 1);
});

test('同一旧密码同时改密只成功一次，不允许后一个请求覆盖已生效的密码', async () => {
  const ctx = await setup();
  const results = await Promise.allSettled([
    ctx.store.changePassword(ctx.user.id, 'passwordtest', 'first-password'),
    ctx.store.changePassword(ctx.user.id, 'passwordtest', 'second-password'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(await ctx.store.authenticate('passwordtest', 'first-password'));
  assert.equal(await ctx.store.authenticate('passwordtest', 'second-password'), null);
});

test('全空格密码被拒绝，带空格的有效密码原样保存', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.store.changePassword(ctx.user.id, 'passwordtest', '        '), /不能全部为空格/);
  await ctx.store.changePassword(ctx.user.id, 'passwordtest', ' pass word 123 ');
  assert.ok(await ctx.store.authenticate('passwordtest', ' pass word 123 '));
  assert.equal(await ctx.store.authenticate('passwordtest', 'pass word 123'), null);
});

test('普通保存失败不会使后续改密永久失败', async () => {
  const ctx = await setup();
  ctx.fail(true);
  await assert.rejects(ctx.store.save(), /database unavailable/);
  ctx.fail(false);
  await ctx.store.changePassword(ctx.user.id, 'passwordtest', 'recovered-password');
  assert.ok(await ctx.store.authenticate('passwordtest', 'recovered-password'));
});

test('不合要求的新密码在任何数据库写入之前被拒绝', async () => {
  const ctx = await setup();
  const before = await ctx.backend.load();
  let writes = 0;
  ctx.backend.save = async () => { writes += 1; };
  for (const password of ['', '        ', 'short', 'a'.repeat(129), 'passwordtest', 'PASSWORDTEST']) {
    await assert.rejects(ctx.store.changePassword(ctx.user.id, 'passwordtest', password));
    assert.equal(writes, 0);
    assert.deepEqual(await ctx.backend.load(), before);
    assert.deepEqual(ctx.store.state, before);
  }
});
