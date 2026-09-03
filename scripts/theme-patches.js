// WorkBuddy 样式补丁（热插拔模块）
// ============================================================
// 用途：所有针对 WorkBuddy 界面的样式补丁集中在此管理，不硬编码进 daemon。
// 每个补丁 = { id, desc, css }，desc 说明修复目标，css 是注入的样式片段。
// 修改本文件后重应用主题即生效（POST /api/theme-apply，无需重启 daemon）。
// WorkBuddy 升级导致样式失效时：先用面板 🔍/DevTools 定位失效组件 → 在此
// 增删对应补丁的 css → 重应用主题验证。
// ============================================================
module.exports = [
  {
    id: 'patch-03',
    desc: '改为半透明毛玻璃（背景图透出 + 模糊），而非纯色',
    css: 'body[data-vscode-theme-name] :not(.project-detail-view__task-conversation) [class*="userMessageBubble"]{background:color-mix(in srgb,var(--wb-bg-secondary) 62%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15);-webkit-backdrop-filter:blur(18px) saturate(1.15);}',
  },
  {
    id: 'patch-04',
    desc: '消息区「更多」按钮（_moreButton）：正方形纯色背景改透明，hover 浅色微底',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"]{background:transparent !important;border-color:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"]:active,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"]:focus,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] path,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] circle{background:transparent !important;border-color:transparent !important;}',
  },
  {
    id: 'patch-05',
    desc: '用户要求输入框下方"更大的矩形"透明，强制覆盖',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_cbChat_"]{background:transparent !important;}',
  },
  {
    id: 'patch-06',
    desc: '模型选择弹窗：模型名称 _modelName 硬编码 rgb(51,51,51) 深灰（深色弹窗上不可见），改主题文字色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_modelName_"]{color:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-07',
    desc: '深色主题下 html 残留 light 类导致 filter:none，故加 !important 强制反色可见',
    css: 'html[data-theme="dark"] .user-menu-trigger-miniprogram img{filter:invert(1) brightness(0.9) !important;}',
  },
  {
    id: 'patch-08',
    desc: '深色主题 --wb-bg-pill-active 为浅色背景，文字需深色（否则白底浅字看不清）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .wb-scene-tabs__pill--active{color:#0a0a0a;}',
  },
  {
    id: 'patch-09',
    desc: '左上角品牌头像（avatar-row-main .face 内 SVG 硬编码品牌色，深色下偏暗）：深色加浅色圆形底圈',
    css: 'html[data-theme="dark"] .avatar-row-main .face{background:rgba(255,255,255,0.14);border-radius:50%;}',
  },
  {
    id: 'patch-10',
    desc: '深色下改为浅色图标色 + 浅色边框（头像图本身由面板「头像」按钮上传替换）',
    css: 'html[data-theme="dark"] .user-menu-trigger-avatar{color:var(--wb-icon-secondary);border-color:rgba(255,255,255,0.22);}html[data-theme="dark"] .user-menu-trigger-avatar img{border-color:rgba(255,255,255,0.22);}',
  },
  {
    id: 'patch-11',
    desc: '深色下覆盖为主题深色 + 浅色图标',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_chatMessageBottomToolbarItem_"]{background:var(--wb-bg-secondary) !important;box-shadow:0 1px 4px rgba(0,0,0,0.4) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_chatMessageBottomToolbarIcon_"]{color:var(--wb-icon-secondary);}',
  },
  {
    id: 'patch-12',
    desc: '提亮 + 深色底（功能色状态圆点不动，保留绿/红语义）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-item"] [class*="modelBadge"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-item"] [class*="modelIcon"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-item"] [class*="modelTag"]{filter:brightness(1.35) contrast(1.05);}html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-item"] [class*="modelBadge"]{background:var(--wb-bg-tertiary) !important;}',
  },
  {
    id: 'patch-13',
    desc: '消息反馈区的模型 logo（_modelTag/_modelIcon，如 DeepSeek 蓝 #3964FE）：提亮与深色背景协调',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_modelTag_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_modelIcon_"]{filter:brightness(1.45) contrast(1.1);}',
  },
  {
    id: 'patch-14',
    desc: '输入框内部容器透明（_mainArea 除外——mainArea 由 patch-40 改为毛玻璃）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"] section[class*="_container_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"] [class*="_contentOverlayWrapper_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"] [class*="_content_"]{background:transparent !important;}',
  },
  {
    id: 'patch-15',
    desc: '弹窗/tooltip 通用深色适配：dropdown/popover/popper/picker-panel/menu-panel 背景默认白，深色下覆盖。排除官方新组件体系(cr-theme/cr-popover/cr-menu——官方自带深色适配)与官方 hash 触发器容器(_dropdownRoot_——仅定位容器，不应着色，否则更多按钮出现黑底)',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="dropdown"]:not([class*="toolbar"]):not([class*="cr-theme"]):not([class*="_dropdownRoot_"]),html[data-theme="dark"] body[data-vscode-theme-name] [class*="popover"]:not([class*="cr-theme"]),html[data-theme="dark"] body[data-vscode-theme-name] [class*="popper"]:not([class*="cr-theme"]),html[data-theme="dark"] body[data-vscode-theme-name] [class*="picker-panel"]:not([class*="cr-theme"]),html[data-theme="dark"] body[data-vscode-theme-name] [class*="menu-panel"]:not([class*="cr-theme"]){background:var(--wb-bg-popover) !important;color:var(--wb-color-text-primary);border-color:var(--wb-border-subtle) !important;box-shadow:0 6px 24px rgba(0,0,0,0.5) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="tooltip"]:not([class*="chat"]):not([class*="message"]){background:var(--wb-bg-popover) !important;color:var(--wb-color-text-primary);}html[data-theme="dark"] body[data-vscode-theme-name] [class*="dropdown"]:not([class*="cr-theme"]):not([class*="_dropdownRoot_"]) [class*="item"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="popover"]:not([class*="cr-theme"]) [class*="item"]:hover{background:var(--wb-bg-hover) !important;}',
  },
  {
    id: 'patch-16',
    desc: '会话列表状态图标：颜色跟随主题图标色（currentColor 类图标生效；硬编码彩色状态保留）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_statusIcon"]{color:var(--wb-icon-secondary);}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_statusIcon"] svg{color:var(--wb-icon-secondary);}',
  },
  {
    id: 'patch-17',
    desc: '骨架屏（TDesign skeleton 等）：占位块背景 --td-* 变量深色未定义回退浅灰，统一覆盖为主题深色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .t-skeleton__col,html[data-theme="dark"] body[data-vscode-theme-name] .t-skeleton__row,html[data-theme="dark"] body[data-vscode-theme-name] [class*="skeleton"] [class*="col"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="skeleton"] [class*="row"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="skeletonItem"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="skeleton-item"]{background:var(--wb-bg-tertiary) !important;}',
  },
  {
    id: 'patch-18',
    desc: '会话消息加载骨架（_loadingMessage 模块）：用户要求直接隐藏（不显示骨架屏）',
    css: 'html[data-theme="dark"] [class*="_loadingWithCredit_"],html[data-theme="dark"] [class*="_loadingMessage_"]{display:none !important;}',
  },
  {
    id: 'patch-19',
    desc: '1. wb-home-page 整体透明（露出上层毛玻璃/背景图）',
    css: 'body[data-vscode-theme-name] .wb-home-page{background:transparent !important;}',
  },
  {
    id: 'patch-20',
    desc: '之前只覆盖了聊天页，主页这边没覆盖到',
    css: 'body[data-vscode-theme-name] .wb-home-page section[class*="_container_"],body[data-vscode-theme-name] .wb-home-page [class*="_contentOverlayWrapper_"],body[data-vscode-theme-name] .wb-home-page [class*="_content_"],body[data-vscode-theme-name] .wb-home-page [class*="_mainArea_"]{background:transparent !important;}',
  },
  {
    id: 'patch-21',
    desc: '3. wb-scene-tabs（主页场景标签栏）毛玻璃：半透明 + 模糊，背景图透出',
    css: 'body[data-vscode-theme-name] .wb-scene-tabs{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(22px) saturate(1.15);-webkit-backdrop-filter:blur(22px) saturate(1.15);}',
  },
  {
    id: 'patch-22',
    desc: '注意排除 item-icon：图标容器类名也含 "item"，会被 [class*="item"] 误伤（用户反馈图标带背景色）',
    css: 'body[data-vscode-theme-name] .quick-actions__list [class*="item"]:not([class*="icon"]),body[data-vscode-theme-name] .quick-actions__list button{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(16px) saturate(1.15);-webkit-backdrop-filter:blur(16px) saturate(1.15);}',
  },
  {
    id: 'patch-23',
    desc: '图标容器背景透明（去掉误伤的半透明底）',
    css: 'body[data-vscode-theme-name] .quick-actions__list [class*="item-icon"]{background:transparent !important;}',
  },
  {
    id: 'patch-24',
    desc: 'quick-actions 滚动渐隐（fade-right::after / fade-left::before，72px 渐变遮罩）→ 透明',
    css: 'body[data-vscode-theme-name] [class*="quick-actions--fade"]::after,body[data-vscode-theme-name] [class*="quick-actions--fade"]::before{background:transparent !important;}',
  },
  {
    id: 'patch-25',
    desc: '5. 会话分组标题（conversation-section-label）透明：左侧整体已是毛玻璃，标题纯色底会盖住',
    css: 'body[data-vscode-theme-name] .conversation-section-label{background:transparent !important;}',
  },
  {
    id: 'patch-26',
    desc: '6. 会话分组折叠头（collapsible-section 的 _header）透明：同上',
    css: 'body[data-vscode-theme-name] .conversation-list [class*="_collapsibleSection_"] [class*="_header_"]{background:transparent !important;}',
  },
  {
    id: 'patch-27',
    desc: '（上一轮 bgCssStr 已透明化，这里兜底确保任何情况不被局部规则覆盖）',
    css: 'body[data-vscode-theme-name] [class*="_input-area-container_"]{background:transparent !important;}',
  },
  {
    id: 'patch-28',
    desc: '图标颜色跟随主题浅色图标色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] path,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"] circle{background:transparent !important;color:var(--wb-icon-secondary);border-color:transparent !important;}',
  },
  {
    id: 'patch-29',
    desc: '会话顶部导航栏（workbuddy-topbar）：纯色底改毛玻璃半透明，背景图透出',
    css: 'body[data-vscode-theme-name] .workbuddy-topbar{background:color-mix(in srgb,var(--wb-bg-primary) 55%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-30',
    desc: '输入框上方浮动问题卡片(_questionFloating)：78% 高不透明接近纯色块→降为 42% 真毛玻璃（与输入框 mainArea 一致）；内部元素兜底',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionFloating_"]{background:color-mix(in srgb,var(--wb-bg-popover) 42%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;color:var(--wb-color-text-primary);}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionFloating_"] *{color:var(--wb-color-text-primary);}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionFloating_"] [class*="number"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionFloating_"] [class*="badge"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionFloating_"] [class*="tag"]{background:var(--wb-bg-tertiary) !important;}',
  },
  {
    id: 'patch-31',
    desc: '问答展示区背景绑定 qad-card-bg 变量（变量定义已移入 theme-vars.js scoped 层，此处仅保留元素背景应用）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .ask-user-question [class*="_questionAnswerDisplay_"]{background-color:var(--qad-card-bg) !important;}',
  },
  {
    id: 'patch-32',
    desc: '问答状态文本（skipped/failed/cancelled 用 --cb-text-tertiary，深色下未定义回退浅色）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .ask-user-question--skipped .skipped-content,html[data-theme="dark"] body[data-vscode-theme-name] .ask-user-question--failed .failed-content,html[data-theme="dark"] body[data-vscode-theme-name] .ask-user-question--cancelled .cancelled-content{color:var(--wb-color-text-tertiary) !important;}',
  },
  {
    id: 'patch-33',
    desc: '更多按钮弹层(dropdownRoot/_moreMenu/_moreButton)：背景透明 + 去边框 + 去阴影（patch-15 通用弹窗规则会给 _dropdownRoot_ 命中 dropdown 子串染上 --wb-bg-popover 背景色/阴影，需在此一并清掉；_moreButton_ 内层同样）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreMenu_"] [class*="_dropdownRoot_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_dropdownRoot_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_moreButton_"]{background:transparent !important;border-color:transparent !important;box-shadow:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-34',
    desc: '滚动时 --scrolled 变体 opacity:1 显示"从深到浅"渐变）→ 直接去掉',
    css: 'body[data-vscode-theme-name] [class*="_input-area-container_"]::before{display:none !important;}',
  },
  {
    id: 'patch-35',
    desc: '4. 会话顶部导航栏下边框线 → 透明',
    css: 'body[data-vscode-theme-name] .workbuddy-topbar{border-bottom-color:transparent !important;}',
  },
  {
    id: 'patch-36',
    desc: '顶部线最黑最明显）→ 边框全透明',
    css: 'body[data-vscode-theme-name] [class*="_mainArea_"]{border-color:transparent !important;}',
  },
  {
    id: 'patch-37',
    desc: '主页输入框(wb-home-composer)完全透明（用户要求去掉毛玻璃背景）；聊天页输入框父容器由 patch-40 控制为透明。加 dark 前缀压过 bgCssStr 后注入的 40% 毛玻璃',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .wb-home-composer{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-38',
    desc: '消息队列展开态(cb-expand)毛玻璃（全局 palette-gray-3 兜底变量已移入 theme-vars.js body 层）',
    css: 'body[data-vscode-theme-name] .cb-message-queue.cb-expand{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.15);}',
  },
  {
    id: 'patch-40',
    desc: '输入框父组件(_input-area-container--opaque-main-area)透明；输入框主体 _mainArea 改毛玻璃（用户要求：父透明 + 输入框本体毛玻璃）。加 dark 前缀提特异性，压过 bgCssStr 后注入的 40% 背景',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"] [class*="_mainArea_"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-41',
    desc: '插件暂存按钮(wbs-stash-inline)深色下改毛玻璃背景：半透明 bg-primary + backdrop blur，与输入框毛玻璃一致；颜色/阴影走主题变量',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .wbs-stash-inline{background:color-mix(in srgb,var(--wb-bg-primary) 62%,transparent) !important;color:var(--wb-color-text-primary) !important;backdrop-filter:blur(16px) saturate(1.15) !important;-webkit-backdrop-filter:blur(16px) saturate(1.15) !important;box-shadow:0 1px 4px rgba(0,0,0,0.4) !important;}',
  },
  {
    id: 'patch-42',
    desc: '深色菜单弹窗(popover/dropdown 面板)背景已深色但内部文字/图标可能硬编码深色看不清：对 wb-dropdown 系弹窗全元素强制浅色（label/button/span/svg 全覆盖）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-dropdown"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-popover"]{color:var(--wb-color-text-primary) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-dropdown"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-popover"] *{color:var(--wb-color-text-primary) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-dropdown"] svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="wb-popover"] svg{fill:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-43',
    desc: '深度思考的代码库组件(write-file-compact)：__content/--executing 执行中态毛玻璃；__header 完全透明（用户要求 header 去掉背景）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__content,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__content--executing,html[data-theme="dark"] body[data-vscode-theme-name] [class*="write-file-compact"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header.expandable{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-44',
    desc: 'tooltip/悬浮提示组件文字硬编码深色（与深色弹窗同色看不见）：强制浅色 + hover 高亮态文字浅色（排除官方新组件体系 cr-theme——其自带深色文字适配）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="tooltip"]:not([class*="chat"]):not([class*="message"]) *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="popover"]:not([class*="cr-theme"]) *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="dropdown"]:not([class*="cr-theme"]) *{color:var(--wb-color-text-primary) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="dropdown"]:not([class*="cr-theme"]) [class*="item"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="dropdown"]:not([class*="cr-theme"]) [class*="item"]:hover *{color:var(--wb-color-text-primary) !important;background:var(--wb-bg-hover) !important;}',
  },
  {
    id: 'patch-45',
    desc: '主页输入框 chips 行(wb-home-composer__chips)去背景；深度思考推理区外层(_assistantReasoning)透明无边框（边框由 patch-50 移除）；消息底部工具栏项(_chatMessageBottomToolbarItem)改毛玻璃',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .wb-home-composer__chips{background:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;border:none !important;border-left:none !important;border-radius:12px !important;padding-left:10px !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_chatMessageBottomToolbarItem_"]{background:color-mix(in srgb,var(--wb-bg-secondary) 60%,transparent) !important;backdrop-filter:blur(16px) saturate(1.15) !important;-webkit-backdrop-filter:blur(16px) saturate(1.15) !important;box-shadow:0 1px 4px rgba(0,0,0,0.4) !important;}',
  },
  {
    id: 'patch-46',
    desc: '左下角用户菜单(user-menu-popover)：cell 悬浮时 label/value 出现白色 7% 矩形背景 → 去掉；升级按钮(plan-action-btn)白底浅字未适配 → 主题按钮色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"] [class*="label"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"] [class*="value"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"] [class*="label"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"] [class*="value"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"]:hover [class*="label"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"] [class*="user-menu-item"]:hover [class*="value"]{background:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="plan-action-btn"]{background:var(--wb-button-primary-bg) !important;color:var(--wb-button-primary-fg) !important;border-color:transparent !important;}',
  },
  {
    id: 'patch-47',
    desc: '左侧 tab 按钮 hover 弹出的列表菜单(cb-tooltip / 专家·技能·连接器 dropdown 等)：文字强制浅色（用户反馈「新建任务下面第 3 个按钮」hover 菜单字看不见）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-tooltip,html[data-theme="dark"] body[data-vscode-theme-name] .cb-tooltip *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="tooltip"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="tooltip"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="expert-menu"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="expert-menu"] *{color:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-48',
    desc: '左侧 tab hover 菜单（项目/专家 等任意弹窗）：深色背景+深色文字看不见 → 弹窗内全部元素强制浅色文字（含非 hover 态），背景强制深色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="popover"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="popover"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="dropdown"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="dropdown"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-expert"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-expert"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="expert-dropdown"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="expert-dropdown"] *{color:var(--wb-color-text-primary) !important;background:var(--wb-bg-popover) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="popover"] [class*="item"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list"] [class*="dropdown"] [class*="item"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-expert"] [class*="item"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] [class*="item"]:hover{color:var(--wb-color-text-primary) !important;background:var(--wb-bg-hover) !important;}',
  },
  {
    id: 'patch-49',
    desc: '用户亲抓 conversation-list-expert-dropdown(:r17:) 组件，反复反馈文字与背景同色看不见；CDP 实测变量值正常但用户界面仍异常 → 终极兜底：对 expert-dropdown 弹窗全部元素硬编码浅色文字/图标 + 深色背景（不依赖 CSS 变量），覆盖所有状态与子元素',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__list,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:focus,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:active{background:#111113 !important;border-color:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__label,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item-hit,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__label:hover,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon:hover,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown svg,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown svg path,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown *{color:#f2f2f4 !important;fill:#f2f2f4 !important;background:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover{background:#111113 !important;}',
  },
  {
    id: 'patch-50',
    desc: '深度思考推理区：外层(_assistantReasoning)去边框已由 patch-45 处理；内层(_assistantReasoningContent)展示毛玻璃；write-file-compact__header 自身及全部子元素去背景（子元素有 rgba(31,31,31,0.4) 深色半透明底）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"]{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;border:none !important;border-radius:12px !important;padding-left:10px !important;}html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header.expandable,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header *,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__header.expandable *{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-51',
    desc: 'write-file-compact 整体去背景（patch-43 曾设 40% 毛玻璃，用户要求去掉）；专家/更多悬浮菜单：图标(wb-dropdown__icon)与文字(wb-dropdown__label)的背景在普通态与 hover 态全部去透明（专家菜单 hover 时 icon/label 出现 rgba(255,255,255,0.07) 官方 hover 背景；更多菜单 icon/label 普通态也是深色 popover 背景）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact,html[data-theme="dark"] body[data-vscode-theme-name] .write-file-compact__content,html[data-theme="dark"] body[data-vscode-theme-name] [class*="write-file-compact"]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] .wb-popover.wb-dropdown.conversation-list-expert-dropdown .wb-dropdown__item:hover,html[data-theme="dark"] body[data-vscode-theme-name] .wb-popover.wb-dropdown.conversation-list-more-dropdown .wb-dropdown__item:hover{background:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover .wb-dropdown__icon,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover .wb-dropdown__label,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover .wb-dropdown__item-hit,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__item:hover svg,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon:hover,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__label:hover,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon svg,html[data-theme="dark"] body[data-vscode-theme-name] .conversation-list-expert-dropdown .wb-dropdown__icon img,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__icon,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__label,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item-hit,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__icon svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__icon img,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item:hover .wb-dropdown__icon,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item:hover .wb-dropdown__label,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item:hover .wb-dropdown__item-hit,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item:hover svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__item:hover img,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__icon:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-list-more"] .wb-dropdown__label:hover{background:transparent !important;}',
  },
  {
    id: 'patch-52',
    desc: '用户消息气泡(_userMessageBubble)右下角补圆角；深度思考仅提亮正文语义标签，不覆盖容器、span/div 或代码 token',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_userMessageBubble_"]{border-radius:16px 16px 16px 16px !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] p,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] li,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h1,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h2,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h3,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h4,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h5,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h6,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] blockquote,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] a{color:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-53',
    desc: '主页输入框 chips 行(wb-home-composer__chips)去掉背景色（透明，不限主题）；聊天页问答展示组件(_questionAnswerDisplay)保持毛玻璃（用户要求）',
    css: '.wb-home-composer__chips{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;border-color:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_questionAnswerDisplay_"]{background:color-mix(in srgb,var(--wb-bg-secondary) 55%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border:1px solid var(--wb-border-subtle) !important;border-radius:12px !important;}',
  },
  {
    id: 'patch-54',
    desc: '左下角用户菜单(user-menu)：父组件（弹窗面板/按钮列表层/加油站插槽容器）悬浮时保持原背景不展示 hover 色（菜单项行悬浮反馈由 patch-15/44 的 item:hover 控制）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-popover"]:hover{background:var(--wb-bg-popover) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="user-menu-items"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] .wb-slot--menu-signin:hover,html[data-theme="dark"] body[data-vscode-theme-name] .wb-slot--menu-growth:hover{background:transparent !important;}',
  },
  {
    id: 'patch-55',
    desc: '深度思考标题与正文语义标签颜色适配；不修改折叠、流式显隐、动画、尺寸或代码高亮 token（--cb-text-* 全局变量已移入 theme-vars.js body 层）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningHeader_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningHeader_"]:hover{color:var(--wb-color-text-primary) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningIcon_"]{color:var(--wb-color-text-secondary) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] p,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] li,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h1,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h2,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h3,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h4,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h5,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] h6,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] blockquote,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoningContent_"] a{color:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-56',
    desc: '消息头部发送状态旋转图标(_trailingStatus 内 .wb-icon--spin)颜色适配：官方 --wb-palette-brand-8 青绿(rgb(0,194,154))在深色主题突兀 → 改中性次级文字色，与黑白风格协调（保留旋转动画指示进行中）',
    css: 'html[data-theme=\"dark\"] body[data-vscode-theme-name] [class*=\"_trailingStatus_\"] .wb-icon--spin,html[data-theme=\"dark\"] body[data-vscode-theme-name] [class*=\"_trailingStatus_\"] .wb-icon,html[data-theme=\"dark\"] body[data-vscode-theme-name] [class*=\"_header_\"] [class*=\"_statusIcon_\"]{color:var(--wb-color-text-secondary,#9a9aa2) !important;}',
  },
  {
    id: 'patch-57',
    desc: '侧边栏会话卡片(conversation-agent-card)头部"待确认"标签(_tag)颜色适配：官方深黑文字 rgb(10,10,12)+深灰底在深色主题下看不清 → 浅色文字+半透明浅底+白描边（黑白风格胶囊保留圆角）',
    css: 'html[data-theme=\"dark\"] body[data-vscode-theme-name] [class*=\"conversation-agent-card\"] [class*=\"_tag_\"],html[data-theme=\"dark\"] body[data-vscode-theme-name] [class*=\"_card_\"] [class*=\"_tag_\"]{color:var(--wb-color-text-primary,#f2f2f4) !important;background:rgba(255,255,255,.12) !important;border:1px solid rgba(255,255,255,.18) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="conversation-agent-card"] [class*="_tag_"]::after,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_card_"] [class*="_tag_"]::after{background:var(--wb-color-text-primary,#f2f2f4) !important;}',
  },
  {
    id: 'patch-59',
    desc: '输入区底部工具栏「允许完全访问」按钮（_buttonToolbar）官方红色 rgb(220,66,88) → 白色：按钮本身及 icon/label/chevron/svg/path 全部改白（深色主题下与黑白风格协调，去掉警示红突兀感）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"]:hover,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"] [class*="_icon_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"] [class*="_label_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"] [class*="_chevron_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"] svg,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_inputBottom_"] [class*="_buttonToolbar_"] path{color:var(--wb-color-text-primary,#f2f2f4) !important;fill:currentColor !important;}',
  },
  {
    id: 'patch-60',
    desc: '欢迎页输入框仅在同一 wb-home-composer 直属存在 chips 行时调整：input-slot 自身透明无模糊，精确内部层级的 _mainArea_ 使用毛玻璃；没有 chips 时保持官方样式',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] section.wb-home-composer:has(> div.wb-home-composer__chips)>div.wb-home-composer__input-slot{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] section.wb-home-composer:has(> div.wb-home-composer__chips)>div.wb-home-composer__input-slot>section[class*="_container_"]>div[class*="_contentOverlayWrapper_"]>div[class*="_content_"]>div[class*="_mainArea_"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-58',
    desc: '深度思考 streaming/complete 正文语义标签颜色适配；保留 spinner、cursor、打字机动画、折叠显隐与代码 token 配色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"][data-wbs-theme-state="streaming"] [class*="_assistantReasoningContent_"] p,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"][data-wbs-theme-state="streaming"] [class*="_assistantReasoningContent_"] li,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"][data-wbs-theme-state="complete"] [class*="_assistantReasoningContent_"] p,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"][data-wbs-theme-state="complete"] [class*="_assistantReasoningContent_"] li{color:var(--wb-color-text-primary) !important;}',
  },
  {
    id: 'patch-61',
    desc: '深色主题下按 data-wbs-theme-kind/state 自动适配流式内容的基础色与卡片毛玻璃，不干预显隐、动画、尺寸、布局或代码 token 配色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .wbs-theme-auto,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="code"]{background:color-mix(in srgb,var(--wb-bg-primary) 46%,transparent);border-color:var(--wb-border-subtle);}html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="assistant"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="tool"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="file"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="table"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="blockquote"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="qa"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="card"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="attachment"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="status"]{color:var(--wb-color-text-primary);background:color-mix(in srgb,var(--wb-bg-primary) 46%,transparent);border-color:var(--wb-border-subtle);}html[data-theme="dark"] body[data-vscode-theme-name] .wbs-theme-auto a,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind] a{color:var(--wb-color-link,var(--wb-color-text-primary));}html[data-theme="dark"] body[data-vscode-theme-name] .wbs-theme-auto button,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind] button,html[data-theme="dark"] body[data-vscode-theme-name] .wbs-theme-auto svg,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind] svg{color:var(--wb-icon-secondary);fill:currentColor;}html[data-theme="dark"] body[data-vscode-theme-name] .wbs-theme-auto button:hover,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind] button:hover{background:var(--wb-bg-hover);}html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] p,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] li,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h1,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h2,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h3,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h4,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h5,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] h6,html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="reasoning"] blockquote{color:var(--wb-color-text-primary);}html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="tool"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="file"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="qa"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="card"],html[data-theme="dark"] body[data-vscode-theme-name] [data-wbs-theme-kind="attachment"]{backdrop-filter:blur(18px) saturate(1.12);-webkit-backdrop-filter:blur(18px) saturate(1.12);}',
  },
  {
    id: 'patch-62',
    desc: '【消息区背景·终版】用户三轮反馈确认：不要任何消息区底色（88%/60% 都被视为"纯色背景"）。改为完全透明——背景图/黑色底直接透出，层次由 mask.json 全局蒙版（0.4）压暗保证；毛玻璃氛围由侧边栏/顶栏/输入框保留',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .chat-container [class*="_chatMessageContainer_"],html[data-theme="dark"] body[data-vscode-theme-name] .chat-container [class*="_chatMessage_"]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-63',
    desc: '深度思考内容区(_assistantReasoningContent, max-height 200px 固定高度滚动容器)内部文字半透明 rgba(255,255,255,0.5) 看不清（cb-markdown 根/ol/ul 列表 patch-55 未覆盖）→ 全部改主题纯白文字色（含后代，保留代码 token 高亮——仅文本色）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] .cb-markdown,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] .cb-markdown *,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] ol,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] ul,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] li,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] p,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] span{color:var(--wb-color-text-primary,#f2f2f4) !important;}',
  },
  {
    id: 'patch-64',
    desc: '【深度思考文字透明真根因】官方 streaming 流光效果 ._cb-shining-text/._loadingText/_assistantReasoningHeader._loadingText 用 background-clip:text + -webkit-text-fill-color:transparent + color:transparent 让文字 fill 透明（配合背景渐变动画），深色主题下看起来"文字没颜色"。只改 color 无效，必须强制 -webkit-text-fill-color 不透明 + background-clip:border-box 取消文字裁剪。同时覆盖 cr-collapse streaming 变体',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningHeader_"]._loadingText_1mily_92,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_assistantReasoning_"] [class*="_assistantReasoningContent_"] *{color:var(--wb-color-text-primary,#f2f2f4) !important;-webkit-text-fill-color:var(--wb-color-text-primary,#f2f2f4) !important;background-clip:border-box !important;background-image:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_cb-shining-text_"],html[data-theme="dark"] body[data-vscode-theme-name] .cb-shining-text,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_loadingText_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_loadingText_"] *{color:var(--wb-color-text-primary,#f2f2f4) !important;-webkit-text-fill-color:var(--wb-color-text-primary,#f2f2f4) !important;background-clip:border-box !important;background-image:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cr-reasoning .cr-collapse--streaming .cr-collapse__content-inner,html[data-theme="dark"] body[data-vscode-theme-name] .cr-reasoning .cr-collapse--streaming .cr-collapse__content-inner *{color:var(--wb-color-text-primary,#f2f2f4) !important;-webkit-text-fill-color:var(--wb-color-text-primary,#f2f2f4) !important;background-clip:border-box !important;background-image:none !important;}',
  },
  {
    id: 'patch-65',
    desc: '决策弹窗(_container_tvhu6_40，输入框容器 _container_pf4c4_2 直接子元素，AskUserQuestion 交互卡片)整体毛玻璃：容器 52% 深色半透明 + blur(22px)；子元素（选项/卡片/分区）40% 深色半透明 + blur(14px)，去掉不透明底让毛玻璃透出；文字统一主题色',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"]{background:color-mix(in srgb,var(--wb-bg-popover) 52%,transparent) !important;backdrop-filter:blur(22px) saturate(1.2) !important;-webkit-backdrop-filter:blur(22px) saturate(1.2) !important;border-color:var(--wb-border-subtle) !important;box-shadow:0 8px 32px rgba(0,0,0,0.45) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="option"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="item"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="card"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="panel"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] section,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="content"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="body"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(14px) saturate(1.15) !important;-webkit-backdrop-filter:blur(14px) saturate(1.15) !important;border-color:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] *{color:var(--wb-color-text-primary,#f2f2f4) !important;}',
  },
  {
    id: 'patch-66',
    desc: '任务面板(cb-plan-task-detail)可点击任务项(cb-plan-task-item-clickable) hover 背景：官方 background-color:var(--wb-color-bg-primary-hover-strong)=#1b1b20 不透明深灰太实；改淡半透明白 rgba(255,255,255,0.05)，与官方默认 --cb-hover-bg 同风格，柔和',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-plan-task-wrapper .cb-plan-task-item.cb-plan-task-item-clickable:hover{background:rgba(255,255,255,0.05) !important;background-color:rgba(255,255,255,0.05) !important;}',
  },
  {
    id: 'patch-67',
    desc: '工具调用任务卡片(.task-compact__content，tool-with-explanation > task-compact--tree 内)背景：官方 background:var(--cb-panel-bg-primary)=#0a0a0a 不透明纯色；改毛玻璃 45% 深色半透明 + blur(20px)，与决策弹窗(patch-65)风格统一，背景图透出层次',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .task-compact__content{background:color-mix(in srgb,var(--wb-bg-primary) 45%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;border:1px solid var(--wb-border-subtle,rgba(255,255,255,0.08)) !important;}',
  },
  {
    id: 'patch-68',
    desc: '任务面板运行中任务项图标(.cb-plan-task-item-running .cb-plan-task-icon svg)颜色：官方 .cb-plan-task-icon color=var(--cb-text-secondary)=#858699 灰色；改纯白，fill 跟随 currentColor，图标在深色面板更醒目',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-plan-task-wrapper .cb-plan-task-item-running .cb-plan-task-icon,html[data-theme="dark"] body[data-vscode-theme-name] .cb-plan-task-wrapper .cb-plan-task-item-running .cb-plan-task-icon svg{color:#ffffff !important;fill:#ffffff !important;stroke:#ffffff !important;}',
  },
  {
    id: 'patch-69',
    desc: '决策弹窗(_container_tvhu6_40)两项修复：①层级——官方 .cb-message-queue z-index:15 会盖住弹窗(patch-65 未设 z-index)，弹窗加 z-index:30 保证在消息队列之上；②选项列表 _optionList_tvhu6_143 去背景色——patch-65 的 [class*="option"] 选择器把 optionList 也套了 40% 毛玻璃底，改为完全透明(含其内 option/item)，毛玻璃只保留在弹窗容器层',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"]{z-index:30 !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="_optionList_"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="_optionList_"] [class*="option"],html[data-theme="dark"] body[data-vscode-theme-name] [class*="_container_tvhu6_40"] [class*="_optionList_"] [class*="item"]{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-70',
    desc: 'markdown 消息正文的表格/表头/代码块统一毛玻璃化：官方 .cb-markdown table 背景用 --cb-markdown-table-color-bg(空)、thead th=--cb-markdown-table-header-bg=#252526 不透明、pre=--cb-vscode-sideBar-background=#0c0c0e 不透明；全部改 42% 深色半透明 + blur(18px)，背景图透出层次，与任务卡片/决策弹窗毛玻璃风格统一',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown table,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown-table-wrapper > table{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown thead th{background:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;backdrop-filter:blur(12px) saturate(1.1) !important;-webkit-backdrop-filter:blur(12px) saturate(1.1) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown pre,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown pre > code{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-71',
    desc: 'markdown 表格边框线条透明：官方 .cb-markdown table border + th/td border-right/bottom 用 --cb-markdown-table-border-color(主题映射=#262626 深色)太抢眼；改为 transparent（表格外框与单元格分隔线都透明，仅靠毛玻璃底区分；变量覆盖已移入 theme-vars.js scoped 层）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown table,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown-table-wrapper > table,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown th,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown td{border-color:transparent !important;}',
  },
  {
    id: 'patch-72',
    desc: '问答卡片内容显示区(.ask-user-question ._questionAnswerDisplay_)毛玻璃：官方 background-color:var(--qad-card-bg)=#292929 不透明（早期 patch 用 background-color !important 覆盖了旧毛玻璃规则）；用同优先级(0,2,0)后插入覆盖为 45% 深色半透明 + blur(20px)，与决策弹窗/任务卡片风格统一',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .ask-user-question [class*="_questionAnswerDisplay_"]{background:color-mix(in srgb,var(--wb-bg-secondary) 45%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-secondary) 45%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15) !important;-webkit-backdrop-filter:blur(20px) saturate(1.15) !important;border:1px solid var(--wb-border-subtle,rgba(255,255,255,0.08)) !important;}',
  },
  {
    id: 'patch-74',
    desc: '代码块/输入框细节三项：①pre.cb-markdown-pre 及内部 code 背景完全透明（覆盖 patch-70 的 42% 毛玻璃，用户要求代码块无底色、背景图直接透出，hljs token 配色不受影响）；②代码块头部 .cb-markdown-pre__header 官方 #292929 不透明 → 45% 半透明 + blur(18px) 毛玻璃（用户要求半透明）；③输入框主体 [class*="_mainArea_"] 去掉 1px 边框（用户反馈可见黑色描边）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown pre.cb-markdown-pre,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown pre.cb-markdown-pre > code{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown .cb-markdown-pre__header{background:color-mix(in srgb,var(--wb-bg-primary) 45%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_input-area-container_"] [class*="_mainArea_"]{border:none !important;}',
  },
  {
    id: 'patch-75',
    desc: '重新编辑会话组件(.user-message-editor / .user-messageior)毛玻璃 v4：外层 55% 半透明 + blur(18px) 无边框；输入框组件去边框+透明——真实 DOM 实测边框在 div._content_pf4c4_7([class*="_content_"]，1px #262626)，连同 mainArea/inputArea/inputBox/composer/editable/textarea/input/contenteditable 全部 border:none、background:transparent、box-shadow:none（含 focus-within）',
    css: 'body[data-vscode-theme-name] .user-message-editor,body[data-vscode-theme-name] .user-messageior{background:color-mix(in srgb,var(--wb-bg-secondary) 55%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-secondary) 55%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border:none !important;box-shadow:none !important;}body[data-vscode-theme-name] .user-message-editor [class*="_content_"],body[data-vscode-theme-name] .user-message-editor [class*=mainArea],body[data-vscode-theme-name] .user-message-editor [class*=inputArea],body[data-vscode-theme-name] .user-message-editor [class*=inputBox],body[data-vscode-theme-name] .user-message-editor [class*=composer],body[data-vscode-theme-name] .user-message-editor textarea,body[data-vscode-theme-name] .user-message-editor input,body[data-vscode-theme-name] .user-message-editor [contenteditable="true"],body[data-vscode-theme-name] .user-messageior [class*="_content_"],body[data-vscode-theme-name] .user-messageior [class*=mainArea],body[data-vscode-theme-name] .user-messageior [class*=inputArea],body[data-vscode-theme-name] .user-messageior [class*=inputBox],body[data-vscode-theme-name] .user-messageior [class*=composer],body[data-vscode-theme-name] .user-messageior textarea,body[data-vscode-theme-name] .user-messageior input,body[data-vscode-theme-name] .user-messageior [contenteditable="true"]{background:transparent !important;background-color:transparent !important;border:none !important;border-color:transparent !important;box-shadow:none !important;}body[data-vscode-theme-name] .user-message-editor:focus-within [class*="_content_"],body[data-vscode-theme-name] .user-message-editor:focus-within [class*=mainArea],body[data-vscode-theme-name] .user-message-editor:focus-within [class*=inputArea],body[data-vscode-theme-name] .user-message-editor:focus-within [class*=composer],body[data-vscode-theme-name] .user-messageior:focus-within [class*="_content_"],body[data-vscode-theme-name] .user-messageior:focus-within [class*=mainArea],body[data-vscode-theme-name] .user-messageior:focus-within [class*=inputArea],body[data-vscode-theme-name] .user-messageior:focus-within [class*=composer]{border-color:transparent !important;box-shadow:none !important;}',
  },
  {
    id: 'patch-76',
    desc: 'AI 思考过程(reasoning)代码块(.cb-markdown[data-md-theme=reasoning] .cb-markdown-pre-wrapper)毛玻璃化：官方 pre-container 用 --qad-card-bg(#292929 类)实心底挡住底层，去掉；wrapper 整体 42% 半透明 + blur(18px)；表头 .cb-markdown-pre__header 45% 半透明 + blur(12px)；表体 pre.cb-markdown-pre 及 code 完全透明。顺带覆盖 reasoning 下表格(若出现在 wrapper 内)：table 毛玻璃、thead 半透明、tbody 透明',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-container{background:transparent !important;background-color:transparent !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper .cb-markdown-pre__header{background:color-mix(in srgb,var(--wb-bg-primary) 45%,transparent) !important;backdrop-filter:blur(12px) saturate(1.1) !important;-webkit-backdrop-filter:blur(12px) saturate(1.1) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper pre.cb-markdown-pre,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper pre.cb-markdown-pre > code{background:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper table,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper .cb-markdown-table-wrapper > table{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper thead th{background:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;backdrop-filter:blur(12px) saturate(1.1) !important;-webkit-backdrop-filter:blur(12px) saturate(1.1) !important;}html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper tbody,html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown[data-md-theme="reasoning"] .cb-markdown-pre-wrapper tbody td{background:transparent !important;}',
  },
  {
    id: 'patch-77',
    desc: '普通代码块外层容器 .cb-markdown-pre-container 毛玻璃（用户要求）：42% 半透明 + blur(18px)，与 reasoning wrapper 风格一致；表体 pre/code 保持透明由 patch-70 处理',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .cb-markdown .cb-markdown-pre-container{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-78',
    desc: 'chat widget 渲染容器毛玻璃 + 表头半透明（用户要求）：_widgetRendererWrapper 42% 半透明 + blur(18px)；_widgetRendererWrapperHeader 30% 半透明 + blur(12px)',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetRendererWrapper_"]{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetRendererWrapperHeader_"]{background:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;backdrop-filter:blur(12px) saturate(1.1) !important;-webkit-backdrop-filter:blur(12px) saturate(1.1) !important;}',
  },
  {
    id: 'patch-79',
    desc: 'chat widget 内层容器 _widgetContainer（_widgetRendererWrapper 毛玻璃内部）改透明背景（用户要求）：透出外层毛玻璃，避免双层实底',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetRendererWrapper_"] [class*="_widgetContainer_"]{background:transparent !important;background-color:transparent !important;}',
  },
  {
    id: 'patch-80',
    desc: 'chat widget 预览 iframe 背景改透明（用户要求）：widget 容器内的 iframe 在深色下自带黑底（元素级背景），改透明让外层毛玻璃透出；iframe 内部文档自带黑底由 inject.js 同源注入兜底（跨域内部无法用 CSS 触达）',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetRendererWrapper_"] iframe,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetContainer_"] iframe,html[data-theme="dark"] body[data-vscode-theme-name] [class*="_widgetRendererWrapper_"] iframe[class*="chromeless"]{background:transparent !important;background-color:transparent !important;border:none !important;box-shadow:none !important;}',
  },
  {
    id: 'patch-81',
    desc: '消息队列项左侧「拖拽图标」（prompt-ico/prompt-icon）在有暂存提示词时透明但仍占位，导致文字左侧空白：整体隐藏不占位（用户要求）',
    css: '.cb-message-queue-item-left .prompt-ico,.cb-message-queue-item-left .prompt-icon{display:none !important;width:0 !important;margin:0 !important;}',
  },
  {
    id: 'patch-83',
    desc: '会话主区域(conversation-shell__main)去背景色全透明（用户 08-29 18:02 终版要求透明）；侧栏代理卡片(cb-agent-card)仅选中态毛玻璃（用户 08-30 10:03 调整：只有带 selected class 的卡片才 32% 毛玻璃，其余透明）——选中判定覆盖 conversation-item 的 active / aria-selected / _selected_ 及卡片自身挂 _selected_（5.4.4 选中 class 直接挂在 card 上，如 _selected_914ll_20）',
    css: 'body[data-vscode-theme-name] .conversation-shell__main{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .conversation-section-content .cb-agent-card{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .conversation-section-content .conversation-item.active .cb-agent-card,body[data-vscode-theme-name] .conversation-section-content .conversation-item[aria-selected="true"] .cb-agent-card,body[data-vscode-theme-name] .conversation-section-content .conversation-item[class*="_selected_"] .cb-agent-card,body[data-vscode-theme-name] .conversation-section-content .cb-agent-card[class*="_selected_"]{background:color-mix(in srgb,var(--wb-bg-primary) 32%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 32%,transparent) !important;backdrop-filter:blur(14px) saturate(1.15) !important;-webkit-backdrop-filter:blur(14px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}',
  },
  {
    id: 'patch-84',
    desc: '主页路由主体(.wb-home-route__body)去背景色全透明（用户 08-29 18:02 要求透明，撤销此前 45% 毛玻璃）；主页整链 teams-main-content / wb-home-route / wb-home-route__body 全透明，层次由输入框毛玻璃局部呈现',
    css: 'body[data-vscode-theme-name] .teams-main-content main.wb-home-route > .wb-home-route__body{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-85',
    desc: '会话输入框容器(cr-input-container，新版 5.4.4 conversation-input 内)毛玻璃：42% 半透明 bg-primary + blur(18px)，与整体系列毛玻璃风格统一；会话主区域已透明，输入框需保留层次（用户要求）',
    css: 'body[data-vscode-theme-name] .conversation-input .cr-input-box__main .cr-input-container{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}',
  },
  {
    id: 'patch-86',
    desc: '消息列表滚动到底部渐变色去除·v3（用户 08-29 18:16 反馈仍存在）：清理面从 content--revealed 扩大到整条虚拟滚动链 cr-message-list-viewport / cr-message-list / content--revealed / cr-document / virtual-spacer，清 background-image 与 mask 全家族（含简写），隐藏所有承载渐变的 ::before/::after',
    css: 'body[data-vscode-theme-name] .cr-message-list-viewport,body[data-vscode-theme-name] .cr-message-list,body[data-vscode-theme-name] .cr-message-list__content.cr-message-list__content--revealed,body[data-vscode-theme-name] .cr-document,body[data-vscode-theme-name] .cr-document__virtual-spacer{background-image:none !important;mask:none !important;-webkit-mask:none !important;mask-image:none !important;-webkit-mask-image:none !important;}body[data-vscode-theme-name] .cr-message-list-viewport::before,body[data-vscode-theme-name] .cr-message-list-viewport::after,body[data-vscode-theme-name] .cr-message-list::before,body[data-vscode-theme-name] .cr-message-list::after,body[data-vscode-theme-name] .cr-message-list__content.cr-message-list__content--revealed::before,body[data-vscode-theme-name] .cr-message-list__content.cr-message-list__content--revealed::after,body[data-vscode-theme-name] .cr-document::before,body[data-vscode-theme-name] .cr-document::after,body[data-vscode-theme-name] .cr-document__virtual-spacer::before,body[data-vscode-theme-name] .cr-document__virtual-spacer::after{display:none !important;background-image:none !important;background:transparent !important;mask:none !important;-webkit-mask:none !important;mask-image:none !important;-webkit-mask-image:none !important;}',
  },
  {
    id: 'patch-87',
    desc: '输入框底部工具栏右侧(cr-input-toolbar__right)全局背景透明（会话页 + 主页 wb-home-composer 均命中）：官方不透明底 → 完全透明，露出输入框容器(cr-input-container)的毛玻璃层（用户 08-29 要求，主页版同步覆盖）',
    css: 'body[data-vscode-theme-name] .cr-input-toolbar__right{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-88',
    desc: '会话页最外层内容容器(teams-main-content)去背景色全透明（用户 08-29 18:02 要求透明，撤销此前 42% 毛玻璃）；配合 conversation-shell/shell__main 全透明，整体露出背景，层次由 topbar/气泡/输入框等局部毛玻璃呈现',
    css: 'body[data-vscode-theme-name] .teams-main-content{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-89',
    desc: '会话容器分层整理（用户 08-30 00:20 修正）：conversation-shell 深色主题下半透明黑 45%（无 blur，仅底色，不影响背景图清晰度；浅色主题如护眼绿不受影响）；teams 布局最外层 grid 网格项(_gridViewItem_)透明；主页路由 main.wb-home-route 透明；侧栏会话列表 tab 按钮(conversation-list-tab-button-box)透明',
    css: 'html[data-theme="dark"] body[data-vscode-theme-name] .conversation-shell{background:rgba(0,0,0,0.45) !important;background-color:rgba(0,0,0,0.45) !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .teams-container.is-mac [class*="_gridViewItem_"]{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .teams-main-content main.wb-home-route{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .conversation-list-tab-button.conversation-list-tab-button-box{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-90',
    desc: '局部毛玻璃组（用户 08-29 18:02/18:16 批量需求，统一 42% bg-primary + blur(18px)）：workbuddy-topbar--mac 顶栏、会话自己的消息气泡(cr-self-bubble)、滚动到底按钮(cr-scroll-to-bottom__inner)、主页输入框本体(cr-input-box__main)；markdown 分隔线 cr-markdown hr 改毛玻璃质感（硬边框 → 半透明主题色渐变线）',
    css: 'body[data-vscode-theme-name] .workbuddy-topbar--mac,body[data-vscode-theme-name] .cr-self-message .cr-self-bubble,body[data-vscode-theme-name] .cr-scroll-to-bottom,body[data-vscode-theme-name] .cr-scroll-to-bottom__inner,body[data-vscode-theme-name] .wb-home-composer .cr-input-box__main{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}body[data-vscode-theme-name] .cr-markdown hr{background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--wb-color-text-secondary) 30%,transparent) 50%,transparent) !important;border:none !important;height:1px !important;border-radius:1px !important;box-shadow:none !important;}',
  },
  {
    id: 'patch-91',
    desc: '主页输入框容器(.wb-home-composer 内 cr-input-container)改透明背景（用户 08-29 18:02 要求）：主页输入区层次为本体 cr-input-box__main 毛玻璃(patch-90) + 容器与工具栏全透明',
    css: 'body[data-vscode-theme-name] .wb-home-composer .cr-input-container{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-92',
    desc: '侧栏会话卡片未读圆点(_unreadDot_，挂 cb-agent-card 的 header 内)适配主题：圆点由 ::before 实现（官方硬编码 rgb(0,194,154) 青绿、局部 --wb-accent-unread 也被官方污染为青绿；无 --wb-accent 定义导致 fallback 蓝色突兀），改为主题文字色 var(--wb-color-text-primary)（WorkDaddy 建主题必定义：深色=白/浅色=深绿，与主题绝对协调），fallback #8a8f98 中性灰；容器自身保持透明背景（用户 08-30 10:40 修正 10:36 的蓝色）',
    css: 'html[data-wbs-theme="1"] body[data-vscode-theme-name] .cb-agent-card [class*="_unreadDot_"]{background:transparent !important;background-color:transparent !important;}html[data-wbs-theme="1"] body[data-vscode-theme-name] .cb-agent-card [class*="_unreadDot_"]::before{background:var(--wb-color-text-primary,#8a8f98) !important;background-color:var(--wb-color-text-primary,#8a8f98) !important;}',
  },
  {
    id: 'patch-93',
    desc: '细节适配组（用户 08-29 18:21 / 08-30 09:57 调整）：1) 深度思考推理区 cr-collapse__content(-inner) 左侧边框线条去掉；2) markdown 表格：外层容器 cr-table-block 透明背景，表格本体 cr-table-block table 毛玻璃(42%+blur18) + 表头 thead/th 半透明背景；3) 会话列表 tab 行 conversation-list-tab-row 鼠标悬浮时毛玻璃背景（仅背景/模糊，不改变布局）',
    css: 'body[data-vscode-theme-name] .cr-reasoning .cr-collapse__content,body[data-vscode-theme-name] .cr-reasoning .cr-collapse__content-inner{border-left:none !important;}body[data-vscode-theme-name] .cr-markdown .cr-table-block{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}body[data-vscode-theme-name] .cr-markdown .cr-table-block .cr-table-block__inner table,body[data-vscode-theme-name] .cr-markdown .cr-table-block table{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}body[data-vscode-theme-name] .cr-markdown .cr-table-block thead,body[data-vscode-theme-name] .cr-markdown .cr-table-block thead th{background:color-mix(in srgb,var(--wb-bg-secondary) 52%,transparent) !important;}body[data-vscode-theme-name] .conversation-list-tab-row:hover{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}',
  },
  {
    id: 'patch-94',
    desc: '会话消息列表底部渐变色(cr-message-list__bottom-mask, 72px 高)改透明：官方 background-image 硬编码 linear-gradient(rgba(0,0,0,0),rgb(20,20,20))，滚动场景下 expose 渐变，用户要求顶部/中部/底部均无渐变遮罩（非默认主题注入）',
    css: 'body[data-vscode-theme-name] .cr-message-list__bottom-mask{background-image:none !important;background:transparent !important;background-color:transparent !important;mask:none !important;-webkit-mask:none !important;mask-image:none !important;-webkit-mask-image:none !important;}body[data-vscode-theme-name] .cr-message-list__bottom-mask::before,body[data-vscode-theme-name] .cr-message-list__bottom-mask::after{background-image:none !important;background:transparent !important;mask:none !important;-webkit-mask:none !important;}',
  },
  {
    id: 'patch-95',
    desc: '工具调用展开内容(cr-tool-exp__content)背景半透明（用户 08-30 00:46）：官方硬编码 rgb(42,44,49) 不透明纯色块 → 45% 主题次级底 + 轻微 blur，与整体毛玻璃语言统一',
    css: 'body[data-vscode-theme-name] .cr-tool-exp__content-shell .cr-tool-exp__content,body[data-vscode-theme-name] .cr-tool-exp__content{background:color-mix(in srgb,var(--wb-bg-tertiary) 45%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-tertiary) 45%,transparent) !important;backdrop-filter:blur(16px) saturate(1.15) !important;-webkit-backdrop-filter:blur(16px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}',
  },
  {
    id: 'patch-96',
    desc: '左侧栏整理（用户 08-30 00:52 调整）：conversation-sidebar 外层改与顶栏(workbuddy-topbar--mac)相同的毛玻璃 42% + blur(18px)；内部容器（list/topbar/content/section 等）保持透明避免叠层；选中会话卡片 32% 毛玻璃选中态保留（patch-83）',
    css: 'body[data-vscode-theme-name] .conversation-sidebar{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;}body[data-vscode-theme-name] .conversation-list,body[data-vscode-theme-name] [data-view-id="sidebar"],body[data-vscode-theme-name] .conversation-list-topbar,body[data-vscode-theme-name] .conversation-list-content,body[data-vscode-theme-name] .conversation-section,body[data-vscode-theme-name] .conversation-section-content,body[data-vscode-theme-name] .conversation-section-groups{background:transparent !important;background-color:transparent !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  },
  {
    id: 'patch-97',
    desc: '代码块容器(cr-code-like-box)背景毛玻璃（用户 08-30 01:16）：官方硬编码 rgb(26,27,30) 不透明 → 45% 主题深色底 + blur(16px)，与消息区毛玻璃语言统一',
    css: 'body[data-vscode-theme-name] .cr-code-like-box{background:color-mix(in srgb,var(--wb-bg-primary) 45%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 45%,transparent) !important;backdrop-filter:blur(16px) saturate(1.15) !important;-webkit-backdrop-filter:blur(16px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}',
  },
  {
    id: 'patch-98',
    desc: '代码块头部(cr-code-like-box__header)背景半透明（用户 08-30 01:16）：官方硬编码 rgb(20,21,24) 不透明 → 32% 主题深色底（比容器略深形成层次，无独立 blur 透出容器毛玻璃）',
    css: 'body[data-vscode-theme-name] .cr-code-like-box__header{background:color-mix(in srgb,var(--wb-bg-primary) 32%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 32%,transparent) !important;border-color:var(--wb-border-subtle) !important;}',
  },
  {
    id: 'patch-99',
    desc: 'WorkBuddy 主题会话 widget 卡片(.cr-widget-card)使用主题毛玻璃，标题(.cr-widget-header)改为半透明以透出卡片层次',
    css: 'body[data-vscode-theme-name] .cr-widget-card{background:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 42%,transparent) !important;backdrop-filter:blur(18px) saturate(1.15) !important;-webkit-backdrop-filter:blur(18px) saturate(1.15) !important;border-color:var(--wb-border-subtle) !important;}body[data-vscode-theme-name] .cr-widget-header{background:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;background-color:color-mix(in srgb,var(--wb-bg-primary) 30%,transparent) !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;border-color:var(--wb-border-subtle) !important;}',
  },
  /* 原 patch-82（AI 端快捷短语弹层 z-index 抬升）已移入 inject.js 常驻样式：
     theme-patches 仅在非默认主题时注入，默认浅色主题下会失效；层级修复不依赖主题，随注入脚本常驻更可靠。 */
];
