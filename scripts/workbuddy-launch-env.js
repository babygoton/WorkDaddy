'use strict';

const fs = require('fs');
const path = require('path');

// Update origins differ from the billing/API host (CN uses codebuddy.cn there).
const UPDATE_ORIGINS = Object.freeze({
  'workbuddy-cn': 'https://www.workbuddy.cn',
  'workbuddy-ai': 'https://www.workbuddy.ai',
});

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
  const overrides = {
    WORKBUDDY_UPDATE_URL: UPDATE_ORIGINS[profile.id],
    WORKBUDDY_CONFIG_DIR: profile.dataRoot,
    CODEBUDDY_CONFIG_DIR: profile.dataRoot,
    WORKBUDDY_DATA_FOLDER_NAME: path.basename(profile.dataRoot),
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

module.exports = { getWorkBuddyLaunchEnv };
