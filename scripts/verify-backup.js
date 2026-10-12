'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeBackup, digest } = require('../lib/backups');

// Rehearse restoration in a private temporary directory. Never writes to DB.
const file = process.argv[2];
try {
  const bytes = fs.readFileSync(file);
  const payload = decodeBackup(bytes, process.env.ALUMNI_BACKUP_KEY);
  const states = payload.format === 'alumni-full-v1' ? payload.states : payload.documentId === 'full' ? payload.state : { [payload.documentId]: payload.state };
  if (!states?.primary || states.primary.version !== 1 || !Array.isArray(states.primary.users) || !Array.isArray(states.primary.profiles)) throw new Error('备份缺少账号或资料数据');
  for (const [field, identity] of [['users', 'id'], ['users', 'username'], ['profiles', 'id']]) {
    const values = states.primary[field].map(row => row[identity]);
    if (new Set(values).size !== values.length) throw new Error(`备份包含重复的 ${field}.${identity}`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-restore-')); fs.chmodSync(directory, 0o700);
  try {
    for (const [document, state] of Object.entries(states)) {
      if (!['primary', 'analytics'].includes(document)) throw new Error('备份包含未知数据表');
      const target = path.join(directory, document + '.json');
      fs.writeFileSync(target, JSON.stringify(state), { mode: 0o600 });
      if (digest(fs.readFileSync(target)) !== digest(JSON.stringify(state))) throw new Error('恢复文件校验失败');
    }
    console.log(JSON.stringify({ verified: true, sha256: digest(bytes), accounts: states.primary.users.length, profiles: states.primary.profiles.length, analytics: !!states.analytics }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} catch (error) { console.error('恢复校验失败：' + error.message); process.exitCode = 1; }
