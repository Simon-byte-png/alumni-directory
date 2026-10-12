'use strict';
// Read-only export. Run using the production environment, never pasted keys.
const path = require('path');
const { CloudBaseStateBackend } = require('../lib/state-backends');
const { CloudFileBackups, encodeBackup, decodeBackup, writeBackupFile, filename, digest } = require('../lib/backups');

async function main() {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) throw new Error('请提供私有备份目录的绝对路径');
  const primary = new CloudBaseStateBackend({ backups: false });
  const analytics = new CloudBaseStateBackend({ documentId: 'analytics', backups: false });
  const states = { primary: await primary.load(), analytics: await analytics.load() };
  if (!states.primary || states.primary.version !== 1 || !Array.isArray(states.primary.users)) throw new Error('正式账号数据读取不完整，拒绝生成空备份');
  if (!states.analytics || !states.analytics.daily) throw new Error('访问统计读取不完整，拒绝生成空备份');
  const payload = { format: 'alumni-full-v1', createdAt: new Date().toISOString(), envId: primary.envId, collectionName: primary.collectionName, states };
  const bytes = encodeBackup(payload, process.env.ALUMNI_BACKUP_KEY);
  const file = await writeBackupFile(directory, filename('full', 'alumni-backup'), bytes);
  decodeBackup(bytes, process.env.ALUMNI_BACKUP_KEY);
  const cloud = new CloudFileBackups({ getApp: () => primary.getApp(), key: process.env.ALUMNI_BACKUP_KEY });
  const remote = await cloud.save('full', states, { envId: primary.envId, collectionName: primary.collectionName });
  const manifest = { file, sha256: digest(bytes), remote, counts: { accounts: states.primary.users.length, profiles: states.primary.profiles.length, roster: states.primary.rosterRecords.length } };
  await writeBackupFile(directory, path.basename(file) + '.manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  console.log(JSON.stringify(manifest));
}
main().catch(error => { console.error('备份失败：' + error.message); process.exitCode = 1; });
