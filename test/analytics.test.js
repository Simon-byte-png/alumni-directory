'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AnalyticsStore } = require('../lib/analytics');

test('访问统计重启后保留计数，并发访问不会丢失', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'alumni-analytics-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'analytics-state.json');
  const now = () => Date.parse('2026-09-30T02:00:00Z');
  const store = await new AnalyticsStore({ statePath, now }).init();
  await Promise.all(Array.from({ length: 20 }, () => store.recordVisit('a'.repeat(32))));
  const restored = await new AnalyticsStore({ statePath, now }).init();
  assert.equal(restored.summary().totalViews, 20);
  assert.equal(restored.summary().today.uniqueVisitors, 1);
  assert.equal(JSON.stringify(restored.state).includes('a'.repeat(32)), false);
});

test('访问统计写入失败时不增加内存中的计数，后续可重试', async () => {
  let fail = true;
  let stored = null;
  const backend = {
    async load() { return stored; },
    async save(snapshot) {
      if (fail) throw new Error('存储暂不可用');
      stored = structuredClone(snapshot);
    },
  };
  const store = await new AnalyticsStore({ stateBackend: backend }).init();
  await assert.rejects(store.recordVisit('a'.repeat(32)), /访问统计暂时无法保存/);
  assert.equal(store.summary().totalViews, 0);
  fail = false;
  await store.recordVisit('a'.repeat(32));
  assert.equal(store.summary().totalViews, 1);
  assert.equal((await new AnalyticsStore({ stateBackend: backend }).init()).summary().totalViews, 1);
});

test('访问统计重新加载其他实例的最新计数，后台读数也能看到外部更新', async () => {
  let saved = null;
  const backend = {
    async load() { return structuredClone(saved); },
    async save(state) { saved = structuredClone(state); },
  };
  const first = await new AnalyticsStore({ stateBackend: backend }).init();
  const second = await new AnalyticsStore({ stateBackend: backend }).init();
  await first.recordVisit('a'.repeat(32));
  await second.recordVisit('b'.repeat(32));
  const summary = await first.freshSummary();
  assert.equal(summary.totalViews, 2);
  assert.equal(summary.today.uniqueVisitors, 2);
});
