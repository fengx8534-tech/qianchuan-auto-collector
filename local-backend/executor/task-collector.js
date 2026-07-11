const fs = require("fs");
const { DEFAULT_CDP_URL, listTabs, connect, scoreQianchuanTab, openTab, switchToTodayDate } = require("./cdp-client");
const { recordCollectionIntegrity } = require("../lib/collection-integrity");

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function num(value) {
  const parsed = parseFloat(String(value ?? "").replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay(base = 500) {
  await sleep(base + Math.floor(Math.random() * 260));
}

function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function buildTaskCenterUrl(accountId) {
  const detail = encodeURIComponent(JSON.stringify({ tb: "uni_task_center" }));
  return `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${encodeURIComponent(accountId)}&uniDetail=%7B%7D#uniDetail=${detail}`;
}

function taskCenterUrlFromSource(sourceUrl, accountId) {
  try {
    const parsed = new URL(sourceUrl);
    if (!parsed.hostname.includes("qianchuan.jinritemai.com")) return "";
    parsed.pathname = "/uni-prom/detail";
    parsed.searchParams.set("aavid", accountId);
    parsed.searchParams.set("uniDetail", "{}");
    const hashParams = new URLSearchParams(String(parsed.hash || "").replace(/^#/, ""));
    let detail = {};
    try {
      detail = JSON.parse(hashParams.get("uniDetail") || "{}");
    } catch {
      detail = {};
    }
    detail.tb = "uni_task_center";
    if (!detail.edc) detail.edc = "liveRace";
    if (!detail.cst) detail.cst = "0";
    hashParams.set("uniDetail", JSON.stringify(detail));
    parsed.hash = hashParams.toString();
    return parsed.toString();
  } catch {
    return "";
  }
}

function buildTaskCenterUrlFromTabs(accountId, tabs = []) {
  const detailTabs = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com/uni-prom/detail"))
    .map((tab) => {
      const url = String(tab.url || "");
      let score = scoreQianchuanTab(tab);
      if (url.includes("uni_task_center")) score += 80;
      if (url.includes("tb%22%3A%22data") || url.includes("tb%22%3A%22creative")) score += 20;
      return { tab, url, score };
    })
    .sort((a, b) => b.score - a.score);
  for (const item of detailTabs) {
    const url = taskCenterUrlFromSource(item.url, accountId);
    if (url) return { url, tab: item.tab };
  }
  return { url: buildTaskCenterUrl(accountId), tab: null };
}

function buildExtractTasksExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const num = (value) => {
      const raw = String(value || "");
      const normalized = raw.replaceAll(",", "");
      const match = normalized.match(/-?\\d+(?:\\.\\d+)?/);
      if (!match) return null;
      const parsed = parseFloat(match[0]);
      if (!Number.isFinite(parsed)) return null;
      const unitText = normalized.slice(match.index, match.index + match[0].length + 4);
      return /万/.test(unitText) ? parsed * 10000 : parsed;
    };
    const looksLikeDate = (value) => Number.isFinite(value) && value >= 20000101 && value <= 20991231;
    const spendBudgetOf = (items) => {
      for (const item of items) {
        const raw = String(item || "").replaceAll(",", "");
        const match = raw.match(/(-?\\d+(?:\\.\\d+)?)\\s*\\/\\s*(-?\\d+(?:\\.\\d+)?)/);
        if (!match) continue;
        const spend = parseFloat(match[1]);
        const budget = parseFloat(match[2]);
        return {
          spend: Number.isFinite(spend) ? spend : null,
          budget: Number.isFinite(budget) ? budget : null,
        };
      }
      return {};
    };
    const taskCenterMetricsOf = (items) => {
      const statusIndex = items.findIndex((item) => /(调控中|调控结束|已暂停|已结束|进行中|审核|暂停)/.test(item));
      const createdIndex = items.findIndex((item) => /20\\d{2}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}/.test(item));
      const budget = statusIndex >= 0 ? num(items[statusIndex + 1]) : null;
      const tail = createdIndex >= 0
        ? items.slice(createdIndex + 1).map(num).filter((value) => Number.isFinite(value) && !looksLikeDate(value))
        : [];
      return {
        budget: Number.isFinite(budget) && !looksLikeDate(budget) ? budget : null,
        orderCost: tail[0] ?? null,
        dealAmount: tail[1] ?? null,
        roi: tail[2] ?? null,
        spend: tail.length ? tail[tail.length - 1] : null,
      };
    };
    const taskTypeOf = (text) => {
      if (/一键调速|一键起量|起量/.test(text)) return "oneClickLift";
      if (/控成本|成本调控/.test(text)) return "materialCostControl";
      if (/画面追投|放量追投|素材追投|追投/.test(text)) return "materialBoost";
      return "unknown";
    };
    const readRow = (row) => {
      const cells = Array.from(row.querySelectorAll("td,[role='cell'],.arco-table-td,.semi-table-cell,.byted-table-cell"))
        .map((cell) => clean(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
      const text = clean(cells.length ? cells.join(" ") : (row.innerText || row.textContent || ""));
      if (!text || text.length < 20) return null;
      if (!/(调控中|已暂停|已结束|进行中|预算|ROI|追投|起量|控成本)/.test(text)) return null;
      if (/->|→|调控状态[：:]|操作内容[：:]/.test(text)) return null;
      if (/首页\\s*乘方|千川可用余额|千川日预算|授权待处理|计划ID[：:]?\\s*\\d{8,}|抖音号ID[：:]?\\s*\\d{8,}/.test(text) && !/^20\\d{6}_/.test(text)) return null;
      const taskIdText = text.replace(/素材ID[：:]?\\s*\\d{8,}/g, "");
      const idMatch = taskIdText.match(/(?:任务ID|ID)[：:]?\\s*(\\d{8,})/);
      const taskId = idMatch?.[1] || "";
      if (!taskId) return null;
      const taskType = taskTypeOf(text);
      const status = cells.find((item) => /(调控中|调控结束|已暂停|已结束|进行中|审核|暂停)/.test(item)) || "";
      const numeric = cells.map(num).filter((value) => Number.isFinite(value));
      const name = cells.find((item) => item.includes(taskId)) || cells[0] || taskId;
      const spendBudget = spendBudgetOf(cells);
      const taskCenterMetrics = taskCenterMetricsOf(cells);
      const budget = taskCenterMetrics.budget ?? spendBudget.budget ?? numeric.find((value) => value > 0 && !looksLikeDate(value) && value < 1000000) ?? null;
      const spend = taskCenterMetrics.spend ?? spendBudget.spend ?? numeric.slice().reverse().find((value) => value >= 0 && !looksLikeDate(value)) ?? null;
      const roiCandidates = numeric.filter((value) => value >= 0 && value <= 1000);
      const roi = taskCenterMetrics.roi ?? (roiCandidates.length ? roiCandidates[Math.max(0, roiCandidates.length - 3)] : null);
      const dealAmount = taskCenterMetrics.dealAmount ?? numeric.find((value) => Number.isFinite(value) && value > Math.max(Number(spend || 0), Number(budget || 0))) ?? null;
      return {
        taskId,
        taskName: name,
        taskType,
        status,
        budget,
        roi,
        spend,
        dealAmount,
        rawText: text.slice(0, 700),
      };
    };
    const bodyText = clean(document.body?.innerText || "");
    const rows = Array.from(document.querySelectorAll("tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row"));
    const dataRows = rows.filter((row) => {
      const cells = row.querySelectorAll("td,[role='cell'],.arco-table-td,.semi-table-cell,.byted-table-cell");
      return cells.length > 0 && clean(row.innerText || row.textContent || "").length > 0;
    });
    const tasks = rows.map(readRow).filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const task of tasks) {
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      unique.push(task);
    }
    const taskCenterUrl = /qianchuan\\.jinritemai\\.com\\/uni-prom\\/detail/.test(location.href) && location.href.includes("uni_task_center");
    const taskHeaders = /任务名称|调控状态|调控预算|调控消耗|综合ROI目标|支付ROI目标/.test(bodyText);
    const tableContainer = Array.from(document.querySelectorAll("table,[role='table'],.arco-table,.semi-table,.byted-table,[class*='table']"))
      .some((el) => isVisible(el));
    const loadingVisible = Array.from(document.querySelectorAll("[class*='loading'],[class*='Loading'],[class*='spin'],[class*='Spin'],[aria-busy='true']"))
      .some((el) => {
        const marker = String(el.className || "") + " " + clean(el.innerText || el.textContent || el.getAttribute("aria-label") || "");
        return isVisible(el) && (el.getAttribute("aria-busy") === "true" || /加载|loading|spin/i.test(marker));
      });
    const emptyState = /共\\s*0\\s*条|暂无数据|暂无任务|未找到任务|哎呀/.test(bodyText);
    const tableReady = taskCenterUrl && document.readyState === "complete" && taskHeaders && tableContainer;
    return {
      // A row from the old SPA view is not enough: require the task-center URL,
      // a visible task table and its header before accepting a snapshot.
      ok: tableReady && !loadingVisible && unique.length > 0,
      title: document.title,
      url: location.href,
      rowCount: rows.length,
      dataRowCount: dataRows.length,
      taskRowCount: unique.length,
      tableReady,
      taskCenterUrl,
      taskHeaders,
      tableContainer,
      loadingVisible,
      emptyState,
      firstTaskName: unique[0]?.taskName || "",
      tasks: unique.slice(0, 100),
      textSample: bodyText.slice(0, 2500),
    };
  })()`;
}

function buildClickTabExpression(tabKind) {
  const wanted = tabKind === "oneclick"
    ? ["一键起量", "一键调速"]
    : ["素材追投", "放量追投", "画面追投", "控成本追投"];
  const avoid = tabKind === "oneclick"
    ? ["素材追投", "放量追投", "画面追投", "控成本追投"]
    : ["一键起量", "一键调速"];
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const wanted = ${JSON.stringify(wanted)};
    const avoid = ${JSON.stringify(avoid)};
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clickableOf = (el) => {
      const ownText = clean(el.innerText || el.textContent || "");
      const closest = el.closest("button,[role='tab'],[role='button'],a,.semi-tabs-tab,.semi-segmented-item,.arco-tabs-header-title,.arco-radio-button,.ovui-radio-item,.oc-radio-item");
      const closestText = clean(closest?.innerText || closest?.textContent || "");
      if (closest && avoid.some((item) => closestText.includes(item)) && !avoid.some((item) => ownText.includes(item))) return el;
      return closest || el;
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .filter((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (!text || text.length > 48) return false;
        if (!wanted.some((item) => text.includes(item))) return false;
        if (avoid.some((item) => text.includes(item))) return false;
        return isVisible(el);
      })
      .map((el) => {
        const node = clickableOf(el);
        const text = clean(node.innerText || node.textContent || el.innerText || el.textContent || "");
        const rect = node.getBoundingClientRect();
        const cls = String(node.className || "") + " " + String(el.className || "");
        let score = 0;
        if (node.getAttribute("role") === "tab") score += 70;
        if (node.tagName === "BUTTON") score += 55;
        if (/tabs|tab|segmented|radio|filter|筛选|类型|ovui-radio|oc-radio/.test(cls)) score += 45;
        if (wanted.some((item) => text === item)) score += 140;
        else if (wanted.some((item) => text.startsWith(item))) score += 80;
        if (avoid.some((item) => text.includes(item))) score -= 160;
        if (node.closest("tr,tbody,table")) score -= 120;
        if (/ID[：:]?\\s*\\d{8,}|预算|ROI|消耗|成交/.test(text)) score -= 100;
        return { node, text: text.slice(0, 80), score, top: Math.round(rect.top) };
      })
      .sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) return { ok: false, error: "tab_not_found", tabKind: ${JSON.stringify(tabKind)} };
    target.node.scrollIntoView({ block: "center", inline: "center" });
    target.node.click();
    return { ok: true, tabKind: ${JSON.stringify(tabKind)}, text: target.text, score: target.score, candidates: candidates.slice(0, 5).map((item) => ({ text: item.text, score: item.score, top: item.top })) };
  })()`;
}

function buildTaskTabReadyExpression(tabKind) {
  const wanted = tabKind === "oneclick"
    ? ["一键起量", "一键调速"]
    : ["素材追投", "放量追投", "画面追投", "控成本追投"];
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const wanted = ${JSON.stringify(wanted)};
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,.semi-tabs-tab,.semi-segmented-item,.arco-tabs-header-title,.arco-radio-button,.ovui-radio-item,.oc-radio-item"))
      .filter((el) => isVisible(el))
      .map((el) => {
        const text = clean(el.innerText || el.textContent || "");
        const cls = String(el.className || "");
        const selected = el.getAttribute("aria-selected") === "true" || /(?:^|\\s)(?:active|selected|checked)(?:\\s|$)/i.test(cls);
        return { text, selected, wanted: wanted.some((item) => text.includes(item)) };
      })
      .filter((item) => item.text && item.text.length <= 48);
    const selectionSupported = candidates.some((item) => item.selected);
    const activeWanted = candidates.some((item) => item.wanted && item.selected);
    const bodyText = clean(document.body?.innerText || "");
    const tableLoaded = /任务名称|调控状态|调控预算|调控消耗/.test(bodyText);
    return {
      ok: tableLoaded && (!selectionSupported || activeWanted),
      tableLoaded,
      selectionSupported,
      activeWanted,
      tabKind: ${JSON.stringify(tabKind)},
    };
  })()`;
}

function buildClickControlTabExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clickableOf = (el) => el.closest("button,[role='tab'],[role='button'],a,.semi-tabs-tab,.arco-tabs-header-title") || el;
    const candidates = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .filter((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (text !== "调控") return false;
        if (!isVisible(el)) return false;
        return true;
      })
      .map((el) => {
        const node = clickableOf(el);
        const rect = node.getBoundingClientRect();
        const cls = String(node.className || "") + " " + String(el.className || "");
        let score = 0;
        if (node.getAttribute("role") === "tab") score += 70;
        if (/tabs|tab|header/.test(cls)) score += 40;
        if (rect.top > 200) score -= 80;
        if (node.closest("tr,tbody,table")) score -= 150;
        return { node, score, top: Math.round(rect.top), text: clean(node.innerText || node.textContent || "调控") };
      })
      .sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) return { ok: false, error: "control_tab_not_found" };
    target.node.scrollIntoView({ block: "center", inline: "center" });
    target.node.click();
    return { ok: true, text: target.text, score: target.score, top: target.top };
  })()`;
}

function buildFindTaskExpression(taskId, step) {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const num = (value) => {
      const match = String(value || "").replaceAll(",", "").match(/-?\\d+(?:\\.\\d+)?/);
      if (!match) return null;
      const parsed = parseFloat(match[0]);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const looksLikeDate = (value) => Number.isFinite(value) && value >= 20000101 && value <= 20991231;
    const spendBudgetOf = (items) => {
      for (const item of items) {
        const raw = String(item || "").replaceAll(",", "");
        const match = raw.match(/(-?\\d+(?:\\.\\d+)?)\\s*\\/\\s*(-?\\d+(?:\\.\\d+)?)/);
        if (!match) continue;
        const spend = parseFloat(match[1]);
        const budget = parseFloat(match[2]);
        return {
          spend: Number.isFinite(spend) ? spend : null,
          budget: Number.isFinite(budget) ? budget : null,
        };
      }
      return {};
    };
    const taskCenterMetricsOf = (items) => {
      const statusIndex = items.findIndex((item) => /(调控中|调控结束|已暂停|已结束|进行中|审核|暂停|开启)/.test(item));
      const createdIndex = items.findIndex((item) => /20\\d{2}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}/.test(item));
      const budget = statusIndex >= 0 ? num(items[statusIndex + 1]) : null;
      const tail = createdIndex >= 0
        ? items.slice(createdIndex + 1).map(num).filter((value) => Number.isFinite(value) && !looksLikeDate(value))
        : [];
      return {
        budget: Number.isFinite(budget) && !looksLikeDate(budget) ? budget : null,
        orderCost: tail[0] ?? null,
        dealAmount: tail[1] ?? null,
        roi: tail[2] ?? null,
        spend: tail.length ? tail[tail.length - 1] : null,
      };
    };
    const taskId = ${JSON.stringify(String(taskId || ""))};
    const rows = Array.from(document.querySelectorAll("tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row"));
    const matched = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td,[role='cell'],.arco-table-td,.semi-table-cell,.byted-table-cell"))
        .map((cell) => clean(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
      const text = clean(cells.length ? cells.join(" ") : (row.innerText || row.textContent || ""));
      if (!text.includes(taskId)) return null;
      const numeric = cells.map(num).filter((value) => Number.isFinite(value));
      const ids = Array.from(new Set((text.match(/\\b\\d{12,}\\b/g) || []).filter((id) => id !== taskId))).slice(0, 20);
      const status = cells.find((item) => /(调控中|调控结束|已暂停|已结束|进行中|审核|暂停|开启)/.test(item)) || "";
      const spendBudget = spendBudgetOf(cells);
      const taskCenterMetrics = taskCenterMetricsOf(cells);
      const budget = taskCenterMetrics.budget ?? spendBudget.budget ?? numeric.find((value) => value > 0 && !looksLikeDate(value) && value < 1000000) ?? null;
      const spend = taskCenterMetrics.spend ?? spendBudget.spend ?? numeric.slice().reverse().find((value) => value >= 0 && !looksLikeDate(value)) ?? null;
      const roi = taskCenterMetrics.roi ?? numeric.filter((value) => value >= 0 && value <= 1000).at(-3) ?? null;
      const dealAmount = taskCenterMetrics.dealAmount ?? numeric.find((value) => value > Math.max(Number(spend || 0), Number(budget || 0))) ?? null;
      const durationText = cells.find((item) => /小时|分钟|天/.test(item)) || "";
      return {
        ok: true,
        taskId,
        step: ${JSON.stringify(step)},
        status,
        budget,
        duration: durationText,
        roi,
        spend,
        dealAmount,
        materialIds: ids,
        rawText: text.slice(0, 700),
      };
    }).filter(Boolean);
    return {
      ok: matched.length > 0,
      taskId,
      step: ${JSON.stringify(step)},
      rowCount: rows.length,
      matched: matched.slice(0, 3),
      textSample: clean(document.body?.innerText || "").slice(0, 2500),
    };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value || null;
}

async function waitFor(client, expression, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    if (last?.ok) return last;
    await sleep(500);
  }
  return last || { ok: false, error: "timeout" };
}

function buildTaskCenterLocationExpression(accountId) {
  return `(() => {
    const url = location.href;
    const matchesTaskCenter = /qianchuan\\.jinritemai\\.com\\/uni-prom\\/detail/.test(url) && url.includes("uni_task_center");
    const matchesAccount = !${JSON.stringify(String(accountId || ""))} || url.includes("aavid=${encodeURIComponent(String(accountId || ""))}");
    return {
      ok: matchesTaskCenter && matchesAccount && document.readyState === "complete",
      url,
      readyState: document.readyState,
      matchesTaskCenter,
      matchesAccount,
    };
  })()`;
}

async function randomExtractDelay() {
  await sleep(500 + Math.floor(Math.random() * 501));
}

function summarizeTaskPageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}#${String(parsed.hash || "").includes("uni_task_center") ? "uni_task_center" : "other"}`;
  } catch {
    return "";
  }
}

function logTaskPageProbe(options, payload) {
  if (!options?.logFile) return;
  const { url, ...rest } = payload;
  appendJsonl(options.logFile, {
    type: "task_collect_page",
    at: Date.now(),
    receivedAt: Date.now(),
    ...rest,
    page: summarizeTaskPageUrl(url),
  });
}

async function waitForTaskRows(client, expression, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  let zeroRowStreak = 0;
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    const dataRowCount = Number(last?.dataRowCount || 0);
    const unconfirmedZeroRows = last?.tableReady && !last?.emptyState && dataRowCount === 0;
    zeroRowStreak = unconfirmedZeroRows ? zeroRowStreak + 1 : 0;
    if (last?.ok) {
      // Let Qianchuan finish its asynchronous row update, then confirm that the
      // task table still exists before accepting this SPA snapshot.
      await randomExtractDelay();
      const confirmed = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
      if (confirmed?.ok) return { ...confirmed, attempts, zeroRowStreak: 0 };
      last = confirmed || last;
    }
    if (zeroRowStreak >= 2) {
      return {
        ...last,
        ok: false,
        error: "task_rows_empty_twice",
        attempts,
        zeroRowStreak,
      };
    }
    await sleep(500);
  }
  return { ...(last || { ok: false, error: "timeout" }), attempts, zeroRowStreak };
}

function normalizeBasic(task = {}) {
  return {
    status: task.status || "",
    budget: money(num(task.budget)),
    roi: money(num(task.roi)),
    spend: money(num(task.spend)),
    dealAmount: money(num(task.dealAmount)),
  };
}

function preferNonZeroMetric(primary, fallback) {
  const current = num(primary);
  const backup = num(fallback);
  if (Number.isFinite(current) && (current !== 0 || !Number.isFinite(backup) || backup <= 0)) return money(current);
  if (Number.isFinite(backup)) return money(backup);
  return null;
}

function oneClickFromMatch(match = {}, fallback = {}) {
  return {
    budget: money(num(match.budget ?? fallback.budget)),
    duration: match.duration || fallback.duration || "",
    roi: preferNonZeroMetric(match.roi, fallback.roi),
    spend: preferNonZeroMetric(match.spend, fallback.spend),
    dealAmount: preferNonZeroMetric(match.dealAmount, fallback.dealAmount),
    status: match.status || fallback.status || "",
  };
}

function materialFromMatch(match = {}, fallback = {}) {
  return {
    materialIds: Array.isArray(match.materialIds) ? match.materialIds : [],
    spend: preferNonZeroMetric(match.spend, fallback.spend),
    roi: preferNonZeroMetric(match.roi, fallback.roi),
    budget: money(num(match.budget ?? fallback.budget)),
    dealAmount: preferNonZeroMetric(match.dealAmount, fallback.dealAmount),
    status: match.status || fallback.status || "",
  };
}

function publicCollectedItems(collected = []) {
  return collected.map(({ statusDetail, ...item }) => item);
}

function mergeCollectedIntoMetricsTasks(state, collected = [], options = {}) {
  state.metrics = state.metrics || {};
  const nextTasks = [];
  const collectedCount = collected.length;
  const receivedAt = Date.now();
  const failedSteps = Array.isArray(options.failedSteps) ? options.failedSteps : [];
  const collectionWarnings = Array.isArray(options.warnings) ? options.warnings.filter(Boolean) : [];
  const partialIssues = [
    ...failedSteps.map((item) => `${item.step || "task"}:${item.error || "incomplete"}`),
    ...collectionWarnings,
  ];
  const partial = partialIssues.length > 0;
  collected.forEach((item) => {
    const key = String(item.taskId || "");
    if (!key) return;
    const oneclick = item.oneclick || {};
    const material = item.material || {};
    const basic = item.basic || {};
    const merged = {
      id: key,
      taskId: key,
      name: item.taskName || key,
      taskType: item.taskType || "unknown",
      status: basic.status || oneclick.status || material.status || "",
      budget: money(num(oneclick.budget ?? material.budget ?? basic.budget)),
      roi: money(num(oneclick.roi ?? material.roi ?? basic.roi)),
      spend: money(num(oneclick.spend ?? material.spend ?? basic.spend)),
      dealAmount: money(num(oneclick.dealAmount ?? material.dealAmount ?? basic.dealAmount)),
      oneclick,
      material,
      source: "task_collector",
      receivedAt,
      updatedAt: receivedAt,
    };
    if (!String(merged.status || "").includes("调控中")) return;
    nextTasks.push(merged);
  });
  state.metrics.tasks = nextTasks;
  state.latestByPage = state.latestByPage || {};
  state.latestByPage.taskCollector = {
    pageType: "taskCollector",
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields: nextTasks,
  };
  state.latestByPage.visualTaskCenter = {
    pageType: "visualTaskCenter",
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields: nextTasks.map((task) => ({ ...task })),
    source: "task_collector_mirror",
  };
  state.taskSource = {
    ...(state.taskSource || {}),
    source: "task_collector",
    status: "ok",
    label: "任务采集器",
    message: partial ? `本轮有 ${partialIssues.length} 项任务采集未完整确认，已保留可用任务数据` : "",
    qualityStatus: partial ? "partial" : "ok",
    partialCount: partialIssues.length,
    receivedAt,
    total: nextTasks.length,
    activeCount: nextTasks.length,
    count: collectedCount,
    collectedCount,
    filteredCount: Math.max(0, collectedCount - nextTasks.length),
    pages: [],
  };
  const activeCollectedCount = collected.filter((item) => String(item.basic?.status || item.oneclick?.status || item.material?.status || "").includes("调控中")).length;
  state.taskCollectionReconciliation = {
    status: activeCollectedCount === nextTasks.length ? (partial ? "partial" : "ok") : "warning",
    receivedAt,
    collectedActiveCount: activeCollectedCount,
    renderedActiveCount: nextTasks.length,
    taskIds: nextTasks.map((task) => task.taskId),
    message: activeCollectedCount === nextTasks.length ? "" : "任务采集结果与看板任务数不一致，已保留最近可用快照",
  };
  recordCollectionIntegrity(state, "task_collect", {
    label: "调控任务",
    source: "task_collector",
    accepted: true,
    partial,
    count: nextTasks.length,
    warnings: partialIssues,
    at: receivedAt,
  });
}

function defaultStatus(patch = {}) {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    currentTaskIndex: 0,
    currentTaskName: "",
    currentStep: "",
    stepLabel: "",
    lastError: "",
    completed: 0,
    total: 0,
    paused: false,
    details: [],
    failedSteps: [],
    warnings: [],
    ...patch,
  };
}

function updateStatus(options, patch) {
  const state = readJson(options.stateFile, {});
  state.taskCollectStatus = {
    ...(state.taskCollectStatus || defaultStatus()),
    ...patch,
    updatedAt: Date.now(),
  };
  state.updatedAt = new Date().toISOString();
  writeJson(options.stateFile, state);
  return state.taskCollectStatus;
}

function logWarning(options, payload) {
  appendJsonl(options.logFile, {
    type: "task_collect_warning",
    at: Date.now(),
    receivedAt: Date.now(),
    ...payload,
  });
}

function logPaused(options, payload) {
  appendJsonl(options.logFile, {
    type: "task_collect_paused",
    at: Date.now(),
    receivedAt: Date.now(),
    ...payload,
  });
}

async function ensureTaskCenterTab(cdpUrl, accountId) {
  const tabs = await listTabs(cdpUrl);
  const picked = buildTaskCenterUrlFromTabs(accountId, tabs);
  const existing = picked.tab || tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com/uni-prom/detail"))
    .sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a))[0];
  if (existing?.webSocketDebuggerUrl) {
    const client = connect(existing.webSocketDebuggerUrl);
    try {
      await client.send("Page.enable").catch(() => null);
      await client.send("Runtime.enable").catch(() => null);
      const locationExpression = buildTaskCenterLocationExpression(accountId);
      const current = await evaluate(client, locationExpression).catch(() => null);
      if (current?.matchesTaskCenter && current?.matchesAccount) {
        // A matching tab can still hold an old SPA cache. Reload it once with
        // cache bypass before the collection starts.
        await client.send("Page.reload", { ignoreCache: true });
      } else {
        // Do not collect from a reused detail/data tab. Return it to the
        // canonical task-center route first.
        await client.send("Page.navigate", { url: picked.url });
      }
      // Page.navigate/Page.reload return before the SPA tears down the prior
      // document. Avoid accepting that old document as the new task center.
      await sleep(800);
      let confirmed = await waitFor(client, locationExpression, 15000);
      if (!confirmed?.ok) {
        await client.send("Page.navigate", { url: picked.url });
        await sleep(800);
        confirmed = await waitFor(client, locationExpression, 15000);
      }
      if (!confirmed?.ok) throw new Error("task_center_navigation_timeout");
      await randomExtractDelay();
      return { ...existing, url: picked.url, taskCenterUrl: picked.url };
    } finally {
      client.close();
    }
  }
  const opened = await openTab(cdpUrl, picked.url);
  return { ...opened, url: picked.url, taskCenterUrl: picked.url };
}

async function reloadTaskCenter(client) {
  await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
  await sleep(1800);
}

async function collectTaskCenterPages(client, extractExpression, options = {}) {
  const pages = [];
  const warnings = [];
  let loadedEmpty = false;
  const extractPage = async (sourceTab, phase) => {
    let page = await waitForTaskRows(client, extractExpression, 8000);
    logTaskPageProbe(options, {
      sourceTab,
      phase,
      attempt: 1,
      ok: Boolean(page?.ok),
      error: page?.error || "",
      url: page?.url || "",
      rowCount: Number(page?.rowCount || 0),
      dataRowCount: Number(page?.dataRowCount || 0),
      taskRowCount: Number(page?.taskRowCount || 0),
      firstTaskName: page?.firstTaskName || page?.tasks?.[0]?.taskName || "",
    });
    if (page?.error !== "task_rows_empty_twice") return page;

    logWarning(options, { sourceTab, error: "task_rows_empty_twice_reloading" });
    await reloadTaskCenter(client);
    await evaluate(client, buildClickControlTabExpression()).catch(() => null);
    await randomExtractDelay();
    if (sourceTab === "materialBoost" || sourceTab === "oneClickLift") {
      const tabKind = sourceTab === "oneClickLift" ? "oneclick" : "material";
      await evaluate(client, buildClickTabExpression(tabKind)).catch(() => null);
      await randomExtractDelay();
    }
    page = await waitForTaskRows(client, extractExpression, 8000);
    logTaskPageProbe(options, {
      sourceTab,
      phase,
      attempt: 2,
      reloaded: true,
      ok: Boolean(page?.ok),
      error: page?.error || "",
      url: page?.url || "",
      rowCount: Number(page?.rowCount || 0),
      dataRowCount: Number(page?.dataRowCount || 0),
      taskRowCount: Number(page?.taskRowCount || 0),
      firstTaskName: page?.firstTaskName || page?.tasks?.[0]?.taskName || "",
    });
    if (page?.error === "task_rows_empty_twice") warnings.push(`${sourceTab}_rows_empty_after_reload`);
    return page;
  };

  const pushPage = (page, sourceTab) => {
    if (page?.tableReady && page?.emptyState && Number(page?.dataRowCount || 0) === 0) {
      loadedEmpty = true;
    }
    if (!page?.ok || !Array.isArray(page.tasks) || !page.tasks.length) return;
    pages.push({ ...page, sourceTab });
  };

  const filterTasksForSourceTab = (tasks = [], sourceTab = "") => {
    if (sourceTab === "materialBoost") return tasks.filter((task) => ["materialBoost", "materialCostControl"].includes(task.taskType));
    if (sourceTab === "oneClickLift") return tasks.filter((task) => task.taskType === "oneClickLift");
    return tasks;
  };

  const initialPage = await extractPage("initial", "control_tab");
  if (initialPage?.tableReady && initialPage?.emptyState && Number(initialPage?.dataRowCount || 0) === 0) {
    loadedEmpty = true;
  }

  for (const item of [
    { tabKind: "material", sourceTab: "materialBoost" },
    { tabKind: "oneclick", sourceTab: "oneClickLift" },
  ]) {
    const clicked = await evaluate(client, buildClickTabExpression(item.tabKind)).catch(() => null);
    if (clicked && clicked.clicked === false) continue;
    await randomExtractDelay();
    const tabReady = await waitFor(client, buildTaskTabReadyExpression(item.tabKind), 3500);
    if (!tabReady?.ok) warnings.push(`${item.sourceTab}_tab_unconfirmed`);
    await randomExtractDelay();
    const page = await extractPage(item.sourceTab, "task_type_tab");
    if (page && Array.isArray(page.tasks)) {
      page.tasks = filterTasksForSourceTab(page.tasks, item.sourceTab);
      page.tabReady = tabReady || null;
    }
    pushPage(page, item.sourceTab);
  }

  const byId = new Map();
  for (const page of pages) {
    for (const task of page.tasks || []) {
      const key = String(task.taskId || "");
      if (!key) continue;
      byId.set(key, { ...task, sourceTab: page.sourceTab });
    }
  }
  return {
    ok: byId.size > 0 || loadedEmpty,
    empty: byId.size === 0 && loadedEmpty,
    pages,
    tasks: Array.from(byId.values()),
    warnings: Array.from(new Set(warnings)),
  };
}

function shouldStop(options) {
  const state = readJson(options.stateFile, {});
  return state.taskCollectStatus?.stopRequested === true;
}

async function collectStepForTask(client, task, step, options, retryDelay = 3000) {
  const tabKind = step === "oneclick_lift" ? "oneclick" : "material";
  const label = step === "oneclick_lift" ? "一键起量采集" : "素材追投采集";
  updateStatus(options, {
    currentTaskName: task.taskName || task.taskId,
    currentStep: step,
    stepLabel: label,
    lastError: "",
  });
  await randomDelay();
  const tabResult = await evaluate(client, buildClickTabExpression(tabKind)).catch((error) => ({ ok: false, error: error.message }));
  if (!tabResult?.ok) {
    await sleep(retryDelay);
    await evaluate(client, buildClickTabExpression(tabKind)).catch(() => null);
  }
  await randomDelay();
  const findExpression = buildFindTaskExpression(task.taskId, step);
  let found = await waitFor(client, findExpression, 8000);
  if (!found?.ok) {
    updateStatus(options, { lastError: `${label}超时，等待 3 秒后重试` });
    await sleep(retryDelay);
    found = await waitFor(client, findExpression, 8000);
  }
  if (!found?.ok) {
    const error = `${step === "oneclick_lift" ? "oneclick" : "material"}_timeout`;
    logWarning(options, { taskId: task.taskId, step, error: "timeout_after_2_retries" });
    return { ok: false, step, error, warning: "timeout_after_2_retries" };
  }
  return { ok: true, step, match: found.matched?.[0] || null };
}

async function runTaskCollector(options = {}) {
  const stateFile = options.stateFile;
  const logFile = options.logFile;
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const runOptions = { stateFile, logFile };
  const startedAt = Date.now();
  updateStatus(runOptions, defaultStatus({
    running: true,
    startedAt,
    paused: false,
    stopRequested: false,
    stepLabel: "准备任务中心",
    collected: [],
  }));

  let client = null;
  const collected = [];
  const failedSteps = [];
  const warnings = [];
  let consecutiveFailedTasks = 0;
  const stepFailureStreak = { oneclick_lift: 0, material_boost: 0 };

  try {
    const tab = await ensureTaskCenterTab(cdpUrl, accountId);
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Runtime.enable").catch(() => null);
    await client.send("Page.enable").catch(() => null);
    await sleep(3500);

    const taskCenterLocation = await waitFor(client, buildTaskCenterLocationExpression(accountId), 10000);
    logTaskPageProbe(runOptions, {
      sourceTab: "navigation",
      phase: "before_collect",
      attempt: 1,
      ok: Boolean(taskCenterLocation?.ok),
      error: taskCenterLocation?.error || "",
      url: taskCenterLocation?.url || "",
      rowCount: 0,
      dataRowCount: 0,
      taskRowCount: 0,
      firstTaskName: "",
    });
    if (!taskCenterLocation?.ok) throw new Error("task_center_url_unconfirmed");
    const dateSwitch = await switchToTodayDate(client).catch((error) => ({ ok: false, reason: error.message }));
    logTaskPageProbe(runOptions, {
      sourceTab: "date",
      phase: "before_collect",
      attempt: 1,
      ok: dateSwitch.ok !== false,
      error: dateSwitch.reason || "",
      url: taskCenterLocation.url || "",
      rowCount: 0,
      dataRowCount: 0,
      taskRowCount: 0,
      firstTaskName: "",
    });
    if (!dateSwitch.ok) throw new Error(`task_date_range_unconfirmed:${dateSwitch.reason || "unknown"}`);

    const extractExpression = buildExtractTasksExpression();
    updateStatus(runOptions, { currentStep: "basic", stepLabel: "等待任务表格渲染" });
    await evaluate(client, buildClickControlTabExpression()).catch(() => null);
    await randomExtractDelay();
    let page = await collectTaskCenterPages(client, extractExpression, runOptions);
    if (!page?.ok) {
      updateStatus(runOptions, { lastError: "页面加载超时，已重试 1 次" });
      await reloadTaskCenter(client);
      await evaluate(client, buildClickControlTabExpression()).catch(() => null);
      await randomExtractDelay();
      page = await collectTaskCenterPages(client, extractExpression, runOptions);
    }
    if (!page?.ok) {
      updateStatus(runOptions, {
        running: false,
        paused: false,
        status: "failed",
        currentStep: "basic",
        stepLabel: "任务表格加载失败",
        lastError: "detail_table_timeout_after_reload",
        completed: 0,
        total: 0,
        details: [],
        collected: [],
        finishedAt: Date.now(),
      });
      return { ok: false, error: "detail_table_timeout_after_reload", collected, failedSteps, warnings };
    }

    if (Array.isArray(page.warnings) && page.warnings.length) warnings.push(...page.warnings);

    const tasks = (Array.isArray(page.tasks) ? page.tasks : [])
      .filter((task) => task.taskId)
      .slice(0, Number(options.maxTasks || 80));
    if (!tasks.length) {
      const output = { ok: true, empty: true, collected: [], failedSteps, warnings: [] };
      const emptyState = readJson(stateFile, {});
      const receivedAt = Date.now();
      emptyState.taskCollectStatus = {
        ...(emptyState.taskCollectStatus || {}),
        running: false,
        paused: false,
        status: "empty",
        stopRequested: false,
        currentStep: "done",
        stepLabel: "当前未采集到调控任务",
        completed: 0,
        total: 0,
        details: [],
        collected: [],
        failedSteps,
        warnings: [],
        lastError: "",
        finishedAt: receivedAt,
      };
      emptyState.metrics = emptyState.metrics || {};
      emptyState.metrics.tasks = [];
      emptyState.latestByPage = emptyState.latestByPage || {};
      emptyState.latestByPage.taskCollector = {
        pageType: "taskCollector",
        accountId: emptyState.config?.expectedAccountId || null,
        timestamp: receivedAt,
        receivedAt,
        fields: [],
      };
      emptyState.latestByPage.visualTaskCenter = {
        pageType: "visualTaskCenter",
        accountId: emptyState.config?.expectedAccountId || null,
        timestamp: receivedAt,
        receivedAt,
        fields: [],
        source: "task_collector_mirror",
      };
      emptyState.taskSource = {
        ...(emptyState.taskSource || {}),
        source: "task_collector",
        status: "empty",
        label: "任务采集器",
        message: "",
        receivedAt,
        total: 0,
        activeCount: 0,
        count: 0,
        collectedCount: 0,
        filteredCount: 0,
        pages: [],
      };
      emptyState.taskCollectResult = output;
      emptyState.updatedAt = new Date().toISOString();
      writeJson(stateFile, emptyState);
      return output;
    }
    updateStatus(runOptions, { total: tasks.length, details: [], currentStep: "basic", stepLabel: "基础字段采集" });

    for (let index = 0; index < tasks.length; index += 1) {
      if (shouldStop(runOptions)) break;
      const task = tasks[index];
      const detail = {
        taskId: task.taskId,
        taskName: task.taskName || task.taskId,
        taskType: task.taskType || "unknown",
        basic: normalizeBasic(task),
        oneclick: null,
        material: null,
        status: "running",
        stepStatus: { basic: "ok", oneclick_lift: "pending", material_boost: "pending" },
      };
      updateStatus(runOptions, {
        currentTaskIndex: index,
        currentTaskName: detail.taskName,
        currentStep: "basic",
        stepLabel: "基础字段采集",
        completed: collected.length,
        details: [...collected.map((item) => item.statusDetail || item), detail],
      });
      await randomDelay();

      const shouldCollectOneclick = task.taskType === "oneClickLift" || task.taskType === "unknown";
      const shouldCollectMaterial = ["materialBoost", "materialCostControl", "unknown"].includes(task.taskType);

      if (shouldCollectOneclick) {
        const oneclickResult = await withTimeout(
          collectStepForTask(client, task, "oneclick_lift", runOptions),
          30000,
          { ok: false, step: "oneclick_lift", error: "hard_timeout", warning: "hard_timeout" },
        );
        if (oneclickResult.ok) {
          detail.oneclick = oneClickFromMatch(oneclickResult.match, task);
          detail.stepStatus.oneclick_lift = "ok";
          stepFailureStreak.oneclick_lift = 0;
        } else {
          detail.stepStatus.oneclick_lift = oneclickResult.warning || oneclickResult.error;
          stepFailureStreak.oneclick_lift += 1;
          failedSteps.push({ taskId: task.taskId, step: "oneclick_lift", error: "timeout_after_2_retries" });
        }
      } else {
        detail.stepStatus.oneclick_lift = "skipped";
      }

      if (shouldCollectMaterial) {
        const materialResult = await withTimeout(
          collectStepForTask(client, task, "material_boost", runOptions),
          30000,
          { ok: false, step: "material_boost", error: "hard_timeout", warning: "hard_timeout" },
        );
        if (materialResult.ok) {
          detail.material = materialFromMatch(materialResult.match, task);
          detail.stepStatus.material_boost = "ok";
          stepFailureStreak.material_boost = 0;
        } else {
          detail.stepStatus.material_boost = materialResult.warning || materialResult.error;
          stepFailureStreak.material_boost += 1;
          failedSteps.push({ taskId: task.taskId, step: "material_boost", error: "timeout_after_2_retries" });
        }
      } else {
        detail.stepStatus.material_boost = "skipped";
      }

      const expectedStatuses = [
        shouldCollectOneclick ? detail.stepStatus.oneclick_lift : null,
        shouldCollectMaterial ? detail.stepStatus.material_boost : null,
      ].filter(Boolean);
      const taskFailed = expectedStatuses.length > 0 && expectedStatuses.every((status) => status !== "ok");
      consecutiveFailedTasks = taskFailed ? consecutiveFailedTasks + 1 : 0;
      detail.status = taskFailed ? "failed" : (failedSteps.some((item) => item.taskId === task.taskId) ? "partial" : "complete");
      collected.push({
        taskId: detail.taskId,
        taskName: detail.taskName,
        taskType: detail.taskType,
        basic: detail.basic,
        oneclick: detail.oneclick,
        material: detail.material,
        statusDetail: detail,
      });

      if (failedSteps.length >= 2) warnings.push(`累计 ${failedSteps.length} 个任务步骤采集超时`);

      const details = collected.map((item) => item.statusDetail);
      updateStatus(runOptions, {
        currentTaskIndex: index,
        currentTaskName: detail.taskName,
        currentStep: "task_done",
        stepLabel: "当前任务完成",
        completed: collected.length,
        total: tasks.length,
        details,
        failedSteps,
        warnings: Array.from(new Set(warnings)),
        lastError: taskFailed ? "当前任务一键起量和素材追投均超时" : "",
      });

      const repeatedStepFailure = Object.entries(stepFailureStreak).find(([, count]) => count >= 3);
      if (consecutiveFailedTasks >= 3 || repeatedStepFailure) {
        const pauseReason = repeatedStepFailure ? `consecutive_${repeatedStepFailure[0]}_warnings_3` : "consecutive_failures_3_tasks";
        logPaused(runOptions, { reason: pauseReason, lastTask: task.taskId });
        updateStatus(runOptions, {
          running: false,
          paused: true,
          currentStep: "paused",
          stepLabel: "连续失败已暂停",
          lastError: repeatedStepFailure ? `连续3个${repeatedStepFailure[0] === "material_boost" ? "素材追投" : "一键起量"}步骤失败，已暂停` : "连续3个任务失败，已暂停",
          finishedAt: Date.now(),
        });
        const pausedState = readJson(stateFile, {});
        const pausedOutput = {
          ok: false,
          paused: true,
          error: pauseReason,
          collected: publicCollectedItems(collected),
          failedSteps,
          warnings,
        };
        pausedState.taskCollectResult = pausedOutput;
        mergeCollectedIntoMetricsTasks(pausedState, pausedOutput.collected, pausedOutput);
        pausedState.updatedAt = new Date().toISOString();
        writeJson(stateFile, pausedState);
        return {
          ok: false,
          paused: true,
          error: pauseReason,
          collected: publicCollectedItems(collected),
          failedSteps,
          warnings,
        };
      }
    }

    const output = {
      ok: true,
      collected: publicCollectedItems(collected),
      failedSteps,
      warnings: Array.from(new Set(warnings)),
    };
    const finalState = readJson(stateFile, {});
    finalState.taskCollectStatus = {
      ...(finalState.taskCollectStatus || {}),
      running: false,
      status: failedSteps.length ? "partial" : "ok",
      paused: false,
      stopRequested: false,
      currentStep: "done",
      stepLabel: "任务采集完成",
      completed: collected.length,
      total: finalState.taskCollectStatus?.total || collected.length,
      finishedAt: Date.now(),
      collected: output.collected,
      failedSteps,
      warnings: output.warnings,
      lastError: failedSteps.length ? `本轮 ${failedSteps.length} 项任务明细未完整采集` : "",
    };
    finalState.taskCollectResult = output;
    mergeCollectedIntoMetricsTasks(finalState, output.collected, output);
    finalState.updatedAt = new Date().toISOString();
    writeJson(stateFile, finalState);
    return output;
  } catch (error) {
    updateStatus(runOptions, {
      running: false,
      paused: false,
      status: "failed",
      currentStep: "error",
      stepLabel: "任务采集异常",
      lastError: error.message,
      finishedAt: Date.now(),
    });
    const errorState = readJson(stateFile, {});
    const errorOutput = { ok: false, error: error.message, collected: publicCollectedItems(collected), failedSteps, warnings };
    errorState.taskCollectResult = errorOutput;
    recordCollectionIntegrity(errorState, "task_collect", {
      label: "调控任务",
      source: "task_collector",
      accepted: false,
      count: Array.isArray(errorState.metrics?.tasks) ? errorState.metrics.tasks.length : 0,
      reason: error.message,
      warnings: failedSteps.map((item) => `${item.step || "task"}:${item.error || "incomplete"}`),
    });
    errorState.updatedAt = new Date().toISOString();
    writeJson(stateFile, errorState);
    return errorOutput;
  } finally {
    if (client) client.close();
  }
}

function stopTaskCollector(options = {}) {
  const state = readJson(options.stateFile, {});
  state.taskCollectStatus = {
    ...(state.taskCollectStatus || defaultStatus()),
    running: Boolean(state.taskCollectStatus?.running),
    stopRequested: true,
    paused: true,
    currentStep: "stop_requested",
    stepLabel: "停止中",
    lastError: "用户请求停止采集",
    updatedAt: Date.now(),
  };
  state.updatedAt = new Date().toISOString();
  writeJson(options.stateFile, state);
  return { ok: true, taskCollectStatus: state.taskCollectStatus };
}

module.exports = { runTaskCollector, stopTaskCollector, defaultStatus };
