// AI Catalog - content.js  v1.4-debug
// Injected into claude.ai to record user questions

(function () {
  'use strict';

  // ─── Debug DOM log (readable from page context via Playwright) ────────────────
  function dbg(msg) {
    let el = document.getElementById('aic-dbg-log');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aic-dbg-log';
      el.style.display = 'none';
      document.documentElement.appendChild(el);
    }
    const entry = document.createElement('span');
    entry.textContent = `${Date.now()}|${msg}`;
    el.appendChild(entry);
  }

  // ─── Constants ───────────────────────────────────────────────────────────────

  const STORAGE_KEY = 'aicatalog_data';
  const PANEL_ID = 'aic-panel-host';
  const TOGGLE_BTN_ID = 'aic-toggle-btn';
  const DEBOUNCE_MS = 300;
  const HIGHLIGHT_CLASS = 'aic-highlight';
  const MAX_TITLE_LEN = 60;

  // Verified against live claude.ai DOM (2026-02):
  //   [data-testid="user-message"] → 5 matches ✓
  //   Everything else             → 0 matches ✗
  const USER_MESSAGE_SELECTORS = [
    '[data-testid="user-message"]',   // current claude.ai (confirmed)
    '[data-is-human-turn="true"]',    // possible future attribute
    '[class*="HumanTurn"]',           // possible future class
  ];

  // ─── State ───────────────────────────────────────────────────────────────────

  let currentChatId = null;
  let panelOpen = false;
  let shadowRoot = null;
  let observer = null;
  let debounceTimer = null;
  // Monotonically-increasing counter; incremented on every chat switch so that
  // async callbacks from a previous chat can detect staleness and bail.
  let chatVersion = 0;

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function extractChatId() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]{36})/i);
    return match ? match[1] : null;
  }

  function findUserMessageNodes() {
    for (const sel of USER_MESSAGE_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  function getScrollContainer() {
    return (
      document.querySelector('main [class*="overflow"]') ||
      document.querySelector('[class*="overflow-y-auto"]') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.documentElement
    );
  }

  // ─── Extension context guard ─────────────────────────────────────────────────
  //
  // When the extension is reloaded from chrome://extensions while a page is
  // already open, any subsequent chrome.* API call throws
  //   "Extension context invalidated."
  // We guard every chrome API call with this helper so the page never sees
  // uncaught errors.

  function isContextAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ─── Storage ─────────────────────────────────────────────────────────────────

  async function loadData() {
    if (!isContextAlive()) return {};
    try {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (res) => {
          if (chrome.runtime.lastError) { resolve({}); return; }
          resolve(res[STORAGE_KEY] || {});
        });
      });
    } catch { return {}; }
  }

  async function saveData(data) {
    if (!isContextAlive()) return;
    try {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: data }, () => {
          if (chrome.runtime.lastError) { resolve(); return; }
          resolve();
        });
      });
    } catch { /* context gone, silently ignore */ }
  }

  async function getCurrentChatData() {
    // Snapshot currentChatId SYNCHRONOUSLY before the async loadData().
    // Without this, if the user switches chat while loadData is in-flight,
    // the return statement below would read data[newChatId] instead —
    // causing the panel to show wrong-chat data or questions to appear
    // "appended" from the previous chat.
    const chatId = currentChatId;
    if (!chatId) return null;
    const data = await loadData();
    return data[chatId] || null;
  }

  async function getQuestionById(questionId) {
    const chatData = await getCurrentChatData();
    if (!chatData) return null;
    return chatData.questions.find((q) => q.id === questionId) || null;
  }

  // ─── DOM Chat Marking ─────────────────────────────────────────────────────────
  //
  // Each captured node gets TWO dataset attributes:
  //   data-aic-id   = question ID  (used for scroll-to)
  //   data-aic-chat = chat UUID    (used to skip stale old-chat nodes)
  //
  // When navigating away from a chat we stamp ALL currently-visible user nodes
  // with data-aic-chat = old chatId.  That way, if React hasn't unmounted them
  // yet by the time our new observer fires, captureUntaggedNodes will skip them.

  function stampNodesWithChatId(chatId) {
    if (!chatId) return;
    findUserMessageNodes().forEach((node) => {
      if (!node.dataset.aicChat) node.dataset.aicChat = chatId;
    });
  }

  // ─── Question Capture ────────────────────────────────────────────────────────

  // Scan all user-message nodes; tag untagged ones synchronously, then save
  // all new questions in a SINGLE storage write to avoid the race condition
  // where concurrent saveQuestion() calls each read the same empty snapshot
  // and the last write wins (causing all but one question to be lost).
  async function captureUntaggedNodes(chatId) {
    if (!chatId) return;
    if (chatId !== currentChatId) {
      dbg(` captureUntaggedNodes BLOCKED stale chatId=${chatId?.slice(0,8)} currentChatId=${currentChatId?.slice(0,8)}`);
      return;
    }
    if (!isContextAlive()) return;

    const allNodes = findUserMessageNodes();
    dbg(` captureUntaggedNodes chatId=${chatId?.slice(0,8)} url=${location.pathname.slice(-8)} nodes=${allNodes.length}`);

    // ── Synchronous pass: tag DOM nodes immediately ────────────────────────
    // Tagging is synchronous so a second concurrent call sees already-tagged
    // nodes and skips them — the DOM attribute acts as a write mutex.
    const newQuestions = [];
    allNodes.forEach((node) => {
      if (node.dataset.aicChat && node.dataset.aicChat !== chatId) return;
      if (node.dataset.aicId) return; // already captured

      const text = (node.innerText || node.textContent || '').trim();
      if (!text || text.length < 2) return;

      const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      node.dataset.aicId = questionId;
      node.dataset.aicChat = chatId;
      newQuestions.push({ id: questionId, text, timestamp: Date.now() });
      dbg(` captureQuestion OK chatId=${chatId?.slice(0,8)} text="${text.slice(0,30)}"`);
    });

    if (newQuestions.length === 0) return;

    // ── Single async write: load → merge all → save ────────────────────────
    if (chatId !== currentChatId) return; // re-check after sync work
    const data = await loadData();
    if (chatId !== currentChatId) return; // re-check after await

    if (!data[chatId]) {
      data[chatId] = {
        title: newQuestions[0].text.slice(0, MAX_TITLE_LEN),
        createdAt: newQuestions[0].timestamp,
        updatedAt: newQuestions[0].timestamp,
        questions: [],
      };
    }
    newQuestions.forEach((q) => {
      const norm = q.text.trim();
      const exists = data[chatId].questions.some(
        (existing) => existing.id === q.id || existing.text.trim() === norm
      );
      if (!exists) {
        data[chatId].questions.push(q);
        data[chatId].updatedAt = q.timestamp;
      }
    });

    // Re-sort all stored questions to match current DOM order.
    // This corrects any out-of-order entries left by previous bugs.
    const domTexts = allNodes.map((n) => (n.innerText || n.textContent || '').trim());
    data[chatId].questions.sort((a, b) => {
      const ai = domTexts.indexOf(a.text.trim());
      const bi = domTexts.indexOf(b.text.trim());
      // Questions not found in DOM (unlikely) go to end
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });

    await saveData(data);
    updatePanel();
  }

  // Restore data-aic-id tags from storage onto DOM nodes (for scroll-to after reload)
  async function tagExistingNodes(chatId) {
    if (!chatId) return;
    const data = await loadData();
    const chatData = data[chatId];
    if (!chatData) {
      dbg(` tagExistingNodes chatId=${chatId?.slice(0,8)} no stored data`);
      return;
    }

    const nodes = findUserMessageNodes();
    dbg(` tagExistingNodes chatId=${chatId?.slice(0,8)} stored=${chatData.questions.length} domNodes=${nodes.length}`);
    // Match stored questions to DOM nodes by TEXT content, not by index.
    // Index matching breaks when stored data is out of order (e.g. from the
    // old race-condition bug) and maps the wrong question to the wrong node.
    chatData.questions.forEach((q) => {
      const norm = q.text.trim();
      const node = nodes.find(
        (n) => !n.dataset.aicId && (n.innerText || n.textContent || '').trim() === norm
      );
      if (node) {
        dbg(` tagExistingNodes matched "${q.text.slice(0,20)}" → chatId=${chatId?.slice(0,8)}`);
        node.dataset.aicId = q.id;
        node.dataset.aicChat = chatId;
      }
    });
  }

  // ─── MutationObserver ────────────────────────────────────────────────────────

  function stopObserver() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function getObserverContainer() {
    // Always observe document.body instead of a specific scroll container.
    // The inner overflow-div may be replaced wholesale when React transitions
    // between chats, which would leave the observer watching a detached node
    // that never fires. document.body is stable for the lifetime of the page.
    return document.body;
  }

  function startObserver(chatId) {
    stopObserver();
    if (!isContextAlive()) return;

    const container = getObserverContainer();
    dbg(` startObserver chatId=${chatId?.slice(0,8)} container=${container.tagName}`);

    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      // chatId is captured in the closure — never uses currentChatId at fire time
      debounceTimer = setTimeout(() => captureUntaggedNodes(chatId), DEBOUNCE_MS);
    });

    observer.observe(container, { childList: true, subtree: true });
  }

  // ─── Scroll & Highlight ──────────────────────────────────────────────────────

  async function scrollToQuestion(questionId) {
    let target = document.querySelector(`[data-aic-id="${questionId}"]`);

    if (!target) {
      const question = await getQuestionById(questionId);
      if (question) {
        target = findUserMessageNodes().find(
          (n) => (n.innerText || n.textContent || '').trim() === question.text
        );
      }
    }

    if (!target) {
      const chatData = await getCurrentChatData();
      if (chatData) {
        const idx = chatData.questions.findIndex((q) => q.id === questionId);
        if (idx !== -1) {
          const container = getScrollContainer();
          const estimated = (idx / chatData.questions.length) * container.scrollHeight;
          container.scrollTo({ top: estimated, behavior: 'smooth' });
          setTimeout(async () => {
            let retarget = document.querySelector(`[data-aic-id="${questionId}"]`);
            if (!retarget) {
              const q = await getQuestionById(questionId);
              if (q) {
                retarget = findUserMessageNodes().find(
                  (n) => (n.innerText || n.textContent || '').trim() === q.text
                );
              }
            }
            if (retarget) highlightNode(retarget);
          }, 500);
          return;
        }
      }
    }

    if (target) highlightNode(target);
  }

  function highlightNode(node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => node.classList.remove(HIGHLIGHT_CLASS), 2000);
  }

  // ─── Panel UI (Shadow DOM) ────────────────────────────────────────────────────

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const host = document.createElement('div');
    host.id = PANEL_ID;
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getPanelStyles();
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'aic-panel';
    panel.innerHTML = `
      <div id="aic-header">
        <span id="aic-title">AI Catalog</span>
        <button id="aic-close-btn" title="关闭">✕</button>
      </div>
      <div id="aic-body">
        <p class="aic-empty">尚无记录的问题</p>
      </div>
    `;
    shadowRoot.appendChild(panel);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = TOGGLE_BTN_ID;
    toggleBtn.title = '打开 AI Catalog';
    toggleBtn.textContent = '📋';
    document.body.appendChild(toggleBtn);

    toggleBtn.addEventListener('click', togglePanel);
    shadowRoot.getElementById('aic-close-btn').addEventListener('click', closePanel);
  }

  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    panelOpen = true;
    const panel = shadowRoot && shadowRoot.getElementById('aic-panel');
    if (panel) panel.classList.add('open');
    const btn = document.getElementById(TOGGLE_BTN_ID);
    if (btn) { btn.classList.add('panel-open'); btn.title = '关闭 AI Catalog'; }
    updatePanel();
  }

  function closePanel() {
    panelOpen = false;
    const panel = shadowRoot && shadowRoot.getElementById('aic-panel');
    if (panel) panel.classList.remove('open');
    const btn = document.getElementById(TOGGLE_BTN_ID);
    if (btn) { btn.classList.remove('panel-open'); btn.title = '打开 AI Catalog'; }
  }

  async function updatePanel() {
    if (!panelOpen || !shadowRoot || !isContextAlive()) return;
    const body = shadowRoot.getElementById('aic-body');
    if (!body) return;

    // Snapshot the chat we're rendering for — if the user switches again
    // while loadData is in-flight, we discard the stale result instead of
    // overwriting the panel with wrong-chat content.
    const renderingForChatId = currentChatId;
    const chatData = await getCurrentChatData();

    // Another switch happened while we were loading — bail out.
    if (currentChatId !== renderingForChatId) return;

    if (!chatData || chatData.questions.length === 0) {
      body.innerHTML = '<p class="aic-empty">尚无记录的问题</p>';
      return;
    }

    body.innerHTML = chatData.questions
      .map((q, i) => {
        const short = q.text.length > 80 ? q.text.slice(0, 80) + '…' : q.text;
        const time = new Date(q.timestamp).toLocaleTimeString('zh-CN', {
          hour: '2-digit', minute: '2-digit',
        });
        return `
          <div class="aic-item" data-qid="${q.id}" title="${escapeAttr(q.text)}">
            <span class="aic-index">${i + 1}</span>
            <span class="aic-text">${escapeHtml(short)}</span>
            <span class="aic-time">${time}</span>
          </div>`;
      })
      .join('');

    body.querySelectorAll('.aic-item').forEach((el) => {
      el.addEventListener('click', () => scrollToQuestion(el.dataset.qid));
    });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(str) {
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── Panel Styles (CSS variables for light / dark) ────────────────────────────

  function getPanelStyles() {
    return `
      /* ── Theme tokens ── */
      :host {
        all: initial;
        /* Dark (default) */
        --bg:        #1e1e2e;
        --bg-header: #181825;
        --border:    #313244;
        --text:      #cdd6f4;
        --muted:     #585b70;
        --accent:    #cba6f7;
        --hover-bg:  #313244;
        --hover-bdr: #45475a;
        --num-bg:    #313244;
        --scrollbar: #45475a;
      }

      @media (prefers-color-scheme: light) {
        :host {
          --bg:        #ffffff;
          --bg-header: #f5f5fa;
          --border:    #e2e2ef;
          --text:      #1e1e3a;
          --muted:     #9999bb;
          --accent:    #6d28d9;
          --hover-bg:  #f0eeff;
          --hover-bdr: #d0c8f0;
          --num-bg:    #ede9fe;
          --scrollbar: #c4bfe8;
        }
      }

      /* ── Panel shell ── */
      #aic-panel {
        position: fixed;
        top: 0; right: 0;
        width: 320px;
        height: 100vh;
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        box-shadow: -4px 0 24px rgba(0,0,0,0.15);
        display: flex;
        flex-direction: column;
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 2147483647;
        border-left: 1px solid var(--border);
      }
      #aic-panel.open { transform: translateX(0); }

      /* ── Header ── */
      #aic-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        background: var(--bg-header);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      #aic-title {
        font-weight: 600;
        font-size: 14px;
        color: var(--accent);
        letter-spacing: 0.5px;
      }
      #aic-close-btn {
        background: none;
        border: none;
        color: var(--muted);
        cursor: pointer;
        font-size: 16px;
        padding: 2px 6px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      #aic-close-btn:hover {
        color: var(--text);
        background: var(--hover-bg);
      }

      /* ── Body / scroll area ── */
      #aic-body {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        scrollbar-width: thin;
        scrollbar-color: var(--scrollbar) var(--bg);
      }
      #aic-body::-webkit-scrollbar { width: 6px; }
      #aic-body::-webkit-scrollbar-track { background: var(--bg); }
      #aic-body::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }

      /* ── Empty state ── */
      .aic-empty {
        color: var(--muted);
        text-align: center;
        margin-top: 40px;
        font-size: 12px;
      }

      /* ── Question item ── */
      .aic-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        cursor: pointer;
        margin-bottom: 4px;
        transition: background 0.15s, border-color 0.15s;
        border: 1px solid transparent;
      }
      .aic-item:hover {
        background: var(--hover-bg);
        border-color: var(--hover-bdr);
      }
      .aic-index {
        flex-shrink: 0;
        width: 20px; height: 20px;
        background: var(--num-bg);
        color: var(--accent);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 600;
        margin-top: 1px;
      }
      .aic-text {
        flex: 1;
        line-height: 1.4;
        color: var(--text);
        word-break: break-word;
      }
      .aic-time {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--muted);
        margin-top: 2px;
      }
    `;
  }

  // ─── SPA Navigation Detection ────────────────────────────────────────────────

  function patchHistoryMethods() {
    const wrap = (orig) =>
      function (...args) {
        const result = orig.apply(this, args);
        window.dispatchEvent(new Event('aic-urlchange'));
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () =>
      window.dispatchEvent(new Event('aic-urlchange'))
    );

    // Fallback: poll the URL every 500 ms.
    // Next.js / React Router often keeps an internal reference to the version
    // of history.replaceState it captured at boot — before our patch runs —
    // so the wrapped version is never called during SPA navigation.
    // Polling guarantees we detect the URL change within ~500 ms regardless.
    let lastPolledUrl = location.href;
    setInterval(() => {
      if (location.href !== lastPolledUrl) {
        lastPolledUrl = location.href;
        window.dispatchEvent(new Event('aic-urlchange'));
      }
    }, 500);
  }

  function handleUrlChange() {
    const newId = extractChatId();
    if (newId === currentChatId) return;
    dbg(` handleUrlChange ${currentChatId?.slice(0,8)} → ${newId?.slice(0,8)}`);

    // ── Display line (synchronous, immediate) ──────────────────────────────
    // Update the chat ID first, then read storage[newId] and re-render.
    // This is completely independent of the capture logic below.
    stampNodesWithChatId(currentChatId); // mark old nodes before ID changes
    stopObserver();
    currentChatId = newId;
    updatePanel(); // reads storage[newId] and renders — nothing else

    // ── Capture line (async, background) ──────────────────────────────────
    // Restore stored IDs onto DOM nodes, capture any new ones, start observer.
    // Runs entirely after the panel is already showing the correct chat.
    const chatId = newId;
    const myVersion = ++chatVersion;

    tagExistingNodes(chatId).then(async () => {
      if (chatVersion !== myVersion) return;
      await captureUntaggedNodes(chatId);
      startObserver(chatId);
    });

    // Re-scan once React has finished rendering the new chat's messages
    setTimeout(async () => {
      if (chatVersion !== myVersion) return;
      await tagExistingNodes(chatId);
      await captureUntaggedNodes(chatId);
    }, 1000);
  }

  // ─── Init ────────────────────────────────────────────────────────────────────

  async function init() {
    currentChatId = extractChatId();
    patchHistoryMethods();
    window.addEventListener('aic-urlchange', handleUrlChange);
    injectPanel();

    const chatId = currentChatId;
    const myVersion = ++chatVersion;

    // ── Display line ───────────────────────────────────────────────────────
    // Panel reads storage[chatId] and renders immediately on open.
    // (Nothing to do here — updatePanel() is called when user opens the panel)

    // ── Capture line ───────────────────────────────────────────────────────
    // Tag stored IDs onto DOM nodes FIRST, then capture untagged ones,
    // then start the observer — order matters to prevent re-capturing
    // already-stored questions on every page refresh.
    await tagExistingNodes(chatId);
    if (chatVersion !== myVersion) return;

    captureUntaggedNodes(chatId); // async, runs in background
    startObserver(chatId);

    // Re-scan after async content finishes loading (claude.ai loads messages
    // asynchronously; this catches anything that wasn't in DOM yet above)
    setTimeout(async () => {
      if (chatVersion !== myVersion) return;
      await tagExistingNodes(chatId);
      await captureUntaggedNodes(chatId);
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
