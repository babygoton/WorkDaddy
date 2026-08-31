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

  function findMessageNavigationSurface(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    try {
      var scrollElement = doc.querySelector('.cr-message-list');
      var viewportElement = doc.querySelector('.cr-message-list-viewport');
      var contentElement = doc.querySelector('.cr-message-list__content');
      var conversationElement = doc.querySelector('.cr-document[data-root-id]');
      if (!scrollElement || !viewportElement || !contentElement || !conversationElement) return null;
      return {
        scrollElement: scrollElement,
        viewportElement: viewportElement,
        contentElement: contentElement,
        conversationElement: conversationElement,
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
      typeof value.getMessagesViewState === 'function';
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

  function findQueueAdapter(doc) {
    return findModernQueueAdapter(doc) || findLegacyQueueAdapter(doc);
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
    findLegacyQueueAdapter: findLegacyQueueAdapter,
    findModernQueueAdapter: findModernQueueAdapter,
    findQueueAdapter: findQueueAdapter,
    findSessionsResource: findSessionsResource,
    findConversationListRecords: findConversationListRecords,
    findMessageNavigationAdapter: findMessageNavigationAdapter,
    findMessageNavigationSurface: findMessageNavigationSurface,
    findConversationControllers: findConversationControllers,
    getSelectedConversationId: getSelectedConversationId,
    hasModernQueueSurface: hasModernQueueSurface,
    isComposerStore: isComposerStore,
    isModernQueueAdapter: isModernQueueAdapter,
    markQueueAdapter: markQueueAdapter,
    selectedConversationId: selectedConversationId,
  };
});
