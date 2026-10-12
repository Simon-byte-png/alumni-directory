'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VISITOR_BUCKETS = 8192;
const VISITOR_BITS_BYTES = VISITOR_BUCKETS / 8;
const DAY_MS = 86400000;

function shanghaiDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function emptyState() {
  return { startedAt: '', totalViews: 0, daily: {} };
}

class AnalyticsStore {
  constructor(options = {}) {
    this.statePath = options.statePath;
    this.stateBackend = options.stateBackend;
    this.now = options.now || (() => Date.now());
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (!this.statePath && !this.stateBackend) throw new Error('AnalyticsStore requires statePath or stateBackend');
    let raw;
    if (this.stateBackend) {
      raw = await this.stateBackend.load();
    } else {
      await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      try {
        raw = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (raw) {
      if (!raw.daily || typeof raw.daily !== 'object' || Array.isArray(raw.daily)) {
        throw new Error('访问统计数据格式不正确');
      }
      this.state = { ...emptyState(), ...raw };
    }
    return this;
  }

  async persist(snapshot) {
    if (this.stateBackend) return this.stateBackend.save(snapshot);
    if (fs.existsSync(this.statePath)) await require('./backups').backupLocalState(this.statePath, JSON.parse(await fs.promises.readFile(this.statePath, 'utf8')));
    const tempPath = `${this.statePath}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(snapshot) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempPath, this.statePath);
    await require('./backups').backupLocalState(this.statePath, snapshot);
  }

  recordVisit(visitorId) {
    if (!/^[a-f0-9]{32}$/i.test(String(visitorId || ''))) {
      const error = new Error('访问标识格式不正确');
      error.status = 400;
      throw error;
    }
    const result = this.writeQueue.then(async () => {
      if (this.stateBackend) {
        const latest = await this.stateBackend.load();
        this.state = latest ? { ...emptyState(), ...latest } : emptyState();
      }
      const snapshot = structuredClone(this.state);
      const timestamp = this.now();
      const date = shanghaiDate(timestamp);
      const day = snapshot.daily[date] || { pageViews: 0, uniqueVisitors: 0, visitorBits: '' };
      const bits = Buffer.from(day.visitorBits || '', 'base64');
      const bitmap = bits.length === VISITOR_BITS_BYTES ? bits : Buffer.alloc(VISITOR_BITS_BYTES);
      const bucket = crypto.createHash('sha256').update(visitorId.toLowerCase()).digest().readUInt32BE(0) % VISITOR_BUCKETS;
      bitmap[bucket >> 3] |= 1 << (bucket & 7);
      let occupied = 0;
      for (const byte of bitmap) {
        let value = byte;
        while (value) { occupied++; value &= value - 1; }
      }
      day.pageViews++;
      day.uniqueVisitors = Math.round(-VISITOR_BUCKETS * Math.log(Math.max(1, VISITOR_BUCKETS - occupied) / VISITOR_BUCKETS));
      day.visitorBits = bitmap.toString('base64');
      snapshot.daily[date] = day;
      snapshot.totalViews++;
      if (!snapshot.startedAt) snapshot.startedAt = new Date(timestamp).toISOString();
      const bitmapCutoff = shanghaiDate(timestamp - 31 * DAY_MS);
      const historyCutoff = shanghaiDate(timestamp - 365 * DAY_MS);
      for (const [key, item] of Object.entries(snapshot.daily)) {
        if (key < historyCutoff) delete snapshot.daily[key];
        else if (key < bitmapCutoff) delete item.visitorBits;
      }
      try {
        await this.persist(snapshot);
      } catch (cause) {
        const error = new Error('访问统计暂时无法保存', { cause });
        error.status = 503;
        throw error;
      }
      this.state = snapshot;
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  freshSummary() {
    const result = this.writeQueue.then(async () => {
      if (this.stateBackend) {
        const latest = await this.stateBackend.load();
        this.state = latest ? { ...emptyState(), ...latest } : emptyState();
      }
      return this.summary();
    });
    this.writeQueue = result.catch(() => {});
    return result;
  }

  summary() {
    const rows = Array.from({ length: 14 }, (_, index) => {
      const date = shanghaiDate(this.now() - (13 - index) * DAY_MS);
      const day = this.state.daily[date] || {};
      return { date, pageViews: day.pageViews || 0, uniqueVisitors: day.uniqueVisitors || 0 };
    });
    return {
      startedAt: this.state.startedAt,
      totalViews: this.state.totalViews,
      today: rows[rows.length - 1],
      last7Views: rows.slice(-7).reduce((sum, day) => sum + day.pageViews, 0),
      days: rows,
    };
  }
}

module.exports = { AnalyticsStore };
