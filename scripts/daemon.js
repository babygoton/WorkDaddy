#!/usr/bin/env node
/**
 * WorkBuddy 多账号切换器 - CDP 守护进程
 *
 * 方案：通过 Chrome DevTools Protocol (CDP) 直接连接正在运行的 WorkBuddy 桌面应用
 *  （Electron），监听其登录/认证网络事件与页面加载事件，自动把登录信息文件按
 *  account.uid 备份到稳定目录；提供本地 Web 界面一键切换登录账号（把备份复制回
 *  登录信息文件），切换后可通过 CDP 刷新应用窗口。
 *
 * 前提：WorkBuddy 需以 --remote-debugging-port 启动（见 scripts/relaunch-with-cdp.sh）。
 * 若未开启 CDP，守护进程自动降级为文件监听模式，基础备份/切换功能不受影响。
 *
 * 环境变量：
 *   WBSWITCH_AUTH_FILE   登录信息文件路径（默认 CodeBuddyExtension 下 auth/workbuddy-desktop.info）
 *   WBSWITCH_DATA_DIR    备份数据目录（默认 ~/Library/Application Support/WorkDaddy）
 *   WBSWITCH_PORT        Web 界面端口（显式指定时固定；未指定时从 47832 起尝试）
 *   WBSWITCH_CDP_PORT    WorkBuddy CDP 首选端口（被占用时自动切换到 9222-9232/9333）
 *   WBSWITCH_WORKBUDDY_BIN / WBSWITCH_WORKBUDDY_VERSION
 *                         VPC/便携版目标程序路径与可选版本校验
 *
 * 用法: node scripts/daemon.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const {
  assertSameProcessIdentity,
  detectWindowsPrivilege,
  buildNativeProcessQuery,
  filterVerifiedWindowsProcesses,
  filterVerifiedNodeProcesses,
  parseCimProcessResult,
  resolveWindowsExecutable,
  sameWindowsPath,
  selectRunningProfileBinary,
  selectPreferredDiscoveredBinary,
} = require('./windows-process-boundary.js');
const DAEMON_PRIVILEGE = process.platform === 'win32'
  ? (process.env.WBSWITCH_NATIVE_LAUNCHER === '1' ? 'standard' : detectWindowsPrivilege())
  : 'standard';
// ws（WebSocketServer）用于 DevTools 代理：Electron 的 CDP server 拒绝带 Origin 的 WS 连接
// （浏览器必带 Origin → DevTools 前端 "websocket disconnected"），daemon 代理中转去掉 Origin
let wsLib = null;
try { wsLib = require('ws'); } catch (_) {
  // 打包到 WorkDaddy.app 内的相对路径（开箱即用）
  const cands = [
    path.join(__dirname, 'node_modules', 'ws'),
    path.join(__dirname, '..', '..', 'scripts', 'node_modules', 'ws'),
    '/Users/h/.workbuddy/binaries/node/workspace/node_modules/ws',
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'ws'),
  ];
  for (const c of cands) {
    try { wsLib = require(c); break; } catch (_) {}
  }
}
// Node 22 提供全局 WebSocket，但 macOS 用户常见的 Node 18/20 没有；app 内置 ws 作为统一兜底。
const WebSocketCtor = globalThis.WebSocket || (wsLib && (wsLib.WebSocket || wsLib));
const {
  AUTH_FILE,
  defaultDataDir,
  logFile,
  ensureDirs,
  readAuthFile,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
  backupPath,
  updateMeta,
  canonicalWorkspace,
  getAutoCopyRules,
  setAutoCopyRule,
  getAutoCopySession,
  getAutoCopySessionMembers,
  getAutoCopySessionMemberRecords,
  selectLatestAutoCopyMember,
  ensureAutoCopySession,
  addAutoCopySessionMember,
  moveAutoCopySession,
  removeAutoCopySession,
  removeAutoCopyAccount,
  getAutoCopyMapping,
  setAutoCopyMapping,
  deleteAutoCopyMapping,
  workbuddyModelsFile,
  listOfficialModels,
  readOfficialModel,
  deleteOfficialModels,
  listModelBackups,
  backupOfficialModel,
  copyModelBackup,
  editModelBackup,
  deleteModelBackups,
  enableModelBackup,
  importModels,
  checkinDisplayValue,
} = require('./lib.js');
const { extractCreditSegments, sortCreditSegments, mergeCreditSegments, parseEnterpriseUsage, ENTERPRISE_EDITIONS } = require('./credit-segments.js');
const { buildCreditResourceBody } = require('./credit-resource-queries.js');
const { fetchUsageSinceAnchor, startOfLocalDay } = require('./credit-request-usage.js');
const { createCreditUsageStore } = require('./credit-usage-store.js');
const { classifyCheckinResult } = require('./checkin-result.js');
const { fetchGrowthTodayActive } = require('./growth-active.js');
const {
  captureException,
  captureMessage,
  setTelemetryEnabled,
  telemetryEnabled,
  telemetryEnvironmentOverride,
} = require('./sentry-report.js');
const { getProfile, profileDataDir, listInstalledModelSources } = require('./profiles.js');
const { readWorkBuddyTarget } = require('./workbuddy-target.js');
const { classifyTarget, looksLikeWbFamilyTarget, isTargetForProfile } = require('./cdp-targets.js');
const { createSessionDb, normalizeSessionIdBatch, parameterCount } = require('./session-db.js');
const {
  createEncryptedExport,
  openEncryptedExport,
  remapSessionArchivePath,
  requiredPassword,
  resolveArchiveTarget,
} = require('./secure-transfer.js');
const { replaceFileWithRetry } = require('./atomic-file-write.js');
const { parseUiPortState, profileUiPortCandidates } = require('./ui-port.js');

const PROFILE = getProfile();
const DATA_DIR = defaultDataDir();
// 版本号：改动 daemon/inject/theme-patches/builtin 资产后递增，launcher 检测到运行中版本不一致会强制用 app 内置代码重启
// 0.6.6：品牌 HelloBuddy→WorkDaddy 期间版本号未递增，旧 HelloBuddy daemon 会被 launcher 误判为"同版本"而不重启，导致旧代码继续注入；递增后强制升级
// 0.6.7：新增「关于」tab（/api/about + __WBS_VERSION__ 注入）；必须递增，否则旧 daemon 不重启、面板看不到关于页
// 0.6.8：关于页精简（只留版本 + GitHub 链接），仓库改为 github.com/babygoton/WorkDaddy，去掉 logo/原理/平台/运行时
// 1.0.0：正式统一版本号（Info.plist / daemon / dmg 对齐 1.0.0），关于页改单行紧凑布局
// 1.0.1：自动更新（业界标准链路：GitHub Releases API 检查 → dmg 下载+SHA256 校验 → 辅助脚本替换 → relaunch）
// 1.0.2：代码块容器 /.cb-markdown-pre-container 毛玻璃 + chat widget 容器毛玻璃 + 表头半透明（theme-patches patch-77/78）
// 1.0.3：欢迎页隐藏暂存提示词按钮（inject isWelcomePage）；chat widget 预览 iframe 背景透明（patch-80 + inject 同源注入兜底）；
//       默认主题改为「WorkBuddy 默认主题」（首次初始化/面板回退不再指向 nebula）
// 1.0.4：macOS dmg 打包修复（launcher 可执行位）
// 1.0.5：修复自动更新「缺少解包后的新应用」——下载阶段只落 .dmg 从未解包，
//       applyUpdate 现改为在安装前调用 extractAppFromDmg 解出 WorkDaddy.app（幂等），
//       解包函数亦增强（清理残留挂载点、只读挂载、校验 dmg 内存在 WorkDaddy.app）
// 1.0.5（修复版打包）：修复 Windows 自动更新三大卡死根因，让「更新已启动，WorkDaddy 即将重启」
//     到真正更新完成：
//     ① daemon spawn powershell 曾被 detached:true + stdio:'ignore' 拉起，PowerShell 5.1（console 程序）
//       在 detached（无控制台）下宿主静默退出、-File 脚本从不执行 → apply.log 永不生成、替换永不发生；
//     ② 即便去掉 detached，Node 在 Windows 上给子进程套的 Job Object 会在 daemon 退出时（KILL_ON_JOB_CLOSE）
//       连带杀死 powershell，替换中断在「停止 watchdog」一步；
//     ③ 发布包内曾混入非 ASCII 文件名（安装失败自主解决提示词.txt），Windows .NET Expand-Archive 解压时
//       文件名解码成非法字符直接抛「路径中具有非法字符」→ 备份/替换/回滚全部失效。
//     修复：更新脚本改由 wscript.exe（GUI 子系统）+ apply-update.vbs 中介经 ShellExecute 启动独立进程树，
//     daemon 随即自我退出释放文件锁；apply-update.ps1 对 watchdog 与端口进程一律按 PID 精确结束，
//     避免连坐自身；打包脚本 build-win-zip.sh 增加非 ASCII 文件名守护，杜绝中文/特殊字符条目进入安装包。
//     另：daemon 单实例锁、启动竞态修复、注入结果校验与本地诊断快照；
//       修复跨平台自动更新并展示按到期时间拆分的积分明细
// 1.0.7：兼容无全局 WebSocket 的 Node 18/20，使用内置 ws 建立 CDP
// 1.0.8：Windows 数据目录锁文件遇到权限/残留 ACL 时，降级到用户临时目录锁，避免 daemon 未捕获退出
// 历史：去除 launchd 重定向造成的重复日志，并记录 launcher 选择的 Node 运行时
// 1.0.9：诊断快照中的常见 token 字段脱敏
// 1.0.10：daemon.log 按 10 MB 滚动保留最近 3 份，避免长期运行无限增长
// 1.0.11：「登录新账号」新增「无感登录」（OAuth state 轮询采集，流程同 workbuddy-switch），
//         不退出 WorkBuddy 即可把新账号入库；/api/open-url 供系统浏览器打开授权页
// 1.0.12：修复旧 daemon 与新版使用同一 build 标识导致启动器复用旧内存代码；
//         账号切换始终使用 JSON 替换 + CDP 刷新，不退出 WorkBuddy
// 1.0.13：Windows 安装/更新释放 launcher.cmd 文件锁；延长 CDP 启动等待；
//         补充便携版 WorkBuddy 路径探测，并在重启后恢复主窗口
// 1.0.14：自动更新使用独立尝试记录、严格脚本退出码、安装后 daemon 校验；
//         macOS 不再把更新目标硬编码为 /Applications/WorkDaddy.app
// 1.0.15：会话/空间自动复制规则，切换账号后异步幂等复制并提供进度状态
// 1.0.16：全局会话 lineage、迁移/删除清理、快速切换复制队列与任务组只读
// 1.0.17：会话摘要去重统计与本地模型备份/启用管理
// 1.0.18：模型页展示脱敏详情，支持官方/本地模型批量操作及本地备份复制/编辑
// 1.0.19：官方模型批量删除、模型卡片稳定布局与固定 650px 面板
// 1.0.20：模型卡片悬浮操作、官方连通测试、完整长度脱敏 API Key
// 1.0.21：模型页改为当前/备选模型列表风格，去除刷新入口并优化字段排版
// 1.0.15：新增「免打扰」模块（增强页）：基于 WorkBuddy 官方 sandbox 配置通道的 5 个开关，
//        写入 ~/.workbuddy/settings.json 的 sandbox 域（excludedCommands/extraAllowWrite/
//        批量删除阈值/删除保护）+ 弹窗自动点允许兜底（含审计）。
// 1.0.16：修复免打扰「自动点允许」在 WorkBuddy AI 端无效：AI 拦截卡选项按钮带序号前缀
//        （「1允许」「2本次会话内始终允许」）导致 once 匹配落空；文件/敏感路径拦截文案
//        （「检测到受保护文件修改」等）不含旧关键词表导致语境校验失败。改为按钮文本
//        规范化 + 加入「允许+拒绝」决策组结构化语境（自动排除积分/资费确认弹窗，绝不
//        自动扣费），并在禁用按钮/点击异常处加护栏，避免误触与渲染进程异常。
// 1.0.17：Windows 退出失败时对剩余 PID 请求一次提权 taskkill；HTTP 异步响应增加幂等保护，避免重复写 headers。
// 1.0.18：Windows 更新包缺少 apply-update.vbs 时，在可写更新目录生成运行时桥接，避免更新直接失败。
// 1.0.19：更新缓存按 daemon/应用版本校验后再复用；补强 Windows 客户端路径探测。
// 1.0.20：修复标准工作区被误判为任务会话；复制文件时跳过源目录到自身子目录的无效操作。
// 1.0.21：按个人中心四类资源查询积分；合并同一赠送包的多条额度记录。
// 1.0.22：对齐 WorkBuddy v2 全量资源接口，避免 PackageCodes 白名单漏掉赠送/付费额度。
// 1.0.23：手动注入确认组件已挂载；注入失败不再让 Windows launcher 假报成功。
// 1.0.24：下载尚未收到数据时隐藏 0 B/s 和未知剩余时间文案。
// 1.0.9：WorkBuddy / WorkBuddy AI profile 隔离；修复 Windows launcher 的本地端口探测、
//        AI 端 CDP 误连国内端、watchdog 路径和退出确认问题。
// 1.0.13：下载使用唯一临时文件并在校验通过后原子替换，防止并发更新造成 ENOENT。
// 1.0.25：会话删除仅作用于数据库匹配记录，并在清理失败时保留可重试的数据库记录。
// 1.0.26：Windows launcher/logout 取消脚本提权与镜像名结束，只操作同安装目录的已验证 PID。
// 1.0.27：会话数据库查询在原生 SQLite 与 CLI fallback 上统一使用绑定参数。
// 1.0.28：诊断遥测和完整渲染器日志改为显式 opt-in，移除输入框内容调试落盘，
//         并修正文档与打包排障提示中的网络、隐私和用户同意边界。
// 1.0.25：持续会话模块（会话异常中断 Auto-Continue）：写入 app-config.customPrompt 指令块 + 开关状态 API。
// 1.0.31：launcher 注入请求支持后台重试；daemon 复用同一轮手动注入，避免 renderer 未就绪时报假错。
// 1.0.39：暂存队列按稳定 item id 识别，避免普通提示词被误判；异步清空增加输入内容守卫。
// 1.0.40：关于页诊断开关简化、备选模型改名后按新名称重分组、自动复制规则触发修复。
// 1.0.41：workspace 自动复制键保留 Windows 原始路径大小写，与 macOS 行为一致。
// 1.0.43：企业账号积分查询（对齐官方 AuthProductCoordinator.getAccountUsage 分流）：
//         enterpriseId 非空（或 type ∈ {ultimate, exclusive}）→ 调 get-enterprise-user-usage
//         （带 X-Enterprise-Id/X-Tenant-Id），limitNum===-1 显示「不限量」，否则剩余=limitNum-credit；
//         老备份缺 enterpriseId 时从 /console/accounts 补拉一次；个人账号路径不变。
// 1.0.46：Windows 持续扫描仍有消息文件但 cwd 被删除的会话工作目录；只创建
//         数据库已有记录且能在 WorkBuddy 数据目录中找到会话载荷的目录，不改数据库和消息文件。
// 1.0.47：自动复制按 lineage 成员做第二重幂等校验，映射丢失时复用已有目标会话。
// 1.0.48：Windows 自动更新优先静默安装同 profile Setup.exe，旧 ZIP 作为兼容回退。
// 1.0.49：主题 CDP 应用增加异常回读/重试，失败主题不再覆盖已保存主题。
// 1.0.18：主题应用在页面刷新/切换期间自动重连 CDP，并补充失败诊断。
// 1.1.0：Windows launcher 固定传递 profile UI 端口；显式端口冲突时不再递增到相邻 profile。
// 1.1.2：当前登录账号通过官方请求用量接口增量同步；SQLite 按账号持久化，并为所有账号回显今日用量缓存。
// 1.1.3：账号面板稳定置顶当前登录账号。
// 1.1.5：区分“当天已同步但用量为零”和“从未同步”，已同步零用量显示 0.00。
// 1.1.6：今日用量标签复用积分 AI 图标，并统一展示文案。
// 1.1.7：Windows 启动可靠性、profile 隔离 UI 端口、原子配置写入和 CIM 竞态修复。
// 1.1.8：签到只接受明确成功响应并写入 SQLite；悬浮球释放时增加阻尼回弹。
// 1.1.9：签到请求进行中仍立即展示已确认的今日签到标记。
// 1.1.10：账号支持选择性导出；会话和快捷短语支持强制密码加密导入导出。
// 1.1.11：会话导入成功后通过 CDP 刷新 WorkBuddy 窗口，使新会话立即载入。
// 1.1.12：VPC/便携版可通过用户数据目录配置 WorkBuddy 路径与版本。
// 1.1.14：Windows 安装器依赖改为仅在 Windows 更新分支加载，避免 macOS daemon 启动失败。
// 1.1.15：新版 WorkBuddy 按 DOM/队列能力适配，不再把新版布局等同于 AI profile。
// 1.1.16：元素检查器改为 WorkDaddy 插件内弹窗，支持 DOM 树、悬停高亮和重叠元素浏览，不再提供独立页面。
// 1.1.24：6 号官方壁纸替换为新默认图；消息导航与机器人瞳孔改为悬浮毛玻璃。
// 1.1.25：内置官方壁纸更新时刷新数据目录旧副本；新 profile 默认启用 WorkDaddy 壁纸主题。
// 1.1.26：daemon 启动 30 秒后补签，并将全账号签到兜底周期缩短为 1 小时。
// 1.1.27：修复 Windows 原生启动路径发现、旧托管 Node 升级和首次会话播种失败；补充脱敏启动诊断与匿名安装 ID。
// 1.1.28：Windows 安装向导支持选择并锁定 WorkBuddy 客户端，企业版使用进程级环境变量 CDP。
// 1.1.28：修复首次会话播种的 profile 目录缺失，以及 native lifecycle helper 误计自身进程。
// 1.1.29：自动复制会话按 lineage 内最新消息文件做双向全成员同步，避免跨账号往返后历史分叉。
// 1.1.30：新增「今日活跃」查询接口（成长中心热力墙 is_active），复用签到 Bearer 鉴权与 profile 归属域名。
const DAEMON_VERSION = '1.1.30';
const DAEMON_BUILD_ID = 'release-1.1.30-20260901-growth-active';
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32'; // Windows 移植：平台分支开关（macOS 行为保持不变）
// Windows 安装目录（install.ps1 铺、launcher 用、更新替换目标），对应 macOS 的 /Applications/WorkDaddy.app
const WORKDADDY_INSTALL_NAME = PROFILE.id === 'workbuddy-ai' ? 'WorkDaddy AI' : 'WorkDaddy';
const WORKDADDY_DIR_WIN = process.env.WBSWITCH_APP_DIR || path.resolve(__dirname, '..');
const UI_PORT_BASE = parseInt(process.env.WBSWITCH_PORT || String(profileUiPortCandidates(PROFILE.id)[0]), 10);
const ALLOW_UI_PORT_FALLBACK = !process.env.WBSWITCH_PORT;
let ACTUAL_PORT = UI_PORT_BASE; // 实际监听端口（可能回退到当前 profile 的备用端口）
const PROFILE_CDP_PORT = { 'workbuddy-cn': 9222, 'workbuddy-ai': 9223, 'codebuddy-cn': 9224, 'codebuddy-intl': 9225 };
const CDP_PORT_HINT = process.env.WBSWITCH_CDP_PORT
  ? parseInt(process.env.WBSWITCH_CDP_PORT, 10)
  : (Number(PROFILE.cdp && PROFILE.cdp.port) || PROFILE_CDP_PORT[PROFILE.id] || null);
const CDP_PORT_FILE = path.join(DATA_DIR, 'cdp-port.json');
const UI_PORT_FILE = path.join(DATA_DIR, 'ui-port.json');
const API_TOKEN_FILE = path.join(DATA_DIR, '.api-token');
const CREDIT_USAGE_DB_FILE = path.join(DATA_DIR, 'credit-usage.db');
const CREDIT_USAGE_STORE = createCreditUsageStore({ dbPath: CREDIT_USAGE_DB_FILE, profileId: PROFILE.id });
const CREDIT_USAGE_REFRESH_MS = 15000;
const creditUsageSyncInFlight = new Map();
const WATCH_INTERVAL = 3000; // 文件监听兜底
const BACKUP_DEBOUNCE = 1500; // CDP 事件触发的备份防抖
const CDP_RECONNECT_MS = 5000;

// API token 是当前 profile 的本地能力凭证：只注入 WorkBuddy renderer，不写日志、不回传状态接口。
// 用 wx + 重读避免两个 watchdog 进程启动竞态时各自生成一枚 token。
function loadApiToken() {
  const valid = (value) => /^[a-f0-9]{64}$/i.test(String(value || '').trim());
  try {
    const current = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    if (valid(current)) return current;
  } catch (_) {}
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(API_TOKEN_FILE, generated + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(API_TOKEN_FILE, 0o600); } catch (_) {}
    return generated;
  } catch (_) {
    try {
      const existing = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
      if (valid(existing)) return existing;
    } catch (_) {}
    // 极端情况下数据目录不可写：只在内存中继续运行，启动器会从注入面板路径恢复；不记录 token。
    return generated;
  }
}

const API_TOKEN = loadApiToken();

// 遥测开关统一控制远程 Sentry 与本地脱敏渲染器诊断；每次读取都能响应关于页的即时修改。
let diagnosticsState = { value: null, checkedAt: 0 };
function diagnosticsEnabled() {
  const now = Date.now();
  if (diagnosticsState.value === null || now - diagnosticsState.checkedAt >= 1000) {
    diagnosticsState = { value: telemetryEnabled(), checkedAt: now };
  }
  return diagnosticsState.value;
}

function redactDiagnosticText(value, maxLength = 2500) {
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 2500;
  return String(value == null ? '' : value)
    .replace(/(authorization\s*[:=]\s*)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,"']+/ig, '$1[redacted]')
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/ig, '$1[redacted]')
    .replace(/(["']?(?:access.?token|refresh.?token|token|cookie|password|api.?key|secret)["']?\s*[:=]\s*)"[^"\r\n]*"/ig, '$1"[redacted]"')
    .replace(/(["']?(?:access.?token|refresh.?token|token|cookie|password|api.?key|secret)["']?\s*[:=]\s*)'[^'\r\n]*'/ig, "$1'[redacted]'")
    .replace(/(["']?(?:access.?token|refresh.?token|token|cookie|password|api.?key|secret)["']?\s*[:=]\s*["']?)[^"'\s,}\]]+/ig, '$1[redacted]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[redacted]')
    .slice(0, limit);
}

function shouldPersistBreadcrumb(body, diagnosticsEnabledOverride = diagnosticsEnabled()) {
  const msg = String(body && body.msg || '');
  const includesExceptionDetails = !!(body && body.extra) || /^crash:/i.test(msg);
  return !!diagnosticsEnabledOverride || !includesExceptionDetails;
}

function validCdpPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function readCdpPortFile() {
  try {
    const value = JSON.parse(fs.readFileSync(CDP_PORT_FILE, 'utf8')).port;
    return validCdpPort(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function writeCdpPortFile(port, logFn = log) {
  if (!validCdpPort(port)) return false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CDP_PORT_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ port, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CDP_PORT_FILE);
    return true;
  } catch (e) {
    try { fs.unlinkSync(`${CDP_PORT_FILE}.tmp.${process.pid}`); } catch (_) {}
    logFn(`[cdp] 保存端口配置失败: ${e.message}`);
    return false;
  }
}

function readUiPortFile() {
  try { return parseUiPortState(fs.readFileSync(UI_PORT_FILE, 'utf8'), PROFILE.id); } catch (_) { return null; }
}

function writeUiPortFile(port, logFn = log) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    replaceFileWithRetry(UI_PORT_FILE, JSON.stringify({
      profileId: PROFILE.id,
      port,
      updatedAt: new Date().toISOString(),
    }) + '\n', 0o600);
    return true;
  } catch (error) {
    logFn(`[http] 保存 UI 端口配置失败: ${error.message}`);
    return false;
  }
}

function cdpPortCandidates() {
  const ports = [];
  const add = (port) => { if (validCdpPort(port) && !ports.includes(port)) ports.push(port); };
  add(CDP_PORT_HINT);
  add(readCdpPortFile());
  for (let port = 9222; port <= 9232; port++) add(port);
  add(9333);
  return ports;
}

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      if (available) {
        try { server.close(() => resolve(true)); } catch (_) { resolve(true); }
      } else {
        try { server.close(); } catch (_) {}
        resolve(false);
      }
    };
    server.once('error', () => finish(false));
    server.listen({ host: HOST, port }, () => finish(true));
  });
}

async function findAvailableCdpPort() {
  for (const port of cdpPortCandidates()) {
    if (await isLocalPortAvailable(port)) return port;
  }
  throw new Error('9222-9232、9333 均被占用，无法为 WorkBuddy 分配 CDP 端口');
}

async function selectCdpPort(logFn = log) {
  const port = await findAvailableCdpPort();
  writeCdpPortFile(port, logFn);
  logFn(`[cdp] 为 WorkBuddy 选择端口 ${port}`);
  return port;
}

/* ================= 自动更新（GitHub Releases 检查 + 下载 + 辅助脚本替换） =================
 * 业界标准（Sparkle 同款链路）：daemon 定时请求 GitHub Releases API 取最新 tag/资产，
 * 面板红点提示 → 用户点更新 → daemon 下载 dmg + SHA-256 校验 → 挂载拷贝出新 app →
 * 写 apply-update.sh 由独立脚本接管替换（运行中的 app 无法自删，必须由外部脚本完成）→ relaunch。
 */
const UPDATE_REPO = process.env.WBSWITCH_UPDATE_REPO || 'babygoton/WorkDaddy';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000; // 每 6 小时检查一次（GitHub 未认证限流 60 次/h）
const UPDATE_REQ_TIMEOUT = 10000; // 网络超时，超时静默失败不阻塞面板
const UPDATE_DIR = path.join(DATA_DIR, 'update'); // 下载/解包目录
const UPDATE_CHECK_CACHE = path.join(DATA_DIR, 'update-check.json');
const UPDATE_ATTEMPT_FILE = path.join(UPDATE_DIR, 'last-attempt.json');
const UPDATE_DEBUG_LOG = path.join(UPDATE_DIR, 'update-debug.log');
// 更新状态机（面板轮询用）：idle | checking | downloading | verifying | installing | done | error
const updateState = {
  status: 'idle',
  latest: null,
  hasUpdate: false,
  assetName: null,
  dmgSha256: null,
  downloaded: false,
  progress: 0, // 0-100
  downloadedBytes: 0,
  totalBytes: 0,
  downloadRate: 0,
  etaSeconds: null,
  message: '',
  error: null,
  checkedAt: 0,
  attemptId: null,
};
let updateTimer = null;
let updateDownloadPromise = null;

function updateDebug(stage, details) {
  const scrub = (value, key = '') => {
    const lower = String(key).toLowerCase();
    if (/token|cookie|authorization|secret|password|private.?key|access.?token/.test(lower)) return '[redacted]';
    if (typeof value === 'string') return value.length > 1200 ? value.slice(0, 1200) + '…' : value;
    if (Array.isArray(value)) return value.map((item) => scrub(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
    }
    return value;
  };
  const entry = {
    at: new Date().toISOString(),
    stage,
    profile: PROFILE.id,
    client: PROFILE.name,
    daemonVersion: DAEMON_VERSION,
    buildId: DAEMON_BUILD_ID,
    ...scrub(details || {}),
  };
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    try {
      if (fs.statSync(UPDATE_DEBUG_LOG).size > 2 * 1024 * 1024) {
        fs.renameSync(UPDATE_DEBUG_LOG, UPDATE_DEBUG_LOG + '.1');
      }
    } catch (_) {}
    fs.appendFileSync(UPDATE_DEBUG_LOG, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function writeUpdateAttempt(attempt) {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const tmp = UPDATE_ATTEMPT_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(attempt, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, UPDATE_ATTEMPT_FILE);
  } catch (e) {
    log('[update] 更新尝试记录写入失败: ' + e.message);
  }
}

function macWorkDaddyAppPath() {
  if (process.env.WBSWITCH_APP_PATH) return path.resolve(process.env.WBSWITCH_APP_PATH);
  const bundledInfo = path.resolve(__dirname, '../../..', 'Contents', 'Info.plist');
  if (fs.existsSync(bundledInfo)) return path.resolve(__dirname, '../../..');
  return `/Applications/${WORKDADDY_INSTALL_NAME}.app`;
}

// wscript.exe 是 Windows 更新链路中唯一能在 daemon 退出后继续运行的中介。
// 正常发布包使用源码中的 apply-update.vbs；旧/残缺包若漏掉该文件，则把等价桥接
// 写到用户可写的更新目录，避免因安装目录只读或文件缺失而无法启动更新。
const RUNTIME_APPLY_UPDATE_VBS = [
  'Option Explicit',
  '',
  "Dim shell, i, cmd",
  'Set shell = CreateObject("WScript.Shell")',
  'If WScript.Arguments.Count = 0 Then WScript.Quit 1',
  'cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File "',
  'For i = 0 To WScript.Arguments.Count - 1',
  '  cmd = cmd & " """ & WScript.Arguments(i) & """"',
  'Next',
  'shell.Run cmd, 0, False',
].join('\r\n') + '\r\n';

function resolveApplyUpdateVbs() {
  const packaged = path.join(__dirname, 'apply-update.vbs');
  try {
    if (fs.statSync(packaged).isFile()) return packaged;
  } catch (_) {}

  const fallback = path.join(UPDATE_DIR, 'apply-update-runtime.vbs');
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.writeFileSync(fallback, RUNTIME_APPLY_UPDATE_VBS, { encoding: 'utf8', mode: 0o600 });
    if (!fs.statSync(fallback).isFile()) throw new Error('运行时桥接文件未生成');
    updateDebug('apply-vbs-fallback', { packaged, fallback });
    return fallback;
  } catch (e) {
    throw new Error(`缺少 apply-update.vbs，且运行时桥接创建失败: ${e.message}`);
  }
}

// 简单 semver 比较：a > b → 1，a < b → -1，相等 → 0（忽略预发布后缀）
function semverCompare(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 带超时的 HTTPS GET（返回 statusCode + body + headers）
function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'WorkDaddy/' + DAEMON_VERSION, Accept: 'application/vnd.github+json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || UPDATE_REQ_TIMEOUT, () => { req.destroy(new Error('request timeout')); });
  });
}

// 从 Release body 解析 SHA-256（发布时把 `SHA256: <hex>` 写进 Release notes）
function parseSha256(body) {
  if (!body) return null;
  const m = String(body).match(/SHA-?256[:：]\s*([a-fA-F0-9]{64})/);
  return m ? m[1].toLowerCase() : null;
}

function normalizeAssetSha256(value) {
  const text = String(value || '').trim().replace(/^sha256:/i, '');
  return /^[a-fA-F0-9]{64}$/.test(text) ? text.toLowerCase() : null;
}

function expectedUpdateSha256() {
  return updateState.dmgSha256 || parseSha256(updateState.notes);
}

// 检查更新：请求 Releases API，比对版本，结果写缓存（内存 + 文件）
function checkUpdate(force) {
  if (!force && updateTimer) {
    // 有缓存且未过期且非强制 → 直接返回缓存（面板高频打开不重复请求）
    if (Date.now() - updateState.checkedAt < UPDATE_CHECK_INTERVAL && updateState.latest) {
      return Promise.resolve(updateState);
    }
  }
  updateState.status = 'checking';
  updateState.message = '正在检查更新…';
  updateDebug('check-start', { force: !!force, current: DAEMON_VERSION, updateApi: UPDATE_API });
  return httpsGet(UPDATE_API)
    .then(({ status, body }) => {
      if (status !== 200) {
        throw new Error('Releases API ' + status + (status === 404 ? '（仓库暂无 Release）' : ''));
      }
      const rel = JSON.parse(body);
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      updateState.latest = latest;
      updateState.hasUpdate = semverCompare(latest, DAEMON_VERSION) > 0;
      updateState.releaseUrl = rel.html_url || null;
      updateState.notes = (rel.body || '').slice(0, 2000);
      // 资产按平台选取：macOS 找 .dmg；Windows 新版本优先同 profile 的 Setup.exe，
      // 旧版本仍只识别 ZIP，因此没有 EXE 时回退到对应的 -win64.zip。
      const assets = rel.assets || [];
      const profileAsset = PROFILE.id === 'workbuddy-ai'
        ? /^(?:WorkDaddy-AI-Setup-|WorkDaddy-AI-).*\.(?:exe|zip|dmg)$/i
        : /^WorkDaddy-(?!AI-)(?:Setup-|).*\.(?:exe|zip|dmg)$/i;
      const profileSetup = PROFILE.id === 'workbuddy-ai'
        ? /^WorkDaddy-AI-Setup-\d+\.\d+\.\d+\.exe$/i
        : /^WorkDaddy-Setup-\d+\.\d+\.\d+\.exe$/i;
      const profileZip = PROFILE.id === 'workbuddy-ai'
        ? /^WorkDaddy-AI-\d+\.\d+\.\d+-win64\.zip$/i
        : /^WorkDaddy-\d+\.\d+\.\d+-win64\.zip$/i;
      const asset = IS_WIN
        ? (assets.find((a) => profileSetup.test(a.name || '')) ||
           assets.find((a) => profileZip.test(a.name || '')) ||
           // tolerate older release naming while keeping profile isolation
           assets.find((a) => profileAsset.test(a.name || '') && /\.(?:exe|zip)$/i.test(a.name || '')) || null)
        : (assets.find((a) => profileAsset.test(a.name || '') && /\.dmg$/i.test(a.name || '')) ||
           assets.find((a) => /\.dmg$/i.test(a.name || '') && (PROFILE.id !== 'workbuddy-ai' || !/WorkDaddy-AI-/i.test(a.name || ''))) || null);
      updateState.dmgUrl = asset ? asset.browser_download_url : null;
      updateState.dmgSize = asset ? asset.size : 0;
      updateState.dmgSha256 = asset ? normalizeAssetSha256(asset.digest) : parseSha256(updateState.notes);
      updateState.assetName = asset ? asset.name : null;
      updateState.checkedAt = Date.now();
      updateState.status = 'idle';
      updateState.message = updateState.hasUpdate ? '发现新版本 v' + latest : '已是最新版本';
      try { fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ latest, hasUpdate: updateState.hasUpdate, dmgUrl: updateState.dmgUrl, dmgSize: updateState.dmgSize, dmgSha256: updateState.dmgSha256, assetName: updateState.assetName, notes: updateState.notes, checkedAt: updateState.checkedAt })); } catch (_) {}
      log(`[update] 检查完成: latest=${latest} hasUpdate=${updateState.hasUpdate} (current=${DAEMON_VERSION})`);
      updateDebug('check-result', { current: DAEMON_VERSION, latest, hasUpdate: updateState.hasUpdate, assetName: updateState.assetName, assetSize: updateState.dmgSize, assetSha256: updateState.dmgSha256 });
      return updateState;
    })
    .catch((e) => {
      updateState.status = 'idle';
      updateState.error = e.message;
      updateState.message = '检查更新失败';
      log(`[update] 检查失败: ${e.message}`);
      updateDebug('check-error', { error: e.message });
      // 尝试读缓存兜底（上次成功的结果）
      try {
        const c = JSON.parse(fs.readFileSync(UPDATE_CHECK_CACHE, 'utf8'));
        updateState.latest = c.latest;
        updateState.hasUpdate = !!c.hasUpdate;
        updateState.dmgUrl = c.dmgUrl;
        updateState.dmgSize = Number(c.dmgSize) || 0;
        updateState.assetName = c.assetName || null;
        updateState.dmgSha256 = normalizeAssetSha256(c.dmgSha256) || parseSha256(c.notes);
        updateState.notes = c.notes;
        updateState.checkedAt = c.checkedAt || Date.now();
      } catch (_) {}
      return updateState;
    });
}

// 下载安装包（macOS .dmg / Windows Setup.exe 或旧 ZIP），流式写文件更新 progress，带 SHA-256 校验
// 同一 daemon 内只允许一个下载流程，避免并发请求互相删除/覆盖固定目标文件。
function downloadUpdate() {
  if (updateDownloadPromise) return updateDownloadPromise;
  updateDownloadPromise = Promise.resolve()
    .then(() => downloadUpdateInternal())
    .finally(() => { updateDownloadPromise = null; });
  return updateDownloadPromise;
}

function downloadUpdateInternal() {
  if (!updateState.dmgUrl) {
    updateDebug('download-error', { error: '无可用安装包', latest: updateState.latest, assetName: updateState.assetName });
    return Promise.reject(new Error('无可用安装包'));
  }
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  updateState.downloaded = false;
  updateState.error = null;
  updateState.downloadedBytes = 0;
  updateState.totalBytes = Number(updateState.dmgSize) || 0;
  updateState.downloadRate = 0;
  updateState.etaSeconds = null;
  const ext = IS_WIN ? (/\.exe$/i.test(updateState.assetName || '') ? '.exe' : '.zip') : '.dmg';
  const updatePrefix = PROFILE.id === 'workbuddy-ai' ? 'WorkDaddy-AI-' : 'WorkDaddy-';
  const target = path.join(UPDATE_DIR, updatePrefix + updateState.latest + ext);
  const tempTarget = target + '.part.' + process.pid + '.' + crypto.randomBytes(8).toString('hex');
  const expectSha = expectedUpdateSha256();
  updateDebug('download-start', {
    latest: updateState.latest,
    assetName: updateState.assetName,
    target: path.basename(target),
    tempTarget: path.basename(tempTarget),
    expectedSha256: expectSha,
    expectedSize: updateState.dmgSize,
  });
  if (!expectSha) {
    const error = new Error('发布未提供可信的 SHA-256，已停止更新');
    updateState.status = 'error';
    updateState.error = error.message;
    updateState.message = '安装包缺少完整性校验，已停止更新';
    updateDebug('download-error', { stage: 'preflight', error: error.message, target: path.basename(target) });
    return Promise.reject(error);
  }
  if (fs.existsSync(target)) {
    const checked = validateUpdateArtifact(target, expectSha);
    if (checked.ok) {
      updateState.downloaded = true;
      updateState.progress = 100;
      updateState.downloadedBytes = fs.statSync(target).size;
      updateState.totalBytes = updateState.downloadedBytes;
      updateState.downloadRate = 0;
      updateState.etaSeconds = 0;
      updateState.status = 'idle';
      updateState.message = '安装包已就绪';
      updateDebug('download-cache-hit', { target: path.basename(target), size: updateState.downloadedBytes });
      return Promise.resolve(target);
    }
    log(`[update] 丢弃缓存安装包 ${path.basename(target)}: ${checked.reason}`);
    try { fs.unlinkSync(target); } catch (_) {}
  }
  updateState.status = 'downloading';
  updateState.progress = 0;
  updateState.message = '正在下载安装包…';
  return new Promise((resolve, reject) => {
    const mod = require('https');
    const cleanupTemp = () => { try { fs.unlinkSync(tempTarget); } catch (_) {} };
    let settled = false;
    const failDownload = (error) => {
      if (settled) return;
      settled = true;
      cleanupTemp();
      updateState.status = 'error';
      updateState.error = error && error.message ? error.message : String(error);
      updateState.message = '下载安装包失败';
      const failure = error instanceof Error ? error : new Error(String(error));
      log(`[update] 下载失败 stage=stream target=${path.basename(target)} temp=${path.basename(tempTarget)}: ${failure.message}`);
      updateDebug('download-error', { stage: 'stream', error: failure.message, target: path.basename(target), tempTarget: path.basename(tempTarget) });
      reject(failure);
    };
    mod.get(updateState.dmgUrl, { headers: { 'User-Agent': 'WorkDaddy/' + DAEMON_VERSION } }, (res) => {
      updateDebug('download-response', { statusCode: res.statusCode, contentType: res.headers['content-type'] || null, contentLength: res.headers['content-length'] || null, target: path.basename(target) });
      if (res.statusCode >= 400) return failDownload(new Error('下载失败 HTTP ' + res.statusCode));
      if ((res.statusCode >= 300) && res.headers.location) {
        // 跟随重定向（GitHub 资产会 302 到 objects.githubusercontent.com）
        updateState.dmgUrl = res.headers.location;
        resolve(downloadUpdateInternal());
        res.resume();
        return;
      }
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (!IS_WIN && /text\/html|application\/json/.test(contentType)) {
        res.resume();
        return failDownload(new Error(`下载响应不是 DMG (content-type=${contentType})`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || updateState.dmgSize;
      let received = 0;
      let lastDebugProgress = -1;
      const startedAt = Date.now();
      updateState.totalBytes = total || 0;
      const out = fs.createWriteStream(tempTarget, { flags: 'wx' });
      res.on('data', (c) => {
        received += c.length;
        updateState.downloadedBytes = received;
        const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
        updateState.downloadRate = Math.round(received / elapsed);
        if (total) {
          updateState.progress = Math.min(99, Math.round((received / total) * 100));
          updateState.etaSeconds = updateState.downloadRate > 0 ? Math.max(0, Math.ceil((total - received) / updateState.downloadRate)) : null;
          if (updateState.progress >= lastDebugProgress + 10) {
            lastDebugProgress = updateState.progress;
            updateDebug('download-progress', { progress: updateState.progress, downloadedBytes: received, totalBytes: total, downloadRate: updateState.downloadRate, etaSeconds: updateState.etaSeconds });
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        updateState.progress = 100;
        updateState.status = 'verifying';
        updateState.message = '校验安装包…';
        const checked = validateUpdateArtifact(tempTarget, expectSha);
        if (!checked.ok) {
          settled = true;
          cleanupTemp();
          updateState.status = 'error';
          updateState.error = checked.reason;
          updateState.message = '安装包校验失败，已删除损坏包';
          log(`[update] 下载失败 stage=verify target=${path.basename(target)} temp=${path.basename(tempTarget)}: ${checked.reason}`);
          return reject(new Error(checked.reason));
        }
        try {
          fs.renameSync(tempTarget, target);
        } catch (error) {
          return failDownload(new Error('安装包落盘失败: ' + error.message));
        }
        settled = true;
        updateState.downloaded = true;
        updateState.status = 'idle';
        updateState.downloadedBytes = checked.size || received;
        updateState.totalBytes = updateState.downloadedBytes;
        updateState.downloadRate = 0;
        updateState.etaSeconds = 0;
        updateState.message = '安装包已就绪（校验通过）';
        log(`[update] 下载完成 ${target} sha256=${checked.digest}`);
        updateDebug('download-verified', { target: path.basename(target), size: received, sha256: checked.digest });
        resolve(target);
      });
      out.on('error', failDownload);
      res.on('error', failDownload);
    }).on('error', failDownload);
  });
}

// 计算文件 SHA-256
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inspectPackagedApp(appDir) {
  const result = { appDir, daemonVersion: null, appVersion: null };
  try {
    const daemonFile = path.join(appDir, 'Contents', 'Resources', 'scripts', 'daemon.js');
    const source = fs.readFileSync(daemonFile, 'utf8');
    const match = source.match(/const DAEMON_VERSION = '([^']+)'/);
    result.daemonVersion = match ? match[1] : null;
  } catch (_) {}
  try {
    const plistFile = path.join(appDir, 'Contents', 'Info.plist');
    const source = fs.readFileSync(plistFile, 'utf8');
    const match = source.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    result.appVersion = match ? match[1] : null;
  } catch (_) {}
  return result;
}

function packagedAppVersionError(artifact, expectedVersion) {
  if (!artifact.daemonVersion) return new Error('安装包内部 daemon 版本不可读');
  if (!artifact.appVersion) return new Error('安装包应用版本不可读');
  if (expectedVersion && semverCompare(artifact.daemonVersion, expectedVersion) !== 0) {
    return new Error(`安装包内部 daemon 版本 ${artifact.daemonVersion} 与目标版本 ${expectedVersion} 不一致`);
  }
  if (expectedVersion && semverCompare(artifact.appVersion, expectedVersion) !== 0) {
    return new Error(`安装包应用版本 ${artifact.appVersion} 与目标版本 ${expectedVersion} 不一致`);
  }
  return null;
}

// 文件存在或没有 Release notes 摘要都不能证明它是可挂载的 DMG：断流、代理错误页
// 和旧版残留文件都可能留下普通文件。hdiutil imageinfo 是 macOS UDIF 的确定性预检。
function validateUpdateArtifact(file, expectSha = null) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return { ok: false, reason: '安装包文件不可读: ' + e.message };
  }
  if (!stat.isFile() || stat.size <= 0) return { ok: false, reason: '安装包为空或不是普通文件' };
  if (updateState.dmgSize > 0 && stat.size !== updateState.dmgSize) {
    return { ok: false, reason: `安装包大小不匹配 (${stat.size} != ${updateState.dmgSize})` };
  }
  if (!IS_WIN) {
    let probe;
    try {
      probe = spawnSync('hdiutil', ['imageinfo', file], {
        encoding: 'utf8', timeout: 20000, windowsHide: true,
      });
    } catch (e) {
      return { ok: false, reason: 'DMG 预检执行失败: ' + e.message };
    }
    if (probe.error || probe.status !== 0) {
      const detail = String(probe.stderr || probe.stdout || probe.error?.message || '未知 hdiutil 错误')
        .replace(/\s+/g, ' ').trim().slice(0, 240);
      return { ok: false, reason: '下载内容不是有效 DMG: ' + detail };
    }
  }
  let digest;
  try { digest = sha256File(file); } catch (e) {
    return { ok: false, reason: '安装包 SHA-256 读取失败: ' + e.message };
  }
  if (expectSha && digest !== expectSha) {
    return { ok: false, reason: `SHA-256 校验失败 (${digest} != ${expectSha})` };
  }
  return { ok: true, digest };
}

// ---------------------------------------------------------------------------
// 无感登录（OAuth state 轮询采集，流程与 workbuddy-switch 一致）：
//   1. POST /v2/plugin/auth/state?platform=workbuddy 申请 state + 授权链接
//   2. 用户在系统浏览器完成扫码授权（WorkBuddy 全程不退出）
//   3. 轮询 GET /v2/plugin/auth/token?state=... 拿 accessToken
//   4. GET /v2/plugin/login/account?state=... 拉账号信息，拼成官方认证文件结构入库
// ---------------------------------------------------------------------------

// 各客户端 API host 与 auth.domain 一致：国内版 www.workbuddy.cn / codebuddy.cn，
// 国际版（WorkBuddy AI / CodeBuddy 国际版）为 www.workbuddy.ai / www.codebuddy.ai。
// 签到、积分查询、无感登录必须打到自己对应域名的接口，不能复用国内 host。
const WB_API_ENDPOINT = PROFILE.apiHost || 'https://www.workbuddy.cn';
const WB_API_PREFIX = '/v2/plugin';
const OAUTH_TIMEOUT_SECONDS = 600;
const OAUTH_RESULT_RETENTION_SECONDS = 300;
const oauthStates = new Map(); // loginId -> { state, expiresAt, done, result, error }

// 时间戳归一化：秒/毫秒/字符串 → 毫秒；无效返回 null
function normTs(v) {
  let ts = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!isFinite(ts) || ts <= 0) return null;
  if (ts < 1e10) ts *= 1000; // 秒 → 毫秒
  return Math.round(ts);
}

// 带超时的 JSON 请求（返回解析后的 JSON；解析失败回退 {code,message}）
function httpJson(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: method || 'GET',
        headers: Object.assign(
          { 'User-Agent': 'WorkDaddy/' + DAEMON_VERSION, Accept: 'application/json' },
          data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
          headers || {}
        ),
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (_) {
            resolve({ code: res.statusCode, message: text.slice(0, 500) });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 把 OAuth token + 账号信息拼成官方 workbuddy-desktop.info 结构
// （{account, auth, accounts, allAccounts}，与 lib.js switchTo 写回的格式一致）
function buildSeamlessAuthFile(tokenData, accData) {
  const now = Date.now();
  const rawToken = tokenData && typeof tokenData === 'object' ? tokenData : {};
  const domain = String(rawToken.domain || '');
  let expiresAt = normTs(rawToken.expiresAt != null ? rawToken.expiresAt : rawToken.expires_at);
  if (expiresAt == null) {
    const expiresIn = Number(rawToken.expiresIn != null ? rawToken.expiresIn : rawToken.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = now + expiresIn * 1000;
  }
  let refreshExpiresAt = normTs(
    rawToken.refreshExpiresAt != null ? rawToken.refreshExpiresAt : rawToken.refresh_expires_at
  );
  if (refreshExpiresAt == null) {
    const refreshExpiresIn = Number(
      rawToken.refreshExpiresIn != null ? rawToken.refreshExpiresIn : rawToken.refresh_expires_in
    );
    if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
      refreshExpiresAt = now + refreshExpiresIn * 1000;
    }
  }

  const accountObj = Object.assign({}, accData && typeof accData === 'object' ? accData : {}, {
    uid: String(accData.uid || ''),
    nickname: String(accData.nickname || ''),
    uin: accData.uin || '',
    phoneNumber: accData.phoneNumber || '',
    type: accData.type || 'personal',
    lastLogin: true,
    pluginEnabled: true,
  });

  // 保留官方响应中的额外字段（例如 idToken/sessionState），只覆盖标准字段。
  // WorkBuddy 后续可能依赖这些字段，不能把 OAuth 响应压缩成固定白名单。
  const authObj = Object.assign({}, rawToken, {
    accessToken: String(rawToken.accessToken || rawToken.access_token || ''),
    refreshToken: String(rawToken.refreshToken || rawToken.refresh_token || ''),
    tokenType: String(rawToken.tokenType || rawToken.token_type || 'Bearer'),
    domain,
    lastRefreshTime: now,
    scope: rawToken.scope || 'openid profile offline_access email',
    notBeforePolicy: rawToken.notBeforePolicy != null ? rawToken.notBeforePolicy : 0,
    sessionState: rawToken.sessionState || '',
  });
  if (expiresAt != null) {
    authObj.expiresAt = expiresAt;
    authObj.expiresIn = Math.max(0, Math.round((expiresAt - now) / 1000));
    authObj.refreshExpiresAt = refreshExpiresAt != null ? refreshExpiresAt : expiresAt;
    authObj.refreshExpiresIn = Math.max(0, Math.round((authObj.refreshExpiresAt - now) / 1000));
  } else {
    authObj.expiresIn = 0;
    authObj.refreshExpiresIn = 0;
  }

  // 合并现有登录文件里的 allAccounts（按 uid 去重），保持与官方文件结构一致
  let all = [];
  try {
    const cur = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const arr = cur.allAccounts || cur.accounts;
    if (Array.isArray(arr)) all = arr;
  } catch (_) {}
  all = all.filter((a) => a && a.uid !== accountObj.uid);
  all.push(accountObj);

  return { account: accountObj, auth: authObj, accounts: all, allAccounts: all };
}

function scheduleOAuthStateCleanup(loginId) {
  const timer = setTimeout(() => oauthStates.delete(loginId), OAUTH_RESULT_RETENTION_SECONDS * 1000);
  if (timer.unref) timer.unref();
}

// 把无感登录采集到的账号写入 accounts/<uid>.info 备份（不触碰当前登录文件）
function saveSeamlessAccount(tokenData, accData) {
  const uid = String(accData.uid || '');
  if (!uid) throw new Error('官方接口未返回 uid，无法保存账号');
  ensureDirs(DATA_DIR);
  const session = buildSeamlessAuthFile(tokenData, accData);
  const dest = backupPath(DATA_DIR, uid);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  updateMeta(DATA_DIR, {
    uid,
    nickname: accData.nickname || '',
    uin: accData.uin || '',
    phone: accData.phoneNumber || '',
  });
  log(`[oauth] 无感登录已入库账号 ${accData.nickname || uid} (${uid}) -> ${dest}`);
  return { uid, nickname: accData.nickname || '', email: accData.email || '' };
}

// 轮询一次授权结果：未完成返回 {done:false}；完成则入库并返回账号信息
async function oauthPollOnce(loginId) {
  const info = oauthStates.get(loginId);
  if (!info) return { done: true, error: '登录请求不存在或已过期' };
  if (info.done) return { done: true, result: info.result, error: info.error };
  if (Date.now() > info.expiresAt) {
    info.done = true;
    info.error = '登录超时，请重新发起';
    scheduleOAuthStateCleanup(loginId);
    return { done: true, error: info.error };
  }
  const tokenResp = await httpJson(
    `${WB_API_ENDPOINT}${WB_API_PREFIX}/auth/token?state=${encodeURIComponent(info.state)}`,
    'GET'
  );
  const code = tokenResp && typeof tokenResp.code === 'number' ? tokenResp.code : -1;
  if (code !== 0 && code !== 200) return { done: false };
  const data = tokenResp.data || {};
  const accessToken = data.accessToken || data.access_token || '';
  if (!accessToken) return { done: false };

  // 已授权：拉取账号信息并入库
  const accHeaders = { Authorization: `Bearer ${accessToken}` };
  if (data.domain) accHeaders['X-Domain'] = data.domain;
  const accResp = await httpJson(
    `${WB_API_ENDPOINT}${WB_API_PREFIX}/login/account?state=${encodeURIComponent(info.state)}`,
    'GET',
    null,
    accHeaders
  );
  const accData = (accResp && accResp.data) || {};
  info.done = true;
  try {
    info.result = saveSeamlessAccount(data, accData);
  } catch (e) {
    info.error = e.message;
  }
  scheduleOAuthStateCleanup(loginId);
  return { done: true, result: info.result, error: info.error };
}

// 从 dmg 中解出 WorkDaddy.app 到 UPDATE_DIR（挂载→拷贝→卸载），返回 app 目录
function extractAppFromDmg(dmgPath) {
  const mountPoint = '/Volumes/WorkDaddy-update';
  const appPackageName = WORKDADDY_INSTALL_NAME + '.app';
  const appDest = path.join(UPDATE_DIR, appPackageName);
  return new Promise((resolve, reject) => {
    const exec = require('child_process').execFile;
    const checked = validateUpdateArtifact(dmgPath, expectedUpdateSha256());
    if (!checked.ok) {
      log(`[update] DMG 预检失败 ${path.basename(dmgPath)}: ${checked.reason}`);
      reject(new Error(`DMG 预检失败: ${checked.reason}`));
      return;
    }
    // 先清理可能残留的挂载点（上次更新失败/中断会遗留，direct attach -mountpoint 会报 Resource busy），
    // 再用只读 + 免校验挂载（只取包内容，不做写操作）
    exec('hdiutil', ['detach', mountPoint, '-force'], () => {
      exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint, dmgPath], (err) => {
        if (err) {
          const detail = String(err.stderr || err.message || '未知 hdiutil 错误').replace(/\s+/g, ' ').trim().slice(0, 300);
          log(`[update] hdiutil attach 失败 ${path.basename(dmgPath)}: ${detail}`);
          return reject(new Error('挂载 dmg 失败: ' + detail));
        }
        const src = path.join(mountPoint, WORKDADDY_INSTALL_NAME + '.app');
        if (!fs.existsSync(src)) {
          exec('hdiutil', ['detach', mountPoint, '-force'], () => reject(new Error(`dmg 中未找到 ${WORKDADDY_INSTALL_NAME}.app`)));
          return;
        }
        fs.rmSync(appDest, { recursive: true, force: true });
        const cp = require('child_process').spawn('cp', ['-R', src, appDest], { stdio: 'ignore' });
        cp.on('close', (code) => {
          exec('hdiutil', ['detach', mountPoint, '-force'], () => {
            if (code !== 0 || !fs.existsSync(path.join(appDest, 'Contents', 'Info.plist'))) {
              return reject(new Error('解包应用失败'));
            }
            const artifact = inspectPackagedApp(appDest);
            updateDebug('artifact-inspect', { expectedVersion: updateState.latest, daemonVersion: artifact.daemonVersion, appVersion: artifact.appVersion, source: path.basename(dmgPath) });
            const versionError = packagedAppVersionError(artifact, updateState.latest);
            if (versionError) return reject(versionError);
            resolve(appDest);
          });
        });
        cp.on('error', (e) => { exec('hdiutil', ['detach', mountPoint, '-force'], () => reject(e)); });
      });
    });
  });
}

// 安装：macOS 继续使用 apply-update.sh；Windows 打开已校验的可见 Setup.exe，
// 由 Inno Setup 确认 WorkBuddy 已退出、替换文件并启动新版。
function applyUpdate() {
  if (!updateState.downloaded) {
    updateDebug('apply-error', { stage: 'preflight', error: '尚未下载完成', latest: updateState.latest });
    return Promise.reject(new Error('尚未下载完成'));
  }
  updateState.status = 'installing';
  updateState.message = '正在安装新版本…';
  updateState.error = null;
  const { spawn } = require('child_process');
  const attempt = {
    id: crypto.randomUUID(),
    status: 'starting',
    platform: process.platform,
    fromVersion: DAEMON_VERSION,
    targetVersion: updateState.latest,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    dataDir: DATA_DIR,
    debugLog: UPDATE_DEBUG_LOG,
  };
  updateState.attemptId = attempt.id;
  writeUpdateAttempt(attempt);
  updateDebug('apply-start', { attemptId: attempt.id, fromVersion: DAEMON_VERSION, targetVersion: updateState.latest, platform: process.platform });
  const applyLog = path.join(UPDATE_DIR, 'apply.log');
  const markAttemptFailure = (error, stage = 'update-script') => {
    attempt.status = stage;
    attempt.finishedAt = new Date().toISOString();
    attempt.error = error && error.message ? error.message : String(error);
    writeUpdateAttempt(attempt);
    log('[update] 更新尝试失败 stage=' + stage + ': ' + attempt.error);
    updateDebug('apply-error', { stage, attemptId: attempt.id, targetVersion: updateState.latest, error: attempt.error });
    captureException(error, { stage, extra: { platform: process.platform, attemptId: attempt.id, targetVersion: updateState.latest } }).catch(() => {});
  };
  const markSpawnFailure = (error) => markAttemptFailure(error, 'spawn-error');
  if (IS_WIN) {
    const { launchWindowsInstaller } = require('./windows-installer-launch.js');
    // Windows 更新只负责打开已经过 SHA-256 校验的可见 Setup.exe。
    // 文件替换、WorkBuddy 退出确认和新版启动全部由 Inno Setup 接管；
    // daemon/watchdog 在安装器真正开始复制前保持运行，因此 UI 不会失联。
    const updatePrefix = PROFILE.id === 'workbuddy-ai' ? 'WorkDaddy-AI-' : 'WorkDaddy-';
    const packageExt = /\.exe$/i.test(updateState.assetName || '') ? '.exe' : '.zip';
    const srcPackage = path.join(UPDATE_DIR, updatePrefix + updateState.latest + packageExt);
    if (!fs.existsSync(srcPackage)) {
      const error = new Error('缺少已下载的新版本安装包');
      markAttemptFailure(error, 'preflight-error');
      return Promise.reject(error);
    }
    if (packageExt !== '.exe') {
      const error = new Error('此历史版本只提供 ZIP，无法使用新的可见安装流程；请从发布页下载 Setup.exe');
      markAttemptFailure(error, 'unsupported-artifact');
      return Promise.reject(error);
    }
    const expectedAsset = PROFILE.id === 'workbuddy-ai'
      ? `WorkDaddy-AI-Setup-${updateState.latest}.exe`
      : `WorkDaddy-Setup-${updateState.latest}.exe`;
    if (String(updateState.assetName || '').toLowerCase() !== expectedAsset.toLowerCase()) {
      const error = new Error('安装包名称与目标 profile 或版本不一致');
      markAttemptFailure(error, 'artifact-identity');
      return Promise.reject(error);
    }
    attempt.sourcePackage = srcPackage;
    attempt.assetName = updateState.assetName;
    writeUpdateAttempt(attempt);
    updateDebug('installer-open', { attemptId: attempt.id, sourcePackage: srcPackage, assetName: updateState.assetName });
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = launchWindowsInstaller(srcPackage);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        markSpawnFailure(error);
        updateState.status = 'error';
        updateState.message = '无法打开安装程序';
        updateState.error = error.message;
        reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        attempt.status = 'installer-opened';
        attempt.installerPid = child.pid;
        attempt.finishedAt = new Date().toISOString();
        writeUpdateAttempt(attempt);
        updateState.status = 'installer-opened';
        updateState.message = '安装程序已打开';
        updateDebug('installer-opened', { attemptId: attempt.id, pid: child.pid, assetName: updateState.assetName });
        resolve({ ok: true, opened: true, status: 'installer-opened', message: '安装程序已打开，请按提示完成安装' });
      });
    });
  }
  const scriptPath = path.join(__dirname, 'apply-update.sh');
  const appPath = macWorkDaddyAppPath();
  const srcApp = path.join(UPDATE_DIR, WORKDADDY_INSTALL_NAME + '.app');
  if (!fs.existsSync(scriptPath)) {
    const error = new Error('缺少 apply-update.sh');
    markAttemptFailure(error, 'preflight-error');
    return Promise.reject(error);
  }
  // 解出新应用：下载阶段只落了 .dmg，这里才把 WorkDaddy.app 从 dmg 解到 UPDATE_DIR（幂等：已解出则复用）
  const updatePrefix = PROFILE.id === 'workbuddy-ai' ? 'WorkDaddy-AI-' : 'WorkDaddy-';
  const dmgPath = path.join(UPDATE_DIR, updatePrefix + updateState.latest + '.dmg');
  const cachedArtifact = fs.existsSync(srcApp) ? inspectPackagedApp(srcApp) : null;
  const cachedMatches = Boolean(
    cachedArtifact &&
    cachedArtifact.daemonVersion &&
    cachedArtifact.appVersion &&
    updateState.latest &&
    semverCompare(cachedArtifact.daemonVersion, updateState.latest) === 0 &&
    semverCompare(cachedArtifact.appVersion, updateState.latest) === 0
  );
  updateDebug('artifact-cache', {
    expectedVersion: updateState.latest,
    cachedDaemonVersion: cachedArtifact && cachedArtifact.daemonVersion,
    cachedAppVersion: cachedArtifact && cachedArtifact.appVersion,
    reused: cachedMatches,
  });
  const preUnpack = cachedMatches
    ? Promise.resolve(srcApp)
    : (fs.existsSync(dmgPath)
        ? (updateState.message = '正在解包新应用…', extractAppFromDmg(dmgPath))
        : Promise.reject(new Error('缺少安装包（未找到已下载的 dmg）')));
  return preUnpack.then((p) => {
    if (!fs.existsSync(p)) throw new Error('缺少解包后的新应用');
    const artifact = inspectPackagedApp(p);
    updateDebug('artifact-ready', { expectedVersion: updateState.latest, daemonVersion: artifact.daemonVersion, appVersion: artifact.appVersion, source: path.basename(p) });
    const versionError = packagedAppVersionError(artifact, updateState.latest);
    if (versionError) throw versionError;
    attempt.sourceApp = p;
    attempt.targetApp = appPath;
    writeUpdateAttempt(attempt);
    log('[update] 执行 apply-update.sh attempt=' + attempt.id + ' src=' + p + ' dst=' + appPath + ' log=' + applyLog);
    updateDebug('apply-script-start', { script: 'apply-update.sh', attemptId: attempt.id, sourceApp: p, targetApp: appPath, applyLog });
    const child = spawn('bash', [scriptPath, p, appPath, String(ACTUAL_PORT), applyLog, attempt.id, PROFILE.id], { detached: true, stdio: 'ignore' });
    child.once('error', markSpawnFailure);
    child.once('spawn', () => {
      attempt.status = 'script-started';
      attempt.scriptPid = child.pid;
      writeUpdateAttempt(attempt);
      log('[update] apply-update.sh 已启动 pid=' + child.pid);
      updateDebug('apply-script-spawned', { script: 'apply-update.sh', attemptId: attempt.id, pid: child.pid });
    });
    child.unref();
    return { ok: true, message: '已启动更新，正在替换文件并自动重启，请稍候…' };
  }).catch((error) => {
    updateState.status = 'error';
    updateState.error = error.message;
    updateState.message = '安装包版本校验失败';
    if (attempt.status === 'starting') markAttemptFailure(error, 'preflight-error');
    throw error;
  });
}


let logWriteCount = 0;
function rotateLogsIfNeeded() {
  if (++logWriteCount % 100 !== 0) return;
  const file = logFile(DATA_DIR);
  try {
    if (fs.statSync(file).size < 10 * 1024 * 1024) return;
    for (let i = 2; i >= 1; i--) {
      const older = file + '.' + i;
      const newer = file + '.' + (i + 1);
      try { fs.unlinkSync(newer); } catch (_) {}
      try { fs.renameSync(older, newer); } catch (_) {}
    }
    fs.renameSync(file, file + '.1');
  } catch (_) {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] [client=${PROFILE.name}] [profile=${PROFILE.id}] ${args.join(' ')}\n`;
  // launchd/nohup 已把 stdout 重定向到同一个文件；只写一次，避免每条日志重复。
  try {
    rotateLogsIfNeeded();
    fs.appendFileSync(logFile(DATA_DIR), line);
  } catch (_) {
    /* 忽略日志错误 */
  }
}

function isLockPermissionError(error) {
  return !!error && ['EACCES', 'EPERM', 'EROFS'].includes(error.code);
}

function reportDaemonLockFallback(error) {
  const code = error && error.code ? error.code : 'unknown';
  log(`[lock] 数据目录锁不可用 (${code})，已使用临时目录锁`);
  captureMessage('daemon 使用临时目录锁（数据目录锁权限不可用）', {
    level: 'warning',
    stage: 'daemon-lock-fallback',
    extra: { lockErrorCode: code, lockFallback: true },
  }).catch(() => {});
}

function isCurrentWindowsDaemonProcess(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const command = buildNativeProcessQuery(
    path.join(__dirname, 'windows-process-boundary.ps1'),
    `Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop | ` +
      `Where-Object { $_.Name -ieq 'node.exe' }`
  );
  try {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const processes = parseCimProcessResult(result, {
      requireCommandLine: true,
      requireCurrentOwner: true,
      requireNativeArguments: true,
      allowTransientNotFound: true,
    });
    return processes.some((item) => {
      try {
        return filterVerifiedNodeProcesses(item.ExecutablePath, __filename, [item])
          .some((match) => match.ProcessId === pid);
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    // Failure to prove ownership must keep the lock: deleting it could permit
    // two daemons to operate on the same profile at once.
    return true;
  }
}

// launchd 应只启动一个 daemon；启动器的 nohup 兜底和 launchd 异步拉起可能短暂重叠，
// 用原子创建锁文件把这类竞态变成可观测的单实例退出，而不是两个进程同时清理/注入页面。
// Windows 数据目录锁不可写时，使用同一台机器用户临时目录中的哈希锁继续保证单实例。
function acquireDaemonLock() {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version: DAEMON_VERSION, buildId: DAEMON_BUILD_ID });
  const candidates = [DAEMON_LOCK_FILE];
  if (IS_WIN && DAEMON_LOCK_FALLBACK_FILE !== DAEMON_LOCK_FILE) candidates.push(DAEMON_LOCK_FALLBACK_FILE);
  let fallbackReason = null;

  for (const lockPath of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        daemonLockFd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(daemonLockFd, payload, 'utf8');
        daemonLockPath = lockPath;
        if (lockPath !== DAEMON_LOCK_FILE) reportDaemonLockFallback(fallbackReason || { code: 'EEXIST' });
        log(`[lock] daemon 单实例锁已获取 (pid=${process.pid})`);
        return true;
      } catch (e) {
        if (daemonLockFd !== null) {
          try { fs.closeSync(daemonLockFd); } catch (_) {}
          daemonLockFd = null;
        }
        if (e.code === 'EEXIST') {
          let owner = null;
          try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
          const ownerPid = Number(owner && owner.pid);
          let alive = false;
          if (ownerPid > 0 && ownerPid !== process.pid) {
            if (IS_WIN) alive = isCurrentWindowsDaemonProcess(ownerPid);
            else {
              try { process.kill(ownerPid, 0); alive = true; } catch (_) {}
            }
          }
          if (alive) {
            process.stdout.write(`[${new Date().toISOString()}] [lock] 已有 daemon 运行 (pid=${ownerPid})，当前进程退出\n`);
            return false;
          }
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkError) {
            if (IS_WIN && lockPath === DAEMON_LOCK_FILE && isLockPermissionError(unlinkError)) {
              fallbackReason = unlinkError;
              break;
            }
            return false;
          }
          continue;
        }
        if (IS_WIN && lockPath === DAEMON_LOCK_FILE && isLockPermissionError(e)) {
          fallbackReason = e;
          break;
        }
        throw e;
      }
    }
  }
  return false;
}

function releaseDaemonLock() {
  if (daemonLockFd === null) return;
  try { fs.closeSync(daemonLockFd); } catch (_) {}
  daemonLockFd = null;
  try {
    const owner = JSON.parse(fs.readFileSync(daemonLockPath, 'utf8'));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(daemonLockPath);
  } catch (_) {}
}

/* ================= 自动备份（双层触发：CDP 事件 + 文件监听兜底） ================= */

let backupTimer = null;
function scheduleBackup(reason) {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    try {
      backupCurrent(DATA_DIR, log);
    } catch (e) {
      log(`[sync] ${reason} 触发备份失败: ${e.message}`);
    }
  }, BACKUP_DEBOUNCE);
}

// 兜底：登录文件本身变化（每次打开/刷新 WorkBuddy 都会重写该文件）
if (AUTH_FILE) fs.watchFile(AUTH_FILE, { interval: WATCH_INTERVAL }, (cur, prev) => {
  // 文件被移走（如"假退出登录"）时不应触发备份；仅当文件存在且 mtime 变化才备份
  if (!fs.existsSync(AUTH_FILE)) return;
  if (cur.mtimeMs !== prev.mtimeMs) scheduleBackup('file-change');
});

/* ================= CDP 客户端（Node 22 内置 WebSocket，零依赖） ================= */

const cdp = {
  ws: null,
  connected: false,
  port: null,
  targetUrl: null,
  targetTitle: null,
  error: null,
  id: 0,
  pending: new Map(),
  manualClose: false,
};

const DIAGNOSTICS_FILE = path.join(DATA_DIR, 'diagnostics-latest.json');
const DAEMON_LOCK_FILE = path.join(DATA_DIR, '.daemon.lock');
// Windows 上旧版可能以不同权限创建锁文件，导致当前用户无法覆盖；临时锁按数据目录哈希隔离。
const DAEMON_LOCK_FALLBACK_FILE = path.join(
  os.tmpdir(),
  'WorkDaddy-daemon-' + crypto.createHash('sha256').update(path.resolve(DATA_DIR)).digest('hex').slice(0, 16) + '.lock'
);
let daemonLockFd = null;
let daemonLockPath = DAEMON_LOCK_FILE;
// 注入节流：仅避免 connect 与 loadEventFired 在同一瞬间（<1.5s）重复注入导致闪烁；
// 但每次页面刷新（含 Command+R）都应重新注入最新代码，因此不用“一次加载只注入一次”的布尔去重，
// 否则 Electron 重载未触发 loadEventFired 时会遗留旧版本组件。
let lastInjectTs = 0;
let injectRetryTimer = null; // 被节流跳过的自动注入的兜底补种定时器
let manualInjectPromise = null; // launcher 超时重试时复用同一轮注入，避免并发清理/重挂载 renderer

async function findCdpEndpoint() {
  // profile 已由启动器绑定时不能扫描其他产品的端口；CodeBuddy Agents/Editor
  // 共用 Browser 标识，跨 profile 扫描会把注入发到另一端。
  const ports = process.env.WBSWITCH_PROFILE
    ? [CDP_PORT_HINT, readCdpPortFile()].filter((p, i, a) => validCdpPort(p) && a.indexOf(p) === i)
    : cdpPortCandidates();
  for (const p of ports) {
    try {
      const [versionRes, listRes] = await Promise.all([
        fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) }),
        fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(1500) }),
      ]);
      const version = await versionRes.json();
      const list = await listRes.json();
      const targets = Array.isArray(list) ? list : [];
      const browserInfo = [version.Browser, version['User-Agent']].filter(Boolean).join(' ');
      const belongsToWorkBuddy = /workbuddy|codebuddy/i.test(browserInfo);
      if (belongsToWorkBuddy && targets.some(isWorkBuddyCdpTarget)) {
        if (readCdpPortFile() !== p) writeCdpPortFile(p);
        return p;
      }
      // 旧逻辑会把任意 Chromium（常见为 Antigravity）当成 WorkBuddy。
      // 扫描到历史误注入标记时仅做清理，不对该应用执行任何新注入。
      await cleanupForeignInjectedTargets(targets);
    } catch (_) {
      /* 端口未开放，跳过 */
    }
  }
  return null;
}

function isWorkBuddyCdpTarget(target) {
  // 严格归属判定（见 cdp-targets.js）：页面明确属于其他客户端 → 一律拒绝，
  // 未绑定 profile 的旧 daemon 不会再靠标题 "WorkBuddy" 误连兄弟客户端页面。
  return isTargetForProfile(target, PROFILE);
}

async function getPageTarget(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await r.json();
  return (Array.isArray(list) ? list : []).find(isWorkBuddyCdpTarget) || null;
}

async function cleanupForeignInjectedTargets(targets) {
  if (!WebSocketCtor) return;
  for (const target of targets) {
    if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
    try { await cleanupForeignInjectedTarget(target); } catch (_) {}
  }
}

async function cleanupForeignInjectedTarget(target) {
  // 四客户端同族页面可能携带其他 profile daemon 注入的合法组件（如未绑定 CN daemon
  // 扫描到 WorkBuddy AI 页面），必须跳过，不能当作"历史误注入"清理。
  if (looksLikeWbFamilyTarget(target)) {
    log(`[cdp] 跳过同族页面清理: ${(target.title || target.url || 'unknown').slice(0, 80)}`);
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) {}
      resolve();
    };
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl);
    const timer = setTimeout(finish, 1800);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `(function(){
            var marked = !!(document.querySelector('.wbs-root,#wbs-style,#wbs-theme-style') || window.__wbsWidget);
            if (!marked) return { removed: false };
            try { if (window.__wbsWidget && typeof window.__wbsWidget.destroy === 'function') window.__wbsWidget.destroy(); } catch (_) {}
            try { delete window.__wbsWidget; } catch (_) { window.__wbsWidget = null; }
            document.querySelectorAll('.wbs-root,.wbs-stash-inline,.wbs-stash-btn,#wbs-style,#wbs-theme-style,#wbs-diag-badge,#wbs-debug-panel').forEach(function (n) { n.remove(); });
            return { removed: true };
          })()`,
        },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) log(`[cdp] 清理宿主页旧注入失败: ${msg.error.message || msg.error}`);
          else if (msg.result && msg.result.result && msg.result.result.value && msg.result.result.value.removed) {
            log(`[cdp] 已清理非 WorkBuddy 目标的旧注入: ${target.url || target.title || 'unknown'}`);
          }
          finish();
        }
      } catch (_) {}
    };
    ws.onerror = finish;
    ws.onclose = finish;
  });
}

function cdpSend(method, params = {}, _retry = 0) {
  if (!cdp.ws || cdp.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  }).catch((e) => {
    // "the tab is inactive"：Electron 窗口失焦/最小化/被遮挡时页面 lifecycle 变 inactive，
    // CDP 命令（尤其 Input.*、Page.captureScreenshot、Page.reload）会被拒绝。
    // 自动激活页面后重试一次，避免外部调用方暴露这个错误。
    if (_retry < 1 && /inactive/i.test(String((e && e.message) || e))) {
      return cdpActivatePage().then(() => cdpSend(method, params, _retry + 1));
    }
    throw e;
  });
}

// 激活页面（强制 lifecycle active + 置前），供 cdpSend 自动恢复与 devtools-proxy 保活复用
function cdpActivatePage() {
  const raw = () => {
    if (!cdp.ws || cdp.ws.readyState !== 1) return Promise.resolve();
    const id = ++cdp.id;
    return new Promise((resolve) => {
      const t = setTimeout(() => { cdp.pending.delete(id); resolve(); }, 800);
      cdp.pending.set(id, { resolve: () => { clearTimeout(t); resolve(); }, reject: () => { clearTimeout(t); resolve(); } });
      cdp.ws.send(JSON.stringify({ id, method: 'Page.setWebLifecycleState', params: { state: 'active' } }));
    });
  };
  return raw().then(() => new Promise((r) => setTimeout(r, 60)));
}

async function connectCdp() {
  if (!WebSocketCtor) throw new Error('当前 Node 运行时没有 WebSocket，且未找到内置 ws 模块');
  cdp.port = await findCdpEndpoint();
  if (!cdp.port) {
    cdp.connected = false;
    cdp.error = '未发现 CDP 端口（WorkBuddy 需以 --remote-debugging-port 启动）';
    return false;
  }
  const target = await getPageTarget(cdp.port).catch(() => null);
  if (!target) {
    cdp.connected = false;
    cdp.error = `端口 ${cdp.port} 上没有 WorkBuddy 页面目标`;
    return false;
  }
  return new Promise((resolve) => {
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl);
    ws.onopen = () => {
      cdp.ws = ws;
      cdp.connected = true;
      cdp.error = null;
      cdp.targetUrl = target.url || '';
      cdp.targetTitle = target.title || '';
      log(`[cdp] 已连接 WorkBuddy (port=${cdp.port}, target=${cdp.targetUrl})`);
      // 打开感兴趣的能力域
      cdpSend('Page.enable').catch(() => {});
      cdpSend('Network.enable').catch(() => {});
      cdpSend('Runtime.enable').catch(() => {});
      // 刚连上说明应用刚启动/刚登录，立刻同步一次 + 注入右下角组件
      setTimeout(() => scheduleBackup('cdp-connect'), 800);
      setTimeout(() => {
        injectWidget('connect').catch((e) => log(`[cdp] 注入失败: ${e.message}`));
        // 恢复已保存的主题（页面刷新/WorkBuddy 重启后 WorkBuddy 回到官方浅色，
        // 这里重新应用，保证「WorkDaddy 主题=深色 / WorkBuddy 默认主题=浅色」在重启后仍生效）
        restoreSavedTheme().catch((e) => log(`[theme] 恢复主题失败: ${e.message}`));
      }, 1200);
      resolve(true);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id !== undefined) {
        const p = cdp.pending.get(msg.id);
        if (p) {
          cdp.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        return;
      }
      onCdpEvent(msg.method, msg.params || {});
    };
    ws.onerror = () => {
      cdp.connected = false;
      cdp.error = `连接 ${cdp.port} WebSocket 失败`;
      log(`[cdp] 连接错误: ${cdp.error}`);
      resolve(false);
    };
    ws.onclose = () => {
      cdp.connected = false;
      cdp.ws = null;
      log('[cdp] 连接已断开，5 秒后重连');
    };
  });
}

function onCdpEvent(method, params) {
  switch (method) {
    case 'Network.requestWillBeSent': {
      const url = (params.request && params.request.url) || '';
      if (/auth|realms|login|token/i.test(url)) scheduleBackup('cdp-auth');
      break;
    }
    case 'Runtime.consoleAPICalled': {
      if (!diagnosticsEnabled()) break;
      // 持久采集渲染进程 console（含注入脚本 breadcrumb/console.error），崩溃时也能留痕
      const type = params.type || 'log';
      let args;
      try {
        args = (params.args || []).map((a) => (a && a.value !== undefined ? String(a.value) : a && a.description !== undefined ? String(a.description) : String(a && a.type)));
      } catch (_) {
        args = [];
      }
      log(`[renderer:${type}] ${redactDiagnosticText(args.join(' '))}`);
      break;
    }
    case 'Runtime.exceptionThrown': {
      if (!diagnosticsEnabled()) break;
      const d = params.exceptionDetails || {};
      const desc =
        d.exception && d.exception.description !== undefined
          ? d.exception.description
          : (d.exception && d.exception.value !== undefined ? String(d.exception.value) : '');
      log('[renderer:exception] ' + redactDiagnosticText(desc || d.text || ''));
      break;
    }
    case 'Page.loadEventFired':
      scheduleBackup('cdp-page-load');
      // 页面刷新/导航后重新注入组件（组件自带幂等清理，可安全重新注入最新代码）
      injectWidget('page-load').catch(() => {});
      // 页面刷新后 WorkBuddy 回到官方浅色，重新应用已保存主题（WorkDaddy=深色 / 默认=浅色）
      restoreSavedTheme().catch((e) => log(`[theme] 页面刷新恢复主题失败: ${e.message}`));
      break;
    case 'Page.frameNavigated':
      scheduleBackup('cdp-navigate');
      break;
    default:
      break;
  }
}

async function cdpLoop() {
  for (;;) {
    if (!cdp.connected) {
      try {
        await connectCdp();
      } catch (e) {
        log(`[cdp] 连接异常: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, CDP_RECONNECT_MS));
  }
}

async function reloadWorkBuddyPage() {
  if (!cdp.connected) throw new Error('CDP 未连接，无法自动刷新窗口');
  await cdpSend('Page.reload', { ignoreCache: false });
}

const WORKBUDDY_TARGET = IS_WIN ? null : readWorkBuddyTarget({ dataDir: DATA_DIR, profileId: PROFILE.id });
const WORKBUDDY_APP = IS_WIN ? '' : (WORKBUDDY_TARGET.binary
  ? path.resolve(WORKBUDDY_TARGET.binary, '../../..')
  : PROFILE.appPath);
const WORKBUDDY_BINARY = IS_WIN ? '' : `${WORKBUDDY_APP}/Contents/MacOS/Electron`;
const WORKBUDDY_APP_NAME = path.basename(WORKBUDDY_APP).replace(/\.app$/i, '');

// Windows：解析 WorkBuddy 可执行文件真实路径（安装盘可自定义，必须动态查）
// 优先级：WBSWITCH_WORKBUDDY_BIN > 运行进程 Path > 注册表卸载项 > 常见路径
let wbBinaryCache = null;
const PROFILE_BINARY_NAMES = new Set((
  PROFILE.binaryNames || (PROFILE.id === 'workbuddy-ai' ? ['workbuddyai.exe'] :
    PROFILE.id === 'workbuddy-cn' ? ['workbuddy.exe'] : ['codebuddy.exe'])
).map((name) => String(name).toLowerCase()));
function queryWindowsWorkBuddyProcesses() {
  const names = [...PROFILE_BINARY_NAMES].map((name) => `\"${name}\"`).join(',');
  const helper = path.join(__dirname, 'windows-process-boundary.ps1');
  const command = buildNativeProcessQuery(helper,
    `$names=@(${names}); Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $names -contains $_.Name }`);
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return parseCimProcessResult(result, {
    requireCommandLine: true, requireCurrentOwner: true, requireNativeArguments: true,
    allowTransientNotFound: true,
  });
}

function resolveWorkBuddyBinary() {
  if (!IS_WIN) return WORKBUDDY_BINARY;
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => {
    try {
      const candidate = String(p || '').trim().replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
      if (!candidate || !fs.existsSync(candidate)) return null;
      const resolved = resolveWindowsExecutable(candidate);
      const name = path.win32.basename(resolved).toLowerCase();
      return PROFILE_BINARY_NAMES.has(name) ? resolved : null;
    } catch (_) {
      return null;
    }
  };
  const { execFileSync } = require('child_process');
  const psCmd = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const runningBin = selectRunningProfileBinary(PROFILE_BINARY_NAMES, queryWindowsWorkBuddyProcesses());
  const configuredTarget = readWorkBuddyTarget({ dataDir: DATA_DIR, profileId: PROFILE.id });
  const configuredBin = tryFile(configuredTarget.binary);
  if (configuredTarget.configured && !configuredBin) {
    throw new Error('workbuddy-target.json 指定的路径不是可验证的当前 profile 主程序；登录信息未修改');
  }
  // 1) 显式指定；若当前 profile 已运行，必须与运行路径完全一致。
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (process.env.WBSWITCH_WORKBUDDY_BIN && !envBin) {
    throw new Error('WBSWITCH_WORKBUDDY_BIN 不是可验证的当前 profile 主程序；登录信息未修改');
  }
  if (envBin) {
    if (runningBin && !sameWindowsPath(runningBin, envBin)) {
      throw new Error('检测到当前 profile 正从另一安装目录运行，登录信息未修改');
    }
    return (wbBinaryCache = envBin);
  }
  if (configuredBin) {
    const sameConfiguredInstall = runningBin && PROFILE_BINARY_NAMES.has(path.win32.basename(runningBin).toLowerCase()) &&
      sameWindowsPath(path.win32.dirname(runningBin), path.win32.dirname(configuredBin));
    if (runningBin && !sameConfiguredInstall) {
      throw new Error('检测到当前 profile 正从另一安装目录运行，登录信息未修改');
    }
    return (wbBinaryCache = configuredBin);
  }
  // 2) 运行中当前 profile 的主程序优先（便携安装）。
  if (runningBin) return (wbBinaryCache = runningBin);
  const discovered = [];
  const addCandidate = (candidate) => {
    const hit = tryFile(candidate);
    if (hit) discovered.push(hit);
  };
  // 3) 收集磁盘和注册表候选；无运行进程时只能接受唯一真实路径。
  addCandidate(PROFILE.appPath);
  const appPaths = psCmd("$k=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe'); Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { if ($_.'(default)') { $_.'(default)' } elseif ($_.Path) { $_.Path } }");
  for (const candidate of appPaths.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) addCandidate(candidate);
  const registry = psCmd("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation 'WorkBuddy.exe' } }");
  for (const candidate of registry.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) addCandidate(candidate);
  // 4) 常见路径兜底（含探测机实际安装位）
  const cands = [
    PROFILE.appPath,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.APPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'WorkBuddy.exe'),
    'D:\\workbody\\WorkBuddy\\WorkBuddy.exe',
  ];
  cands.push(
    path.join(process.env.ProgramFiles || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'workbuddy', 'current', 'WorkBuddy.exe'),
    'D:\\workbuddy\\WorkBuddy.exe'
  );
  if (process.env.WBSWITCH_WORKBUDDY_DIR) {
    cands.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, path.win32.basename(PROFILE.appPath)));
  }
  for (const candidate of cands) addCandidate(candidate);
  const scanRoots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'WorkBuddy'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'WorkBuddy'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'CodeBuddy'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'CodeBuddy'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddyAI'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'WorkBuddyAI'),
  ].filter(Boolean);
  const names = [...PROFILE_BINARY_NAMES];
  const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const command = [
    '$roots=@(' + scanRoots.map(psQuote).join(', ') + ')',
    '$names=@(' + names.map(psQuote).join(', ') + ')',
    'foreach($root in $roots){',
    'if(-not (Test-Path -LiteralPath $root -PathType Container)){continue}',
    'Get-ChildItem -LiteralPath $root -File -Recurse -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | Select-Object -ExpandProperty FullName',
    '}',
  ].join('; ');
  for (const candidate of psCmd(command).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) addCandidate(candidate);
  const selected = selectPreferredDiscoveredBinary(PROFILE_BINARY_NAMES, discovered);
  if (discovered.length > 1) {
    log('检测到多个 dormant WorkBuddy 安装目录，按发现优先级选择: ' + selected);
  }
  return selected ? (wbBinaryCache = selected) : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs) || 0;
    const spawnOptions = { ...options };
    delete spawnOptions.timeoutMs;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true, ...spawnOptions });
    } catch (e) {
      return finish({ code: null, error: e });
    }
    child.on('error', (error) => finish({ code: null, error }));
    child.on('exit', (code, signal) => finish({ code, signal, error: null }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish({ code: null, error: new Error(command + ' 超时') });
      }, timeoutMs);
    }
  });
}

// Windows 的 WorkBuddy 可能记住“最小化到托盘”状态；重启后显式恢复主窗口，避免只看到托盘图标。
async function restoreWorkBuddyWindow(pid) {
  if (!IS_WIN || !pid) return false;
  const source = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class WorkDaddyWindowBridge {',
    '  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int command);',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  public static void Restore(uint targetPid) {',
    '    EnumWindows((hWnd, lParam) => { uint owner; GetWindowThreadProcessId(hWnd, out owner);',
    '      if (owner == targetPid) { ShowWindowAsync(hWnd, 9); SetForegroundWindow(hWnd); return false; }',
    '      return true; }, IntPtr.Zero);',
    '  }',
    '}',
  ].join('\n');
  const command = `Add-Type -TypeDefinition @'\n${source}\n'@; [WorkDaddyWindowBridge]::Restore(${Number(pid)})`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const result = await runCommand('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { timeoutMs: 10000 });
  if (result.error || result.code !== 0) {
    log('[relaunch] 恢复 WorkBuddy 窗口失败: ' + (result.error ? result.error.message : 'powershell exit ' + result.code));
    return false;
  }
  log('[relaunch] 已恢复并置前 WorkBuddy 窗口');
  return true;
}

function verifiedWindowsWorkBuddyProcesses(binary) {
  if (!binary) throw new Error('未找到 WorkBuddy 可执行文件，无法验证运行中的进程');
  const processes = queryWindowsWorkBuddyProcesses();
  const verified = filterVerifiedWindowsProcesses(
    binary, processes, fs.realpathSync.native, PROFILE.customTarget ? PROFILE_BINARY_NAMES : null
  );
  if (processes.length !== verified.length) {
    throw new Error('存在当前 profile 进程，但没有进程属于已验证安装目录；登录信息未修改');
  }
  return verified;
}

function revalidateWindowsWorkBuddyProcess(original, binary) {
  const current = verifiedWindowsWorkBuddyProcesses(binary)
    .find((process) => process.ProcessId === original.ProcessId);
  if (!current) {
    throw new Error(`结束前无法再次验证 WorkBuddy PID=${original.ProcessId}`);
  }
  return assertSameProcessIdentity(original, current);
}

function workBuddyRunning(binary = null) {
  try {
    if (IS_WIN) {
      return verifiedWindowsWorkBuddyProcesses(binary || resolveWorkBuddyBinary()).length > 0;
    }
    const r = spawnSync('pgrep', ['-f', WORKBUDDY_APP], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch (error) {
    // 探测失败时按仍在运行处理，避免误删身份文件后拉起旧实例。
    if (IS_WIN) throw error;
    return true;
  }
}

async function waitForWorkBuddyExit(timeoutMs = 10000, binary = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning(binary)) return true;
    await sleep(200);
  }
  return !workBuddyRunning(binary);
}

/** 退出 WorkBuddy，并确认进程已经消失；失败时拒绝继续登录切换。 */
async function quitWorkBuddy() {
  if (IS_WIN) {
    const binary = resolveWorkBuddyBinary();
    if (!binary) throw new Error('未找到 WorkBuddy 可执行文件，无法安全退出；登录信息未修改');
    let processes = verifiedWindowsWorkBuddyProcesses(binary);
    if (!processes.length) return true;

    for (const process of processes) {
      const current = revalidateWindowsWorkBuddyProcess(process, binary);
      const result = await runCommand('taskkill', ['/PID', String(current.ProcessId)]);
      if (result.error || result.code !== 0) {
        throw result.error || new Error(`taskkill 无法结束已验证进程 PID=${process.ProcessId}`);
      }
    }
    if (await waitForWorkBuddyExit(1800, binary)) return true;

    processes = verifiedWindowsWorkBuddyProcesses(binary);
    for (const process of processes) {
      const current = revalidateWindowsWorkBuddyProcess(process, binary);
      const result = await runCommand('taskkill', ['/F', '/PID', String(current.ProcessId)]);
      if (result.error || result.code !== 0) {
        throw result.error || new Error(`taskkill 无法强制结束已验证进程 PID=${process.ProcessId}`);
      }
    }
    if (await waitForWorkBuddyExit(2500, binary)) return true;

    throw new Error('无法以普通用户权限安全退出 WorkBuddy。请手动关闭该程序；若它以管理员身份运行，请先退出后再重试。登录信息未修改');
  }

  if (!workBuddyRunning()) return true;

  // 先尝试正常退出（给 Electron 一次处理机会），再强制 kill 并验证。
  await runCommand('osascript', ['-e', `tell application "${WORKBUDDY_APP_NAME}" to quit`]);
  if (await waitForWorkBuddyExit(2500)) return true;
  await runCommand('pkill', ['-f', WORKBUDDY_APP]);
  if (await waitForWorkBuddyExit(2500)) return true;
  await runCommand('pkill', ['-9', '-f', WORKBUDDY_APP]);
  if (await waitForWorkBuddyExit(3000)) return true;
  throw new Error('无法确认 WorkBuddy 已退出');
}

/** 探测 WorkDaddy.app 位置（macOS 专用：退出登录后打开它，由其 launcher 以 CDP 模式重启 WorkBuddy 并注入组件） */
function findWorkDaddyApp() {
  if (IS_WIN) return null;
  const appPackageName = WORKDADDY_INSTALL_NAME + '.app';
  const cands = [
    path.join('/Applications', appPackageName),
    path.join(os.homedir(), 'Applications', appPackageName),
    path.join(os.homedir(), 'Desktop', appPackageName),
    path.join(__dirname, '..', appPackageName),
    path.join(__dirname, '..', 'WorkDaddy.app'),
    path.join(__dirname, '..', '..', 'workbuddy-switch', appPackageName),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'Contents', 'MacOS', 'launcher'))) return c;
    } catch (_) {}
  }
  return null;
}

/** 重新启动 WorkBuddy：macOS 优先走 WorkDaddy.app launcher；Windows 直接带 CDP 参数重启 exe */
function relaunchWorkBuddy() {
  return (async () => {
    const port = await selectCdpPort(log);
    if (IS_WIN) {
      const bin = resolveWorkBuddyBinary();
      if (!bin) throw new Error('未找到 WorkBuddy.exe（可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定）');
      const environmentMode = !!(PROFILE.cdp && PROFILE.cdp.mode === 'environment');
      log(`[logout] 以 ${environmentMode ? '环境变量' : '命令行参数'} CDP=${port} 重启 WorkBuddy: ${bin}`);
      const child = spawn(bin, environmentMode ? [] : [`--remote-debugging-port=${port}`], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: environmentMode ? { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(port) } : process.env,
      });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
      // 窗口创建可能晚于 CDP/进程就绪，重复几次恢复，仍不影响重启流程本身。
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(1000);
        await restoreWorkBuddyWindow(child.pid);
      }
      return;
    }
    const workDaddy = findWorkDaddyApp();
    if (workDaddy) {
      log(`[logout] 正在打开 WorkDaddy (${workDaddy})，由其 launcher 重启 WorkBuddy`);
      const child = spawn('open', [workDaddy], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
      return;
    }
    if (!fs.existsSync(WORKBUDDY_BINARY)) {
      throw new Error(`未找到 WorkBuddy 可执行文件: ${WORKBUDDY_BINARY}`);
    }
    log(`[logout] 未找到 WorkDaddy.app，直接重新启动 WorkBuddy（带 CDP 端口 ${port}）`);
    const child = spawn(WORKBUDDY_BINARY, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
  })();
}

/**
 * 通过 CDP 在 WorkBuddy 渲染进程里查找/点击元素（trusted 事件，可靠触发应用业务）
 *
 * 策略：先 Runtime.evaluate 找元素 + 获取视口坐标（必要时 scrollIntoView），
 * 再用 Input.dispatchMouseEvent 发送真实鼠标事件，绕过业务代码对 event.isTrusted 的检查。
 */
async function clickByText(text, { tag = null, exact = false } = {}) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tags = tag ? `self::${tag}` : "self::button or self::a or @role='button'";
  const contains = exact ? 'text()' : 'normalize-space(.)';
  const cmp = exact ? '=' : 'contains';
  // 精确匹配：限定为 button/a/role=button；尺寸合理（按钮不会全屏）；文字短
  const expr = `(function(){
    try {
      var xpath = "//*[" + ${JSON.stringify(tags)} + "][" + ${JSON.stringify(cmp)} + "(" + ${JSON.stringify(contains)} + ", '" + ${JSON.stringify(escaped)} + "')]";
      var r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (var i = 0; i < r.snapshotLength; i++) {
        var el = r.snapshotItem(i);
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        var b = el.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        if (b.width > 400 || b.height > 200) continue; // 全屏容器忽略
        var txt = (el.textContent || '').trim();
        if (txt.length > 40) continue; // 按钮文字一般 < 40 字
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(_) {}
        var b2 = el.getBoundingClientRect();
        return {
          x: b2.x + b2.width / 2,
          y: b2.y + b2.height / 2,
          w: b2.width,
          h: b2.height,
          tag: el.tagName,
          text: txt,
          xpath: xpath,
        };
      }
      return null;
    } catch (e) { return { error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  const found = r.result && r.result.value;
  if (!found) throw new Error('未找到元素');
  if (found.error) throw new Error('查找异常: ' + found.error);
  // 用 Input 事件模拟真实鼠标点击（trusted）
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  return found;
}

async function findByText(text, { tag = null, exact = false } = {}) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tags = tag ? `self::${tag}` : "self::button or self::a or @role='button'";
  const contains = exact ? 'text()' : 'normalize-space(.)';
  const cmp = exact ? '=' : 'contains';
  const expr = `(function(){
    try {
      var xpath = "//*[" + ${JSON.stringify(tags)} + "][" + ${JSON.stringify(cmp)} + "(" + ${JSON.stringify(contains)} + ", '" + ${JSON.stringify(escaped)} + "')]";
      var r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var out = [];
      for (var i = 0; i < r.snapshotLength; i++) {
        var el = r.snapshotItem(i);
        var cs = getComputedStyle(el);
        var b = el.getBoundingClientRect();
        if (b.width > 400 || b.height > 200) continue;
        var txt = (el.textContent || '').trim();
        if (txt.length > 40) continue;
        out.push({ tag: el.tagName, text: txt.slice(0,40), visible: cs.visibility!=='hidden'&&cs.display!=='none', w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) });
      }
      return { xpath: xpath, count: out.length, items: out };
    } catch (e) { return { error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result && r.result.value;
}

/* ================= 自动领取积分（轮询点击"立即领取"） ================= */

const CLAIM_TEXTS = (process.env.WBSWITCH_CLAIM_TEXT || '立即领取,今日可领').split(',').map((s) => s.trim()).filter(Boolean);
// 每次切换后轮询总时长（毫秒）。默认 1 秒：100ms 轮询一次，找到"立即领取"即结束。
const CLAIM_MAX_MS = parseInt(process.env.WBSWITCH_CLAIM_MAX_MS || '1000', 10);
const CLAIM_INTERVAL_MS = parseInt(process.env.WBSWITCH_CLAIM_INTERVAL_MS || '100', 10);

// 临时调试日志：把领取查找过程写到 /tmp，方便排查"明明有按钮却识别不到"
function claimDebugFile() {
  return path.join(os.tmpdir(), `wbswitch-claim-${Date.now()}-${process.pid}.log`);
}
function claimLog(file, line) {
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch (_) {}
}

let batchState = { running: false, total: 0, done: 0, startedAt: 0, last: null };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待页面加载完成（reload 后调用），超时返回 false */
async function waitPageLoaded(timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (r.result && r.result.value === 'complete') return true;
    } catch (_) {
      /* 页面正在导航，忽略 */
    }
    await sleep(200);
  }
  return false;
}

/** 找出页面上所有匹配文字、可见、尺寸合理的可点击元素中心坐标。
 *  兼容：shadow DOM、同域 iframe、aria-label/title、React/Vue 事件绑定。
 */
/* ================= 积分自动领取（直接调接口，带每日缓存） ================= */

// 签到接口按 profile 归属域名生成：国际版（WorkBuddy AI）命中 www.workbuddy.ai，
// 国内版保留多域名兜底（workbuddy.cn / codebuddy.cn 账号体系互通）。
function profileCheckinEndpoints() {
  const host = PROFILE.apiHost || 'https://www.workbuddy.cn';
  const eps = [
    `${host}/billing/meter/daily-checkin`,
    `${host}/v2/billing/meter/daily-checkin`,
  ];
  if (PROFILE.region === 'cn') {
    eps.push(
      'https://www.codebuddy.cn/billing/meter/daily-checkin',
      'https://www.codebuddy.cn/v2/billing/meter/daily-checkin'
    );
  }
  return Array.from(new Set(eps));
}
const CHECKIN_ENDPOINTS = profileCheckinEndpoints();
const CHECKIN_CACHE_FILE = path.join(DATA_DIR, 'checkin-cache.json');
const CHECKIN_REQUEST_TIMEOUT_MS = 12000;
const CHECKIN_QUEUE_DELAY_MS = 250;
const CHECKIN_STARTUP_DELAY_MS = 30 * 1000;
const CHECKIN_INTERVAL_MS = 60 * 60 * 1000;
let claimInFlight = false;
let checkinState = { running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 };

function checkinSnapshot() {
  return Object.assign({}, checkinState, { running: !!claimInFlight });
}

function todayStr(d) {
  d = d || new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

function loadCheckinCache() {
  try {
    return JSON.parse(fs.readFileSync(CHECKIN_CACHE_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}
function saveCheckinCache(cache) {
  try {
    fs.writeFileSync(CHECKIN_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    log('[checkin] 写入缓存失败: ' + e.message);
  }
}

/**
 * 用指定账号 accessToken 调用签到接口（多域名兜底）。
 * 只有明确 code=0，或 code=10001 且文案明确表示已签到/已领取，才视为成功。
 */
async function dailyCheckin(accessToken) {
  const origin = PROFILE.apiHost || 'https://www.workbuddy.cn';
  let lastErr = null;
  for (const url of CHECKIN_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECKIN_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin: origin,
          referer: origin + '/profile/plans-usage',
          authorization: 'Bearer ' + accessToken,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        },
        body: '{}',
        signal: controller.signal,
      });
      const text = await r.text();
      let o = {};
      try { o = JSON.parse(text); } catch (_) {}
      // 401 = token 过期/未授权：直接给友好文案，避免面板显示裸 "HTTP 401"
      const failMsg = r.status === 401 ? '登录身份过期' : 'HTTP ' + r.status;
      const message = o.msg || o.message || (r.ok ? 'ok' : failMsg);
      const classified = classifyCheckinResult({ httpOk: r.ok, code: o.code, message });
      const result = { ...classified, status: r.status, url };
      // 网络异常或服务端错误才切换兜底域名；认证/参数错误直接返回，避免无意义地重复请求。
      if (classified.ok || r.status === 401 || (r.status >= 400 && r.status < 500 && r.status !== 404) || (r.ok && r.status !== 404)) return result;
      lastErr = result.message;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '请求超时（' + (CHECKIN_REQUEST_TIMEOUT_MS / 1000) + ' 秒）' : e.message;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, already: false, code: -1, message: lastErr || '未知错误', url: CHECKIN_ENDPOINTS[0] };
}

/** 对单个账号签到（带每日缓存，幂等：今日已成功过则跳过） */
async function claimDailyForUid(uid) {
  const today = todayStr();
  let dbHit = null;
  try { dbHit = await CREDIT_USAGE_STORE.getDailyCheckin(uid, today); } catch (e) {
    log('[checkin] 读取 SQLite 标记失败: ' + e.message);
  }
  if (dbHit && dbHit.ok === true && dbHit.verified === true) {
    return { uid, skipped: true, ...dbHit };
  }
  const cache = loadCheckinCache();
  const hit = cache[uid];
  const cachedResult = hit && hit.date === today
    ? classifyCheckinResult({ httpOk: true, code: hit.code, message: hit.message })
    : null;
  if (cachedResult && cachedResult.ok) {
    const migrated = { uid, skipped: true, date: today, ...cachedResult, at: Number(hit.at) || Date.now(), verified: true };
    try {
      await CREDIT_USAGE_STORE.saveDailyCheckin({ uid, date: today, checkedAt: migrated.at, code: migrated.code, message: migrated.message });
    } catch (e) {
      log('[checkin] 迁移 SQLite 标记失败: ' + e.message);
    }
    return migrated;
  }
  const file = path.join(DATA_DIR, 'accounts', uid + '.info');
  if (!fs.existsSync(file)) return { uid, ok: false, reason: 'no-backup' };
  let tk = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    tk = j.auth && j.auth.accessToken;
  } catch (e) {
    return { uid, ok: false, reason: 'read-token-failed: ' + e.message };
  }
  if (!tk) return { uid, ok: false, reason: 'no-accessToken' };
  const r = await dailyCheckin(tk);
  const rec = { date: today, ok: !!r.ok, already: !!r.already, inactive: !!r.inactive, code: r.code, message: r.message, at: Date.now(), verified: !!r.ok };
  cache[uid] = rec;
  saveCheckinCache(cache);
  if (rec.ok) {
    try {
      await CREDIT_USAGE_STORE.saveDailyCheckin({ uid, date: today, checkedAt: rec.at, code: rec.code, message: rec.message });
    } catch (e) {
      log('[checkin] 写入 SQLite 标记失败: ' + e.message);
    }
  }
  return { uid, ...rec };
}

/** 对所有账号执行每日签到（自动跳过今日已成功过的，带并发保护） */
async function claimDailyForAll() {
  if (!PROFILE.capabilities.accounts) return { skipped: true, reason: 'profile-no-account-files' };
  if (claimInFlight) return { skipped: true, reason: 'in-flight', checkin: checkinSnapshot() };
  claimInFlight = true;
  try {
    const list = listAccounts(DATA_DIR).map((a) => a.uid);
    checkinState = { running: true, total: list.length, done: 0, startedAt: Date.now(), finishedAt: 0 };
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const uid = list[i];
      let result;
      try {
        result = await claimDailyForUid(uid);
      } catch (e) {
        result = { uid, ok: false, reason: e.message };
      }
      results.push(result);
      checkinState.done = i + 1;
      // 账号之间留一点间隔，避免多个账号同时触发服务端限流/连接排队。
      if (i < list.length - 1 && !result.skipped) await sleep(CHECKIN_QUEUE_DELAY_MS);
    }
    log('[checkin] 本轮回检 ' + results.length + ' 个账号');
    return { total: results.length, results };
  } finally {
    checkinState.running = false;
    checkinState.finishedAt = Date.now();
    claimInFlight = false;
  }
}

/** 通过 CDP 把右下角组件注入到 WorkBuddy 渲染进程（幂等，可反复调用） */
function injectWidget(reason) {
  if (!cdp.connected) {
    return Promise.reject(new Error('CDP 未连接，无法注入组件'));
  }
  // 防御闸：绝不向其他客户端的页面注入。四客户端支持后，未绑定 profile 的旧 daemon
  // 可能扫到兄弟客户端页面；其余环节（归属判定/清理跳过）已拦截，这里作为最后一道保险。
  if (cdp.targetUrl) {
    const cls = classifyTarget(cdp.targetUrl, cdp.targetTitle || '');
    if (cls && cls !== PROFILE.id) {
      log(`[cdp] 目标页面属于 ${cls}（当前 profile=${PROFILE.id}），拒绝注入`);
      return Promise.reject(new Error(`目标页面 ${cls} 不属于当前 profile ${PROFILE.id}`));
    }
  }
  // 节流：仅抑制 connect 与 page-load 在 <1s 内连发的重复注入（避免闪烁）。
  // 关键：manual（launcher/用户显式 /api/inject）恒不等候、必须无条件注入——
  // 否则 WorkBuddy 重启后仅有的注入机会会被节流吞掉（多台机器 FAB 缺失的根因：
  // launcher 检测到 CDP 就调用 manual，但被 1.5s 节流跳过，页面又不会再触发补种）。
  var now = Date.now();
  if (reason !== 'manual' && now - lastInjectTs < 1000) {
    log(`[cdp] 注入节流跳过 (${reason})`);
    // 兜底：被跳过的自动注入可能是页面刚就绪的唯一一次机会，1.5s 后补种一次（脚本幂等，安全）
    if (!injectRetryTimer) {
      injectRetryTimer = setTimeout(function () {
        injectRetryTimer = null;
        if (cdp.connected) injectWidget('retry').catch(function () {});
      }, 1500);
    }
    return Promise.resolve();
  }
  injectRetryTimer = null;
  lastInjectTs = now;
  let script;
  try {
    const compatScript = fs.readFileSync(path.join(__dirname, 'workbuddy-compat.js'), 'utf8');
    let injectScript = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
    // 内部调试模块（元素检查/DevTools）：picker-internal.js 存在才注入（git 不跟踪，
    // 他人环境无此文件 → 隐藏入口的拾取按钮点击会报错，符合预期，不影响面板其他功能）。
    // 注入位置：放进 build() 函数体末尾（与面板共享闭包作用域：root/toast/esc 等），
    // 这样拾取实现与原版稳定版 debug 模块完全同域，不被 IIFE 边界隔开。
    const pickerPath = path.join(__dirname, 'picker-internal.js');
    if (fs.existsSync(pickerPath)) {
      const pickerCode = fs.readFileSync(pickerPath, 'utf8');
      const anchor = 'return { destroy: lifecycle.destroy, alive: lifecycle.alive };';
      if (!injectScript.includes(anchor)) {
        return Promise.reject(new Error('picker-internal.js 注入锚点不存在'));
      }
      injectScript = injectScript.replace(anchor, pickerCode + '\n' + anchor);
    }
    script = compatScript + '\n' + injectScript;
  } catch (e) {
    return Promise.reject(new Error('读取注入脚本失败: ' + e.message));
  }
  // 组件内通过 fetch 调用本机 API，注入时写入实际端口
  script = script.replace(/__WBS_API__/g, `http://${HOST}:${ACTUAL_PORT}`);
  script = script.replace(/__WBS_VERSION__/g, DAEMON_VERSION);
  // 注入本地 API 能力凭证；旧版面板不会携带该 header，但新版 daemon 会在启动时重新注入新版面板。
  script = script.replace(/__WBS_API_TOKEN__/g, API_TOKEN);
  script = script.replace(/__WBS_DIAGNOSTICS_ENABLED__/g, diagnosticsEnabled() ? 'true' : 'false');
  script = script.replace(/__WBS_PROFILE__/g, PROFILE.id);
  script = script.replace(/__WBS_CAPS__/g, JSON.stringify(PROFILE.capabilities));
  script = script.replace(/__WBS_PLATFORM__/g, JSON.stringify(process.platform));
  updateDebug('inject-version', { reason, injectedVersion: DAEMON_VERSION, profile: PROFILE.id });
  // 注入策略：不使用 addScriptToEvaluateOnNewDocument（它会在浏览器里持久化注册，
  // 多次重启会叠加旧版本；旧注册先执行并占住 window.__wbsWidget 守卫，导致新代码被拦截）。
  // 改为：先用 Runtime.evaluate 暴力清理任何历史残留（不依赖旧版本的 destroy，避免清不干净），
  // 再 Runtime.evaluate 跑最新文件。脚本顶部自带同样的暴力清理 + 幂等守卫，所以可安全反复注入。
  log(`[cdp] 注入右下角组件 (${reason})`);
  const cleanupExpr =
    'try{if(window.__wbsWidget&&typeof window.__wbsWidget.destroy==="function"){window.__wbsWidget.destroy();}}catch(e){}';
  return cdpSend('Runtime.evaluate', { expression: cleanupExpr, returnByValue: false })
    .catch(() => {})
    .then(() =>
      cdpSend('Runtime.evaluate', {
        expression: script,
        returnByValue: false,
      })
    )
    // 注入脚本若在页面抛错，CDP 协议不报错（无 protocol error），会被误判为"已注入"；
    // 显式检查 exceptionDetails 让失败可见、留痕，便于定位 WorkBuddy 版本差异导致的挂载失败。
    .then((r) => {
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails.exception;
        const desc = (ex && (ex.description || ex.value)) || r.exceptionDetails.text || '注入脚本页面抛错';
        log(`[cdp] 注入脚本页面抛错(${reason}): ${redactDiagnosticText(desc, 500)}`);
        return writeDiagnosticsSnapshot('inject-exception').then(() => r);
      }
      return r;
    })
    .then(async (r) => {
      // Runtime.evaluate 本身成功不代表脚本完成挂载；回读 DOM/全局守卫，区分“协议成功”与“用户可见”。
      // 手动注入是 launcher 的成功判据，给页面首屏最多约 1.3 秒完成挂载，避免把正常加载延迟误报为失败。
      let state = null;
      const checks = reason === 'manual' ? 5 : 1;
      for (let attempt = 0; attempt < checks; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 120 : 300));
        try {
          const check = await cdpSend('Runtime.evaluate', {
            expression: '({ url: location.href, readyState: document.readyState, body: !!document.body, root: !!document.querySelector(".wbs-root"), widget: !!window.__wbsWidget })',
            returnByValue: true,
          });
          state = check && check.result && check.result.value;
        } catch (e) {
          log(`[cdp] 注入结果校验失败(${reason}): ${e.message}`);
        }
        if (state && state.root && state.widget) break;
      }
      if (!state || !state.root || !state.widget) {
        log(`[cdp] 注入后未检测到组件(${reason}): ${JSON.stringify(state || {})}`);
        writeDiagnosticsSnapshot('inject-not-mounted').catch(() => {});
        // 页面首屏尚未完成时偶发 body 已存在但应用仍在替换根节点，延迟补试一次。
        if (!String(reason).endsWith('-retry')) {
          setTimeout(() => { if (cdp.connected) injectWidget(String(reason) + '-retry').catch(() => {}); }, 700);
        }
        if (reason === 'manual') throw new Error('注入后未检测到 WorkDaddy 组件（请检查 WorkBuddy 页面是否正常加载）');
      } else {
        log(`[cdp] 注入结果确认(${reason}): root=true widget=true url=${state.url}`);
      }
      return { result: r, mounted: Boolean(state && state.root && state.widget), state };
    })
    .catch((e) => {
      log(`[cdp] 注入失败: ${e.message}`);
      if (reason === 'manual') throw e;
      return { result: null, mounted: false, error: e.message };
    });
}

function injectWidgetManual() {
  if (manualInjectPromise) return manualInjectPromise;
  manualInjectPromise = injectWidget('manual').finally(() => {
    manualInjectPromise = null;
  });
  return manualInjectPromise;
}

async function readCdpTargets() {
  if (!cdp.port) return [];
  try {
    const r = await fetch(`http://127.0.0.1:${cdp.port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = await r.json();
    return (Array.isArray(list) ? list : []).map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
  } catch (e) {
    return [{ error: e.message }];
  }
}

function readLogTail(maxLines = 120) {
  try {
    const text = fs.readFileSync(logFile(DATA_DIR), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map((line) => line
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/ig, '$1<redacted>')
      .replace(/(["']?(?:accessToken|refreshToken|token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/ig, '$1<redacted>'));
  } catch (_) {
    return [];
  }
}

async function collectDiagnostics(reason) {
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    reason: reason || 'manual',
    daemon: { version: DAEMON_VERSION, buildId: DAEMON_BUILD_ID, pid: process.pid, platform: process.platform, arch: process.arch, node: process.version },
    paths: { dataDir: DATA_DIR, logFile: logFile(DATA_DIR), diagnosticsFile: DIAGNOSTICS_FILE, authFile: AUTH_FILE },
    cdp: { connected: cdp.connected, port: cdp.port, targetUrl: cdp.targetUrl, error: cdp.error, targets: await readCdpTargets() },
    injection: null,
    logTail: readLogTail(),
  };
  if (cdp.connected) {
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title, readyState: document.readyState, body: !!document.body, root: !!document.querySelector(".wbs-root"), widget: !!window.__wbsWidget, diag: !!window.__wbsDiag })',
        returnByValue: true,
      });
      result.injection = r && r.result && r.result.value;
    } catch (e) {
      result.injection = { error: e.message };
    }
  }
  return result;
}

async function writeDiagnosticsSnapshot(reason) {
  try {
    const snapshot = await collectDiagnostics(reason);
    const tmp = DIAGNOSTICS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DIAGNOSTICS_FILE);
    log(`[diag] 已写入本地诊断快照 (${reason || 'manual'}): ${DIAGNOSTICS_FILE}`);
    return snapshot;
  } catch (e) {
    log(`[diag] 写入诊断快照失败: ${e.message}`);
    return null;
  }
}

/* ================= 本地 Web 服务 ================= */


// ===== SESSIONS_API_MARK：会话管理（读 WorkBuddy workbuddy.db）=====
const SESSIONS_DB = PROFILE.sessionDb;
const SESSION_DB = createSessionDb({ dbPath: SESSIONS_DB });

function sqliteRun(sql, params = []) {
  if (PROFILE.kind === 'codebuddy') {
    return Promise.reject(new Error(`${PROFILE.name} 会话库暂只支持读取`));
  }
  return SESSION_DB.run(sql, params);
}
function codeBuddySessionRows() {
  return SESSION_DB.all("SELECT key, value FROM ItemTable WHERE key LIKE 'session:%'")
    .then((items) => items.map((item) => {
        let value = {};
        try { value = typeof item.value === 'string' ? JSON.parse(item.value) : (item.value || {}); } catch (_) {}
        const id = String(value.conversationId || String(item.key || '').replace(/^session:/, ''));
        return {
          id, cwd: value.cwd || '', user_id: value.userId || '', title: value.title || '', custom_title: value.title || '',
          status: value.status || '', created_at: value.createdAt || null, updated_at: value.updatedAt || null,
          last_activity_at: value.updatedAt || null, is_playground: value.isPlayground ? 1 : 0,
          deleted_at: null, source_mode: value.mode || 'agents', mode: value.mode || 'agents', model: value.model || '',
        };
      }))
    .catch((e) => { throw new Error('CodeBuddy 会话库读取失败: ' + e.message); });
}
function sqlParamAt(textSql, params, questionIndex) {
  return params[parameterCount(textSql.slice(0, questionIndex + 1)) - 1];
}
async function sqliteQuery(sql, params = []) {
  const expectedParams = parameterCount(sql);
  if (expectedParams !== params.length) {
    throw new Error(`sqlite 参数数量不匹配: SQL 需要 ${expectedParams} 个，实际收到 ${params.length} 个`);
  }
  if (PROFILE.kind === 'codebuddy') {
    const rows = await codeBuddySessionRows();
    const textSql = String(sql || '');
    const uidMatch = /user_id\s*=\s*\?/i.exec(textSql);
    const idMatch = /id\s+IN\s*\(([^)]*)\)/i.exec(textSql);
    const singleIdMatch = /\bid\s*=\s*\?/i.exec(textSql);
    let filtered = rows;
    if (uidMatch) {
      const questionIndex = textSql.indexOf('?', uidMatch.index);
      const uid = sqlParamAt(textSql, params, questionIndex);
      filtered = filtered.filter((r) => String(r.user_id) === String(uid));
    }
    if (idMatch) {
      const questionIndex = textSql.indexOf('?', idMatch.index);
      const start = parameterCount(textSql.slice(0, questionIndex + 1)) - 1;
      const ids = new Set(params.slice(start, start + parameterCount(idMatch[1])).map(String));
      filtered = filtered.filter((r) => ids.has(String(r.id)));
    }
    if (singleIdMatch) {
      const questionIndex = textSql.indexOf('?', singleIdMatch.index);
      const id = sqlParamAt(textSql, params, questionIndex);
      filtered = filtered.filter((r) => String(r.id) === String(id));
    }
    if (/SELECT\s+DISTINCT\s+cwd/i.test(textSql)) return Array.from(new Set(filtered.map((r) => r.cwd).filter(Boolean))).map((cwd) => ({ cwd }));
    if (/SELECT\s+user_id/i.test(textSql) && /LIMIT\s+1/i.test(textSql)) return filtered.slice(0, 1).map((r) => ({ user_id: r.user_id }));
    return filtered;
  }
  const rows = await SESSION_DB.all(sql, params);
  // Keep the existing API contract (SQLite cells were strings, NULL was empty)
  // while avoiding the delimiter/newline corruption of the former text parser.
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value === null || value === undefined ? '' : String(value).trim(),
  ])));
}

// WorkBuddy 将会话正文保存在 ~/.workbuddy*/projects 等系统目录，同时在 sessions.cwd
// 保存该会话所属的工作目录。cwd 被用户移动/清理后，官方会话页仍能列出记录，但打开时
// 会报“工作目录可能已被重命名或删除”。仅凭数据库记录创建目录过于宽松，因此这里要求
// 会话载荷确实存在，并逐级拒绝符号链接/普通文件后再创建缺失目录。
function sessionPayloadExists(wbHome, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id || !/^[0-9a-f-]{16,}$/i.test(id)) return false;
  const projects = path.join(wbHome, 'projects');
  try {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (fs.existsSync(path.join(projects, entry.name, id + '.jsonl')) ||
          fs.existsSync(path.join(projects, entry.name, id))) return true;
    }
  } catch (_) {}
  return [
    path.join(wbHome, 'workspace', 'sessions', id),
    path.join(wbHome, 'tasks', id),
    path.join(wbHome, 'file-history', id),
    path.join(wbHome, 'artifact-index', id + '.json'),
  ].some((target) => fs.existsSync(target));
}

function createDirectoryNoFollow(directory) {
  const target = path.resolve(String(directory || ''));
  if (!path.isAbsolute(target)) throw new Error('cwd 不是绝对路径');
  const parsed = path.parse(target);
  if (!parsed.root || target === parsed.root) throw new Error('拒绝在文件系统根目录创建会话空间');
  let current = parsed.root;
  for (const part of path.relative(parsed.root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('cwd 路径包含符号链接或普通文件');
    } catch (error) {
      if (error && error.code === 'ENOENT') fs.mkdirSync(current);
      else throw error;
    }
  }
}

let sessionCwdRepairInFlight = null;
function repairMissingSessionWorkspaces() {
  if (sessionCwdRepairInFlight) return sessionCwdRepairInFlight;
  sessionCwdRepairInFlight = (async () => {
    if (!IS_WIN || PROFILE.kind !== 'workbuddy') return { repaired: [], skipped: 0 };
    const wbHome = path.dirname(SESSIONS_DB);
    const rows = await sqliteQuery("SELECT id, cwd FROM sessions WHERE deleted_at IS NULL AND cwd IS NOT NULL AND cwd != '';" );
    const repaired = [];
    let skipped = 0;
    for (const row of rows.slice(0, 2000)) {
      const cwd = String(row.cwd || '').trim();
      if (!cwd || fs.existsSync(cwd) || !sessionPayloadExists(wbHome, row.id)) { skipped++; continue; }
      try {
        createDirectoryNoFollow(cwd);
        if (fs.statSync(cwd).isDirectory()) repaired.push(cwd);
      } catch (error) {
        skipped++;
        log(`[sessions-cwd-repair] 跳过 ${cwd}: ${error.message}`);
      }
    }
    if (repaired.length) log(`[sessions-cwd-repair] 已恢复 ${repaired.length} 个会话工作目录（消息文件未改动）`);
    return { repaired, skipped };
  })();
  sessionCwdRepairInFlight.finally(() => { sessionCwdRepairInFlight = null; }).catch(() => {});
  return sessionCwdRepairInFlight;
}

function sessionRangeMs(range) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === '7d') return now - 7 * day;
  if (range === '30d') return now - 30 * day;
  return 0;
}

// 复制会话的消息文件：projects/<项目>/<id>.jsonl + <id>/、workspace/sessions/<id>/、
// tasks/<id>/、file-history/<id>/、artifact-index/<id>.json（全部以新 id 命名复制）
function copySessionFiles(wbHome, oldId, newId) {
  const fsMod = fs;
  const result = { copied: 0, failed: 0 };
  const copyOne = (from, to) => {
    try {
      if (!fsMod.existsSync(from)) return;
      const fromResolved = path.resolve(from);
      const toResolved = path.resolve(to);
      const relative = path.relative(fromResolved, toResolved);
      const targetInsideSource = relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      if (targetInsideSource) {
        log('[sessions-copy] 跳过源目录内复制 ' + from + ' -> ' + to);
        return;
      }
      fsMod.mkdirSync(path.dirname(to), { recursive: true });
      fsMod.cpSync(from, to, { recursive: true, force: true });
      result.copied++;
    } catch (e) {
      result.failed++;
      log('[sessions-copy] 复制文件失败 ' + from + ': ' + e.message);
    }
  };
  // 1) projects/<项目hash>/<id>.jsonl 与 <id>/ 目录（消息正文核心）
  const projDir = path.join(wbHome, 'projects');
  try {
    if (fsMod.existsSync(projDir)) {
      const projs = fsMod.readdirSync(projDir);
      for (const pj of projs) {
        const pjPath = path.join(projDir, pj);
        if (!fsMod.statSync(pjPath).isDirectory()) continue;
        copyOne(path.join(pjPath, oldId + '.jsonl'), path.join(pjPath, newId + '.jsonl'));
        copyOne(path.join(pjPath, oldId), path.join(pjPath, newId));
      }
    }
  } catch (_) {}
  // 2) workspace/sessions/<id>/
  copyOne(path.join(wbHome, 'workspace', 'sessions', oldId), path.join(wbHome, 'workspace', 'sessions', newId));
  // 3) tasks/<id>/
  copyOne(path.join(wbHome, 'tasks', oldId), path.join(wbHome, 'tasks', newId));
  // 4) file-history/<id>/
  copyOne(path.join(wbHome, 'file-history', oldId), path.join(wbHome, 'file-history', newId));
  // 5) artifact-index/<id>.json
  copyOne(path.join(wbHome, 'artifact-index', oldId + '.json'), path.join(wbHome, 'artifact-index', newId + '.json'));
  log('[sessions-copy] 已复制消息文件 ' + oldId + ' -> ' + newId);
  return result;
}

function sessionContentMtime(wbHome, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return 0;
  let latest = 0;
  const visit = (target) => {
    let stat;
    try { stat = fs.lstatSync(target); } catch (_) { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { latest = Math.max(latest, Number(stat.mtimeMs || 0)); return; }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      visit(path.join(target, entry.name));
    }
  };
  const projects = path.join(wbHome, 'projects');
  try {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(path.join(projects, entry.name, id + '.jsonl'));
      visit(path.join(projects, entry.name, id));
    }
  } catch (_) {}
  for (const target of [
    path.join(wbHome, 'workspace', 'sessions', id),
    path.join(wbHome, 'tasks', id),
    path.join(wbHome, 'file-history', id),
    path.join(wbHome, 'artifact-index', id + '.json'),
  ]) visit(target);
  return latest;
}

// Reconcile every live member of a shared lineage.  A switch can arrive after
// either account has received new messages, so the active account is not a
// reliable source of truth; choose the freshest on-disk snapshot first.
async function syncAutoCopyLineage(lineageId, targetUid) {
  if (!lineageId || PROFILE.kind !== 'workbuddy') return { members: 0, synced: 0, failedFiles: 0, targetIds: [], targetPresent: false };
  const records = getAutoCopySessionMemberRecords(DATA_DIR, lineageId);
  if (!records.length) return { members: 0, synced: 0, failedFiles: 0, targetIds: [], targetPresent: false };
  const live = [];
  for (const member of records) {
    const rows = await sqliteQuery(
      'SELECT ' + SESSION_COPY_COLUMNS.join(',') + ' FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1;',
      [member.id, member.uid]
    );
    if (!rows.length) continue;
    live.push(Object.assign({}, member, {
      row: rows[0],
      contentMtime: sessionContentMtime(PROFILE.dataRoot, member.id),
      updatedAt: Number(rows[0].updated_at || rows[0].last_activity_at || rows[0].created_at || 0),
    }));
  }
  const targetIds = live.map((member) => member.id);
  const targetPresent = targetUid === undefined || live.some((member) => member.uid === String(targetUid || '').trim());
  if (live.length < 2) return { members: live.length, synced: 0, failedFiles: 0, targetIds, targetPresent };
  const latest = selectLatestAutoCopyMember(live);
  if (!latest) return { members: live.length, synced: 0, failedFiles: 0, targetIds, targetPresent };
  const sourceRow = latest.row;
  let synced = 0;
  let failedFiles = 0;
  for (const target of live) {
    if (target.id === latest.id) continue;
    const files = copySessionFiles(PROFILE.dataRoot, latest.id, target.id);
    synced++;
    failedFiles += files.failed;
    try {
      await sqliteRun(
        'UPDATE sessions SET title = ?, custom_title = ?, status = ?, updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL;',
        [sourceRow.title || '', sourceRow.custom_title || '', sourceRow.status || 'Pending',
          Number(sourceRow.updated_at || Date.now()), Number(sourceRow.last_activity_at || sourceRow.updated_at || Date.now()),
          target.id, target.uid]
      );
    } catch (error) {
      log(`[sessions-auto-copy] 同步会话元数据失败 ${target.uid}/${target.id}: ${error.message}`);
    }
  }
  return { members: live.length, synced, failedFiles, sourceId: latest.id, targetIds, targetPresent };
}

const MAX_SESSION_EXPORT_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_EXPORT_FILES = 20000;

function archiveRelativePath(wbHome, target) {
  return path.relative(wbHome, target).split(path.sep).join('/');
}

function collectSessionArchiveFiles(wbHome, sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error('无效的会话 ID');
  const files = [];
  let totalBytes = 0;
  const collect = (target) => {
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        collect(path.join(target, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (files.length >= MAX_SESSION_EXPORT_FILES) throw new Error('会话附件文件过多，无法导出');
    if (totalBytes + stat.size > MAX_SESSION_EXPORT_BYTES) throw new Error('会话附件超过 256 MB，无法导出');
    const relative = archiveRelativePath(wbHome, target);
    // Validate every exported path with the same mapper used during import.
    remapSessionArchivePath(relative, sessionId, sessionId);
    const content = fs.readFileSync(target);
    totalBytes += content.length;
    if (totalBytes > MAX_SESSION_EXPORT_BYTES) throw new Error('会话附件超过 256 MB，无法导出');
    files.push({ path: relative, data: content.toString('base64') });
  };

  const projects = path.join(wbHome, 'projects');
  try {
    const projectEntries = fs.readdirSync(projects, { withFileTypes: true });
    for (const project of projectEntries) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectRoot = path.join(projects, project.name);
      collect(path.join(projectRoot, sessionId + '.jsonl'));
      collect(path.join(projectRoot, sessionId));
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  collect(path.join(wbHome, 'workspace', 'sessions', sessionId));
  collect(path.join(wbHome, 'tasks', sessionId));
  collect(path.join(wbHome, 'file-history', sessionId));
  collect(path.join(wbHome, 'artifact-index', sessionId + '.json'));
  return files;
}

function ensureArchiveParentNoFollow(wbHome, target) {
  const root = path.resolve(wbHome);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('WorkBuddy 数据目录不是受管目录');
  const parent = path.dirname(resolveArchiveTarget(root, archiveRelativePath(root, target)));
  const relative = path.relative(root, parent);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('会话归档目标包含符号链接或普通文件');
    } catch (error) {
      if (error && error.code === 'ENOENT') fs.mkdirSync(current, { mode: 0o700 });
      else throw error;
    }
  }
}

function restoreSessionArchiveFiles(wbHome, sessionArchive, newId) {
  const oldId = String(sessionArchive && sessionArchive.record && sessionArchive.record.id || '');
  if (!isValidSessionId(oldId) || !isValidSessionId(newId)) throw new Error('会话归档包含无效 ID');
  const sourceFiles = Array.isArray(sessionArchive.files) ? sessionArchive.files : [];
  if (sourceFiles.length > MAX_SESSION_EXPORT_FILES) throw new Error('会话归档附件文件过多');
  let totalBytes = 0;
  const targets = new Set();
  for (const entry of sourceFiles) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.data !== 'string' || entry.data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) {
      throw new Error('会话归档包含无效附件');
    }
    const relative = remapSessionArchivePath(entry.path, oldId, newId);
    const target = resolveArchiveTarget(wbHome, relative);
    if (targets.has(target)) throw new Error('会话归档包含重复附件路径');
    targets.add(target);
    const content = Buffer.from(entry.data, 'base64');
    totalBytes += content.length;
    if (totalBytes > MAX_SESSION_EXPORT_BYTES) throw new Error('会话归档附件超过 256 MB');
    ensureArchiveParentNoFollow(wbHome, target);
    fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  }
  return sourceFiles.length;
}

const SESSION_COPY_COLUMNS = [
  'id', 'cwd', 'user_id', 'title', 'custom_title', 'status', 'created_at', 'updated_at',
  'last_activity_at', 'is_playground', 'source_mode', 'is_background_automation', 'mode', 'model',
  'expert_id', 'expert_locale', 'expert_runtime_identity', 'expert_marketplace', 'permission_mode',
  'use_sandbox_cli', 'project_id',
];
const sessionCopyLocks = new Map();

function isTaskSessionRecord(cwd) {
  // WorkBuddy 的普通工作区也使用 WorkBuddy\\YYYY-MM-DD-HH-MM-SS；仅凭 cwd 无法可靠区分任务会话。
  return false;
}

function sqlPlaceholders(values) {
  return values.map(() => '?').join(',');
}

async function insertCopiedSession(src, targetUid, newId) {
  const vals = [
    newId,
    src.cwd || '',
    targetUid,
    src.title || '',
    src.custom_title || '',
    src.status || 'Pending',
    Number(src.created_at || Date.now()),
    Date.now(),
    Number(src.last_activity_at || src.updated_at || Date.now()),
    Number(src.is_playground || 0),
    src.source_mode || null,
    src.is_background_automation === null || src.is_background_automation === undefined || src.is_background_automation === '' ? null : Number(src.is_background_automation),
    src.mode || null,
    src.model || null,
    src.expert_id || null,
    src.expert_locale || null,
    src.expert_runtime_identity || null,
    src.expert_marketplace || null,
    src.permission_mode || null,
    src.use_sandbox_cli === null || src.use_sandbox_cli === undefined || src.use_sandbox_cli === '' ? null : Number(src.use_sandbox_cli),
    src.project_id || null,
  ];
  await sqliteRun(
    'INSERT INTO sessions (' + SESSION_COPY_COLUMNS.join(',') + ') VALUES (' + sqlPlaceholders(vals) + ');',
    vals
  );
}

async function exportSessions(ids, password) {
  const selectedIds = normalizeSessionIdBatch(ids);
  if (!selectedIds.length) throw new Error('未选择会话');
  requiredPassword(password);
  const rows = await sqliteQuery(
    'SELECT ' + SESSION_COPY_COLUMNS.join(',') + ' FROM sessions WHERE id IN (' + sqlPlaceholders(selectedIds) + ') AND deleted_at IS NULL;',
    selectedIds
  );
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const wbHome = PROFILE.dataRoot;
  const sessions = selectedIds.filter((id) => byId.has(id)).map((id) => {
    const record = byId.get(id);
    return { record, files: collectSessionArchiveFiles(wbHome, id) };
  });
  if (!sessions.length) throw new Error('没有可导出的会话');
  const payload = { exportType: 'WorkDaddy-sessions', version: 1, sessions };
  const content = createEncryptedExport('sessions', payload, password);
  return {
    filename: 'WorkDaddy-会话导出-' + new Date().toISOString().slice(0, 10) + '.json',
    content,
    count: sessions.length,
  };
}

function validImportedSessionUid(value) {
  const uid = String(value || '').trim();
  if (!uid || uid.length > 200 || /[\x00-\x1f\x7f]/.test(uid)) throw new Error('会话归档缺少有效的账号归属');
  return uid;
}

async function importSessions(content, password, targetUid) {
  const payload = openEncryptedExport(content, 'sessions', password);
  const archives = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!archives.length) throw new Error('导入文件中没有会话数据');
  if (archives.length > 100) throw new Error('单次最多导入 100 个会话');
  const overrideUid = typeof targetUid === 'string' && targetUid.trim() ? validImportedSessionUid(targetUid) : '';
  const currentUid = String((currentAccount() || {}).uid || '').trim();
  const imported = [];
  const errors = [];
  for (const archive of archives) {
    const record = archive && archive.record;
    const oldId = String(record && record.id || '');
    if (!record || !isValidSessionId(oldId)) { errors.push('无效会话记录'); continue; }
    let ownerUid;
    try { ownerUid = overrideUid || validImportedSessionUid(record.user_id || currentUid); }
    catch (error) { errors.push(error.message); continue; }
    const newId = crypto.randomUUID();
    try {
      restoreSessionArchiveFiles(PROFILE.dataRoot, archive, newId);
      await insertCopiedSession(record, ownerUid, newId);
      imported.push({ sourceId: oldId, id: newId, uid: ownerUid });
    } catch (error) {
      try { deleteSessionFiles(PROFILE.dataRoot, newId); } catch (_) {}
      errors.push(error.message);
    }
  }
  if (!imported.length) throw new Error(errors[0] || '没有可导入的会话');
  return { imported, failed: errors.length };
}

async function copySessionRecord(src, targetUid, options = {}) {
  const sourceUid = String(options.sourceUid || src.user_id || '').trim();
  const auto = !!options.auto;
  const wbHome = PROFILE.dataRoot;
  let lineageId = options.lineageId || null;
  const sourceLineage = sourceUid ? getAutoCopySession(DATA_DIR, sourceUid, src.id) : { lineageId: null, enabled: false };
  if (!lineageId && sourceLineage.enabled) lineageId = sourceLineage.lineageId;
  if (auto && sourceUid && !lineageId) lineageId = ensureAutoCopySession(DATA_DIR, sourceUid, src.id);
  const perform = async () => {
  if (sourceUid && lineageId) {
    const mapping = getAutoCopyMapping(DATA_DIR, lineageId, targetUid);
    if (mapping && mapping.targetId) {
      const existing = await sqliteQuery(
        'SELECT id, user_id FROM sessions WHERE id = ? AND deleted_at IS NULL LIMIT 1;',
        [mapping.targetId]
      );
      if (existing.length && String(existing[0].user_id || '') === String(targetUid)) {
        const files = copySessionFiles(wbHome, src.id, mapping.targetId);
        addAutoCopySessionMember(DATA_DIR, lineageId, targetUid, mapping.targetId);
        setAutoCopyMapping(DATA_DIR, lineageId, targetUid, {
          targetId: mapping.targetId,
          status: files.failed ? 'partial' : 'copied',
          failedFiles: files.failed,
        });
        return { status: files.failed ? 'partial' : 'skipped', sourceId: src.id, targetId: mapping.targetId, failedFiles: files.failed };
      }
      deleteAutoCopyMapping(DATA_DIR, lineageId, targetUid);
    }

    // A stale/missing mapping used to cause a fresh INSERT even when this
    // lineage already contained a target session.  That produced one duplicate
    // session on every account switch after the mapping was lost.  Treat the
    // lineage members as the authoritative fallback and choose a stable
    // canonical row when old data contains more than one member for the uid.
    const memberIds = getAutoCopySessionMembers(DATA_DIR, lineageId, targetUid)
      .filter((id) => String(id) !== String(src.id));
    if (memberIds.length) {
      const candidates = [];
      for (let index = 0; index < memberIds.length; index++) {
        const rows = await sqliteQuery(
          'SELECT id, user_id, created_at, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL LIMIT 1;',
          [memberIds[index]]
        );
        if (rows.length && String(rows[0].user_id || '') === String(targetUid)) {
          candidates.push(Object.assign({ memberIndex: index }, rows[0]));
        }
      }
      candidates.sort((a, b) => {
        const created = Number(a.created_at || 0) - Number(b.created_at || 0);
        if (created) return created;
        const updated = Number(a.updated_at || 0) - Number(b.updated_at || 0);
        if (updated) return updated;
        return a.memberIndex - b.memberIndex;
      });
      if (candidates.length) {
        const canonicalId = candidates[0].id;
        const files = copySessionFiles(wbHome, src.id, canonicalId);
        addAutoCopySessionMember(DATA_DIR, lineageId, targetUid, canonicalId);
        setAutoCopyMapping(DATA_DIR, lineageId, targetUid, {
          targetId: canonicalId,
          status: files.failed ? 'partial' : 'copied',
          failedFiles: files.failed,
        });
        return { status: files.failed ? 'partial' : 'skipped', sourceId: src.id, targetId: canonicalId, failedFiles: files.failed };
      }
    }
  }

  const newId = crypto.randomUUID();
  await insertCopiedSession(src, targetUid, newId);
  const files = copySessionFiles(wbHome, src.id, newId);
  if (lineageId) {
    addAutoCopySessionMember(DATA_DIR, lineageId, targetUid, newId);
    setAutoCopyMapping(DATA_DIR, lineageId, targetUid, {
      targetId: newId,
      status: files.failed ? 'partial' : 'copied',
      failedFiles: files.failed,
    });
  }
  return { status: files.failed ? 'partial' : 'copied', sourceId: src.id, targetId: newId, failedFiles: files.failed };
  };
  if (!lineageId) return perform();
  const lockKey = JSON.stringify([lineageId, String(targetUid || '')]);
  const previous = sessionCopyLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(perform);
  sessionCopyLocks.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (sessionCopyLocks.get(lockKey) === current) sessionCopyLocks.delete(lockKey);
  }
}

async function buildAutoCopyPlan(sourceUid, targetUid) {
  const source = String(sourceUid || '').trim();
  const target = String(targetUid || '').trim();
  if (!source || !target || source === target) return [];
  const rules = getAutoCopyRules(DATA_DIR, source);
  if (!rules.sessionIds.length && !rules.workspaces.length) return [];
  const rows = await sqliteQuery(
    'SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, source_mode, is_background_automation, mode, model, expert_id, expert_locale, expert_runtime_identity, expert_marketplace, permission_mode, use_sandbox_cli, project_id ' +
    'FROM sessions WHERE deleted_at IS NULL AND user_id = ? ORDER BY created_at DESC;',
    [source]
  );
  const sessionSet = new Set(rules.sessionIds);
  const workspaceSet = new Set(rules.workspaces.map(canonicalWorkspace));
  return rows
    .filter((row) => sessionSet.has(String(row.id)) || workspaceSet.has(canonicalWorkspace(row.cwd)))
    .map((row) => {
      let lineageId = rules.lineages[String(row.id)] || null;
      // Workspace rules also represent shared sessions.  Give each matching
      // row a lineage so later switches reuse one target and reconcile its
      // newest snapshot instead of inserting a duplicate every time.
      if (!lineageId && workspaceSet.has(canonicalWorkspace(row.cwd))) {
        lineageId = ensureAutoCopySession(DATA_DIR, source, row.id);
      }
      return Object.assign({}, row, { lineageId });
    });
}

const autoCopyJobs = new Map();
const autoCopyQueue = [];
let autoCopyWorkerRunning = false;

function hasPendingAutoCopyTo(uid) {
  const target = String(uid || '').trim();
  if (!target) return false;
  for (const job of autoCopyJobs.values()) {
    if (job.targetUid === target && (job.status === 'queued' || job.status === 'running')) return true;
  }
  return false;
}

function pruneAutoCopyJobs() {
  const completed = Array.from(autoCopyJobs.values())
    .filter((job) => job.status === 'done' || job.status === 'partial' || job.status === 'error')
    .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  while (completed.length > 100) {
    const oldest = completed.shift();
    autoCopyJobs.delete(oldest.id);
  }
}

function runAutoCopyQueue() {
  if (autoCopyWorkerRunning || !autoCopyQueue.length) return;
  autoCopyWorkerRunning = true;
  const item = autoCopyQueue.shift();
  item.run()
    .catch((e) => {
      const job = item.job;
      job.status = 'error';
      job.error = e.message;
      job.finishedAt = Date.now();
      log(`[sessions-auto-copy] 任务失败: ${e.message}`);
      const cleanup = setTimeout(() => autoCopyJobs.delete(job.id), 30 * 60 * 1000);
      if (cleanup.unref) cleanup.unref();
      pruneAutoCopyJobs();
    })
    .finally(() => {
      autoCopyWorkerRunning = false;
      runAutoCopyQueue();
    });
}

function startAutoCopyJob(sourceUid, targetUid, plan) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    sourceUid,
    targetUid,
    plan: Array.isArray(plan) ? plan : [],
    total: Array.isArray(plan) ? plan.length : 0,
    processed: 0,
    copied: 0,
    skipped: 0,
    failed: 0,
    partial: 0,
    error: null,
    startedAt: Date.now(),
  };
  autoCopyJobs.set(id, job);
  const run = async () => {
    job.status = 'running';
    // A rapid switch chain may enqueue this job before the previous copy has
    // created the target rows. Re-plan after the queue reaches this job.
    job.plan = await buildAutoCopyPlan(sourceUid, targetUid);
    job.total = job.plan.length;
    for (const src of job.plan) {
      try {
        let result;
        if (src.lineageId) {
          // If the target already belongs to this lineage, reconcile all
          // members before/after the switch instead of blindly overwriting it
          // from the account that happened to be active most recently.
          const synced = await syncAutoCopyLineage(src.lineageId, targetUid);
          if (synced.targetPresent) {
            result = { status: synced.failedFiles ? 'partial' : 'skipped', failedFiles: synced.failedFiles };
          } else {
            result = await copySessionRecord(src, targetUid, {
              sourceUid,
              lineageId: src.lineageId,
              auto: true,
            });
            const synced = await syncAutoCopyLineage(src.lineageId, targetUid);
            result.failedFiles = (result.failedFiles || 0) + synced.failedFiles;
            if (synced.failedFiles) result.status = 'partial';
          }
        } else {
          result = await copySessionRecord(src, targetUid, { sourceUid, auto: true });
        }
        if (result.status === 'skipped') job.skipped++;
        else if (result.status === 'partial') job.partial++;
        else job.copied++;
        if (result.failedFiles) job.failed += result.failedFiles;
      } catch (e) {
        job.failed++;
        log(`[sessions-auto-copy] ${sourceUid} -> ${targetUid} 会话 ${src.id} 失败: ${e.message}`);
      }
      job.processed++;
    }
    job.status = job.failed || job.partial ? 'partial' : 'done';
    job.finishedAt = Date.now();
    log(`[sessions-auto-copy] ${sourceUid} -> ${targetUid} 完成 total=${job.total} copied=${job.copied} skipped=${job.skipped} partial=${job.partial} failed=${job.failed}`);
    const cleanup = setTimeout(() => autoCopyJobs.delete(id), 30 * 60 * 1000);
    if (cleanup.unref) cleanup.unref();
    pruneAutoCopyJobs();
  };
  // Serialising jobs makes a chain such as h -> s -> x observe the sessions
  // created by the preceding job, even when the user switches rapidly.
  autoCopyQueue.push({ job, run });
  runAutoCopyQueue();
  return job;
}

function publicAutoCopyJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    copied: job.copied,
    skipped: job.skipped,
    partial: job.partial,
    failed: job.failed,
    error: job.error,
  };
}

const MAX_SESSION_ID_LENGTH = 200;

function isValidSessionId(id) {
  if (typeof id !== 'string' || !id || id.length > MAX_SESSION_ID_LENGTH) return false;
  if (id === '.' || id === '..' || /[\\/\x00-\x1f\x7f]/.test(id)) return false;
  if (/^[ .]|[ .]$/.test(id) || /[<>:"|?*]/.test(id)) return false;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) return false;
  if (/^[A-Za-z]:/.test(id) || path.posix.isAbsolute(id) || path.win32.isAbsolute(id)) return false;
  return true;
}

function matchedSessionIds(requestedIds, rows) {
  const selected = new Set((rows || []).map((row) => String(row && row.id || '')));
  return Array.from(new Set(requestedIds)).filter((id) => selected.has(id));
}

function resolveManagedSessionTarget(parent, leaf) {
  if (typeof leaf !== 'string' || !leaf || leaf === '.' || leaf === '..' || /[\\/\x00]/.test(leaf)) {
    throw new Error('无效的会话文件目标');
  }
  const managedParent = path.resolve(parent);
  const target = path.resolve(managedParent, leaf);
  const relative = path.relative(managedParent, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('会话文件目标不在 managed parent 内');
  }
  return target;
}

function isManagedDirectoryNoFollow(wbHome, directory) {
  const root = path.resolve(wbHome);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('managed directory escaped the WorkBuddy data root');
  }
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('managed directory contains a symbolic link or non-directory: ' + current);
    }
  }
  return true;
}

// 真实删除会话的消息文件：projects/<项目>/<id>.jsonl + <id>/、workspace/sessions/<id>/、
// tasks/<id>/、file-history/<id>/、artifact-index/<id>.json（全部按会话 id 精确删除，不可恢复）
function deleteSessionFiles(wbHome, id) {
  if (!isValidSessionId(id)) throw new Error('无效的会话 ID');
  let removed = 0;
  const delOne = (parent, leaf) => {
    let target;
    try {
      if (!isManagedDirectoryNoFollow(wbHome, parent)) return false;
      target = resolveManagedSessionTarget(parent, leaf);
      const targetStat = fs.lstatSync(target);
      if (targetStat.isSymbolicLink()) fs.unlinkSync(target);
      else fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      log('[sessions-delete] 删除文件失败 ' + (target || parent) + ': ' + e.message);
      throw e;
    }
  };
  // 1) projects/<项目hash>/<id>.jsonl 与 <id>/ 目录（消息正文核心）
  const projDir = path.join(wbHome, 'projects');
  try {
    if (isManagedDirectoryNoFollow(wbHome, projDir)) {
      const projs = fs.readdirSync(projDir, { withFileTypes: true });
      for (const entry of projs) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const pjPath = resolveManagedSessionTarget(projDir, entry.name);
        const projectStat = fs.lstatSync(pjPath);
        if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) continue;
        if (delOne(pjPath, id + '.jsonl')) removed++;
        if (delOne(pjPath, id)) removed++;
      }
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  // 2) workspace/sessions/<id>/
  if (delOne(path.join(wbHome, 'workspace', 'sessions'), id)) removed++;
  // 3) tasks/<id>/
  if (delOne(path.join(wbHome, 'tasks'), id)) removed++;
  // 4) file-history/<id>/
  if (delOne(path.join(wbHome, 'file-history'), id)) removed++;
  // 5) artifact-index/<id>.json
  if (delOne(path.join(wbHome, 'artifact-index'), id + '.json')) removed++;
  if (removed) log('[sessions-delete] 已删除消息文件 ' + id + '（' + removed + ' 项）');
  return removed;
}

function json(res, code, obj) {
  // 异步路由的成功/失败分支可能在响应已结束后再次进入 catch；响应只能写一次。
  if (res.writableEnded || res.destroyed) return false;
  if (res.headersSent) {
    try { res.end(); } catch (_) {}
    return false;
  }
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  };
  // 只回显经过来源校验的 Origin；绝不再使用 *，避免恶意网页读取账号/会话响应。
  if (res.__wbsCorsOrigin) {
    headers['Access-Control-Allow-Origin'] = res.__wbsCorsOrigin;
    headers.Vary = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(body);
}

const PUBLIC_API_PATHS = new Set([
  '/api/status',
  '/api/about',
  '/api/about/',
  '/api/update-check',
  '/api/update-status',
]);

function isAllowedApiOrigin(origin) {
  if (!origin) return true; // 本地 CLI/启动器请求没有 Origin
  if (origin === 'null') return true; // Electron file:// renderer
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(u.hostname || '').toLowerCase();
    // WorkBuddy 的 renderer 可能是官方网页来源，也可能是 loopback DevTools 页面。
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (loopback) return true;
    if (PROFILE.customTarget) return !!PROFILE.apiHost && u.origin === PROFILE.apiHost;
    return host === 'workbuddy.cn' || host.endsWith('.workbuddy.cn') ||
      host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai') ||
      host === 'codebuddy.cn' || host.endsWith('.codebuddy.cn') ||
      host === 'codebuddy.ai' || host.endsWith('.codebuddy.ai');
  } catch (_) {
    return false;
  }
}

function hasApiToken(req) {
  const supplied = String(req.headers['x-workdaddy-token'] || '');
  const expected = Buffer.from(API_TOKEN, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isApiRequestAuthorized(req, p) {
  const origin = String(req.headers.origin || '');
  if (origin && !isAllowedApiOrigin(origin)) return false;
  if (PUBLIC_API_PATHS.has(p)) return true;
  // 保留无 Origin 的手动 launcher/curl 注入兼容；诊断面包屑仍需当前 profile token。
  if (!origin && p === '/api/inject') return true;
  return hasApiToken(req);
}

function isAllowedDevtoolsOrigin(origin, upstreamPort) {
  if (!origin) return true; // 仅允许无浏览器来源的本地调试客户端
  try {
    const u = new URL(origin);
    const host = String(u.hostname || '').toLowerCase();
    const port = String(u.port || (u.protocol === 'https:' ? 443 : 80));
    return (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') && port === String(upstreamPort);
  } catch (_) {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

/* ================= 决策弹窗开关（全局自定义指令注入） =================
 * WorkBuddy 官方「自定义指令」(settings.personalization.customPrompt) 会渲染进
 * user-context-identity.tpl 的 <user_custom_instructions> 区块（模板原文：
 * "The user has provided the following custom instructions. You MUST follow them
 * in all responses..."），对每个会话全局生效。
 * 插件在此写入一段「需要用户决策时必须调用 AskUserQuestion 弹窗提问」的规则，
 * 用标记包裹便于开关时精确增删；用户原有的自定义指令内容保留不动。
 */
const ASK_MODE_TAG_START = '<!-- wbs-ask-mode:start -->';
const ASK_MODE_TAG_END = '<!-- wbs-ask-mode:end -->';
const ASK_MODE_RULE = [
  'Always use the AskUserQuestion tool to ask the user for decisions at the conversation level instead of plain chat text.',
  '',
  '1. Use the AskUserQuestion tool when you need the user to make a decision, choose between options, or clarify ambiguous requirements about the DIRECTION of the work (what to build, which approach to take, what trade-offs to accept, etc.).',
  '2. Do NOT pop up a confirmation dialog for routine tool operations that have already been authorized by the user (e.g. file deletion, file modification, batch operations, running shell commands, switching accounts, etc.). Execute them directly. The system-level permission dialogs (such as "允许完全访问" / "Allow Full Access") are handled by WorkBuddy itself — once the user has granted full access, do NOT ask again for individual file operations.',
  '3. Do NOT ask the user for decisions or confirmation in plain chat text.',
  '4. Do NOT produce a final answer while a decision is pending; wait for the user answer to the AskUserQuestion tool.',
  '5. Use concise questions with 2-4 concrete options whenever possible.',
  'Exception: if the AskUserQuestion tool is unavailable in the current channel (e.g. IM), fall back to asking in text.'
].join('\n');

function workbuddySettingsPath() {
  return path.join(PROFILE.dataRoot, 'settings.json');
}

function readWorkbuddySettings() {
  try {
    return JSON.parse(fs.readFileSync(workbuddySettingsPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeWorkbuddySettings(settings) {
  const file = workbuddySettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceFileWithRetry(file, JSON.stringify(settings, null, 2) + '\n');
}

function buildAskRuleBlock() {
  return ASK_MODE_TAG_START + '\n' + ASK_MODE_RULE + '\n' + ASK_MODE_TAG_END;
}

/** 从 customPrompt 中移除 wbs 规则段（保留用户其它内容） */
function stripAskRule(customPrompt) {
  if (typeof customPrompt !== 'string') return '';
  const start = customPrompt.indexOf(ASK_MODE_TAG_START);
  const end = customPrompt.indexOf(ASK_MODE_TAG_END);
  if (start === -1 || end === -1 || end < start) return customPrompt.trim();
  const before = customPrompt.slice(0, start);
  const after = customPrompt.slice(end + ASK_MODE_TAG_END.length);
  return (before + after).replace(/\n{3,}/g, '\n\n').trim();
}

function getAskModeState() {
  const settings = readWorkbuddySettings();
  const customPrompt = (settings && settings.personalization && typeof settings.personalization.customPrompt === 'string')
    ? settings.personalization.customPrompt
    : '';
  const enabled = customPrompt.includes(ASK_MODE_TAG_START) && customPrompt.includes(ASK_MODE_TAG_END);
  return {
    enabled,
    hasUserCustomPrompt: !!customPrompt.trim(),
    userCustomPromptPreview: customPrompt
      .replace(/<!-- wbs-ask-mode:start -->[\s\S]*?<!-- wbs-ask-mode:end -->/g, '[wbs 决策弹窗规则段]')
      .slice(0, 120),
  };
}

function setAskMode(enabled) {
  const settings = readWorkbuddySettings();
  if (!settings.personalization || typeof settings.personalization !== 'object') settings.personalization = {};
  const existing = typeof settings.personalization.customPrompt === 'string' ? settings.personalization.customPrompt : '';
  const stripped = stripAskRule(existing);
  if (enabled) {
    settings.personalization.customPrompt = [stripped, buildAskRuleBlock()].filter(Boolean).join('\n\n');
  } else {
    settings.personalization.customPrompt = stripped;
  }
  writeWorkbuddySettings(settings);
  return getAskModeState();
}

/** 启动时调用：如已启用决策弹窗，把旧的 ASK_MODE_RULE 替换为最新版本（用 ASK_MODE_TAG_START/END 精确识别） */
function refreshAskModeIfEnabled() {
  if (PROFILE.kind !== 'workbuddy') return;
  try {
    const state = getAskModeState();
    if (!state.enabled) return;
    setAskMode(true);
    log('[ask-mode] 启动时已刷新决策弹窗规则为最新版本');
  } catch (e) {
    log('[ask-mode] 刷新失败: ' + e.message);
  }
}

/* ================= 免打扰模块（No-Disturb）：基于 WorkBuddy 官方 sandbox 配置通道 ================= */
// 原理（逆向 app.asar 内 cli/dist/codebuddy.js）：
//  - CLI 的沙箱入口 shouldSandbox() 读 settings.json 的 sandbox 键：命中 excludedCommands 直接本地执行，
//    根本走不到 systemToolPolicy / 越界审批 → 「常用命令行免确认」「系统级工具放行」由它实现。
//  - extraAllowWrite 在 loadConfig 时并入 filesystem.allowWrite → 「沙箱外写文件免确认」由它实现。
//  - 批量删除保护（safeDelete bulk guard）：sandbox.safeDeleteBulkThreshold / dataSecurity.batchDeleteApprovalThreshold
//    阈值拉满 + 强制 safeDeleteRuntimeEnabled（删除进废纸篓）= 「大批量删除免确认」。
//  - 开关状态记录在 settings.wbs.noDisturb（WorkDaddy 自有命名空间，与 CLI 配置互不干扰）。
const WBS_SYSTEM_LEVEL_TOOLS = ['wsl', 'wsl.exe', 'wslconfig', 'wslconfig.exe', 'wmic', 'wmic.exe', 'sc', 'sc.exe', 'reg', 'reg.exe', 'schtasks', 'schtasks.exe'];
const WBS_COMMON_EXCLUDED_CMDS = ['npm', 'pnpm', 'yarn', 'npx', 'node', 'python3', 'python', 'git', 'curl', 'wget', 'brew'];
const WBS_EXTRA_ALLOW_WRITE = ['/tmp', '/var/tmp', '~/Downloads', '~/Desktop', '~/Documents', '~/Pictures', '~/Movies', '~/Music'];
const WBS_NO_DISTURB_NS = 'noDisturb';
const WBS_SWITCH_NAMES = ['outsideWrite', 'commands', 'bulkDelete', 'systemTools', 'autoApprove'];

function readNoDisturbState() {
  const settings = readWorkbuddySettings();
  const ns = settings.wbs && settings.wbs[WBS_NO_DISTURB_NS];
  const state = (ns && ns.state && typeof ns.state === 'object') ? ns.state : {};
  const switches = {};
  for (const name of WBS_SWITCH_NAMES) switches[name] = !!state[name];
  return switches;
}

function removeListItems(arr, items) {
  if (!Array.isArray(arr)) return arr;
  const drop = new Set(items);
  return arr.filter(function (x) { return !drop.has(x); });
}

function ensureSandboxObj(settings) {
  if (!settings.sandbox || typeof settings.sandbox !== 'object') settings.sandbox = {};
  return settings.sandbox;
}

/**
 * 把「开启/关闭」应用到 settings 的 sandbox 域。
 * ns.added 记录「本次由免打扰新增的数组项」→ 关闭时只回滚新增项，绝不删除用户原有配置。
 */
function applyNoDisturbSwitch(settings, ns, name, enabled) {
  const sb = ensureSandboxObj(settings);
  // 开启：合并清单 + 首次记录新增项（幂等开启不得覆盖已有记录）；
  // 关闭：仅回滚「本次新增」，绝不删除用户原有项。
  const recordAndMerge = function (key, items) {
    const cur = Array.isArray(sb[key]) ? sb[key] : [];
    const newAdded = items.filter(function (x) { return !cur.includes(x); });
    if (!Array.isArray(ns.added[name]) || !ns.added[name].length) ns.added[name] = newAdded;
    return Array.from(new Set(cur.concat(items)));
  };
  const rollback = function (key, items) {
    const cur = Array.isArray(sb[key]) ? sb[key] : [];
    const added = ns.added[name];
    // 有新增记录 → 只移除新增项；历史配置无记录时退化为整清单移除
    const drop = new Set(added && added.length ? added : items);
    return cur.filter(function (x) { return !drop.has(x); });
  };
  if (name === 'outsideWrite') {
    if (enabled) {
      sb.extraAllowWrite = recordAndMerge('extraAllowWrite', WBS_EXTRA_ALLOW_WRITE);
    } else {
      sb.extraAllowWrite = rollback('extraAllowWrite', WBS_EXTRA_ALLOW_WRITE);
      delete ns.added[name];
    }
  } else if (name === 'commands') {
    if (enabled) {
      sb.excludedCommands = recordAndMerge('excludedCommands', WBS_COMMON_EXCLUDED_CMDS);
    } else {
      sb.excludedCommands = rollback('excludedCommands', WBS_COMMON_EXCLUDED_CMDS);
      delete ns.added[name];
    }
  } else if (name === 'systemTools') {
    if (enabled) {
      sb.excludedCommands = recordAndMerge('excludedCommands', WBS_SYSTEM_LEVEL_TOOLS);
    } else {
      sb.excludedCommands = rollback('excludedCommands', WBS_SYSTEM_LEVEL_TOOLS);
      delete ns.added[name];
    }
  } else if (name === 'bulkDelete') {
    if (enabled) {
      // 批量阈值拉满（双写保证 CLI 或数据安全策略任一通道生效）
      sb.safeDeleteBulkThreshold = 99999;
      if (!sb.dataSecurity || typeof sb.dataSecurity !== 'object') sb.dataSecurity = {};
      sb.dataSecurity.batchDeleteApprovalThreshold = 99999;
      // 安全底线：删除必须先进废纸篓/回收站，强制开启删除保护
      sb.safeDeleteRuntimeEnabled = true;
      if (!sb.fileBackup || typeof sb.fileBackup !== 'object') sb.fileBackup = {};
      sb.fileBackup.enabled = true;
    } else {
      // 移除免打扰写入的字段，回到 CLI/UI 默认（safeDeleteRuntimeEnabled CLI 默认 true，删除保护保留）
      delete sb.safeDeleteBulkThreshold;
      if (sb.dataSecurity && typeof sb.dataSecurity === 'object') delete sb.dataSecurity.batchDeleteApprovalThreshold;
    }
  }
  // autoApprove 不写 CLI 配置，仅记录状态（前端据此启动兜底自动点允许）
}

/** 读-改-写（整文件原子替换），并维护 wbs.noDisturb.state */
function setNoDisturbSwitch(name, enabled) {
  if (WBS_SWITCH_NAMES.indexOf(name) === -1) throw new Error('未知开关: ' + name);
  const settings = readWorkbuddySettings();
  if (!settings.wbs || typeof settings.wbs !== 'object') settings.wbs = {};
  if (!settings.wbs[WBS_NO_DISTURB_NS] || typeof settings.wbs[WBS_NO_DISTURB_NS] !== 'object') settings.wbs[WBS_NO_DISTURB_NS] = {};
  const ns = settings.wbs[WBS_NO_DISTURB_NS];
  if (!ns.state || typeof ns.state !== 'object') ns.state = {};
  if (!ns.added || typeof ns.added !== 'object') ns.added = {};
  applyNoDisturbSwitch(settings, ns, name, enabled);
  ns.state[name] = !!enabled;
  writeWorkbuddySettings(settings);
  log('[no-disturb] 开关「' + name + '」已' + (enabled ? '开启' : '关闭'));
  return readNoDisturbState();
}

function noDisturbAudit(entry) {
  try {
    const file = path.join(PROFILE.dataRoot, 'audit-log', 'no-disturb.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry || {}));
    fs.appendFileSync(file, line + '\n', 'utf8');
    return true;
  } catch (e) {
    log('[no-disturb] 审计写入失败: ' + e.message);
    return false;
  }
}

/* ================ 持续会话模块（Auto-Continue）：会话异常自动续跑 ================ */
// 原理：将 WorkDaddy 专属英文指令块追加到 WorkBuddy 全局自定义指令（用户实测「设置-个性化-自定义指令」
// 的真实落点为 <profile>/app/app-config.json 的 personalization.customPrompt），要求 AI 在回复正文末尾
// 追加不可见零宽标记；前端（inject.js）监控会话：回复结束但正文块无标记 = 异常，自动发送「如果未完成，继续执行；已完成则回复"已完成"」。
// 本模块只负责配置读写与开关状态；监控与发送逻辑在 inject.js。WorkBuddy 基于 Electron，跨平台共用同一套逻辑。
const AC_NS = 'autoContinue';
const AC_TAG_START = '[WorkDaddy-Rule1 - activate]'; // 区块标识（v2 起改名，避免与其他项目/旧版块冲突）
const AC_TAG_END = '[end WorkDaddy-Rule1]';
// 兼容清理：新名 Rule1 与旧名 AutoContinue 的块都会被删除（旧版开关残留块升级时一并清除）
const AC_BLOCK_RE = /\[WorkDaddy-(?:AutoContinue|Rule1)[\s\S]*?\[end WorkDaddy-(?:AutoContinue|Rule1)\]/g;
const AC_INSTRUCTION = [
  'Always append one invisible zero-width marker (U+200B U+200B U+2060) at the very end of the main text body of every reply that you finish producing.',
  'The marker means the reply is complete, whether or not the underlying task is fully done.',
  'Append it whenever you finish writing a reply.',
  'Only omit it if your reply is interrupted or cut short before you finished.',
  'Write the actual invisible characters, never a visible placeholder such as text or escaped notation.',
  'Add nothing after the marker.',
  'Keep this active for all remaining replies in this conversation.',
].join(' ');

function acAppConfigPath() {
  return path.join(PROFILE.dataRoot, 'app', 'app-config.json');
}
function readAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(acAppConfigPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}
/** 原子写 app-config.json：目录自动创建、0644、临时文件 + rename，写后由调用方读回校验 */
function writeAppConfig(cfg) {
  const file = acAppConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceFileWithRetry(file, JSON.stringify(cfg, null, 2) + '\n', 0o644);
}
function acBlock() {
  return AC_TAG_START + '\n' + AC_INSTRUCTION + '\n' + AC_TAG_END;
}
/**
 * 从 customPrompt 中移除全部 WorkDaddy-* 指令块（Rule1 新名 + AutoContinue 旧名，含多块），保留用户其他内容。
 * 仅折叠块删除引起的连续空行、释放块带来的尾部多余换行；不 trim 用户正文首尾空白、不重排。
 */
function stripACBlocks(customPrompt) {
  if (typeof customPrompt !== 'string') return '';
  const stripped = customPrompt.replace(AC_BLOCK_RE, '');
  return stripped.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}
/** 开启=追加（幂等：先剥离再追加，最终只保留一个最新 v1 块）；关闭=剥离 */
function applyACBlock(customPrompt, enabled) {
  const stripped = stripACBlocks(typeof customPrompt === 'string' ? customPrompt : '');
  if (!enabled) return stripped;
  const base = stripped.replace(/\n+$/, '');
  return [base, acBlock()].filter(Boolean).join('\n\n');
}
function acCustomPromptPresent(customPrompt) {
  return typeof customPrompt === 'string' &&
    customPrompt.indexOf(AC_TAG_START) !== -1 &&
    customPrompt.indexOf(AC_TAG_END) !== -1;
}
function readAutoContinueState() {
  const settings = readWorkbuddySettings();
  const nsState = settings.wbs && settings.wbs[AC_NS] && settings.wbs[AC_NS].state;
  const enabled = !!(nsState && nsState.enabled);
  const cfg = readAppConfig();
  const customPrompt = cfg && cfg.personalization && typeof cfg.personalization.customPrompt === 'string'
    ? cfg.personalization.customPrompt
    : '';
  return {
    enabled,
    promptBlockPresent: acCustomPromptPresent(customPrompt),
    platformSupported: true,
  };
}
/** 开启：先写 app-config（指令块），再持久化开关状态；关闭：先删除指令块，再持久化关闭状态 */
function setAutoContinue(enabled) {
  const wantOn = !!enabled;
  const cfg = readAppConfig();
  if (!cfg.personalization || typeof cfg.personalization !== 'object') cfg.personalization = {};
  const existing = typeof cfg.personalization.customPrompt === 'string' ? cfg.personalization.customPrompt : '';
  cfg.personalization.customPrompt = applyACBlock(existing, wantOn);
  writeAppConfig(cfg);
  const settings = readWorkbuddySettings();
  if (!settings.wbs || typeof settings.wbs !== 'object') settings.wbs = {};
  if (!settings.wbs[AC_NS] || typeof settings.wbs[AC_NS] !== 'object') settings.wbs[AC_NS] = {};
  if (!settings.wbs[AC_NS].state || typeof settings.wbs[AC_NS].state !== 'object') settings.wbs[AC_NS].state = {};
  settings.wbs[AC_NS].state.enabled = wantOn;
  writeWorkbuddySettings(settings);
  log('[auto-continue] 会话异常中断已' + (wantOn ? '开启（指令块已写入 app-config.customPrompt）' : '关闭（指令块已移除）'));
  return readAutoContinueState();
}
/** 启动时调用：开关开启但指令块缺失/被外部改写 → 补写最新 v1 块；失败仅记录脱敏错误 */
function refreshAutoContinueIfEnabled() {
  try {
    const state = readAutoContinueState();
    if (!state.enabled) return;
    if (state.promptBlockPresent) return;
    setAutoContinue(true);
    log('[auto-continue] 启动时已补写自定义指令块（app-config.customPrompt）');
  } catch (e) {
    log('[auto-continue] 启动补写失败: ' + e.message);
  }
}
/** 通过 CDP 完成「聚焦 composer → 全选 → 真实输入「如果未完成，继续执行；已完成则回复"已完成"」→ 真实 Enter 发送」。
 *  Input.insertText / dispatchKeyEvent 均为 isTrusted 真实输入事件，Slate/React 必然响应，
 *  且内容非空时 Slate 自动隐藏占位符（解决 execCommand 模拟输入导致的占位符重叠/事件不生效）。 */
async function acDispatchEnter() {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const r = await cdpSend('Runtime.evaluate', {
    expression: `(()=>{const ce=document.querySelector('.chat-container [contenteditable="true"]')||document.querySelector('[contenteditable="true"]');if(!ce)return 'no-composer';ce.focus();var sel=window.getSelection();var r=document.createRange();r.selectNodeContents(ce);sel.removeAllRanges();sel.addRange(r);return 'ok'})()`,
    returnByValue: true,
  });
  // cdpSend() 返回 CDP msg.result，Runtime.evaluate 的值位于 r.result.value。
  // composer 不存在时后续输入事件全部空转，必须明确失败。
  const state = r && r.result && r.result.value;
  if (state !== 'ok') throw new Error('no-composer');
  await cdpSend('Input.insertText', { text: '如果未完成，继续执行；已完成则回复"已完成"' });
  await new Promise((r2) => setTimeout(r2, 260)); // 等待 React/Slate 状态同步（太短会导致 Enter 时内容未落定、首次发送无效）
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 通过 CDP 直接发送「当前输入框已有内容」：仅聚焦 + 真实 Enter（不写入任何文字） */
async function acSendCurrentInput() {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const r = await cdpSend('Runtime.evaluate', {
    expression: `(()=>{const ce=document.querySelector('.chat-container [contenteditable="true"]')||document.querySelector('[contenteditable="true"]');if(!ce)return 'no-composer';ce.focus();return 'ok'})()`,
    returnByValue: true,
  });
  if (!(r && r.result && r.result.value === 'ok')) throw new Error('no-composer');
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/* ================= 会话模块（session）：暂存提示词 & 快捷短语 ================= */
// 开关状态 + 短语列表持久化在 ~/.workbuddy/settings.json 的 wbs.session 域（与 noDisturb/autoContinue 同模式）。
// 默认值：暂存提示词开、快捷短语开（属性缺省即按开处理，保证旧用户全新功能默认可用）。
const SESS_NS = 'session';
const SESS_SWITCHES = ['stashEnabled', 'phraseEnabled'];
// 首次使用时播种的默认快捷短语（仅一次；用户删除后不再补——seeded 标志已置位，删除即永久生效）
const SESS_DEFAULT_PHRASES = ['继续执行'];
let sessionSeedPersistReported = false;

function sessBuild(st, phrases) {
  return {
    stashEnabled: st.stashEnabled !== false,
    phraseEnabled: st.phraseEnabled !== false,
    phrases: Array.isArray(phrases) ? phrases : [],
  };
}
function readSessionState() {
  const s = readWorkbuddySettings();
  const ns = (s.wbs && s.wbs[SESS_NS] && typeof s.wbs[SESS_NS] === 'object') ? s.wbs[SESS_NS] : {};
  const st = (ns.state && typeof ns.state === 'object') ? ns.state : {};
  const phrases = Array.isArray(ns.phrases) ? ns.phrases.slice() : [];
  // 稳定播种：仅当 wbs.session.seeded 缺省（首次使用/老数据升级）时执行一次。
  // 之后即使用户删掉默认短语也绝不回补（seeded 已持久化），保证行为可预期。
  if (!ns.seeded) {
    // 列表无默认短语则追加（无论列表是否为空，均只播种这一次；此后用户删除即永久生效）
    if (!phrases.some((p) => p && p.text === SESS_DEFAULT_PHRASES[0])) {
      phrases.push({ id: 'qp_seed_' + Date.now().toString(36), text: SESS_DEFAULT_PHRASES[0], createdAt: Date.now() });
    }
    if (!s.wbs || typeof s.wbs !== 'object') s.wbs = {};
    s.wbs[SESS_NS] = { state: st, phrases, seeded: true };
    try {
      writeWorkbuddySettings(s);
    } catch (error) {
      if (!sessionSeedPersistReported) {
        sessionSeedPersistReported = true;
        const reportError = new Error('首次会话播种持久化失败');
        captureException(reportError, {
          stage: 'session-seed-persist',
          extra: {
            platform: process.platform,
            settingsWrite: 'first-run-session-seed',
            errorName: String(error && error.name || 'Error').slice(0, 80),
            errorCode: String(error && error.code || 'unknown').slice(0, 80),
            syscall: String(error && error.syscall || 'unknown').slice(0, 80),
          },
        }).catch(() => {});
      }
    }
  }
  return sessBuild(st, phrases);
}
function writeSessionState(state) {
  const s = readWorkbuddySettings();
  const prior = (s.wbs && s.wbs[SESS_NS] && typeof s.wbs[SESS_NS] === 'object') ? s.wbs[SESS_NS] : {};
  if (!s.wbs || typeof s.wbs !== 'object') s.wbs = {};
  s.wbs[SESS_NS] = {
    state: { stashEnabled: !!state.stashEnabled, phraseEnabled: !!state.phraseEnabled },
    phrases: state.phrases || [],
    seeded: prior.seeded !== false, // 保留播种标志（删除默认短语后不回补）
  };
  writeWorkbuddySettings(s);
}
function setSessionSwitch(name, enabled) {
  if (SESS_SWITCHES.indexOf(name) === -1) throw new Error('未知开关: ' + name);
  const st = readSessionState();
  st[name] = !!enabled;
  writeSessionState(st);
  log('[session] 开关「' + name + '」已' + (enabled ? '开启' : '关闭'));
  return readSessionState();
}
function addQuickPhrase(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('短语不能为空');
    const st = readSessionState();
  st.phrases.push({
    id: 'qp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    text: t,
    createdAt: Date.now(),
  });
  writeSessionState(st);
  return readSessionState();
}
function updateQuickPhrase(id, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('短语不能为空');
    const st = readSessionState();
  const it = st.phrases.find((x) => x.id === id);
  if (!it) throw new Error('未找到该短语');
  it.text = t;
  writeSessionState(st);
  return readSessionState();
}
function deleteQuickPhrases(ids) {
  const list = Array.isArray(ids) ? ids.map(String) : [String(ids)];
  const st = readSessionState();
  st.phrases = st.phrases.filter((x) => list.indexOf(x.id) === -1);
  writeSessionState(st);
  return readSessionState();
}
function normalizeQuickPhraseIds(ids) {
  if (!Array.isArray(ids)) throw new Error('快捷短语选择必须是数组');
  if (ids.length > 1000) throw new Error('单次最多处理 1000 条快捷短语');
  const result = [];
  const seen = new Set();
  for (const value of ids) {
    const id = String(value || '').trim();
    if (!id) throw new Error('快捷短语标识不能为空');
    if (!seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}
function exportQuickPhrases(ids, password) {
  const selectedIds = normalizeQuickPhraseIds(ids);
  if (!selectedIds.length) throw new Error('未选择快捷短语');
  requiredPassword(password);
  const selected = new Set(selectedIds);
  const phrases = readSessionState().phrases
    .filter((item) => selected.has(String(item.id)))
    .map((item) => ({ text: String(item.text || ''), createdAt: Number(item.createdAt || Date.now()) }));
  if (!phrases.length) throw new Error('没有可导出的快捷短语');
  const payload = { exportType: 'WorkDaddy-quick-phrases', version: 1, phrases };
  return {
    filename: 'WorkDaddy-快捷短语导出-' + new Date().toISOString().slice(0, 10) + '.json',
    content: createEncryptedExport('quick-phrases', payload, password),
    count: phrases.length,
  };
}
function importQuickPhrases(content, password) {
  const payload = openEncryptedExport(content, 'quick-phrases', password);
  const incoming = Array.isArray(payload.phrases) ? payload.phrases : [];
  if (!incoming.length) throw new Error('导入文件中没有快捷短语');
  if (incoming.length > 1000) throw new Error('单次最多导入 1000 条快捷短语');
  const state = readSessionState();
  const existing = new Set(state.phrases.map((item) => String(item.text || '').trim()).filter(Boolean));
  let imported = 0;
  let skipped = 0;
  for (const item of incoming) {
    const text = String(item && item.text || '').trim();
    if (!text || existing.has(text)) { skipped++; continue; }
    existing.add(text);
    state.phrases.push({
      id: 'qp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      text,
      createdAt: Number(item && item.createdAt || Date.now()),
    });
    imported++;
  }
  if (!imported && !skipped) throw new Error('没有可导入的快捷短语');
  writeSessionState(state);
  return { state: readSessionState(), imported, skipped };
}
/** 通过 CDP 发送指定短语：聚焦 composer → 全选 → 真实输入短语 → 真实 Enter（replace 式发送，多行短语按段落插入） */
async function acSendPhrase(text) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const r = await cdpSend('Runtime.evaluate', {
    expression: `(()=>{const ce=document.querySelector('.chat-container [contenteditable="true"]')||document.querySelector('[contenteditable="true"]');if(!ce)return 'no-composer';ce.focus();var sel=window.getSelection();var r=document.createRange();r.selectNodeContents(ce);sel.removeAllRanges();sel.addRange(r);return 'ok'})()`,
    returnByValue: true,
  });
  if (!(r && r.result && r.result.value === 'ok')) throw new Error('no-composer');
  await cdpSend('Input.insertText', { text: String(text || '') });
  await new Promise((r) => setTimeout(r, 260)); // 等待 React/Slate 落定
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

function currentAccount() {
  if (!PROFILE.capabilities.accounts || !AUTH_FILE) return null;
  try {
    const c = readAuthFile();
    const a = (c.raw && c.raw.auth) || {};
    return {
      uid: c.uid,
      nickname: c.nickname,
      phone: c.phone,
      uin: c.uin,
      tokenExpiresAt: a.expiresAt || null,
      refreshExpiresAt: a.refreshExpiresAt || null,
      lastRefreshTime: a.lastRefreshTime || null,
    };
  } catch (_) {
    return null;
  }
}

/* ================= 暂存提示词（stash）辅助 ================= */

function stashDir() {
  return path.join(DATA_DIR, 'stash');
}

// 与 /api/stash 写入时相同的 key 生成规则：safe(uid) + '__' + safe(conversationId)
function safeKey(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

/** 扫描 stash 目录，返回全部暂存记录（按 savedAt 倒序）及 uid -> nickname 映射 */
function listStashRecords() {
  const dir = stashDir();
  const records = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || typeof j !== 'object' || !j.conversationId) continue;
        j._key = f.replace(/\.json$/, ''); // 文件名即 key
        records.push(j);
      } catch (_) {
        /* 损坏文件忽略 */
      }
    }
  } catch (_) {
    /* stash 目录不存在 */
  }
  records.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  const nick = {};
  try {
    for (const a of listAccounts(DATA_DIR)) nick[a.uid] = a.nickname || '';
  } catch (_) {}
  return { records, nick };
}

// key 文件名校验：替换非法字符但不截断（key 本身由 safe() 逐段限制长度，可能超过 80 字符）
function stashFilePath(key) {
  const fname = String(key || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!fname || fname.length > 220) throw new Error('非法 key: ' + String(key).slice(0, 40));
  return path.join(stashDir(), fname + '.json');
}

function stashRecordByKey(key) {
  const file = stashFilePath(key);
  if (!fs.existsSync(file)) throw new Error('暂存记录不存在: ' + key);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 通过 CDP 抓取侧边栏会话列表，返回 conversationId -> 会话名 映射（用于筛选下拉展示会话名而非 id） */
async function fetchConvNames() {
  if (!cdp.connected) return {};
  const expr = `(function(){
    try {
      var map = {};
      var els = document.querySelectorAll('.conversation-item[data-conversation-id],[data-conversation-id]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var id = el.getAttribute('data-conversation-id');
        if (!id || map[id]) continue;
        var txt = (el.innerText || el.textContent || '') || '';
        // 第一行是会话标题，后续行是时间等（如 "11小时前"）
        var line = (txt.split('\\n')[0] || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!line) continue;
        map[id] = line;
      }
      return map;
    } catch (e) { return {}; }
  })()`;
  try {
    const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
    return (r.result && r.result.value) || {};
  } catch (_) {
    return {};
  }
}

/** 删除单条暂存记录（删文件 + 同步 stash-index.json） */
function deleteStashRecord(key) {
  const file = stashFilePath(key);
  let deleted = false;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deleted = true;
  }
  const idxFile = path.join(DATA_DIR, 'stash-index.json');
  try {
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || [];
    const next = idx.filter((r) => r.key !== key);
    if (next.length !== idx.length) fs.writeFileSync(idxFile, JSON.stringify(next, null, 2));
  } catch (_) {
    /* index 不存在则忽略 */
  }
  return deleted;
}

/**
 * 检测 WorkBuddy 当前是否在回复中（AI 生成消息）。
 * 回复中输入框状态异常，回填图片/文字容易失败，且此时发送会进入 WorkBuddy 的消息队列等回复完成后自动发送——
 * 因此发送暂存提示词前必须先等 AI 空闲。
 */
function buildBusyExpr() {
  return `(function(){
    try {
      var sels = [
        '.assistant-message[class*="loading"]',
        '[class*="_loadingMessage_"]',
        '[class*="_loadingText_"]',
        '[class*="typing"]',
        '[class*="generating"]',
        '[title*="停止"],[aria-label*="停止"]'
      ];
      for (var i = 0; i < sels.length; i++) {
        var els = document.querySelectorAll(sels[i]);
        for (var j = 0; j < els.length; j++) {
          var r = els[j].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    } catch (e) { return false; }
  })()`;
}

/** 等待 AI 空闲；超时返回 false */
async function waitAiIdle(maxMs = 60000, pollMs = 500) {
  if (!cdp.connected) return true; // CDP 未连接时不等待（后续会报错）
  const expr = buildBusyExpr();
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
      const busy = (r.result && r.result.value) === true;
      if (!busy) return true;
    } catch (_) {
      return true; // evaluate 异常按空闲处理
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return false;
}

/* ================= 主题系统（WorkBuddy 换肤，VSCode theme 同构） =================
 * 原理：WorkBuddy 界面全部通过 CSS 变量（--wb-* / --wb-color-* / --dc-*）取色，
 * 主题 = 一组「变量 → 颜色」覆盖，注入为 :root 上的 <style> 即可全局换肤。
 * 每个主题一个 JSON 文件，字段：{ id, name, author, dark, colors: { '--wb-bg-primary': '#0d0d0f', ... } }
 */

const THEMES_DIR = path.join(DATA_DIR, 'themes');
// 官方背景图库：面板「主题」页的默认壁纸（wallpaper-01.webp ~ wallpaper-NN.webp）
const WALLPAPERS_DIR = path.join(THEMES_DIR, 'wallpapers');

/** 内置资产源目录（首次启动初始化的来源，WorkDaddy.app 自包含打包）：
 * 1) 脚本同目录 builtin/（app 内置模式：Contents/Resources/scripts/builtin）
 * 2) 项目模式：<项目>/WorkDaddy.app/Contents/Resources/scripts/builtin
 */
function builtinAssetsDir() {
  const cands = [
    path.join(__dirname, 'builtin'),
    path.join(__dirname, '..', 'WorkDaddy.app', 'Contents', 'Resources', 'scripts', 'builtin'),
  ];
  if (process.env.WBSWITCH_DIR) {
    cands.push(path.join(process.env.WBSWITCH_DIR, 'WorkDaddy.app', 'Contents', 'Resources', 'scripts', 'builtin'));
  }
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'nebula', 'theme.json')) && fs.existsSync(path.join(c, 'wallpapers'))) return c;
    } catch (_) {}
  }
  return null;
}

function builtinWallpaperSource(baseDir, fileName) {
  const override = path.join(__dirname, 'builtin-overrides', fileName);
  return fs.existsSync(override) ? override : path.join(baseDir, 'wallpapers', fileName);
}

/** 内置资产同步：官方壁纸 + WorkDaddy 主题 + 默认蒙版 10%
 * 幂等：官方 wallpaper-*.webp 由应用管理，内置内容变化时刷新；custom-* 与用户主题不覆盖。
 * nebula 主题和背景仅在缺失时安装，避免覆盖用户后来选择的主题配色或背景。
 */
function initBuiltinAssets() {
  if (!PROFILE.capabilities.theme) return;
  try {
    const src = builtinAssetsDir();
    if (!src) {
      log('[init] 未找到内置资产目录（builtin/），跳过初始化');
      return;
    }
    // 1) 内置官方壁纸 → themes/wallpapers/（缺失时补齐、应用升级内容变化时刷新）
    const wpSrc = path.join(src, 'wallpapers');
    if (fs.existsSync(wpSrc)) {
      const files = fs.readdirSync(wpSrc).filter((f) => /\.webp$/i.test(f)).sort();
      if (files.length) {
        fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
        let added = 0;
        let updated = 0;
        for (const f of files) {
          const source = builtinWallpaperSource(src, f);
          const dest = path.join(WALLPAPERS_DIR, f);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(source, dest);
            added++;
          } else if (Buffer.compare(fs.readFileSync(source), fs.readFileSync(dest)) !== 0) {
            fs.copyFileSync(source, dest);
            updated++;
          }
        }
        if (added || updated) log(`[init] 同步内置壁纸：新增 ${added} 张，更新 ${updated} 张 -> ${WALLPAPERS_DIR}`);
      }
    }
    // 2) WorkDaddy 主题（nebula）→ themes/nebula/（缺失才安装，已有不动）
    const thSrc = path.join(src, 'nebula');
    const thDst = path.join(THEMES_DIR, 'nebula');
    if (fs.existsSync(path.join(thSrc, 'theme.json'))) {
      const themeJson = path.join(thDst, 'theme.json');
      if (!fs.existsSync(themeJson)) {
        fs.mkdirSync(thDst, { recursive: true });
        fs.copyFileSync(path.join(thSrc, 'theme.json'), themeJson);
        log('[init] 已安装 WorkDaddy 主题（nebula）');
      }
      const bgSrc = builtinWallpaperSource(src, 'wallpaper-06.webp');
      const bgDst = path.join(thDst, 'background.webp');
      if (fs.existsSync(bgSrc) && !fs.existsSync(bgDst)) {
        fs.copyFileSync(bgSrc, bgDst);
        log('[init] 已补齐 nebula 主题背景图');
      }
    }
    // 3) 默认蒙版 10%（仅当 mask.json 不存在，不覆盖用户设置）
    const maskFile = path.join(DATA_DIR, 'mask.json');
    if (!fs.existsSync(maskFile)) {
      fs.writeFileSync(maskFile, JSON.stringify({ opacity: 0.1 }, null, 2));
      log('[init] 首次初始化：背景蒙版默认 10% -> mask.json');
    }
    // 4) 默认主题 → WorkDaddy 壁纸主题（仅当 profile 从未设置过主题）
    const curFile = path.join(DATA_DIR, 'current-theme.json');
    if (!fs.existsSync(curFile)) {
      fs.writeFileSync(curFile, JSON.stringify({ id: 'nebula', at: new Date().toISOString() }, null, 2));
      log('[init] 首次初始化：默认主题 -> WorkDaddy 壁纸主题（nebula）');
    }
  } catch (e) {
    log('[init] 首次初始化失败: ' + e.message);
  }
}

/** 内置主题（默认 + 3 套示例） */
const BUILTIN_THEMES = {
  default: { id: 'default', name: '默认（浅色）', author: 'WorkBuddy', dark: false, colors: {} },
  'oled-dark': {
    id: 'oled-dark', name: 'OLED 纯黑', author: 'wbs', dark: true,
    colors: {
      // ---- vscode 主题变量（body 层，整体布局：编辑器/侧边栏/活动栏/tab/输入框/菜单/按钮/列表等）----
      '--vscode-editor-background': '#0a0a0c', '--vscode-editor-foreground': '#e6e6e9',
      '--vscode-sideBar-background': '#0d0d10', '--vscode-sideBar-foreground': '#c8c8cc', '--vscode-sideBar-border': '#1c1c22',
      '--vscode-activityBar-background': '#0d0d10', '--vscode-activityBar-foreground': '#e6e6e9',
      '--vscode-activityBar-inactiveForeground': 'rgba(230,230,233,0.45)',
      '--vscode-activityBarBadge-background': '#e6e6e9', '--vscode-activityBarBadge-foreground': '#0a0a0c',
      '--vscode-titleBar-activeBackground': '#0a0a0c', '--vscode-titleBar-activeForeground': '#e6e6e9',
      '--vscode-tab-activeBackground': '#0a0a0c', '--vscode-tab-activeForeground': '#e6e6e9',
      '--vscode-tab-inactiveBackground': '#101014', '--vscode-tab-inactiveForeground': 'rgba(230,230,233,0.5)',
      '--vscode-tab-border': '#1c1c22',
      '--vscode-input-background': '#131316', '--vscode-input-foreground': '#e6e6e9',
      '--vscode-input-border': '#2a2a30', '--vscode-input-placeholderForeground': 'rgba(230,230,233,0.4)',
      '--vscode-button-background': 'rgba(255,255,255,0.92)', '--vscode-button-foreground': '#0a0a0c',
      '--vscode-button-hoverBackground': 'rgba(255,255,255,0.8)',
      '--vscode-list-activeSelectionBackground': 'rgba(255,255,255,0.1)', '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-list-hoverBackground': 'rgba(255,255,255,0.06)', '--vscode-list-inactiveSelectionBackground': 'rgba(255,255,255,0.08)',
      '--vscode-menu-background': '#131316', '--vscode-menu-foreground': '#e6e6e9',
      '--vscode-dropdown-background': '#131316', '--vscode-dropdown-foreground': '#e6e6e9', '--vscode-dropdown-border': '#2a2a30',
      '--vscode-panel-background': '#0a0a0c', '--vscode-panel-border': '#1c1c22',
      '--vscode-badge-background': 'rgba(255,255,255,0.16)', '--vscode-badge-foreground': '#e6e6e9',
      '--vscode-foreground': '#e6e6e9', '--vscode-descriptionForeground': 'rgba(230,230,233,0.7)',
      '--vscode-focusBorder': 'rgba(255,255,255,0.4)',
      '--vscode-scrollbarSlider-background': 'rgba(255,255,255,0.2)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(255,255,255,0.3)',
      '--vscode-editorGroupHeader-tabsBackground': '#0d0d10', '--vscode-editorGroupHeader-tabsBorder': '#1c1c22',
      '--vscode-editorGroup-border': '#1c1c22', '--vscode-statusBar-background': '#0d0d10', '--vscode-statusBar-foreground': '#e6e6e9',
      '--vscode-checkbox-background': '#131316', '--vscode-checkbox-border': '#2a2a30', '--vscode-checkbox-foreground': '#e6e6e9',
      '--vscode-editorWidget-background': '#131316', '--vscode-editorWidget-border': '#2a2a30',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#0a0a0c', '--wb-bg-secondary': '#131316', '--wb-bg-tertiary': '#1b1b20',
      '--wb-bg-popover': '#131316', '--wb-bg-hover': 'color-mix(in srgb,#ffffff 7%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#ffffff 10%,transparent)', '--wb-bg-overlay': 'rgba(0,0,0,0.7)',
      '--wb-text-strong': '#e6e6e9', '--wb-text-medium': 'rgba(230,230,233,0.72)',
      '--wb-text-muted': 'rgba(230,230,233,0.42)', '--wb-text-weak': 'rgba(230,230,233,0.55)',
      '--wb-color-text-primary': '#e6e6e9', '--wb-color-text-secondary': 'rgba(230,230,233,0.72)',
      '--wb-color-text-tertiary': 'rgba(230,230,233,0.55)', '--wb-color-text-disabled': 'rgba(230,230,233,0.42)',
      '--wb-border-default': 'color-mix(in srgb,#ffffff 13%,transparent)', '--wb-border-subtle': '#202025',
      '--wb-border-strong': '#2c2c33', '--wb-border-hover': 'color-mix(in srgb,#ffffff 22%,transparent)',
      '--wb-button-primary-bg': 'rgba(255,255,255,0.92)', '--wb-button-primary-fg': '#0a0a0c',
      '--wb-button-primary-bg-hover': 'rgba(255,255,255,0.8)',
      '--wb-status-success': '#2ee59d', '--wb-status-warning': '#ffb03a',
      '--wb-status-error': '#ff6b6b', '--wb-status-info': '#3fd6c0',
      '--wb-card-bg': '#131316', '--wb-kb-tabs-container-bg': '#101013', '--wb-kb-tabs-container-border': '#1e1e24',
      '--wb-kb-card-bg': '#131316', '--wb-kb-card-bg-soft': '#16161b', '--wb-kb-card-border': '#232329',
      '--dc-bg-primary': '#0a0a0c', '--dc-bg-secondary': '#131316', '--dc-bg-tertiary': '#1b1b20',
      '--dc-bg-hover': '#1d1d22', '--dc-text-primary': 'rgba(255,255,255,0.88)',
      '--dc-text-secondary': 'rgba(255,255,255,0.62)', '--dc-text-tertiary': 'rgba(255,255,255,0.42)',
      '--dc-border': 'rgba(255,255,255,0.12)', '--dc-border-light': 'rgba(255,255,255,0.07)',
      '--dc-card-bg': '#131316', '--dc-primary': '#ffffff', '--dc-primary-hover': '#e0e0e0',
      '--dc-primary-active': '#ffffff', '--dc-btn-text': '#0a0a0c',
    },
  },
  'eye-care': {
    id: 'eye-care', name: '护眼绿', author: 'wbs', dark: false,
    colors: {
      // ---- vscode 主题变量（body 层）----
      '--vscode-editor-background': '#f0f5ec', '--vscode-editor-foreground': '#2b3a26',
      '--vscode-sideBar-background': '#e7efe0', '--vscode-sideBar-foreground': '#3b4a36', '--vscode-sideBar-border': '#d9e3cf',
      '--vscode-activityBar-background': '#e7efe0', '--vscode-activityBar-foreground': '#2b3a26',
      '--vscode-activityBar-inactiveForeground': 'rgba(43,58,38,0.5)',
      '--vscode-activityBarBadge-background': '#3b6d11', '--vscode-activityBarBadge-foreground': '#ffffff',
      '--vscode-titleBar-activeBackground': '#f0f5ec', '--vscode-titleBar-activeForeground': '#2b3a26',
      '--vscode-tab-activeBackground': '#f0f5ec', '--vscode-tab-activeForeground': '#2b3a26',
      '--vscode-tab-inactiveBackground': '#e7efe0', '--vscode-tab-inactiveForeground': 'rgba(43,58,38,0.5)',
      '--vscode-tab-border': '#d9e3cf',
      '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#2b3a26',
      '--vscode-input-border': '#c3d2b5', '--vscode-input-placeholderForeground': 'rgba(43,58,38,0.45)',
      '--vscode-button-background': '#3b6d11', '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#4a8517',
      '--vscode-list-activeSelectionBackground': 'rgba(59,109,17,0.12)', '--vscode-list-activeSelectionForeground': '#2b3a26',
      '--vscode-list-hoverBackground': 'rgba(59,109,17,0.07)', '--vscode-list-inactiveSelectionBackground': 'rgba(59,109,17,0.08)',
      '--vscode-menu-background': '#ffffff', '--vscode-menu-foreground': '#2b3a26',
      '--vscode-dropdown-background': '#ffffff', '--vscode-dropdown-foreground': '#2b3a26', '--vscode-dropdown-border': '#c3d2b5',
      '--vscode-panel-background': '#f0f5ec', '--vscode-panel-border': '#d9e3cf',
      '--vscode-badge-background': '#3b6d11', '--vscode-badge-foreground': '#ffffff',
      '--vscode-foreground': '#2b3a26', '--vscode-descriptionForeground': 'rgba(43,58,38,0.7)',
      '--vscode-focusBorder': 'rgba(59,109,17,0.5)',
      '--vscode-scrollbarSlider-background': 'rgba(43,58,38,0.2)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(43,58,38,0.3)',
      '--vscode-editorGroupHeader-tabsBackground': '#e7efe0', '--vscode-editorGroupHeader-tabsBorder': '#d9e3cf',
      '--vscode-editorGroup-border': '#d9e3cf', '--vscode-statusBar-background': '#e7efe0', '--vscode-statusBar-foreground': '#2b3a26',
      '--vscode-checkbox-background': '#ffffff', '--vscode-checkbox-border': '#c3d2b5', '--vscode-checkbox-foreground': '#2b3a26',
      '--vscode-editorWidget-background': '#ffffff', '--vscode-editorWidget-border': '#c3d2b5',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#f0f5ec', '--wb-bg-secondary': '#e7efe0', '--wb-bg-tertiary': '#dce7d3',
      '--wb-bg-popover': '#f5f9f1', '--wb-bg-hover': 'color-mix(in srgb,#3b6d11 6%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#3b6d11 10%,transparent)',
      '--wb-text-strong': '#2b3a26', '--wb-text-medium': 'rgba(43,58,38,0.72)',
      '--wb-text-muted': 'rgba(43,58,38,0.42)', '--wb-text-weak': 'rgba(43,58,38,0.55)',
      '--wb-color-text-primary': '#2b3a26', '--wb-color-text-secondary': 'rgba(43,58,38,0.72)',
      '--wb-color-text-tertiary': 'rgba(43,58,38,0.55)', '--wb-color-text-disabled': 'rgba(43,58,38,0.42)',
      '--wb-border-default': 'color-mix(in srgb,#3b6d11 14%,transparent)', '--wb-border-subtle': '#d9e3cf',
      '--wb-border-strong': '#c3d2b5', '--wb-border-hover': 'color-mix(in srgb,#3b6d11 24%,transparent)',
      '--wb-button-primary-bg': '#3b6d11', '--wb-button-primary-fg': '#ffffff',
      '--wb-button-primary-bg-hover': '#4a8517',
      '--wb-status-success': '#3b8c2e', '--wb-status-warning': '#b8860b',
      '--wb-status-error': '#c0392b', '--wb-status-info': '#2e8b8b',
      '--wb-card-bg': '#f5f9f1', '--wb-kb-tabs-container-bg': '#e3ebda', '--wb-kb-tabs-container-border': '#d2dec6',
      '--dc-bg-primary': '#f0f5ec', '--dc-bg-secondary': '#e7efe0', '--dc-bg-tertiary': '#dce7d3',
      '--dc-bg-hover': '#dfe9d5', '--dc-text-primary': 'rgba(43,58,38,0.88)',
      '--dc-text-secondary': 'rgba(43,58,38,0.62)', '--dc-border': 'rgba(59,109,17,0.15)',
      '--dc-border-light': 'rgba(59,109,17,0.09)', '--dc-card-bg': '#f5f9f1',
      '--dc-primary': '#3b6d11', '--dc-primary-hover': '#4a8517', '--dc-btn-text': '#ffffff',
    },
  },
  'cyber-purple': {
    id: 'cyber-purple', name: '赛博紫', author: 'wbs', dark: true,
    colors: {
      // ---- vscode 主题变量（body 层）----
      '--vscode-editor-background': '#12101e', '--vscode-editor-foreground': '#e8e5ff',
      '--vscode-sideBar-background': '#151227', '--vscode-sideBar-foreground': '#c8c2ea', '--vscode-sideBar-border': '#2a2450',
      '--vscode-activityBar-background': '#151227', '--vscode-activityBar-foreground': '#e8e5ff',
      '--vscode-activityBar-inactiveForeground': 'rgba(232,229,255,0.45)',
      '--vscode-activityBarBadge-background': '#7f77dd', '--vscode-activityBarBadge-foreground': '#ffffff',
      '--vscode-titleBar-activeBackground': '#12101e', '--vscode-titleBar-activeForeground': '#e8e5ff',
      '--vscode-tab-activeBackground': '#12101e', '--vscode-tab-activeForeground': '#e8e5ff',
      '--vscode-tab-inactiveBackground': '#1a1729', '--vscode-tab-inactiveForeground': 'rgba(232,229,255,0.5)',
      '--vscode-tab-border': '#2a2450',
      '--vscode-input-background': '#1a1729', '--vscode-input-foreground': '#e8e5ff',
      '--vscode-input-border': '#3a3160', '--vscode-input-placeholderForeground': 'rgba(232,229,255,0.4)',
      '--vscode-button-background': '#7f77dd', '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#938ce6',
      '--vscode-list-activeSelectionBackground': 'rgba(127,119,221,0.28)', '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-list-hoverBackground': 'rgba(127,119,221,0.14)', '--vscode-list-inactiveSelectionBackground': 'rgba(127,119,221,0.18)',
      '--vscode-menu-background': '#1a1729', '--vscode-menu-foreground': '#e8e5ff',
      '--vscode-dropdown-background': '#1a1729', '--vscode-dropdown-foreground': '#e8e5ff', '--vscode-dropdown-border': '#3a3160',
      '--vscode-panel-background': '#12101e', '--vscode-panel-border': '#2a2450',
      '--vscode-badge-background': '#7f77dd', '--vscode-badge-foreground': '#ffffff',
      '--vscode-foreground': '#e8e5ff', '--vscode-descriptionForeground': 'rgba(232,229,255,0.7)',
      '--vscode-focusBorder': 'rgba(159,148,235,0.5)',
      '--vscode-scrollbarSlider-background': 'rgba(159,148,235,0.25)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(159,148,235,0.4)',
      '--vscode-editorGroupHeader-tabsBackground': '#151227', '--vscode-editorGroupHeader-tabsBorder': '#2a2450',
      '--vscode-editorGroup-border': '#2a2450', '--vscode-statusBar-background': '#151227', '--vscode-statusBar-foreground': '#e8e5ff',
      '--vscode-checkbox-background': '#1a1729', '--vscode-checkbox-border': '#3a3160', '--vscode-checkbox-foreground': '#e8e5ff',
      '--vscode-editorWidget-background': '#1a1729', '--vscode-editorWidget-border': '#3a3160',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#12101e', '--wb-bg-secondary': '#1a1729', '--wb-bg-tertiary': '#221d35',
      '--wb-bg-popover': '#1a1729', '--wb-bg-hover': 'color-mix(in srgb,#7f77dd 10%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#7f77dd 16%,transparent)',
      '--wb-text-strong': '#e8e5ff', '--wb-text-medium': 'rgba(232,229,255,0.75)',
      '--wb-text-muted': 'rgba(232,229,255,0.45)', '--wb-text-weak': 'rgba(232,229,255,0.58)',
      '--wb-color-text-primary': '#e8e5ff', '--wb-color-text-secondary': 'rgba(232,229,255,0.75)',
      '--wb-color-text-tertiary': 'rgba(232,229,255,0.58)', '--wb-color-text-disabled': 'rgba(232,229,255,0.45)',
      '--wb-border-default': 'color-mix(in srgb,#7f77dd 20%,transparent)', '--wb-border-subtle': '#262140',
      '--wb-border-strong': '#3a3160', '--wb-border-hover': 'color-mix(in srgb,#a99ff0 30%,transparent)',
      '--wb-button-primary-bg': '#7f77dd', '--wb-button-primary-fg': '#ffffff',
      '--wb-button-primary-bg-hover': '#938ce6',
      '--wb-status-success': '#5ddfb0', '--wb-status-warning': '#f2b94d',
      '--wb-status-error': '#f27e9b', '--wb-status-info': '#7fd0e8',
      '--wb-card-bg': '#1a1729', '--wb-kb-tabs-container-bg': '#151227', '--wb-kb-tabs-container-border': '#2a2450',
      '--dc-bg-primary': '#12101e', '--dc-bg-secondary': '#1a1729', '--dc-bg-tertiary': '#221d35',
      '--dc-bg-hover': '#241f3c', '--dc-text-primary': 'rgba(255,255,255,0.88)',
      '--dc-text-secondary': 'rgba(255,255,255,0.62)', '--dc-text-tertiary': 'rgba(255,255,255,0.42)',
      '--dc-border': 'rgba(127,119,221,0.28)', '--dc-border-light': 'rgba(127,119,221,0.16)',
      '--dc-card-bg': '#1a1729', '--dc-primary': '#7f77dd', '--dc-primary-hover': '#938ce6',
      '--dc-btn-text': '#ffffff',
    },
  },
};

/** 主题列表（内置 + 用户自定义；自定义文件与内置同名时以文件为准，不重复列出） */
function listThemes() {
  const themes = Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name, author: t.author, dark: t.dark, builtin: true }));
  try {
    if (fs.existsSync(THEMES_DIR)) {
      for (const f of fs.readdirSync(THEMES_DIR)) {
        // 兼容两种布局：themes/<id>.json（扁平）与 themes/<id>/theme.json（目录）
        let t = null;
        const flatPath = path.join(THEMES_DIR, f);
        if (f.endsWith('.json')) {
          try { t = JSON.parse(fs.readFileSync(flatPath, 'utf8')); } catch (_) { continue; }
        } else {
          const subPath = path.join(flatPath, 'theme.json');
          if (!fs.statSync(flatPath).isDirectory() || !fs.existsSync(subPath)) continue;
          try { t = JSON.parse(fs.readFileSync(subPath, 'utf8')); } catch (_) { continue; }
        }
        if (!t || !t.id || !t.colors) continue;
        const existing = themes.findIndex((x) => x.id === t.id);
        const item = { id: t.id, name: t.name || t.id, author: t.author || 'unknown', dark: !!t.dark, builtin: false };
        if (existing >= 0) themes[existing] = item; // 覆盖内置
        else themes.push(item);
      }
    }
  } catch (_) {}
  return themes;
}

/** 取主题完整定义（含 colors）。优先读 themes/ 目录的自定义文件（可覆盖内置同名主题），否则回退内置 */
function getTheme(id) {
  // 先查文件（用户自定义或覆盖内置的完整版）——支持 themes/<id>.json 与 themes/<id>/theme.json 两种布局
  try {
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
    let t = null;
    const flat = path.join(THEMES_DIR, safeId + '.json');
    if (fs.existsSync(flat)) {
      t = JSON.parse(fs.readFileSync(flat, 'utf8'));
    } else {
      const sub = path.join(THEMES_DIR, safeId, 'theme.json');
      if (fs.existsSync(sub)) t = JSON.parse(fs.readFileSync(sub, 'utf8'));
    }
    if (t && t.colors) return t;
  } catch (_) {}
  if (BUILTIN_THEMES[id]) return BUILTIN_THEMES[id];
  return null;
}

/** 恢复已保存的主题（CDP 连接/页面刷新后调用）：读取 current-theme.json 重新应用，保证深浅色在重启/刷新后仍生效 */
async function restoreSavedTheme() {
  if (!PROFILE.capabilities.theme) return;
  if (!cdp.connected) return;
  let id = 'default';
  try {
    const f = path.join(DATA_DIR, 'current-theme.json');
    if (fs.existsSync(f)) id = String(JSON.parse(fs.readFileSync(f, 'utf8')).id || 'default');
  } catch (_) {}
  if (id === 'default') return; // 默认主题 = 官方浅色，无需处理
  await applyThemeByCdp(id);
}

/** 应用主题：通过 CDP 注入主题样式。
 * 原理（逆向 WorkBuddy 主题机制后确认）：
 * 1) 设计 token（--wb-*、--dc-*、--vscode-*）定义在 `:root, body[data-vscode-theme-name="IDE Light"]`
 *    联合选择器上，且部分组件（.teams-container 等）有**局部硬编码覆盖**（优先级更高）——
 *    只改 :root / body 无效，必须对这些局部容器追加同层覆盖。
 * 2) WorkBuddy 自带深色模式：`html[data-theme="dark"]`/`html.cb-dark`/`body[data-vscode-theme-name="IDE Night"]`
 *    分支下这些变量（含局部硬编码）都有官方深色值。
 * 因此正确做法：深色主题先切到官方深色模式（局部变量全部变深），再注入自定义色板
 * （body[data-vscode-theme-name] 同优先级后插入胜出 + 局部容器追加覆盖）；浅色主题只注入自定义色板。
 */
// 已知有局部变量硬编码覆盖的容器（选择器 -> 主题 colors 里对应的变量名）
const LOCAL_THEME_OVERRIDES = [
  { sel: '.teams-container.is-mac', vars: ['--wb-home-bg-primary', '--wb-home-bg-secondary'] },
  { sel: '.project-detail-view__chat-input', vars: ['--wb-bg-primary'] },
  { sel: '.project-detail-view__chat-input--task', vars: ['--wb-bg-primary', '--wb-color-border-secondary'] },
  { sel: '[class*="mainArea"]', vars: ['--wb-bg-hover'] },
  { sel: '.workbuddy-collab', vars: ['--wb-border-info', '--wb-bg-info', '--wb-bg-action'] },
];

/** 生成 markdown 表格 + 输入框渐变的主题跟随样式（追加到主题 CSS 末尾）。
 * - markdown 表格：WorkBuddy 用 --cb-markdown-table-* 变量，但浅色分支（.light 类）会继承白底值，
 *   需在 .cb-markdown 元素上直接定义（直接定义 > 继承），颜色引用主题变量实现跟随。
 * - 输入框上方渐变：.input-area-container::before 用 var(--cb-colleagues-dashboard-bg, #FAFAFA)，
 *   浅色下变量未定义回退白色，深色下需定义为主题背景色。
 */
// ===== 样式补丁热插拔 =====
// 所有针对 WorkBuddy 界面的样式补丁集中在 scripts/theme-patches.js（独立模块，按 {id, desc, css} 组织）。
// 热加载：修改 theme-patches.js 后重新 POST /api/theme-apply 即生效，无需重启 daemon。
// WorkBuddy 升级导致样式失效时：面板 🔍/DevTools 定位失效组件 → 改 theme-patches.js 对应补丁 → 重应用。
let _patchesCache = null;
let _patchesMtime = 0;
function loadThemePatches() {
  try {
    const f = path.join(__dirname, 'theme-patches.js');
    const st = fs.statSync(f);
    if (!_patchesCache || st.mtimeMs !== _patchesMtime) {
      delete require.cache[require.resolve(f)];
      _patchesCache = require(f);
      _patchesMtime = st.mtimeMs;
    }
    return _patchesCache || [];
  } catch (e) {
    log('[theme] 样式补丁加载失败: ' + e.message);
    return [];
  }
}
/** 主题附加样式：从 theme-patches.js 热加载，不硬编码在此 */
function themeExtrasCss() {
  return loadThemePatches().map((p) => (p && p.css ? p.css : '')).join('');
}

/** 主题变量别名层：从 theme-vars.js 热加载（官方漏定义/深色值不对的 token 重定向到主题变量）。
 * body 级定义生成 `html[data-theme="dark"] body[data-vscode-theme-name]{...}`（darkOnly=true 时前缀深色条件），
 * 组件作用域定义生成 `html[data-theme="dark"] body[data-vscode-theme-name] <sel>{...}`。
 * 属「常量可搞定」的样式处理，不占 theme-patches.js（那里只保留必须针对元素写规则的魔改补丁）。
 */
let _varsCache = null;
let _varsMtime = 0;
function loadThemeVars() {
  try {
    const f = path.join(__dirname, 'theme-vars.js');
    const st = fs.statSync(f);
    if (!_varsCache || st.mtimeMs !== _varsMtime) {
      delete require.cache[require.resolve(f)];
      _varsCache = require(f);
      _varsMtime = st.mtimeMs;
    }
    return _varsCache || { body: [], scoped: [] };
  } catch (e) {
    log('[theme] 变量别名层加载失败: ' + e.message);
    return { body: [], scoped: [] };
  }
}
/** 生成变量别名 CSS：isDark 时 darkOnly 条目加 html[data-theme="dark"] 前缀；浅色主题跳过 darkOnly 条目 */
function themeVarsCss(isDark) {
  const mod = loadThemeVars();
  const pre = isDark ? 'html[data-theme="dark"] ' : '';
  let out = '';
  const declOf = (vars) => Object.keys(vars || {}).map((k) => k + ':' + vars[k] + ';').join('');
  for (const b of mod.body || []) {
    if (b.darkOnly && !isDark) continue;
    const lead = b.darkOnly ? pre : '';
    const d = declOf(b.vars);
    if (d) out += lead + 'body[data-vscode-theme-name]{' + d + '}';
  }
  for (const s of mod.scoped || []) {
    if (s.darkOnly && !isDark) continue;
    const lead = (s.darkOnly ? pre : '') + 'body[data-vscode-theme-name] ';
    const sels = String(s.sel).split(',').map((seg) => lead + seg.trim()).join(',');
    const d = declOf(s.vars);
    if (d) out += sels + '{' + d + '}';
  }
  return out;
}

async function applyThemeByCdp(id) {
  if (!PROFILE.capabilities.theme) throw new Error(`${PROFILE.name} 暂不支持主题功能`);
  if (!cdp.connected) throw new Error('CDP 未连接');
  let _accUid = null;
  try { const _a = currentAccount(); _accUid = _a ? _a.uid : null; } catch (_) {}
  const uid = (typeof _accUid === 'string' && _accUid) ? _accUid : null;
  const theme = getTheme(id);
  const colors = (theme && theme.colors) || {};
  const allCssStr = Object.keys(colors).map((k) => k + ':' + colors[k] + ';').join('');
  // 局部容器覆盖：对已知硬编码容器追加同层变量（body[data-vscode-theme-name] 提升优先级）
  let localCssStr = '';
  for (const loc of LOCAL_THEME_OVERRIDES) {
    const parts = [];
    for (const v of loc.vars) {
      if (colors[v]) parts.push(v + ':' + colors[v] + ';');
    }
    if (parts.length) localCssStr += 'body[data-vscode-theme-name] ' + loc.sel + '{' + parts.join('') + '}';
  }
  const extrasCss = themeExtrasCss();
  const isDark = !!(theme && theme.dark);
  // 背景图：主题 JSON 带 image 字段时，从 themes/<id>/<image> 读取转 data URL（WBSS 方案：#root 背景 + 容器透明化）
  let bgCssStr = '';
  if (theme && theme.image) {
    try {
      const safeId = String(theme.id || id).replace(/[^A-Za-z0-9_-]/g, '_');
      const candidates = [
        path.join(THEMES_DIR, safeId, String(theme.image).replace(/^\.\.?[/\\]/, '')),
        path.join(THEMES_DIR, safeId, 'background.' + String(theme.image).split('.').pop()),
        path.join(THEMES_DIR, String(theme.image).replace(/^\.\.?[/\\]/, '')),
      ];
      let imgPath = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) { imgPath = c; break; }
      }
      // 兜底：按文件名在 themes 所有子目录里搜索（兼容旧 build 上传时目录 id 与主题 id 不一致的情况）
      if (!imgPath) {
        try {
          const wanted = String(theme.image).split('/').pop().split('\\').pop();
          for (const sub of fs.readdirSync(THEMES_DIR)) {
            const p = path.join(THEMES_DIR, sub, wanted);
            if (fs.existsSync(p)) { imgPath = p; break; }
          }
        } catch (_) {}
      }
      if (imgPath) {
        const buf = fs.readFileSync(imgPath);
        const ext = path.extname(imgPath).toLowerCase().replace('.jpeg', '.jpg');
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        // WBSS 背景图方案：背景图铺 #root，容器透明 + 半透明毛玻璃让底图透出
        // 遮罩/半透明度调低（40%/34%/30%）：背景图偏暗时让图更透出，毛玻璃更可见
        // 全局黑色蒙版（默认 0.3，面板主题页可调）：rgba(0,0,0,α) 压在最上层，让背景图更沉、文字更可读
        // 注意：opacity=0 是合法的「关闭蒙版」，不能用 || 兜底（0 会被当成 falsy 变成 0.1）
        const maskFile = path.join(DATA_DIR, 'mask.json');
        let mask = 0.3;
        try {
          if (fs.existsSync(maskFile)) {
            const v = parseFloat(JSON.parse(fs.readFileSync(maskFile, 'utf8')).opacity);
            if (!Number.isNaN(v)) mask = Math.min(1, Math.max(0, v));
          }
        } catch (_) {}
        bgCssStr = [
          '#root{background:',
          'linear-gradient(rgba(0,0,0,' + mask + '),rgba(0,0,0,' + mask + ')),',
          'linear-gradient(90deg,color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) 0 18%,transparent 42%),',
          'linear-gradient(180deg,transparent 0 58%,color-mix(in srgb,var(--wb-bg-primary) 50%,transparent) 100%),',
          'url(' + dataUrl + ') right center / cover no-repeat fixed !important;}',
          'body[data-vscode-theme-name] .teams-container,body[data-vscode-theme-name] .teams-container.is-mac{background:transparent !important}',
          'body[data-vscode-theme-name] [data-view-id]{background:transparent !important}',
          'body[data-vscode-theme-name] .main-content{background:transparent !important}',
          // 左侧菜单（会话列表）透明（用户 08-30 00:46 要求去掉毛玻璃，连同子组件全透明，背景图直接透出）
          'body[data-vscode-theme-name] .conversation-list,body[data-vscode-theme-name] [data-view-id=sidebar]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important}',
          // 输入框区域：毛玻璃背景（用户要求加回：半透明 + 模糊，背景图透出）
          // 注意：聊天页 [class*="input-area-container"] 父容器改为透明（patch-40 处理），
          // 主页 .wb-home-composer 也改为透明（patch-37），毛玻璃只保留在输入框主体 _mainArea（patch-40）。
          'body[data-vscode-theme-name] [class*="chat-input"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.15)}',
          // 主内容区底部渐变保证可读
          'body[data-vscode-theme-name] [data-view-id=main-content]{background:linear-gradient(180deg,transparent 0 38%,color-mix(in srgb,var(--wb-bg-primary) 55%,transparent) 100%) !important}',
        ].join('');
      }
    } catch (e) {
      log('[theme] 背景图加载失败: ' + e.message);
    }
  }
  const expr = `(function(){
    var h = document.documentElement, b = document.body;
    if (!h || !b) return { pending: true };
    var WBS_UID = ${JSON.stringify(uid || null)};
    // WorkDaddy 自定义主题已应用标记：theme-patches 里部分规则用 html[data-wbs-theme] 限定
    // 只在 WorkDaddy 内置自定义主题下生效（官方默认主题不激活）。
    try { h.setAttribute('data-wbs-theme', ${id === 'default' ? "'0'" : "'1'"}); } catch (e) {}
    // 联动 WorkBuddy 原生主题（源码 theme.ts ThemeManager + legacy-appearance-mode-storage）：
    // 1) 写 localStorage 'agent-ui-theme'（ThemeManager.saveTheme 同款结构），reload/重启后 WorkBuddy 自己恢复该主题；
    // 2) 写 'workbuddy.appearance.lastApplied'（getInitialTheme 优先读它，避免残留旧外观覆盖我们的配置）；
    // 3) 同步 'workbuddy.appearance.mode::*'（顶部「浅色/深色」开关存储，账号维度）与
    //    'workbuddy.appearance.state::*'（外观面板 currentTheme），否则启动时 AppearanceMenuItem/useAppearance
    //    会按账号原偏好（如 dark）恢复并覆盖我们的设置 —— 这是面板切主题被"弹回"的根因；
    // 4) 设置 body[data-vscode-theme-kind]，触发 ThemeManager 的 MutationObserver（syncThemeClassesFromAttribute），
    //    让 WorkBuddy 内部 useTheme hook / 组件 theme prop 实时跟随，等价调用原生 setTheme()。
    function wbsSyncAppearanceKeys(mode) {
      try {
        // 覆盖所有已存在的账号外观键（mode 存裸 'light'/'dark'，state 存 {currentTheme}）
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (typeof k !== 'string') continue;
          if (k.indexOf('workbuddy.appearance.mode::') === 0) {
            localStorage.setItem(k, mode);
          } else if (k.indexOf('workbuddy.appearance.state::') === 0) {
            try { localStorage.setItem(k, JSON.stringify({ currentTheme: mode })); } catch (e3) {}
          }
        }
        // 当前账号兜底键（个人版默认 accountType=personal、eid=personal），保证新账号也跟随
        if (WBS_UID) {
          localStorage.setItem('workbuddy.appearance.mode::personal::personal::' + WBS_UID, mode);
          try { localStorage.setItem('workbuddy.appearance.state::personal::' + WBS_UID, JSON.stringify({ currentTheme: mode })); } catch (e4) {}
        }
      } catch (e5) {}
    }
    function wbsSyncNativeTheme(mode) {
      var isLight = mode === 'light';
      var kind = isLight ? 'vscode-light' : 'vscode-dark';
      var name = isLight ? 'IDE Light' : 'IDE Night';
      try {
        localStorage.setItem('agent-ui-theme', JSON.stringify({ theme: mode, followSystem: false, vsCodeThemeName: name, vsCodeThemeKind: kind }));
        try { localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ appearance: mode })); } catch (e2) {}
        wbsSyncAppearanceKeys(mode);
      } catch (e1) {}
      b.setAttribute('data-vscode-theme-kind', kind);
      b.setAttribute('data-vscode-theme-name', name);
      h.setAttribute('data-theme', mode);
    }
    var s = document.getElementById('wbs-theme-style');
    if (s) s.remove();
    if (${id === 'default' ? 'true' : 'false'}) {
      // 默认主题：完全恢复官方浅色（移除 dark 标记，body 恢复官方浅色主题名）
      h.removeAttribute('data-theme'); h.classList.remove('cb-dark');
      b.setAttribute('data-vscode-theme-name', 'IDE Light'); b.classList.remove('vscode-dark');
      wbsSyncNativeTheme('light');
    } else {
      if (${isDark ? 'true' : 'false'}) {
        // 深色主题：切官方深色模式（局部硬编码变量随之变深）
        h.setAttribute('data-theme', 'dark');
        h.classList.add('cb-dark');
        b.setAttribute('data-vscode-theme-name', 'IDE Night');
        b.classList.add('vscode-dark');
        wbsSyncNativeTheme('dark');
      } else {
        // 浅色主题：保持官方浅色主题名（选择器 body[data-vscode-theme-name] 需匹配）
        h.removeAttribute('data-theme'); h.classList.remove('cb-dark');
        b.setAttribute('data-vscode-theme-name', 'IDE Light'); b.classList.remove('vscode-dark');
        wbsSyncNativeTheme('light');
      }
      // 注入自定义色板（body 层覆盖，同优先级后插入胜出）+ 变量别名层（官方漏定义 token 重定向）
      var css = 'body[data-vscode-theme-name]{' + ${JSON.stringify(allCssStr)} + '}' +
        ${JSON.stringify(localCssStr)} +
        ${JSON.stringify(themeVarsCss(isDark))} +
        ${JSON.stringify(extrasCss)} + ${JSON.stringify(bgCssStr)};
      var st = document.createElement('style');
      st.id = 'wbs-theme-style';
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    }
    var cs = getComputedStyle(b);
    return { applied: ${id === 'default' ? 'false' : 'true'}, dark: ${isDark ? 'true' : 'false'}, bg: cs.getPropertyValue('--vscode-editor-background').trim(), text: cs.getPropertyValue('--vscode-editor-foreground').trim() };
  })()`;
  let r;
  let v;
  let lastError = null;
  // 页面导航时旧 target 的 WebSocket 会短暂失效。重新发现 target 并等待 body
  // 就绪，避免把正常的渲染竞态显示成“应用主题失败”。
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (!cdp.connected) {
        await connectCdp();
      } else if (attempt) {
        await cdpActivatePage();
      }
      r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r && r.exceptionDetails) {
        const detail = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error(detail || r.exceptionDetails.text || 'Runtime.evaluate 执行失败');
      }
      v = r && r.result && r.result.value;
      if (v && !v.pending) break;
      lastError = v && v.pending
        ? new Error('WorkBuddy 页面尚未完成加载')
        : new Error('Runtime.evaluate 未返回主题结果');
    } catch (error) {
      lastError = error;
      if (!cdp.ws || cdp.ws.readyState !== 1 || /closed|socket|connection|CDP/i.test(String(error && error.message || error))) {
        cdp.connected = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (!v) {
    const detail = lastError && lastError.message ? lastError.message : '未知 CDP 响应';
    log('[theme] 应用主题失败: ' + detail);
    throw new Error('应用主题失败: ' + detail);
  }
  return { ok: true, applied: v.applied, dark: v.dark, bg: v.bg, text: v.text };
}

/**
 * 通过 CDP 清空 WorkBuddy 输入框（点暂存按钮入队成功后调用，让输入框内容随之清空）。
 * 实现：focus -> range 全选 -> execCommand('delete')。
 * 注意：不能用 CDP Input.dispatchKeyEvent 模拟 Cmd+A —— 在此环境会挂起（页面主线程无响应）。
 */
async function clearComposerByCdp() {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const expr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      if (mic) {
        var p = mic.parentElement;
        for (var up = 0; up < 6 && p; up++) {
          var e = p.querySelector('[contenteditable="true"]');
          if (e) { ed = e; break; }
          p = p.parentElement;
        }
      }
      if (!ed) {
        var all = document.querySelectorAll('[contenteditable="true"]'), best = null, bestBottom = -Infinity;
        for (var i = 0; i < all.length; i++) {
          var r = all[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.bottom > bestBottom) { best = all[i]; bestBottom = r.bottom; }
        }
        ed = best;
      }
      if (!ed) return { ok: false, error: 'no editor' };
      ed.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete');
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result && r.result.value;
  if (!v || !v.ok) throw new Error((v && v.error) || '无法清空输入框');
  await new Promise((r2) => setTimeout(r2, 250));
  return { cleared: true };
}

/**
 * 通过 CDP 把暂存内容发送到 WorkBuddy 输入框：
 * 0) 等待 AI 空闲（避免回复中输入框状态异常导致还原失败、消息进队列自动发送）
 * 1) 聚焦输入框（与 inject.js findComposer 相同策略，独立实现，不依赖注入组件）
 * 2) Input.insertText 真实键入文本（触发 beforeinput，Slate/React 完全感知）
 * 3) 找到发送按钮（操作栏最右圆形可点击元素，与 inject.js findSendButton 相同算法）并真实鼠标点击
 */
async function sendStashToComposer(record) {
  if (!cdp.connected) throw new Error('CDP 未连接，无法发送');
  // 等待 AI 空闲：若正在回复，最多等 60 秒；期间前端会提示"等待空闲"
  const idle = await waitAiIdle();
  if (!idle) throw new Error('对话持续回复中（等待 60 秒仍未空闲），已取消发送，请稍后再试');
  const content = record.content || {};
  const allItems = (content.items || []).filter((it) => it && typeof it === 'object');
  const imageItems = allItems.filter((it) => it.type === 'image' && (it.imageBase64 || (typeof it.data === 'string' && it.data)));
  const blockItems = allItems.filter((it) => it.type !== 'image' && (it.name || it.uri || (it._meta && (it._meta.type || it._meta.mentionType))));
  // 文本：剔除所有 item 的文本占位符（name/title/displayText），避免还原块后文字重复
  let text = (content.text || '').toString();
  const placeholders = [];
  for (const it of allItems) {
    const cands = [it.name, it.title, it._meta && it._meta.displayText];
    for (const c of cands) {
      const s = (c || '').trim();
      if (s && placeholders.indexOf(s) < 0) placeholders.push(s);
    }
  }
  placeholders.sort((a, b) => b.length - a.length); // 先删长的，避免子串误删
  for (const ph of placeholders) {
    const esc = ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('\\s*' + esc + '\\s*', 'g'), '\n');
  }
  // 规整：折叠连续空行（保留至多 2 行）、去掉零宽字符与首尾空白
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[\uFEFF\u200B]+/g, '').replace(/\s+$/g, '').trimStart();
  if (!text && !allItems.length) throw new Error('暂存内容为空');

  const focusExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      if (mic) {
        var p = mic.parentElement;
        for (var up = 0; up < 6 && p; up++) {
          var e = p.querySelector('[contenteditable="true"]') || p.querySelector('[data-slate-editor="true"]');
          if (e) { ed = e; break; }
          p = p.parentElement;
        }
      }
      if (!ed) {
        var all = document.querySelectorAll('[contenteditable="true"]');
        if (mic && all.length) {
          var mr = mic.getBoundingClientRect(), best = null, bd = Infinity;
          for (var i = 0; i < all.length; i++) {
            var r = all[i].getBoundingClientRect();
            if (r.height > 0 && r.bottom > 0 && r.bottom <= mr.top + 40) {
              var d = mr.top - r.bottom;
              if (d >= 0 && d < bd) { bd = d; best = all[i]; }
            }
          }
          if (best) ed = best;
        }
        if (!ed && all.length) ed = all[0];
      }
      if (!ed) return { ok: false, error: '未找到输入框' };
      ed.focus();
      ed.scrollIntoView({ block: 'nearest' });
      try {
        var sel = window.getSelection();
        if (sel && sel.selectAllChildren) { sel.selectAllChildren(ed); sel.collapseToEnd(); }
      } catch (_) {}
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const fr = await cdpSend('Runtime.evaluate', { expression: focusExpr, returnByValue: true });
  const fv = fr.result && fr.result.value;
  if (!fv || !fv.ok) throw new Error((fv && fv.error) || '无法聚焦输入框');

  // 1.5) 清空输入框已有内容（避免与暂存内容拼接）。
  // 关键：不能用 document.execCommand('delete') —— execCommand 绕过 Slate 的 model 同步，
  // 会破坏编辑器内部 selection 状态，导致之后「退格/全选失效、只能追加文字」。
  // 改用 CDP 真实键盘事件：Cmd+A 全选 + Backspace 删除，Slate 完全感知（onKeyDown -> beforeinput 链路）。
  const clearExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      if (mic) {
        var p = mic.parentElement;
        for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; }
      }
      if (!ed) {
        var all = document.querySelectorAll('[contenteditable="true"]'), best = null, bestBottom = -Infinity;
        for (var i = 0; i < all.length; i++) {
          var r = all[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.bottom > bestBottom) { best = all[i]; bestBottom = r.bottom; }
        }
        ed = best;
      }
      if (!ed) return { ok: false, error: 'no editor' };
      ed.focus();
      return { ok: true, hasContent: ((ed.innerText || '').replace(/[\\uFEFF\\u200B\\u00A0]/g, '').trim().length > 0) || !!ed.querySelector('[data-contentblock]') };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const clr = await cdpSend('Runtime.evaluate', { expression: clearExpr, returnByValue: true });
  const clrV = clr.result && clr.result.value;
  if (!clrV || !clrV.ok) throw new Error((clrV && clrV.error) || '无法聚焦输入框');
  if (clrV.hasContent) {
    // Cmd+A 全选（macOS meta=4）→ Backspace 删除
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await new Promise((r) => setTimeout(r, 120));
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await new Promise((r) => setTimeout(r, 300));
  }

  // 真实键入文本：逐行 insertText，行间 Shift+Enter 换行（trusted 键盘事件，Slate 生成段落；
  // 不能一次 insertText 整个文本——其中的 \n 不会在 Slate 中变成段落）
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (lines[li]) {
      const CHUNK = 4000;
      for (let i = 0; i < lines[li].length; i += CHUNK) {
        await cdpSend('Input.insertText', { text: lines[li].slice(i, i + CHUNK) });
        if (i + CHUNK < lines[li].length) await new Promise((r) => setTimeout(r, 40));
      }
    }
    if (li < lines.length - 1) {
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8 }); // Shift+Enter
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8 });
    }
  }

  // 图片还原：构造含 image File 的合成 paste 事件，触发 WorkBuddy 的 onPasteFiles 插入 contentblock。
  // 关键：
  //  - 必须先 focus（activeElement 需在粘贴容器内），否则 handlePaste 直接忽略
  //  - 必须先有真实文本输入重建有效 selection（execCommand 清空后 selection 可能无效，合成 paste 会被忽略）
  //  - 还原后轮询验证 contentblock 数量是否增加；未增加说明当前会话不支持图片附件（降级为仅文字）
  const countExpr = `(function(){
    var mic = document.querySelector('.voice-mic-wrap');
    var ed = null;
    if (mic) { var p = mic.parentElement;
      for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; } }
    if (!ed) {
      var all = document.querySelectorAll('[contenteditable="true"]'), best = null, bestBottom = -Infinity;
      for (var i = 0; i < all.length; i++) { var r = all[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.bottom > bestBottom) { best = all[i]; bestBottom = r.bottom; } }
      ed = best;
    }
    return ed ? ed.querySelectorAll('[data-contentblock]').length : 0;
  })()`;
  const countBlocks = async () => {
    const r = await cdpSend('Runtime.evaluate', { expression: countExpr, returnByValue: true });
    return (r.result && r.result.value) || 0;
  };
  let imagesRestored = 0;
  let imagesFailed = 0;
  let blocksRestored = 0;
  let blocksFailed = 0;

  // 通用「合成 paste 后轮询验证 contentblock 增加」
  const pasteAndVerify = async (dtScript) => {
    const before = await countBlocks();
    const pasteExpr = `(function(){
      try {
        var mic = document.querySelector('.voice-mic-wrap');
        var ed = null;
        if (mic) { var p = mic.parentElement;
          for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; } }
        if (!ed) {
          var all = document.querySelectorAll('[contenteditable="true"]'), best = null, bestBottom = -Infinity;
          for (var i = 0; i < all.length; i++) { var r = all[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.bottom > bestBottom) { best = all[i]; bestBottom = r.bottom; } }
          ed = best;
        }
        if (!ed) return { ok: false, error: 'no editor' };
        ed.focus();
        var sel = window.getSelection();
        if (sel && sel.selectAllChildren) { sel.selectAllChildren(ed); sel.collapseToEnd(); }
        var dt = new DataTransfer();
        ${dtScript}
        var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        ed.dispatchEvent(ev);
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`;
    const ir = await cdpSend('Runtime.evaluate', { expression: pasteExpr, returnByValue: true });
    const iv = ir.result && ir.result.value;
    if (!iv || !iv.ok) return false;
    // 轮询验证（最多 ~3 秒）contentblock 数量是否增加
    for (let t = 0; t < 10; t++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = await countBlocks();
      if (now > before) return true;
    }
    return false;
  };

  // 1) 图片：合成 paste 携带 image File（走 WorkBuddy 的 onPasteFiles）
  for (const it of imageItems) {
    let b64 = it.imageBase64 || (typeof it.data === 'string' ? it.data : '');
    if (!b64) continue;
    let mime = 'image/png';
    if (b64.indexOf('data:') === 0) {
      const m = b64.match(/^data:([^;,]+)[;,]/);
      if (m && m[1]) mime = m[1];
      b64 = b64.slice(b64.indexOf(',') + 1);
    }
    const name = (it.name || 'image.png').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const dtScript =
      'var bin = atob(' + JSON.stringify(b64) + ');' +
      'var bytes = new Uint8Array(bin.length);' +
      'for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);' +
      'dt.items.add(new File([bytes], ' + JSON.stringify(name) + ', { type: ' + JSON.stringify(mime) + ' }));';
    const ok = await pasteAndVerify(dtScript);
    if (ok) imagesRestored++;
    else imagesFailed++;
  }

  // 2) 非图片块（skill / 文件 / 上下文等 resource_link）：
  //    WorkBuddy 的 Slate onPaste 走 React 合成事件，不响应脚本派发的合成 paste（实测静默失败），
  //    因此无法还原为块——回填为文字行（显示文本），保证内容不丢失。
  let blockText = '';
  for (const it of blockItems) {
    const disp = (it._meta && it._meta.displayText) || it.title || it.name || '';
    if (disp) blockText += (blockText ? '\n' : '') + disp;
  }
  if (blockText) text = text ? text + '\n' + blockText : blockText;
  blocksFailed = blockItems.length;

  // 等 React 重渲染使发送按钮可用
  await new Promise((r) => setTimeout(r, 250));

  const sendExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var row = mic ? mic.parentElement : null;
      if (!row) {
        var allEd = document.querySelectorAll('[contenteditable="true"]'), ed = null, bestBottom = -Infinity;
        for (var ei = 0; ei < allEd.length; ei++) { var er = allEd[ei].getBoundingClientRect(); if (er.width > 0 && er.height > 0 && er.bottom > 0 && er.bottom > bestBottom) { ed = allEd[ei]; bestBottom = er.bottom; } }
        if (ed) {
          var er2 = ed.getBoundingClientRect();
          var buttons = document.querySelectorAll('button,[role="button"]'), candidates = [];
          for (var bi = 0; bi < buttons.length; bi++) {
            var b0 = buttons[bi];
            if (b0.closest && b0.closest('.wbs-root')) continue;
            var br0 = b0.getBoundingClientRect(), cs0 = getComputedStyle(b0);
            var click0 = b0.tagName === 'BUTTON' || b0.getAttribute('role') === 'button';
            var circ0 = /%/.test(cs0.borderRadius || '') || parseFloat(cs0.borderRadius || '0') >= Math.min(br0.width, br0.height) / 2 - 3;
            if (click0 && circ0 && br0.width >= 16 && br0.height >= 16 && br0.bottom > er2.bottom - 140 && br0.top < er2.bottom + 180) candidates.push(b0);
          }
          if (candidates.length) row = candidates[candidates.length - 1].parentElement;
        }
      }
      if (!row || !row.children) return { ok: false, error: '未找到操作栏' };
      var kids = row.children, matches = [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        var cs = getComputedStyle(k);
        var isClick = k.getAttribute && (k.getAttribute('role') === 'button' || k.tagName === 'BUTTON');
        var r = k.getBoundingClientRect();
        var w = r.width, h = r.height;
        if (!isClick || w < 16 || h < 16) continue;
        var circular = /%/.test(cs.borderRadius) || parseFloat(cs.borderRadius || '0') >= Math.min(w, h) / 2 - 3;
        if (circular) matches.push(k);
      }
      if (!matches.length) return { ok: false, error: '未找到发送按钮' };
      var btn = matches[matches.length - 1];
      var dis = btn.disabled === true || (btn.hasAttribute && btn.hasAttribute('disabled'));
      if (dis) return { ok: false, error: '发送按钮禁用（输入内容未被识别）' };
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      var b = btn.getBoundingClientRect();
      return { ok: true, x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const sr = await cdpSend('Runtime.evaluate', { expression: sendExpr, returnByValue: true });
  const sv = sr.result && sr.result.value;
  if (!sv || !sv.ok) throw new Error((sv && sv.error) || '未找到发送按钮');
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sv.x, y: sv.y });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: sv.x, y: sv.y, button: 'left', clickCount: 1 });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sv.x, y: sv.y, button: 'left', clickCount: 1 });
  return { sent: true, textLen: text.length, itemCount: allItems.length, imagesRestored, imagesFailed, blocksRestored, blocksFailed };
}

/**
 * 查询剩余积分余额。
 * WorkBuddy v2 接口返回所有有效资源 Account，避免按 PackageCode 白名单漏掉赠送或付费额度。
 */
async function fetchResource(accessToken, body, source) {
  // 积分查询与签到同源：按 profile 归属域名请求（国际版为 www.workbuddy.ai）
  const apiHost = PROFILE.apiHost || 'https://www.workbuddy.cn';
  const r = await fetch(`${apiHost}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      origin: apiHost,
      referer: `${apiHost}/profile/plans-usage`,
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const text = await r.text();
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Error(`解析积分响应失败: ${e.message}`);
  }
  if (!r.ok) throw new Error(`积分接口 HTTP ${r.status}: ${text.slice(0, 120)}`);
  if (o.code !== 0 && o.code !== undefined) throw new Error(o.msg || `积分接口返回 code=${o.code}`);
  const data = (o.data && o.data.Response && o.data.Response.Data) ||
    (o.data && o.data.data && o.data.data.Response && o.data.data.Response.Data) ||
    null;
  const accounts = (data && Array.isArray(data.Accounts) ? data.Accounts : null) ||
    (o.data && Array.isArray(o.data.accounts) ? o.data.accounts : null) ||
    (o.data && o.data.data && Array.isArray(o.data.data.accounts) ? o.data.data.accounts : null) ||
    [];
  let credits = 0;
  for (const a of accounts) {
    // 剩余字段优先「周期剩余」(CycleCapacityRemainPrecise)：月度包用完时 CapacityRemainPrecise
    // 仍是满额(如 500)，但 CycleCapacityRemainPrecise 已为 0，必须用周期剩余才算对。
    const cands = [a.CycleCapacityRemainPrecise, a.CycleCapacityRemain, a.CapacityRemainPrecise, a.CapacityRemain];
    let v = NaN;
    for (const c of cands) {
      if (c === undefined || c === null || c === '') continue;
      const n = parseFloat(c);
      if (!Number.isNaN(n)) { v = n; break; }
    }
    if (!Number.isNaN(v)) credits += v;
  }
  return {
    credits: parseFloat(credits.toFixed(2)),
    count: accounts.length,
    totalDosage: data && data.TotalDosage,
    segments: mergeCreditSegments(extractCreditSegments(accounts, source)),
  };
}

/**
 * 查询企业账号剩余配额。
 * 官方链路：WorkBuddy 主进程 AuthProductCoordinator.getEnterpriseUsage——
 *   POST {endpoint}/v2/billing/meter/get-enterprise-user-usage，body {}，
 *   headers 必须带 X-Enterprise-Id / X-Tenant-Id（缺了网关直接 400 "uid or enterpriseID is empty"）。
 * 响应 data { credit, limitNum, cycleResetTime }；limitNum===-1 表示不限量。
 */
async function fetchEnterpriseResource(accessToken, enterpriseId, domain) {
  const apiHost = PROFILE.apiHost || 'https://www.workbuddy.cn';
  const headers = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    origin: apiHost,
    referer: `${apiHost}/profile/plans-usage`,
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'x-enterprise-id': String(enterpriseId),
    'x-tenant-id': String(enterpriseId),
  };
  if (domain) headers['x-domain'] = domain;
  let r;
  try {
    r = await fetch(`${apiHost}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    throw new Error(`企业积分接口请求失败: ${e.message}`);
  }
  const text = await r.text();
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Error(`解析企业积分响应失败: ${e.message}`);
  }
  if (!r.ok) throw new Error(`企业积分接口 HTTP ${r.status}: ${text.slice(0, 120)}`);
  if (o.code !== 0 && o.code !== undefined) throw new Error(o.msg || `企业积分接口返回 code=${o.code}`);
  const parsed = parseEnterpriseUsage(o, '企业配额');
  if (!parsed) throw new Error('企业积分接口返回数据无法解析');
  return parsed;
}

async function robustFetchEnterpriseResource(accessToken, enterpriseId, domain) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchEnterpriseResource(accessToken, enterpriseId, domain);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        log(`[credits] 企业 ${String(enterpriseId).slice(0, 8)} 失败(第 ${attempt} 次): ${e.message}`);
        await retryDelay(300 * attempt);
      }
    }
  }
  throw lastErr || new Error('企业积分查询返回空结果');
}

/**
 * 老备份可能没记 enterpriseId：企业版账号（type ∈ {ultimate, exclusive}）从
 * 用户信息接口 /console/accounts 补一次（官方 session.account 的数据来源）。
 * 拿不到就返回空串，由调用方按「无法查询」处理，绝不误报 0。
 */
async function resolveEnterpriseId(uid, accessToken) {
  const apiHost = PROFILE.apiHost || 'https://www.workbuddy.cn';
  try {
    const r = await fetch(`${apiHost}/console/accounts`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'x-user-id': String(uid),
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
    const o = await r.json();
    const list = o && o.data && Array.isArray(o.data.accounts) ? o.data.accounts : [];
    const enterpriseId = list[0] && list[0].enterpriseId ? String(list[0].enterpriseId).trim() : '';
    if (enterpriseId) log(`[credits] 从 /console/accounts 补到企业 ID ${enterpriseId.slice(0, 8)}…`);
    return enterpriseId;
  } catch (e) {
    log(`[credits] 补拉企业 ID 失败: ${e.message}`);
    return '';
  }
}

/**
 * 用指定账号的 accessToken 查询 WorkBuddy 总剩余积分。
 * 单次全量资源查询失败会有限重试，避免临时接口异常把余额显示为偏低值。
 */
const retryDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// 接口/http 偶发失败或返回空 Accounts 时，若直接按 0 计入会让总余额偏低。
// 重试耗尽仍失败才抛出，由上层按现有错误路径处理。
async function robustFetchResource(accessToken, body, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchResource(accessToken, body, label);
      // 偶发返回空 Accounts（count=0）也会把该组余额算成 0，同样再多试一次（bound 在 3 次内）
      if (r.count === 0 && attempt < 3) {
        log(`[credits] ${label} 返回空结果，第 ${attempt} 次重试`);
        await retryDelay(300 * attempt);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        log(`[credits] ${label} 失败(第 ${attempt} 次): ${e.message}，重试`);
        await retryDelay(300 * attempt);
      }
    }
  }
  throw lastErr || new Error(label + ' 查询返回空结果');
}

/**
 * 查询指定账号的剩余积分。账号类型分流与官方 AuthProductCoordinator.getAccountUsage 一致：
 *   enterpriseId 非空（或 type 属企业版）→ 企业接口 get-enterprise-user-usage；
 *   否则 → 个人接口 get-user-resource。
 * @param {string} accessToken
 * @param {object} [account] .info 备份中的 account 字段（enterpriseId / type / uid / domain）
 */
async function fetchCredits(accessToken, account) {
  const info = account && typeof account === 'object' ? account : {};
  const enterpriseId = typeof info.enterpriseId === 'string' ? info.enterpriseId.trim() : '';
  const isEnterpriseEdition = typeof info.type === 'string' && ENTERPRISE_EDITIONS.includes(info.type);
  if (enterpriseId || isEnterpriseEdition) {
    const resolvedId = enterpriseId ||
      (typeof info.uid === 'string' && info.uid ? await resolveEnterpriseId(info.uid, accessToken) : '');
    if (!resolvedId) {
      log('[credits] 企业账号缺少 enterpriseId，无法查询企业配额');
      return {
        credits: null, count: 0, totalDosage: 0,
        meterCredits: null, packageCredits: 0,
        meterError: '缺少企业 ID', packageError: null,
        segments: [], unlimited: false, cycleResetTime: null,
      };
    }
    const r = await robustFetchEnterpriseResource(accessToken, resolvedId, typeof info.domain === 'string' ? info.domain : undefined);
    return {
      credits: r.unlimited ? null : r.credits,
      count: r.count,
      totalDosage: r.total,
      meterCredits: r.unlimited ? null : r.credits,
      packageCredits: 0,
      meterError: null,
      packageError: null,
      segments: Array.isArray(r.segments) ? r.segments : [],
      unlimited: !!r.unlimited,
      cycleResetTime: r.cycleResetTime || null,
    };
  }

  // 个人账号：v2 全量资源 Account 汇总（原逻辑）
  const result = await robustFetchResource(accessToken, buildCreditResourceBody(), 'all-resources');
  const credits = result.credits;
  const totalDosage = Number(result.totalDosage) || 0;
  let segments = sortCreditSegments(result.segments || []);
  const visibleSegmentCredits = segments.reduce((sum, segment) => sum + segment.remaining, 0);
  // Keep the total and the bar consistent even when a new API field is not recognized yet.
  if (credits > visibleSegmentCredits + 0.01) {
    segments = sortCreditSegments([
      ...segments,
      { remaining: credits - visibleSegmentCredits, total: credits - visibleSegmentCredits, expiresAt: null, source: '其他积分' },
    ]);
  }
  return {
    credits,
    count: result.count,
    totalDosage,
    meterCredits: credits,
    packageCredits: 0,
    meterError: null,
    packageError: null,
    segments,
    unlimited: false,
    cycleResetTime: null,
  };
}

async function listDailyUsage(accounts, date = todayStr()) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return {};
  return CREDIT_USAGE_STORE.listDailyUsage(list.map((account) => account.uid), date);
}

async function syncCurrentCreditUsage(uid, accessToken) {
  const existing = creditUsageSyncInFlight.get(uid);
  if (existing) return existing;
  const task = (async () => {
    const now = new Date();
    const nowMs = now.getTime();
    const state = await CREDIT_USAGE_STORE.getSyncState(uid);
    if (state && Number.isFinite(state.lastSuccessAt) && nowMs - state.lastSuccessAt < CREDIT_USAGE_REFRESH_MS) {
      return CREDIT_USAGE_STORE.dailyUsageForUid(uid, todayStr(now));
    }
    const lastSuccessAt = state && Number.isFinite(state.lastSuccessAt) && state.lastSuccessAt <= nowMs
      ? new Date(state.lastSuccessAt)
      : now;
    const startTime = startOfLocalDay(lastSuccessAt);
    const result = await fetchUsageSinceAnchor({
      accessToken,
      apiHost: PROFILE.apiHost || 'https://www.workbuddy.cn',
      startTime,
      endTime: now,
      anchorRequestId: state && state.anchorRequestId,
    });
    await CREDIT_USAGE_STORE.saveSuccessfulSync({
      uid,
      records: result.records,
      anchorRequestId: result.newestRequestId || (state && state.anchorRequestId) || '',
      syncedAt: nowMs,
    });
    return CREDIT_USAGE_STORE.dailyUsageForUid(uid, todayStr(now));
  })();
  creditUsageSyncInFlight.set(uid, task);
  try {
    return await task;
  } finally {
    if (creditUsageSyncInFlight.get(uid) === task) creditUsageSyncInFlight.delete(uid);
  }
}

/* ================= 加密导出 / 导入 =================
 * v2 导出：用户在面板输入非空密码；随机 salt + AES-256-GCM，密码不落盘、不写日志。
 * v1 导入：兼容历史固定密码 workdaddy 的导出文件，空密码即走旧格式默认值。
 */
const EXPORT_PASSPHRASE = 'workdaddy';
const EXPORT_KDF_SALT = 'WorkDaddy-account-export-v1';

function exportSecretKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32);
}

function decryptLegacyExport(b64, password) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length <= 28) throw new Error('导出数据不完整或已损坏');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', exportSecretKey(password || EXPORT_PASSPHRASE, EXPORT_KDF_SALT), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;
  const origin = String(req.headers.origin || '');
  res.__wbsCorsOrigin = origin && isAllowedApiOrigin(origin) ? origin : '';

  // CORS 预检（注入到 WorkBuddy 页面里的组件需要跨域调用本机 API）
  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedApiOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('forbidden origin');
    }
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-WorkDaddy-Token',
      'Access-Control-Max-Age': '86400',
    };
    if (res.__wbsCorsOrigin) {
      headers['Access-Control-Allow-Origin'] = res.__wbsCorsOrigin;
      headers.Vary = 'Origin';
    }
    res.writeHead(204, headers);
    return res.end();
  }

  if (!isApiRequestAuthorized(req, p)) {
    return json(res, 401, { ok: false, error: '本地 API 未授权' });
  }

  if (req.method === 'POST' && p === '/api/inject') {
    return injectWidgetManual().then(
      (info) => json(res, 200, { ok: true, mounted: !!(info && info.mounted) }),
      (e) => json(res, 500, { ok: false, error: e.message })
    );
  }

  if (req.method === 'GET' && p === '/api/ask-mode') {
    return json(res, 200, { ok: true, ...getAskModeState() });
  }

  if (req.method === 'POST' && p === '/api/ask-mode-set') {
    return readBody(req).then((body) => {
      try {
        const state = setAskMode(!!body.enabled);
        log(`[ask-mode] 决策弹窗开关已${state.enabled ? '开启' : '关闭'}（下次会话全局生效）`);
        return json(res, 200, { ok: true, ...state });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 免打扰模块：GET /api/no-disturb（读全部开关状态）
  if (req.method === 'GET' && p === '/api/no-disturb') {
    return json(res, 200, { ok: true, switches: readNoDisturbState() });
  }

  // 免打扰模块：POST /api/no-disturb-set { name, enabled }
  if (req.method === 'POST' && p === '/api/no-disturb-set') {
    return readBody(req).then((body) => {
      try {
        const switches = setNoDisturbSwitch(String(body.name || ''), !!body.enabled);
        return json(res, 200, { ok: true, switches });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 免打扰模块：POST /api/no-disturb-audit（弹窗自动点允许的审计记录）
  if (req.method === 'POST' && p === '/api/no-disturb-audit') {
    return readBody(req).then((body) => {
      const ok = noDisturbAudit({
        action: body.action === 'approve' ? 'auto-approve' : String(body.action || 'unknown'),
        matched: typeof body.matched === 'string' ? body.matched.slice(0, 200) : '',
        url: typeof body.url === 'string' ? body.url.slice(0, 300) : '',
      });
      return json(res, 200, { ok });
    });
  }

  // 持续会话模块：GET /api/auto-continue（读开关/指令块/平台状态）
  if (req.method === 'GET' && p === '/api/auto-continue') {
    return json(res, 200, { ok: true, ...readAutoContinueState() });
  }

  // 持续会话模块：POST /api/auto-continue-set { enabled }
  if (req.method === 'POST' && p === '/api/auto-continue-set') {
    return readBody(req).then((body) => {
      try {
        const state = setAutoContinue(!!body.enabled);
        return json(res, 200, { ok: true, ...state });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 持续会话模块：POST /api/auto-continue-enter（CDP 真实输入+Enter 发送「如果未完成，继续执行；已完成则回复"已完成"」，旧路由别名）
  if (req.method === 'POST' && p === '/api/auto-continue-enter') {
    return acDispatchEnter()
      .then(() => json(res, 200, { ok: true }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  // 持续会话模块：POST /api/auto-continue-send（主路径：CDP 真实输入+Enter）
  if (req.method === 'POST' && p === '/api/auto-continue-send') {
    return acDispatchEnter()
      .then(() => json(res, 200, { ok: true }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  // 探索菜单：POST /api/auto-continue-send-current（直接发送当前输入框内容：聚焦+Enter，不写入文字）
  if (req.method === 'POST' && p === '/api/auto-continue-send-current') {
    return acSendCurrentInput()
      .then(() => json(res, 200, { ok: true }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  // 会话模块：GET /api/session-module（两个开关状态 + 快捷短语列表）
  if (req.method === 'GET' && p === '/api/session-module') {
    return json(res, 200, { ok: true, ...readSessionState(), platformSupported: true });
  }
  // 会话模块：POST /api/session-module-set { name, enabled }
  if (req.method === 'POST' && p === '/api/session-module-set') {
    return readBody(req).then((body) => {
      try {
        return json(res, 200, { ok: true, ...setSessionSwitch(body.name, !!body.enabled) });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 会话模块：POST /api/quick-phrase-add { text }
  if (req.method === 'POST' && p === '/api/quick-phrase-add') {
    return readBody(req).then((body) => {
      try {
        return json(res, 200, { ok: true, ...addQuickPhrase(body.text) });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 会话模块：POST /api/quick-phrase-update { id, text }
  if (req.method === 'POST' && p === '/api/quick-phrase-update') {
    return readBody(req).then((body) => {
      try {
        return json(res, 200, { ok: true, ...updateQuickPhrase(body.id, body.text) });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 会话模块：POST /api/quick-phrase-delete { ids: [id,...] }（支持批量）
  if (req.method === 'POST' && p === '/api/quick-phrase-delete') {
    return readBody(req).then((body) => {
      try {
        return json(res, 200, { ok: true, ...deleteQuickPhrases(body.ids) });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 快捷短语加密导出：POST /api/quick-phrases/export { ids, password }
  if (req.method === 'POST' && p === '/api/quick-phrases/export') {
    return readBody(req).then((body) => {
      try {
        const result = exportQuickPhrases(body && body.ids, body && body.password);
        log(`[quick-phrases-export] 已导出 ${result.count} 条快捷短语`);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    });
  }
  // 快捷短语加密导入：POST /api/quick-phrases/import { content, password }
  if (req.method === 'POST' && p === '/api/quick-phrases/import') {
    return readBody(req).then((body) => {
      try {
        const result = importQuickPhrases(body && body.content, body && body.password);
        log(`[quick-phrases-import] 已导入 ${result.imported} 条，跳过 ${result.skipped} 条`);
        return json(res, 200, { ok: true, ...result.state, imported: result.imported, skipped: result.skipped });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    });
  }
  // 会话模块：POST /api/quick-phrase-send { text }（CDP 替换输入框内容并发送）
  if (req.method === 'POST' && p === '/api/quick-phrase-send') {
    return readBody(req).then((body) =>
      acSendPhrase(body.text)
        .then(() => json(res, 200, { ok: true }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }))
    );
  }

  if (req.method === 'POST' && p === '/api/click') {
    return readBody(req).then((body) =>
      clickByText(body.text || '', { tag: body.tag, exact: !!body.exact })
        .then((info) => json(res, 200, { ok: true, clicked: info }))
        .catch((e) => json(res, 404, { ok: false, error: e.message }))
    );
  }

  if (req.method === 'POST' && p === '/api/find') {
    return readBody(req).then((body) =>
      findByText(body.text || '', { tag: body.tag, exact: !!body.exact })
        .then((info) => json(res, 200, { ok: true, found: info }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }))
    );
  }

  if (req.method === 'POST' && p === '/api/delete') {
    return readBody(req).then((body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const r = deleteAccount(DATA_DIR, uid);
        const rulesRemoved = removeAutoCopyAccount(DATA_DIR, uid);
        log(`[delete] 已永久删除账号备份 ${uid}`);
        return json(res, 200, { ok: true, deleted: r.deleted, uid, rulesRemoved });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 「假退出登录」：先退出 WorkBuddy，再删除当前登录文件（备份的 accounts/<uid>.info
  // 仍保留，token 未过期），最后重新打开，让应用回到登录页，方便登录新账号。
  if (req.method === 'POST' && p === '/api/logout') {
    return (async () => {
      let quit = false;
      let relaunched = false;
      try {
        // 必须先停宿主：优雅退出可能把内存中的旧身份重新写回登录文件。
        await quitWorkBuddy();
        quit = true;
        if (fs.existsSync(AUTH_FILE)) {
          fs.unlinkSync(AUTH_FILE); // token 仍保留在 accounts/ 备份里
          log('[logout] WorkBuddy 已退出，已删除登录文件（假退出，token 未过期，备份保留）');
        } else {
          log('[logout] WorkBuddy 已退出，当前无登录文件');
        }
        if (fs.existsSync(AUTH_FILE)) {
          throw new Error('删除登录文件后仍然存在');
        }
        await relaunchWorkBuddy();
        relaunched = true;
        return json(res, 200, { ok: true, quit, relaunched });
      } catch (e) {
        log(`[logout] 退出/删除/重启 WorkBuddy 失败: ${e.message}`);
        return json(res, 502, { ok: false, quit, relaunched, error: e.message });
      }
    })();
  }

  // /api/batch-claim 已移除：领取改为打开面板时自动调接口（见 /api/accounts）

  // 「无感登录」第一步：申请 state + 授权链接（不退出、不打断当前 WorkBuddy）
  if (req.method === 'POST' && p === '/api/oauth/start') {
    return (async () => {
      try {
        const resp = await httpJson(
          `${WB_API_ENDPOINT}${WB_API_PREFIX}/auth/state?platform=workbuddy`,
          'POST',
          {}
        );
        const d = (resp && resp.data) || {};
        if (!d.state) throw new Error('auth/state 响应缺少 state');
        const authUrl =
          d.authUrl || d.auth_url || d.url || `${WB_API_ENDPOINT}/login?state=${d.state}`;
        const loginId = 'wd_' + crypto.randomUUID().replace(/-/g, '');
        oauthStates.set(loginId, {
          state: d.state,
          expiresAt: Date.now() + OAUTH_TIMEOUT_SECONDS * 1000,
          done: false,
          result: null,
          error: null,
        });
        const cleanupTimer = setTimeout(
          () => oauthStates.delete(loginId),
          (OAUTH_TIMEOUT_SECONDS + OAUTH_RESULT_RETENTION_SECONDS) * 1000
        );
        if (cleanupTimer.unref) cleanupTimer.unref();
        log(`[oauth] 发起无感登录 loginId=${loginId}`);
        return json(res, 200, { ok: true, loginId, verificationUri: authUrl, expiresIn: OAUTH_TIMEOUT_SECONDS });
      } catch (e) {
        log(`[oauth] 发起失败: ${e.message}`);
        return json(res, 502, { ok: false, error: e.message });
      }
    })();
  }

  // 「无感登录」第二步：轮询授权结果，完成即自动入库
  if (req.method === 'GET' && p === '/api/oauth/poll') {
    const loginId = url.searchParams.get('loginId') || '';
    return oauthPollOnce(loginId).then(
      (r) => json(res, 200, Object.assign({ ok: true }, r)),
      (e) => json(res, 502, { ok: false, error: e.message })
    );
  }

  // 在系统浏览器打开链接（无感登录授权页等）
  if (req.method === 'POST' && p === '/api/open-url') {
    return readBody(req).then((body) => {
      const u = String((body && body.url) || '');
      if (!/^https?:\/\//i.test(u)) return json(res, 400, { ok: false, error: '仅支持 http(s) 链接' });
      try {
        if (IS_WIN) {
          spawn('rundll32', ['url.dll,FileProtocolHandler', u], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  if (req.method === 'GET' && p === '/api/status') {
    const authenticated = hasApiToken(req);
    const status = {
      ok: true,
      version: DAEMON_VERSION,
      buildId: DAEMON_BUILD_ID,
      pid: process.pid,
      privilege: DAEMON_PRIVILEGE,
      profile: { id: PROFILE.id, name: PROFILE.name, kind: PROFILE.kind, mode: PROFILE.mode, capabilities: PROFILE.capabilities },
      cdp: {
        connected: cdp.connected,
        port: cdp.port,
        error: cdp.error,
      },
      batch: {
        running: batchState.running,
        total: batchState.total,
        done: batchState.done,
        startedAt: batchState.startedAt,
        last: batchState.last,
      },
    };
    if (authenticated) {
      status.cdp.targetUrl = cdp.targetUrl;
      status.current = currentAccount();
      status.dataDir = DATA_DIR;
      status.authFile = AUTH_FILE;
    }
    return json(res, 200, status);
  }

  if (req.method === 'GET' && p === '/api/telemetry-settings') {
    return json(res, 200, {
      ok: true,
      enabled: telemetryEnabled(),
      managed: telemetryEnvironmentOverride() === null,
    });
  }

  if (req.method === 'POST' && p === '/api/telemetry-settings') {
    return readBody(req).then((body) => {
      if (telemetryEnvironmentOverride() !== null) {
        return json(res, 409, { ok: false, error: '诊断设置由 WORKDADDY_TELEMETRY 环境变量控制' });
      }
      if (!body || typeof body.enabled !== 'boolean') {
        return json(res, 400, { ok: false, error: '遥测开关值必须是布尔值' });
      }
      try {
        const enabled = setTelemetryEnabled(body.enabled);
        diagnosticsState = { value: enabled, checkedAt: Date.now() };
        return json(res, 200, { ok: true, enabled, managed: true });
      } catch (e) {
        return json(res, 500, { ok: false, error: '保存遥测设置失败: ' + e.message });
      }
    });
  }

  // 诊断：保存一份不含 token 的本地快照，便于用户在异常机器上直接提供文件排查。
  if (req.method === 'GET' && p === '/api/diagnostics') {
    return writeDiagnosticsSnapshot('api-get').then((snapshot) => json(res, 200, { ok: true, file: DIAGNOSTICS_FILE, diagnostics: snapshot }));
  }
  if (req.method === 'POST' && p === '/api/diagnostics') {
    return writeDiagnosticsSnapshot('api-post').then((snapshot) => json(res, 200, { ok: true, file: DIAGNOSTICS_FILE, diagnostics: snapshot }));
  }

  if (req.method === 'GET' && p === '/api/accounts') {
    // 面板打开即自动对全部账号签到（带每日缓存，幂等，不阻塞响应）
    // checkinStatus=1 仅回读缓存和队列状态，不重复触发一轮签到，供面板轮询使用。
    if (url.searchParams.get('checkinStatus') !== '1') {
      claimDailyForAll().catch((e) => log('[checkin] 自动签到失败: ' + e.message));
    }
    const accounts = listAccounts(DATA_DIR);
    const cache = loadCheckinCache();
    const today = todayStr();
    const checkinPending = !!claimInFlight;
    return CREDIT_USAGE_STORE.listDailyCheckins(accounts.map((a) => a.uid), today)
      .catch((error) => {
        log('[checkin] 读取 SQLite 标记失败: ' + error.message);
        return {};
      })
      .then((dbCheckins) => {
        const enriched = accounts.map((a) => {
          const c = dbCheckins[a.uid] || cache[a.uid];
          const checked = c && c.ok && (c.verified === true || classifyCheckinResult({ httpOk: true, code: c.code, message: c.message }).ok)
            ? c
            : null;
          return Object.assign({}, a, {
            checkin: checkinDisplayValue(checked, today, checkinPending),
          });
        });
        return listDailyUsage(enriched, today)
          .then((summaries) => {
            const withUsage = enriched.map((account) => summaries[account.uid]
              ? Object.assign({}, account, { todayUsage: summaries[account.uid] })
              : account);
            return json(res, 200, { ok: true, current: currentAccount(), accounts: withUsage, checkin: checkinSnapshot() });
          })
          .catch((error) => {
            log('[credits-usage] 读取本地今日用量失败: ' + error.message);
            return json(res, 200, { ok: true, current: currentAccount(), accounts: enriched, checkin: checkinSnapshot() });
          });
      });
  }

  // 查询指定账号的剩余积分（v2 全量资源 Account 汇总）
  if (req.method === 'POST' && p === '/api/credits') {
    return readBody(req).then(async (body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const file = path.join(DATA_DIR, 'accounts', `${uid}.info`);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '账号备份不存在' });
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tk = j.auth && j.auth.accessToken;
        if (!tk) return json(res, 400, { ok: false, error: '备份中无 accessToken' });
        const current = currentAccount();
        const shouldSyncUsage = !!(current && current.uid === uid);
        const usagePromise = shouldSyncUsage
          ? syncCurrentCreditUsage(uid, tk)
            .then((value) => ({ synced: true, value }))
            .catch((error) => {
              log('[credits-usage] 当前账号增量同步失败: ' + error.message);
              return { synced: false };
            })
          : Promise.resolve({ synced: false });
        const [r, usage] = await Promise.all([fetchCredits(tk, j.account), usagePromise]);
        const payload = {
          ok: true,
          uid,
          credits: r.credits,
          count: r.count,
          totalDosage: r.totalDosage,
          meterCredits: r.meterCredits,
          packageCredits: r.packageCredits,
          meterError: r.meterError,
          packageError: r.packageError,
          segments: r.segments,
          unlimited: !!r.unlimited,
          cycleResetTime: r.cycleResetTime || null,
        };
        if (usage.synced) payload.todayUsage = usage.value;
        return json(res, 200, payload);
      } catch (e) {
        log(`[credits] 查询 ${uid} 积分失败: ${e.message}`);
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 查询指定账号今日是否活跃（成长中心热力墙 is_active）
  if (req.method === 'POST' && p === '/api/growth/today-active') {
    return readBody(req).then(async (body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const file = path.join(DATA_DIR, 'accounts', `${uid}.info`);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '账号备份不存在' });
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tk = j.auth && j.auth.accessToken;
        if (!tk) return json(res, 400, { ok: false, error: '备份中无 accessToken' });
        const today = await fetchGrowthTodayActive(tk, { apiHost: PROFILE.apiHost });
        return json(res, 200, { ok: true, uid, ...today });
      } catch (e) {
        log(`[growth] 查询 ${uid} 今日活跃失败: ${e.message}`);
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 导出账号：密码必填；v2 使用随机 salt，密码只在本次请求内存在
  if (req.method === 'POST' && p === '/api/accounts/export') {
    return readBody(req).then((body) => {
      try {
        const enteredPassword = body && typeof body.password === 'string' ? body.password : '';
        const password = requiredPassword(enteredPassword);
        let selectedUids = null;
        if (body && body.uids !== undefined) {
          if (!Array.isArray(body.uids)) return json(res, 400, { ok: false, error: '账号选择必须是数组' });
          if (body.uids.length > 500) return json(res, 400, { ok: false, error: '选择的账号过多' });
          selectedUids = new Set(body.uids.map((uid) => String(uid || '').trim()).filter(Boolean));
          if (!selectedUids.size) return json(res, 400, { ok: false, error: '请至少选择一个账号' });
        }
        const accounts = listAccounts(DATA_DIR).filter((account) => !selectedUids || selectedUids.has(String(account.uid)));
        const items = [];
        for (const a of accounts) {
          const file = backupPath(DATA_DIR, a.uid);
          if (!fs.existsSync(file)) continue;
          try {
            const raw = fs.readFileSync(file, 'utf8');
            JSON.parse(raw); // 跳过损坏备份
            items.push({ uid: a.uid, info: raw });
          } catch (_) { /* 跳过 */ }
        }
        if (!items.length) return json(res, 200, { ok: false, error: '没有可导出的账号备份' });
        const payload = { exportType: 'WorkDaddy-accounts', version: 2, accounts: items };
        const envelope = createEncryptedExport('accounts', payload, password);
        const filename = 'WorkDaddy-账号导出-' + new Date().toISOString().slice(0, 10) + '.json';
        log(`[export] 导出 ${items.length} 个账号 -> ${filename}`);
        return json(res, 200, { ok: true, filename, content: envelope, count: items.length });
      } catch (e) {
        log(`[export] 导出失败: ${e.message}`);
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 导入账号：v2 必须输入密码；历史 v1 文件密码可留空（默认 workdaddy）
  if (req.method === 'POST' && p === '/api/accounts/import') {
    return readBody(req).then((body) => {
      try {
        let text = '';
        if (typeof body === 'string') text = body;
        else if (body && typeof body.content === 'string') text = body.content;
        else if (body && typeof body.data === 'string') text = body.data;
        if (!text) throw new Error('未读取到有效内容，请选择导出文件');
        let envelope;
        try { envelope = JSON.parse(text); } catch (_) { throw new Error('文件不是有效的导出 JSON'); }
        if (!envelope || envelope.wbsExport !== 'WorkDaddy') throw new Error('不是 WorkDaddy 的账号导出文件');
        const enteredPassword = body && typeof body.password === 'string' ? body.password : '';
        const password = enteredPassword.trim() ? enteredPassword : '';
        if (password.length > 1024) throw new Error('密码不能超过 1024 个字符');
        let payload;
        if (Number(envelope.version) >= 2) {
          payload = openEncryptedExport(text, 'accounts', password);
        } else {
          payload = JSON.parse(decryptLegacyExport(envelope.data, password || EXPORT_PASSPHRASE));
        }
        const list = Array.isArray(payload && payload.accounts) ? payload.accounts : [];
        if (!list.length) throw new Error('导入文件中没有账号数据');
        ensureDirs(DATA_DIR);
        const imported = [];
        for (const item of list) {
          const uid = String(item && item.uid || '').trim();
          const info = item && item.info;
          // 导出文件属于用户输入；UID 只能是账号文件名的一段，禁止路径分隔符和
          // 特殊目录名，避免导入请求把认证内容写到 accounts 目录之外。
          if (!uid || uid.length > 200 || uid === '.' || uid === '..' || /[\\/\0]/.test(uid) || typeof info !== 'string') continue;
          let j;
          try { j = JSON.parse(info); } catch (_) { continue; }
          const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
          if (!acct || !acct.uid || String(acct.uid) !== uid) continue; // 安全校验：uid 必须匹配
          const dest = backupPath(DATA_DIR, uid);
          const tmp = dest + '.tmp';
          fs.writeFileSync(tmp, info, { mode: 0o600 });
          fs.renameSync(tmp, dest);
          try { fs.chmodSync(dest, 0o600); } catch (_) {}
          updateMeta(DATA_DIR, {
            uid,
            nickname: acct.nickname || '',
            uin: acct.uin || '',
            phone: acct.phoneNumber || '',
          });
          imported.push(uid);
        }
        log(`[import] 成功导入 ${imported.length}/${list.length} 个账号`);
        return json(res, 200, { ok: true, imported, count: imported.length });
      } catch (e) {
        log(`[import] 导入失败: ${e.message}`);
        return json(res, 200, { ok: false, error: e.message });
      }
    });
  }

  // 清空输入框（点暂存按钮入队成功后调用）：CDP 真实键盘事件，安全清空 Slate 编辑器
  if (req.method === 'POST' && p === '/api/clear-composer') {
    return clearComposerByCdp()
      .then((info) => json(res, 200, { ok: true, ...info }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  // 主题列表（内置 + 用户自定义）
  if (req.method === 'GET' && p === '/api/themes') {
    try {
      const current = fs.existsSync(path.join(DATA_DIR, 'current-theme.json'))
        ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id
        : 'default';
      return json(res, 200, { ok: true, themes: listThemes(), current });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 官方背景图库列表（themes/wallpapers/*.webp），供面板「主题」页预览切换。
  // 附带 currentWallpaper：当前主题 background.webp 内容哈希匹配到的图库文件名（供面板高亮当前壁纸）
  // 附带 customWallpapers：用户上传的自定义壁纸（custom-*.webp），供面板分开展示
  if (req.method === 'GET' && p === '/api/wallpapers') {
    try {
      const files = fs.existsSync(WALLPAPERS_DIR)
        ? fs.readdirSync(WALLPAPERS_DIR).filter((f) => /\.webp$/i.test(f)).sort()
        : [];
      const official = files.filter((f) => !/^custom-/i.test(f));
      const custom = files.filter((f) => /^custom-/i.test(f));
      // 当前背景 = 当前主题目录的 background.webp（哈希对比图库）
      let currentWallpaper = null;
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id || '';
        const bg = path.join(THEMES_DIR, String(cur).replace(/[^A-Za-z0-9_-]/g, '_'), 'background.webp');
        if (fs.existsSync(bg)) {
          const crypto = require('crypto');
          const want = crypto.createHash('md5').update(fs.readFileSync(bg)).digest('hex');
          for (const f of files) {
            const p2 = path.join(WALLPAPERS_DIR, f);
            if (crypto.createHash('md5').update(fs.readFileSync(p2)).digest('hex') === want) { currentWallpaper = f; break; }
          }
        }
      } catch (_) {}
      return json(res, 200, {
        ok: true,
        wallpapers: official.map((f) => ({ name: f, title: '官方壁纸 ' + String(f.replace(/\.webp$/i, '')).replace(/^wallpaper-?0*/, '') })),
        customWallpapers: custom.map((f) => ({ name: f, title: '自定义壁纸 ' + String(f.replace(/\.webp$/i, '')).replace(/^custom-/, '') })),
        currentWallpaper,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 自定义壁纸管理（themes/wallpapers/custom-*.webp）：
  // GET  /api/custom-wallpapers —— 列表（冗余，主要随 /api/wallpapers 返回）
  // POST /api/custom-wallpapers —— 上传 body.dataUrl（base64），保存为 custom-<时间戳>.webp 并返回 name
  // DELETE /api/custom-wallpapers?name=x —— 删除指定自定义壁纸文件（仅 custom- 前缀，防误删官方壁纸）
  if (req.method === 'GET' && p === '/api/custom-wallpapers') {
    try {
      const files = fs.existsSync(WALLPAPERS_DIR)
        ? fs.readdirSync(WALLPAPERS_DIR).filter((f) => /^custom-[A-Za-z0-9_.-]+\.webp$/i.test(f)).sort()
        : [];
      return json(res, 200, { ok: true, wallpapers: files.map((f) => ({ name: f, title: '自定义壁纸 ' + String(f.replace(/\.webp$/i, '')).replace(/^custom-/, '') })) });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (req.method === 'POST' && p === '/api/custom-wallpapers') {
    return readBody(req).then((body) => {
      try {
        const dataUrl = String(body.dataUrl || '');
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
        if (!m) return json(res, 400, { ok: false, error: '图片必须是 PNG/JPEG/WebP base64' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 10 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片不能超过 10MB' });
        fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
        const name = 'custom-' + Date.now().toString(36) + '.webp';
        fs.writeFileSync(path.join(WALLPAPERS_DIR, name), buf);
        log(`[theme] 上传自定义壁纸 -> ${name} (${buf.length}B)`);
        return json(res, 200, { ok: true, name });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'DELETE' && p === '/api/custom-wallpapers') {
    try {
      const raw = String(req.url.split('?')[1] || '');
      const name = decodeURIComponent(/name=([^&]+)/.exec(raw) ? RegExp.$1 : '');
      if (!/^custom-[A-Za-z0-9_.-]+\.webp$/i.test(name)) return json(res, 400, { ok: false, error: '仅支持删除自定义壁纸（custom-*.webp）' });
      const file = path.join(WALLPAPERS_DIR, name);
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '壁纸不存在: ' + name });
      fs.unlinkSync(file);
      log('[theme] 删除自定义壁纸 -> ' + name);
      return json(res, 200, { ok: true, name });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 背景图全局蒙版透明度（0~1，默认 0.1）：GET 读取、POST 保存并重应用当前主题
  if (req.method === 'GET' && p === '/api/mask') {
    try {
      const f = path.join(DATA_DIR, 'mask.json');
      let opacity = 0.1;
      if (fs.existsSync(f)) {
        const v = parseFloat(JSON.parse(fs.readFileSync(f, 'utf8')).opacity);
        if (!Number.isNaN(v)) opacity = Math.min(1, Math.max(0, v));
      }
      return json(res, 200, { ok: true, opacity });
    } catch (e) {
      return json(res, 200, { ok: true, opacity: 0.1 });
    }
  }
  if (req.method === 'POST' && p === '/api/mask') {
    return readBody(req).then((body) => {
      try {
        const opacity = Math.min(1, Math.max(0, parseFloat(body.opacity)));
        if (Number.isNaN(opacity)) return json(res, 400, { ok: false, error: 'opacity 必须是数字' });
        fs.writeFileSync(path.join(DATA_DIR, 'mask.json'), JSON.stringify({ opacity }, null, 2));
        log('[theme] 背景蒙版透明度 -> ' + opacity);
        // 重应用当前主题使蒙版生效
        const cur = fs.existsSync(path.join(DATA_DIR, 'current-theme.json'))
          ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id
          : 'default';
        if (cur === 'default') return json(res, 200, { ok: true, opacity });
        return applyThemeByCdp(cur)
          .then((info) => json(res, 200, { ok: true, opacity, applied: info.ok }))
          .catch((e) => json(res, 500, { ok: false, error: '蒙版已保存但应用失败: ' + e.message }));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 电脑休眠控制：GET/POST /api/sleep-mode（三模式 allow/keep/until-done + 显示器开关）+ POST /api/sleep-now（立即休眠）
  if (req.method === 'GET' && p === '/api/sleep-mode') {
    let st = { mode: 'allow', displaySleep: false };
    try { st = Object.assign(st, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sleep-mode.json'), 'utf8'))); } catch (_) {}
    return json(res, 200, { ok: true, mode: st.mode, displaySleep: !!st.displaySleep, preventing: st.mode === 'keep' || st.mode === 'until-done', active: !!sleepCaffeinate, antiLock: !!sleepUserActivityTimer });
  }
  if (req.method === 'POST' && p === '/api/sleep-mode') {
    return readBody(req).then((body) => {
      try {
        const mode = body.mode === 'keep' || body.mode === 'until-done' ? body.mode : 'allow';
        const displaySleep = !!body.displaySleep;
        if (!applySleepMode(mode, displaySleep)) return json(res, 500, { ok: false, error: 'caffeinate 启动失败' });
        fs.writeFileSync(path.join(DATA_DIR, 'sleep-mode.json'), JSON.stringify({ mode, displaySleep }, null, 2));
        return json(res, 200, { ok: true, mode, displaySleep, preventing: mode === 'keep' || mode === 'until-done' });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    });
  }
  if (req.method === 'POST' && p === '/api/sleep-now') {
    return sleepNow() ? json(res, 200, { ok: true }) : json(res, 500, { ok: false, error: '立即休眠失败' });
  }

  // 会话列表：GET /api/sessions?uid=<账号uid>&range=today|7d|30d|all（uid 缺省=当前账号；uid=空=全部账号）
  if (req.method === 'GET' && p === '/api/sessions') {
    const uidParam = url.searchParams.get('uid');
    const uid = uidParam === null ? (((currentAccount() || {}).uid || '').trim()) : uidParam.trim();
    const range = url.searchParams.get('range') || '7d';
    const rangeMs = sessionRangeMs(range);
    const clauses = ["deleted_at IS NULL"];
    const params = [];
    if (uid) { clauses.push('user_id = ?'); params.push(uid); }
    if (rangeMs) { clauses.push('COALESCE(last_activity_at, updated_at, created_at) >= ?'); params.push(rangeMs); }
    // 时间筛选和排序按最近活动/修改时间；旧记录缺字段时回退到创建时间。
    return sqliteQuery("SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, project_id FROM sessions WHERE " + clauses.join(' AND ') + " ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC, created_at DESC;", params)
      .then((rows) => {
        const rulesByUid = {};
        rows.forEach((row) => {
          const owner = String(row.user_id || '').trim();
          if (!owner || rulesByUid[owner]) return;
          const rules = getAutoCopyRules(DATA_DIR, owner);
          rulesByUid[owner] = { sessions: new Set(rules.sessionIds), workspaces: new Set(rules.workspaces) };
        });
        const sessions = rows.map((row) => {
          const rules = rulesByUid[String(row.user_id || '').trim()] || { sessions: new Set(), workspaces: new Set() };
          return Object.assign({}, row, {
            autoCopySession: rules.sessions.has(String(row.id)),
            autoCopyWorkspace: rules.workspaces.has(canonicalWorkspace(row.cwd)),
          });
        });
        const currentRules = uid
          ? (rulesByUid[uid] || (() => {
              const rules = getAutoCopyRules(DATA_DIR, uid);
              return { sessions: new Set(rules.sessionIds), workspaces: new Set(rules.workspaces) };
            })())
          : null;
        return json(res, 200, {
          ok: true,
          sessions,
          count: sessions.length,
          uid,
          range,
          autoCopy: currentRules ? { sessionIds: Array.from(currentRules.sessions), workspaces: Array.from(currentRules.workspaces) } : null,
        });
      })
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }
  // 会话空间列表：GET /api/sessions/workspaces
  if (req.method === 'GET' && p === '/api/sessions/workspaces') {
      return sqliteQuery("SELECT DISTINCT cwd FROM sessions WHERE deleted_at IS NULL AND cwd IS NOT NULL AND cwd != '' ORDER BY cwd;")
      .then((rows) => json(res, 200, { ok: true, workspaces: rows.map((r) => r.cwd) }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }
  // 模型连通测试：只返回网络/HTTP 状态，不记录或回传 URL 查询参数、API Key 等敏感内容。
  // 大多数 OpenAI 兼容服务的根路径不响应（404），因此按候选顺序探测真实端点：
  //   {base}/models → {base}/v1/models（base 未带版本前缀时）→ base 本身。
  // 2xx/3xx/401/403/400/405 视为端点真实命中并立即返回；404/5xx/网络错误则继续尝试下一个候选。
  async function probeModelEndpoint(model) {
    // url 可能是完整端点（.../v1/chat/completions），先规约到 base 再按候选探测
    let base = String(model && model.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new Error('模型 URL 仅支持 http/https');
    if (/\/chat\/completions$/i.test(base)) base = base.replace(/\/chat\/completions$/i, '');
    const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'WorkDaddy probe/1.0' };
    if (model.apiKey) headers.Authorization = 'Bearer ' + String(model.apiKey);
    const candidates = [base + '/models'];
    if (!/\/v\d+$/i.test(base)) candidates.push(base + '/v1/models');
    candidates.push(base);
    let lastStatus = 0;
    let lastError = '';
    for (const target of candidates) {
      let response = null;
      try {
        response = await fetch(target, { method: 'HEAD', headers, redirect: 'manual', signal: AbortSignal.timeout(6000) });
        if (response.status === 405 || response.status === 501) {
          response = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(6000) });
        }
      } catch (e) {
        lastError = (e && e.message) || String(e);
        continue;
      }
      const status = response.status;
      lastStatus = status;
      if (status === 404) continue; // 路径不存在：尝试下一个候选
      if (status >= 200 && status < 500) {
        return {
          status,
          reachable: true,
          authorized: status >= 200 && status < 300,
          message: status >= 200 && status < 300
            ? '接口可用'
            : (status === 401 || status === 403 ? '接口可达，但 API Key 可能无效' : `接口返回 HTTP ${status}`),
        };
      }
    }
    const message = lastStatus ? `接口返回 HTTP ${lastStatus}` : (lastError ? `请求失败：${lastError}` : '无法连接模型服务');
    return { status: lastStatus, reachable: false, authorized: false, message };
  }

  // 模型管理：列表返回供模型页 UI 展示的摘要（apiKey 明文，供 cell/编辑弹窗直接展示；
  // 仅本机 loopback 服务，不写日志、不上传）。备份文件保留完整配置，参考 docs 下工作流说明。
  if (req.method === 'GET' && p === '/api/models') {
    let official = [];
    let officialError = null;
    try {
      official = listOfficialModels();
    } catch (e) {
      officialError = e.message;
    }
    return json(res, 200, { ok: true, file: workbuddyModelsFile(), official, officialError, backups: listModelBackups(DATA_DIR), imports: listInstalledModelSources(PROFILE.id) });
  }
  if (req.method === 'POST' && p === '/api/models/import') {
    return readBody(req).then((body) => {
      try {
        const profileId = String((body && body.profileId) || '').trim();
        const source = listInstalledModelSources(PROFILE.id).find((item) => item.profileId === profileId);
        if (profileId === PROFILE.id) return json(res, 400, { ok: false, error: '不能从当前客户端导入模型' });
        if (!source) return json(res, 404, { ok: false, error: '未找到可导入的客户端模型配置' });
        // 两个 WorkBuddy 桌面端共用同一 models.json：配置天然互通，无需导入
        if (source.shared) return json(res, 200, { ok: true, shared: true, imported: [], skipped: [] });
        if (!source.available) return json(res, 404, { ok: false, error: `未找到 ${source.name} 的模型配置文件` });
        const result = importModels(workbuddyModelsFile(), source.modelsFile);
        return json(res, 200, { ok: true, imported: result.imported, skipped: result.skipped, official: result.official });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message || String(e) });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/backup') {
    return readBody(req).then((body) => {
      try {
        const backup = backupOfficialModel(DATA_DIR, body && body.index);
        return json(res, 200, { ok: true, backup });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/delete-official') {
    return readBody(req).then((body) => {
      try {
        const indexes = Array.isArray(body && body.indexes) ? body.indexes : [];
        const result = deleteOfficialModels(workbuddyModelsFile(), indexes);
        return json(res, 200, { ok: true, deleted: result.deleted, official: result.official, backups: listModelBackups(DATA_DIR) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/test') {
    return readBody(req).then(async (body) => {
      try {
        const index = Number(body && body.index);
        const model = readOfficialModel(workbuddyModelsFile(), index);
        const result = await probeModelEndpoint(model);
        return json(res, 200, { ok: true, result });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/copy') {
    return readBody(req).then((body) => {
      try {
        const backupId = String((body && body.backupId) || '');
        if (!backupId) return json(res, 400, { ok: false, error: '缺少模型备份标识' });
        const copied = copyModelBackup(DATA_DIR, backupId);
        return json(res, 200, { ok: true, copied, backups: listModelBackups(DATA_DIR) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/edit') {
    return readBody(req).then((body) => {
      try {
        const backupId = String((body && body.backupId) || '');
        if (!backupId) return json(res, 400, { ok: false, error: '缺少模型备份标识' });
        const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : {};
        const edited = editModelBackup(DATA_DIR, backupId, patch);
        return json(res, 200, { ok: true, edited, backups: listModelBackups(DATA_DIR) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/delete') {
    return readBody(req).then((body) => {
      try {
        const ids = Array.isArray(body && body.backupIds) ? body.backupIds : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '未选择模型备份' });
        const deleted = deleteModelBackups(DATA_DIR, ids);
        return json(res, 200, { ok: true, requested: ids.length, deleted, backups: listModelBackups(DATA_DIR) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  if (req.method === 'POST' && p === '/api/models/enable') {
    return readBody(req).then((body) => {
      try {
        const backupId = String((body && body.backupId) || '');
        if (!backupId) return json(res, 400, { ok: false, error: '缺少模型备份标识' });
        const enabled = enableModelBackup(DATA_DIR, backupId);
        return json(res, 200, { ok: true, enabled, official: listOfficialModels(), backups: listModelBackups(DATA_DIR) });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  // 自动复制规则：POST /api/sessions/auto-copy { uid, kind: session|workspace, key, enabled }
  if (req.method === 'POST' && p === '/api/sessions/auto-copy') {
    return readBody(req).then(async (body) => {
      try {
        const uid = String(body.uid || '').trim();
        const kind = body.kind === 'workspace' ? 'workspace' : 'session';
        const key = String(body.key || '').trim();
        if (!uid || !key) return json(res, 400, { ok: false, error: '缺少自动复制规则参数' });
        if (kind === 'session') {
          const rows = await sqliteQuery(
            'SELECT user_id FROM sessions WHERE id = ? AND deleted_at IS NULL LIMIT 1;',
            [key]
          );
          if (!rows.length || String(rows[0].user_id || '') !== uid) return json(res, 404, { ok: false, error: '会话不存在或不属于该账号' });
        }
        const rules = setAutoCopyRule(DATA_DIR, { uid, kind, key, enabled: body.enabled !== false });
        return json(res, 200, { ok: true, uid, kind, key: kind === 'workspace' ? canonicalWorkspace(key) : key, rules });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    });
  }
  // 自动复制任务状态：GET /api/sessions/auto-copy/status?id=<jobId>
  if (req.method === 'GET' && p === '/api/sessions/auto-copy/status') {
    const job = autoCopyJobs.get(url.searchParams.get('id') || '');
    return job ? json(res, 200, { ok: true, job: publicAutoCopyJob(job) }) : json(res, 404, { ok: false, error: '自动复制任务不存在' });
  }
  // 加密导出会话及其受管消息附件：POST /api/sessions/export { ids, password }
  if (req.method === 'POST' && p === '/api/sessions/export') {
    return readBody(req).then(async (body) => {
      try {
        const result = await exportSessions(body && body.ids, body && body.password);
        log(`[sessions-export] 已导出 ${result.count} 个会话`);
        return json(res, 200, { ok: true, ...result });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    });
  }
  // 加密导入会话；targetUid 缺省时保留归档中的账号归属。
  if (req.method === 'POST' && p === '/api/sessions/import') {
    return readBody(req).then(async (body) => {
      try {
        const result = await importSessions(body && body.content, body && body.password, body && body.targetUid);
        log(`[sessions-import] 已导入 ${result.imported.length} 个会话，失败 ${result.failed} 个`);
        let reloaded = false;
        try {
          await reloadWorkBuddyPage();
          reloaded = true;
          log('[sessions-import] 已通过 CDP 刷新 WorkBuddy 窗口');
        } catch (reloadError) {
          log(`[sessions-import] CDP 刷新失败: ${reloadError.message}`);
        }
        return json(res, 200, { ok: true, count: result.imported.length, imported: result.imported, failed: result.failed, reloaded });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
    });
  }
  // 复制会话：POST /api/sessions/copy { ids, targetUid }（保留原会话，复制记录+消息文件到目标账号）
  if (req.method === 'POST' && p === '/api/sessions/copy') {
    return readBody(req).then(async (body) => {
      let ids;
      try { ids = normalizeSessionIdBatch(body && body.ids); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const targetUid = (body.targetUid || '').trim();
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      if (!targetUid) return json(res, 400, { ok: false, error: '未指定目标账号' });
      try {
        // 1) 取出源会话（含 cwd 用于定位消息文件）
        const srcRows = await sqliteQuery(
          "SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, source_mode, is_background_automation, mode, model, expert_id, expert_locale, expert_runtime_identity, expert_marketplace, permission_mode, use_sandbox_cli, project_id FROM sessions WHERE id IN (" + sqlPlaceholders(ids) + ") AND deleted_at IS NULL;",
          ids
        );
        if (!srcRows.length) return json(res, 404, { ok: false, error: '源会话不存在' });
        let copied = 0;
        for (const src of srcRows) {
          await copySessionRecord(src, targetUid);
          copied++;
        }
        return json(res, 200, { ok: true, copied, targetUid });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 迁移会话：POST /api/sessions/migrate { ids, targetUid }
  if (req.method === 'POST' && p === '/api/sessions/migrate') {
    return readBody(req).then(async (body) => {
      let ids;
      try { ids = normalizeSessionIdBatch(body && body.ids); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const targetUid = (body.targetUid || '').trim();
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      if (!targetUid) return json(res, 400, { ok: false, error: '未指定目标账号' });
      try {
        const placeholders = sqlPlaceholders(ids);
        const before = await sqliteQuery(
          'SELECT id, user_id FROM sessions WHERE id IN (' + placeholders + ') AND deleted_at IS NULL;',
          ids
        );
        await sqliteRun(
          "UPDATE sessions SET user_id = ?, updated_at = ? WHERE id IN (" + placeholders + ");",
          [targetUid, Date.now(), ...ids]
        );
        let rulesMoved = 0;
        for (const row of before) {
          if (String(row.user_id || '') === targetUid) continue;
          try {
            if (moveAutoCopySession(DATA_DIR, row.user_id, targetUid, row.id)) rulesMoved++;
          } catch (e) {
            // The DB move is complete; surface rule maintenance separately so it can be retried.
            log(`[sessions-auto-copy] 迁移规则 ${row.id} 失败: ${e.message}`);
          }
        }
        return json(res, 200, { ok: true, moved: before.length, requested: ids.length, targetUid, rulesMoved });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 删除会话（真实删除）：POST /api/sessions/delete { ids }——删除 DB 记录 + 该账号下全部会话文件（不可恢复）
  if (req.method === 'POST' && p === '/api/sessions/delete') {
    return readBody(req).then(async (body) => {
      let ids;
      try { ids = normalizeSessionIdBatch(body && body.ids); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      if (!ids.every(isValidSessionId)) return json(res, 400, { ok: false, error: '包含无效的会话 ID' });
      try {
        const placeholders = sqlPlaceholders(ids);
        const before = await sqliteQuery('SELECT id, user_id FROM sessions WHERE id IN (' + placeholders + ');', ids);
        const matchedIds = matchedSessionIds(ids, before);
        const matchedSet = new Set(matchedIds);
        const matchedRows = before.filter((row) => matchedSet.has(String(row.id || '')));
        // 1) 先完成可重试的文件与规则清理；失败时保留 DB 记录作为重试锚点。
        const wbHome = PROFILE.dataRoot;
        let filesRemoved = 0;
        for (const id of matchedIds) filesRemoved += deleteSessionFiles(wbHome, id);
        let rulesRemoved = 0;
        for (const row of matchedRows) {
          try {
            if (removeAutoCopySession(DATA_DIR, row.user_id, row.id)) rulesRemoved++;
          } catch (e) {
            log(`[sessions-auto-copy] 删除规则 ${row.id} 失败: ${e.message}`);
            throw e;
          }
        }
        // 2) 最后真实删除 DB 记录（非软删）。若此步失败，重复请求可安全重试。
        if (matchedIds.length) {
          await sqliteRun(
            "DELETE FROM sessions WHERE id IN (" + sqlPlaceholders(matchedIds) + ");",
            matchedIds
          );
        }
        log(`[sessions-delete] 已真实删除 ${matchedIds.length} 个会话（DB + ${filesRemoved} 项文件）`);
        return json(res, 200, { ok: true, deleted: matchedIds.length, requested: ids.length, filesRemoved, rulesRemoved });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 恢复会话：POST /api/sessions/restore { ids }
  if (req.method === 'POST' && p === '/api/sessions/restore') {
    return readBody(req).then((body) => {
      let ids;
      try { ids = normalizeSessionIdBatch(body && body.ids); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      return sqliteRun(
        "UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE id IN (" + sqlPlaceholders(ids) + ");",
        [Date.now(), ...ids]
      )
        .then(() => json(res, 200, { ok: true, restored: ids.length }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }));
    });
  }

  // 打开 WorkBuddy 的 Chrome DevTools（绕开 chrome://inspect 404 + Electron CDP 拒绝带 Origin 的 WS）
  // 前端页面从 9222 加载，ws 通过 daemon 代理（/devtools-proxy/<id>）中转去 Origin
  // 注意：必须 return Promise 立即返回，避免同步函数继续执行到 404 分支
  if (req.method === 'GET' && p === '/api/devtools-url') {
    return new Promise((resolve) => {
      const httpMod = require('http');
      const devtoolsPort = cdp.port || readCdpPortFile() || CDP_PORT_HINT || 9222;
      httpMod.get('http://127.0.0.1:' + devtoolsPort + '/json/list', (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            const list = JSON.parse(d);
            const page = list.find(isWorkBuddyCdpTarget);
            const id = page && page.id;
            if (!id) return resolve(json(res, 500, { ok: false, error: '未找到 WorkBuddy 页面 target' }));
            if (!wsLib) return resolve(json(res, 500, { ok: false, error: 'ws 代理库未加载，无法打开 DevTools' }));
            const url = 'http://127.0.0.1:' + devtoolsPort + '/devtools/inspector.html?ws=127.0.0.1:' + ACTUAL_PORT + '/devtools-proxy/' + id;
            resolve(json(res, 200, { ok: true, url }));
          } catch (e) {
            resolve(json(res, 500, { ok: false, error: e.message }));
          }
        });
      }).on('error', (e) => resolve(json(res, 500, { ok: false, error: 'CDP 端口不可达: ' + e.message })));
    });
  }

  // 应用主题（CDP 注入 CSS 变量覆盖）
  if (req.method === 'POST' && p === '/api/theme-apply') {
    return readBody(req).then((body) => {
      const id = (body.id || 'default') + '';
      if (id !== 'default' && !getTheme(id)) return json(res, 404, { ok: false, error: '主题不存在: ' + id });
      return applyThemeByCdp(id)
        .then((info) => {
          try {
            fs.writeFileSync(path.join(DATA_DIR, 'current-theme.json'), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
          } catch (error) {
            log('[theme] 保存当前主题失败: ' + error.message);
          }
          return json(res, 200, { ok: true, ...info, id });
        })
        .catch((e) => {
          log('[theme] API 应用失败: ' + e.message);
          return json(res, 500, { ok: false, error: e.message });
        });
    });
  }

  // 保存自定义主题（用户上传/导入）
  if (req.method === 'POST' && p === '/api/theme-save') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_') || ('custom-' + Date.now());
        const theme = {
          id,
          name: String(body.name || id),
          author: String(body.author || 'unknown'),
          dark: !!body.dark,
          colors: body.colors || {},
        };
        if (body.image) theme.image = String(body.image);
        if (body.appearance) theme.appearance = String(body.appearance);
        if (!theme.colors || typeof theme.colors !== 'object' || !Object.keys(theme.colors).length) {
          return json(res, 400, { ok: false, error: 'colors 不能为空' });
        }
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, id + '.json'), JSON.stringify(theme, null, 2));
        log('[theme] 保存自定义主题 -> ' + id);
        return json(res, 200, { ok: true, id });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 上传主题背景图：multipart 或 JSON base64（dataURL），保存到 themes/<id>/<image>
  if (req.method === 'POST' && p === '/api/theme-image') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const dataUrl = String(body.dataUrl || '');
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
        if (!m) return json(res, 400, { ok: false, error: '图片必须是 PNG/JPEG/WebP base64' });
        const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 10 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片不能超过 10MB' });
        const dir = path.join(THEMES_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        const imageName = 'background.' + ext;
        fs.writeFileSync(path.join(dir, imageName), buf);
        log('[theme] 保存背景图 -> ' + id + '/' + imageName + ' (' + buf.length + 'B)');
        return json(res, 200, { ok: true, image: imageName });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 替换主题背景图（保持主题配色不变）：存 background.webp + 更新 theme.json image 字段 +
  // 设 current 并立即应用。用于面板「图片」按钮——用户换背景图不生成新主题，reload 后恢复的就是新图。
  // 支持三种来源：body.dataUrl（用户上传 base64）/ body.wallpaper（官方图库文件名，从 wallpapers 目录复制）/
  //             body.custom（自定义壁纸文件名，从 wallpapers/custom-* 复制）
  // 注意：CDP 未连接时应用主题会失败，但文件与 current-theme.json 已保存——此时仍返回成功，
  //       由 restoreSavedTheme 在连接恢复后自动应用，避免"背景图已保存但应用失败"的报错困扰用户。
  if (req.method === 'POST' && p === '/api/theme-bg') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        let buf = null;
        const wpName = String(body.wallpaper || '');
        const customName = String(body.custom || '');
        if (wpName) {
          // 官方图库：从 wallpapers 目录读取（防路径穿越：只允许纯文件名）
          const safeName = path.basename(wpName).replace(/[^A-Za-z0-9._-]/g, '_');
          const src = path.join(WALLPAPERS_DIR, safeName);
          if (!fs.existsSync(src)) return json(res, 400, { ok: false, error: '壁纸不存在: ' + safeName });
          buf = fs.readFileSync(src);
        } else if (customName) {
          // 自定义壁纸：从 wallpapers/custom-* 读取（同样防路径穿越）
          const safeName = path.basename(customName).replace(/[^A-Za-z0-9._-]/g, '_');
          if (!/^custom-/i.test(safeName)) return json(res, 400, { ok: false, error: '壁纸不存在: ' + safeName });
          const src = path.join(WALLPAPERS_DIR, safeName);
          if (!fs.existsSync(src)) return json(res, 400, { ok: false, error: '壁纸不存在: ' + safeName });
          buf = fs.readFileSync(src);
        } else {
          const dataUrl = String(body.dataUrl || '');
          const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
          if (!m) return json(res, 400, { ok: false, error: '图片必须是 PNG/JPEG/WebP base64' });
          buf = Buffer.from(m[2], 'base64');
        }
        if (buf.length > 10 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片不能超过 10MB' });
        const dir = path.join(THEMES_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'background.webp'), buf);
        // 更新 theme.json 的 image 字段（保证 getTheme 能找到新图）
        const tf = path.join(dir, 'theme.json');
        if (fs.existsSync(tf)) {
          try {
            const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
            t.image = 'background.webp';
            fs.writeFileSync(tf, JSON.stringify(t, null, 2));
          } catch (_) {}
        }
        // 记录当前主题并应用（reload 后 1.5s 恢复的就是这张新图，不再"切回最早背景图"）
        try {
          fs.writeFileSync(path.join(DATA_DIR, 'current-theme.json'), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
        } catch (_) {}
        log('[theme] 替换背景图 -> ' + id + '/background.webp (' + buf.length + 'B)');
        // CDP 未连接/应用失败不再判为整体失败：文件已落盘，连接恢复后 restoreSavedTheme 会应用
        return applyThemeByCdp(id)
          .then((info) => json(res, 200, { ok: true, image: 'background.webp', applied: !!(info && info.ok), id }))
          .catch((e) => json(res, 200, { ok: true, image: 'background.webp', applied: false, pending: true, id, warn: '背景已保存，主题将在连接恢复后自动应用' }));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 当前账号 uid（轻量，不触发签到），供暂存等功能取用户标识
  if (req.method === 'GET' && (p === '/api/current' || p === '/api/current/')) {
    try {
      const c = currentAccount();
      return json(res, 200, { ok: true, uid: c ? c.uid : null });
    } catch (e) {
      return json(res, 200, { ok: true, uid: null });
    }
  }

  // 关于页：版本/许可/平台/原理/构建信息，面板「关于」tab 直接渲染
  if (req.method === 'GET' && (p === '/api/about' || p === '/api/about/')) {
    let build = { version: DAEMON_VERSION, commit: null, buildAt: null };
    try {
      const pjson = require('./package.json');
      // package.json 可能随 app 壳滞后于 daemon.js；关于页和升级结果必须展示实际运行代码版本。
      build.packageVersion = pjson.version || null;
      build.commit = process.env.WBSWITCH_GIT_COMMIT || null;
      build.buildAt = process.env.WBSWITCH_BUILD_AT || null;
    } catch (_) { /* 没有 package.json 时退回到 DAEMON_VERSION */ }
    let platform = { os: process.platform, arch: process.arch };
    let appVersion = null;
    try {
      const plist = require('./plist-reader.js') || null;
    } catch (_) { /* 可选依赖，缺失不影响 */ }
    try {
      const fsMod = require('fs');
      const plistPath = path.join(__dirname, '..', '..', 'Info.plist');
      if (fsMod.existsSync(plistPath)) {
        const buf = fsMod.readFileSync(plistPath, 'utf8');
        const m = buf.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
        if (m) appVersion = m[1];
      }
    } catch (_) { /* 解析失败忽略 */ }
    updateDebug('about-version', { daemonVersion: DAEMON_VERSION, packageVersion: build.packageVersion || null, appVersion, shownVersion: DAEMON_VERSION });
    return json(res, 200, {
      ok: true,
      name: WORKDADDY_INSTALL_NAME,
      tagline: PROFILE.name + ' 的多账号 · 主题 · 增强工具集',
      version: DAEMON_VERSION,
      appVersion: appVersion,
      license: 'AGPL-3.0',
      repository: 'https://github.com/babygoton/WorkDaddy',
      principle: '本机回环 CDP 注入 · 不改官方安装包',
      platform: IS_WIN ? 'Windows 10+（x64）' : 'macOS 11+',
      author: WORKDADDY_INSTALL_NAME,
      nodeVersion: process.version,
      ...platform,
      ...build,
    });
  }

  // 自动更新：检查（GET /api/update-check，force=1 强制刷新）→ 下载（POST /api/update-download）→ 状态（GET /api/update-status）→ 安装（POST /api/update-apply）
  if (req.method === 'GET' && p === '/api/update-check') {
    const force = url.searchParams.get('force') === '1';
    return Promise.resolve(checkUpdate(force)).then((st) =>
      json(res, 200, {
        ok: true,
        current: DAEMON_VERSION,
        latest: st.latest,
        hasUpdate: st.hasUpdate,
        dmgUrl: st.dmgUrl,
        dmgSize: st.dmgSize,
        assetName: st.assetName,
        notes: st.notes,
        message: st.message,
        error: st.error || null,
        checkedAt: st.checkedAt,
      })
    );
  }
  if (req.method === 'GET' && p === '/api/update-status') {
    const status = {
      ok: true,
      // 前端在 daemon 重启后通过版本变化结束等待；缺少该字段会永久停留在“重启中”。
      version: DAEMON_VERSION,
      daemonVersion: DAEMON_VERSION,
      buildId: DAEMON_BUILD_ID,
      status: updateState.status,
      progress: updateState.progress,
      message: updateState.message,
      error: updateState.error || null,
      latest: updateState.latest,
      hasUpdate: updateState.hasUpdate,
      downloaded: updateState.downloaded,
      downloadedBytes: updateState.downloadedBytes,
      totalBytes: updateState.totalBytes,
      downloadRate: updateState.downloadRate,
      etaSeconds: updateState.etaSeconds,
      attemptId: updateState.attemptId,
    };
    if (hasApiToken(req)) {
      status.applyLog = path.join(UPDATE_DIR, 'apply.log');
      status.debugLog = UPDATE_DEBUG_LOG;
    }
    return json(res, 200, status);
  }
  if (req.method === 'POST' && p === '/api/update-download') {
    updateState.error = null;
    downloadUpdate().then(() => {
      log('[update] 后台下载任务完成');
    }).catch((e) => {
      updateState.error = e.message;
      updateState.message = '下载失败';
    });
    return json(res, 202, {
      ok: true,
      started: true,
      status: updateState.status,
      progress: updateState.progress,
      downloadedBytes: updateState.downloadedBytes,
      totalBytes: updateState.totalBytes,
    });
  }
  if (req.method === 'POST' && p === '/api/update-apply') {
    return applyUpdate()
      .then((r) => json(res, 200, { ...r, attemptId: updateState.attemptId, applyLog: path.join(UPDATE_DIR, 'apply.log'), debugLog: UPDATE_DEBUG_LOG }))
      .catch((e) => json(res, 200, {
        ok: false,
        error: e.message,
        status: updateState.status,
        attemptId: updateState.attemptId,
        applyLog: path.join(UPDATE_DIR, 'apply.log'),
        debugLog: UPDATE_DEBUG_LOG,
      }));
  }

  // 暂存卡死诊断：注入脚本上报的面包屑/错误栈，仅写 daemon 日志（崩溃排查用）
  if (req.method === 'POST' && p === '/api/breadcrumb') {
    return readBody(req).then((body) => {
      try {
        if (!shouldPersistBreadcrumb(body)) return json(res, 200, { ok: true });
        const details = body.extra ? ' ' + redactDiagnosticText(JSON.stringify(body.extra), 1500) : '';
        log('[breadcrumb] ' + redactDiagnosticText(body.msg || '?', 500) + details);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 200, { ok: true });
      }
    });
  }

  // 暂存提示词：绑定到 用户(uid) + 会话(conversationId)。
  // 同一 uid+conv 可多次暂存——每次生成新 key（追加时间戳），旧记录保留不覆盖。
  if (req.method === 'POST' && p === '/api/stash') {
    return readBody(req).then((body) => {
      try {
        const uid = (body.uid || 'unknown') + '';
        const conv = (body.conversationId || 'unknown') + '';
        const safe = (s) => (s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
        const now = Date.now();
        const key = safe(uid) + '__' + safe(conv) + '__' + now;
        const dir = path.join(DATA_DIR, 'stash');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, key + '.json');
        const items = (body.content && body.content.items) || [];
        const record = {
          uid: body.uid || null,
          conversationId: body.conversationId || null,
          savedAt: new Date().toISOString(),
          content: body.content || null,
          summary: {
            textLen: body.content && body.content.textLen,
            itemCount: items.length,
            itemTypes: Array.from(new Set(items.map((x) => x.type))),
          },
        };
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        // 主索引：便于后续按 uid/会话 检索
        const idxFile = path.join(DATA_DIR, 'stash-index.json');
        let idx = [];
        try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || []; } catch (_) {}
        idx.unshift({
          key,
          uid: record.uid,
          conversationId: record.conversationId,
          savedAt: record.savedAt,
          file,
          summary: record.summary,
        });
        fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
        log('[stash] 暂存 -> ' + file + ' (uid=' + uid + ' conv=' + conv + ', items=' + items.length + ')');
        return json(res, 200, { ok: true, key: key, file: file });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 暂存提示词列表：全部记录 + uid->nickname 映射 + 会话名映射 + 当前账号 uid（供前端默认筛选）
  if (req.method === 'GET' && p === '/api/stash-list') {
    return (async () => {
      try {
        const { records, nick } = listStashRecords();
        const cur = currentAccount();
        const convNames = await fetchConvNames();
        const list = records.map((r) => {
          const text = (r.content && r.content.text) || '';
          return {
            key: r._key,
            uid: r.uid,
            conversationId: r.conversationId,
            savedAt: r.savedAt,
            preview: text.slice(0, 140),
            textLen: text.length,
            summary: r.summary || null,
          };
        });
        return json(res, 200, { ok: true, current: cur ? cur.uid : null, nick, convNames, records: list });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    })();
  }

  // 暂存提示词详情（含完整 content，供弹窗预览与发送）
  if (req.method === 'GET' && p === '/api/stash-get') {
    try {
      const key = (url.searchParams.get('key') || '').trim();
      if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
      const rec = stashRecordByKey(key);
      return json(res, 200, { ok: true, key, record: rec });
    } catch (e) {
      return json(res, 404, { ok: false, error: e.message });
    }
  }

  // 删除单条暂存记录
  if (req.method === 'POST' && p === '/api/stash-delete') {
    return readBody(req).then((body) => {
      try {
        const key = (body.key || '').trim();
        if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
        const deleted = deleteStashRecord(key);
        log('[stash] 删除 -> ' + key + ' (deleted=' + deleted + ')');
        return json(res, 200, { ok: true, key, deleted });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 发送暂存提示词：CDP 回填输入框并点击发送；mode=delete 时发送成功后删除该记录
  if (req.method === 'POST' && p === '/api/stash-send') {
    return readBody(req).then(async (body) => {
      try {
        const key = (body.key || '').trim();
        const mode = body.mode === 'delete' ? 'delete' : 'keep';
        if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
        const rec = stashRecordByKey(key);
        const sent = await sendStashToComposer(rec);
        let deleted = false;
        if (mode === 'delete') deleted = deleteStashRecord(key);
        log(`[stash] 发送 -> ${key} (mode=${mode}, deleted=${deleted}, textLen=${sent.textLen}, img=${sent.imagesRestored}/${sent.imagesFailed}, block=${sent.blocksRestored}/${sent.blocksFailed})`);
        return json(res, 200, {
          ok: true,
          key,
          mode,
          sent: true,
          deleted,
          textLen: sent.textLen,
          itemCount: sent.itemCount,
          imagesRestored: sent.imagesRestored,
          imagesFailed: sent.imagesFailed,
          blocksRestored: sent.blocksRestored,
          blocksFailed: sent.blocksFailed,
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  if (req.method === 'GET' && p === '/api/open-dir') {
    try {
      if (IS_WIN) {
        require('child_process').execFile('explorer.exe', [DATA_DIR]);
      } else {
        require('child_process').execFile('/usr/bin/open', [DATA_DIR]);
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/backup') {
    try {
      const info = backupCurrent(DATA_DIR, log);
      return json(res, 200, {
        ok: true,
        uid: info.uid,
        nickname: info.nickname,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/switch') {
    return readBody(req).then(async (body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        // 先记录源账号并规划自动复制内容；切换后异步执行，避免阻塞 WorkBuddy 刷新。
        const sourceUid = String((currentAccount() || {}).uid || '').trim();
        let autoCopyPlan = [];
        if (sourceUid && sourceUid !== uid) {
          try {
            autoCopyPlan = await buildAutoCopyPlan(sourceUid, uid);
          } catch (e) {
            log(`[sessions-auto-copy] 规划失败 ${sourceUid} -> ${uid}: ${e.message}`);
          }
        }
        const acct = switchTo(DATA_DIR, uid, log);
        const hint = '登录文件已切换，请重启 WorkBuddy 使新账号生效';
        let reloaded = false;
        if (body.reload) {
          try {
            await reloadWorkBuddyPage();
            reloaded = true;
            log('[switch] 已通过 CDP 刷新 WorkBuddy 窗口');
            // 切换后通过接口自动签到（带每日缓存，幂等）
            claimDailyForUid(uid)
              .then((r) => log('[checkin] 切换后自动签到 ' + uid + ': ' + (r.ok ? '已领取' : '失败 ' + (r.reason || r.message))))
              .catch((e) => log('[checkin] 切换后签到异常: ' + e.message));
          } catch (e) {
            log(`[switch] CDP 刷新失败: ${e.message}`);
          }
        }
        // 空间规则可能因切换前后的会话索引时序暂时无法生成初始计划，但规则本身仍需触发复制任务；
        // 任务规则通常能直接命中，所以旧逻辑只表现为“任务能复制、空间不复制”。
        const sourceRules = sourceUid ? getAutoCopyRules(DATA_DIR, sourceUid) : { sessionIds: [], workspaces: [] };
        const hasSourceAutoCopyRules = !!(sourceRules.sessionIds.length || sourceRules.workspaces.length);
        const autoCopyJob = (autoCopyPlan.length || hasSourceAutoCopyRules || hasPendingAutoCopyTo(sourceUid))
          ? startAutoCopyJob(sourceUid, uid, autoCopyPlan)
          : null;
        return json(res, 200, {
          ok: true,
          uid: acct.uid,
          nickname: acct.nickname,
          reloaded,
          autoCopy: autoCopyJob ? { jobId: autoCopyJob.id, total: autoCopyJob.total } : { total: 0 },
          hint: reloaded ? '已切换并触发窗口刷新' : hint,
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}


// ===== 电脑休眠控制（三模式：allow/keep/until-done + 显示器开关 + 立即休眠 pmset sleepnow）=====
// mode: 'allow' 允许电脑休眠（默认）| 'keep' 持续禁止休眠 | 'until-done' 所有任务结束后允许休眠
// displaySleep: 禁止休眠时是否允许显示器休眠（默认 false = 显示器也保持唤醒）
let sleepCaffeinate = null;
let sleepUserActivity = null; // 防锁屏：caffeinate -u -t 300（UserIsActive 断言，阻止屏保启动/空闲锁屏）
let sleepUserActivityTimer = null; // -u 断言每 240s 续期一次（-t 300 超时前续期，保持无间隙）
let sleepPowershell = null; // Windows: 常驻 powershell 进程持有 SetThreadExecutionState
function stopCaffeinate() {
  if (IS_WIN) {
    const c = sleepPowershell;
    sleepPowershell = null; // 先置 null 再 kill，避免 exit 回调把旧引用覆盖
    if (c) { try { c.kill(); } catch (_) {} }
    return;
  }
  const c = sleepCaffeinate;
  sleepCaffeinate = null; // 先置 null 再 kill，避免旧进程 exit 回调把新引用覆盖
  if (c) { try { c.kill(); } catch (_) {} }
  stopUserActivity(); // 同步停止防锁屏循环
}
// 停止防锁屏：清除续期定时器并杀掉 -u 进程（UserIsActive 断言随之释放）
function stopUserActivity() {
  if (sleepUserActivityTimer) { clearInterval(sleepUserActivityTimer); sleepUserActivityTimer = null; }
  const c = sleepUserActivity; sleepUserActivity = null;
  if (c) { try { c.kill(); } catch (_) {} }
}
// 防锁屏循环：持续声明「用户活跃」（caffeinate -u），等价 Amphetamine 的模拟用户活动机制，
// 系统认为用户一直在操作，屏保与空闲锁屏便不会触发；每 240s 重启一个 -t 300 的断言实现无间隙续期。
// 无需辅助功能权限（-u 走系统 IOKit 用户活动断言）。
function startUserActivityLoop() {
  if (IS_WIN) return; // Windows 无 caffeinate -u 等价；防锁屏由系统电源策略控制
  stopUserActivity();
  const tick = () => {
    if (!sleepCaffeinate) return; // 防休眠已停止（allow 模式），不再续期
    if (sleepUserActivity) { try { sleepUserActivity.kill(); } catch (_) {} }
    const child = spawn('caffeinate', ['-u', '-t', '300'], { stdio: 'ignore' });
    child.on('error', (e) => log('[sleep] 防锁屏 caffeinate(-u) 启动失败: ' + e.message));
    child.on('exit', () => { if (sleepUserActivity === child) sleepUserActivity = null; });
    sleepUserActivity = child;
  };
  tick();
  sleepUserActivityTimer = setInterval(tick, 240 * 1000);
  if (sleepUserActivityTimer.unref) sleepUserActivityTimer.unref();
}
function startCaffeinate(displaySleep) {
  if (IS_WIN) {
    // Windows：常驻 powershell 循环调用 SetThreadExecutionState。
    // 0x80000000 ES_CONTINUOUS | 0x1 ES_SYSTEM_REQUIRED | 0x2 ES_DISPLAY_REQUIRED
    const flags = displaySleep ? '0x80000001' : '0x80000003';
    const ps = "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);' -Name WSleep -Namespace WB -PassThru | Out-Null; while($true){ [WB.WSleep]::SetThreadExecutionState(" + flags + "); Start-Sleep -Seconds 90 }";
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => { log('[sleep] 防休眠进程启动失败: ' + e.message); if (sleepPowershell === child) sleepPowershell = null; });
    child.on('exit', () => { if (sleepPowershell === child) sleepPowershell = null; });
    sleepPowershell = child;
    return child;
  }
  const child = spawn('caffeinate', displaySleep ? ['-i', '-s', '-m'] : ['-d', '-i', '-s', '-m'], { stdio: 'ignore' });
  child.on('error', (e) => { log('[sleep] caffeinate 启动失败: ' + e.message); if (sleepCaffeinate === child) sleepCaffeinate = null; });
  child.on('exit', () => { if (sleepCaffeinate === child) sleepCaffeinate = null; });
  sleepCaffeinate = child;
  // 显示器保持唤醒时启用防锁屏（-u 用户活动断言）；允许显示器休眠时屏幕黑屏后由系统锁屏策略决定，无法防锁屏
  if (!displaySleep) startUserActivityLoop(); else stopUserActivity();
  return child;
}
function applySleepMode(mode, displaySleep) {
  const preventing = mode === 'keep' || mode === 'until-done';
  if (preventing) {
    if (IS_WIN) {
      // Windows：powershell 持有进程参数固定，无法比较 spawnargs，直接重启（低频操作，代价可接受）
      stopCaffeinate();
      try {
        startCaffeinate(!!displaySleep);
        log('[sleep] 禁止休眠已开启（Windows，模式=' + mode + (displaySleep ? '，允许显示器休眠' : '，显示器保持唤醒') + '）');
      } catch (e) { log('[sleep] 开启失败: ' + e.message); return false; }
      return true;
    }
    const wantArgs = displaySleep ? '-i-s-m' : '-d-i-s-m';
    const curArgs = sleepCaffeinate ? sleepCaffeinate.spawnargs.slice(1).join('-') : null;
    const wantLock = !displaySleep; // 防锁屏仅在显示器保持唤醒时有效
    const curLock = !!sleepUserActivityTimer;
    if (curArgs === wantArgs && curLock === wantLock) return true; // 已按同样参数在防休眠（含防锁屏状态），无需重启
    stopCaffeinate();
    try {
      startCaffeinate(!!displaySleep);
      log('[sleep] 禁止休眠已开启（模式=' + mode + (displaySleep ? '，允许显示器休眠，防锁屏关闭' : '，显示器保持唤醒，防锁屏开启') + '）');
    } catch (e) { log('[sleep] 开启失败: ' + e.message); return false; }
  } else {
    if (!sleepCaffeinate && !sleepUserActivityTimer) return true;
    stopCaffeinate();
    log('[sleep] 禁止休眠已解除（允许电脑休眠）');
  }
  return true;
}
function sleepNow() {
  try {
    if (IS_WIN) {
      // Windows：SetSuspendState(Hibernate=0, ForceCritical=0, DisableWakeEvent=0) → 睡眠
      const c = spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { stdio: 'ignore', windowsHide: true });
      c.on('error', (e) => log('[sleep] 立即休眠失败: ' + e.message));
      c.on('exit', () => log('[sleep] 已请求立即休眠（Windows SetSuspendState）'));
      return true;
    }
    const c = spawn('pmset', ['sleepnow'], { stdio: 'ignore' });
    c.on('error', (e) => log('[sleep] 立即休眠失败: ' + e.message));
    c.on('exit', () => log('[sleep] 已请求立即休眠'));
    return true;
  } catch (e) { log('[sleep] 立即休眠失败: ' + e.message); return false; }
}
function restoreSleepMode() {
  try {
    const f2 = path.join(DATA_DIR, 'sleep-mode.json');
    if (fs.existsSync(f2)) {
      const c = JSON.parse(fs.readFileSync(f2, 'utf8'));
      const mode = c.mode === 'keep' || c.mode === 'until-done' ? c.mode : 'allow';
      applySleepMode(mode, !!c.displaySleep);
    }
  } catch (_) {}
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) return handleApi(req, res);
    // 官方背景图静态服务：/wallpapers/<name>（供面板「主题」页缩略图预览）
    if (req.method === 'GET' && /^\/wallpapers\//.test(req.url)) {
      try {
        const name = path.basename(decodeURIComponent(req.url.split('?')[0].split('/').pop()));
        if (!/\.webp$/i.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        const file = path.join(WALLPAPERS_DIR, name);
        if (!fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        return res.end(fs.readFileSync(file));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('error: ' + e.message);
      }
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      // web/ 调试界面已移除（web 目录不再打包），根路径返回自包含的状态提示页
      const c = currentAccount();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><html lang="zh"><meta charset="utf-8"><title>' + WORKDADDY_INSTALL_NAME + '</title>' +
        '<body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#e6e6e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h1 style="margin:0 0 8px">' + WORKDADDY_INSTALL_NAME + ' v' + DAEMON_VERSION + '</h1>' +
        '<p style="color:#9a9aa0;margin:0">面板入口：' + PROFILE.name + ' 右下角机器人按钮</p>' +
        '<p style="color:#555;font-size:12px;margin-top:16px">守护进程运行中 · CDP ' + (cdp.connected ? '已连接' : '未连接') +
        (c && c.nickname ? ' · 当前账号：' + String(c.nickname).replace(/</g, '&lt;') : '') + '</p></div></body></html>'
      );
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  // DevTools WebSocket 代理：只接受当前 CDP DevTools 页面来源，拒绝任意网页借代理控制 renderer。
  // daemon 到 Electron CDP 的上游连接仍去掉 Origin（Electron CDP 会拒绝带 Origin 的连接）。
  if (wsLib) {
    const { WebSocketServer } = wsLib;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) { socket.destroy(); return; }
      const m = /^\/devtools-proxy\/([A-Za-z0-9]+)$/.exec(pathname);
      if (!m) { socket.destroy(); return; }
      // 与 /api/devtools-url 使用同一套回退顺序：CDP 尚未完成内存连接时，
      // 仍允许已持久化端口上的官方 DevTools 页面建立代理连接。
      const upstreamPort = cdp.port || readCdpPortFile() || CDP_PORT_HINT || 9222;
      if (!upstreamPort || !isAllowedDevtoolsOrigin(String(req.headers.origin || ''), upstreamPort)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (front) => {
        if (!WebSocketCtor) { try { front.close(); } catch (_) {} return; }
        const back = new WebSocketCtor('ws://127.0.0.1:' + upstreamPort + '/devtools/page/' + m[1]);
        let backReady = false;
        let keepAlive = null;
        const queue = [];
        back.onopen = () => {
          backReady = true;
          while (queue.length) back.send(queue.shift());
          // 双层保活，消除 DevTools 前端的 "The tab is inactive"：
          // 1) Page.setWebLifecycleState active —— 维持 CDP lifecycle 状态；
          // 2) 注入 Page.screencastVisibilityChanged{visible:true} —— DevTools 的 ScreencastView
          const poke = () => {
            try {
              back.send(JSON.stringify({ id: 999001, method: 'Page.setWebLifecycleState', params: { state: 'active' } }));
            } catch (_) {}
          };
          // 注入 screencastVisibilityChanged{visible:true}：DevTools 前端的 ScreencastView
          // 通过 startScreencast 的回调监听该事件判断 "The tab is inactive"
          // （screencastVisibilityChanged 回调里 targetInactive = !visible）。实测 Electron
          // 在 startScreencast 后主动推送 visible:false（窗口无焦点/遮挡），导致前端进入
          // inactive 状态。注入 true 覆盖初始态。
          const injectVisible = () => {
            try {
              front.send(JSON.stringify({ method: 'Page.screencastVisibilityChanged', params: { visible: true } }));
            } catch (_) {}
          };
          poke();
          injectVisible();
          keepAlive = setInterval(() => { poke(); injectVisible(); }, 2000);
        };
        front.on('message', (data) => {
          const msg = data.toString();
          // 前端有交互时顺带戳一下保活
          if (backReady) { try { back.send(msg); } catch (_) {} } else queue.push(msg);
        });
        back.onmessage = (ev) => {
          // 拦截真实 screencastVisibilityChanged：visible 一律改写为 true 再转发，
          // 防止窗口失焦/遮挡后 DevTools 前端再次切入 "The tab is inactive"
          let msg = ev.data.toString();
          try {
            const j = JSON.parse(msg);
            if (j.method === 'Page.screencastVisibilityChanged' && j.params && j.params.visible === false) {
              j.params.visible = true;
              msg = JSON.stringify(j);
            }
          } catch (_) {}
          try { front.send(msg); } catch (_) {}
        };
        back.onerror = () => { try { front.close(); } catch (_) {} };
        const cleanup = () => {
          if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
          try { back.close(); } catch (_) {}
        };
        back.onclose = () => { cleanup(); try { front.close(); } catch (_) {} };
        front.on('close', cleanup);
        front.on('error', cleanup);
      });
    });
    log('[ws] DevTools 代理就绪 (/devtools-proxy/<targetId>)');
  }

  // 每个 profile 的候选端口完全不重叠。显式端口由 launcher 预先选定，
  // 直接运行 daemon 时才在本 profile 的持久化/固定候选中回退。
  const ports = ALLOW_UI_PORT_FALLBACK
    ? profileUiPortCandidates(PROFILE.id, { persistedPort: readUiPortFile(), preferredPort: UI_PORT_BASE })
    : [UI_PORT_BASE];
  const tryListen = (attempt) => {
    const port = ports[attempt];
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempt + 1 < ports.length) {
        log(`[http] 端口 ${port} 不可绑定，改用当前 profile 备用端口 ${ports[attempt + 1]}`);
        tryListen(attempt + 1);
      } else {
        log(`[http] 启动失败: ${e.message}`);
        process.exit(1);
      }
    });
    server.listen(port, HOST, () => {
      ACTUAL_PORT = port;
      writeUiPortFile(port);
      log(`[http] Web 界面: http://${HOST}:${port}  (数据目录: ${DATA_DIR})`);
    });
  };
  tryListen(0);
}

/* ================= 启动 ================= */

process.on('uncaughtException', (error) => {
  log('[fatal] 未捕获异常: ' + (error && error.stack || error));
  captureException(error, { stage: 'daemon-uncaught' }).catch(() => {});
  setTimeout(() => process.exit(1), 5500);
});
process.on('unhandledRejection', (reason) => {
  log('[fatal] 未处理 Promise 异常: ' + (reason && reason.stack || reason));
  captureException(reason, { stage: 'daemon-unhandled-rejection' }).catch(() => {});
});

ensureDirs(DATA_DIR, log);
if (!acquireDaemonLock()) process.exit(0);
CREDIT_USAGE_STORE.initialize().catch((error) => log('[credits-usage] 初始化数据库失败: ' + error.message));
// 首次启动初始化（新电脑 / 数据目录为空时）：内置壁纸 + WorkDaddy 主题 + 默认蒙版 10%
initBuiltinAssets();
// 启动时刷新决策弹窗规则到最新版本（已启用时替换旧规则段）
refreshAskModeIfEnabled();
// 启动时补偿持续会话指令块（开关开启但 app-config 块缺失/被改写时补写）
refreshAutoContinueIfEnabled();
repairMissingSessionWorkspaces().catch((error) => log('[sessions-cwd-repair] 启动修复失败: ' + error.message));
const sessionCwdRepairTimer = setInterval(() => {
  repairMissingSessionWorkspaces().catch((error) => log('[sessions-cwd-repair] 定时修复失败: ' + error.message));
}, 5000);
sessionCwdRepairTimer.unref && sessionCwdRepairTimer.unref();
log('WorkBuddy 多账号切换器启动 (CDP 模式)');
log(`登录信息文件: ${AUTH_FILE}`);
log(`备份目录: ${DATA_DIR}`);
updateDebug('daemon-start', { authFile: AUTH_FILE, dataDir: DATA_DIR, appPath: IS_WIN ? WORKDADDY_DIR_WIN : macWorkDaddyAppPath(), apiPort: UI_PORT_BASE });

restoreSleepMode();
startServer();
cdpLoop();
// 启动后给网络和本地存储留出就绪时间，再补一轮；之后每小时兜底。
const startupCheckinTimer = setTimeout(() => {
  claimDailyForAll().catch((e) => log('[checkin] 启动签到失败: ' + e.message));
}, CHECKIN_STARTUP_DELAY_MS);
startupCheckinTimer.unref && startupCheckinTimer.unref();
const periodicCheckinTimer = setInterval(() => {
  claimDailyForAll().catch((e) => log('[checkin] 定时签到失败: ' + e.message));
}, CHECKIN_INTERVAL_MS);
periodicCheckinTimer.unref && periodicCheckinTimer.unref();
// 自动更新：启动时检查一次（延迟 8s 等网络就绪），之后每 6 小时一次
setTimeout(() => { checkUpdate(true).catch(() => {}); }, 8000);
updateTimer = setInterval(() => { checkUpdate(false).catch(() => {}); }, UPDATE_CHECK_INTERVAL);
updateTimer.unref && updateTimer.unref();

process.on('SIGTERM', () => {
  log('收到 SIGTERM，退出');
  releaseDaemonLock();
  try { stopCaffeinate(); } catch (_) {}
  try {
    if (AUTH_FILE) fs.unwatchFile(AUTH_FILE);
  } catch (_) {}
  process.exit(0);
});
process.on('SIGINT', () => {
  releaseDaemonLock();
  process.exit(0);
});
process.on('exit', releaseDaemonLock);
