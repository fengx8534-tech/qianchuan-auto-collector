const LOCAL_BACKEND = "http://127.0.0.1:8788";
const PENDING_KEY = "pendingSnapshots";
const NOTIFIED_AI_BATCH_KEY = "notifiedAiActionBatch";
const NOTIFICATION_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'%3E%3Crect width='48' height='48' rx='10' fill='%231f7a55'/%3E%3Ctext x='24' y='31' text-anchor='middle' font-size='22' font-family='Arial' fill='white' font-weight='700'%3EAI%3C/text%3E%3C/svg%3E";

function ensureAlarms() {
  chrome.alarms.create("autoExtract", { periodInMinutes: 1 });
  chrome.alarms.create("aiActionPoll", { periodInMinutes: 0.5 });
}

ensureAlarms();

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
});

async function syncSnapshot(snapshot) {
  const response = await fetch(`${LOCAL_BACKEND}/api/snapshot.php`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  return response.json();
}

async function readPendingSnapshots() {
  const result = await chrome.storage.local.get([PENDING_KEY]);
  return Array.isArray(result[PENDING_KEY]) ? result[PENDING_KEY] : [];
}

async function savePendingSnapshots(items) {
  await chrome.storage.local.set({ [PENDING_KEY]: items.slice(-50) });
}

async function bufferSnapshot(snapshot) {
  const pending = await readPendingSnapshots();
  pending.push(snapshot);
  await savePendingSnapshots(pending);
}

async function flushPendingSnapshots() {
  const pending = await readPendingSnapshots();
  if (!pending.length) return;
  const failed = [];
  for (const snapshot of pending) {
    try {
      await syncSnapshot(snapshot);
    } catch {
      failed.push(snapshot);
    }
  }
  await savePendingSnapshots(failed);
}

async function syncWithBuffer(snapshot) {
  try {
    const result = await syncSnapshot(snapshot);
    await flushPendingSnapshots();
    return { ok: true, result };
  } catch (error) {
    await bufferSnapshot(snapshot);
    return { ok: false, error: error.message, buffered: true };
  }
}

async function getQianchuanTabs() {
  const tabs = await chrome.tabs.query({ url: "https://qianchuan.jinritemai.com/*" });
  return tabs || [];
}

async function autoExtractActiveTab() {
  const tabs = await getQianchuanTabs();
  console.log("[qianchuan] autoExtract alarm", new Date().toLocaleTimeString(), "tabs", tabs.length);
  if (!tabs.length) {
    console.log("[qianchuan] autoExtract skipped: no qianchuan tab");
    return;
  }
  for (const tab of tabs) {
    try {
      chrome.tabs.sendMessage(tab.id, { action: "forceAssist" }).catch(() => {});
      const result = await chrome.tabs.sendMessage(tab.id, { action: "extract" });
      await chrome.storage.local.set({ lastExtract: result, [`extract_${result?.pageType || "unknown"}`]: result });
      const syncResult = await syncWithBuffer(result);
      console.log("[qianchuan] autoExtract", tab.id, result?.pageType || "unknown", syncResult);
    } catch (error) {
      console.log("[qianchuan] autoExtract tab failed", tab.id, error.message);
    }
  }
}

async function checkAiNotifications() {
  try {
    const response = await fetch(`${LOCAL_BACKEND}/api/dashboard.php`, { cache: "no-store" });
    if (!response.ok) return;
    const state = await response.json();
    const first = (state.actions || []).find((action) => action.source === "ai" && action.status === "pending_review");
    if (!first) return;
    const batchId = `ai-batch-${first.createdAt}`;
    const saved = await chrome.storage.local.get([NOTIFIED_AI_BATCH_KEY]);
    if (saved[NOTIFIED_AI_BATCH_KEY] === batchId) return;
    await chrome.storage.local.set({ [NOTIFIED_AI_BATCH_KEY]: batchId });
    chrome.notifications.create(batchId, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON,
      title: "千川 AI 有新的调控建议",
      message: first.title || first.reason || "点击打开实时调控台审批",
      priority: 2,
    });
  } catch (error) {
    console.log("[qianchuan] ai notification skipped", error.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "autoExtract") autoExtractActiveTab().catch((error) => console.log("[qianchuan] autoExtract failed", error.message));
  if (alarm.name === "aiActionPoll") checkAiNotifications();
});

setInterval(checkAiNotifications, 30000);

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("ai-batch-")) chrome.tabs.create({ url: `${LOCAL_BACKEND}/preview.html` });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "getExtractData") {
    chrome.storage.local.get(["lastExtract"], (result) => {
      sendResponse(result?.lastExtract || null);
    });
    return true;
  }

  if (message?.action === "getAllExtractData") {
    chrome.storage.local.get(
      ["extract_investOverview", "extract_liveScreen", "extract_investData", "extract_controlTable"],
      (result) => {
        sendResponse(result || {});
      }
    );
    return true;
  }

  if (message?.action === "syncSnapshot") {
    syncWithBuffer(message.payload).then(sendResponse);
    return true;
  }

  if (message?.action === "apiIntercept") {
    const payload = message.payload || {};
    syncWithBuffer({ pageType: "apiIntercept", fields: payload, timestamp: payload.ts, accountId: payload.accountId })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
