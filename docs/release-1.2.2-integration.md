# 1.2.2 集成与打包记录

当前分支：`codex/1.2.2`。

## 合并来源

- `codex/windows-elevated-consent`：`04d0bee`，管理员桌面兼容模式的显式同意及逐次身份核验。
- `codex/fix-import-token-double-count`：`9413b2f`，导入/复制会话的 Token 去重及真实客户端验证记录。
- `codex/checkin-risk-consent`：`051dc14`，自动签到默认关闭、首次选择后持久化。

三个分支均以 merge commit 合入；冲突仅发生在 daemon 版本与 build id，统一源码运行版本为 1.2.40。按用户要求用 `WORKDADDY_BUILD_VERSION=1.2.2` 构建发行包，构建脚本把 staged daemon 与 app 元数据统一写为 1.2.2。没有修改 main，也没有推送远端。

另修复 macOS 打包脚本遗漏 `assets/workdaddy-app-icon-source.svg` 的问题，增加根据 `buildInjectScript()` 实际 SVG 依赖核对打包列表的回归测试。

## 验证

- 全套 Node 测试：757 项，749 通过、8 跳过、0 失败。
- daemon、inject、win-launcher、watchdog 的语法检查以及两个 shell 构建脚本语法检查通过。
- Windows/amd64 原生启动器交叉编译通过；这不代表 Windows 安装/权限场景已实测。
- scripts/test/docs 的 diff 检查通过。用户先前的两个 README 工作区修改已原样恢复；README.md 的既有行尾空格没有纳入提交。
- 合并后的隔离 renderer 检查完成了账号排序及积分汇总，主题切换检查遇到 CSS 过渡取样时序；调整测试夹具后本机 CDP 端口不可连接，未完成完整 UI 复测。未因此重启 WorkBuddy。

## macOS 产物

两个 DMG 均通过 hdiutil 校验并只读挂载检查：daemon 版本、build id、Info.plist 两个版本字段、profile/品牌、可执行 launcher、Applications 链接、Finder 布局、新 SVG、签到默认关闭、安装/更新脚本均正确；包内没有 `安装失败自主解决提示词.txt`。daemon 除版本重写外与源码一致，必需模块与源码逐字节一致。

- `WorkDaddy-1.2.2.dmg`：profile `workbuddy-cn`，版本 `1.2.2`，SHA-256 `c56357a98177396ab2815a2633fce7b9649c42ac885f09f8b3574874fc5f5d26`。
- `WorkDaddy-AI-1.2.2.dmg`：profile `workbuddy-ai`，版本 `1.2.2`，SHA-256 `d500439c536409c5dec59071f16a5a4de3c90a717cdc6aafe4365aa82fc02c4d`。

## Windows 状态

`win-admin`（192.168.101.9:22）多次 SSH 连接超时，已请求用户恢复构建机连接。本次尚未生成 Windows 1.2.2 Setup.exe；未将历史安装包重命名交付。两个 Windows 安装器的实际 payload、普通/管理员安装以及 CN/AI 同时运行验证仍待 Windows 构建环境恢复后完成。
