const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('quick phrase click diagnostics record menu close and API lifecycle without phrase text', () => {
  assert.match(inject, /qpDiag\('click:start'/);
  assert.match(inject, /qpDiag\('menu:close:before'/);
  assert.match(inject, /qpDiag\('menu:close:after'/);
  assert.match(inject, /qpDiag\('api:send'/);
  assert.match(daemon, /quick-phrase-diagnostics.*api:received/);
  assert.match(daemon, /quick-phrase-diagnostics.*send:start/);
  assert.match(daemon, /quick-phrase-diagnostics.*send:finish/);
  assert.match(daemon, /quick-phrase-diagnostics.*wait-idle:start/);
  assert.match(daemon, /quick-phrase-diagnostics.*wait-idle:probe/);
  assert.match(daemon, /quick-phrase-diagnostics.*wait-idle:finish/);
  assert.match(daemon, /quick-phrase-diagnostics.*composer:start/);
  assert.match(daemon, /quick-phrase-diagnostics.*composer:finish/);
});
