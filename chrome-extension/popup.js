const pageTypeNode = document.getElementById("pageType");
const statusText = document.getElementById("statusText");
const extractBtn = document.getElementById("extractBtn");
const openDashboardBtn = document.getElementById("openDashboardBtn");
const themeToggle = document.getElementById("themeToggle");
const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

function setStatus(text) {
  statusText.textContent = text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function requestExtract() {
  try {
    setStatus("正在读取当前页面。");
    const tab = await getActiveTab();
    if (!tab?.id) {
      setStatus("未找到当前标签页。");
      return;
    }

    const result = await chrome.tabs.sendMessage(tab.id, { action: "extract" });
    pageTypeNode.textContent = result?.pageType || "unknown";
    await chrome.storage.local.set({ lastExtract: result });
    const key = "extract_" + (result?.pageType || "unknown");
    await chrome.storage.local.set({ [key]: result });
    const syncResult = await chrome.runtime.sendMessage({ action: "syncSnapshot", payload: result });
    const syncText = syncResult?.ok ? "，已同步本地后台" : "，本地后台未连接";
    setStatus("已读取：" + (result?.pageType || "unknown") + "，" + Object.keys(result?.fields || {}).length + " 个字段" + syncText);
  } catch {
    pageTypeNode.textContent = "unknown";
    setStatus("读取失败，请确认当前页是千川页面并已加载完成。");
  }
}

async function loadPageType() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const result = await chrome.tabs.sendMessage(tab.id, { action: "extract" });
    pageTypeNode.textContent = result?.pageType || "unknown";
  } catch {
    pageTypeNode.textContent = "unknown";
  }
}

function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/index.html") });
}

extractBtn.addEventListener("click", requestExtract);
openDashboardBtn.addEventListener("click", openDashboard);
themeToggle.addEventListener("click", () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); });
loadPageType();
