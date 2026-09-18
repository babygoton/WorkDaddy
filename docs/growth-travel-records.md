# 派猫猫旅行：用官方行程历史做权威对账

派猫进自动化后（`account.travel`），「今天到底领完没」是由本地缓存推断的（`rollTravelCacheToToday` / `mergeTravelRecord` / `travelCacheCompleted`）。缓存能节流 —— 多账号并发去重、派发重试间隔 —— 但它答不了终局问题：跨日、以及缓存和官方 `status` 不同步时，只能猜。

服务端本来就有确定答案：`GET /activity/growth/buddy/travel/records`。

`scripts/growth-travel-records.js` 把它做成**零依赖的只读模块**（无 `require`，纯函数 + 一个只读接口，22 项单测）。

## 实测语义

用真实账号 42 条历史记录逐条比对出来，跟直觉相反的两条：

| 观察 | 结论 |
| --- | --- |
| 猫已到家（`status.state === 'arrived'`）、那趟有 `record_id`，但它在两页 `records` 里都查不到 | `records` **只含已领取的行程**，待领取的不出现 |
| `travel_date` 与 `depart_at` 的日期 8/8 一致 | `travel_date` 是**出发日**，不是到达日 |
| 最近 6 笔里 5 笔的 `claimed_at` 日期 ≠ `travel_date` | **领取跨天是常态**（09-11 出发的行程 09-13 才领） |

第三条是关键：`travel_date === 今天` 回答的是「**今天的配额被用掉了**」，不是「今天领过奖」。拿它判断「今天领完没」，会把跨天补领的那一天漏掉。

## 三个问题分开答

| 问题 | 数据源 |
| --- | --- |
| 今天配额用掉没 | `/travel/status` 的 `daily_limit_reached` |
| 现在有要领的吗 | `/travel/status` 的 `state === 'arrived'` |
| 今天领过没 | `records` 里 `claimed_at` 落在今天的记录（本模块） |

前两问只能问 `status` —— 待领取的行程不进 `records`。所以本模块只做**终局判定**，不做「还有没有活要干」。

## 用法

```js
const { reconcileToday, readDaySettlement } = require('./growth-travel-records');

const { ok, today, reconciliation, error } = await reconcileToday({
  apiHost,      // 默认 https://www.workbuddy.cn
  accessToken,
  serverNow,    // 用 `/travel/status` 的 server_now，不要用本机时钟
});

readDaySettlement({ status, reconciliation });
// → { state, needsClaim, canDepart, claimedToday, dailyLimitReached, settled }
```

- `status` 可以**原样传** `/travel/status` 的 `data`：模块同时认服务端的 snake_case 和归一化后的 camelCase。
- 「今天」按成长中心口径（+08）显式换算，不依赖本机时区 —— 跨零点前后才不会把「昨天那趟」认成今天的。
- `fetchImpl` / `page` / `pageSize` / `timeoutMs` 可注入，单测不联网。
- 接口失败一律返回 `ok: false` 并带上 `error`，**绝不推断成「今天没派」**；调用方据此退回缓存推断。

模块导出：`fetchTravelRecords` / `reconcileToday` / `reconcileTravelRecords` / `readDaySettlement` / `travelDateKey` / `normalizeTravelRecord`。

## 还没接线的部分

模块只做只读接口 + 纯函数：不读不写本地文件，也不改 `growth-travel.js` 的既有结构。接线只需要一处 —— 用它给今天的 prior 记录做一次权威 seeding：

```js
const settlement = readDaySettlement({
  status,
  reconciliation: await reconcileToday({ apiHost, accessToken, serverNow: status.server_now }),
});
```

缓存继续负责它擅长的部分（多账号并发去重、`TRAVEL_DEPART_RETRY_MS` 的派发重试间隔），records 负责终局判定。等 `#203` 进 `main` 之后接这一段，那时也才知道 `planTravelStep` 的入参具体长什么样。
