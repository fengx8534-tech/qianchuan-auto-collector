const { DEFAULT_CDP_URL, listTabs, connect, scoreQianchuanTab, openTab, switchToTodayDate } = require("./cdp-client");

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

function extractPlanContext(tabs = []) {
  for (const tab of tabs) {
    const url = String(tab.url || "");
    if (!url.includes("qianchuan.jinritemai.com")) continue;
    const adId = url.match(/[?&#](?:adId|uAId)=(\d+)/);
    if (adId) return { adId: adId[1] };
    const decoded = decodeURIComponent(url);
    const nestedAdId = decoded.match(/"uAId":"(\d+)"/) || decoded.match(/"adId":"(\d+)"/);
    if (nestedAdId) return { adId: nestedAdId[1] };
  }
  return {};
}

function buildDetailUrl(accountId, context = {}) {
  const params = new URLSearchParams({ aavid: accountId });
  if (context.adId) params.set("adId", context.adId);
  return `https://qianchuan.jinritemai.com/uni-prom/detail?${params.toString()}`;
}

function buildPlanExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
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
    const money = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const cellSelector = "th,td,[role='columnheader'],[role='cell'],.arco-table-th,.arco-table-td,.semi-table-cell,.byted-table-cell";
    const rowSelector = "tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row";
    const cellsOf = (row) => {
      const cells = Array.from(row.querySelectorAll(cellSelector));
      return cells
        .filter((cell) => !cells.some((other) => other !== cell && other.contains(cell)))
        .map((cell) => clean(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
    };
    const text = clean(document.body?.innerText || "");
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const headerRows = rows.map(cellsOf).filter((cells) => cells.length >= 2);
    const timeLike = (value) => /^\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}/.test(clean(value));
    const scoreLabel = (label, kind) => {
      const value = clean(label).replace(/\\s+/g, "");
      if (!value) return 0;
      if (kind === "baseSpend") {
        if (value === "基础消耗") return 100;
        if (value.includes("基础消耗")) return 90;
        if (value === "基础") return 70;
      }
      if (kind === "planTotalCost") {
        if (value === "总消耗" || value === "整体消耗" || value === "消耗") return 95;
        if (value.includes("总消耗") || value.includes("整体消耗")) return 85;
        if (/^消耗\\(.*\\)$/.test(value)) return 75;
      }
      if (kind === "planRoi") {
        if (value === "ROI" || value === "净成交ROI" || value === "综合ROI") return 95;
        if (value.includes("ROI")) return 70;
      }
      return 0;
    };
    const extractColumnTotal = (kind) => {
      const candidates = [];
      headerRows.forEach((cells, rowIndex) => {
        cells.forEach((label, cellIndex) => {
          const score = scoreLabel(label, kind);
          if (score > 0) candidates.push({ rowIndex, cellIndex, label, score, headers: cells.slice(0, 24) });
        });
      });
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, 6)) {
        const values = [];
        const totals = [];
        const headerLooksHourly = candidate.headers.some((label) => clean(label) === "时间");
        for (let index = candidate.rowIndex + 1; index < rows.length; index += 1) {
          const cells = cellsOf(rows[index]);
          if (cells.length <= candidate.cellIndex) continue;
          const rowText = clean(cells.join(" "));
          if (!rowText || /基础消耗|总消耗|整体消耗|计划名称|投放内容|广告组|操作/.test(rowText)) continue;
          if (headerLooksHourly && !timeLike(cells[0])) continue;
          const value = money(num(cells[candidate.cellIndex]));
          if (!Number.isFinite(value) || value < 0) continue;
          const item = { value, text: rowText.slice(0, 160), cellText: cells[candidate.cellIndex] };
          if (/合计|总计|汇总/.test(rowText)) totals.push(item);
          else values.push(item);
        }
        const chosen = totals.length ? totals.slice(0, 1) : values.slice(0, 80);
        if (!chosen.length) continue;
        const total = kind === "planRoi"
          ? money(chosen.reduce((sum, item) => sum + item.value, 0) / chosen.length)
          : money(totals.length ? totals[0].value : chosen.reduce((sum, item) => sum + item.value, 0));
        if (Number.isFinite(total)) {
          return { value: total, column: candidate.label, rows: chosen.length, rowSamples: chosen.slice(0, 3), headers: candidate.headers };
        }
      }
      return null;
    };
    const inlineBase = (() => {
      const match = text.match(/(?:^|\\s)基础\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)(?=\\s|$)/);
      const value = money(num(match?.[1]));
      return Number.isFinite(value) && value > 0 ? { value, column: "基础", rows: 1, rowSamples: [{ value, text: text.slice(0, 180), cellText: match[1] }], headers: [] } : null;
    })();
    const base = inlineBase || extractColumnTotal("baseSpend");
    const total = extractColumnTotal("planTotalCost");
    const roi = extractColumnTotal("planRoi");
    const metrics = {
      baseSpend: base?.value ?? null,
      planTotalCost: total?.value ?? null,
      planRoi: roi?.value ?? null,
      baseSpendSource: base ? "plan_table_dom" : undefined,
      planTotalCostSource: total ? "plan_table_dom" : undefined,
      planRoiSource: roi ? "plan_table_dom" : undefined,
    };
    const useful = Number.isFinite(metrics.baseSpend) || Number.isFinite(metrics.planTotalCost) || Number.isFinite(metrics.planRoi);
    const domReady = rows.length > 0 && (/基础消耗|总消耗|整体消耗|ROI|消耗/.test(text));
    return {
      ok: useful && domReady,
      metrics: Object.fromEntries(Object.entries(metrics).filter(([, value]) => Number.isFinite(value) || typeof value === "string")),
      title: document.title,
      url: location.href,
      rowCount: rows.length,
      textSample: text.slice(0, 500),
      columns: { base, total, roi },
    };
  })()`;
}

function buildEnsurePlanDataExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const clicked = [];
    const result = { url: location.href, clicked };
    if (location.href.includes("/uni-prom/detail")) {
      try {
        const url = new URL(location.href);
        const params = new URLSearchParams((url.hash || "").replace(/^#/, ""));
        const raw = params.get("uniDetail");
        if (raw) {
          const detail = JSON.parse(raw);
          let changed = false;
          if (detail.tb !== "data") { detail.tb = "data"; changed = true; }
          if (detail.edc !== "liveRace") { detail.edc = "liveRace"; changed = true; }
          if (detail.cst !== "0") { detail.cst = "0"; changed = true; }
          if (changed) {
            params.set("uniDetail", JSON.stringify(detail));
            history.replaceState(null, "", url.origin + url.pathname + url.search + "#" + params.toString());
            window.dispatchEvent(new HashChangeEvent("hashchange"));
            result.hashChanged = true;
          }
        }
      } catch (error) {
        result.hashError = error.message;
      }
    }
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const dataTab = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "数据" && visible(item.el))
      .sort((a, b) => {
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (ar.top - br.top) || (ar.left - br.left);
      })[0];
    if (dataTab) {
      dataTab.el.click();
      clicked.push("数据");
    }
    result.finalUrl = location.href;
    return result;
  })()`;
}

function buildPlanTablePrepareExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const touched = [];
    const candidates = Array.from(document.querySelectorAll("button,div,span,a,h1,h2,h3,th,[role='columnheader']"))
      .filter((el) => /计划|投放列表|广告列表|基础消耗|基础/.test(clean(el.innerText || el.textContent || "")));
    const target = candidates.find((el) => /计划|投放列表|广告列表|基础消耗/.test(clean(el.innerText || el.textContent || "")));
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center", inline: "nearest" });
      touched.push({ tag: target.tagName, className: String(target.className || "").slice(0, 80), reason: "scroll_into_plan_area" });
    } else {
      window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) * 0.7);
      touched.push({ tag: "WINDOW", reason: "scroll_window_down" });
    }

    const verticalContainers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el && el.scrollHeight > el.clientHeight + 180 && el.clientHeight > 240)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
      .slice(0, 8);
    verticalContainers.forEach((el) => {
      const before = el.scrollTop || 0;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (max <= 0) return;
      el.scrollTop = Math.max(el.scrollTop || 0, Math.round(max * 0.72));
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ tag: el.tagName, className: String(el.className || "").slice(0, 80), before, after: el.scrollTop, max, reason: "vertical" });
    });

    const horizontalContainers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el && el.scrollWidth > el.clientWidth + 80 && el.clientWidth > 120);
    horizontalContainers.forEach((el) => {
      const before = el.scrollLeft || 0;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      if (max <= 0) return;
      el.scrollLeft = max;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ tag: el.tagName, className: String(el.className || "").slice(0, 80), before, after: el.scrollLeft || max, max, reason: "horizontal" });
    });
    return { touched: touched.slice(0, 20) };
  })()`;
}

function buildSetPlanBaseOnlyExpression(enabled) {
  return `(() => {
    const want = ${enabled ? "true" : "false"};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const isChecked = (el) => {
      const box = el?.matches?.("input[type='checkbox']") ? el : (el?.querySelector?.("input[type='checkbox']") || el?.closest?.("label")?.querySelector?.("input[type='checkbox']"));
      if (box && typeof box.checked === "boolean") return box.checked;
      const candidate = box || el;
      const aria = candidate?.getAttribute?.("aria-checked");
      if (aria === "true") return true;
      if (aria === "false") return false;
      const cls = String(candidate?.className || "");
      if (/checked|selected|active/.test(cls) && !/uncheck|unchecked/.test(cls)) return true;
      return null;
    };
    const label = Array.from(document.querySelectorAll("label,span,div,input,[role='checkbox']"))
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "") }))
      .find((item) => /只看基础数据/.test(item.text) && visible(item.el));
    if (!label) return { ok: false, wanted: want, reason: "base_only_toggle_not_found" };
    const container = label.el.closest("label") || label.el.parentElement || label.el;
    const checkbox = container.querySelector?.("input[type='checkbox']") || container.querySelector?.("[role='checkbox']") || label.el;
    const checked = isChecked(checkbox);
    if (checked === want) return { ok: true, wanted: want, checked, clicked: false };
    if (checked === null && !want) return { ok: false, wanted: want, checked, clicked: false, reason: "base_only_state_unknown" };
    (checkbox || label.el).scrollIntoView({ block: "center", inline: "nearest" });
    (checkbox || label.el).click();
    return { ok: true, wanted: want, checked, clicked: true };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value || null;
}

async function preparePlanPage(client) {
  await evaluate(client, buildEnsurePlanDataExpression()).catch(() => null);
  await sleep(1500);
  for (let index = 0; index < 2; index += 1) {
    await evaluate(client, buildPlanTablePrepareExpression()).catch(() => null);
    await sleep(900);
  }
}

async function collectBaseOnlyPlanMetrics(client) {
  const toggle = await evaluate(client, buildSetPlanBaseOnlyExpression(true)).catch((error) => ({ ok: false, error: error.message }));
  if (!toggle?.ok) return { toggle, page: null };
  await sleep(toggle.clicked ? 1500 : 500);
  await preparePlanPage(client);
  const page = await waitForPlan(client, 8000);
  await evaluate(client, buildSetPlanBaseOnlyExpression(false)).catch(() => null);
  return { toggle, page };
}

async function waitForPlan(client, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  const expression = buildPlanExpression();
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    if (last?.ok) return last;
    await sleep(500);
  }
  return last || { ok: false, error: "plan_timeout" };
}

async function ensurePlanTab(cdpUrl, accountId) {
  const tabs = await listTabs(cdpUrl);
  const existing = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com/uni-prom/detail"))
    .sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a))[0];
  if (existing?.webSocketDebuggerUrl) return existing;
  return openTab(cdpUrl, buildDetailUrl(accountId, extractPlanContext(tabs)));
}

async function runPlanCollector(options = {}) {
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const startedAt = Date.now();
  let client = null;
  try {
    const tab = await ensurePlanTab(cdpUrl, accountId);
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Runtime.enable").catch(() => null);
    await client.send("Page.enable").catch(() => null);
    await randomDelay();
    const dateSwitch = await switchToTodayDate(client).catch((error) => ({ ok: false, reason: error.message }));
    if (!dateSwitch.ok) throw new Error(`plan_date_range_unconfirmed:${dateSwitch.reason || "unknown"}`);
    await preparePlanPage(client);
    let page = await waitForPlan(client, 8000);
    let reloaded = false;
    if (!page?.ok) {
      reloaded = true;
      await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
      await sleep(1500);
      await randomDelay();
      await preparePlanPage(client);
      page = await waitForPlan(client, 8000);
    }
    if (!page?.ok) {
      return {
        ok: false,
        status: "skipped",
        error: "plan_timeout_after_reload",
        startedAt,
        finishedAt: Date.now(),
        reloaded,
        page,
      };
    }
    let baseOnly = null;
    if (!Number.isFinite(num(page.metrics?.baseSpend))) {
      baseOnly = await collectBaseOnlyPlanMetrics(client);
      const baseValue = money(num(baseOnly?.page?.metrics?.planTotalCost));
      if (Number.isFinite(baseValue) && baseValue > 0) {
        page.metrics = {
          ...(page.metrics || {}),
          baseSpend: baseValue,
          baseSpendSource: "plan_base_only_dom",
          baseSpendRows: baseOnly.page?.columns?.total?.rows,
        };
      }
    }
    return {
      ok: true,
      status: "ok",
      startedAt,
      finishedAt: Date.now(),
      reloaded,
      dateSwitch,
      metrics: page.metrics || {},
      page: {
        title: page.title || tab.title || "",
        url: page.url || tab.url || "",
        rowCount: page.rowCount || 0,
        textSample: cleanText(page.textSample || "").slice(0, 500),
        columns: page.columns || {},
        baseOnly: baseOnly ? { toggle: baseOnly.toggle, metrics: baseOnly.page?.metrics || {}, columns: baseOnly.page?.columns || {} } : null,
      },
    };
  } catch (error) {
    return { ok: false, status: "error", error: error.message, startedAt, finishedAt: Date.now() };
  } finally {
    if (client) client.close();
  }
}

module.exports = { runPlanCollector };
