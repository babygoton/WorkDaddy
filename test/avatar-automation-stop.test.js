'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const injectPath = path.join(__dirname, '../scripts/inject.js');
const source = fs.readFileSync(injectPath, 'utf8');
const { findLatestManualAutomationRun } = require('../scripts/inject');

test('floating stop control targets only the latest running manual automation', () => {
  const tasks = [
    { id: 'manual-old', manualRunnable: true },
    { id: 'scheduled', manualRunnable: false },
    { id: 'manual-new', manualRunnable: true },
  ];
  const runs = [
    { id: 'run-old', taskId: 'manual-old', status: 'running', startedAt: 10 },
    { id: 'run-scheduled', taskId: 'scheduled', status: 'running', startedAt: 30 },
    { id: 'run-finished', taskId: 'manual-new', status: 'success', startedAt: 40 },
    { id: 'run-new', taskId: 'manual-new', status: 'running', startedAt: 20 },
  ];

  assert.equal(findLatestManualAutomationRun(tasks, runs).id, 'run-new');
  assert.equal(findLatestManualAutomationRun(tasks, runs.filter((run) => run.taskId === 'scheduled')), null);
});

test('theme avatar keeps three built-ins, defaults to the second, and removes all captions', () => {
  assert.match(source, /state = \{ selected: 'workbuddy', items: \[\] \}/);
  const first = source.match(/<label class="wbs-avatar-option wbs-avatar-default-option"[\s\S]*?<\/label>/);
  assert.ok(first, 'the supplied avatar should replace the old refresh mark');
  assert.match(first[0], /<img class="wb-avatar__img" data-avatar-image="default"/);
  assert.doesNotMatch(first[0], /wbs-avatar-default-mark|<svg/);
  assert.doesNotMatch(first[0], /<span>/);
  const preset = source.match(/<label class="wbs-avatar-option" title="WorkBuddy">[^']+value="workbuddy"[^']+<\/label>/);
  assert.ok(preset, 'the second WorkBuddy avatar preset should exist');
  assert.doesNotMatch(preset[0], /<span>/);
  const workdaddy = source.match(/<label class="wbs-avatar-option" title="WorkDaddy">[^']+value="workdaddy"[^']+<\/label>/);
  assert.ok(workdaddy, 'the third WorkDaddy avatar preset should exist');
  assert.doesNotMatch(workdaddy[0], /<span>/);

  const image = source.match(/var OFFICIAL_AVATAR = '(data:image\/png;base64,([^']+))'/);
  assert.ok(image, 'the supplied default avatar should remain embedded as the first preset source');
  assert.equal(Buffer.from(image[2], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(source, /var DEFAULT_AVATAR = OFFICIAL_AVATAR;/);
  assert.match(source, /svgToPng\(OFFICIAL_LOGO_SVG, 96\)/);
  assert.match(source, /input\.value === 'default' \? DEFAULT_AVATAR/);
});

test('floating manual automation stop uses the existing safe-stop endpoint', () => {
  assert.match(source, /class="wbs-automation-stop"[^>]+aria-label="停止运行"/);
  assert.match(source, /AUTO_TAB_SVG \+ '<span class="wbs-automation-stop-label">停止运行<\/span>'/);
  assert.match(source, /data-tab="automations">' \+ AUTO_TAB_SVG \+ '<span>自动化<\/span>/);
  assert.match(source, /findLatestManualAutomationRun\(result && result\.tasks, result && result\.runs\)/);
  assert.match(source, /api\('\/api\/automations\/stop',[\s\S]*JSON\.stringify\(\{ runId: runId \}\)/);
  assert.match(source, /\.wbs-root\[data-wbs-robot-style="black"\] \.wbs-automation-stop/);
  assert.match(source, /--wbs-robot-shell/);
});
