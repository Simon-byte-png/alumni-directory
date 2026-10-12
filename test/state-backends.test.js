'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CloudBaseStateBackend } = require('../lib/state-backends');

function fakeDatabase() {
  let value = null;
  return {
    async runTransaction(callback) { return callback(this); },
    collection(name) {
      assert.equal(name, 'alumni_runtime');
      return {
        doc(id) {
          assert.equal(id, 'primary');
          return {
            async get() { return { data: value ? [value] : [] }; },
            async set(next) { value = JSON.parse(JSON.stringify(next)); },
          };
        },
      };
    },
  };
}

test('CloudBase 状态后端可保存并恢复完整运行时状态', async () => {
  const backend = new CloudBaseStateBackend({ database: fakeDatabase() });
  assert.equal(await backend.load(), null);
  const state = { version: 1, users: [{ username: 'zhangsan' }], profiles: [{ name: '张三' }] };
  await backend.save(state);
  state.users[0].username = 'changed-locally';
  const loaded = await backend.load();
  assert.equal(loaded.users[0].username, 'zhangsan');
  assert.equal(loaded.profiles[0].name, '张三');
});

test('云端已写入但响应丢失时，通过回读确认保存成功', async () => {
  let saved;
  const backend = new CloudBaseStateBackend({ database: {
    async runTransaction(callback) { return callback(this); },
    collection: () => ({ doc: () => ({
      set: async value => { saved = value; throw new Error('response lost'); },
      get: async () => ({ data: saved ? [saved] : [] }),
    }) }),
  } });
  const state = { users: [{ username: 'test', passwordHash: 'new-hash' }] };
  await backend.save(state);
  assert.deepEqual(await backend.load(), state);
});

test('云端未保存新状态时不能把写入失败当成成功', async () => {
  const backend = new CloudBaseStateBackend({ database: {
    async runTransaction(callback) { return callback(this); },
    collection: () => ({ doc: () => ({
      set: async () => { throw new Error('write failed'); },
      get: async () => ({ data: [{ state: { users: [] } }] }),
    }) }),
  } });
  await backend.load();
  await assert.rejects(backend.save({ users: [{ username: 'test' }] }), /write failed/);
});

test('两个独立实例读取同一版本后，后写者不能覆盖已经提交的新密码', async () => {
  const database = fakeDatabase();
  const first = new CloudBaseStateBackend({ database });
  const second = new CloudBaseStateBackend({ database });
  await first.load();
  await first.save({ users: [{ passwordHash: 'old' }] });
  await first.load();
  await second.load();
  await first.save({ users: [{ passwordHash: 'new' }] });
  await assert.rejects(second.save({ users: [{ passwordHash: 'stale' }] }), error => error.code === 'state_conflict');
  assert.equal((await second.load()).users[0].passwordHash, 'new');
  await second.save({ users: [{ passwordHash: 'latest' }] });
  assert.equal((await first.load()).users[0].passwordHash, 'latest');
});
