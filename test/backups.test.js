'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CloudFileBackups, encodeBackup, decodeBackup, backupLocalState, writeBackupFile } = require('../lib/backups');
const { CloudBaseStateBackend } = require('../lib/state-backends');
const { createDrafts } = require('../public/drafts');
const key = crypto.randomBytes(32).toString('hex');

test('备份完整加密，错误密钥、篡改和不完整文件均不能恢复', () => {
  const payload = { state: { users: [{ passwordHash: 'private-hash' }], profiles: [{ message: '完整寄语' }] } };
  const bytes = encodeBackup(payload, key);
  assert.equal(bytes.includes('private-hash'), false);
  assert.deepEqual(decodeBackup(bytes, key), payload);
  assert.throws(() => decodeBackup(bytes, crypto.randomBytes(32).toString('hex')));
  const tampered = JSON.parse(bytes); tampered.data = 'AAAA' + tampered.data.slice(4);
  assert.throws(() => decodeBackup(Buffer.from(JSON.stringify(tampered)), key));
  assert.throws(() => decodeBackup(bytes.subarray(0, bytes.length - 20), key));
});

test('每次备份生成独立文件，拒绝覆盖旧文件，文件仅拥有者可读', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-backup-test-'));
  try {
    const statePath = path.join(directory, 'state.json');
    const first = await backupLocalState(statePath, { name: '旧资料' });
    const second = await backupLocalState(statePath, { name: '新资料' });
    assert.notEqual(first, second);
    assert.equal(JSON.parse(fs.readFileSync(first)).state.name, '旧资料');
    assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    await assert.rejects(writeBackupFile(path.dirname(first), path.basename(first), Buffer.from('覆盖')), error => error.code === 'EEXIST');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('云备份保存后回读并解密验证，服务端返回错误不能当作成功', async () => {
  const files = new Map();
  const backup = new CloudFileBackups({ key, getApp: async () => ({
    uploadFile: async ({ cloudPath, fileContent }) => { assert.equal(files.has(cloudPath), false); files.set(cloudPath, fileContent); return { fileID: cloudPath }; },
    downloadFile: async ({ fileID }) => ({ fileContent: files.get(fileID) }),
  }) });
  await backup.save('primary', { message: 'one' });
  await backup.save('primary', { message: 'two' });
  assert.equal(files.size, 2);
  const bad = new CloudFileBackups({ key, getApp: async () => ({ uploadFile: async () => ({ code: 'FAILED' }) }) });
  await assert.rejects(bad.save('primary', {}), /上传未确认/);
  const truncated = new CloudFileBackups({ key, getApp: async () => ({ uploadFile: async () => ({ fileID: 'test' }), downloadFile: async () => ({ fileContent: Buffer.from('{}') }) }) });
  await assert.rejects(truncated.save('primary', {}));
});

test('备份失败不推进版本检查点，旧内存不能覆盖已提交的新资料', async () => {
  let state = { version: 1, profiles: [{ message: 'old' }] };
  const files = [];
  let fail = false;
  const database = {
    runTransaction: async callback => callback(database),
    collection: () => ({ doc: () => ({ get: async () => ({ data: [{ state }] }), set: async value => { state = value.state; } }) }),
  };
  const backend = new CloudBaseStateBackend({ database, backups: { save: async (_, snapshot) => {
    if (fail && snapshot.profiles[0].message === 'new') throw new Error('storage down');
    files.push(structuredClone(snapshot));
  } } });
  await backend.load(); fail = true;
  await assert.rejects(backend.save({ version: 1, profiles: [{ message: 'new' }] }), e => e.code === 'backup_unconfirmed');
  assert.equal(state.profiles[0].message, 'new');
  assert.equal(backend.expectedState.profiles[0].message, 'old');
  assert.equal(files[0].profiles[0].message, 'old');
  await assert.rejects(backend.save({ version: 1, profiles: [{ message: 'stale' }] }), e => e.code === 'state_conflict');
  assert.equal(state.profiles[0].message, 'new');
  await backend.load(); fail = false;
  await backend.save({ version: 1, profiles: [{ message: 'latest' }] });
  assert.ok(files.some(file => file.profiles[0].message === 'new'));
  assert.equal(files.at(-1).profiles[0].message, 'latest');
});

test('提交前旧版本备份失败时，数据库完全不修改', async () => {
  let writes = 0;
  const database = { runTransaction: async callback => callback(database), collection: () => ({ doc: () => ({ get: async () => ({ data: [{ state: { version: 1 } }] }), set: async () => { writes++; } }) }) };
  const backend = new CloudBaseStateBackend({ database, backups: { save: async () => { throw new Error('backup unavailable'); } } });
  await backend.load();
  await assert.rejects(backend.save({ version: 2 }), /backup unavailable/);
  assert.equal(writes, 0);
});

test('草稿按账号隔离，只保留资料字段，不保存密码或登录令牌', () => {
  const storage = new Map();
  const drafts = createDrafts({ setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key), removeItem: key => storage.delete(key) });
  drafts.save('profile:first', { message: '填了一半', password: 'secret', token: 'secret', name: '张三' });
  assert.equal(drafts.load('profile:second'), null);
  assert.deepEqual(drafts.load('profile:first').data, { name: '张三', message: '填了一半' });
  drafts.clear('profile:first'); assert.equal(drafts.load('profile:first'), null);
  assert.equal(createDrafts({ setItem() { throw new Error('quota'); } }).save('first', {}), false);
});
