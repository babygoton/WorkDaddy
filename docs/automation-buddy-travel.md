# 派猫猫旅行（account.travel）

**状态**：v1.2.45 起提供。自动化新增 `account.travel`，用账号自己的 token 处理成长中心的
「派猫猫旅行」——未出发就派发，已到达就领取奖励，**全程不切换当前登录账号**。

官方接口前缀：`/activity/growth/buddy/travel/{config,status,depart,claim}`。

## 状态机

```
idle ──depart──▶ traveling ──(到达时间到)──▶ arrived ──claim──▶ idle
                      │                                          │
                      └────────── daily_limit_reached ───────────┘
```

| 官方 `state` | 自动模式下的动作 | 是否算「今日办完」 |
|---|---|---|
| `traveling` | 等待（`wait`） | **否** —— 到点还要领奖 |
| `arrived` | 领取（`claim`） | 领取成功才算 |
| `idle` + `daily_limit_reached=false` | 派发（`depart`） | 否（等下一轮确认） |
| `idle` + `daily_limit_reached=true` | 跳过（`skip: daily-limit`） | 是（今天的行程已派出） |
| 无法识别 / 请求失败 | 报错，**不派发** | 否 |

## 用法

```json
{
  "op": "account.travel",
  "mode": "auto",
  "saveAs": "travel"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `mode` | `auto`（默认）/ `depart` / `claim` | `auto` 按官方状态自动对账；`depart` 只派发；`claim` 只领取。其他值静态校验直接报错。 |
| `saveAs` | 变量名 | 把回执存到 `{{vars.<name>}}`。 |

回执字段：`ok`、`state`、`location`、`locationId`、`recordId`、`departAt`、`arriveAt`、
`rewardCredit`、`claimed`、`claimedAt`、`skip`、`message`、`skipped`、`summary`。
同样无需 `switch:true`（与 `account.checkin` 一致）。

内置任务 `scripts/builtin/automations/daily-buddy-travel.json`：每 15 分钟跑一轮
`account.forEach → logic.catch → account.travel(mode=auto)`，触发事件为
`clientLoaded` / `panelOpened`。**发布时 `enabled: false`**（与签到任务一致，由用户在自动化页自行开启）。

## 接口鉴权

与签到同一套约定（见 `scripts/checkin-result.js`）：

- Bearer token 取自账号备份 `%APPDATA%\WorkDaddy\accounts\<uid>.info` 的 `auth.accessToken`；
- **接口域名由 token 自己签发的 `iss` 决定**（`tokenIssuerOrigin` → `ISSUER_HOST_MAP`），
  读不到再退回备份里的 `auth.domain`，最后才用 profile 的 `apiHost`；
- 请求头带 `referer: <apiHost>/profile/growth-center`、`x-client-platform: web`、`x-codebuddy-request: 1`。

本机两个账号实测走的是**不同域名**（`www.workbuddy.cn` / `www.codebuddy.cn`），
两边接口都可用——所以 host 必须按账号推导，不能统一用 profile 的 `apiHost`。

## 能力开关

`scripts/profiles.js`：只有 `workbuddy-cn` 有 `travel: true`，其余客户端（`workbuddy-ai`、
`codebuddy-cn`、`codebuddy-intl`）为 `travel: false`——国际版没有派猫猫旅行。
不支持时 daemon 的 `/api/travel/status` 返回 `{ok:true, supported:false}`，
`/api/travel/run` 返回 400，`account.travel` 步骤抛「当前客户端不支持派猫猫旅行」。

## 缓存

`%APPDATA%\WorkDaddy\travel-cache.json`：

```json
{
  "date": "2026-09-17",
  "completed": false,
  "results": { "<uid>": { "state": "traveling", "arriveAt": 1789624926, "claimed": false, ... } }
}
```

- 跨日时把仍在飞的行程带过去，已完结的丢掉（`rollTravelCacheToToday`）；
- `completed` = **所有账号都到达终态**：奖励已领（含今日已派）、没有待重试项、
  且没有 `state === 'traveling'` 的行程。

> `completed` 早先只判断「有没有可重试项」，会把**行程在飞**误判成「今日已完成」。
> 虽然当时没有调用方拿它做短路（账号级每轮都重新查官方状态），但面板一旦用它当门控就会漏领，
> 所以 v1.2.45 改成上面的定义，并补了回归测试。

## 排错

| 日志 / 现象 | 含义 |
|---|---|
| `skip: retry-wait` | 派发失败后的 30 分钟冷却，下一轮再试（`TRAVEL_DEPART_RETRY_MS`） |
| `skip: daily-limit` | 今天的行程已经派出，不再重复派 |
| `skip: no-buddy` | 账号还没有猫猫，**可重试**，不会把当天标成完成 |
| `skip: no-location` / `config-error` | `/config` 拿不到可用地点 |
| `skip: claim-error` | 领取失败且不是已知的幂等情形，下一轮重试 |
| `message: 已领取（网页端）` | claim 报 `no unclaimed travel` / `daily_limit`，视为已领，避免死循环 |
| `message: 还没到达，下一轮再领` | claim 报 `not arrived yet`，状态按 `arrived` 保留 |

### 参考项目踩过的坑（这里都保留了处理）

1. **可重试的跳过不能把当天标成完成** —— 否则账号后面真有猫猫了也永不重试。
2. **HTTP 429 是限流，不是「今日已派」** —— `classifyDepartError` 把 429 归为 `other`，不当作 daily-limit。
3. **缺 `state` / 未知 `state` 不能当成 `idle`** —— 否则会误判成「可以派发」或「已经领了」。
4. **`/config` 没有 `enabled` 字段** —— 只有 `locations` 非空才代表可旅行；
   照搬「检查 enabled」的写法会把功能整片关掉。

## 真机验收（2026-09-17，v1.2.45）

补丁已实际部署到本机安装目录 `D:\Program Files\WorkDaddy\scripts`，结束 daemon 进程后由常驻
watchdog 用新代码拉起（无需重启 WorkBuddy）。安装目录 ACL 只给管理员写，部署走提权脚本，
改动前先按 `<文件>.bak-20260917-before-1.2.45` 备份。

启动日志确认版本生效：

```
[update] 检查完成: latest=1.2.2 hasUpdate=false (current=1.2.45)
```

只读接口 `GET /api/travel/status` → `200 {ok:true, supported:true, accounts:[2]}`。

`POST /api/travel/run {mode:"auto"}` 与**官方原始状态**逐字段对齐，两个账号当时都在飞，
正确判定为「等待」，**没有产生任何写操作**：

| uid | host | state | depart_at | arrive_at | 时长 | 预计奖励 | daily_limit_reached |
|---|---|---|---|---|---|---|---|
| `6cef00ac…` | www.workbuddy.cn | traveling | 12:02:06 | **14:02:06** | 2h | 8 | true |
| `d3144c2c…` | www.codebuddy.cn | traveling | 12:02:07 | **16:02:07** | 4h | 6 | true |

daemon 回执的 `recordId` / `arriveAt` / `rewardCredit` 与官方响应完全一致
（`6106861`/`6106869`、`1789624926`/`1789632127`、`8`/`6`）。

`/config` 返回 4 个地点（咖啡馆 / 商场店铺 / 健身房 / 古镇），
`duration_hours 1–4`、`reward_credit 5–10`。

### 零回归验证

在干净基线 worktree（`git worktree add <dir> HEAD`，即改动前的 9fe811e）上跑一遍完整套件，
再在改动后跑一遍，用同一口径对比失败清单：

| 套件 | 用例数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| 基线 HEAD `9fe811e` | 758 | 745 | 11 | 2 |
| 本次改动 | 791 | 781 | 8 | 2 |

**改动后没有任何新增失败**，改动后剩下的 8 项全部是基线里就存在的失败（Windows 启动器 / 原生流程 /
打包字节 / macOS 启动器 / 会话归档并发类）。基线里另外 3 项（`automation deep locator …`、
`real session export/import …`、`repeated encrypted imports …`）在两次运行间自行消失，
属于并行与文件锁导致的抖动，不是修复成果。

> 先用基线 worktree 取「哪些失败是环境固有的」，再判断自己有没有引入回归——
> 否则很容易把自己引入的问题混进固有失败里，或者反过来把固有失败当成自己的锅。

## 相关改动

| 文件 | 改动 |
|---|---|
| `scripts/growth-travel.js` | 新增。纯逻辑（状态机、失败分类、跨日缓存、记录合并、重试节流）+ HTTP 原语 + 汇总文案。 |
| `scripts/daemon.js` | 新增 `performAccountTravel` / `claimTravelForUid` / `travelBaseRecord` / `persistTravelRecord` / `travelApiHost`；`accountTravel` 运行依赖；`GET /api/travel/status` 与 `POST /api/travel/run`；启动时装载内置任务；版本递增到 1.2.45。 |
| `scripts/automation.js` | `account.travel` 目录条目与中英文协议说明、`mode` 静态校验、执行期透传。 |
| `scripts/automation-packages.js` | 任务包效果分析新增 `account-travel`。 |
| `scripts/profiles.js` | `workbuddy-cn` 加 `travel: true`，其余客户端加 `travel: false`。 |
| `scripts/inject.js` | 新增内置任务的英文名/说明与 3 条旅行运行文案；`wbsIsBuiltinAutomation` 与 `wbsBuiltinAutomationText` 的默认文案表加入 `daily-buddy-travel`。 |
| `scripts/builtin/automations/daily-buddy-travel.json` | 新增内置任务（15 分钟一轮，默认关闭）。 |
| `scripts/build-mac-dmg.sh` | 打包清单加入 `growth-travel.js`。 |
| `test/growth-travel.test.js` | 新增回归测试 33 项（纯逻辑 / HTTP 原语 / 协议接线三层）。 |

### 顺带维护的既有测试

这个仓库对「内置任务」和「daemon 文案」有硬断言，新增第 4 个内置任务必然会碰到：

| 测试 | 改动 |
|---|---|
| `test/automation-calendar.test.js` | 内置任务数量 3 → 4。 |
| `test/automation-checkin.test.js` | 预设断言按 profile 的能力开关区分（`workbuddy-cn` 4 个，`workbuddy-ai` 3 个）。 |
| `test/automation-model.test.js` | daemon 版本断言 1.2.44 → 1.2.45（该测试的作用是「改 daemon 必须递增版本」）。 |
| `test/i18n.test.js` / `test/i18n-coverage.test.js` | 无需改动，靠 `inject.js` 的字典与默认文案表补齐。 |

> **踩到的坑**：`i18n-coverage.test.js` 的 `extractKeys()` 只用 `/'([^']+)':\s*'[^']*'/g`
> 提取字典键，**双引号条目对它不可见**。新增 daemon 文案时若跟着邻近条目用双引号，
> 「daemon 中文文案全覆盖」这条断言就会报未覆盖，而翻译本身是正常工作的。
>
> **另一个坑**：`checkin-consent-start.test.js` 用 `daemon.indexOf('}, httpRequest:', a)`
> 按源码切片来构造签到函数，隐含要求 `accountCheckin` 后面**紧跟** `, httpRequest:`。
> 新的 `accountTravel` 依赖必须插在 `accountCheckin` **之前**，插在后面会让这个切片
> 多包一段箭头函数体、直接变成语法错误。

## 已知限制

1. **每天一次**：官方是每日一次出行；`daily_limit_reached` 之后不会再派，只能等跨日。
2. **时长与奖励由官方随机**（1–4 小时、5–10 积分），脚本只是照状态执行，不干预选点。
3. **自动领取依赖到点后的下一轮**：内置任务 15 分钟一轮，所以实际领取时间在到达后 0–15 分钟内。
4. **只能读本机账号备份**：账号没做过备份（没有 `.info`）时返回 `skip: no-backup`。
5. **`claim` 幂等但不可重放判定**：官方接口在「网页端已领」时返回
   `no unclaimed travel`，这种情况按已领取处理，不会重复发奖。
