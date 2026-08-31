'use strict';

// CDP target 归属判定（纯函数，无副作用，便于单测）。
// 背景：WorkDaddy 现在支持四个客户端（WorkBuddy CN / WorkBuddy AI / CodeBuddy CN /
// CodeBuddy 国际版），每个客户端由独立 daemon（WBSWITCH_PROFILE 绑定）驱动。旧版未绑定
// profile 的 daemon 会扫描 9222-9232 全部 CDP 端口，仅凭 Browser 标识 + 页面标题判断
// "这是 WorkBuddy"，容易把兄弟客户端的页面误认成自己的注入目标：
//   - 对别人的页面执行注入（把组件送错端）；
//   - 注入失败后反复重试，每次先清理旧组件，把对方 daemon 注入好的组件也一并销毁。
// 本模块提供严格的归属判定：优先依据应用包路径 / 登录域名（强信号），拒绝一切明确属于
// 其他客户端的页面；无强信号时才按 profile 类型走宽松兜底。

/**
 * 归一化 URL：Electron file:// URL 中空格编码为 %20（如 WorkBuddy%20AI.app），
 * 统一替换为空格便于正则匹配。
 */
function normalizeTargetUrl(url) {
  return String(url || '').replace(/%20/g, ' ');
}

const APP_CN = /\/WorkBuddy\.app(?:\/|$)/i;
const APP_AI = /\/WorkBuddy AI\.app(?:\/|$)/i;
const APP_CBCN = /\/CodeBuddy CN\.app(?:\/|$)/i;
const APP_CBINTL = /\/CodeBuddy\.app(?:\/|$)/i;
const DOMAIN_WB_AI = /https?:\/\/(?:[^/]+\.)?workbuddy\.ai(?:\/|$)/i;
const DOMAIN_WB_CN = /https?:\/\/(?:[^/]+\.)?workbuddy\.cn(?:\/|$)/i;
const DOMAIN_CB_CN = /https?:\/\/(?:[^/]+\.)?codebuddy\.cn(?:\/|$)/i;
const DOMAIN_CB_AI = /https?:\/\/(?:[^/]+\.)?codebuddy\.ai(?:\/|$)/i;

/**
 * 依据目标页 URL / 标题判定它属于哪个 client profile。
 * 只返回强信号：明确命中某个客户端的 app 包路径或登录域名。
 * 无强信号返回 null（调用方按 profile 类型走宽松兜底）。
 * @returns {string|null} profile id（workbuddy-cn / workbuddy-ai / codebuddy-cn / codebuddy-intl）
 */
function classifyTarget(url, title, description) {
  const u = normalizeTargetUrl(url);
  if (APP_AI.test(u)) return 'workbuddy-ai';
  if (APP_CN.test(u)) return 'workbuddy-cn';
  if (APP_CBCN.test(u)) return 'codebuddy-cn';
  if (APP_CBINTL.test(u)) return 'codebuddy-intl';
  if (DOMAIN_WB_AI.test(u)) return 'workbuddy-ai';
  if (DOMAIN_WB_CN.test(u)) return 'workbuddy-cn';
  if (DOMAIN_CB_CN.test(u)) return 'codebuddy-cn';
  if (DOMAIN_CB_AI.test(u)) return 'codebuddy-intl';
  return null;
}

/**
 * 目标页是否属于 WorkDaddy 支持的四客户端之一（含 CodeBuddy Editor 的 vscode-file:// 页面）。
 * 用于「清理历史误注入」时区分：同族页面上可能存在其他 profile daemon 注入的合法组件，
 * 不得当作"误注入"清理；只有明显不属于任何客户端的页面（如任意 Chromium 应用）才清理。
 */
function looksLikeWbFamilyTarget(target) {
  if (!target) return false;
  const url = String(target.url || '');
  const title = String(target.title || '');
  const desc = String(target.description || '');
  if (classifyTarget(url, title, desc)) return true;
  const haystack = `${url} ${title} ${desc}`;
  const u = normalizeTargetUrl(url);
  return (
    /\/CodeBuddy(?: CN)?\.app(?:\/|$)/i.test(u) ||
    /^vscode-/i.test(url) ||
    /codebuddy/i.test(haystack) ||
    /^WorkBuddy(?:\s|$)/i.test(title)
  );
}

/**
 * 判定一个 CDP target 是否属于当前 daemon 的 profile。
 * @param {object} target CDP /json/list 中的 page target
 * @param {object} profile profiles.js 中的 profile 对象
 */
function isTargetForProfile(target, profile) {
  if (!target || target.type !== 'page') return false;
  const url = String(target.url || '');
  const title = String(target.title || '');
  const desc = String(target.description || '');
  const haystack = `${url} ${title} ${desc}`;

  // 企业专享版沿用 CN/AI 的 UI 能力，但应用路径和登录域均由用户选择后生成。
  // 企业模式只接受它自己的精确信号，不再回落到官方域名或通用标题。
  if (profile.customTarget) {
    const signals = [];
    try { if (profile.apiHost) signals.push(new URL(profile.apiHost).hostname.toLowerCase()); } catch (_) {}
    for (const hint of profile.targetHints || []) {
      const value = String(hint || '').trim().toLowerCase();
      if (value.length >= 4) signals.push(value);
    }
    const lower = haystack.toLowerCase();
    return signals.some((signal) => lower.includes(signal));
  }

  // 强信号：页面明确属于某客户端 → 必须与当前 profile 一致，否则一律拒绝
  const cls = classifyTarget(url, title, desc);
  if (cls) return cls === profile.id;

  // CodeBuddy：Editor 模式的 target URL 通常是 vscode-file://，不包含产品名；
  // profile 已由启动器绑定到独立 CDP 端口，因此选第一个普通页面即可覆盖 Agents/Editor。
  if (profile.kind === 'codebuddy') {
    if (/^(devtools|chrome|about):/i.test(url)) return false;
    if (!/codebuddy/i.test(haystack) && !/^vscode-/i.test(url)) return false;
    if (profile.id === 'codebuddy-intl' && /codebuddy\s*cn|中文/i.test(haystack)) return false;
    return true;
  }

  // WorkBuddy 家族无强信号（罕见）：
  //   - 已绑定 profile（WBSWITCH_PROFILE 固定了 CDP 端口）：标题兜底可以接受；
  //   - 未绑定（旧式 CN daemon 扫描多端口）：禁止裸标题匹配，避免误连兄弟客户端。
  if (process.env.WBSWITCH_PROFILE && /^WorkBuddy(?:\s|$)/i.test(title)) return true;
  return false;
}

module.exports = { normalizeTargetUrl, classifyTarget, looksLikeWbFamilyTarget, isTargetForProfile };
