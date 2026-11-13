'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const start = source.indexOf('    var rememberedSessionsKey =');
const end = source.indexOf('    // 按空间分组渲染', start);

test('remembered sessions persist by profile and account UID and can be removed', () => {
  const values = new Map();
  const context = vm.createContext({
    PROFILE_ID: 'workbuddy-cn',
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, value),
    },
    sessionsState: { uid: 'account-a', currentUid: 'account-a' },
  });
  vm.runInContext(source.slice(start, end), context);
  const sessionA = { id: 'session-1', user_id: 'account-a', title: 'Pinned task' };
  const sessionB = { id: 'session-1', user_id: 'account-b', title: 'Different task' };

  assert.equal(context.isSessionRemembered(sessionA), false);
  context.toggleRememberedSession(sessionA);
  assert.equal(context.isSessionRemembered(sessionA), true);
  assert.equal(context.isSessionRemembered(sessionB), false);
  context.toggleRememberedSession(sessionA);
  assert.equal(context.isSessionRemembered(sessionA), false);
});
