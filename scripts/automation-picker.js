// 自动化页面的简化元素拾取器。由 daemon 始终拼入 inject.js 的 build() 闭包，
// 与五连击 logo 打开的私有 debug 拾取器保持独立入口和 DOM 命名空间。
var automationInspectState = { active: false, hoverEl: null, hoverOutline: null, hoverOutlineOffset: null, x: 0, y: 0 };
    function buildAutomationSelector(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + el.id;
      var cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
      var sel = el.tagName.toLowerCase();
      if (cls.length) sel += '.' + cls.join('.');
      return sel;
    }
    // 元素 query 路径：从 body 到元素的完整 CSS 选择器（带 :nth-child 保证唯一，可直接 document.querySelector）
    function buildAutomationQueryPath(el) {
      if (el && el.id) return el.tagName.toLowerCase() + '#' + el.id;
      var parts = [];
      var node = el;
      while (node && node !== document.body && node !== document.documentElement) {
        var seg = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(seg + '#' + node.id); break; }
        var cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) seg += '.' + cls.join('.');
        else if (node.parentElement) {
          var idx = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
          seg += ':nth-child(' + idx + ')';
        }
        parts.unshift(seg);
        node = node.parentElement;
      }
      if (node === document.body) parts.unshift('body');
      return parts.join(' > ');
    }
    function buildAutomationXPath(el) {
      if (!el || el.nodeType !== 1) return '';
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1) {
        var name = node.tagName.toLowerCase();
        var index = 1;
        var sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(name + '[' + index + ']');
        node = node.parentElement;
      }
      return '/' + parts.join('/');
    }
    function showAutomationInspector(stack, fallbackEl) {
      try {
        var old = document.getElementById('wbs-auto-inspector');
        if (old && old.__wbsInspectAt) { old.__wbsInspectAt(stack, fallbackEl); return; }
        if (old && old.__wbsClose) old.__wbsClose();
        else if (old) old.remove();
        function filterPicked(nodesAtPoint, fallback) {
          var items = (nodesAtPoint || []).filter(function (node) {
            return node && node.nodeType === 1 && !(node.closest && (node.closest('.wbs-root') || node.closest('#wbs-auto-inspector') || node.id === 'wbs-auto-inspect-tip'));
          });
          if (!items.length && fallback) items = [fallback];
          return items;
        }
        var picked = filterPicked(stack, fallbackEl);
        var selected = picked[0];
        if (!selected) throw new Error('未找到可检查元素');

        var mask = document.createElement('div');
        mask.id = 'wbs-auto-inspector';
        mask.className = 'wbs-modal-mask wbs-auto-inspector-mask';
        mask.innerHTML =
          '<div class="wbs-auto-inspector-highlight" aria-hidden="true"></div>' +
          '<div class="wbs-modal wbs-auto-inspector-modal" role="dialog" aria-modal="false" aria-label="DOM 元素检查器">' +
          '<div class="wbs-auto-inspector-head wbs-auto-inspector-drag-handle"><div><strong>DOM 元素检查器</strong><span class="wbs-auto-inspector-current"></span></div>' +
          '<div class="wbs-auto-ins-btns"><button class="wbs-auto-ins-copy-element" type="button">复制元素</button><button class="wbs-auto-ins-close" type="button" title="关闭" aria-label="关闭元素检查器"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3 3 13"/></svg></button></div></div>' +
          '<div class="wbs-auto-inspector-main"><section class="wbs-auto-inspector-tree-pane"><div class="wbs-auto-inspector-pane-title">HTML</div><div class="wbs-auto-inspector-tree" role="tree"></div></section></div>' +
          '</div>';
        document.body.appendChild(mask);
        applyI18n(mask);

        var modal = mask.querySelector('.wbs-auto-inspector-modal');
        var dragHandle = mask.querySelector('.wbs-auto-inspector-drag-handle');
        var tree = mask.querySelector('.wbs-auto-inspector-tree');
        var current = mask.querySelector('.wbs-auto-inspector-current');
        var highlighter = mask.querySelector('.wbs-auto-inspector-highlight');
        var nodeIds = new WeakMap();
        var nodes = {};
        var nextNodeId = 1;
        var expanded = new WeakSet();

        function nodeId(node) {
          if (!nodeIds.has(node)) nodeIds.set(node, String(nextNodeId++));
          var id = nodeIds.get(node);
          nodes[id] = node;
          return id;
        }
        function nodeChildren(node) {
          var out = Array.prototype.slice.call(node && node.children || []);
          if (node && node.shadowRoot) out = out.concat(Array.prototype.slice.call(node.shadowRoot.children || []));
          return out.filter(function (child) { return !(child.closest && child.closest('.wbs-root')) && child !== mask; });
        }
        function nodeLabel(node) {
          var label = node.tagName.toLowerCase();
          if (node.id) label += '#' + node.id;
          var cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 3);
          if (cls.length) label += '.' + cls.join('.');
          return label;
        }
        function reveal(node) {
          var parent = node && node.parentElement;
          while (parent) { expanded.add(parent); parent = parent.parentElement; }
        }
        function highlight(node) {
          if (!node || !node.isConnected) { highlighter.style.display = 'none'; return; }
          var rect = node.getBoundingClientRect();
          highlighter.style.display = rect.width || rect.height ? 'block' : 'none';
          highlighter.style.left = rect.left + 'px';
          highlighter.style.top = rect.top + 'px';
          highlighter.style.width = Math.max(0, rect.width) + 'px';
          highlighter.style.height = Math.max(0, rect.height) + 'px';
        }
        function renderNode(node, depth) {
          var children = nodeChildren(node);
          var open = expanded.has(node);
          var id = nodeId(node);
          var html = '<div class="wbs-auto-inspector-node' + (node === selected ? ' selected' : '') + '" role="treeitem" data-node-id="' + id + '" style="--depth:' + depth + '">' +
            '<button class="wbs-auto-inspector-twisty" type="button" tabindex="-1">' + (children.length ? (open ? '▾' : '▸') : '') + '</button>' +
            '<span class="wbs-auto-inspector-tag">&lt;' + esc(nodeLabel(node)) + '&gt;</span>' +
            '</div>';
          if (open) children.forEach(function (child) { html += renderNode(child, depth + 1); });
          return html;
        }
        function renderTree() {
          tree.innerHTML = renderNode(document.documentElement, 0);
          var active = tree.querySelector('.wbs-auto-inspector-node.selected');
          if (active) active.scrollIntoView({ block: 'center' });
        }
        function copyElement() {
          if (!selected || !selected.isConnected) return;
          var text = (selected.innerText || selected.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
          var payload = [
            'CSS: ' + buildAutomationQueryPath(selected),
            'XPath: ' + buildAutomationXPath(selected),
            'Text: ' + text,
            'HTML:',
            selected.outerHTML,
          ].join('\n');
          copyPlainText(payload).then(function () {
            try { toast('已复制元素', false, root); } catch (_) {}
          }).catch(function () {
            try { toast('复制失败', true, root); } catch (_) {}
          });
        }
        function selectNode(node) {
          if (!node || node.nodeType !== 1) return;
          selected = node;
          reveal(node);
          current.textContent = nodeLabel(selected);
          renderTree(); highlight(node);
        }
        function inspectAt(nodesAtPoint, fallback) {
          var nextPicked = filterPicked(nodesAtPoint, fallback);
          if (!nextPicked.length) return;
          picked = nextPicked;
          selected = picked[0];
          selectNode(selected);
        }
        function clampModalPosition(left, top) {
          var rect = modal.getBoundingClientRect();
          var maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
          var maxTop = Math.max(8, window.innerHeight - rect.height - 8);
          return {
            left: Math.max(8, Math.min(maxLeft, left)),
            top: Math.max(8, Math.min(maxTop, top)),
          };
        }
        function onDragStart(event) {
          if (event.button !== 0 || event.target.closest('button')) return;
          var rect = modal.getBoundingClientRect();
          var offsetX = event.clientX - rect.left;
          var offsetY = event.clientY - rect.top;
          modal.style.position = 'fixed';
          modal.style.margin = '0';
          modal.style.transform = 'none';
          modal.style.left = rect.left + 'px';
          modal.style.top = rect.top + 'px';
          dragHandle.classList.add('dragging');
          try { dragHandle.setPointerCapture(event.pointerId); } catch (_) {}
          function onDragMove(moveEvent) {
            var position = clampModalPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
            modal.style.left = position.left + 'px';
            modal.style.top = position.top + 'px';
          }
          function onDragEnd(endEvent) {
            dragHandle.classList.remove('dragging');
            dragHandle.removeEventListener('pointermove', onDragMove);
            dragHandle.removeEventListener('pointerup', onDragEnd);
            dragHandle.removeEventListener('pointercancel', onDragEnd);
            try { dragHandle.releasePointerCapture(endEvent.pointerId); } catch (_) {}
          }
          dragHandle.addEventListener('pointermove', onDragMove);
          dragHandle.addEventListener('pointerup', onDragEnd);
          dragHandle.addEventListener('pointercancel', onDragEnd);
          event.preventDefault();
        }
        function onInspectorResize() {
          if (!modal.style.left || !modal.style.top) return;
          var position = clampModalPosition(parseFloat(modal.style.left), parseFloat(modal.style.top));
          modal.style.left = position.left + 'px';
          modal.style.top = position.top + 'px';
        }
        function closeInspector() {
          stopAutomationInspect();
          document.removeEventListener('keydown', onInspectorKey, true);
          window.removeEventListener('resize', onInspectorResize);
          dragHandle.removeEventListener('pointerdown', onDragStart);
          mask.remove();
        }
        function onInspectorKey(event) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeInspector(); }
        }
        mask.__wbsClose = closeInspector;
        mask.__wbsInspectAt = inspectAt;
        modal.addEventListener('click', function (event) { event.stopPropagation(); });
        mask.querySelector('.wbs-auto-ins-close').addEventListener('click', closeInspector);
        mask.querySelector('.wbs-auto-ins-copy-element').addEventListener('click', copyElement);
        dragHandle.addEventListener('pointerdown', onDragStart);
        window.addEventListener('resize', onInspectorResize);
        tree.addEventListener('click', function (event) {
          var row = event.target.closest('.wbs-auto-inspector-node');
          if (!row) return;
          var node = nodes[row.dataset.nodeId];
          if (event.target.closest('.wbs-auto-inspector-twisty')) {
            if (expanded.has(node)) expanded.delete(node); else expanded.add(node);
            renderTree(); return;
          }
          selectNode(node);
        });
        tree.addEventListener('mouseover', function (event) {
          var row = event.target.closest('.wbs-auto-inspector-node');
          if (row) highlight(nodes[row.dataset.nodeId]);
        });
        tree.addEventListener('mouseleave', function () { highlight(selected); });
        document.addEventListener('keydown', onInspectorKey, true);
        selectNode(selected);
        mask.querySelector('.wbs-auto-ins-close').focus();
      } catch (err) {
        try { toast('检查失败：' + String(err && err.message || err).slice(0, 80), true, root); } catch (_) {}
      }
    }
    function stopAutomationInspect() {
      automationInspectState.active = false;
      document.removeEventListener('mousemove', onAutomationInspectMove, true);
      document.removeEventListener('click', onAutomationInspectClick, true);
      document.removeEventListener('keydown', onAutomationInspectKey, true);
      if (automationInspectState.hoverEl) {
        if (automationInspectState.hoverOutline && automationInspectState.hoverOutline.hadValue) automationInspectState.hoverEl.style.setProperty('outline', automationInspectState.hoverOutline.value, automationInspectState.hoverOutline.priority);
        else automationInspectState.hoverEl.style.removeProperty('outline');
        if (automationInspectState.hoverOutlineOffset && automationInspectState.hoverOutlineOffset.hadValue) automationInspectState.hoverEl.style.setProperty('outline-offset', automationInspectState.hoverOutlineOffset.value, automationInspectState.hoverOutlineOffset.priority);
        else automationInspectState.hoverEl.style.removeProperty('outline-offset');
        automationInspectState.hoverEl = null;
        automationInspectState.hoverOutline = null;
        automationInspectState.hoverOutlineOffset = null;
      }
      var tip = document.getElementById('wbs-auto-inspect-tip');
      if (tip) tip.remove();
    }
    function onAutomationInspectMove(e) {
      automationInspectState.x = e.clientX;
      automationInspectState.y = e.clientY;
      var eventPath = e.composedPath ? e.composedPath() : [];
      var el = eventPath[0] && eventPath[0].nodeType === 1 ? eventPath[0] : e.target;
      if (el.closest && (el.closest('.wbs-root') || el.closest('#wbs-auto-inspector'))) return;
      if (automationInspectState.hoverEl && automationInspectState.hoverEl !== el) {
        if (automationInspectState.hoverOutline && automationInspectState.hoverOutline.hadValue) automationInspectState.hoverEl.style.setProperty('outline', automationInspectState.hoverOutline.value, automationInspectState.hoverOutline.priority);
        else automationInspectState.hoverEl.style.removeProperty('outline');
        if (automationInspectState.hoverOutlineOffset && automationInspectState.hoverOutlineOffset.hadValue) automationInspectState.hoverEl.style.setProperty('outline-offset', automationInspectState.hoverOutlineOffset.value, automationInspectState.hoverOutlineOffset.priority);
        else automationInspectState.hoverEl.style.removeProperty('outline-offset');
      }
      if (automationInspectState.hoverEl !== el) {
        var outlineValue = el.style.getPropertyValue('outline');
        var offsetValue = el.style.getPropertyValue('outline-offset');
        automationInspectState.hoverOutline = { hadValue: outlineValue !== '', value: outlineValue, priority: el.style.getPropertyPriority('outline') };
        automationInspectState.hoverOutlineOffset = { hadValue: offsetValue !== '', value: offsetValue, priority: el.style.getPropertyPriority('outline-offset') };
      }
      el.style.setProperty('outline', '2px solid #22d3ee', 'important');
      el.style.setProperty('outline-offset', '-2px', 'important');
      automationInspectState.hoverEl = el;
    }
    function onAutomationInspectClick(e) {
      var eventPath = e.composedPath ? e.composedPath() : [];
      var el = eventPath[0] && eventPath[0].nodeType === 1 ? eventPath[0] : e.target;
      if (el.closest && (el.closest('.wbs-root') || el.closest('#wbs-auto-inspector'))) return;
      e.preventDefault(); e.stopPropagation();
      var stack = [];
      function collectElementsAtPoint(surface) {
        var hits = [];
        try { hits = Array.prototype.slice.call(surface.elementsFromPoint(automationInspectState.x, automationInspectState.y) || []); } catch (_) {}
        hits.forEach(function (node) {
          if (stack.indexOf(node) < 0) stack.push(node);
          if (node.shadowRoot && node.shadowRoot.elementsFromPoint) collectElementsAtPoint(node.shadowRoot);
        });
      }
      collectElementsAtPoint(document);
      var inspector = document.getElementById('wbs-auto-inspector');
      if (inspector && inspector.__wbsInspectAt) inspector.__wbsInspectAt(stack, el);
      else showAutomationInspector(stack, el);
    }
    function onAutomationInspectKey(e) {
      if (e.key === 'Escape') stopAutomationInspect();
    }
    function startAutomationInspect() {
      if (automationInspectState.active) return;
      automationInspectState.active = true;
      // 检查器与 WorkDaddy 面板保持可见；只忽略它们自身的 DOM。
      document.addEventListener('mousemove', onAutomationInspectMove, true);
      document.addEventListener('click', onAutomationInspectClick, true);
      document.addEventListener('keydown', onAutomationInspectKey, true);
      var tip = document.createElement('div');
      tip.id = 'wbs-auto-inspect-tip';
      tip.textContent = '拾取模式：移动鼠标高亮元素，点击选中（Esc 退出）';
      document.body.appendChild(tip);
      applyI18n(tip);
    }
    function toggleAutomationInspect() {
      if (automationInspectState.active) { stopAutomationInspect(); return; }
      startAutomationInspect();
    }
// 自动化页面的“拾取元素”按钮调用。
window.__wbsStartAutomationPicker = function () {
  ensureAutomationPickerCss();
  toggleAutomationInspect();
};
window.__wbsStopAutomationPicker = function () {
  try { stopAutomationInspect(); } catch (e) {}
};



// 每次调用重建样式，保证重注入或手动删除后仍使用当前版本。
function ensureAutomationPickerCss() {
  if (!document.body) return;
  var old = document.getElementById('wbs-automation-picker-style');
  if (old) old.remove();
  var el = document.createElement('style');
  el.id = 'wbs-automation-picker-style';
  el.textContent = ".wbs-auto-inspector-mask{z-index:2147483647;padding:0;box-sizing:border-box;background:transparent!important;pointer-events:none}" +
    ".wbs-modal.wbs-auto-inspector-modal{position:relative;z-index:2;box-sizing:border-box;width:50vw;height:50vh;min-width:0;min-height:0;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);padding:0;overflow:hidden;resize:both;pointer-events:auto;container-name:inspector;container-type:inline-size;display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--wb-border-default,rgba(128,128,128,.25));background:var(--wb-bg-primary,#fff);font-size:12px}" +
    ".wbs-auto-inspector-head{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--wb-border-default,rgba(128,128,128,.22));background:var(--wb-bg-secondary,#f7f7f8);cursor:grab;user-select:none;touch-action:none}.wbs-auto-inspector-head.dragging{cursor:grabbing}.wbs-auto-inspector-head button{cursor:pointer}" +
    ".wbs-auto-inspector-head>div:first-child{display:flex;align-items:center;min-width:0;gap:10px}.wbs-auto-inspector-head strong{font-size:13px}.wbs-auto-inspector-current{font-family:ui-monospace,Menlo,monospace;color:var(--wb-color-text-secondary,#777);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".wbs-auto-ins-btns{display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:8px}.wbs-auto-ins-btns button{border:1px solid var(--wb-border-default,#ddd);background:var(--wb-bg-primary,#fff);border-radius:7px;padding:5px 9px;font-size:11px;cursor:pointer;color:var(--wb-color-text-secondary,#555);line-height:1}.wbs-auto-ins-btns button:hover{background:var(--wb-bg-hover,#eee);color:var(--wb-color-text-primary,#222)}.wbs-auto-ins-btns .wbs-auto-ins-copy-element{border-color:var(--wb-button-primary-bg,#1f1f1f);background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);font-weight:600}.wbs-auto-ins-btns .wbs-auto-ins-copy-element:hover{background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 86%,#fff);color:var(--wb-button-primary-fg,#fff)}.wbs-auto-ins-btns .wbs-auto-ins-close{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border-color:transparent;background:transparent}.wbs-auto-ins-close svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}" +
    ".wbs-auto-inspector-main{display:grid;grid-template-columns:minmax(0,1fr);min-height:0}.wbs-auto-inspector-tree-pane{min-width:0;min-height:0;display:grid;grid-template-rows:32px minmax(0,1fr)}.wbs-auto-inspector-pane-title{display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--wb-border-default,rgba(128,128,128,.18));font-size:11px;font-weight:600;color:var(--wb-color-text-secondary,#666);background:var(--wb-bg-secondary,#f7f7f8)}" +
    ".wbs-auto-inspector-tree{overflow:auto;min-height:0;background:var(--wb-bg-primary,#fff)}.wbs-auto-inspector-node{height:25px;display:flex;align-items:center;padding-left:calc(8px + var(--depth)*14px);font-family:ui-monospace,Menlo,monospace;white-space:nowrap;cursor:default;color:var(--wb-color-text-primary,#222)}.wbs-auto-inspector-node:hover{background:var(--wb-bg-hover,#f0f0f2)}.wbs-auto-inspector-node.selected{background:color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 18%,transparent)}.wbs-auto-inspector-twisty{width:18px;height:22px;padding:0;border:0;background:transparent;color:var(--wb-color-text-secondary,#777);cursor:pointer}.wbs-auto-inspector-tag{color:#b45309}" +
    "html.cb-dark .wbs-auto-inspector-tag,html[data-theme=\"dark\"] .wbs-auto-inspector-tag{color:#e5a85d}" +
    ".wbs-auto-inspector-highlight{position:fixed;z-index:1;display:none;pointer-events:none;box-sizing:border-box;border:2px solid #22d3ee;background:rgba(34,211,238,.16);box-shadow:0 0 0 1px rgba(4,34,43,.55)}" +
    "@container inspector (max-width:560px){.wbs-auto-inspector-head{padding:0 10px}.wbs-auto-inspector-head strong{font-size:12px}.wbs-auto-inspector-current{display:none}}" +
    "#wbs-auto-inspect-tip{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:rgba(34,211,238,.95);color:#04222b;padding:6px 16px;border-radius:20px;font-size:12px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none;white-space:nowrap}";
  (document.head || document.body).appendChild(el);
}
