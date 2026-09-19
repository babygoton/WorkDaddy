# 会话分叉（对标 Codex 桌面版的 Fork）

WorkBuddy 没有原生的「分支」按钮：想换个方向继续聊，只能整条会话倒回来，把之前走歪的几百轮一起背着走。Codex 桌面版的做法是每条消息旁挂一个分叉图标，**新会话只保留到所选回复为止，后面的不保留**（代码不回滚）。

本功能自 1.2.3 起随版本发布：增强页有开关，每条 AI 回复的完成页脚上有一个分支图标。

## 怎么用

1. 增强页打开**会话分支**（默认开启，只有被显式关掉才不显示按钮）。
2. 每条 AI 回复底部会出现一个分支图标，悬停提示：*复制到这条回复为止的聊天内容，在当前工作区继续聊；原会话不变。*
3. 点它 → 提示「正在创建分支会话…」→ 成功后页面刷新并自动打开新会话。

新会话标题是原标题加后缀「（分支）」（超长会截断），状态为 `Pending`。

要强调的是：**原会话一个字节都不会改。** 分叉只是复制一份前缀出来。

## 机制

会话记录是逐行 JSON，落在数据根的 `projects/<工作区slug>/<会话id>.jsonl`：

```
<data-root>/projects/<slug>/<session-id>.jsonl
```

这与 `daemon.js` 里 `collectSessionArchiveFiles()` 收集会话产物的口径一致 —— 会话迁移本来就靠搬运这个文件 + 各产物目录 + 插入一行 `sessions` 记录。**所以分叉不需要新机制，只需要在写入前把记录截断。**

### 锚点

锚点 = 记录里 `type === 'message'`、角色为 `user` / `assistant`、且**有可见正文**的消息，按出现顺序从 1 编号。工具调用、思考、文件快照都不计入锚点。

两条解析上的处理：

- `user` 消息先抽 `<user_query>…</user_query>` 里的正文。harness 的注入块（`<system-reminder>` / `<cb_summary>` / `<additional_data>` / `<identity_context>` / `<task-notification>`）与用户真话可能落在同一条记录里，**先抽再判**才不会把真话一起丢掉。
- 抽不到、且整条以注入块开头的 `user` 记录直接跳过，不占锚点序号。

### 切点

记录顺序是「消息正文 → 该轮的工具调用与结果 → 下一条消息」。切点取**下一条 `message` 记录之前**：

- 保留的是完整的一轮，不会留下没有结果的 `function_call`；
- 锚点之后的新对话内容一条都不进来。

### 不做区间切片

只支持「保留前缀到某个锚点为止」。丢掉前缀会让新会话从半轮开始、缺少开头的 user 消息，反而不可用——这不是保守，是那个产物本身没有意义。

### 保留原始行

切片按**原始行**拼接，不重新序列化 JSON。这样未知字段、数字精度、转义方式都原样保留。

## 渲染层与记录层不是同一份东西

这是分叉里最容易做错的地方，也是 1.2.3 那次修复（`51cb3a1c`）针对的问题。

界面上看到的消息序列，和 `.jsonl` 里的记录序列**形状并不一致**：

- 一轮流式回复在界面上是**一条**消息，落盘时可能是**好几条** assistant 记录；
- `task-notification` 之类的 `user` 记录在界面上被隐藏，文件里却实实在在存在。

所以**不能拿界面的下标直接去切文件**——差一条就切错位置，而切错是静默的：新会话照样创建成功，只是从错误的轮次开始。

### 做法：只有角色序列一致时才信位置

前端不上报消息 ID（渲染层的 ID 不是 JSONL 的记录 ID），只上报三样东西：**按顺序的角色串**、**所选消息的下标**、**该回复的完成时间**。

后端 `planForkAtMessage()` 拿到记录后，按同样口径拼出角色串 `rawRoles`，然后走两条路：

| 情况 | 定位方式 |
| --- | --- |
| `rawRoles === roles` | 两边记录形状一致，直接用 `messageIndex` 定位（连续 assistant 记录的流式会话也在此列） |
| 不一致 | 用 `finishedAt` 精确匹配 assistant 记录的 `timestamp`；再退一步取差值 ≤ 30 秒的最近一条 |

最后统一终检：必须命中、必须是 assistant、时间戳为正、且 `|记录时间 − finishedAt| ≤ 30 秒`。任一条不满足就报「无法确认所选消息的分支位置」。

**为什么要留 30 秒容差**：两边的时间来源不同，精确相等未必成立；而容差再放大就可能匹配到相邻的一轮，反而制造静默错切。宁可报错让用户重试，也不猜一个位置。

## 落库（daemon）

前端点按钮后 `POST /api/sessions/fork`：

```json
{ "id": "<会话ID>", "messageIndex": 12, "roles": "uauaua...", "finishedAt": 1789812497329 }
```

`createForkSession()` 依次做这些事：

1. 只认 `projects/<slug>/<当前会话ID>.jsonl` 这一个文件；匹配不到或不唯一就报错。
2. 校验是普通文件且 ≤ 64 MiB；读入后**再比一次字节长度**——长度不符说明文件正在被追加写，报「源会话记录已变化，请重试」。
3. `planForkAtMessage()` 算出要保留的记录文本；任一条拒绝原因都**原样上报**，不降级。
4. 用 `crypto.randomUUID()` 生成新 ID，写到同目录 `<新ID>.jsonl`，以 `flag: 'wx'`（不覆盖已存在文件）和 `0o600` 权限落盘。
5. `insertCopiedSession()` 插入 `sessions` 行：标题换成 `forkedTitle()` 的结果（加后缀「（分支）」、上限 60 字符），状态 `Pending`，`is_background_automation` 置 0，三个时间戳都取当前时刻。
6. **插入失败就把刚写的文件删掉再抛错**，不留半成品。

前置检查：仅 `workbuddy` 类型 profile、必须存在当前账号、会话必须属于该账号且未删除。

前端拿到成功响应后，把新会话 ID 记进 `sessionStorage`，刷新页面再自动点开它；15 秒内没在列表里找到就提示用户自己找，这条待打开记录 45 秒后过期。

前端在发请求之前还有一道自检：消息数超过 10000、或序列里出现非 user / assistant 的消息、或所选那条不是已完成的 assistant（`complete === false` / `isEnd === false` / 完成时间不合法），一律不发请求，直接提示「无法确认所选消息的分支位置，请稍后重试」。

## 拒绝条件一览（fail closed）

| 情形 | 结果 |
| --- | --- |
| 记录里存在解析不了的坏行（文件正在写入） | 拒绝：会话记录正在写入或包含损坏的行 |
| 角色串 / 下标 / 完成时间不合法 | 拒绝：分支消息参数无效 |
| 位置和时间都对不上 | 拒绝：无法确认所选消息的分支位置 |
| 所选消息没有可分支的正文 | 拒绝：所选消息没有可分支的正文 |
| 记录为空 / 没有可分叉的消息 / 锚点解析不出来 | 拒绝并说明原因 |
| 分叉点之前没有可保留的消息 | 拒绝：分叉点之前没有可保留的消息 |
| 源文件缺失、不唯一、非普通文件、或 > 64 MiB | 拒绝：无法唯一定位源会话记录 / 源会话记录不可读取 |
| 索引文件与磁盘不一致 | 拒绝：源会话记录已变化，请重试 |

这套设计的原则是：**宁可让用户重试，也不静默挑一个位置切错。**

## CLI

同一份逻辑也有命令行入口，便于离线检查与自动化调用：

```bash
# 打锚点清单
node scripts/session-fork.js --id <会话ID> --points [--max 60]

# 从第 12 条消息分叉
node scripts/session-fork.js --id <会话ID> --until 12 [--out <文件>] [--json]

# 按时间点分叉
node scripts/session-fork.js --id <会话ID> --until "09-17 15:30"

# 直接指定记录文件，并自定义标题后缀
node scripts/session-fork.js --file <记录文件> --until 7 [--suffix "（副本）"]
```

- `--data-dir <路径>` 指定数据根，缺省用当前 profile（`lib.js` 的 `defaultDataDir()`）。
- `--out <文件>` 把分叉后的记录文本写到指定文件；`--dry-run` 配合 `--out` 时只回显不落盘。
- `--json` 输出结果摘要（锚点、保留/丢弃条数），便于面板或自动化调用。
- 锚点解析不出来、记录为空、会话里没有可分叉的消息 —— 一律**报错退出（exit 1）**，不静默挑一个默认锚点。

模块导出：`parseRecords` / `buildAnchors` / `resolveAnchor` / `cutIndexFor` / `planFork` / **`planForkAtMessage`** / `forkedTitle` / `findSessionFile` / `describeAnchor`。

`session-fork.js` 整体是纯计算：不写数据库、不改任何文件，落库全部由 `daemon.js` 完成。

## 相关文件

| 文件 | 职责 |
| --- | --- |
| `scripts/session-fork.js` | 解析、锚点、切片、标题、`planFork` / `planForkAtMessage`、CLI |
| `scripts/workbuddy-compat.js` | `findSessionForkSelection()`：从渲染层取出角色串 / 下标 / 完成时间 |
| `scripts/inject.js` | 增强页开关、页脚分支按钮与悬停提示、失败提示、刷新后自动打开新会话 |
| `scripts/daemon.js` | `POST /api/sessions/fork` → `createForkSession()` 落库 |

## 验证

- `node --check scripts/session-fork.js` 通过。
- `node --test test/session-fork.test.js test/session-fork-integration.test.js`：**21 项全通过**（单元 15 + 集成 6）。
  - 单元覆盖：坏行跳过、锚点编号与注入块剥离、`<user_query>` 与注入块同行时的抽取、assistant 锚点保留本轮工具调用、user 锚点丢弃紧随其后的回复、末尾锚点丢弃数为 0、输出行逐字等于原文且不改动入参、按数字 / `#n` / 时间解析锚点、四种失败路径、标题截断、多工作区下按 ID 定位文件；以及**渲染层下标只在角色串与完成时间都对上时才被采用**（含连续 assistant 记录、被隐藏的 task-notification 两种情况）。
  - 集成覆盖：分叉写出新会话且不改源文件、插入失败只清理新写的文件、页脚按钮取结构化位置、按钮位于首位 / 重扫保持唯一 / 开关关闭后消失、开关默认开启且保留显式关闭、开关与页脚按钮的无障碍属性。
- **未验证**：真实客户端里的交互效果。开发机上没有可连接的 WorkBuddy renderer，只能断言到「记录文本按预期截断、落库路径正确」，不能断言官方客户端会按这份记录重建会话。这一条需要在能连 renderer 的机器上补。
