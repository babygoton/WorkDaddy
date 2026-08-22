# Session Evidence: 支持 WorkBuddy AI 国际版（全功能适配与会话/模型数据目录归正）

日期：2026-08-22

## 1. 问题与根因

1. **账号识别失败**：WorkBuddy AI 国际版将认证信息写入 `workbuddy-desktop-ai.info`（带 `-ai` 后缀），原代码硬编码 `workbuddy-desktop.info`，导致 `backupCurrent` 报错 ENOENT，`accounts/` 目录为空。
2. **登录跳转 CN 域名**：无感登录端点硬编码 `https://www.codebuddy.cn`，AI 国际版 API 域名为 `https://www.workbuddy.ai`。
3. **会话与模型无法读取（数据目录错位）**：
   - 原代码硬编码读取用户目录下的 `~/.workbuddy/workbuddy.db` 和 `~/.workbuddy/models.json`；
   - 实际 WorkBuddy AI 国际版的数据根目录为 **`~/.workbuddy-ai/`**（内含真实的会话数据库与模型配置）。
4. **前端刷新与列表跳动**：
   - 注入脚本中 `window.__wbsWidget.refresh` 依赖未赋值的 `state._refresh`，导致 CDP 自动刷新失效。现已完成真实函数绑定。
   - 积分拉取完成后通过排序重排 DOM 卡片导致视觉跳动，现已改为当前账号置顶、其余按最近使用时间稳定排列，积分原地加载。
5. **启动黑窗口与多重空白窗口**：
   - 窗口置前桥接中缺少对无标题 Chromium 辅助子窗口（IME、渲染管道辅助 HWND）的过滤，导致内部隐藏窗口被全量显示。
   - 窗口激活子进程缺少 `windowsHide: true` 与 `stdio: 'ignore'`，导致在 Windows Terminal 环境下闪现黑框控制台。

## 2. 修改文件清单

- `scripts/lib.js`：
  - 增加 `AUTH_FILES`（国内版与 AI 国际版双候选）
  - 增加 `detectEdition`、`workbuddyHomeDir`（动态识别 `~/.workbuddy-ai` 或 `~/.workbuddy` 数据目录）
  - 增加 `setEdition`、`currentEdition`、`resolveAuthFile`、`targetAuthFileForAccount`
  - `workbuddyModelsFile` 动态跟随环境数据目录
  - `switchTo` 按账号自身 `auth.domain` 与锁定环境写入对应的登录文件
- `scripts/daemon.js`：
  - 启动时调用 `detectStartupEdition` 锁定环境版本
  - `sessionsDbFile`、会话文件复制与删除、`settings.json` 全部对接 `workbuddyHomeDir()`
  - 无感登录使用 `WB_API_ENDPOINTS`（`cn: codebuddy.cn` / `ai: workbuddy.ai`）
  - 签到/积分接口按环境版本分别路由到 `workbuddy.cn` 或 `workbuddy.ai`
  - Windows 进程名兼容 `WorkBuddyAI.exe`
  - 窗口恢复严格过滤标题，只还原带合法标题的主工作区窗口
- `scripts/inject.js`：
  - 发起无感登录时上报宿主环境版本（`location.href` 识别 `WorkBuddyAI`）
  - `state._refresh` 绑定真实刷新函数，支持 CDP 与 Tab 切换实时更新
  - 移除导致列表跳动的异步 DOM 重排逻辑，改为稳定排序与就地刷新
- `scripts/win-launcher.js`：
  - 进程探测与退出兼容 `WorkBuddy.exe` 与 `WorkBuddyAI.exe`
  - 窗口恢复严格限制在有效标题的主窗口，杜绝无效辅助窗口弹出
  - 移除多余的控制台弹窗，子进程全部添加隐藏参数
- `scripts/relaunch-with-cdp.sh`：
  - macOS 启动脚本支持 `workbuddy-desktop-ai.info` 探测
- `test/auth-edition.test.js`：
  - 新增 9 项环境探测、版本锁定、接口路由的单元与契约测试
- `test/auto-copy-rules.test.js`、`test/update-layout.test.js`：
  - 修复 Windows 大小写归一化及缺失打包产物时的断言平台兼容

## 3. 验证命令与结果

1. 语法与静态检查：
   ```bash
   node --check scripts/daemon.js
   node --check scripts/inject.js
   node --check scripts/win-launcher.js
   node --check scripts/lib.js
   git diff --check
   ```
   结果：全部 PASS，无语法错误，无空白字符问题。

2. 全量单元测试：
   ```bash
   node --test test/*.test.js
   ```
   结果：`pass 42, fail 0, skipped 1`（1 处 macOS 产物跳过），43 项用例全部通过。

3. 本机实机运行验证：
   - 会话列表已成功读取 `~/.workbuddy-ai/workbuddy.db` 中的当前会话，支持手动复制与跨账号自动复制
   - 模型列表已成功读取 `~/.workbuddy-ai/models.json` 中的 8 个可用模型
   - 快捷方式启动无黑窗口，1 秒内平滑聚焦置前 WorkBuddy
   - 4 个账号完整入库，无感登录实时同步，列表无跳动
