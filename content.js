(function () {
  const SIDEBAR_ID = 'cgpt-toc';
  const ANCHOR_ATTR = 'data-cgpt-anchor';
  const CHAT_SELECTOR = '.flex.h-full.flex-col.overflow-y-auto';

  let lastCount = -1;
  let pollTimer = null;
  let urlWatchTimer = null;
  let allItems = [];

  const viewState = {
    query: '',
    pinnedOnly: false,
    includeHidden: false,
    pinnedIds: new Set()
  };

  function log(...args) {
    try { console.debug('[ChatGPT-TOC]', ...args); } catch (e) {}
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
      <div class="cgpt-filter-row">
        <input class="cgpt-filter-input" type="text" placeholder="搜尋問題內容..." aria-label="Filter questions" />
        <label class="cgpt-toggle-pill">
          <input class="cgpt-toggle-pinned" type="checkbox" />
          <span>僅釘選</span>
        </label>
        <label class="cgpt-toggle-pill">
          <input class="cgpt-toggle-hidden" type="checkbox" />
          <span>含隱藏</span>
        </label>
      </div>
      <div class="cgpt-list" role="list"></div>
    `;
    document.body.appendChild(el);

    el.querySelector('.btn-toggle').addEventListener('click', () => el.classList.toggle('minimized'));
    el.querySelector('.btn-refresh').addEventListener('click', () => {
      log('Manual refresh clicked');
      rebuild(true);
    });
    el.querySelector('.btn-export').addEventListener('click', exportMarkdown);

    const debouncedFilter = debounce((evt) => {
      viewState.query = evt.target.value || '';
      buildList(allItems);
    }, 150);

    el.querySelector('.cgpt-filter-input').addEventListener('input', debouncedFilter);
    el.querySelector('.cgpt-toggle-pinned').addEventListener('change', (evt) => {
      viewState.pinnedOnly = !!evt.target.checked;
      buildList(allItems);
    });
    el.querySelector('.cgpt-toggle-hidden').addEventListener('change', (evt) => {
      viewState.includeHidden = !!evt.target.checked;
      buildList(allItems);
    });

    return el;
  }

  function debounce(fn, wait = 120) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function getChatContainer() {
    return document.querySelector(CHAT_SELECTOR) || window;
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
    return Array.from(nodes);
  }

  function isNodeHidden(node) {
    if (!node) return true;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(node);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
    const rect = node.getBoundingClientRect();
    return rect.width === 0 || rect.height === 0;
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

    const msgId = container.getAttribute('data-message-id') || '';

    const searchText = oneLine.toLowerCase();

    return {
      id: container.id,
      raw,
      searchText,
      label: label || `問題 #${index + 1}`,
      messageId: msgId,
      hidden: isNodeHidden(container)
    };
  }

  function computeFilteredItems(items) {
    const query = (viewState.query || '').trim().toLowerCase();
    return items.filter((item) => {
      if (!viewState.includeHidden && item.hidden) return false;
      if (viewState.pinnedOnly && !viewState.pinnedIds.has(item.id)) return false;
      if (query && !item.searchText.includes(query)) return false;
      return true;
    });
  }

  function renderList(items, filteredItems) {
    const sidebar = ensureSidebar();
    const list = sidebar.querySelector('.cgpt-list');
    const countEl = sidebar.querySelector('#cgpt-count');

    list.innerHTML = '';

    countEl.textContent = filteredItems.length ? `(${filteredItems.length})` : '(0)';
    if (!items.length) {
      list.innerHTML = '<div class="cgpt-empty">no questions found</div>';
      return;
    }

    if (!filteredItems.length) {
      list.innerHTML = '<div class="cgpt-empty">no results for current filter</div>';
      return;
    }

    filteredItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'cgpt-item-row';

      const btn = document.createElement('button');
      btn.className = 'cgpt-item';
      btn.setAttribute('role', 'listitem');
      btn.type = 'button';
      btn.textContent = `${i + 1}. ${item.label}`;
      btn.addEventListener('click', () => {
        // 最小可用：直接使用 DOM id 重新查詢當前節點
        const nodeNow = document.getElementById(item.id);
        if (nodeNow) {
          nodeNow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          nodeNow.classList.add('cgpt-highlight');
          setTimeout(() => nodeNow.classList.remove('cgpt-highlight'), 1500);
        } else {
          // 後備：用 messageId 自動搜尋（若存在）
          if (item.messageId) {
            autoScrollToMessageId(item.messageId);
          } else {
            alert('找不到對應元素，請按 ↻ 重新掃描。');
          }
        }
      });

      const pinBtn = document.createElement('button');
      const pinned = viewState.pinnedIds.has(item.id);
      pinBtn.className = `cgpt-pin ${pinned ? 'is-pinned' : ''}`;
      pinBtn.type = 'button';
      pinBtn.title = pinned ? '取消釘選' : '釘選';
      pinBtn.textContent = pinned ? '★' : '☆';
      pinBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        if (viewState.pinnedIds.has(item.id)) viewState.pinnedIds.delete(item.id);
        else viewState.pinnedIds.add(item.id);
        buildList(allItems);
      });

      row.appendChild(btn);
      row.appendChild(pinBtn);
      list.appendChild(row);
    });
  }

  function buildList(items) {
    const filteredItems = computeFilteredItems(items);
    renderList(items, filteredItems);
  }

  function exportMarkdown() {
    const nodes = queryUserMessages();
    const items = nodes.map(normalizeItem);
    const lines = items.map((it, i) => `${i + 1}. ${it.label}`);
    const md = `# ChatGPT 問題清單\\n\\n${lines.join('\\n')}`;
    navigator.clipboard.writeText(md).then(
      () => alert('已複製 Markdown 到剪貼簿！'),
      () => prompt('複製以下內容：', md)
    );
  }

  function rebuild(force=false) {
    const nodes = queryUserMessages();
    if (!force && nodes.length === lastCount) {
      return; // 無變化時不重建
    }
    lastCount = nodes.length;
    const items = nodes.map(normalizeItem);
    allItems = items;
    log('Rebuild list. Count =', nodes.length);
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

  // Auto scroll search by data-message-id
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

  function boot(fromUrlChange=false) {
    ensureSidebar();
    rebuild(true);
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
