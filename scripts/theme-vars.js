// WorkBuddy 主题变量别名层（热插拔模块）
// ============================================================
// 用途：官方 token 里「漏定义 / 深色下值不对」的变量，重定向到 WorkDaddy 主题变量。
// 这些是「改常量就能搞定」的样式问题（等价 vscode 主题 token 映射），不属于 DOM 魔改，
// 因此独立于 theme-patches.js（那里只保留必须针对元素写规则的补丁）。
//
// 注入时机：daemon applyThemeByCdp 生成主题 CSS 时统一附加（非 default 主题）。
// darkOnly: true 等价原补丁的 html[data-theme="dark"] 前缀，仅深色主题注入。
// 顺序：body 层在前、组件作用域层在后；同特异性后注入者胜（dark 覆盖按此排列）。
// 修改本文件后重应用主题即生效（POST /api/theme-apply，无需重启 daemon）。
// ============================================================

module.exports = {
  // body 级变量（作用域 body[data-vscode-theme-name]）
  body: [
    {
      darkOnly: true,
      vars: {
        // 官方 .cb-* 组件变量深色下仍是浅色值（浅灰 #f5f5f5 / #d1d5db），全局重定向为主题深色
        '--cb-bg-secondary': 'var(--wb-bg-tertiary)',
        '--cb-border': 'var(--wb-border-subtle)',
        // 官方 --cb-text-* 深色下未定义回退浅色，重定向为主题文字色
        '--cb-text-primary': 'var(--wb-color-text-primary)',
        '--cb-text-tertiary': 'var(--wb-color-text-secondary)',
        // 消息队列/骨架屏回退色
        '--wb-palette-gray-3': 'var(--wb-bg-primary)',
        // 问答卡片变量兜底（组件作用域还会再定义，这里保证 body 继承链有值）
        '--qad-card-bg': 'var(--wb-bg-secondary)',
        '--qad-question-color': 'var(--wb-color-text-secondary)',
        '--qad-answer-color': 'var(--wb-color-text-primary)',
      },
    },
  ],
  // 组件作用域级变量：官方在这些组件上定义了局部浅色硬编码，必须同作用域重定向（直接定义 > 继承）
  scoped: [
    {
      sel: '.cr-tool-head__primary-tooltip-anchor',
      themeId: 'nebula',
      darkOnly: false,
      // tooltip 通用补丁命中了工具标题触发器；只清空此处的背景常量，保留真实弹窗底色。
      vars: { '--wb-bg-popover': 'transparent !important' },
    },
    {
      sel: '.cb-markdown',
      darkOnly: false,
      vars: {
        // markdown 表格：官方 --cb-markdown-table-* 浅色分支继承白底值
        '--cb-markdown-table-cell-bg': 'var(--wb-bg-primary)',
        '--cb-markdown-table-header-bg': 'var(--wb-bg-secondary)',
        '--cb-markdown-table-border-color': 'var(--wb-border-strong)',
        '--cb-markdown-border-color': 'var(--wb-border-strong)',
        // markdown 代码块：官方深色下未定义的组件变量
        '--cb-markdown-code-block-header-bg': 'var(--wb-bg-secondary)',
        '--cb-markdown-code-block-title-fg': 'var(--wb-color-text-primary)',
        '--cb-markdown-code-block-action-fg': 'var(--wb-color-text-secondary)',
        '--cb-markdown-code-block-action-hover-bg': 'var(--wb-bg-hover)',
        '--cb-markdown-code-block-border': 'var(--wb-border-subtle)',
        '--cb-markdown-code-block-bg': 'var(--wb-bg-tertiary)',
      },
    },
    {
      sel: '[class*="input-area-container"]::before',
      darkOnly: false,
      vars: {
        // 输入框上方渐变：官方 var(--cb-colleagues-dashboard-bg, #FAFAFA)，浅色下变量未定义回退白色
        '--cb-colleagues-dashboard-bg': 'var(--wb-bg-primary)',
      },
    },
    // 深色下 markdown 表格边框改透明（浅色保持上方 --wb-border-strong 值）
    {
      sel: '.cb-markdown',
      darkOnly: true,
      vars: {
        '--cb-markdown-table-border-color': 'transparent !important',
        '--cb-markdown-border-color': 'transparent !important',
      },
    },
    // 问答卡片：body 层定义会被中间祖先链的局部浅色值覆盖，必须组件作用域（直接定义 > 继承）
    {
      sel: '[class*="_questionAnswerDisplay_"],[class*="_qaQuestion_"],[class*="_qaAnswerText_"],[class*="_qaAnswer_"]',
      darkOnly: true,
      vars: {
        '--qad-card-bg': 'var(--wb-bg-secondary) !important',
        '--qad-question-color': 'var(--wb-color-text-secondary) !important',
        '--qad-answer-color': 'var(--wb-color-text-primary) !important',
      },
    },
  ],
};
