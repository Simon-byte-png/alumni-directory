'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { digestRecords, hasCloudCredential, migrateRoster } = require('../scripts/migrate-roster');

test('迁移校友基线默认不覆盖不同数据，并对相同数据保持幂等', async () => {
  let records = [];
  const store = {
    listRosterRecords: () => JSON.parse(JSON.stringify(records)),
    async replaceRosterRecords(next, meta) {
      records = JSON.parse(JSON.stringify(next));
      return { count: records.length, contactCount: 1, ...meta };
    },
  };
  const source = [{ id: 'a0001', name: '测试校友', contact: 'member@example.com' }];
  const first = await migrateRoster({ store, records: source, source: 'private.json' });
  assert.equal(first.changed, true);
  assert.equal(first.digest, digestRecords(source));
  const second = await migrateRoster({ store, records: source, source: 'private.json' });
  assert.equal(second.changed, false);
  assert.equal(digestRecords(source), digestRecords([{ ...source[0], experiences: [] }]));
  await assert.rejects(
    migrateRoster({ store, records: [{ id: 'a0002', name: '另一校友' }], source: 'private.json' }),
    /--replace/,
  );
});

test('CloudBase 凭据检查接受 API Key 或成对临时密钥', () => {
  assert.equal(hasCloudCredential({}), false);
  assert.equal(hasCloudCredential({ CLOUDBASE_APIKEY: 'set' }), true);
  assert.equal(hasCloudCredential({ TENCENTCLOUD_SECRETID: 'id' }), false);
  assert.equal(hasCloudCredential({ TENCENTCLOUD_SECRETID: 'id', TENCENTCLOUD_SECRETKEY: 'key' }), true);
});
