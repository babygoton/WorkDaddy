'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const IS_WIN = process.platform === 'win32';
const appSupport = IS_WIN
  ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
  : path.join(home, 'Library', 'Application Support');
const localSupport = IS_WIN
  ? (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
  : appSupport;
const extensionAuth = path.join(localSupport, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
// Windows 可执行名与安装目录名不完全一致（AI 国际版 exe 为 WorkBuddyAI.exe，无空格；
// win-launcher 进程枚举与 PR#8 实机已确认）。winExec 缺省时用安装目录同名 .exe，找不到时
// win-launcher 仍有进程/注册表兜底。
const appPath = (name, winExec, winDir) =>
  IS_WIN
    ? path.join(localSupport, 'Programs', winDir || name, winExec || `${winDir || name}.exe`)
    : `/Applications/${name}.app`;

function sharedDataDir() {
  return path.join(appSupport, 'WorkDaddy');
}

const PROFILES = {
  'workbuddy-cn': {
    id: 'workbuddy-cn', name: 'WorkBuddy', appName: 'WorkDaddy', region: 'cn', kind: 'workbuddy', mode: 'agents',
    appPath: appPath('WorkBuddy'),
    dataRoot: path.join(home, '.workbuddy'),
    authFile: path.join(extensionAuth, 'workbuddy-desktop.info'),
    sessionDb: path.join(home, '.workbuddy', 'workbuddy.db'),
    modelsFile: path.join(home, '.workbuddy', 'models.json'),
    // billing/积分/签到/无感登录 API host（与 auth.domain 一致；国际版为 www.workbuddy.ai）
    apiHost: 'https://www.codebuddy.cn',
    capabilities: { accounts: true, sessions: true, models: true, stashPrompt: true, theme: true, checkin: true },
    targetHints: ['workbuddy'],
  },
  'workbuddy-ai': {
    id: 'workbuddy-ai', name: 'WorkBuddy AI', appName: 'WorkDaddy AI', region: 'intl', kind: 'workbuddy', mode: 'agents',
    // Windows 安装目录无空格：%LOCALAPPDATA%\Programs\WorkBuddyAI\WorkBuddyAI.exe（PR#8 实机确认）
    appPath: appPath('WorkBuddy AI', 'WorkBuddyAI.exe', 'WorkBuddyAI'),
    dataRoot: path.join(home, '.workbuddy-ai'),
    authFile: path.join(extensionAuth, 'workbuddy-desktop-ai.info'),
    sessionDb: path.join(home, '.workbuddy-ai', 'workbuddy.db'),
    // 模型配置文件：国际版用 ~/.workbuddy-ai/models.json，国内版用 ~/.workbuddy/models.json，
    // 两者独立（勿改共用）。“从 XX 导入”即把另一端文件中的模型合并进本端文件。
    modelsFile: path.join(home, '.workbuddy-ai', 'models.json'),
    apiHost: 'https://www.workbuddy.ai',
    capabilities: { accounts: true, sessions: true, models: true, stashPrompt: true, theme: true, checkin: true },
    targetHints: ['workbuddy ai', 'workbuddy'],
  },
  // CodeBuddy IDE（CN/国际版）的认证文件位于 CodeBuddyExtension 共享认证目录，
  // 文件名来自 genie 扩展 ID（publisher.name = "Tencent-Cloud.coding-copilot"），
  // 与 CodeBuddy CLI 的认证文件同路径同格式（{ account, auth, accounts, allAccounts }）。
  // 该文件由 CodeBuddyExtension 共享组件写入，WorkBuddy 桌面端登录后会同时写入
  // workbuddy-desktop.info 与 Tencent-Cloud.coding-copilot.info。
  // 国际版（CodeBuddy Intl）的扩展 ID 与 CN 版相同，因此凭证文件名不变，仅 API host 不同。
  //
  // 退出登录的坑：CodeBuddy CLI/IDE 退出登录会留下 <authFile>.logged-out 标记文件，
  // FileAuthenticationStorage.store 看到该标记会短路跳过写入，导致后续写文件都视为未登录。
  // lib.js retireLogoutMarker（与 cli-auth.js retireLogoutMarker 同构）负责清理该标记。
  'codebuddy-cn': {
    id: 'codebuddy-cn', name: 'CodeBuddy CN', region: 'cn', kind: 'codebuddy', mode: 'auto',
    appPath: appPath('CodeBuddy CN'),
    dataRoot: path.join(appSupport, 'CodeBuddy CN'),
    authFile: path.join(extensionAuth, 'Tencent-Cloud.coding-copilot.info'),
    sessionDb: path.join(appSupport, 'CodeBuddy CN', 'codebuddy-sessions.vscdb'),
    modelsFile: path.join(appSupport, 'CodeBuddy CN', 'User', 'globalStorage', 'state.vscdb'),
    apiHost: 'https://www.codebuddy.cn',
    capabilities: { accounts: true, sessions: true, models: false, stashPrompt: false, theme: false, checkin: true },
    targetHints: ['codebuddy cn'],
  },
  'codebuddy-intl': {
    id: 'codebuddy-intl', name: 'CodeBuddy', region: 'intl', kind: 'codebuddy', mode: 'auto',
    appPath: appPath('CodeBuddy'),
    dataRoot: path.join(appSupport, 'CodeBuddy'),
    authFile: path.join(extensionAuth, 'Tencent-Cloud.coding-copilot.info'),
    sessionDb: path.join(appSupport, 'CodeBuddy', 'codebuddy-sessions.vscdb'),
    modelsFile: path.join(appSupport, 'CodeBuddy', 'User', 'globalStorage', 'state.vscdb'),
    apiHost: 'https://www.codebuddy.ai',
    capabilities: { accounts: true, sessions: true, models: false, stashPrompt: false, theme: false, checkin: true },
    targetHints: ['codebuddy'],
  },
};

function getProfile(id = process.env.WBSWITCH_PROFILE || 'workbuddy-cn') {
  const key = String(id || '').trim().toLowerCase();
  if (PROFILES[key]) return PROFILES[key];
  throw new Error(`未知客户端 profile: ${id}`);
}

function listProfiles() { return Object.values(PROFILES).map((p) => ({ ...p, capabilities: { ...p.capabilities }, targetHints: [...p.targetHints] })); }

function listInstalledModelSources(activeId) {
  const active = PROFILES[activeId];
  return ['workbuddy-cn', 'workbuddy-ai']
    .filter((id) => id !== activeId)
    .map((id) => PROFILES[id])
    .map((profile) => {
      const installed = fs.existsSync(profile.appPath);
      const available = fs.existsSync(profile.modelsFile);
      // 防御：仅当两端模型文件实际指向同一路径时才视为共享（正常情况
      // CN/AI 各用各的 models.json，可互相导入；若未来某端路径缺失需容错）
      const shared = !!(active && active.modelsFile && profile.modelsFile &&
        path.resolve(active.modelsFile) === path.resolve(profile.modelsFile));
      return {
        profileId: profile.id,
        name: profile.name,
        modelsFile: profile.modelsFile,
        installed,
        available,
        shared,
      };
    })
    .filter((source) => source.installed || source.available || source.shared);
}

function profileDataDir(profile, configured) {
  if (configured) return configured;
  if (profile.id === 'workbuddy-cn') return sharedDataDir();
  return path.join(sharedDataDir(), 'profiles', profile.id);
}

module.exports = { PROFILES, getProfile, listProfiles, listInstalledModelSources, profileDataDir, sharedDataDir };
