'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('release staging copies source presets even when the reusable asset shell has none', { skip: process.platform === 'win32' }, () => {
  const repo = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-preset-stage-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts/builtin/automations'), { recursive: true });
    const presets = fs.readdirSync(path.join(repo, 'scripts/builtin/automations')).filter(f => f.endsWith('.json'));
    for (const file of presets) fs.copyFileSync(path.join(repo, 'scripts/builtin/automations', file), path.join(dir, 'scripts/builtin/automations', file));
    for (const [script, variable, destination] of [
      ['build-mac-dmg.sh', 'APP', 'Contents/Resources/scripts/builtin/automations'],
      ['build-win-zip.sh', 'STAGE', 'scripts/builtin/automations'],
    ]) {
      const source = fs.readFileSync(path.join(repo, 'scripts', script), 'utf8');
      const block = source.match(/mkdir -p "\$(?:APP|STAGE)\/[^"\n]*builtin\/automations"\ncp scripts\/builtin\/automations\/\*\.json [^\n]+/);
      assert.ok(block, script + ' must stage presets from source');
      const stage = path.join(dir, variable + ' with spaces');
      const result = spawnSync('bash', ['-eu', '-c', block[0]], { cwd: dir, env: { ...process.env, [variable]: stage }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const file of presets) assert.equal(fs.readFileSync(path.join(stage, destination, file), 'utf8'), fs.readFileSync(path.join(repo, 'scripts/builtin/automations', file), 'utf8'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
