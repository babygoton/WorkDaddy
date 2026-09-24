'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const route = source.slice(source.indexOf("  if (req.method === 'POST' && p === '/api/open-url')"), source.indexOf("  if (req.method === 'GET' && p === '/api/status')"));

async function openUrl(platform, url, failure) {
  const calls = [];
  const context = {
    IS_WIN: platform === 'win32', IS_LINUX: platform === 'linux',
    req: { method: 'POST' }, p: '/api/open-url', res: {},
    readBody: async () => ({ url }),
    json: (_res, status, body) => ({ status, ...body }),
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.unref = () => { child.unreferenced = true; };
      calls.push({ command, args: Array.from(args), options, child });
      queueMicrotask(() => {
        if (failure) child.emit('error', Object.assign(new Error('missing opener'), { code: 'ENOENT' }));
        else child.emit('spawn');
      });
      return child;
    },
  };
  const result = await vm.runInNewContext('(function(){' + route + '})()', context);
  return { calls, result };
}

test('open-url uses the platform opener and passes the URL as one unchanged argument', async () => {
  const url = 'https://example.invalid/login?state=a%2Bb&next=%2F';
  for (const [platform, command, args] of [
    ['linux', 'xdg-open', [url]], ['darwin', 'open', [url]],
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
  ]) {
    const { calls, result } = await openUrl(platform, url);
    assert.equal(result.status, 200);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, command);
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.shell, undefined);
    assert.equal(calls[0].child.unreferenced, true);
  }
});

test('open-url rejects non-HTTP URLs before spawning an opener', async () => {
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', '']) {
    const { calls, result } = await openUrl('linux', url);
    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  }
});

test('Linux missing xdg-open returns an error without leaking the URL or an unhandled event', async () => {
  const { result } = await openUrl('linux', 'https://example.invalid/?state=private-fixture', true);
  assert.equal(result.status, 500);
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /private-fixture/);
});
