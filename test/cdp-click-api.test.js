'use strict';

// /api/cdp-click：真实鼠标点击路由的契约测试（坐标校验 + 视口边界 + 只发左键单击）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const daemonPath = path.join(__dirname, '..', 'scripts', 'daemon.js');
const daemon = fs.readFileSync(daemonPath, 'utf8');

test('cdp-click route exists and validates coordinates before dispatching', () => {
  const start = daemon.indexOf("p === '/api/cdp-click'");
  assert.ok(start >= 0, 'route must exist');
  const before = daemon.slice(0, start);
  const end = daemon.indexOf("p === '/api/devtools-url'", start);
  const route = daemon.slice(start, end < 0 ? start + 4000 : end);

  assert.match(route, /Number\.isFinite\(x\)/);
  assert.match(route, /Number\.isFinite\(y\)/);
  assert.match(route, /'点击坐标超出视口'/);
  assert.match(route, /Input\.dispatchMouseEvent/, 'must use real mouse events (isTrusted=true)');
  assert.match(route, /type: 'mousePressed'/);
  assert.match(route, /type: 'mouseReleased'/);
  assert.match(route, /button: 'left'/);
  assert.match(route, /clickCount: 1/);
  // 坐标先做视口校验再派发
  const viewportCheck = route.indexOf('x > viewport.w');
  const press = route.indexOf("type: 'mousePressed'");
  assert.ok(viewportCheck >= 0 && press >= 0 && viewportCheck < press,
    'viewport bounds must be validated before dispatching the click');
});

test('cdp-click route is registered before the 404 fallback', () => {
  const routeAt = daemon.indexOf("p === '/api/cdp-click'");
  const notFoundAt = daemon.lastIndexOf('return json(res, 404');
  assert.ok(routeAt >= 0 && notFoundAt > routeAt, 'route must not fall through to 404');
});