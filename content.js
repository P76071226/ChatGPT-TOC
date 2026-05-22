(function () {
  const SIDEBAR_ID = 'cgpt-toc';
  const ANCHOR_ATTR = 'data-cgpt-anchor';
  const CHAT_SELECTOR = '.flex.h-full.flex-col.overflow-y-auto';
  const CACHE_KEY = 'cgptConversationIndexCache';
  const MAX_ITEMS_PER_CONVERSATION = 300;
  const MAX_CACHED_CONVERSATIONS = 50;
  const CACHE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
  const DEFAULT_SETTINGS = {
    sidebarMode: 'expanded',
    sidebarPosition: 'right',
    appearance: 'system',
    questionSort: 'oldest',
    listFontSize: 'medium',
    backgroundOpacity: 100,
  };

  let lastSignature = '';
  let pollTimer = null;
  let urlWatchTimer = null;
  let settings = { ...DEFAULT_SETTINGS };
  let conversationCache = {};
  let activeConversationKey = '';
  let lastScrollOffset = null;

  function log(...args) {
    try { console.debug('[ChatGPT-TOC]', ...args); } catch (e) {}
  }

  function ensureSidebar() {
    let el = document.getElementById(SIDEBAR_ID);
    if (el) {
      applySettingsToSidebar(el);
      return el;
    }

    el = document.createElement('aside');
    el.id = SIDEBAR_ID;
    el.setAttribute('aria-label', 'ChatGPT 問題清單');
    el.innerHTML = `
      <header>
        <h1>問題清單（本頁） <small id="cgpt-count" style="opacity:.7;font-weight:500"></small></h1>
        <div class="cgpt-actions">
          <button class="btn-refresh" title="重新掃描">↻</button>
          <button class="btn-export" title="匯出 Markdown">⤓</button>
          <button class="btn-toggle" title="收合/展開">—</button>
        </div>
      </header>
      <div class="cgpt-list" role="list"></div>
    `;
    document.body.appendChild(el);

    el.querySelector('.btn-toggle').addEventListener('click', () => el.classList.toggle('minimized'));
    el.querySelector('.btn-refresh').addEventListener('click', () => {
      log('Manual refresh clicked');
      rebuild(true);
    });
    el.querySelector('.btn-export').addEventListener('click', exportMarkdown);
    applySettingsToSidebar(el);
    return el;
  }

  function resetConversationView() {
    lastSignature = '';
    lastScrollOffset = null;
    activeConversationKey = getConversationKey();
    buildList([]);
  }

  function getStorageSync() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return null;
    return chrome.storage.sync;
  }

  function getStorageLocal() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    return chrome.storage.local;
  }

  function normalizeSettings(nextSettings) {
    const backgroundOpacity = Number(nextSettings.backgroundOpacity);

    return {
      sidebarMode: nextSettings.sidebarMode === 'tab' ? 'tab' : 'expanded',
      sidebarPosition: nextSettings.sidebarPosition === 'left' ? 'left' : 'right',
      appearance: ['light', 'dark', 'system'].includes(nextSettings.appearance)
        ? nextSettings.appearance
        : 'system',
      questionSort: nextSettings.questionSort === 'newest' ? 'newest' : 'oldest',
      listFontSize: ['small', 'medium', 'large'].includes(nextSettings.listFontSize)
        ? nextSettings.listFontSize
        : 'medium',
      backgroundOpacity: Number.isFinite(backgroundOpacity)
        ? Math.min(Math.max(backgroundOpacity, 30), 100)
        : 100,
    };
  }

  function applySettingsToSidebar(sidebar = document.getElementById(SIDEBAR_ID)) {
    if (!sidebar) return;

    sidebar.classList.toggle('cgpt-mode-tab', settings.sidebarMode === 'tab');
    sidebar.classList.toggle('cgpt-mode-expanded', settings.sidebarMode === 'expanded');
    sidebar.classList.toggle('cgpt-position-left', settings.sidebarPosition === 'left');
    sidebar.classList.toggle('cgpt-position-right', settings.sidebarPosition === 'right');
    sidebar.classList.toggle('cgpt-theme-light', settings.appearance === 'light');
    sidebar.classList.toggle('cgpt-theme-dark', settings.appearance === 'dark');
    sidebar.classList.toggle('cgpt-theme-system', settings.appearance === 'system');
    sidebar.classList.toggle('cgpt-font-small', settings.listFontSize === 'small');
    sidebar.classList.toggle('cgpt-font-medium', settings.listFontSize === 'medium');
    sidebar.classList.toggle('cgpt-font-large', settings.listFontSize === 'large');
    sidebar.style.setProperty('--cgpt-bg-alpha', String(settings.backgroundOpacity / 100));
  }

  function loadSettings(callback) {
    const storage = getStorageSync();
    if (!storage) {
      settings = normalizeSettings(DEFAULT_SETTINGS);
      callback();
      return;
    }

    storage.get(DEFAULT_SETTINGS, (storedSettings) => {
      settings = normalizeSettings(storedSettings || DEFAULT_SETTINGS);
      applySettingsToSidebar();
      callback();
    });
  }

  function watchSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;

      const nextSettings = { ...settings };
      Object.keys(DEFAULT_SETTINGS).forEach((key) => {
        if (changes[key]) nextSettings[key] = changes[key].newValue;
      });

      settings = normalizeSettings(nextSettings);
      applySettingsToSidebar();
    });
  }

  function getChatContainer() {
    return document.querySelector(CHAT_SELECTOR) || window;
  }

  function getConversationKey() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    if (match) return `conversation:${match[1]}`;
    return `page:${location.pathname || 'unknown'}`;
  }

  function loadConversationCache(callback) {
    const storage = getStorageLocal();
    activeConversationKey = getConversationKey();

    if (!storage) {
      conversationCache = {};
      callback();
      return;
    }

    storage.get({ [CACHE_KEY]: {} }, (result) => {
      conversationCache = cleanupConversationCache(result[CACHE_KEY] || {});
      storage.set({ [CACHE_KEY]: conversationCache }, callback);
    });
  }

  function cleanupConversationCache(cache) {
    const now = Date.now();
    const entries = Object.entries(cache)
      .filter(([, conversation]) => now - (conversation.lastSeenAt || 0) <= CACHE_MAX_AGE_MS)
      .sort(([, a], [, b]) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, MAX_CACHED_CONVERSATIONS);

    return Object.fromEntries(entries);
  }

  function persistConversationCache() {
    const storage = getStorageLocal();
    if (!storage) return;

    conversationCache = cleanupConversationCache(conversationCache);
    storage.set({ [CACHE_KEY]: conversationCache });
  }

  function getCachedItems() {
    const conversation = conversationCache[activeConversationKey];
    return conversation && Array.isArray(conversation.items) ? conversation.items : [];
  }

  function getItemCacheKey(item) {
    return item.messageId || item.id || item.label;
  }

  function normalizeCachedItem(item, now) {
    return {
      ...item,
      firstSeenAt: item.firstSeenAt || now,
      lastSeenAt: now,
    };
  }

  function insertItemsAt(result, index, items) {
    if (!items.length) return result;
    result.splice(index, 0, ...items);
    return result;
  }

  function trimCachedItems(items, direction) {
    if (items.length <= MAX_ITEMS_PER_CONVERSATION) return items;
    return direction === 'up'
      ? items.slice(0, MAX_ITEMS_PER_CONVERSATION)
      : items.slice(-MAX_ITEMS_PER_CONVERSATION);
  }

  function mergeCachedItems(liveItems, direction = 'unknown') {
    const now = Date.now();
    const existingItems = getCachedItems();
    const existingKeySet = new Set(existingItems.map(getItemCacheKey));
    const liveItemMap = new Map();

    liveItems.forEach((item) => {
      liveItemMap.set(getItemCacheKey(item), normalizeCachedItem(item, now));
    });

    if (!existingItems.length) {
      const items = trimCachedItems(liveItems.map((item) => normalizeCachedItem(item, now)), direction);
      conversationCache[activeConversationKey] = { items, lastSeenAt: now };
      persistConversationCache();
      return items;
    }

    let result = existingItems.map((item) => {
      const liveItem = liveItemMap.get(getItemCacheKey(item));
      return liveItem ? { ...item, ...liveItem, firstSeenAt: item.firstSeenAt || liveItem.firstSeenAt } : item;
    });

    let pendingNewItems = [];
    let lastKnownKey = null;
    let sawKnownItem = false;

    liveItems.forEach((item) => {
      const cacheKey = getItemCacheKey(item);
      const cachedItem = normalizeCachedItem(item, now);

      if (existingKeySet.has(cacheKey)) {
        if (pendingNewItems.length) {
          const anchorIndex = result.findIndex((candidate) => getItemCacheKey(candidate) === cacheKey);
          result = insertItemsAt(result, anchorIndex >= 0 ? anchorIndex : result.length, pendingNewItems);
          pendingNewItems = [];
        }
        sawKnownItem = true;
        lastKnownKey = cacheKey;
        return;
      }

      pendingNewItems.push(cachedItem);
    });

    if (pendingNewItems.length) {
      if (sawKnownItem && lastKnownKey) {
        const anchorIndex = result.findIndex((candidate) => getItemCacheKey(candidate) === lastKnownKey);
        result = insertItemsAt(result, anchorIndex >= 0 ? anchorIndex + 1 : result.length, pendingNewItems);
      } else if (direction === 'up') {
        result = [...pendingNewItems, ...result];
      } else {
        result = [...result, ...pendingNewItems];
      }
    }

    const items = trimCachedItems(result, direction);

    conversationCache[activeConversationKey] = {
      items,
      lastSeenAt: now,
    };
    persistConversationCache();

    return items;
  }

  function queryUserMessages() {
    const selectors = [
      '[data-message-author-role="user"]',
      '[data-testid="user-message"]',
      '.text-base[data-role="user"]',
      'div[data-testid="conversation-turn"][data-is-user="true"]'
    ];
    const nodes = new Set();
    selectors.forEach(sel => document.querySelectorAll(sel).forEach(n => nodes.add(n)));
    return Array.from(nodes).filter(n => {
      const rect = n.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function normalizeItem(node, index) {
    let container = node.closest('[data-message-author-role="user"], [data-testid="user-message"], .text-base[data-role="user"], div[data-testid="conversation-turn"][data-is-user="true"]');
    if (!container) container = node;

    if (!container.hasAttribute(ANCHOR_ATTR)) {
      container.setAttribute(ANCHOR_ATTR, `cgpt-${index + 1}`);
      container.id = container.id || `cgpt-anchor-${index + 1}`;
    }
    const raw = container.innerText || container.textContent || '';
    const oneLine = raw.replace(/\\s+/g, ' ').trim();
    const label = oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;

    const messageNode = container.matches('[data-message-id]')
      ? container
      : container.querySelector('[data-message-id]');
    const msgId = messageNode ? messageNode.getAttribute('data-message-id') || '' : '';

    return {
      id: container.id,
      label: label || `問題 #${index + 1}`,
      messageId: msgId,
      firstSeenAt: Date.now() + index,
      lastSeenAt: Date.now(),
    };
  }

  function getNodeSignature(nodes) {
    return nodes.map((node) => {
      const msgId = node.getAttribute('data-message-id') || '';
      const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return `${msgId}:${text}`;
    }).join('|');
  }

  function getNormalizedText(value) {
    return (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function getLabelSearchText(item) {
    return getNormalizedText((item.label || '').replace(/…$/, ''));
  }

  function getUserContainerForNode(node) {
    return node.closest('[data-message-author-role="user"], [data-testid="user-message"], .text-base[data-role="user"], div[data-testid="conversation-turn"][data-is-user="true"]');
  }

  function findTargetNodeForItem(item) {
    if (item.messageId) {
      const messageNode = document.querySelector(`[data-message-id="${CSS.escape(item.messageId)}"]`);
      const userContainer = messageNode ? getUserContainerForNode(messageNode) : null;
      if (userContainer) return userContainer;
    }

    const labelText = getLabelSearchText(item);
    if (!labelText) return null;

    return queryUserMessages().find((node) => {
      const text = getNormalizedText(node.innerText || node.textContent || '');
      const textPrefix = text.slice(0, 80);
      return text && (text.includes(labelText) || (textPrefix && labelText.includes(textPrefix)));
    }) || null;
  }

  function getScrollOffset() {
    const container = getChatContainer();
    return container === window ? window.scrollY : container.scrollTop;
  }

  function getScrollDirection() {
    const currentOffset = getScrollOffset();
    const direction = lastScrollOffset === null
      ? 'unknown'
      : currentOffset < lastScrollOffset
        ? 'up'
        : currentOffset > lastScrollOffset
          ? 'down'
          : 'stable';
    lastScrollOffset = currentOffset;
    return direction;
  }

  function getSearchDirectionForItem(item) {
    const cachedItems = getCachedItems();
    const targetIndex = cachedItems.findIndex((candidate) => getItemCacheKey(candidate) === getItemCacheKey(item));
    if (targetIndex < 0) return 'down';

    const liveKeys = queryUserMessages()
      .map((node, index) => getItemCacheKey(normalizeItem(node, index)))
      .filter(Boolean);
    const liveIndexes = liveKeys
      .map((key) => cachedItems.findIndex((candidate) => getItemCacheKey(candidate) === key))
      .filter((index) => index >= 0);

    if (!liveIndexes.length) return 'down';

    const firstVisibleIndex = Math.min(...liveIndexes);
    const lastVisibleIndex = Math.max(...liveIndexes);
    if (targetIndex < firstVisibleIndex) return 'up';
    if (targetIndex > lastVisibleIndex) return 'down';
    return 'down';
  }

  function buildList(items) {
    const sidebar = ensureSidebar();
    const list = sidebar.querySelector('.cgpt-list');
    const countEl = sidebar.querySelector('#cgpt-count');
    const sortedItems = settings.questionSort === 'newest' ? [...items].reverse() : items;

    list.innerHTML = '';

    countEl.textContent = sortedItems.length ? `(${sortedItems.length})` : '(0)';
    if (!sortedItems.length) {
      list.innerHTML = '<div class="cgpt-empty">尚未偵測到你的問題（使用者訊息）。</div>';
      return;
    }

    sortedItems.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.className = 'cgpt-item';
      btn.setAttribute('role', 'listitem');
      btn.textContent = `${i + 1}. ${item.label}`;
      btn.addEventListener('click', () => {
        // 最小可用：直接使用 DOM id 重新查詢當前節點
        const candidateNode = document.getElementById(item.id);
        const nodeNow = candidateNode && (!item.messageId || candidateNode.getAttribute('data-message-id') === item.messageId)
          ? candidateNode
          : null;
        if (nodeNow) {
          nodeNow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          nodeNow.classList.add('cgpt-highlight');
          setTimeout(() => nodeNow.classList.remove('cgpt-highlight'), 1500);
        } else {
          // 後備：用 messageId 自動搜尋（若存在）
          autoScrollToItem(item, getSearchDirectionForItem(item));
        }
      });
      list.appendChild(btn);
    });
  }

  function exportMarkdown() {
    const items = getCachedItems();
    const lines = items.map((it, i) => `${i + 1}. ${it.label}`);
    const md = `# ChatGPT 問題清單\\n\\n${lines.join('\\n')}`;
    navigator.clipboard.writeText(md).then(
      () => alert('已複製 Markdown 到剪貼簿！'),
      () => prompt('複製以下內容：', md)
    );
  }

  function rebuild(force=false) {
    const currentConversationKey = getConversationKey();
    if (activeConversationKey && currentConversationKey !== activeConversationKey) {
      resetConversationView();
      loadConversationCache(() => rebuild(true));
      return;
    }

    const nodes = queryUserMessages();
    const signature = getNodeSignature(nodes);
    if (!force && signature === lastSignature) {
      return; // 無變化時不重建
    }
    lastSignature = signature;
    const scrollDirection = getScrollDirection();
    const liveItems = nodes.map(normalizeItem);
    const items = mergeCachedItems(liveItems, scrollDirection);
    log('Rebuild list. DOM count =', nodes.length, 'Cached count =', items.length, 'Direction =', scrollDirection);
    buildList(items);
  }

  function observeMutations() {
    const root = document.body;
    const mo = new MutationObserver((mutations) => {
      const changed = mutations.some(m => m.addedNodes && m.addedNodes.length);
      if (changed) {
        if (observeMutations._raf) cancelAnimationFrame(observeMutations._raf);
        observeMutations._raf = requestAnimationFrame(() => rebuild());
      }
    });
    mo.observe(root, { childList: true, subtree: true });
  }

  function watchUrlChanges() {
    let last = location.href;
    if (urlWatchTimer) clearInterval(urlWatchTimer);
    urlWatchTimer = setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        log('URL changed -> Reboot');
        boot(true);
      }
    }, 800);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => rebuild(), 1500);
  }

  function getOppositeDirection(direction) {
    return direction === 'up' ? 'down' : 'up';
  }

  function highlightNode(node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('cgpt-highlight');
    setTimeout(() => node.classList.remove('cgpt-highlight'), 1500);
  }

  function autoScrollToItem(item, searchDirection = 'down') {
    const container = document.querySelector(CHAT_SELECTOR) || window;
    const isWindow = (container === window);
    const directions = [searchDirection, getOppositeDirection(searchDirection)];

    let found = false;
    let directionIndex = 0;
    let directionStartedAt = Date.now();
    let timer = null;
    const root = isWindow ? document.body : container;

    const finishIfFound = () => {
      const n = findTargetNodeForItem(item);
      if (n) {
        found = true;
        highlightNode(n);
        observer.disconnect();
        if (timer) clearInterval(timer);
      }
      return found;
    };

    const observer = new MutationObserver(finishIfFound);
    observer.observe(root, { childList: true, subtree: true });

    if (finishIfFound()) return;

    timer = setInterval(() => {
      if (found) return;
      if (finishIfFound()) return;

      const elapsed = Date.now() - directionStartedAt;
      if (elapsed > 6000) {
        if (directionIndex < directions.length - 1) {
          directionIndex += 1;
          directionStartedAt = Date.now();
        } else {
          observer.disconnect();
          clearInterval(timer);
          alert('找不到目標訊息（請試著手動捲一下或按 ↻ 重新掃描）');
          return;
        }
      }

      const step = directions[directionIndex] === 'up' ? -400 : 400;
      if (isWindow) window.scrollBy({ top: step, behavior: 'auto' });
      else container.scrollBy({ top: step, behavior: 'auto' });
    }, 200);
  }

  // Auto scroll search by data-message-id
  function autoScrollToMessageId(targetId, searchDirection = 'down') {
    autoScrollToItem({ messageId: targetId, label: '' }, searchDirection);
  }

  function boot(fromUrlChange=false) {
    ensureSidebar();
    if (fromUrlChange) resetConversationView();
    loadSettings(() => {
      loadConversationCache(() => rebuild(true));
    });
    if (!fromUrlChange) {
      watchSettings();
      observeMutations();
      watchUrlChanges();
      startPolling();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(false));
  } else {
    boot(false);
  }
})();
