'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSegment(segment) {
  if (!segment || typeof segment !== 'object') return null;
  const remaining = finiteNumber(segment.remaining);
  if (remaining === null || remaining <= 0) return null;
  const expiresAt = segment.expiresAt === null || segment.expiresAt === undefined || segment.expiresAt === ''
    ? null
    : finiteNumber(segment.expiresAt);
  return {
    remaining,
    expiresAt,
    source: String(segment.source || '积分'),
    packageCode: String(segment.packageCode || ''),
  };
}

function nearestExpiringSegment(segments, now = Date.now()) {
  const current = Number(now);
  const at = Number.isFinite(current) ? current : Date.now();
  return (Array.isArray(segments) ? segments : [])
    .map(normalizeSegment)
    .filter(Boolean)
    .filter((segment) => segment.expiresAt === null || segment.expiresAt > at)
    .sort((a, b) => {
      if (a.expiresAt === null && b.expiresAt !== null) return 1;
      if (a.expiresAt !== null && b.expiresAt === null) return -1;
      return (a.expiresAt || Number.MAX_SAFE_INTEGER) - (b.expiresAt || Number.MAX_SAFE_INTEGER);
    })[0] || null;
}

function segmentKey(segment) {
  if (!segment) return '';
  return [segment.expiresAt === null ? 'never' : segment.expiresAt, segment.packageCode || segment.source].join('|');
}

function wasNearestSegmentConsumed(previousSegments, nextSegments, now = Date.now()) {
  const previous = nearestExpiringSegment(previousSegments, now);
  if (!previous) return false;
  const next = nearestExpiringSegment(nextSegments, now);
  if (!next) return true;
  return segmentKey(previous) !== segmentKey(next) &&
    (previous.expiresAt !== null && (next.expiresAt === null || next.expiresAt > previous.expiresAt));
}

function selectRotationCandidate(accounts, currentUid, now = Date.now()) {
  const candidates = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account && String(account.uid || '') && String(account.uid) !== String(currentUid || ''))
    .map((account) => ({ account, segment: nearestExpiringSegment(account.creditSegments || account.segments, now) }))
    .filter((item) => item.segment && item.segment.remaining > 0)
    .sort((a, b) => {
      const ae = a.segment.expiresAt === null ? Number.MAX_SAFE_INTEGER : a.segment.expiresAt;
      const be = b.segment.expiresAt === null ? Number.MAX_SAFE_INTEGER : b.segment.expiresAt;
      if (ae !== be) return ae - be;
      return b.segment.remaining - a.segment.remaining;
    });
  return candidates[0] || null;
}

function isSameLocalDay(a, b = Date.now()) {
  const left = new Date(Number(a));
  const right = new Date(Number(b));
  if (!Number.isFinite(left.getTime()) || !Number.isFinite(right.getTime())) return false;
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

module.exports = {
  DAY_MS,
  nearestExpiringSegment,
  wasNearestSegmentConsumed,
  selectRotationCandidate,
  isSameLocalDay,
};
