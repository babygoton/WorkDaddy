# 会话分叉（对标 Codex 桌面版的 Fork）

WorkBuddy 没有原生的「分支」按钮：想换个方向继续聊，只能整条会话倒回来，把之前走歪的几百轮一起背着走。Codex 桌面版的做法是每条消息旁挂一个分叉图标，**新会话只保留到所选消息为止，后面的不保留**（代码不回滚）。

`scripts/session-fork.js` 把同一件事做成可复用的纯计算模块 + CLI：把一个会话的本机记录按「消息锚点」切成前缀，产出新会话所需的记录文本。

## 机制

会话记录是逐行 JSON，落在数据根的 `projects/<工作区slug>/<会话id>.jsonl`：

```
<data-root>/projects/<slug>/<session-id>.jsonl
```

这与 `daemon.js` 里 `collectSessionArchiveFiles()` 收集会话产物的口径一致 —— 会话迁移本来就靠搬运这个文件 + 各产物目录 + 插入一行 `sessions` 记录。**所以分叉不需要新机制，只需要在写入前把记录截断。**

### 锚点

锚点 = 记录里 `type === 'message'` 且角色为 `user` / `assistant` 的消息，按出现顺序从 1 编号。工具调用、思考、文件快照都不计入锚点。

两条解析上的处理：

- `user` 消息先抽 `<user_query>…</user_query>` 里的正文。harness 的注入块（`<system-reminder>` / `<cb_summary>` / `<additional_data>` / `<identity_context>`）与用户真话可能落在同一条记录里，**先抽再判**才不会把真话一起丢掉。
- 抽不到、且整条以注入块开头的 `user` 记录直接跳过，不占锚点序号。

### 切点

记录顺序是「消息正文 → 该轮的工具调用与结果 → 下一条消息」。切点取**下一条 `message` 记录之前**：

- 保留的是完整的一轮，不会留下没有结果的 `function_call`；
- 锚点之后的新对话内容一条都不进来。

### 不做区间切片

只支持「保留前缀到某个锚点为止」。丢掉前缀会让新会话从半轮开始、缺少开头的 user 消息，反而不可用——这不是保守，是那个产物本身没有意义。

### 保留原始行

切片按**原始行**拼接，不重新序列化 JSON。这样未知字段、数字精度、转义方式都原样保留。

## CLI

```bash
# 打锚点清单
node scripts/session-fork.js --id <会话ID> --points [--max 60]

# 从第 12 条消息分叉
node scripts/session-fork.js --id <会话ID> --until 12 [--out <文件>] [--json]

# 按时间点分叉
node scripts/session-fork.js --id <会话ID> --until "09-17 15:30"

# 直接指定记录文件
node scripts/session-fork.js --file <记录文件> --until 7
```

- `--data-dir <路径>` 指定数据根，缺省用当前 profile（`lib.js` 的 `defaultDataDir()`）。
- `--out <文件>` 把分叉后的记录文本写到指定文件；`--dry-run` 配合 `--out` 时只回显不落盘。
- `--json` 输出结果摘要（锚点、保留/丢弃条数），便于面板或自动化调用。
- 锚点解析不出来、记录为空、会话里没有可分叉的消息 —— 一律**报错退出（exit 1）**，不静默挑一个默认锚点。

模块导出：`parseRecords` / `buildAnchors` / `resolveAnchor` / `cutIndexFor` / `planFork` / `forkedTitle` / `findSessionFile` / `describeAnchor`。

## 还没接线的部分

本模块刻意只做纯计算，不写数据库、不改任何文件。要变成面板里的一个按钮，还差两步：

1. **daemon 路由**：例如 `POST /api/sessions/fork`，入参 `{ id, until }`。先跑 `planFork()` 拿到文本与目标标题（`forkedTitle()`），再复用既有的会话复制链路落库 —— 复制记录文件与产物目录到新 ID、`insertCopiedSession()` 插入 `sessions` 行。
   注意：改 daemon 行为需要按 AGENTS.md 递增 `DAEMON_VERSION` / `DAEMON_BUILD_ID`。
2. **面板入口**：会话页每条会话旁加「分叉」，弹窗用既有的 `.wbs-modal` 模式列出锚点（`describeAnchor()` 已经是现成的一行格式）。

这两步都没有动这里的代码，纯粹是接线。

## 验证

- `node --check scripts/session-fork.js` 通过。
- `node --test test/session-fork.test.js`：12 项全通过。覆盖坏行跳过、锚点编号与注入块剥离、`<user_query>` 与注入块同行时的抽取、assistant 锚点保留本轮工具调用、user 锚点丢弃紧随其后的回复、末尾锚点丢弃数为 0、输出行逐字等于原文且不改动入参、按数字/`#n`/时间来解析锚点、四种失败路径、标题截断、按会话 ID 在多工作区下定位文件。
- **未验证**：真实客户端里的分叉效果。本机没有可连接的 WorkBuddy renderer，只能断言到「记录文本按预期截断」，不能断言官方客户端会按这份记录重建会话。这一条需要在能连 renderer 的机器上补。
