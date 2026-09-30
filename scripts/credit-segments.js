'use strict';

// The billing API has used several names for the same values over time.
const REMAINING_FIELDS = [
  'SlicePeriodCapacityRemainPrecise',
  'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise',
  'CycleCapacityRemain',
  'CapacityRemainPrecise',
  'CapacityRemain',
  'RemainPrecise',
  'Remain',
  'Remaining',
  'Balance',
];
const TOTAL_FIELDS = [
  'SlicePeriodCapacitySizePrecise',
  'SlicePeriodCapacitySize',
  'CycleCapacitySizePrecise',
  'CycleCapacitySize',
  'CycleCapacityPrecise',
  'CycleCapacity',
  'CapacityPrecise',
  'Capacity',
  'TotalCapacityPrecise',
  'TotalCapacity',
  'PackageCapacity',
  'Quota',
  'Amount',
];
const EXPIRY_FIELDS = [
  'DeductionEndTime',
  'ExpiredTime',
  'SlicePeriodEndTime',
  'PackageEndTime',
  'EndTime',
  'CycleEndTime',
  'ExpireTime',
  'ExpirationTime',
  'ValidEndTime',
  'ValidPeriodEndTime',
  'EndAt',
  'ExpireAt',
];
const LABEL_FIELDS = [
  'PackageName',
  'PackageTypeName',
  'AccountName',
  'ProductName',
  'Name',
  'RuleName',
  'Description',
];

function firstNumber(value, fields) {
  for (const field of fields) {
    const raw = value && value[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(value, fields) {
  for (const field of fields) {
    const parsed = parseTimestamp(value && value[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

// [积分段到期修正] 月度套餐基础包（如套餐基础500）同时携带两类时间：
//   DeductionEndTime = 长期扣费有效期（如 2034，真正的权益期）
//   CycleEndTime     = 本计费周期结束（月底 23:59:59，额度每月重发）
// firstTimestamp 按字段优先级取值会把这类包判成 2034 年才过期，导致
// 「即将过期」统计漏掉月底清零的额度。积分只在「扣费窗口 ∩ 计费周期」内可用，
// 因此到期点应取候选字段中最早的非空值：月度包取到本周期 CycleEndTime，
// 裂变包/一次性包两类字段相等（取最早无影响）。
function earliestTimestamp(value, fields) {
  let earliest = null;
  for (const field of fields) {
    const parsed = parseTimestamp(value && value[field]);
    if (parsed === null) continue;
    if (earliest === null || parsed < earliest) earliest = parsed;
  }
  return earliest;
}

function firstText(value, fields) {
  for (const field of fields) {
    const text = value && value[field];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function extractCreditSegments(accounts, source) {
  return (Array.isArray(accounts) ? accounts : [])
    .flatMap((account) => {
      const details = Array.isArray(account && account.SlicePeriodUsageDetails) && account.SlicePeriodUsageDetails.length
        ? account.SlicePeriodUsageDetails.map((detail) => Object.assign({}, account, detail))
        : [account];
      return details.map((item) => {
        const remaining = firstNumber(item, REMAINING_FIELDS);
        if (remaining === null || remaining <= 0) return null;
        const total = firstNumber(item, TOTAL_FIELDS);
        return {
          remaining: Number(remaining.toFixed(2)),
          total: Number((total === null ? remaining : Math.max(total, remaining)).toFixed(2)),
          expiresAt: earliestTimestamp(item, EXPIRY_FIELDS),
          source: firstText(item, LABEL_FIELDS) || source || '积分',
          packageCode: item && item.PackageCode ? String(item.PackageCode) : '',
        };
      });
    })
    .filter(Boolean);
}

function sortCreditSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && Number(segment.remaining) > 0)
    .map((segment) => ({
      remaining: Number(Number(segment.remaining).toFixed(2)),
      total: Number(Number(segment.total || segment.remaining).toFixed(2)),
      expiresAt: segment.expiresAt === null || segment.expiresAt === undefined ? null : Number(segment.expiresAt),
      source: String(segment.source || '积分'),
      packageCode: String(segment.packageCode || ''),
    }))
    .sort((a, b) => {
      if (a.expiresAt === null && b.expiresAt !== null) return 1;
      if (a.expiresAt !== null && b.expiresAt === null) return -1;
      return (a.expiresAt || 0) - (b.expiresAt || 0);
    });
}

function mergeCreditSegments(segments) {
  const merged = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || Number(segment.remaining) <= 0) continue;
    // Multiple records can represent one grant package (for example ten 500-credit
    // records that the account page renders as one 5000-credit gift quota).
    const key = [segment.packageCode || segment.source || '积分', segment.expiresAt ?? 'unknown'].join('|');
    const previous = merged.get(key);
    if (previous) {
      previous.remaining += Number(segment.remaining) || 0;
      previous.total += Number(segment.total || segment.remaining) || 0;
    } else {
      merged.set(key, {
        remaining: Number(segment.remaining) || 0,
        total: Number(segment.total || segment.remaining) || 0,
        expiresAt: segment.expiresAt === undefined ? null : segment.expiresAt,
        source: String(segment.source || '积分'),
        packageCode: String(segment.packageCode || ''),
      });
    }
  }
  return sortCreditSegments(Array.from(merged.values()));
}

// 官方企业版判定（agent-ui hooks 的 ENTERPRISE_EDITIONS）：enterpriseId 之外的兜底类型判断
const ENTERPRISE_EDITIONS = ['ultimate', 'exclusive'];

/**
 * 解析企业积分接口（POST /v2/billing/meter/get-enterprise-user-usage）返回值。
 * 官方实现（WorkBuddy 主进程 AuthProductCoordinator.getEnterpriseUsage）响应结构：
 *   { code, msg, data: { credit, limitNum, cycleResetTime, cycleStartTime, cycleEndTime } }
 * - limitNum === -1 表示企业无限量（UI 显示「不限量」）
 * - 否则剩余 = limitNum - credit，cycleResetTime 为下个权益周期重置时间
 * 兼容 data 直接传入（payload 就是 data 对象）或带 { data: {...} } 包装。
 */
function parseEnterpriseUsage(payload, source) {
  if (!payload || typeof payload !== 'object') return null;
  // 兼容三种形态：直接传 data / { data: {...} } / { data: { data: {...} } }
  let data = payload;
  if (payload.data && typeof payload.data === 'object') {
    if ('limitNum' in payload.data) data = payload.data;
    else if (payload.data.data && typeof payload.data.data === 'object') data = payload.data.data;
  }
  const limitNum = Number(data.limitNum);
  if (!Number.isFinite(limitNum)) return null;
  const reset = firstTimestamp(data, ['CycleResetTime', 'cycleResetTime', 'CycleResetTimeMs']);
  if (limitNum === -1) {
    return { unlimited: true, credits: 0, total: 0, count: 0, segments: [], cycleResetTime: reset };
  }
  const credit = Number.isFinite(Number(data.credit)) ? Number(data.credit) : 0;
  const credits = Math.max(0, limitNum - credit);
  const segments = sortCreditSegments([{
    remaining: credits,
    total: limitNum,
    expiresAt: reset,
    source: source || '企业配额',
    packageCode: '',
  }]).filter((segment) => Number(segment.remaining) > 0);
  return {
    unlimited: false,
    credits: Number(credits.toFixed(2)),
    total: Number(limitNum.toFixed(2)),
    count: 1,
    segments,
    cycleResetTime: reset,
  };
}

module.exports = { extractCreditSegments, sortCreditSegments, mergeCreditSegments, parseEnterpriseUsage, ENTERPRISE_EDITIONS };
