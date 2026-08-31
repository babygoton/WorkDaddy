# WorkDaddy

> **WorkDaddy 是 WorkBuddy 桌面端增强助手：多账号独立备份、点切即用；免打扰模式让 AI 无人值守跑长任务；跨账号会话迁移、异常中断自动续接；暂存/快捷提示词；毛玻璃主题与更多实用功能，账号与配置全部留在本机。**
> 本机回环 CDP 注入 · 不改官方安装包。

一个基于 **Chrome DevTools Protocol (CDP)** 的 [WorkBuddy](https://www.workbuddy.cn/)、[WorkBuddy AI](https://www.workbuddy.ai/) 桌面端增强工具。
零侵入、零重签名——只把界面组件注入到正在运行的 WorkBuddy 渲染进程里。

![License](https://img.shields.io/badge/license-AGPL--3.0-blueviolet)
![Platform](https://img.shields.io/badge/platform-macOS%2011%2B%20%7C%20Windows%2010%2F11-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A518-green)


---

## 演示

**面板预览**
![面板预览图](docs/images/accounts.png)

**输入框预览**
![输入框预览图](docs/images/input1.jpg)
![输入框预览图](docs/images/input2.png)

**主题效果（非最新版）**
![WorkDaddy 演示](docs/images/demo.gif)

---

## 它能做什么

- **方便切换账号**：每个 WorkBuddy 账号独立备份，点一下就切，再也不用每次扫码。
- **无感登录新账号**：「登录新账号」支持免退出 OAuth 授权——不退出 WorkBuddy，在浏览器完成扫码后新账号自动加入列表；也可选传统的「假退出」方式回登录页扫码。
- **账号导入导出**：把全部账号备份加密导出，在另一台电脑安装 WorkDaddy 后一键导入，方便电脑之间迁移账号。
- **自动领每日积分**：打开面板即对全部账号静默签到，幂等缓存，不打断你。
- **权限弹窗免打扰**：真正的零决策弹窗弹出，可以放心开启任务后睡觉。
- **暂存提示词**：输入框边上一键把草稿「暂存」到待发送队列——图片 / 文件 / 引用原样保留，择机发送。
- **切换精美主题**：内置毛玻璃官方主题，多套预设壁纸，支持自定义壁纸。
- **账号间会话迁移**：自动或手动跨账号复制会话，跨账号继续接龙。
- **模型切换更便捷**：解决 WorkBuddy 不支持添加多个同名模型的问题。
- **防止电脑休眠**：睡前任务未完成，开启休眠模式，任务结束后自动切换成允许休眠。
- **异常中断会话自动继续**：AI 回复因网络波动、超时等原因中断时，自动让异常中断任务继续执行。
- **快捷短语**：常用语存进面板，输入框操作栏一键点发；


---

## 安装

>- 国内版 [WorkBuddy](https://www.workbuddy.cn/) 请下载 `WorkDaddy` 安装包
>- 国际版 [WorkBuddy AI](https://www.workbuddy.ai/) 请下载 `WorkDaddy AI` 安装包

### macOS

1. 在 [Releases](../../releases) 下载最新 `WorkDaddy-x.y.z.dmg`
2. 打开 dmg，把 `WorkDaddy.app` 拖进 **应用程序** 文件夹
3. 第一次打开如果遇到「无法打开，因为 Apple 无法检查恶意软件」：
   1. 打开「系统设置 → 隐私与安全性」
   2. 在「WorkDaddy 已被阻止」处点 **仍要打开**
   3. 输入开机密码确认
   ![安装引导](docs/images/install-guide.png)

4. 双击 `WorkDaddy.app` 启动：它会自带守护进程并把组件注入到 WorkBuddy
5. 看到机器人按钮？**搞定**。


### Windows

1. 在 [Releases](../../releases) 下载对应客户端的 `WorkDaddy-Setup-x.y.z.exe` 或 `WorkDaddy-AI-Setup-x.y.z.exe`
2. 双击安装器完成安装
3. 双击打开 `WorkDaddy` 或 `WorkDaddy AI` 桌面快捷方式

#### 企业专享版 / VPC 客户端

企业专享版用户仍安装与界面最接近的 `WorkDaddy` 或 `WorkDaddy AI`。安装程序会先自动识别对应的官方客户端，并在安装向导中显示路径和版本；企业版用户点击「浏览」改选自己的 `.exe` 主程序即可，不需要修改配置文件或设置系统环境变量。

选择结果保存在 WorkDaddy 的个人数据目录中。更新安装默认保留上次选择，也可以在安装向导中修改；需要改回官方客户端时，重新运行安装程序并选择自动识别出的官方 `.exe`。WorkDaddy 会锁定所选客户端版本，客户端升级或移动后同样通过安装程序重新确认。


### 从源码运行（开发者）

```bash
git clone https://github.com/babygoton/WorkDaddy.git
cd WorkDaddy
bash scripts/install.sh        # 创建备份目录 + 启动守护进程
bash scripts/relaunch-with-cdp.sh   # 把 WorkBuddy 切换到调试模式（端口 9222）
```

WorkBuddy 国内版和 WorkBuddy AI 使用同一套 daemon，通过 profile 绑定客户端，不靠“第一个 CDP 端口”猜测目标：

```bash
WBSWITCH_PROFILE=workbuddy-cn bash scripts/relaunch-with-cdp.sh
WBSWITCH_PROFILE=workbuddy-ai bash scripts/relaunch-with-cdp.sh
```

暂存提示词和主题功能在两个 WorkBuddy profile 开启。CodeBuddy profile 的适配暂缓，不进入当前发布包。

当前发布脚本只打包两个 WorkBuddy 客户端，共 4 个包：`WorkDaddy-<version>.dmg`、`WorkDaddy-AI-<version>.dmg`，以及对应的 `-win64.zip`；传 `WORKDADDY_BUILD_PROFILE=workbuddy-cn` 或 `workbuddy-ai` 可单独重打一个客户端。CodeBuddy profile 代码暂不进入发布包。

`install.sh` 做了：

- 创建 `~/Library/Application Support/WorkDaddy` 备份目录
- 首次启动自动兼容迁移旧版 `~/Library/Application Support/HelloBuddy/accounts` 账号备份（旧目录保留不删除）
- 首次备份当前 WorkBuddy 账号
- 清理旧 launchd 注册并手动启动守护进程（不再登录自启）
- 立即启动后台守护进程
- 打开管理界面 `http://127.0.0.1:47832`

> 守护进程会在安装结束时手动启动；需要使用时手动启动对应的 WorkDaddy 端即可。

---

## 原理

**CDP 注入 · 不改官方安装包**

```
┌─────────────┐  --remote-debugging-port=9222  ┌──────────────┐
│  WorkBuddy  │ <───────────────────────────> │  WorkDaddy   │
│  (Electron) │       Chrome DevTools          │   daemon.js  │
│             │        Protocol (CDP)          │              │
│  渲染进程    │  ←── Runtime.evaluate ────     │  HTTP :47832 │
│  右下角     │      注入 inject.js            │  本地 API    │
└─────────────┘                                └──────────────┘
```

1. **不修改 WorkBuddy 二进制**：用 `launcher` 启动 WorkBuddy 时多带一个 `--remote-debugging-port=9222` 参数，**二进制与签名原封不动**。
2. **守护进程通过 CDP 连接 WorkBuddy**：监听登录/认证网络事件 + 文件监听兜底，每次登录/刷新令牌都把当前登录信息按 `account.uid` 备份到稳定目录。
3. **注入界面组件**：`Runtime.evaluate` 把 `inject.js` 推到渲染进程执行，在右下角渲染机器人按钮和 7 标签页面板（账号 / 主题 / 会话 / 模型 / 增强 / 电脑 / 关于）。
4. **本地 HTTP API**：daemon 在 `127.0.0.1:47832` 起服务，组件通过 fetch 调用（账号切换、主题应用、签到、决策弹窗开关、休眠控制等）。
5. **数据边界清晰**：账号备份和本地配置保存在本机；按功能访问 WorkBuddy 官方 API（登录、积分）和 GitHub Releases（更新检查），显式执行模型连通测试时会向你配置的模型服务发送请求及对应 API Key；默认不发送诊断遥测。

> 为什么用 CDP 而不是官方插件机制：直接面向运行中的应用实例，事件级感知登录变化，
> 主动注入界面与样式补丁，**官方升级 WorkBuddy 后只要界面没大改就照常工作**。

---

## 使用

### 面板

WorkBuddy 右下角的机器人按钮 → 弹出面板 → 选你要的操作：

| Tab      | 能做什么 |
| -------- | -------- |
| **账号** | 查看账号数、积分、签到和登录状态；切换、删除或登录新账号，并加密导入导出账号备份 |
| **主题** | 切换默认 / WorkDaddy 主题，选择或上传壁纸、更换头像，调整毛玻璃和背景蒙版 |
| **会话** | 按账号和时间筛选会话，批量复制或删除，并设置会话 / 工作空间在切换账号时自动复制 |
| **模型** | 管理当前模型和备选模型，支持备份、复制、编辑、启用、连通测试及批量删除 |
| **增强** | 配置权限免打扰、异常中断自动续接、暂存提示词和快捷短语 |
| **电脑** | 允许或持续禁止休眠，也可在所有 AI 任务结束后自动恢复休眠 |
| **关于** | 查看版本和项目说明、检查并安装更新、控制脱敏错误诊断 |

**输入框插件**：在「增强」页分别开启「暂存提示词」和「快捷短语」后，输入框操作栏会显示对应按钮。
暂存提示词可把当前草稿（文字、图片、文件、引用等**完整原样**）加入 WorkBuddy 自带的待发送队列，并暂停自动发送；
入队后输入框自动清空，内容按会话独立保存，可随时发送、编辑或删除。快捷短语可在增强页新增、编辑和批量管理，并从输入框操作栏一键发送，发送后不会自动删除。

### 账号迁移到其他电脑

在账号页右上角使用「导出」和「导入」按钮即可迁移全部账号：

1. 在旧电脑打开 WorkDaddy 账号页，点击「导出」，保存生成的 `WorkDaddy-账号导出-YYYY-MM-DD.json` 文件。
2. 用安全方式把导出文件传到新电脑，并在新电脑安装、启动 WorkDaddy。
3. 打开账号页点击「导入」，选择导出文件；导入完成后即可在账号列表中切换恢复的账号。

新版导出会使用你输入的密码、每次导出随机 salt 和 AES-256-GCM 加密；密码不会写入导出文件。文件中仍包含可恢复登录状态的 token，请像保护密码一样安全保存和传输，迁移完成后及时删除不再需要的副本。旧版 v1 导出仍可兼容导入。


## 安全与隐私

- **本地数据优先**：账号备份、主题和本地配置不会在后台上传；登录、积分等功能会访问 WorkBuddy 官方 API，自动更新会访问 GitHub Releases；显式执行模型连通测试时，会向你配置的第三方模型地址发送请求及对应 API Key。
- **发送错误诊断默认开启**：关于页的「发送错误诊断」开关同时控制 Sentry 远程错误诊断和本地脱敏渲染器日志，帮助定位版本和兼容性问题；处理内容经过脱敏、截断，远程上报不包含账号、会话内容、Token 或 API Key。随时可以在关于页关闭；`WORKDADDY_TELEMETRY=0`/`1` 可作为启动时的明确关闭/开启覆盖。

完整威胁模型见 [`SECURITY.md`](SECURITY.md)（可选；未提供时本节即为完整说明）。

---

## 许可与声明

本项目采用 **[GNU Affero General Public License v3.0](LICENSE)** 开源（`SPDX-License-Identifier: AGPL-3.0-or-later`）。

- 本项目仅面向本机运行的 WorkBuddy 桌面端做界面与体验增强，**与 WorkBuddy 官方无隶属关系**。
- WorkBuddy、其商标、官方资源归其权利人所有；本项目未获得其官方授权或认可。
- 第三方主题、壁纸、背景图等素材仅作演示，商用前请自行确认权利。

---

## 社区支持

[Linux.do](https://linux.do/)
