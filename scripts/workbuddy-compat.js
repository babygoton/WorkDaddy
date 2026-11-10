'use strict';

// WorkBuddy renderer compatibility seam. Keep volatile DOM/React discovery here;
// inject.js owns user-facing behavior and calls these selectors through one API.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__wbsWorkBuddyCompat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasQueueMethods(value) {
    return !!value && typeof value === 'object' &&
      typeof value.enqueueConversationMessageQueueItem === 'function' &&
      typeof value.pauseConversationMessageQueue === 'function';
  }

  function isVisible(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findModernToolbar(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var toolbar = doc.querySelector('div.cr-input-toolbar__right');
    return isVisible(toolbar) ? { kind: 'modern', element: toolbar } : null;
  }

  function findLegacyToolbar(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    var candidates = doc.querySelectorAll(
      '[class*="_inputBottom_"] > [class*="_gapLarge_"],' +
      '[class*="_inputBottom_"] > [class*="_gap_"]:not([class*="_selector_"]),' +
      '[class*="_inputBottom_"] > [class*="_item_"]:not([class*="_selector_"])'
    );
    var best = null;
    var bestLeft = -Infinity;
    for (var i = 0; i < candidates.length; i++) {
      if (!isVisible(candidates[i])) continue;
      var left = candidates[i].getBoundingClientRect().left;
      if (left > bestLeft) {
        best = candidates[i];
        bestLeft = left;
      }
    }
    return best ? { kind: 'legacy', element: best } : null;
  }

  function findComposerToolbar(doc) {
    return findModernToolbar(doc) || findLegacyToolbar(doc);
  }

  // Shared geometry for conversation-owned overlays. The shell can remain
  // mounted at its old size behind a fullscreen artifact preview.
  function findConversationArea(doc, preferred) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    var win = doc.defaultView;
    function visibleRect(node) {
      if (!node || node.isConnected === false) return null;
      for (var p = node; p && p !== doc; p = p.parentElement) {
        var css = win && win.getComputedStyle ? win.getComputedStyle(p) : null;
        if (css && (css.display === 'none' || css.visibility === 'hidden' ||
            css.visibility === 'collapse' || css.opacity === '0')) return null;
      }
      var box = node.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return null;
      var left = Math.max(0, box.left), top = Math.max(0, box.top);
      var right = Math.min(win && win.innerWidth || box.right, box.right);
      var bottom = Math.min(win && win.innerHeight || box.bottom, box.bottom);
      return right > left && bottom > top ? { left:left, top:top, right:right, bottom:bottom,
        width:right-left, height:bottom-top } : null;
    }
    var own = preferred && preferred.closest && preferred.closest('.conversation-shell');
    var shells = own ? [own] : Array.from(doc.querySelectorAll('.conversation-shell'));
    // Only old clients may use the legacy chat host. A missing modern shell
    // must not fall back to the teams grid or the whole application window.
    if (!shells.length && !doc.querySelector('.teams-container,.conversation-page-chrome')) {
      shells = Array.from(doc.querySelectorAll('.chat-container'));
    }
    var previews = Array.from(doc.querySelectorAll('.detail-panel-container'));
    var fallback = shells.length ? { element:shells[0], rect:null } : null;
    for (var i = 0; i < shells.length; i++) {
      var rect = visibleRect(shells[i]);
      if (!rect) continue;
      for (var j = 0; j < previews.length && rect; j++) {
        var cover = visibleRect(previews[j]);
        if (!cover || cover.top > rect.top || cover.bottom < rect.bottom ||
            cover.right <= rect.left || cover.left >= rect.right) continue;
        if (cover.left <= rect.left && cover.right >= rect.right) rect = null;
        else if (cover.right >= rect.right) rect.right = cover.left;
        else if (cover.left <= rect.left) rect.left = cover.right;
        if (rect) rect.width = rect.right - rect.left;
      }
      if (rect) return { element:shells[i], rect:rect };
    }
    return fallback;
  }

  function findMessageNavigationSurface(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    try {
      // WorkBuddy keeps this host stable across renderer layout revisions. The
      // nested viewport/content/document classes are implementation details and
      // may disappear even while the message list remains mounted.
      var messageList = doc.querySelector('div.cr-message-list');
      if (!messageList) return null;
      var viewportElement = messageList.parentElement || messageList;
      return {
        scrollElement: messageList,
        viewportElement: viewportElement,
        contentElement: messageList,
        conversationElement: messageList,
      };
    } catch (_) {
      return null;
    }
  }

  function collectMessageNavigationTurnsFromMessages(messages) {
    var list = Array.isArray(messages) ? messages : [];
    var turns = [];
    var current = null;
    var seenIds = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var message = list[i];
      if (!message || typeof message !== 'object') continue;
      if (message.messageType === 'user') {
        // 过滤发送中的临时消息：只有 requestId（req-* 前缀）而无真实服务端 id 的 user 消息，
        // 在 DOM/消息流里没有可定位的帧（5.4.4 发送中 pending 消息不落虚拟列表），跳过不建 turn。
        var realId = message.id ? String(message.id) : '';
        var reqId = message.requestId ? String(message.requestId) : '';
        if (!realId && /^req-/.test(reqId)) continue;
        var messageId = realId || reqId || ('message-' + i);
        var baseId = messageId;
        var id = baseId;
        var duplicate = 2;
        while (seenIds[id]) id = baseId + '-' + duplicate++;
        seenIds[id] = true;
        current = {
          id: id,
          // messageId 保持原始 id 用于滚动定位（supports scrollToMessage(id)）；
          // turn.id 若被去重加后缀（同 id 多轮），滚动仍用原始 messageId。
          messageId: messageId,
          messageIndex: i,
          userMessage: message,
          assistantMessage: null,
        };
        turns.push(current);
        continue;
      }
      if (message.messageType === 'assistant' && current) current.assistantMessage = message;
    }
    return turns;
  }

  function findSessionForkSelection(frame, messageStore) {
    try {
      var id = frame && frame.getAttribute('data-cr-frame-id');
      var state = messageStore && messageStore.getState();
      var messages = state && state.messages;
      if (!id || !Array.isArray(messages) || !messages.length || messages.length > 10000) return null;
      var roles = '';
      var index = -1;
      for (var i = 0; i < messages.length; i++) {
        var message = messages[i];
        if (!message || (message.messageType !== 'user' && message.messageType !== 'assistant')) return null;
        roles += message.messageType === 'user' ? 'u' : 'a';
        if (message.id === id) index = i;
      }
      var selected = messages[index];
      if (!selected || selected.messageType !== 'assistant' ||
          selected.complete === false || selected.isEnd === false ||
          !Number.isSafeInteger(selected.finishTime) || selected.finishTime <= 0) return null;
      return { messageIndex: index, roles: roles, finishedAt: selected.finishTime };
    } catch (_) {
      return null;
    }
  }

  function selectedConversationId(candidates) {
    var list = Array.isArray(candidates) ? candidates : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var classes = String(item.className || '') + ' ' + String(item.childClassName || '');
      if (item.ariaSelected === true || item.ariaSelected === 'true' ||
          /(^|\s)active(\s|$)/.test(classes) || /_selected_/.test(classes)) {
        var id = String(item.conversationId || '').trim();
        if (id) return id;
      }
    }
    return null;
  }

  function getModernSelectedConversationId(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    try {
      var nodes = doc.querySelectorAll('.conversation-item[data-conversation-id]');
      var candidates = [];
      for (var i = 0; i < nodes.length; i++) {
        var child = nodes[i].firstElementChild;
        candidates.push({
          conversationId: nodes[i].getAttribute('data-conversation-id'),
          ariaSelected: nodes[i].getAttribute('aria-selected') || (child && child.getAttribute && child.getAttribute('aria-selected')),
          className: nodes[i].className,
          childClassName: child && child.className,
        });
      }
      var selected = selectedConversationId(candidates);
      if (selected) return selected;
      if (typeof doc.querySelector === 'function') {
        var current = doc.querySelector('.cr-document[data-root-id]');
        if (current) return current.getAttribute('data-root-id') || null;
      }
    } catch (_) {}
    return null;
  }

  function getLegacySelectedConversationId(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    try {
      var selected = doc.querySelector(
        '[data-conversation-id].active,' +
        '[data-conversation-id][aria-selected="true"],' +
        '.conversation-item.active,' +
        '[data-conversation-id][class*="active"],' +
        '.conv-item.active,' +
        '[class*="conversation"][class*="active"]'
      );
      return selected && (selected.getAttribute('data-conversation-id') || selected.getAttribute('data-id')) || null;
    } catch (_) {
      return null;
    }
  }

  function getSelectedConversationId(doc) {
    return getModernSelectedConversationId(doc) || getLegacySelectedConversationId(doc);
  }

  function reactFiber(element) {
    if (!element) return null;
    for (var key in element) {
      if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance') === 0) return element[key];
    }
    return null;
  }

  function isConversationController(value) {
    return !!value && typeof value === 'object' && value.conversationId &&
      value.messageStore && typeof value.messageStore.getState === 'function' &&
      typeof value.messageStore.subscribe === 'function' &&
      (typeof value.getMessagesViewState === 'function' ||
       typeof value.getSessionViewState === 'function' ||
       typeof value.getMessageStore === 'function');
  }

  function isMessageNavigationHandle(value) {
    return !!value && typeof value === 'object' &&
      typeof value.scrollToMessage === 'function' &&
      typeof value.getScrollMetrics === 'function';
  }

  function controllerFromFiber(element, conversationId) {
    var fiber = reactFiber(element);
    var seen = 0;
    while (fiber && seen++ < 700) {
      var props = fiber.memoizedProps;
      var candidates = props && [props.value, props.controller, props.adapter];
      for (var i = 0; candidates && i < candidates.length; i++) {
        var candidate = candidates[i];
        if (!isConversationController(candidate)) continue;
        if (!conversationId || String(candidate.conversationId) === String(conversationId)) return candidate;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function navigationHandleFromFiber(element) {
    var fiber = reactFiber(element);
    var seen = 0;
    while (fiber && seen++ < 700) {
      var props = fiber.memoizedProps;
      var value = props && props.value;
      var candidates = props && [props.handle, value && value.handle, value];
      for (var i = 0; candidates && i < candidates.length; i++) {
        if (isMessageNavigationHandle(candidates[i])) return candidates[i];
      }
      fiber = fiber.return;
    }
    return null;
  }

  function findMessageNavigationAdapter(doc, surface) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var currentSurface = surface || findMessageNavigationSurface(doc);
    if (!currentSurface) return null;
    try {
      var conversationId = currentSurface.conversationElement.getAttribute &&
        currentSurface.conversationElement.getAttribute('data-root-id');
      var controllerRoots = [
        currentSurface.conversationElement,
        currentSurface.scrollElement,
        doc.querySelector('.conversation-shell'),
        doc.querySelector('#root > div'),
      ];
      var controller = null;
      for (var i = 0; i < controllerRoots.length && !controller; i++) {
        if (controllerRoots[i]) controller = controllerFromFiber(controllerRoots[i], conversationId);
      }
      var navigationHandle = navigationHandleFromFiber(currentSurface.scrollElement) ||
        navigationHandleFromFiber(currentSurface.viewportElement) ||
        navigationHandleFromFiber(currentSurface.contentElement);
      if (!controller || !navigationHandle) return null;
      return {
        controller: controller,
        messageStore: controller.messageStore,
        navigationHandle: navigationHandle,
      };
    } catch (_) {
      return null;
    }
  }

  // Discover every mounted ConversationController by capability shape rather
  // than volatile component/class names. Shared fibers are de-duplicated so a
  // large conversation tree is walked once per fiber, not once per element.
  function findConversationControllers(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return [];
    var root = doc.querySelector('#root > div') || doc.querySelector('#root');
    if (!root) return [];
    var found = Object.create(null);
    var fibers = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var stack = [root];
    var visitedElements = 0;
    while (stack.length && visitedElements++ < 1400) {
      var element = stack.pop();
      var fiber = reactFiber(element);
      var seen = 0;
      while (fiber && seen++ < 800) {
        if (!fibers || !fibers.has(fiber)) {
          if (fibers) fibers.add(fiber);
          var props = fiber.memoizedProps;
          var candidates = props && [props.value, props.controller, props.adapter];
          for (var i = 0; candidates && i < candidates.length; i++) {
            var candidate = candidates[i];
            if (!isConversationController(candidate)) continue;
            var id = String(candidate.conversationId || '').trim();
            if (id && !found[id]) found[id] = candidate;
          }
        }
        fiber = fiber.return;
      }
      var children = element && element.children || [];
      for (var ci = 0; ci < children.length; ci++) stack.push(children[ci]);
    }
    return Object.keys(found).map(function (id) { return found[id]; });
  }

  function findModernQueueAdapter(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    try {
      var root = doc.querySelector('#root > div') || doc.querySelector('#root');
      if (!root) return null;
      var stack = [root];
      var visitedElements = 0;
      while (stack.length && visitedElements++ < 300) {
        var element = stack.pop();
        var fiber = reactFiber(element);
        var seen = 0;
        while (fiber && seen++ < 400) {
          var props = fiber.memoizedProps;
          if (props && hasQueueMethods(props.adapter)) return { kind: 'modern', adapter: props.adapter };
          fiber = fiber.return;
        }
        var children = element && element.children || [];
        for (var i = 0; i < children.length; i++) stack.push(children[i]);
      }
    } catch (_) {}
    return null;
  }

  function findLegacyQueueAdapter(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var roots = [
      doc.querySelector('.voice-mic-wrap'),
      doc.querySelector('[class*="_cbChat_"]'),
      doc.querySelector('.chat-container'),
    ];
    for (var ri = 0; ri < roots.length; ri++) {
      var node = roots[ri];
      for (var up = 0; up < 30 && node; up++) {
        var fiber = reactFiber(node);
        var seen = 0;
        while (fiber && seen++ < 150) {
          var props = fiber.memoizedProps;
          if (props && typeof props === 'object') {
            for (var key in props) {
              var value;
              try { value = props[key]; } catch (_) { continue; }
              if (hasQueueMethods(value)) return { kind: 'legacy', adapter: value };
            }
          }
          fiber = fiber.return;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  // CodeBuddy 4.12 uses square IconButton controls without an aria-label.
  // Identify the official submit handler by its editor preparation contract,
  // never by geometry or position (our composer buttons share that toolbar).
  function findCodeBuddySendButton(doc) {
    if (!doc) return null;
    var selector = '[class*="_inputBox_"]';
    var active = doc.activeElement;
    var box = active && active.closest ? active.closest(selector) : null;
    if (!box) {
      var boxes = Array.from(doc.querySelectorAll(selector)).filter(function (el) {
        return !el.getBoundingClientRect || el.getBoundingClientRect().width > 0;
      });
      if (boxes.length !== 1) return null;
      box = boxes[0];
    }
    var matches = Array.from(box.querySelectorAll('[role="button"],button')).filter(function (el) {
      if (el.closest('.wbs-root,.wbs-stash-inline')) return false;
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactProps') === 0; });
      var handler = key && el[key] && el[key].onClick;
      if (typeof handler !== 'function') return false;
      var source = Function.prototype.toString.call(handler);
      return source.indexOf('prepareBeforeSubmit') >= 0 && source.indexOf('flushPendingContentChange') >= 0;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function findQueueAdapter(doc) {
    return findModernQueueAdapter(doc) || findLegacyQueueAdapter(doc);
  }

  // The conversation-list click handler is the only public path that performs
  // the real route transition. Its minified body is rewritten between releases,
  // so match a group of stable string/property markers instead of one release's
  // private symbols. Groups are OR'd with each other; markers inside a group are
  // AND'd. Prefer the newest group first so a build that carries several marker
  // sets is classified by the current contract.
  var CONVERSATION_NAVIGATION_MARKER_GROUPS = [
    // WorkBuddy >= 5.7: ConversationList loader. Dedupes on loadSession, reads
    // options.conversationEngineRouteTarget and honours preserveListView.
    ['preserveListView', 'conversationEngineRouteTarget', 'loadSession'],
    // WorkBuddy <= 5.6: hover peek dismissal plus task route sync. Both symbols
    // were dropped in 5.7, so this group only matches older renderers.
    ['dismissHoverPeek', 'syncTaskRouteFromClick'],
  ];

  function functionLooksLikeConversationNavigation(value, nativeCodeBuddy) {
    if (typeof value !== 'function') return false;
    try {
      var source = Function.prototype.toString.call(value);
      if (nativeCodeBuddy && source.indexOf('SessionLoadCancelledError') >= 0 &&
          source.indexOf('getPendingMessageTracker') >= 0 && source.indexOf('getInitialMessages') >= 0) return true;
      for (var gi = 0; gi < CONVERSATION_NAVIGATION_MARKER_GROUPS.length; gi++) {
        var group = CONVERSATION_NAVIGATION_MARKER_GROUPS[gi];
        var matched = true;
        for (var mi = 0; mi < group.length; mi++) {
          if (source.indexOf(group[mi]) < 0) { matched = false; break; }
        }
        if (matched) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function findConversationNavigationHandler(doc, nativeCodeBuddy) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    var roots = [
      doc.querySelector('#root > div'),
      doc.querySelector('.conversation-list'),
      doc.querySelector('.conversation-shell'),
      doc.querySelector('.conversation-item'),
      nativeCodeBuddy ? doc.querySelector('[data-conversation-id]') : null,
    ];
    for (var ri = 0; ri < roots.length; ri++) {
      var root = roots[ri];
      var fiber = reactFiber(root);
      var fiberSeen = 0;
      while (fiber && fiberSeen++ < 700) {
        var hook = fiber.memoizedState;
        var hookSeen = 0;
        while (hook && hookSeen++ < 700) {
          var state = hook.memoizedState;
          var candidate = state && typeof state === 'object' ? state.current : null;
          if (functionLooksLikeConversationNavigation(candidate, nativeCodeBuddy)) return candidate;
          if (functionLooksLikeConversationNavigation(state, nativeCodeBuddy)) return state;
          hook = hook.next;
        }
        fiber = fiber.return;
      }
    }
    return null;
  }

  function isSessionsResource(value) {
    return !!value && typeof value === 'object' &&
      typeof value.on === 'function' && typeof value.off === 'function' &&
      (typeof value.list === 'function' || typeof value.getByIds === 'function');
  }

  // The facade publishes sessionUpdated/sessionsChanged for background sessions
  // even after their ConversationController has left the mounted React tree.
  function findSessionsResource(doc) {
    var found = findQueueAdapter(doc);
    var resource = found && found.adapter && found.adapter.sessionsResource;
    return isSessionsResource(resource) ? resource : null;
  }

  // WorkBuddy's conversation list owns the real navigation path, so prefer the
  // official handler found in its React hooks (or the session-navigation SDK
  // when a build exposes it). adapter.emit is retained for older builds whose
  // list did not expose the handler at all.
  function findConversationActivationApi(doc, options) {
    var nativeCodeBuddy = !!(options && /^codebuddy-(cn|intl)$/.test(options.profileId));
    var found = findQueueAdapter(doc);
    var adapter = found && found.adapter;
    var resource = findSessionsResource(doc);
    var handler = findConversationNavigationHandler(doc, nativeCodeBuddy);
    var sdkNavigate = null;
    try {
      var conversations = typeof window !== 'undefined' && window.wb && window.wb.conversations;
      // Only a real route transition may be treated as authoritative. The
      // sibling `setCurrentConversation` looks similar but merely reports the
      // active conversation to the main process; it never navigates, so a
      // fallback onto it produced an "official-dispatched" log with no page
      // change and retried until the activation timeout.
      if (conversations && typeof conversations.navigateToSession === 'function') {
        sdkNavigate = conversations.navigateToSession;
      }
    } catch (_) {}
    if (!handler && !sdkNavigate && (nativeCodeBuddy || !adapter || typeof adapter.emit !== 'function')) return null;
    return {
      authoritative: !!(handler || sdkNavigate),
      hasSession: function (sessionId) {
        var id = String(sessionId || '').trim();
        if (!id || !resource || typeof resource.getByIds !== 'function') return Promise.resolve(null);
        try {
          return Promise.resolve(resource.getByIds([id])).then(function (result) {
            // The renderer adapter normalizes the session resource response to
            // `conversations`; lower-level/test adapters may expose `sessions`
            // or return the array directly.
            var sessions = result && Array.isArray(result.conversations) ? result.conversations :
              result && Array.isArray(result.sessions) ? result.sessions :
              Array.isArray(result) ? result : [];
            return sessions.some(function (item) { return String(item && (item.id || item.sessionId) || '') === id; });
          });
        } catch (_) {
          return Promise.resolve(false);
        }
      },
      activate: function (sessionId) {
        var id = String(sessionId || '').trim();
        if (!id) return false;
        try {
          if (handler) {
            Promise.resolve(handler(id, '', false, false, nativeCodeBuddy ? undefined : {})).catch(function () {});
          } else if (sdkNavigate) {
            var conversationsApi = (typeof window !== 'undefined' && window.wb && window.wb.conversations) || null;
            Promise.resolve(sdkNavigate.call(conversationsApi, id, { ensureLoaded: true })).catch(function () {});
          } else {
            adapter.emit('jump-to-conversation', {
              source: 'tencent-docs',
              sessionId: id,
              reason: 'already-active',
            });
          }
          return true;
        } catch (_) {
          return false;
        }
      },
    };
  }

  // Sidebar records are an initial/reconciliation snapshot only. Live updates
  // come from sessionsResource; this narrow fiber walk avoids scanning the page.
  function findConversationListRecords(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return [];
    try {
      var element = doc.querySelector('.conversation-list .conversation-item') ||
        doc.querySelector('.conversation-list');
      var fiber = reactFiber(element);
      var seen = 0;
      while (fiber && seen++ < 80) {
        var props = fiber.memoizedProps;
        var records = props && props.allConversations;
        if (Array.isArray(records) && records.some(function (item) {
          return item && item.id && typeof item.status === 'string';
        })) return records;
        fiber = fiber.return;
      }
    } catch (_) {}
    return [];
  }

  function hasModernQueueSurface(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    return !!findModernQueueAdapter(doc) || !!doc.querySelector(
      '.cr-input-toolbar__right,.cr-document[data-root-id],.conversation-shell'
    );
  }

  function markQueueAdapter(adapter, kind) {
    if (!adapter || typeof adapter !== 'object') return adapter;
    try {
      Object.defineProperty(adapter, '__wbsCompatKind', {
        value: kind,
        configurable: true,
        enumerable: false,
      });
    } catch (_) {
      adapter.__wbsCompatKind = kind;
    }
    return adapter;
  }

  function isModernQueueAdapter(adapter) {
    return !!adapter && adapter.__wbsCompatKind === 'modern';
  }

  function draftStorageKey(sessionId) {
    var id = String(sessionId || '').trim();
    return id ? 'cb-draft:' + id : null;
  }

  function isComposerStore(store, sessionId) {
    try {
      if (!store || typeof store !== 'object' || !store.api ||
          typeof store.api.clear !== 'function' || typeof store.api.setBlocks !== 'function' ||
          typeof store.api.getDraft !== 'function' || typeof store.getSnapshot !== 'function') return false;
      var snapshot = store.getSnapshot();
      return !!snapshot && String(snapshot.activeSessionId || '') === String(sessionId || '');
    } catch (_) {
      return false;
    }
  }

  return {
    draftStorageKey: draftStorageKey,
    collectMessageNavigationTurnsFromMessages: collectMessageNavigationTurnsFromMessages,
    findComposerToolbar: findComposerToolbar,
    findConversationArea: findConversationArea,
    findCodeBuddySendButton: findCodeBuddySendButton,
    findLegacyQueueAdapter: findLegacyQueueAdapter,
    findModernQueueAdapter: findModernQueueAdapter,
    findQueueAdapter: findQueueAdapter,
    findSessionsResource: findSessionsResource,
    findConversationActivationApi: findConversationActivationApi,
    findConversationListRecords: findConversationListRecords,
    findMessageNavigationAdapter: findMessageNavigationAdapter,
    findMessageNavigationSurface: findMessageNavigationSurface,
    findSessionForkSelection: findSessionForkSelection,
    findConversationControllers: findConversationControllers,
    getSelectedConversationId: getSelectedConversationId,
    hasModernQueueSurface: hasModernQueueSurface,
    isComposerStore: isComposerStore,
    isModernQueueAdapter: isModernQueueAdapter,
    markQueueAdapter: markQueueAdapter,
    selectedConversationId: selectedConversationId,
  };
});
