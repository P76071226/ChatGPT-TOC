(function () {
  const SIDEBAR_ID = 'cgpt-toc';
  const ANCHOR_ATTR = 'data-cgpt-anchor';
  const CHAT_SELECTOR = '.flex.h-full.flex-col.overflow-y-auto';
  const STORAGE_KEY = 'tocMeta';

  let lastCount = -1;
  let pollTimer = null;
  let urlWatchTimer = null;
  let cachedConversationKey = '';
  let cachedMeta = {};

  function log(...args) {
    try { console.debug('[ChatGPT-TOC]', ...args); } catch (e) {}
  }

  function getConversationKey() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    if (match && match[1]) return match[1];
    return location.pathname || 'default';
  }

  function getItemMetaKey(item) {
    return item.messageId || item.anchorId;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
  }

  async function loadConversationMeta(force = false) {
    const conversationKey = getConversationKey();
    if (!force && conversationKey === cachedConversationKey && cachedMeta) {
      return cachedMeta;
    }

    const data = await storageGet(STORAGE_KEY);
    const tocMeta = data[STORAGE_KEY] || {};
    cachedConversationKey = conversationKey;
    cachedMeta = tocMeta[conversationKey] || {};
    return cachedMeta;
  }

  async function updateItemMeta(item, partialMeta) {
    const conversationKey = getConversationKey();
    const metaKey = getItemMetaKey(item);
    if (!metaKey) return;

    const data = await storageGet(STORAGE_KEY);
    const tocMeta = data[STORAGE_KEY] || {};
    const convMeta = tocMeta[conversationKey] || {};
    const prev = convMeta[metaKey] || {};

    convMeta[metaKey] = {
      pinned: Boolean(prev.pinned),
      customLabel: typeof prev.customLabel === 'string' ? prev.customLabel : '',
      hidden: Boolean(prev.hidden),
      ...partialMeta
    };

    tocMeta[conversationKey] = convMeta;
    await storageSet({ [STORAGE_KEY]: tocMeta });

    cachedConversationKey = conversationKey;
    cachedMeta = convMeta;
  }

  function ensureSidebar() {
    let el = document.getElementById(SIDEBAR_ID);
    if (el) return el;

    el = document.createElement('aside');
    el.id = SIDEBAR_ID;
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
    return el;
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

  function normalizeItem(node, index, meta = {}) {
    let container = node.closest('[data-message-author-role="user"], [data-testid="user-message"], .text-base[data-role="user"], div[data-testid="conversation-turn"][data-is-user="true"]');
    if (!container) container = node;

    const fallbackAnchor = `cgpt-anchor-${index + 1}`;
    if (!container.hasAttribute(ANCHOR_ATTR)) {
      container.setAttribute(ANCHOR_ATTR, fallbackAnchor);
    }
    container.id = container.id || container.getAttribute(ANCHOR_ATTR) || fallbackAnchor;

    const raw = container.innerText || container.textContent || '';
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    const label = oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;

    const msgId = container.getAttribute('data-message-id') || '';
    const anchorId = container.getAttribute(ANCHOR_ATTR) || fallbackAnchor;
    const metaKey = msgId || anchorId;
    const itemMeta = meta[metaKey] || {};
    const customLabel = typeof itemMeta.customLabel === 'string' ? itemMeta.customLabel.trim() : '';

    return {
      id: container.id,
      label: label || `問題 #${index + 1}`,
      messageId: msgId,
      anchorId,
      index,
      pinned: Boolean(itemMeta.pinned),
      hidden: Boolean(itemMeta.hidden),
      customLabel,
      displayLabel: customLabel || (label || `問題 #${index + 1}`)
    };
  }

  function buildList(items) {
    const sidebar = ensureSidebar();
    const list = sidebar.querySelector('.cgpt-list');
    const countEl = sidebar.querySelector('#cgpt-count');

    list.innerHTML = '';

    const visibleCount = items.filter((item) => !item.hidden).length;
    countEl.textContent = items.length ? `(${visibleCount}/${items.length})` : '(0)';
    if (!items.length) {
      list.innerHTML = '<div class="cgpt-empty">尚未偵測到你的問題（使用者訊息）。</div>';
      return;
    }

    const ordered = [...items].sort((a, b) => {
      if (a.pinned === b.pinned) return a.index - b.index;
      return a.pinned ? -1 : 1;
    });

    ordered.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cgpt-item-row';
      row.setAttribute('role', 'listitem');
      if (item.pinned) row.classList.add('is-pinned');
      if (item.hidden) row.classList.add('is-hidden');

      const btn = document.createElement('button');
      btn.className = 'cgpt-item';
      btn.textContent = `${i + 1}. ${item.displayLabel}`;
      btn.title = item.displayLabel;
      btn.disabled = item.hidden;
      btn.addEventListener('click', () => {
        const nodeNow = document.getElementById(item.id);
        if (nodeNow) {
          nodeNow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          nodeNow.classList.add('cgpt-highlight');
          setTimeout(() => nodeNow.classList.remove('cgpt-highlight'), 1500);
        } else if (item.messageId) {
          autoScrollToMessageId(item.messageId);
        } else {
          alert('找不到對應元素，請按 ↻ 重新掃描。');
        }
      });

      const controls = document.createElement('div');
      controls.className = 'cgpt-item-controls';

      const pinBtn = document.createElement('button');
      pinBtn.className = `cgpt-control-btn ${item.pinned ? 'is-active' : ''}`;
      pinBtn.textContent = item.pinned ? '📌' : '📍';
      pinBtn.title = item.pinned ? '取消置頂' : '置頂';
      pinBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await updateItemMeta(item, { pinned: !item.pinned });
        await rebuild(true);
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'cgpt-control-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = '重新命名';
      renameBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const nextLabel = prompt('輸入自訂標題（留空可清除）：', item.customLabel || item.label);
        if (nextLabel === null) return;
        await updateItemMeta(item, { customLabel: nextLabel.trim() });
        await rebuild(true);
      });

      const hideBtn = document.createElement('button');
      hideBtn.className = `cgpt-control-btn ${item.hidden ? 'is-active' : ''}`;
      hideBtn.textContent = item.hidden ? '👁️' : '🙈';
      hideBtn.title = item.hidden ? '取消隱藏' : '隱藏';
      hideBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await updateItemMeta(item, { hidden: !item.hidden });
        await rebuild(true);
      });

      controls.append(pinBtn, renameBtn, hideBtn);
      row.append(btn, controls);
      list.appendChild(row);
    });
  }

  async function exportMarkdown() {
    const meta = await loadConversationMeta();
    const nodes = queryUserMessages();
    const items = nodes.map((node, index) => normalizeItem(node, index, meta));
    const lines = items
      .filter((it) => !it.hidden)
      .map((it, i) => `${i + 1}. ${it.customLabel || it.label}`);
    const md = `# ChatGPT 問題清單\n\n${lines.join('\n')}`;
    navigator.clipboard.writeText(md).then(
      () => alert('已複製 Markdown 到剪貼簿！'),
      () => prompt('複製以下內容：', md)
    );
  }

  async function rebuild(force=false) {
    const nodes = queryUserMessages();
    if (!force && nodes.length === lastCount) {
      return;
    }
    lastCount = nodes.length;
    const meta = await loadConversationMeta();
    const items = nodes.map((node, index) => normalizeItem(node, index, meta));
    log('Rebuild list. Count =', nodes.length);
    buildList(items);
  }

  function observeMutations() {
    const root = document.body;
    const mo = new MutationObserver((mutations) => {
      const changed = mutations.some(m => m.addedNodes && m.addedNodes.length);
      if (changed) {
        if (observeMutations._raf) cancelAnimationFrame(observeMutations._raf);
        observeMutations._raf = requestAnimationFrame(() => rebuild().catch((err) => log('rebuild error', err)));
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
    pollTimer = setInterval(() => rebuild().catch((err) => log('poll rebuild error', err)), 1500);
  }

  function autoScrollToMessageId(targetId) {
    const container = document.querySelector(CHAT_SELECTOR) || window;
    const isWindow = (container === window);
    const getEl = () => document.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`);

    let found = false;
    const root = isWindow ? document.body : container;
    const observer = new MutationObserver(() => {
      const n = getEl();
      if (n) {
        found = true;
        n.scrollIntoView({ behavior: 'smooth', block: 'center' });
        n.classList.add('cgpt-highlight');
        setTimeout(() => n.classList.remove('cgpt-highlight'), 1500);
        observer.disconnect();
        clearInterval(timer);
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    const timer = setInterval(() => {
      if (found) return;
      const step = 400;
      if (isWindow) window.scrollBy({ top: step, behavior: 'auto' });
      else container.scrollBy({ top: step, behavior: 'auto' });
    }, 200);

    setTimeout(() => {
      if (!found) {
        observer.disconnect();
        clearInterval(timer);
        alert('找不到目標訊息（請試著手動捲一下或按 ↻ 重新掃描）');
      }
    }, 6000);
  }

  async function boot(fromUrlChange=false) {
    await loadConversationMeta(true);
    ensureSidebar();
    await rebuild(true);
    if (!fromUrlChange) {
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
