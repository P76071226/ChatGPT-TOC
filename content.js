(function () {
  const SIDEBAR_ID = 'cgpt-toc';
  const ANCHOR_ATTR = 'data-cgpt-anchor';
  const CHAT_SELECTOR = '.flex.h-full.flex-col.overflow-y-auto';

  let lastCount = -1;
  let pollTimer = null;
  let urlWatchTimer = null;

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

    const msgId = container.getAttribute('data-message-id') || '';

    return { id: container.id, label: label || `問題 #${index + 1}`, messageId: msgId };
  }

  function buildList(items) {
    const sidebar = ensureSidebar();
    const list = sidebar.querySelector('.cgpt-list');
    const countEl = sidebar.querySelector('#cgpt-count');

    list.innerHTML = '';

    countEl.textContent = items.length ? `(${items.length})` : '(0)';
    if (!items.length) {
      list.innerHTML = '<div class="cgpt-empty">尚未偵測到你的問題（使用者訊息）。</div>';
      return;
    }

    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.className = 'cgpt-item';
      btn.setAttribute('role', 'listitem');
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
      list.appendChild(btn);
    });
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