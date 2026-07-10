(function () {
  const boostMethodMap = {
    "放量追投": "素材追投",
    "一键起量": "一键起量",
    "智能调速": "一键调速",
    "搜索快投": "搜索抢首屏",
  };

  function parseJsonSafely(value) {
    if (!value) return null;
    const candidates = [value];
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      // Ignore malformed encoded text.
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  function getUniDetailFromHash(hash) {
    const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
    const queryText = rawHash.includes("?") ? rawHash.slice(rawHash.indexOf("?") + 1) : rawHash;
    const params = new URLSearchParams(queryText);
    return parseJsonSafely(params.get("uniDetail"));
  }

  function getPageType() {
    const { pathname, hash } = window.location;

    if (pathname === "/uni-prom/overall") return "investOverview";
    if (pathname === "/board-next") return "liveScreen";

    if (pathname === "/uni-prom/detail") {
      const uniDetail = getUniDetailFromHash(hash);
      if (uniDetail?.tb === "data") return "investData";
      if (uniDetail?.tb === "uni_task_center") return "controlTable";
    }

    return "unknown";
  }

  function getAccountId() {
    const params = new URLSearchParams(window.location.search);
    const urlAccountId = params.get("aavid") || params.get("aadvid") || params.get("account_id");
    if (urlAccountId) return urlAccountId;
    const accountNode = document.querySelector('[class*="account"]');
    const text = accountNode?.innerText || accountNode?.textContent || "";
    const match = text.match(/\d{8,}/);
    return match ? match[0] : null;
  }

  function readFieldValue(field) {
    if (!field.selector) return "";
    const node = document.querySelector(field.selector);
    if (!node) return "";
    return (node.innerText || node.textContent || node.value || "").trim();
  }

  function parseMetricNumber(value) {
    const cleaned = String(value ?? "")
      .replaceAll(",", "")
      .replaceAll("%", "")
      .trim();
    const match = cleaned.match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const parsed = parseFloat(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function extractNumberFromSelector(field) {
    return parseMetricNumber(readFieldValue(field));
  }

  function extractNumberFromTableRow(field) {
    const row = document.querySelector(".ovui-table__body-wrapper tr");
    const cells = Array.from(row?.querySelectorAll("td") || []);
    const text = readCellText(cells, field.columnIndex);
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const matchedLine = lines.find((line) => line.includes(field.matchText));
    return parseMetricNumber(matchedLine || "");
  }

  function findMetricListValue(matchText) {
    const nameNodes = Array.from(document.querySelectorAll(".metric-list .metric-name-text"));
    const nameNode = nameNodes.find((node) => (node.innerText || node.textContent || "").trim() === matchText);
    if (!nameNode) return "";

    const siblingText = nameNode.nextElementSibling?.matches?.(".metric-name-value")
      ? nameNode.nextElementSibling.innerText || nameNode.nextElementSibling.textContent || ""
      : "";
    if (siblingText) return siblingText;

    const parentValue = nameNode.parentElement?.querySelector?.(".metric-name-value");
    return parentValue?.innerText || parentValue?.textContent || "";
  }

  function extractNumberFromMetricList(field) {
    return parseMetricNumber(findMetricListValue(field.matchText));
  }

  function extractInvestOverview(config) {
    const fields = {};
    config.fields.forEach((field) => {
      if (field.extractMethod === "tableRow") {
        fields[field.key] = extractNumberFromTableRow(field);
        return;
      }
      if (field.extractMethod === "metricList") {
        fields[field.key] = extractNumberFromMetricList(field);
        return;
      }
      if (field.selector) fields[field.key] = extractNumberFromSelector(field);
    });
    return fields;
  }

  function extractLiveScreen(config) {
    const fields = {};
    config.fields.forEach((field) => {
      if (field.canvasRendered) {
        fields[field.key] = null;
        return;
      }

      if (field.cardSelector && field.matchText) {
        const cards = Array.from(document.querySelectorAll(field.cardSelector));
        const card = cards.find((item) => (item.innerText || item.textContent || "").includes(field.matchText));
        fields[field.key] = parseMetricNumber(card?.innerText || card?.textContent || "");
        return;
      }

      if (field.selector) fields[field.key] = extractNumberFromSelector(field);
    });
    return fields;
  }

  function readCellText(cells, columnIndex) {
    const cell = cells[columnIndex];
    return (cell?.innerText || cell?.textContent || "").trim();
  }

  function isNumericTaskField(key) {
    return ["budget", "targetRoi", "payRoi", "bid", "spend", "dealAmount", "roi", "impressions", "clicks"].includes(key);
  }

  function mapBoostMethod(value) {
    const text = String(value || "").trim();
    if (!text) return { type: "", unknownBoostMethod: "" };
    if (boostMethodMap[text]) return { type: boostMethodMap[text], unknownBoostMethod: "" };
    const matchedKey = Object.keys(boostMethodMap).find((key) => text.includes(key));
    if (matchedKey) return { type: boostMethodMap[matchedKey], unknownBoostMethod: "" };
    return { type: "未知类型", unknownBoostMethod: text };
  }

  function extractControlTable(config) {
    const rows = Array.from(document.querySelectorAll(config.rowSelector || ""));
    return rows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("td"));
        const task = {};
        config.fields.forEach((field) => {
          const text = readCellText(cells, field.columnIndex);
          task[field.key] = isNumericTaskField(field.key) ? parseMetricNumber(text) : text;
        });
        Object.assign(task, mapBoostMethod(task.boostMethod));
        return task;
      })
      .filter((task) => Object.values(task).some((value) => value !== "" && value !== null));
  }

  function extractData() {
    const pageType = getPageType();
    const config = globalThis.QIANCHUAN_FIELD_MAP?.[pageType];
    let fields = {};

    if (config?.fields) {
      if (pageType === "investOverview") fields = extractInvestOverview(config);
      else if (pageType === "liveScreen") fields = extractLiveScreen(config);
      else if (pageType === "controlTable") fields = extractControlTable(config);
      else {
        config.fields.forEach((field) => {
          if (!field.selector) return;
          fields[field.key] = extractNumberFromSelector(field);
        });
      }
    }

    return {
      pageType,
      accountId: getAccountId(),
      timestamp: Date.now(),
      fields,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "forceAssist") {
      window.postMessage({ type: "QIANCHUAN_FORCE_ASSIST" }, "*");
      sendResponse({ ok: true });
      return false;
    }
    if (message?.action !== "extract") return false;
    const metricList = document.querySelector(".metric-list");
    if (!metricList) {
      const trendArea = document.querySelector('[class*="trend"], [class*="chart"]');
      if (trendArea) trendArea.scrollIntoView({ behavior: "instant" });
      setTimeout(() => { sendResponse(extractData()); }, 500);
      return true;
    }
    sendResponse(extractData());
    return false;
  });

  const lastInterceptMap = {};
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.type !== "QIANCHUAN_API_INTERCEPT") return;
    try {
      const url = new URL(event.data.url, location.href);
      const reqFrom = url.searchParams.get("reqFrom") || "";
      const key = `${url.origin}${url.pathname}:${reqFrom}`.slice(0, 140);
      const now = Date.now();
      if (lastInterceptMap[key] && now - lastInterceptMap[key] < 30000) return;
      lastInterceptMap[key] = now;
      chrome.runtime.sendMessage({
        action: "apiIntercept",
        payload: { url: event.data.url, data: event.data.data, ts: event.data.ts, accountId: getAccountId(), pageUrl: location.href },
      });
    } catch {}
  });

  globalThis.QIANCHUAN_PAGE_DETECTOR = {
    getPageType,
    getUniDetailFromHash,
    extractData,
  };
})();
