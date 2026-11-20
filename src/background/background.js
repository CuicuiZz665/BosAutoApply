// background.js (MV3 service worker)
// 职责很单一：接收 content script 上报的进度，缓存最新状态，
// 供 popup 打开时立刻读取（即使 popup 在任务运行期间被关闭过）。

let latestState = {
  running: false,
  appliedCount: 0,
  skippedCount: 0,
  errorCount: 0,
  log: []
};

// 兜底：任何未捕获的 Promise 拒绝都只记日志，不让 service worker 崩掉
self.addEventListener('unhandledrejection', (event) => {
  console.warn('[background] 未捕获的异步错误（已忽略）:', event.reason);
  event.preventDefault();
});

// 合并为单个 listener：避免多条消息分发到多个监听器时的响应端口歧义
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.type === 'BA_PROGRESS') {
      latestState = message.payload;
      // 用 storage.local 兼容所有 Chrome 版本（session 需要 102+ 且有上下文限制）
      chrome.storage.local.set({ ba_latest_state: latestState }).catch(() => {});

      if (sender.tab && sender.tab.id) {
        const badgeText = latestState.running ? String(latestState.appliedCount) : '';
        chrome.action.setBadgeText({ text: badgeText, tabId: sender.tab.id }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId: sender.tab.id }).catch(() => {});
      }
      return false;
    }

    if (message.type === 'BA_GET_LATEST_STATE') {
      chrome.storage.local
        .get('ba_latest_state')
        .then((data) => {
          try {
            sendResponse(data.ba_latest_state || latestState);
          } catch (_e) {
            // popup 可能在响应前已被关闭，端口断开属于正常情况，忽略
          }
        })
        .catch(() => {
          try {
            sendResponse(latestState);
          } catch (_e) {
            /* 同上，忽略 */
          }
        });
      return true; // 异步响应
    }
  } catch (e) {
    console.warn('[background] 处理消息异常（已忽略）:', e);
  }
  return false;
});
