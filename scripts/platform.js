'use strict';

/**
 * 平台常量与路径解析（macOS / Windows / Linux）
 *
 * 背景：WorkDaddy 上游只发布了 macOS(.dmg) 与 Windows(.exe) 两个安装包，
 * 代码里「非 Windows」一律按 macOS 处理（~/Library/Application Support、
 * /Applications/*.app、launchctl、osascript）。本模块把三平台差异集中到一处，
 * 其余模块只引用这里的常量，避免到处散落平台判断。
 *
 * 三平台数据根对照（Linux 列已在本机 WorkBuddy 5.5.4 上实测确认）：
 *
 *   用途                      macOS                                  Windows                    Linux
 *   ----------------------------------------------------------------------------------------------------------
 *   应用支持根(配置类)         ~/Library/Application Support           %APPDATA%                  $XDG_CONFIG_HOME(~/.config)
 *   扩展数据根(auth 所在)      ~/Library/Application Support           %LOCALAPPDATA%             $XDG_DATA_HOME(~/.local/share)
 *   登录凭据                   <扩展数据根>/CodeBuddyExtension/Data/Public/auth/<id>.info   （三平台同构，仅根不同）
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const IS_DESKTOP_UNIX = IS_MAC || IS_LINUX;

const home = os.homedir();

function envOr(key, fallback) {
  const value = process.env[key];
  return value && String(value).trim() ? String(value).trim() : fallback;
}

// 应用支持根：用于 WorkDaddy 自身备份目录、CodeBuddy IDE 的 profile 数据
const appSupport = IS_WIN
  ? envOr('APPDATA', path.join(home, 'AppData', 'Roaming'))
  : IS_MAC
    ? path.join(home, 'Library', 'Application Support')
    : envOr('XDG_CONFIG_HOME', path.join(home, '.config'));

// XDG 配置根（显式）：Electron 在 Linux 上把 userData 放在
// $XDG_CONFIG_HOME/<productName>，与 macOS 的「应用支持根」语义一一对应。
const xdgConfigHome = envOr('XDG_CONFIG_HOME', path.join(home, '.config'));

// 扩展数据根：CodeBuddyExtension（登录凭据）所在
const localSupport = IS_WIN
  ? envOr('LOCALAPPDATA', path.join(home, 'AppData', 'Local'))
  : IS_MAC
    ? appSupport
    : envOr('XDG_DATA_HOME', path.join(home, '.local', 'share'));

// 登录凭据目录（三平台同构）
const extensionAuth = path.join(localSupport, 'CodeBuddyExtension', 'Data', 'Public', 'auth');

/**
 * Linux 上 WorkBuddy 的可执行文件候选。
 * Linux 没有 .app 包，官方包把 Electron 主程序直接铺在安装目录里：
 *   /opt/WorkBuddy/workbuddy（发行版包）  →  /usr/bin/workbuddy 软链
 * 海外版/企业版常见做法是复制一份应用副本到用户目录并自定义 --user-data-dir，
 * 因此这里也把 XDG 数据目录下的副本纳入候选。
 */
const LINUX_APP_CANDIDATES = {
  workbuddy: [
    '/opt/WorkBuddy/workbuddy',
    '/usr/lib/workbuddy/workbuddy',
    '/usr/bin/workbuddy',
    '/usr/local/bin/workbuddy',
    path.join(localSupport, 'workbuddy', 'workbuddy'),
  ],
  'workbuddy-ai': [
    path.join(localSupport, 'workbuddy-ai', 'app', 'workbuddy'),
    '/opt/WorkBuddyAI/workbuddy',
    '/opt/WorkBuddyAI/WorkBuddyAI',
    '/usr/bin/workbuddy-ai',
  ],
  codebuddy: [
    '/opt/CodeBuddy/codebuddy',
    '/usr/bin/codebuddy',
    path.join(localSupport, 'codebuddy', 'codebuddy'),
  ],
  'codebuddy-cn': [
    '/opt/CodeBuddy CN/codebuddy',
    '/usr/bin/codebuddy-cn',
    path.join(localSupport, 'codebuddy-cn', 'codebuddy'),
  ],
};

/**
 * 应用标识归一：本模块的部分函数按「kind」索引（workbuddy / workbuddy-ai /
 * codebuddy / codebuddy-cn），而调用方常手边只有 profile id（workbuddy-cn / codebuddy-intl）。
 * 两者混用会静默取不到候选（返回空串），因此统一在这里归一。
 */
const APP_KIND_ALIASES = {
  workbuddy: 'workbuddy',
  'workbuddy-cn': 'workbuddy',
  'workbuddy-ai': 'workbuddy-ai',
  codebuddy: 'codebuddy',
  'codebuddy-intl': 'codebuddy',
  'codebuddy-cn': 'codebuddy-cn',
};

function normalizeAppKind(kind) {
  return APP_KIND_ALIASES[String(kind || '').trim()] || '';
}

function isAiKind(kind) {
  return normalizeAppKind(kind) === 'workbuddy-ai';
}

/**
 * 在 Linux 上解析应用可执行文件：返回第一个真实存在的候选；
 * 都不存在时返回首选路径（保持与 macOS 分支一致的「路径恒为字符串」语义，
 * 由调用方用 fs.existsSync 判断是否真的可用）。
 */
function linuxAppBinary(kind) {
  const candidates = LINUX_APP_CANDIDATES[normalizeAppKind(kind)] || [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* 权限/链接异常时继续尝试下一个候选 */
    }
  }
  return candidates[0] || '';
}

/**
 * 判断一个数据根路径是否明显属于「兄弟端」（CN ↔ AI 互斥）。
 * 背景：从 WorkBuddy 内置终端启动时，环境里可能残留另一端的
 * WORKBUDDY_CONFIG_DIR，直接采信会把 AI 的数据根指到 CN 的目录上。
 */
function looksLikeSiblingRoot(value, isAiProfile) {
  const raw = String(value || '').replace(/[/\\]+$/, '');
  const base = path.basename(raw).toLowerCase();
  if (!base) return true; // 空值一律视为不可用
  const aiNamed = base.includes('ai');
  // AI 端只接受名字带 ai 的根；CN 端只接受不带 ai 的根
  return isAiProfile ? !aiNamed : aiNamed;
}

/**
 * Linux 数据根候选（越靠前优先级越高）。
 * Electron 在 Linux 的默认 userData 是 $XDG_CONFIG_HOME/<productName>，
 * 这一层按 profile 名构造，天然不会串端，因此优先级最高；
 * 客户端显式重定向（WORKBUDDY_CONFIG_DIR / --user-data-dir）放在最后，
 * 仅在前面都落空时采用——避免继承来的另一端环境变量误命中。
 */
function linuxDataRootCandidates(kind, options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const xdgConfig = options.xdgConfigHome || envOr('XDG_CONFIG_HOME', path.join(home, '.config'));
  const ai = isAiKind(kind);
  const productNames = ai
    ? ['workbuddy-ai', 'WorkBuddy AI', 'WorkBuddyAI']
    : ['workbuddy', 'WorkBuddy'];
  const roots = [];
  const push = (value) => {
    const trimmed = value && String(value).trim();
    if (trimmed && !roots.includes(trimmed)) roots.push(trimmed);
  };
  // 1) Electron 在 Linux 的默认 userData（按 profile 名区分，不会串端）
  for (const name of productNames) push(path.join(xdgConfig, name));
  // 2) 历史 / 自定义布局
  push(path.join(home, ai ? '.workbuddy-ai' : '.workbuddy'));
  // 3) 客户端显式重定向：放最后，并排除明显属于兄弟端的路径
  for (const value of [env.WORKBUDDY_CONFIG_DIR, env.CODEBUDDY_CONFIG_DIR]) {
    if (looksLikeSiblingRoot(value, ai)) continue;
    push(value);
  }
  return roots;
}

/** 从候选里挑出真正的数据根：优先含 workbuddy.db，其次含 app/，再次仅需目录存在。 */
function pickLinuxDataRoot(candidates) {
  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  for (const c of candidates) if (exists(path.join(c, 'workbuddy.db'))) return c;
  for (const c of candidates) if (isDir(path.join(c, 'app'))) return c;
  for (const c of candidates) if (isDir(c)) return c;
  return candidates[0] || '';
}

/** 数据根里的登录凭据文件：优先本端专属名，其次通用名，都不存在则返回首选名。 */
function linuxAuthFileFor(authDir, kind) {
  const ai = isAiKind(kind);
  const candidates = ai
    ? [path.join(authDir, 'workbuddy-desktop-ai.info'), path.join(authDir, 'workbuddy-desktop.info')]
    : [path.join(authDir, 'workbuddy-desktop.info'), path.join(authDir, 'workbuddy-desktop-ai.info')];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 继续 */ }
  }
  return candidates[0];
}

/** Linux 上应用「安装根目录」（用于 pgrep 匹配与目录级操作） */
function linuxAppRoot(binary) {
  const value = String(binary || '');
  if (!value) return '';
  // 官方包：/opt/WorkBuddy/workbuddy → /opt/WorkBuddy
  // 用户副本：<xdg>/workbuddy-ai/app/workbuddy → <xdg>/workbuddy-ai/app
  return path.dirname(value);
}

/**
 * 由启动器路径反推「登录用户的真实家目录」。
 *
 * 为什么需要：海外版以隔离 HOME 运行，启动器内部用 `REAL_HOME="${HOME:-...}"`
 * 反推真实家目录。若调用方带着隔离 HOME 去启动它，它会误把隔离 HOME 当真实家目录，
 * 进而把 <隔离HOME>/.config/mimeapps.list 覆盖成**指向自己的死链**，
 * xdg-open 随即退回系统兜底关联（实测会打开 ChatGPT 而不是浏览器）。
 * 因此调用启动器前必须把 HOME 还原为真实家目录。
 *
 * 启动器约定位于 `<真实HOME>/.local/bin/<name>`，上溯三级即真实 HOME；
 * 路径形态不符时返回空串，交由调用方决定回退策略。
 */
function launcherHomeFor(launcherPath, explicitHome) {
  const explicit = String(explicitHome || '').trim();
  if (explicit) return explicit;
  const value = String(launcherPath || '').trim();
  if (!value) return '';
  const binDir = path.dirname(value);
  if (path.basename(binDir) !== 'bin') return '';
  const localDir = path.dirname(binDir);
  if (path.basename(localDir) !== '.local') return '';
  return path.dirname(localDir);
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  IS_DESKTOP_UNIX,
  home,
  appSupport,
  localSupport,
  xdgConfigHome,
  extensionAuth,
  linuxAppBinary,
  linuxAppRoot,
  launcherHomeFor,
  normalizeAppKind,
  isAiKind,
  linuxDataRootCandidates,
  pickLinuxDataRoot,
  linuxAuthFileFor,
  looksLikeSiblingRoot,
  LINUX_APP_CANDIDATES,
};
