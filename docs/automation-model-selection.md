# 自动化指定模型（session.create / session.send）

**状态**：`session.create`（v1.2.43 起）与 `session.send`（v1.2.44 起）都支持指定模型。
两者走的是**不同机制**，不要混淆：

| | `session.create` | `session.send` |
|---|---|---|
| 作用对象 | 即将新建的会话 | 已选中且在挂载中的目标会话 |
| 机制 | 改 `localStorage['cb-newtask:model:<uid>']`（写偏好） | 真实点击 composer 的模型下拉选项 |
| 生效时机 | 进入「新建任务」视图时读取一次 | 点击后立即生效（运行时重新派发） |
| 可改项 | model / thoughtLevel / isThinking / contextWindow | model / thoughtLevel / isThinking |
| 还原 | 结束前还原用户原值（总是） | 结束前还原（默认；`keepModel: true` 跳过） |

## 用法

### 新建会话（`session.create`）

```json
{
  "op": "session.create",
  "message": "早上好",
  "model": "glm-5.3-flash",
  "thoughtLevel": "high",
  "saveAs": "receipt"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `model` | 模型键或显示名 | 自定义模型可只写 models.json 里的 id（会自动补 `custom-local:` 前缀）。支持 `{{vars.x}}` 模板。 |
| `thoughtLevel` | `low` / `medium` / `high` | 写入偏好对象的 `reasoningEffort`。可选。 |
| `isThinking` | 布尔 | 可选，直接写偏好对象的 `isThinking`。 |
| `contextWindow` | 1000–10000000 的整数 | 可选，写偏好对象的 `contextWindow`。 |

### 向已选中的会话发送（`session.send`）

```json
[
  { "op": "session.create", "message": "起个头", "model": "fast-model", "saveAs": "receipt" },
  { "op": "session.send", "conversationId": "{{vars.receipt.conversationId}}",
    "message": "接着这条用另一个模型说", "model": "glm-5.3-flash", "thoughtLevel": "high" }
]
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `model` | 模型键或显示名 | 解析基数**就是下拉里的候选**（权威），因此不吃 `knownModels` 是否就绪。 |
| `thoughtLevel` | 该模型支持的档位 | **按目标模型的 `supportedEfforts` 校验**：每个模型不同（如 `glm-5.3-flash` 是 `low/high/max`，`fast-model` 是 `low/medium/high`）。写了不支持的档位会报错并列出可选值。 |
| `isThinking` | 布尔 | 该模型 `canDisableThinking` 为 false 时传 `false` 会报错。 |
| `keepModel` | 布尔，默认 `false` | `false` = 运行结束前把会话模型与思考偏好还原成原值；`true` = 保留切换结果。 |
| `contextWindow` | — | **不支持**，会明确报错（会话内切换改不了上下文窗口，静默忽略会让任务以为改了却没改）。 |

模型解析规则（两者共用）：

- 已经带 `:` 的值原样使用（`custom-local:` 里的 id **大小写敏感**，不做改写）；
- 否则先匹配模型键，再匹配显示名；
- 再退回 models.json：命中就补 `custom-local:` 前缀并保留原始大小写；
- 拿到过候选却没命中 → **报错并列出候选**，不静默忽略；
- 拿不到候选（例如新建任务页没有会话控制器）→ 保留裸键，只靠写入后的回读校验兜底。

回执里会带 `model`（实际使用的键）与 `modelDisplay`（composer 选择器上的显示文本），可用 `logic.assert` 校验。

## 机制一：新建任务偏好（`session.create`）

WorkBuddy 的「新建任务」模型偏好存在渲染进程 localStorage：

```
cb-newtask:model:<uid> = { "id": "<模型键>", "isThinking": true, "reasoningEffort": "high", "contextWindow": 1000000 }
```

daemon 在**进入新建任务视图之前**改写该键（保留用户其余字段，只替换被指定的字段），随后走原有发送流程，最后在 `finally` 里**还原用户原值**（原本不存在则删除该键）。

### 实测证据（2026-09-17，本机真环境）

| 步骤 | 观察 |
|---|---|
| 写 `cb-newtask:model:<uid>.id = fast-model` | 写入成功 |
| 进入「新建任务」 | 模型选择器显示「快速」 |
| 发送 `3+3=?` | 建出会话并正常回复 |
| 查 `~/.workbuddy/workbuddy.db` 的 `sessions.model` | `fast-model`（账号默认是 `hy3`，说明确由该键决定） |

## 机制二：composer 模型下拉（`session.send`）

### 为什么不能写 `sessionStore.setModel`

`sessionStore`（zustand 风格）的 `setModel(model)` 源码就是 `set({ model })`——它是**运行时状态的镜像**的 setter，不是输入接口。实测（同一会话上）：

| 观察项 | `setModel('balanced-model')` 之后 |
|---|---|
| store 值 | `{before:'fast-model', after:'balanced-model', changed:true}` |
| composer 选择器文本 | 仍是「快速」 |
| `sessions.model` | 仍是 `fast-model` |
| 宿主日志 | 没有 `unstable_setSessionModel`，也没有 `modelId=balanced-model` |

结论：改它等于改缓存。真实切换只能走 UI 路径。

### 可达的路径

composer 上的 `button.cr-model-selector__trigger` 只负责开合菜单（`onClick = () => setIsOpen(!isOpen)`），真正切换在**下拉选项**的 onClick 里；选项是菜单展开后才挂载的。

选项与其 React 处理器可以从 fiber 上稳定取到（不需要展开任何子菜单）：

```
div.cr-model-selector__item  → 向上找 ancestor fiber，其 memoizedProps.option 存在
  memoizedProps.option = { id, name, supportedEfforts, canDisableThinking, isExternal, ... }
  memoizedProps.isSelected / isThinking / currentEffort
  memoizedProps.onSelectEffort(modelId, effort)      // 思考档位
  memoizedProps.onToggleThinking(modelId, enabled)   // 思考开关
```

因此 daemon 侧分两步：

1. **只读探查**（`readSessionModelMenu`）：开一次菜单 → 读全部候选（含每项的 `supportedEfforts` 与当前选中项）→ 关菜单。据此在 Node 侧解析模型键与思考档位。
2. **应用**（`applySessionModel`）：开菜单 → 点目标项（用 `__reactProps$.onClick`，等价于真实点击，且不受元素是否在可视区内影响）→ 校验已选中 → 改思考档位/开关 → 回读校验 → 关菜单。

任何一步拿不到确认都直接报错，**不会带着「以为换了模型」的状态去发送**。

> **读数的坑（已处理）**：`currentEffort` / `isThinking` 只有**当前选中**的模型项才是真实值；
> 未选中项读到的只是占位值。所以
> (a) 应用时先切模型、后改档位；
> (b) 还原时必须**趁目标模型还被选中**先把它的思考偏好改回去，最后才把会话切回原模型；
> (c) 还原基准取「切换完成后」的读数，而不是切换前的占位值。
> 顺序搞反的话，`effort` 会被改写成一个假值，或校验直接误判失败。

### 实测证据（2026-09-17，本机真环境，v1.2.44）

对一条真实会话反复切换，`sessions.model` 与选择器文本同步跟随：

| 操作 | 渲染器回读 | `workbuddy.db` → `sessions.model` |
|---|---|---|
| 基线 | `快速` | `fast-model` |
| 切到 `glm-5.3-flash` | `GLM-5.3-Flash` | `glm-5.3-flash` |
| 切回 `fast-model` | `快速` | `fast-model` |
| 请求 `no-such-model-xyz` | `{ok:false, code:'unknown-model'}` + 21 个候选 | 不变 |

宿主日志同时出现该会话的运行时派发：`[CliDispatcher] [Dispatch] entry opts: sessionId=<sid> ... model=glm-5.3-flash`，
以及 `[ACP Agent] getModelsInfo: sessionId=<sid>, currentModelId=glm-5.3-flash`。

思考档位与思考开关同样可切换（同一会话实测）：

| 调用 | 回读 |
|---|---|
| `onSelectEffort(id,'high')` → `low` | `currentEffort: high → low`，DB `sessions.thought_level` 同步 |
| `onToggleThinking(id,false)` → `true` | `isThinking: true → false → true` |

注意**思考档位是「按模型记忆」的偏好**：`glm-5.3-flash` 被记成 `high`、`fast-model` 被记成 `medium` 可以并存。
因此 `session.send` 的还原分两步——先把会话切回原模型，再把目标模型的思考偏好改回去
（第二次必须用 `switchModel:false`，否则又会把会话切走）。

## 真机端到端验收

补丁不只是单测通过——已实际部署到本机安装目录（`D:\Program Files\WorkDaddy\scripts`）并跑通真实任务。

验收方式：把改动写入本机安装目录并结束 daemon 进程（常驻 watchdog 会在数秒内用新代码拉起，**无需重启 WorkBuddy**），随后跑真实任务核对结果。下面的表格都是这样跑出来的原始观察。

### v1.2.43：`session.create` + `model`

该账号默认的新建任务模型是 `hy3`，任务显式指定 `glm-5.3-flash`、`thoughtLevel: high`。三条独立证据一致：

| 证据源 | 观察 |
|---|---|
| 任务运行日志 | `session:model:glm-5.3-flash display=GLM-5.3-Flash` |
| `workbuddy.db` → `sessions` | 新会话 `model = "glm-5.3-flash"`、`thought_level = "high"` |
| 宿主日志的请求记录 | `method:sendPrompt {"instanceId":"ci-b","blockCount":1,"mode":"craft","modelId":"glm-5.3-flash"}` |

第三条是**请求级铁证**：该会话真的是按 `glm-5.3-flash` 发出的请求，不只是 UI 或配置层面的变化。

任务结束后 `cb-newtask:model:<uid>` 已由 `finally` 还原为 `{"id":"hy3",...}`，临时会话与临时任务均已删除。

### v1.2.44：`session.send` + `model`

见下节运行日志格式中的 `scope=session` 行，以及文末「验收记录」。

## 运行日志

| 日志 | 含义 |
|---|---|
| `session:model:<key> display=<显示名>` | `session.create`：偏好已写入且选择器已跟上 |
| `session:model:<key> display=<显示名> effort=<档位> thinking=<bool> scope=session restore=on` | `session.send`：会话内已切换且已回读确认；`restore=on` 表示结束时会还原（`keep=true` 表示按 `keepModel` 保留） |
| `session:model:restore:model=<原模型>,prefs=<目标模型>` | 还原成功 |
| `session:model:restore-failed:<原因>` | 还原失败（**只记日志，不覆盖任务结果**） |

### 真机跑出来的缺陷（已修）

首次实跑失败：`appendRunLog is not defined`。

原因：`prepareNewTaskModel` 位于**模块顶层**，而 `appendRunLog` 是 `startAutomationRun` 的**闭包内**函数——跨作用域引用。静态测试没抓到（测试里由 harness 注入 mock）。修复方式是让顶层 helper 只返回数据，把运行日志改到 `sessionAction`（同一闭包内）记录。

这个坑说明：新增顶层 helper 时，凡是还想写「运行日志」的，都必须把日志调用留在闭包内，或者把数据返回给闭包。

## 已知限制与失败语义

1. **新建任务偏好只在进入视图时读取一次，非响应式。**
   因此 daemon 必须在挂载前写入。如果视图已经打开，写入不会被重新读取——这时
   `session.create` 直接报错「新建任务页已打开…请先切换到其他会话后重试」，
   而不是用旧模型静默发送。
2. **写入后回读校验（`session.create`）。**
   回读到的 `id` 与请求不一致（含读不到）时取消发送并报错，避免「任务以为换了模型、
   实际沿用旧模型」。回读失败时 `finally` 仍会还原用户原值。
3. **`session.send` 依赖 composer 的模型下拉 DOM 与 fiber 结构。**
   选择器类名（`.cr-model-selector__trigger` / `__popover` / `__item`）或
   `memoizedProps.option` 的字段名变化时该功能会失效；此时会**明确报错**
   （`no-composer-model-selector` / `model-menu-not-opened` / `model-option-missing`），
   不会静默沿用旧模型。报错文本见 `SESSION_MODEL_ERROR_TEXT`。
4. **`session.send` 不支持 `contextWindow`。** 静态校验与运行时都会报错。
5. **`session.send` 要求目标会话已经选中且在挂载中**（与原有约束一致）。
6. **模型键清单可能取不到（`session.create` 路径）。**
   新建任务页没有会话控制器，`knownModels` 可能为空，此时无法在写入前判定「未知模型」，
   只能依赖第 2 条的回读校验。`session.send` 路径不存在这个问题（候选就是下拉本身）。
7. 模板解析为空（如 `{{vars.missing}}`）会报错，不会退回账号默认模型。
8. **思考档位是全局的按模型偏好**，不是会话级：`session.send` 指定 `thoughtLevel` 会改变该模型
   在**所有**会话里的默认档位。默认会被还原；`keepModel: true` 时会保留，请自行确认这是期望行为。

## 相关改动

| 文件 | 改动 |
|---|---|
| `scripts/automation-model.js` | 新增（v1.2.43）。v1.2.44 加入 `normalizeSessionModelRequest` / `pickEffortLevel` / `readBooleanFlag` / `SESSION_MODEL_FIELDS`。 |
| `scripts/automation.js` | `validateModelStep`（静态校验，按 op 分支）、`session.create`/`session.send` 目录文案与示例、执行期透传 + 空模板报错、协议说明（中英）。 |
| `scripts/daemon.js` | `SESSION_MODEL_MENU_TOOLKIT` + `sessionModelProbeExpression` / `sessionModelSwitchExpression` / `readSessionModelMenu` / `applySessionModel` / `prepareSessionModel`（v1.2.44）；`prepareNewTaskModel` 等（v1.2.43）；`sessionAction` 接入并 `finally` 还原；回执带 `model`；`DAEMON_VERSION`/`DAEMON_BUILD_ID` 递增到 1.2.44。 |
| `scripts/build-mac-dmg.sh` | 打包清单加入 `automation-model.js`。 |
| `test/automation-model.test.js` | 回归测试（v1.2.43 13 项 → v1.2.44 17 项）。 |
| `test/agent-new-task-draft.test.js` | 会话动作 harness 补注入 `automation-model.js`。 |
| `schemas/automation-package.v1.schema.json` | 无需改动（`task` 为宽松对象，字段级校验由 `validateTask` 负责）。 |
