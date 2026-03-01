(function () {
  const SIDEBAR_ID = 'cgpt-toc';
  const ANCHOR_ATTR = 'data-cgpt-anchor';
  const CHAT_SELECTOR = '.flex.h-full.flex-col.overflow-y-auto';
  const CHUNK_SIZE = 10;
  const COLLAPSE_STORAGE_KEY = 'cgptTocCollapseState';
  const STOP_WORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how', 'i', 'if', 'in', 'into',
    'is', 'it', 'me', 'my', 'of', 'on', 'or', 'please', 'show', 'that', 'the', 'this', 'to', 'what', 'when',
    'where', 'which', 'who', 'why', 'with', 'you', 'your', '的', '了', '和', '是', '我', '請', '幫', '一下', '如何', '嗎'
  ]);

  let lastCount = -1;
  let pollTimer = null;
  let urlWatchTimer = null;
  let collapseState = {};
  let lastRendered = { items: [], sections: [] };

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

  function getConversationKey() {
    const matched = location.pathname.match(/\/c\/([^/]+)/);
    return matched ? `conversation:${matched[1]}` : `page:${location.pathname}`;
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get([key], (result) => resolve(result || {}));
    });
  }

  function storageSet(payload) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set(payload, () => resolve());
    });
  }

  async function loadCollapseState() {
    const allState = (await storageGet(COLLAPSE_STORAGE_KEY))[COLLAPSE_STORAGE_KEY] || {};
    collapseState = allState[getConversationKey()] || {};
  }

  async function saveCollapseState() {
    const allState = (await storageGet(COLLAPSE_STORAGE_KEY))[COLLAPSE_STORAGE_KEY] || {};
    allState[getConversationKey()] = collapseState;
    await storageSet({ [COLLAPSE_STORAGE_KEY]: allState });
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
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    const label = oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;

    const msgId = container.getAttribute('data-message-id') || '';

    return { id: container.id, label: label || `問題 #${index + 1}`, messageId: msgId };
  }

  function tokenize(text) {
    return new Set(
      (text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((token) => token && token.length > 1 && !STOP_WORDS.has(token))
    );
  }

  function jaccardSimilarity(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let intersection = 0;
    setA.forEach((value) => {
      if (setB.has(value)) intersection += 1;
    });
    const union = setA.size + setB.size - intersection;
    return union ? intersection / union : 0;
  }

  function buildChunkSections(items) {
    const sections = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const block = items.slice(i, i + CHUNK_SIZE);
      const start = i + 1;
      const end = i + block.length;
      sections.push({
        id: `range-${start}-${end}`,
        title: `Q${start}–Q${end}`,
        items: block,
        rangeStart: start,
        rangeEnd: end,
        type: 'range'
      });
    }
    return sections;
  }

  function buildKeywordSections(items) {
    const clusters = [];

    items.forEach((item, index) => {
      const tokens = tokenize(item.label);
      let bestCluster = null;
      let bestScore = 0;
      clusters.forEach((cluster) => {
        const score = jaccardSimilarity(tokens, cluster.tokens);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      });

      if (bestCluster && bestScore >= 0.25) {
        bestCluster.entries.push({ item, index });
        tokens.forEach((token) => bestCluster.tokens.add(token));
      } else {
        clusters.push({ entries: [{ item, index }], tokens });
      }
    });

    if (!clusters.length) return [];

    const singletonRatio = clusters.filter((cluster) => cluster.entries.length === 1).length / clusters.length;
    if (clusters.length === items.length || singletonRatio > 0.7) return [];

    return clusters
      .map((cluster, clusterIndex) => {
        const sorted = [...cluster.entries].sort((a, b) => a.index - b.index);
        const rangeStart = sorted[0].index + 1;
        const rangeEnd = sorted[sorted.length - 1].index + 1;
        const keywords = [...cluster.tokens]
          .sort((a, b) => b.length - a.length)
          .slice(0, 2)
          .join(' / ');
        const topicLabel = keywords ? `主題：${keywords}` : `主題 ${clusterIndex + 1}`;

        return {
          id: `topic-${clusterIndex + 1}-${rangeStart}-${rangeEnd}`,
          title: `${topicLabel} (Q${rangeStart}–Q${rangeEnd})`,
          items: sorted.map((entry) => entry.item),
          rangeStart,
          rangeEnd,
          type: 'topic'
        };
      })
      .sort((a, b) => a.rangeStart - b.rangeStart);
  }

  function groupItems(items) {
    const keywordSections = buildKeywordSections(items);
    if (keywordSections.length >= 2) return keywordSections;
    return buildChunkSections(items);
  }

  async function onToggleSection(sectionId, isCollapsed) {
    collapseState[sectionId] = isCollapsed;
    await saveCollapseState();
  }

  function scrollToItem(item) {
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
  }

  function buildList(items) {
    const sidebar = ensureSidebar();
    const list = sidebar.querySelector('.cgpt-list');
    const countEl = sidebar.querySelector('#cgpt-count');
    const sections = groupItems(items);
    const indexById = new Map(items.map((it, idx) => [it.id, idx]));

    lastRendered = { items, sections };

    list.innerHTML = '';

    countEl.textContent = items.length ? `(${items.length})` : '(0)';
    if (!items.length) {
      list.innerHTML = '<div class="cgpt-empty">尚未偵測到你的問題（使用者訊息）。</div>';
      return;
    }

    sections.forEach((section) => {
      const sectionEl = document.createElement('section');
      const isCollapsed = Boolean(collapseState[section.id]);
      sectionEl.className = `cgpt-section ${isCollapsed ? 'collapsed' : ''}`;

      const headerBtn = document.createElement('button');
      headerBtn.className = 'cgpt-section-header';
      headerBtn.type = 'button';
      headerBtn.textContent = section.title;
      headerBtn.setAttribute('aria-expanded', String(!isCollapsed));
      headerBtn.addEventListener('click', async () => {
        const collapsed = sectionEl.classList.toggle('collapsed');
        headerBtn.setAttribute('aria-expanded', String(!collapsed));
        await onToggleSection(section.id, collapsed);
      });

      const body = document.createElement('div');
      body.className = 'cgpt-section-items';

      section.items.forEach((item) => {
        const btn = document.createElement('button');
        const idx = (indexById.get(item.id) ?? 0) + 1;
        btn.className = 'cgpt-item';
        btn.setAttribute('role', 'listitem');
        btn.textContent = `${idx}. ${item.label}`;
        btn.addEventListener('click', () => scrollToItem(item));
        body.appendChild(btn);
      });

      sectionEl.appendChild(headerBtn);
      sectionEl.appendChild(body);
      list.appendChild(sectionEl);
    });
  }

  function exportMarkdown() {
    const { items, sections } = lastRendered;
    const modeInput = prompt('匯出格式：輸入 1=平面清單，2=分組清單', '2');
    const grouped = modeInput !== '1';

    const md = grouped
      ? `# ChatGPT 問題清單\n\n${sections.map((section) => {
          const rows = section.items.map((it) => `${(items.findIndex((item) => item.id === it.id) || 0) + 1}. ${it.label}`);
          return `## ${section.title}\n${rows.join('\n')}`;
        }).join('\n\n')}`
      : `# ChatGPT 問題清單\n\n${items.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`;

    navigator.clipboard.writeText(md).then(
      () => alert('已複製 Markdown 到剪貼簿！'),
      () => prompt('複製以下內容：', md)
    );
  }

  function rebuild(force = false) {
    const nodes = queryUserMessages();
    if (!force && nodes.length === lastCount) {
      return;
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

  async function boot(fromUrlChange = false) {
    ensureSidebar();
    await loadCollapseState();
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
