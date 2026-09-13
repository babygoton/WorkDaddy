'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  nearestExpiringSegment,
  wasNearestSegmentConsumed,
  selectRotationCandidate,
} = require('../scripts/credit-rotation.js');

const now = Date.parse('2026-09-11T10:00:00Z');

test('nearest expiring segment ignores exhausted and expired segments', () => {
  const segment = nearestExpiringSegment([
    { remaining: 0, expiresAt: now + 60_000 },
    { remaining: 20, expiresAt: now - 60_000 },
    { remaining: 80, expiresAt: now + 3_600_000 },
    { remaining: 100, expiresAt: null },
  ], now);
  assert.equal(segment.remaining, 80);
  assert.equal(segment.expiresAt, now + 3_600_000);
});

test('detects when the previously nearest segment disappears after a refresh', () => {
  const before = [{ remaining: 10, expiresAt: now + 3_600_000, packageCode: 'soon' }, { remaining: 500, expiresAt: null }];
  const after = [{ remaining: 500, expiresAt: null }];
  assert.equal(wasNearestSegmentConsumed(before, after, now), true);
  assert.equal(wasNearestSegmentConsumed(before, [{ remaining: 3, expiresAt: now + 3_600_000, packageCode: 'soon' }], now), false);
});

test('selects the non-current account with the earliest usable expiry', () => {
  const candidate = selectRotationCandidate([
    { uid: 'current', creditSegments: [{ remaining: 1, expiresAt: now + 10_000 }] },
    { uid: 'later', creditSegments: [{ remaining: 300, expiresAt: now + 86_400_000 }] },
    { uid: 'soon', creditSegments: [{ remaining: 80, expiresAt: now + 3_600_000 }] },
  ], 'current', now);
  assert.equal(candidate.account.uid, 'soon');
  assert.equal(candidate.segment.remaining, 80);
});

test('rotation completion request uses real segment detection and keeps the verified prompt behavior', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.doesNotMatch(daemon, /forceSuggest|testMode/);
  assert.doesNotMatch(daemon, /wasNearestSegmentConsumed\(previousSegments/);
  assert.match(daemon, /const candidate = selectRotationCandidate\(cachedCreditRotationAccounts\(\), uid, Date\.now\(\)\)/);
  assert.match(daemon, /const candidate = selectRotationCandidate\(cachedCreditRotationAccounts\(\), uid, Date\.now\(\)\)/);
  assert.match(inject, /previousSegments: current\.creditSegments \}\)/);
  assert.doesNotMatch(inject, /previousSegments: current\.creditSegments, force: true/);
  const updateBaseline = inject.indexOf('current.creditSegments = Array.isArray(result && result.current && result.current.segments)');
  const suggestionGuard = inject.indexOf('if (!result || !result.shouldSuggest || !result.candidate) return;', updateBaseline);
  assert.ok(updateBaseline >= 0 && suggestionGuard > updateBaseline, 'current credit baseline must update even when no prompt is shown');
  assert.match(inject, /要切换账号吗？/);
  assert.match(inject, /关闭（10）/);
  assert.match(inject, /var remaining = 10/);
  assert.match(inject, /检测到积分到期时间最临近的账号/);
  assert.doesNotMatch(inject, /action === 'remove'[\s\S]{0,500}checkCreditRotationAfterSession/);
  assert.match(inject, /Account rotation must wait for an actual reply/);
  assert.match(inject, /Use the untransformed fixed position/);
});
