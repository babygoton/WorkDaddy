'use strict';

const fs = require('fs');
const path = require('path');
const { replaceFileWithRetry } = require('./atomic-file-write.js');

// Fixed allowlist only: never turn a local API payload into arbitrary Electron flags.
const SOFTWARE_RENDERING_ARGS = [
  '--disable-gpu',
  '--use-gl=angle',
  '--use-angle=swiftshader-webgl',
  '--enable-unsafe-swiftshader',
];

function supportsClientLaunchSettings(profileId, platform) {
  return platform === 'win32' && profileId === 'workbuddy-ai';
}

function readClientLaunchSettings(dataDir, profileId, platform = process.platform) {
  const supported = supportsClientLaunchSettings(profileId, platform);
  let softwareRendering = false;
  if (supported) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'client-launch-settings.json'), 'utf8'));
      softwareRendering = !!settings && settings.softwareRendering === true;
    } catch (_) { /* Missing or invalid settings retain the official default. */ }
  }
  return { supported, softwareRendering };
}

function setClientLaunchSettings(dataDir, profileId, body, platform = process.platform) {
  if (!supportsClientLaunchSettings(profileId, platform)) throw new Error('当前客户端不支持此兼容设置');
  if (!body || typeof body.softwareRendering !== 'boolean') throw new Error('软件渲染开关值必须是布尔值');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  replaceFileWithRetry(path.join(dataDir, 'client-launch-settings.json'),
    JSON.stringify({ softwareRendering: body.softwareRendering }, null, 2) + '\n', 0o600);
  return readClientLaunchSettings(dataDir, profileId, platform);
}

function getClientLaunchArgs(dataDir, profileId, platform = process.platform) {
  return readClientLaunchSettings(dataDir, profileId, platform).softwareRendering
    ? SOFTWARE_RENDERING_ARGS.slice() : [];
}

module.exports = { readClientLaunchSettings, setClientLaunchSettings, getClientLaunchArgs };
