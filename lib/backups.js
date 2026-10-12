'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function backupKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) throw new Error('备份密钥必须是 32 字节的十六进制字符串');
  return Buffer.from(value, 'hex');
}

function encodeBackup(payload, keyValue) {
  const key = backupKey(keyValue);
  const body = Buffer.from(JSON.stringify(payload));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('alumni-backup-v1'));
  const ciphertext = Buffer.concat([cipher.update(zlib.gzipSync(body)), cipher.final()]);
  return Buffer.from(JSON.stringify({
    format: 'alumni-backup-v1', keyId: digest(key).slice(0, 16),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    sha256: digest(body), data: ciphertext.toString('base64'),
  }) + '\n');
}

function decodeBackup(bytes, keyValue) {
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (envelope.format !== 'alumni-backup-v1') throw new Error('不支持的备份格式');
  const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey(keyValue), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from('alumni-backup-v1'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const body = zlib.gunzipSync(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]), { maxOutputLength: 64 * 1024 * 1024 });
  if (digest(body) !== envelope.sha256) throw new Error('备份完整性校验失败');
  return JSON.parse(body.toString('utf8'));
}

function filename(label, extension) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('备份名称格式不正确');
  return `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.${extension}`;
}

// Append-only: never rename over, truncate, or clean up any previous backup.
async function writeBackupFile(directory, name, bytes) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, name);
  const file = await fs.promises.open(target, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  if (!Buffer.from(await fs.promises.readFile(target)).equals(bytes)) throw new Error('本地备份回读校验失败');
  return target;
}

async function backupLocalState(statePath, snapshot) {
  const bytes = Buffer.from(JSON.stringify({ format: 'alumni-state-v1', createdAt: new Date().toISOString(), state: snapshot }) + '\n');
  return writeBackupFile(path.join(path.dirname(statePath), 'backups'), filename(path.basename(statePath).replace(/[^a-zA-Z0-9_-]/g, '-'), 'json'), bytes);
}

class CloudFileBackups {
  constructor({ getApp, key, prefix = 'alumni-backups', localDirectory = '' }) {
    backupKey(key);
    if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('备份目录格式不正确');
    Object.assign(this, { getApp, key, prefix, localDirectory });
  }

  async save(documentId, state, metadata = {}) {
    const createdAt = new Date().toISOString();
    const name = filename(documentId, 'alumni-backup');
    const payload = { format: 'alumni-state-v1', createdAt, documentId, ...metadata, state };
    const bytes = encodeBackup(payload, this.key);
    const cloudPath = `${this.prefix}/${documentId}/${createdAt.slice(0, 10)}/${name}`;
    const app = await this.getApp();
    const uploaded = await app.uploadFile({ cloudPath, fileContent: bytes });
    if (!uploaded?.fileID || uploaded.code) throw new Error('云备份上传未确认');
    const downloaded = await app.downloadFile({ fileID: uploaded.fileID });
    if (!downloaded?.fileContent || downloaded.code) throw new Error('云备份回读未确认');
    const restored = decodeBackup(downloaded.fileContent, this.key);
    if (!Buffer.from(downloaded.fileContent).equals(bytes) || digest(JSON.stringify(restored)) !== digest(JSON.stringify(payload))) throw new Error('云备份完整性校验失败');
    if (this.localDirectory) await writeBackupFile(this.localDirectory, name, bytes);
    return { fileID: uploaded.fileID, cloudPath, createdAt, sha256: digest(bytes) };
  }
}

module.exports = { CloudFileBackups, encodeBackup, decodeBackup, writeBackupFile, backupLocalState, filename, digest };
