const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

// 回归：会话 cwd 落在已拔除的盘符上时（如 G: 被移除），createDirectoryNoFollow 会在卷根
// 目录上永久 ENOENT。原实现每 5 秒重试一次并各写一行日志，实测空转 12 小时刷出 3.5 万行
// 日志、daemon.log 涨到 8.5 MB。修法是「卷根不存在就直接跳过，同一卷根只提示一次」。
test('session cwd repair skips a cwd whose volume root is gone instead of retrying every tick', () => {
  assert.match(daemonSource, /const reportedMissingCwdRoots = new Set\(\);/);
  assert.match(daemonSource, /const root = path\.parse\(cwd\)\.root;/);
  assert.match(daemonSource, /if \(root && !fs\.existsSync\(root\)\) \{/);
  assert.match(daemonSource, /missingCwdRoots\.add\(root\);/);
});

test('session cwd repair reports a missing volume once per root and never logs the full session path', () => {
  const repair = daemonSource.slice(
    daemonSource.indexOf('function repairMissingSessionWorkspaces()'),
    daemonSource.indexOf('function sessionRangeMs('),
  );
  assert.ok(repair.length > 0, 'repairMissingSessionWorkspaces must be present');

  // 卷根不存在时必须走 continue，不能落到 createDirectoryNoFollow。
  const rootCheckIndex = repair.indexOf('if (root && !fs.existsSync(root))');
  const createIndex = repair.indexOf('createDirectoryNoFollow(cwd)');
  assert.ok(rootCheckIndex > -1 && createIndex > -1, 'both the volume check and the mkdir path must exist');
  assert.ok(rootCheckIndex < createIndex, 'the volume check must run before createDirectoryNoFollow');

  // 同一卷根只提示一次：提示被包在 has() 判断里，且 add() 在提示之前。
  assert.match(repair, /if \(reportedMissingCwdRoots\.has\(root\)\) continue;\s*reportedMissingCwdRoots\.add\(root\);/);

  // 提示只带卷根，不带完整 cwd —— 会话路径里常含用户名与项目名。
  assert.match(repair, /跳过所在卷不存在的会话：\$\{root\}/);
  assert.doesNotMatch(repair, /跳过 \$\{cwd\}: 所在卷/);

  // 非「卷不存在」的失败仍然照旧记录，行为不变。
  assert.match(repair, /跳过 \$\{cwd\}: \$\{error\.message\}/);
});
