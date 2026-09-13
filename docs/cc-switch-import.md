# CC Switch 模型导入

入口：模型 → 当前模型 → 从第三方导入 → CC Switch。按来源客户端分开展示，同一供应商合并为一项并列出包含的模型；默认全选当前客户端的可导入供应商。计数与全选仅针对当前客户端，点击确定时读取当前配置检查冲突：没有同名模型则直接导入；会覆盖现有模型或选中项之间存在重复 ID 时，才显示 380px 的确认弹窗。模型选择弹窗保持 640px。

## 数据来源

参考源码：`https://github.com/farion1231/cc-switch`，分析版本 `b78192e8fec3e062948237526d9c03ad08ea7831`（3.20.2）。本实现独立编写，不运行第三方代码。

- 优先读取用户目录 `.cc-switch/cc-switch.db` 的 `providers` 表；旧版回退 `config.json`。
- 遵循 `com.ccswitch.desktop/app_paths.json` 中的 `app_config_dir_override`，兼容 macOS、Windows 和 Linux 的 Tauri 数据目录。Windows 同时兼容历史 `HOME` 目录。
- 数据库使用现有只读 SQLite 适配器，支持安装包自带 Node SQLite，不依赖 Windows 另装 SQLite。不会创建缺失的第三方数据库。
- 支持 Claude 主模型（未设置时回退 Sonnet 默认模型）、Codex TOML 根配置和 profiles、Gemini、OpenCode 模型映射、OpenClaw 模型列表；兼容明确启用的公共配置片段。
- 仅读取供应商模型配置，不读取 CC Switch OAuth 会话、使用记录，不探测网络接口。预览只返回模型摘要、接口地址和 API Key，供本机用户确认配置；数据仅走 loopback，不写日志、不上传。

## 格式兼容边界

WorkBuddy 自定义模型的标准请求格式为 OpenAI Chat Completions。`useCustomProtocol` 只是 URL 原样传递，并非 Anthropic/Responses 协议转换器。

- Chat 配置保留模型 ID、密钥、路径前缀，规范为 `/chat/completions` 地址。
- Claude / Codex / 第三方 Gemini 的地址转换要求供应商同时支持 Chat Completions。不保证只提供原生协议的服务可用。
- Google Gemini 官方 API 使用其 OpenAI 兼容入口 `/v1beta/openai/chat/completions`。
- Anthropic 官方原生接口、OAuth 登录、缺少模型或密钥、额外认证请求头、无法解析的 TOML 等条目直接从预览过滤；不伪造模型名或凭据。
- 只转移有明确对应关系的模型能力、上下文/输出限制与推理强度，不迁移 CC Switch 的代理、工具、系统提示或脚本。

## 写入与覆盖

- 预览在 daemon 内保存 10 分钟，最多保留 4 份。导入请求必须携带有效快照与选择标识，不能提交任意文件路径或客户端自造配置。有冲突且未确认时只返回冲突数量，不写入模型或备份。成功后快照作废，避免重复提交。
- 按 WorkBuddy 的模型 ID 覆盖，保留未选择的现有模型；同 ID 多供应商采用选择顺序最后一项。所有所选配置同时保存到“备选模型”，可随时换用。
- 先将当前原文件以 `models.json.before-cc-switch-<uuid>.bak` 保存（权限 0600），再原子替换模型配置。保留原 JSON 包装和 `availableModels` 列表。
- 检测、预览和取消都不会写入 WorkBuddy 模型配置。

## 验证

`node --test test/third-party-models.test.js test/third-party-model-ui.test.js` 覆盖 SQLite / 旧 JSON、自定义目录、字段转换、缺失凭据过滤、公共配置、覆盖备份、同 ID 多供应商、快照过期，以及实际预览数据格式下的分组、选择、计数与确认行为。

在模拟数据页面中运行实际 `inject.js` 模型模块，验证默认勾选、全选/取消全选、两阶段确认、取消、重复提交、`html.cb-dark` / `html[data-theme="dark"]` 和 360px 窄窗口。没有用真实模型发起付费请求。Windows 安装器实机验证需在 Windows 进行。
