const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');

const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

test('macOS DMG declares an arm64 LaunchServices architecture priority', () => {
  const build = read('build-mac-dmg.sh');
  assert.match(build, /LS_ARCH_PRIORITY="arm64"/);
  assert.match(build, /Add :LSArchitecturePriority array/);
  assert.match(build, /Add :LSArchitecturePriority:0 string \$\{LS_ARCH_PRIORITY\}/);
  // 声明必须落在打包产物上，而不是只在仓库里的壳上。
  assert.match(build, /Print :LSArchitecturePriority:0' "\$PACKAGE_APP\/Contents\/Info\.plist"/);
});

test('macOS DMG build fails loudly when the arch priority is not written', () => {
  const build = read('build-mac-dmg.sh');
  const verify = build.indexOf('BUILT_ARCH_PRIORITY=');
  assert.notEqual(verify, -1);
  const guard = build.slice(verify, build.indexOf('echo "==> 架构优先级已声明'));
  assert.match(guard, /if \[ "\$BUILT_ARCH_PRIORITY" != "\$LS_ARCH_PRIORITY" \]; then/);
  assert.match(guard, /exit 3/);
});

test('macOS updater refreshes the LaunchServices registration before relaunching', () => {
  const script = read('apply-update.sh');
  assert.match(script, new RegExp(LSREGISTER_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(script, /"\$LSREGISTER" -u "\$APP_PATH"/);
  assert.match(script, /"\$LSREGISTER" -f "\$APP_PATH"/);
  assert.match(script, /\/Volumes\/\*\/WorkDaddy\*\.app/);

  const xattr = script.indexOf('xattr -cr "$APP_PATH"');
  const refresh = script.indexOf('"$LSREGISTER" -u "$APP_PATH"');
  const relaunch = script.indexOf('open -n "$APP_PATH" || rollback 27');
  assert.notEqual(xattr, -1);
  assert.notEqual(refresh, -1);
  assert.notEqual(relaunch, -1);
  assert.ok(xattr < refresh, 'registration refresh must follow the bundle replacement');
  assert.ok(refresh < relaunch, 'registration refresh must happen before the relaunch');
});

test('macOS updater never fails the update because of registration cleanup', () => {
  const script = read('apply-update.sh');
  assert.match(script, /"\$LSREGISTER" -u "\$APP_PATH" >\/dev\/null 2>&1 \|\| log /);
  assert.match(script, /"\$LSREGISTER" -f "\$APP_PATH" >\/dev\/null 2>&1 \|\| log /);
  assert.match(script, /未找到 lsregister，跳过注册刷新/);
});
