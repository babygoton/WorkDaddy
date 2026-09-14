# 1.2.2 集成与打包记录

当前分支：`codex/1.2.2`。

## 合并来源

- `codex/windows-elevated-consent`：`04d0bee`，管理员桌面兼容模式的显式同意及逐次身份核验。
- `codex/fix-import-token-double-count`：`9413b2f`，导入/复制会话的 Token 去重及真实客户端验证记录。
- `codex/checkin-risk-consent`：`051dc14`，自动签到默认关闭、首次选择后持久化。

三个分支均以 merge commit 合入；冲突仅发生在 daemon 版本与 build id。合并与头像打包修复此前已推送至 `4e38054`。本次后续修复的源码运行版本为 1.2.42，build id 为 `release-1.2.42-20260914-streaming-session-transfer`。按用户要求用 `WORKDADDY_BUILD_VERSION=1.2.2` 构建发行包，构建脚本把 staged daemon 与 app 元数据统一写为 1.2.2。修改均在 `codex/1.2.2` 分支进行，没有修改 main。

另修复 macOS 打包脚本遗漏 `assets/workdaddy-app-icon-source.svg` 的问题，增加根据 `buildInjectScript()` 实际 SVG 依赖核对打包列表的回归测试。

## 本轮修复

- 匿名安装数/日活不再受错误诊断开关或 `WORKDADDY_TELEMETRY` 限制；错误诊断本身继续受控。前后端门控和关闭诊断时的请求取消均移除，仍保留持久标识、每日去重、失败退避及 CN/AI 共用配额。
- 首次确认开启自动签到后，立即启动内置签到任务；重复选择不重跑，已运行的任务复用。缓存跳过结果及整个任务结束都通知面板更新标签，确认后也主动刷新。
- 提示文案改为「开启后自动为已保存账号签到。请留意官方规则，自动操作可能影响账号使用。可随时在『自动化』中关闭。」
- 移除会话附件 256 MiB 大小上限；改用 `.wds` 流式压缩加密、Blob 下载上传和先认证后恢复的导入链路，继续兼容旧 `.json` 导入。格式与约束见 `docs/session-transfer.md`。

## 验证

- 全套 Node 测试：769 项，761 通过、8 跳过、0 失败。
- daemon、inject、usage-report、session-transfer、win-launcher、watchdog 的语法检查与 macOS 构建脚本语法检查通过。
- 上轮 Windows/amd64 原生启动器交叉编译通过；本轮没有 Windows 运行环境，这不代表 Windows 安装/权限或大文件场景已实测。
- scripts/test/docs 的 diff 检查通过。用户先前的两个 README 工作区修改未改动；README.md 的既有行尾空格不在本轮修改范围。
- 257 MiB 单附件导出/导入及 SHA-256 对比通过，在 96 MiB JavaScript 堆限制下也通过。真实 HTTP 路由往返、密码错误不写库、原归属及目标账号覆盖、空文件、路径穿越/重复/损坏拒绝、旧 JSON 兼容均通过。
- 本机 CDP 端口不可连接，未完成本轮实际面板签到和文件选择/下载交互验证；未因此重启 WorkBuddy。

## macOS 产物

两个 DMG 均通过 hdiutil 校验并只读挂载检查：daemon 版本、build id、Info.plist 两个版本字段、profile/品牌、可执行 launcher、Applications 链接、Finder 布局、新 SVG、签到默认关闭、安装/更新脚本均正确；包内没有 `安装失败自主解决提示词.txt`。daemon 除版本重写外与源码一致，必需模块与源码逐字节一致。包内 build id 为 `release-1.2.2-20260914-streaming-session-transfer`。

按 `scripts/build-mac-dmg.sh` 完整清单同步源码；本轮变更的运行文件为 `scripts/daemon.js`、`scripts/inject.js`、`scripts/usage-report.js` 和新增 `scripts/session-transfer.js`，两个 DMG 均包含这四项。另更新了 Windows 自检清单 `scripts/verify-win.cmd`，Windows 构建时会随 scripts 整体复制。没有同步到 `/Applications/WorkDaddy.app`，没有重启运行中的 daemon 或 WorkBuddy。

- `WorkDaddy-1.2.2.dmg`：profile `workbuddy-cn`，版本 `1.2.2`，SHA-256 `25af5f60018965a85735d7de894b21f8f2570655f54a43a892fafcc11f24b7c9`。
- `WorkDaddy-AI-1.2.2.dmg`：profile `workbuddy-ai`，版本 `1.2.2`，SHA-256 `324f91bca51ef90b60e1e71b5b91d144650cbb1f63180d690ae4d33077942949`。

## Windows 状态

`win-admin`（192.168.101.9:22）多次 SSH 连接超时，已请求用户恢复构建机连接。本次尚未生成 Windows 1.2.2 Setup.exe；未将历史安装包重命名交付。两个 Windows 安装器的实际 payload、普通/管理员安装以及 CN/AI 同时运行验证仍待 Windows 构建环境恢复后完成。
