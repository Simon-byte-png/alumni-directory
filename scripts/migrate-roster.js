'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AuthStore, cleanName } = require('../lib/auth');
const { cloudBaseBackendFromEnv } = require('../lib/state-backends');

function digestRecords(records) {
  const normalized = records.map(record => ({
    ...record,
    experiences: Array.isArray(record.experiences) ? record.experiences : [],
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function readRoster(sourcePath) {
  const input = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const records = Array.isArray(input) ? input : input.records;
  if (!Array.isArray(records) || !records.length) throw new Error('迁移文件中没有校友记录');
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`第 ${index + 1} 条校友记录格式不正确`);
    }
    if (!cleanName(record.name)) throw new Error(`第 ${index + 1} 条校友记录缺少姓名`);
  });
  return JSON.parse(JSON.stringify(records));
}

function readPendingReview(sourcePath) {
  if (!fs.existsSync(sourcePath)) return [];
  const input = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const pending = Array.isArray(input) ? input : input.pending;
  if (!Array.isArray(pending)) throw new Error('待核对名单格式不正确');
  return JSON.parse(JSON.stringify(pending));
}

function hasCloudCredential(env = process.env) {
  return !!(
    env.CLOUDBASE_APIKEY
    || (env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY)
    || env.TENCENTCLOUD_RUNENV
    || env.TENCENTCLOUD === 'true'
  );
}

async function migrateRoster(options) {
  const { store, records, source, replace = false, verifyBackend = null } = options;
  const digest = digestRecords(records);
  const existing = store.listRosterRecords();
  if (existing.length) {
    const existingDigest = digestRecords(existing);
    if (existingDigest === digest) {
      return {
        changed: false,
        count: existing.length,
        contactCount: existing.filter(record => cleanName(record.contact)).length,
        digest,
      };
    }
    if (!replace) throw new Error('目标已有不同的校友基线；核对无误后加 --replace 才会覆盖');
  }

  const meta = await store.replaceRosterRecords(records, { digest, source });
  if (verifyBackend) {
    const saved = await verifyBackend.load();
    const savedRecords = saved && Array.isArray(saved.rosterRecords) ? saved.rosterRecords : [];
    if (savedRecords.length !== records.length || digestRecords(savedRecords) !== digest) {
      throw new Error('写入后回读校验失败，目标数据与源文件不一致');
    }
  }
  return { changed: true, ...meta, digest };
}

async function main() {
  const rootDir = path.join(__dirname, '..');
  const driver = String(process.env.ALUMNI_STORAGE_DRIVER || 'json');
  if (!['json', 'cloudbase'].includes(driver)) throw new Error('ALUMNI_STORAGE_DRIVER 只支持 json 或 cloudbase');

  const sourcePath = path.resolve(
    process.env.ALUMNI_ROSTER_PATH || path.join(rootDir, 'data', 'runtime', 'alumni-import.json'),
  );
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`找不到迁移文件：${sourcePath}\n请先把真实名单放入 data/runtime/alumni-import.json，或设置 ALUMNI_ROSTER_PATH`);
  }
  if (driver === 'cloudbase') {
    if (!process.env.CLOUDBASE_ENV_ID) throw new Error('迁移到 CloudBase 必须明确设置 CLOUDBASE_ENV_ID');
    if (!hasCloudCredential()) {
      throw new Error('本机没有 CloudBase 写入凭据；请设置 CLOUDBASE_APIKEY，或使用腾讯云临时密钥环境变量');
    }
  }

  const records = readRoster(sourcePath);
  const count = records.length;
  const contactCount = records.filter(record => cleanName(record.contact)).length;
  const digest = digestRecords(records);
  console.log(`迁移源已核对：${count} 条记录，其中 ${contactCount} 条含联系方式，SHA-256 ${digest}`);

  if (process.argv.includes('--dry-run')) {
    console.log('仅检查，未写入目标存储。');
    return;
  }

  const stateDir = process.env.ALUMNI_STATE_DIR || path.join(rootDir, 'data', 'runtime');
  const stateBackend = driver === 'cloudbase' ? cloudBaseBackendFromEnv() : null;
  const accountSeedPath = process.env.ALUMNI_ACCOUNT_SEED_PATH || path.join(stateDir, 'account-seed.json');
  const questionSeedPath = process.env.ALUMNI_QUESTION_SEED_PATH || path.join(stateDir, 'question-seed.json');
  const reviewPath = process.env.ALUMNI_ROSTER_REVIEW_PATH || path.join(stateDir, 'pending-account-review.json');
  const store = await new AuthStore({
    statePath: path.join(stateDir, 'auth-state.json'),
    stateBackend,
    seedPath: accountSeedPath,
    questionSeedPath,
  }).init();
  const result = await migrateRoster({
    store,
    records,
    source: path.basename(sourcePath),
    replace: process.argv.includes('--replace'),
    verifyBackend: stateBackend,
  });
  const pendingReview = readPendingReview(reviewPath);
  await store.replaceRosterReview(pendingReview);
  if (stateBackend) {
    const saved = await stateBackend.load();
    const savedPending = saved && saved.rosterReview && Array.isArray(saved.rosterReview.pending)
      ? saved.rosterReview.pending
      : [];
    if (savedPending.length !== pendingReview.length) throw new Error('待核对名单写入后回读校验失败');
  }
  console.log(result.changed
    ? `迁移完成并回读校验通过：${result.count} 条记录，${pendingReview.length} 条待核对。`
    : `目标中已有相同校友基线：${result.count} 条记录；待核对名单已同步 ${pendingReview.length} 条。`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { digestRecords, hasCloudCredential, migrateRoster, readPendingReview, readRoster };
