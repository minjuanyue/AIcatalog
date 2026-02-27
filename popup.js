// AI Catalog - popup.js

const STORAGE_KEY = 'aicatalog_data';

// ─── Load and render ───────────────────────────────────────────────────────────

async function loadData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      resolve(res[STORAGE_KEY] || {});
    });
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderChatList(data) {
  const container = document.getElementById('chat-list');

  const entries = Object.entries(data).sort(
    ([, a], [, b]) => b.updatedAt - a.updatedAt
  );

  if (entries.length === 0) {
    container.innerHTML =
      '<p class="empty-hint">暂无记录。打开 Claude.ai 对话后，问题将自动收集。</p>';
    return;
  }

  container.innerHTML = entries
    .map(([chatId, chat]) => {
      const questions = chat.questions || [];
      const title = chat.title || chatId.slice(0, 20);
      const updated = formatDate(chat.updatedAt);

      const qItems = questions
        .map((q, i) => {
          const short = q.text.length > 100 ? q.text.slice(0, 100) + '…' : q.text;
          const time = new Date(q.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          });
          return `
            <div class="q-item">
              <span class="q-num">${i + 1}</span>
              <span class="q-text">${escapeHtml(short)}</span>
              <span class="q-time">${time}</span>
            </div>`;
        })
        .join('');

      return `
        <details class="chat-entry">
          <summary>
            <span class="chat-arrow">▶</span>
            <div class="chat-meta">
              <div class="chat-title">${escapeHtml(title)}</div>
              <div class="chat-info">更新于 ${updated}</div>
            </div>
            <span class="chat-count">${questions.length} 问</span>
          </summary>
          <div class="question-list">
            ${qItems || '<p class="empty-hint" style="margin:8px">暂无问题</p>'}
          </div>
        </details>`;
    })
    .join('');
}

// ─── Export ────────────────────────────────────────────────────────────────────

async function exportData() {
  const data = await loadData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aicatalog_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Clear ─────────────────────────────────────────────────────────────────────

async function clearData() {
  if (!confirm('确认清空所有记录？此操作不可恢复。')) return;
  await new Promise((r) => chrome.storage.local.remove(STORAGE_KEY, r));
  renderChatList({});
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const data = await loadData();
  renderChatList(data);

  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-clear').addEventListener('click', clearData);
});
