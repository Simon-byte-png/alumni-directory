'use strict';

const path = require('path');
const { AuthStore } = require('../lib/auth');
const { cloudBaseBackendFromEnv } = require('../lib/state-backends');

async function main() {
  const password = String(process.env.ALUMNI_ADMIN_PASSWORD || '');
  const username = String(process.env.ALUMNI_ADMIN_USERNAME || 'admin');
  const displayName = String(process.env.ALUMNI_ADMIN_NAME || '管理员');
  if (password.length < 12) {
    throw new Error('请通过 ALUMNI_ADMIN_PASSWORD 提供至少 12 位的管理员密码');
  }
  const rootDir = path.join(__dirname, '..');
  const stateDir = process.env.ALUMNI_STATE_DIR || path.join(rootDir, 'data', 'runtime');
  const stateBackend = process.env.ALUMNI_STORAGE_DRIVER === 'cloudbase' ? cloudBaseBackendFromEnv() : null;
  const store = await new AuthStore({
    statePath: path.join(stateDir, 'auth-state.json'),
    stateBackend,
    seedPath: process.env.ALUMNI_ACCOUNT_SEED_PATH || path.join(stateDir, 'account-seed.json'),
    questionSeedPath: process.env.ALUMNI_QUESTION_SEED_PATH || path.join(stateDir, 'question-seed.json'),
  }).init();
  if (store.findUserByUsername(username)) throw new Error('管理员账号已存在，请换一个账号名');
  const admin = await store.createUser({
    displayName,
    username,
    password,
    role: 'admin',
    allowSuffix: false,
    source: 'create-admin-script',
  });
  console.log(`管理员已创建：${admin.username}`);
  console.log('密码未写入日志或 Git，请妥善保存。');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
