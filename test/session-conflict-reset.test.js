'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../scripts/lib.js');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-reset-route-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const lineage = lib.ensureAutoCopySession(dataDir, 'source', 'session-source');
  lib.addAutoCopySessionMember(dataDir, lineage, 'target', 'session-target');
  lib.setAutoCopyMapping(dataDir, lineage, 'target', { targetId: 'session-target' });
  lib.setAutoCopyMapping(dataDir, lineage, 'other', { targetId: 'session-other' });
  const jobs = [];
  const ctx = {
    ...lib, URL, HOST: '127.0.0.1', DATA_DIR: dataDir,
    isApiRequestAuthorized: () => true,
    readBody: async req => req.body,
    json: (_, status, body) => ({ status, body }),
    listAccounts: () => [],
    buildAutoCopyPlan: async () => [{ id: 'session-source', lineageId: lineage }],
    startAutoCopyJob: (sourceUid, targetUid, plan) => {
      assert.equal(lib.getAutoCopyMapping(dataDir, lineage, targetUid), null);
      const job = { id: 'retry-job', sourceUid, targetUid, plan, status: 'queued' };
      jobs.push(job);
      return job;
    },
    publicAutoCopyJob: job => job,
  };
  const start = source.indexOf('function handleApi(');
  const end = source.indexOf('// ===== 电脑休眠控制', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), ctx);
  return { dataDir, lineage, jobs, request: body => ctx.handleApi({
    method: 'POST', url: '/api/sessions/auto-copy/reset', headers: {}, body,
  }, {}) };
}

for (const body of [{}, { sourceUid: 'source', targetUid: 'target', sessionIds: ['session-source'] }]) {
  test('retired reset endpoint preserves all baselines and starts no work: ' + JSON.stringify(body), async t => {
    const h = harness(t);
    const before = fs.readFileSync(lib.metaFile(h.dataDir));
    const result = await h.request(body);
    assert.equal(result.status, 410);
    assert.match(result.body.error, /已保留双方内容/);
    assert.deepEqual(fs.readFileSync(lib.metaFile(h.dataDir)), before);
    assert.equal(h.jobs.length, 0);
  });
}
