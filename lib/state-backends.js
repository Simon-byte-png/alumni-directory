'use strict';
const { isDeepStrictEqual } = require('util');
const { CloudFileBackups, digest } = require('./backups');

class CloudBaseStateBackend {
  constructor(options = {}) {
    this.envId = String(options.envId || process.env.CLOUDBASE_ENV_ID || '');
    this.region = String(options.region || process.env.CLOUDBASE_REGION || 'ap-shanghai');
    this.collectionName = String(options.collectionName || process.env.CLOUDBASE_STATE_COLLECTION || 'alumni_runtime');
    this.documentId = String(options.documentId || 'primary');
    this.database = options.database || null;
    this.app = options.app || null;
    this.expectedState = null;
    this.lastBackupDigest = '';
    this.backups = options.backups || (options.backups !== false && process.env.ALUMNI_BACKUP_ENABLED === '1'
      ? new CloudFileBackups({ getApp: () => this.getApp(), key: process.env.ALUMNI_BACKUP_KEY, prefix: process.env.ALUMNI_BACKUP_PREFIX || 'alumni-backups' }) : null);
  }

  async getApp() {
    if (this.app) return this.app;
    if (!this.envId) throw new Error('使用 CloudBase 时必须配置 CLOUDBASE_ENV_ID');
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(this.collectionName)) {
      throw new Error('CLOUDBASE_STATE_COLLECTION 格式不正确');
    }
    // The server SDK uses CLOUDBASE_APIKEY or the cloud runtime identity.
    // Browser credentials cannot access the private runtime document.
    const imported = await import('@cloudbase/node-sdk');
    const cloudbase = imported.default || imported;
    this.app = cloudbase.init({ env: this.envId, region: this.region });
    return this.app;
  }

  async getDatabase() {
    if (this.database) return this.database;
    this.database = (await this.getApp()).database();
    return this.database;
  }

  async readState(database) {
    const result = await database.collection(this.collectionName).doc(this.documentId).get();
    const record = Array.isArray(result && result.data) ? result.data[0] : result && result.data;
    return record && record.state ? record.state : null;
  }

  async load() {
    const state = await this.readState(await this.getDatabase());
    this.expectedState = structuredClone(state);
    return state;
  }

  async archiveCurrent() {
    if (!this.backups || !this.expectedState) return;
    const snapshot = structuredClone(this.expectedState);
    await this.backups.save(this.documentId, snapshot, { envId: this.envId, collectionName: this.collectionName, reason: 'service-start' });
    this.lastBackupDigest = digest(JSON.stringify(snapshot));
  }

  async save(state) {
    const database = await this.getDatabase();
    const snapshot = JSON.parse(JSON.stringify(state));
    const expected = structuredClone(this.expectedState);
    // Preserve the previous committed revision before replacing it, including
    // the first write after deployment or a lost backup acknowledgement.
    if (this.backups && expected && this.lastBackupDigest !== digest(JSON.stringify(expected))) {
      await this.backups.save(this.documentId, expected, { envId: this.envId, collectionName: this.collectionName });
      this.lastBackupDigest = digest(JSON.stringify(expected));
    }
    try {
      // Read and write in one database transaction. A stale container or CLI
      // must never replace a newer password, account or profile snapshot.
      await database.runTransaction(async transaction => {
        const current = await this.readState(transaction);
        if (!isDeepStrictEqual(current, expected)) {
          const error = new Error('数据已被更新，请刷新页面后重试');
          error.code = 'state_conflict';
          error.status = 409;
          throw error;
        }
        await transaction.collection(this.collectionName).doc(this.documentId).set({
          state: snapshot,
          updatedAt: new Date().toISOString(),
        });
      });
    } catch (error) {
      if (error.code === 'state_conflict') throw error;
      // Confirmation must not update our checkpoint unless our write landed.
      try {
        if (isDeepStrictEqual(await this.readState(database), snapshot)) {
          error = null;
        }
      } catch (_) { /* Keep the original error if confirmation is unavailable. */ }
      if (error) throw error;
    }
    try {
      if (this.backups) {
        await this.backups.save(this.documentId, snapshot, { envId: this.envId, collectionName: this.collectionName });
        this.lastBackupDigest = digest(JSON.stringify(snapshot));
      }
    } catch (cause) {
      const error = new Error('数据已提交，但备份尚未确认。请刷新核对后重试，已填内容会保留。', { cause });
      error.code = 'backup_unconfirmed';
      error.status = 503;
      throw error;
    }
    // A failed backup must not advance the checkpoint while AuthStore still
    // holds the previous revision: that could allow a stale overwrite.
    this.expectedState = structuredClone(snapshot);
  }
}

function cloudBaseBackendFromEnv(options = {}) {
  return new CloudBaseStateBackend(options);
}

module.exports = { CloudBaseStateBackend, cloudBaseBackendFromEnv };
