# WorkDaddy · Linux 移植版

本项目是 [WorkDaddy](https://github.com/babygoton/WorkDaddy)（AGPL-3.0）的 **Linux 移植**。
上游只发布 macOS（dmg）与 Windows（exe）两个平台，本移植补齐 Linux 缺口，
**不修改 WorkBuddy 任何文件**——与上游一致，仍是 CDP 注入 + 本地守护进程。

> 与 WorkBuddy 官方无隶属关系，未获官方授权或认可。

---

## 平台路径映射

Linux 上 Electron 遵循 XDG 规范，userData 落在 `~/.local/share`（而非 macOS 的 `~/Library/Application Support`）。
本移植据此做了如下映射（均在 Ubuntu 26.04 + WorkBuddy 5.5.6 实测确认）：

| 项目 | macOS | Linux |
| --- | --- | --- |
| 客户端二进制 | `/Applications/WorkBuddy.app/Contents/MacOS/Electron` | `/opt/WorkBuddy/workbuddy` |
| 登录信息文件 | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` | `~/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| 会话数据库 | `~/.workbuddy/workbuddy.db` | `~/.workbuddy/workbuddy.db`（一致） |
| WorkDaddy 数据目录 | `~/Library/Application Support/WorkDaddy` | `~/.local/share/WorkDaddy`（`$XDG_DATA_HOME`） |

---

## 安装

### 方式 A：deb 包（Debian / Ubuntu，推荐）

```bash
sudo dpkg -i workdaddy_<版本>_amd64.deb
sudo apt -f install        # 若报依赖问题
```

装到 `/opt/WorkDaddy`，并提供两个命令：`workdaddy`（启动守护进程）、`workdaddy-cdp`（以 CDP 模式重启 WorkBuddy）。

### 方式 B：tar.gz（通用，免 root）

```bash
tar -xzf WorkDaddy-<版本>-linux-x64.tar.gz -C ~/.local/share/
bash ~/.local/share/WorkDaddy-linux/scripts/install-linux.sh
```

可选参数：

- `--profile workbuddy-ai`：国际版 WorkBuddy AI
- `--prefix <目录>`：指定安装位置
- `--systemd`：注册 `systemd --user` 开机自启（默认不注册，与 macOS 版行为一致）

### 依赖

- Node.js **>= 18**（deb 的 Depends 已声明 `nodejs`）
- 图形会话（X11 或 Wayland）——无 `DISPLAY`/`WAYLAND_DISPLAY` 时 WorkBuddy 无法启动
- 防休眠功能需要 `systemd-inhibit`（systemd 环境）；缺失时仅记录日志，不影响其他功能

---

## 使用

```bash
# 1) 在图形会话中执行：退出 WorkBuddy → 以 CDP 模式重启 → 启动守护进程
bash ~/.local/share/WorkDaddy-linux/scripts/relaunch-with-cdp-linux.sh

# deb 安装时可简写为
workdaddy-cdp
```

成功后 WorkBuddy 右下角会出现 WorkDaddy 机器人按钮。若未出现：

```bash
curl -X POST http://127.0.0.1:47832/api/inject
```

手动管理守护进程（未注册 systemd 时）：

```bash
WBSWITCH_PROFILE=workbuddy-cn nohup node ~/.local/share/WorkDaddy-linux/scripts/daemon.js \
  >> ~/.local/share/WorkDaddy/daemon.log 2>&1 &
```

管理界面：http://127.0.0.1:47832（国际版为 47833）

卸载：

```bash
bash ~/.local/share/WorkDaddy-linux/scripts/uninstall-linux.sh   # 加 --keep-data 保留账号备份
```

指定客户端位置（非 `/opt` 安装时）：

```bash
WBSWITCH_WORKBUDDY_BIN=/path/to/workbuddy bash scripts/relaunch-with-cdp-linux.sh
```

---

## 相对上游的改动清单

| 文件 | 改动 |
| --- | --- |
| `scripts/profiles.js` | 新增 `IS_LINUX`；`appSupport`/`localSupport` 走 `XDG_DATA_HOME`；`appPath()` 增加 Linux 分支（`/opt/<安装目录>/<可执行>`） |
| `scripts/lib.js` | 数据目录、HelloBuddy 旧目录、auth 文件路径均增加 Linux 分支 |
| `scripts/workbuddy-target.js` | 客户端目标解析在 Linux 上用 XDG 定位 auth 目录；`--configure` 接受 `linux` 平台 |
| `scripts/daemon.js` | 新增 `IS_LINUX`；二进制解析适配单文件可执行；`openPath()` 统一 open/xdg-open/start；休眠控制改用 `systemd-inhibit` / `systemctl suspend`；更新包改认 `.tar.gz` 并用 `tar -tzf` 预检；退出客户端跳过 AppleScript |
| `scripts/install-linux.sh` `uninstall-linux.sh` | 新增：用户级安装、可选 systemd 自启、干净卸载 |
| `scripts/relaunch-with-cdp-linux.sh` | 新增：CDP 模式重启（桌面文件自动发现客户端 + pkill 退出 + 端口验证） |
| `scripts/apply-update-linux.sh` | 新增：解包覆盖 + 重启守护进程，带失败回滚 |
| `scripts/build-linux-tar.sh` | 新增：stage 依赖并产出 `tar.gz` 与 `.deb` |
| `test/linux-port.test.js` | 新增 9 条 Linux 回归测试 |
| `.github/workflows/build-linux.yml` | 新增 Linux CI |

---

## 已知限制

1. **防锁屏**：Linux 无 `caffeinate -u` 等价物，防休眠走 `systemd-inhibit`（可阻止挂起），
   但屏保/空闲锁屏取决于桌面环境设置，Wayland 下可能无法完全阻止。
2. **自动更新**：需要 Release 中存在 `WorkDaddy-<版本>-linux-x64.tar.gz` 资产，
   本仓库的 CI 会在打 tag 时自动上传。
3. **企业定制客户端**：目前按 `/opt/<安装目录>/<可执行>` 约定发现，可用
   `WBSWITCH_WORKBUDDY_BIN` 或 `workbuddy-target.js --configure` 指定。
4. **未做真实 GUI 端到端验证的部分**：注入后的界面交互（面板点击、主题、暂存提示词）
   依赖 WorkBuddy 界面结构，Linux 客户端与 macOS 版本一致，理论上可工作，但需在实机确认。

---

## 安全提示

与上游一致：账号导出文件包含可恢复登录态的 token（AES-256-GCM 加密），
请像保护密码一样保存与传输，迁移完成后及时删除副本。
错误诊断（Sentry）默认开启，可在「关于」页关闭，或用 `WORKDADDY_TELEMETRY=0` 启动覆盖。

## 许可

沿用上游 **AGPL-3.0**（`SPDX-License-Identifier: AGPL-3.0-or-later`）。
