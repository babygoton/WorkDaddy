'use strict';

const fs = require('fs');
const path = require('path');

// Update origins differ from the billing/API host (CN uses codebuddy.cn there).
const UPDATE_ORIGINS = Object.freeze({
  'workbuddy-cn': 'https://www.workbuddy.cn',
  'workbuddy-ai': 'https://www.workbuddy.ai',
});

/** 目录下非隐藏条目数；不存在或读不了返回 0 */
function entryCount(p) {
  try { return fs.readdirSync(p).filter((n) => !n.startsWith('.')).length; } catch (_) { return 0; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * 解析 Windows 上真正该用的 WorkBuddy 数据根（configDir）。
 *
 * 背景：profiles.js 在 Windows 上把 dataRoot 硬编码成 ~/.workbuddy，既不探测也不允许
 * 覆盖；workbuddy-target.js 里那套「环境变量覆盖 + 目录探测」整段被包在
 * `platform === 'linux'` 分支内，Windows 分支产出的 target 根本没有 dataRoot 字段。
 * 于是把数据目录迁出 %USERPROFILE% 的用户，侧栏历史（读 <configDir>\projects）会被
 * 指到一个空目录，表现为「直接用客户端有历史，用 WorkDaddy 拉起就全空」。
 *
 * 优先级：
 *   1. WBSWITCH_TARGET_DATA_ROOT —— 显式指定，最高优先（与 Linux 分支同名，保持一致）
 *   2. 在候选里挑「最强信号」：
 *        a. 有非空 projects 目录者，取条目最多的那个
 *        b. 否则取 workbuddy.db 体积最大者
 *   3. 都落空 → 返回 ''，由调用方跳过注入，把目录决定权还给客户端（fail-open）
 *
 * 为什么不能「首个含 workbuddy.db 的候选即返回」：本函数注入的 configDir 会让客户端
 * 在该根下创建 workbuddy.db 与 app/，那正好构成自证循环——探测器以最高置信度验证了
 * 自己造出来的空目录。必须全体候选比强弱，且以 projects 这种只有真实使用才会产生的
 * 信号为准。
 */
function resolveConfigDir(profile, env) {
  const explicit = String(env.WBSWITCH_TARGET_DATA_ROOT || '').trim();
  if (explicit && path.isAbsolute(explicit)) return explicit;

  const candidates = [];
  const push = (value) => {
    const t = String(value || '').trim();
    if (t && path.isAbsolute(t) && !candidates.includes(t)) candidates.push(t);
  };
  push(profile.dataRoot);

  // 客户端显式重定向：作为线索参与竞争。CN 端与 AI 端数据根互斥，名字带 ai 的根不能
  // 给 CN 端用（与 platform.js 的 looksLikeSiblingRoot 同一思路）。
  const ai = profile.id === 'workbuddy-ai';
  for (const key of ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']) {
    const value = String(env[key] || '').trim();
    if (!value) continue;
    if (path.basename(value).toLowerCase().includes('ai') !== ai) continue;
    push(value);
  }

  // WorkBuddy 自己迁移 userData 时用的持久变量：userData = <数据根>\app，
  // 因此它的父目录就是数据根。这是「数据目录被迁走」最可靠的发现途径。
  const hostUserData = String(env.WB_OFFICE_HOST_USER_DATA_DIR || '').trim();
  if (hostUserData && path.isAbsolute(hostUserData)) push(path.dirname(hostUserData));

  const scored = candidates.map((root) => ({
    root,
    projects: entryCount(path.join(root, 'projects')),
    dbSize: fileSize(path.join(root, 'workbuddy.db')),
  }));
  const withProjects = scored.filter((s) => s.projects > 0).sort((a, b) => b.projects - a.projects);
  if (withProjects.length) return withProjects[0].root;
  const withDb = scored.filter((s) => s.dbSize > 0).sort((a, b) => b.dbSize - a.dbSize);
  if (withDb.length) return withDb[0].root;
  // 没有任何候选带 projects 或 db：我们并不比客户端更了解该用哪个根，
  // 此时宁可交出决定权，也不要猜一个（它很可能是我们上次造出来的空目录）。
  return '';
}

function getWorkBuddyLaunchEnv(profile, dataDir, platform = process.platform, env = process.env) {
  const childEnv = { ...env };
  if (platform !== 'win32' || profile.customTarget || !Object.hasOwn(UPDATE_ORIGINS, profile.id)) return childEnv;
  if (!profile.dataRoot || !path.isAbsolute(profile.dataRoot) || !dataDir || !path.isAbsolute(dataDir)) {
    throw new Error('无法隔离 WorkBuddy 更新：客户端或 WorkDaddy 数据目录不是绝对路径');
  }

  // #424: the official Windows updater restores cached Setup.exe files before
  // checking its feed. Pinning the URL alone cannot exclude a sibling installer.
  // A stable profile-specific TEMP isolates the cache without deleting any files.
  // Use DATA_DIR rather than inherited TEMP so child restarts cannot nest paths.
  const tempDir = path.join(dataDir, 'client-tmp', profile.id);
  try {
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error('无法创建 WorkBuddy 独立临时目录，请检查 WorkDaddy 数据目录的写入权限', { cause: error });
  }
  const configDir = resolveConfigDir(profile, env);
  const overrides = {
    WORKBUDDY_UPDATE_URL: UPDATE_ORIGINS[profile.id],
    // 解析不出真实数据根时，这三个键干脆不注入：宁可让客户端用它自己的解析逻辑，
    // 也不要把它指到一个我们刚刚创建出来的空目录。
    ...(configDir
      ? {
        WORKBUDDY_CONFIG_DIR: configDir,
        CODEBUDDY_CONFIG_DIR: configDir,
        WORKBUDDY_DATA_FOLDER_NAME: path.basename(configDir),
      }
      : {}),
    TEMP: tempDir,
    TMP: tempDir,
  };
  // Windows keys are case-insensitive. Remove aliases before adding canonical
  // names; Node otherwise passes only the first case variant to the child.
  for (const key of Object.keys(childEnv)) {
    if (Object.hasOwn(overrides, key.toUpperCase())) delete childEnv[key];
  }
  return Object.assign(childEnv, overrides);
}

module.exports = { getWorkBuddyLaunchEnv, resolveConfigDir };
