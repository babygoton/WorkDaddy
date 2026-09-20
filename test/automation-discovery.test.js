'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutomationDiscovery } = require('../scripts/automation-discovery');
const { importTasks, readAutomations } = (() => {
  const transfer = require('../scripts/automation-transfer');
  const automation = require('../scripts/automation');
  return { importTasks: transfer.importTasks, readAutomations: automation.readAutomations };
})();

const MARKER = 'WorkDaddyAutomationRepository';
const runtime = { version: '1.2.43', profileId: 'workbuddy-cn', platform: 'darwin' };
const task = { schemaVersion: 1, id: 'shared-task', name: '账号提示', description: '显示账号信息', enabled: true, trigger: { type: 'manual' }, schedule: { type: 'manual' }, variables: {}, steps: [{ op: 'notify.toast', message: 'ok' }], onSuccess: [], onFailure: [] };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fixture() {
  let now = 1_000_000;
  const calls = [];
  const pushed = { github: '2026-09-16T10:00:00Z', gitee: '2026-09-16 18:00:00' };
  const githubRepositories = [
    { full_name: 'other/first', html_url: 'https://github.com/other/first', description: MARKER + ' sample tasks', stargazers_count: 1, default_branch: 'main', pushed_at: pushed.github },
    { full_name: 'demo/tasks', html_url: 'https://github.com/demo/tasks', description: MARKER + ' sample tasks', stargazers_count: 5, default_branch: 'main', pushed_at: pushed.github },
    { full_name: 'other/last', html_url: 'https://github.com/other/last', description: 'Unrelated tasks', stargazers_count: 2, default_branch: 'main', pushed_at: pushed.github },
  ];
  const giteeRepositories = [
    { url: 'https://gitee.com/other/first', title: 'other/first', stars: 3 },
    { url: 'https://gitee.com/demo/tasks', title: 'demo/tasks', stars: 7 },
    { url: 'https://gitee.com/other/last', title: 'other/last', stars: 4 },
  ];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === 'api.github.com' && url.pathname === '/search/repositories') {
      const page = Number(url.searchParams.get('page'));
      const items = page === 1 ? githubRepositories.slice(0, 2) : githubRepositories.slice(2);
      return json({ total_count: 3, incomplete_results: false, items });
    }
    if (url.hostname === 'so.gitee.com') {
      const from = Number(url.searchParams.get('from'));
      const rows = (from === 0 ? giteeRepositories.slice(0, 2) : giteeRepositories.slice(2)).map((repo, index) => ({
        _id: String(from + index),
        fields: { title: [repo.title], url: [repo.url], description: [repo.title === 'other/last' ? 'Unrelated tasks' : MARKER + ' sample tasks'], 'count.star': [repo.stars], last_push_at: [pushed.gitee] },
      }));
      return json({ hits: { total: { value: 3, relation: 'eq' }, hits: rows } });
    }
    if (/api\.github\.com$/.test(url.hostname) && /\/contents\/tasks$/.test(url.pathname)) {
      const repo = url.pathname.split('/').slice(2, 4).join('/');
      return json(repo === 'demo/tasks' ? [{ type: 'file', name: 'notice.json', path: 'tasks/notice.json' }] : []);
    }
    if (url.hostname === 'gitee.com' && /\/api\/v5\/repos\/.+\/contents\/tasks$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const repo = parts.slice(4, 6).join('/');
      return json(repo === 'demo/tasks' ? [{ type: 'file', name: 'notice.json', path: 'tasks/notice.json' }] : []);
    }
    if (url.hostname === 'raw.githubusercontent.com') return new Response(JSON.stringify(task, null, 2));
    if (url.hostname === 'gitee.com' && /\/raw\//.test(url.pathname)) {
      return new Response('', { status: 302, headers: { location: 'https://raw.giteeusercontent.com' + url.pathname + '?signature=test' } });
    }
    if (url.hostname === 'raw.giteeusercontent.com' && /\/raw\//.test(url.pathname)) {
      const reordered = { name: task.name, id: task.id, schemaVersion: 1, description: task.description, enabled: true, trigger: task.trigger, schedule: task.schedule, variables: {}, steps: task.steps, onSuccess: [], onFailure: [] };
      return new Response(JSON.stringify(reordered));
    }
    throw new Error('Unexpected URL: ' + url);
  };
  return { calls, pushed, fetchImpl, now: () => now, advance(ms) { now += ms; } };
}

test('discovery searches GitHub and Gitee, deduplicates task JSON and caches results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-'));
  try {
    const f = fixture();
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl: f.fetchImpl, now: f.now, pageSize: 2, runtime });
    const result = await discovery.getCatalog();
    assert.equal(result.loading, false);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].name, '账号提示');
    assert.equal(result.tasks[0].schemaVersion, 1);
    assert.equal(result.schemaVersion, 3);
    assert.equal(result.marker, MARKER);
    assert.deepEqual(result.tasks[0].sources.map(source => source.platform), ['github', 'gitee']);
    assert.equal(result.tasks[0].compatible, true);
    assert.equal(f.calls.filter(url => url.includes('api.github.com/search/repositories')).length, 2);
    assert.equal(f.calls.filter(url => url.includes('so.gitee.com/')).length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'automation-discovery-cache.json')));

    const before = f.calls.length;
    await discovery.getCatalog();
    assert.equal(f.calls.length, before, 'fresh cache should avoid all network requests');

    f.advance(10 * 60 * 1000);
    await discovery.getCatalog();
    assert.ok(f.calls.length > before, 'stale cache should refresh repository searches');
    assert.equal(f.calls.filter(url => url.includes('/contents/tasks')).length, 4, 'unmarked or unchanged repositories should not be rescanned');

    const forcedBefore = f.calls.length;
    await discovery.getCatalog({ force: true });
    assert.ok(f.calls.length > forcedBefore, 'forced discovery should search when the automation page opens');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery ignores the old cache and reads V2 from task JSON, not the repository marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-version-'));
  try {
    fs.writeFileSync(path.join(dir, 'automation-discovery-cache.json'), JSON.stringify({
      version: 1, checkedAt: 1_000_000, refreshedAt: 1_000_000,
      providers: { github: [{ key: 'github:old/tasks', platform: 'github' }], gitee: [] },
      repositories: { 'github:old/tasks': { platform: 'github', fullName: 'old/tasks', tasks: [{ content: JSON.stringify(task) }] } }, errors: [],
    }));
    const f = fixture();
    const v2 = { ...task, id: 'v2-task', name: 'V2 提醒', schemaVersion: 2 };
    const fetchImpl = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'raw.giteeusercontent.com' || url.hostname === 'raw.githubusercontent.com') return new Response(JSON.stringify(v2));
      return f.fetchImpl(input);
    };
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl, now: f.now, marker: MARKER, pageSize: 2, runtime });
    const catalog = await discovery.getCatalog();
    assert.equal(catalog.tasks.length, 1);
    assert.equal(catalog.tasks[0].schemaVersion, 2);
    assert.equal(catalog.tasks[0].name, 'V2 提醒');
    assert.equal(catalog.tasks[0].compatible, true);
    const imported = importTasks(dir, { content: discovery.getTaskContent(catalog.tasks[0].key), selected: ['0'] }, runtime);
    assert.equal(imported.imported, 1);
    assert.equal(readAutomations(dir)[0].schemaVersion, 2);
    assert.deepEqual(catalog.tasks[0].sources.map(source => source.platform), ['github', 'gitee']);
    assert.equal(f.calls.some(url => url.includes('api.github.com/search/repositories')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery groups package revisions by ID and keeps the highest version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-package-revisions-'));
  try {
    const packageFile = path.join(__dirname, '../examples/automation-packages/account-summary.workdaddy.json');
    const older = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const newer = { ...older, version: '1.1.0', name: '账号积分与活跃天数新版' };
    fs.writeFileSync(path.join(dir, 'automation-discovery-cache.json'), JSON.stringify({
      version: 3, checkedAt: 1_000_000, refreshedAt: 1_000_000,
      providers: { github: [], gitee: [] },
      repositories: {
        'github:demo/tasks': {
          platform: 'github', fullName: 'demo/tasks', repositoryUrl: 'https://github.com/demo/tasks', stars: 3,
          tasks: [
            { path: 'tasks/older.json', downloadUrl: 'https://raw.githubusercontent.com/demo/tasks/main/tasks/older.json', content: JSON.stringify(older) },
            { path: 'tasks/newer.json', downloadUrl: 'https://raw.githubusercontent.com/demo/tasks/main/tasks/newer.json', content: JSON.stringify(newer) },
          ],
        },
      }, errors: [],
    }));
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl: async () => { throw new Error('cache should be fresh'); }, now: () => 1_000_000, runtime });
    const catalog = await discovery.getCatalog();
    assert.equal(catalog.tasks.length, 1);
    assert.equal(catalog.tasks[0].packageId, older.id);
    assert.equal(catalog.tasks[0].packageVersion, '1.1.0');
    assert.equal(catalog.tasks[0].name, '账号积分与活跃天数新版');
    assert.match(discovery.getTaskContent(catalog.tasks[0].key), /"version":"1\.1\.0"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovered task imports through the existing validator and remains disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-import-'));
  try {
    const f = fixture();
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl: f.fetchImpl, now: f.now, marker: MARKER, pageSize: 2, runtime });
    const catalog = await discovery.getCatalog();
    const content = discovery.getTaskContent(catalog.tasks[0].key);
    const result = importTasks(dir, { content, selected: ['0'] }, runtime);
    assert.equal(result.imported, 1);
    assert.equal(readAutomations(dir)[0].enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed refresh keeps the last complete cached catalog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-fallback-'));
  try {
    const f = fixture();
    const first = createAutomationDiscovery({ dataDir: dir, fetchImpl: f.fetchImpl, now: f.now, marker: MARKER, pageSize: 2, runtime });
    const expected = await first.getCatalog();
    f.advance(10 * 60 * 1000);
    const failed = createAutomationDiscovery({ dataDir: dir, fetchImpl: async () => { throw new Error('offline'); }, now: f.now, marker: MARKER, pageSize: 2, runtime });
    const fallback = await failed.getCatalog();
    assert.deepEqual(fallback.tasks, expected.tasks);
    assert.equal(fallback.stale, true);
    assert.ok(fallback.errors.length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitHub failure leaves Gitee results available and reports only that source as stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-github-fallback-'));
  try {
    const f = fixture();
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl: async input => {
      if (new URL(String(input)).hostname === 'api.github.com') throw new Error('GitHub timeout');
      return f.fetchImpl(input);
    }, now: f.now, pageSize: 2, runtime });
    const catalog = await discovery.getCatalog();
    assert.equal(catalog.tasks.length, 1);
    assert.deepEqual(catalog.tasks[0].sources.map(source => source.platform), ['gitee']);
    assert.equal(catalog.stale, true);
    assert.deepEqual(catalog.errors.map(error => error.platform), ['github']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Gitee failure leaves GitHub tasks importable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-discovery-gitee-fallback-'));
  try {
    const f = fixture();
    const discovery = createAutomationDiscovery({ dataDir: dir, fetchImpl: async input => {
      if (new URL(String(input)).hostname === 'so.gitee.com') throw new Error('Gitee timeout');
      return f.fetchImpl(input);
    }, now: f.now, pageSize: 2, runtime });
    const catalog = await discovery.getCatalog();
    assert.deepEqual(catalog.tasks[0].sources.map(source => source.platform), ['github']);
    assert.equal(catalog.stale, true);
    assert.equal(importTasks(dir, { content: discovery.getTaskContent(catalog.tasks[0].key), selected: ['0'] }, runtime).imported, 1);
    assert.equal(readAutomations(dir)[0].enabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automation UI preloads discovery and exposes fuzzy task search and import', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.match(source, /id="wbs-auto-discover"[^>]*disabled/);
  assert.match(source, /class="wbs-sess-bbtn wbs-auto-pick-btn is-loading"[^>]*id="wbs-auto-discover"/);
  assert.match(source, /m21 21-4\.3-4\.3/);
  assert.match(source, /\/api\/automations\/discovery/);
  assert.match(source, /wbs-auto-discovery-search/);
  assert.match(source, /data-auto-discovery-import/);
  assert.match(source, /发现更多自动化任务/);
  assert.match(source, /wbs-auto-discovery-pagination/);
  assert.match(source, /我也要出现在这里/);
  assert.match(source, /wbs-auto-discovery-head-actions \[data-auto-discovery-guide\]/);
  assert.match(source, /git clone https:\/\/github\.com\/babygoton\/workdaddy-official-plugin\.git/);
  assert.match(source, /<ol><li>克隆示例仓库/);
  assert.match(source, /WorkDaddyAutomationRepository<\/code>/);
  assert.match(source, /WorkDaddyAutomationRepository。/);
  assert.doesNotMatch(source, /WorkDaddyAutomationRepositoryV1/);
  assert.match(source, /wbs-auto-discovery-version/);
  assert.match(source, /wbs-auto-update-badge/);
  assert.match(source, /wbs-auto-discovery-update/);
  assert.match(source, /data-auto-discovery-filter="favorites"/);
  assert.match(source, /data-auto-discovery-favorite/);
  assert.match(source, /\/api\/automations\/discovery\/favorite/);
  assert.match(source, /favoriteCount/);
  assert.match(source, /matches\.sort\(function \(left, right\)/);
  assert.match(source, /Number\(right\.favoriteCount\).*Number\(left\.favoriteCount\)/);
  assert.match(source, /wbs-auto-discovery-favorite\.is-active\{color:var\(--wb-color-text-primary/);
  assert.doesNotMatch(source, /wbs-auto-discovery-favorite\.is-active\{color:var\(--wb-accent-blue/);
  assert.match(source, /replaceExisting/);
  assert.match(source, /\/api\/automations\/discovery\?refresh=1/);
  assert.match(source, /确认用公开仓库中的新版覆盖本地任务/);
  assert.match(source, /source\.platform === 'github'/);
  assert.match(source, /wbs-usage-modal-mask wbs-auto-dialog-mask/);
  assert.doesNotMatch(source, /wbs-auto-discovery-stars/);
});

test('daemon includes a disabled check-in preset without a risk prompt', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.match(daemon, /daily-account-checkin\.json/);
  assert.doesNotMatch(inject, /showCheckinRiskOnOpen/);
});
