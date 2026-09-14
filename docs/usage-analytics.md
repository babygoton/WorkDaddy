# 匿名用户数和日活

`scripts/usage-report.js` 向 `https://workdaddy.dev/api/track` 上报匿名安装活跃状态。服务端源码、部署步骤和查看入口见相邻官网项目 `analytics/README.md`；生产统计页为 `https://workdaddy.dev/api/track/dashboard`，需要管理密钥。

- 使用现有 `sentry-report.js` 的共享随机 `installation-id`，不读取账号作为用户标识。仅持久化成功的 ID 可上报，避免临时随机 ID 膨胀安装数。
- 同一安装的 CN/AI/profile 共用 `usage-state.json` 和 `.usage-report.lock`，文件位于 WorkDaddy 共享数据目录。`WBSWITCH_SHARED_DATA_DIR` 可覆盖共享目录，便于隔离测试。
- 获得焦点的可见 renderer 初次加载或真实键鼠/窗口事件触发无内容的本地 `POST /api/usage`，受现有 profile API Token 校验。事件不读取输入、按键值、DOM 内容或坐标；监听器通过 build lifecycle 清理。
- renderer 的本地请求每小时最多一次，北京时间跨天后可立即触发。后台守护进程和自动化不会自行发送活跃事件。
- 匿名安装数和日活独立统计，不受 About 页「发送错误诊断」或 `WORKDADDY_TELEMETRY` 影响；关闭错误诊断不会取消匿名统计请求。错误诊断本身仍遵循原有开关和环境变量优先级，About 页说明同步展示这一区别。
- 每天最多成功一次；失败最少间隔 6 小时、每日最多尝试 3 次，重启不清零。不补报历史活跃。每次请求总超时 5 秒，不跟随重定向；仅 HTTP 204 且携带服务端确认头视作成功，官网静态兜底 200 不算成功。
- 本地配额先写盘再发送，写盘失败、状态损坏或持久标识缺失时跳过上报。异常退出留下的空锁目录 60 秒后可回收。状态损坏需要人工检查共享目录中的 `usage-state.json`，不要删除账号目录或 `installation-id`。
- 上报仅含随机安装标识、profile、WorkDaddy 版本、系统、架构和 `os.release()` 内核版本。服务端可补充出口国家，不保存 IP。没有功能使用事件、账号、会话、输入内容、硬件序列号。

统计用户数是自该版本启用后被服务端观测到的安装数；不代表自然人数，未升级或没有成功发送活跃请求的用户不会计入。同一电脑保留共享数据重装仍算一个安装；更换电脑或删除共享数据则算新安装。

验证：`node --test test/usage-report.test.js test/usage-activity.test.js test/sentry.test.js`，并执行仓库全量测试。发布时必须包含新 `usage-report.js`；macOS 构建清单已同步，Windows 继续沿用 scripts 目录整体复制。
