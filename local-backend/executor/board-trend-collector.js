const { DEFAULT_CDP_URL, listTabs, connect, scoreQianchuanTab, openTab } = require("./cdp-client");

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

function firstFiniteMetric(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay(base = 500) {
  await sleep(base + Math.floor(Math.random() * 260));
}

function tsMs(value, fallbackText = "") {
  const parsed = num(value);
  if (Number.isFinite(parsed)) {
    if (parsed > 1e12) return parsed;
    if (parsed > 1e9) return parsed * 1000;
  }
  const text = String(fallbackText || "");
  const matched = text.match(/(20\d{2})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second = "0"] = matched;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function extractLiveContext(tabs = []) {
  for (const tab of tabs) {
    const url = String(tab.url || "");
    if (!url.includes("qianchuan.jinritemai.com")) continue;
    const rid = url.match(/live_room_id=(\d+)/);
    if (!rid) continue;
    const aid = url.match(/anchorId=(\d+)/);
    return { liveRoomId: rid[1], anchorId: aid ? aid[1] : "" };
  }
  return null;
}

function buildBoardUrl(context = {}, accountId = "") {
  if (!context.liveRoomId) return "";
  const params = new URLSearchParams({
    live_room_id: context.liveRoomId,
    aavid: accountId,
    fromModule: "uni_promotion_v2",
  });
  if (context.anchorId) params.set("anchorId", context.anchorId);
  return `https://qianchuan.jinritemai.com/board-next?${params.toString()}`;
}

async function ensureBoardTab(cdpUrl, accountId) {
  const tabs = await listTabs(cdpUrl);
  const existing = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com/board-next"))
    .sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a))[0];
  if (existing?.webSocketDebuggerUrl) return existing;
  const context = extractLiveContext(tabs);
  const url = buildBoardUrl(context || {}, accountId);
  if (!url) throw new Error("board_live_context_missing");
  return openTab(cdpUrl, url);
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value || null;
}

function buildDomReadyExpression() {
  return `(() => {
    const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
    return {
      ok: text.includes("整体趋势") && text.includes("综合成本") && text.includes("净成交金额"),
      title: document.title,
      url: location.href,
      textSample: text.slice(0, 500),
    };
  })()`;
}

async function waitForTrendDom(client, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  const expression = buildDomReadyExpression();
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    if (last?.ok) return last;
    await sleep(500);
  }
  return last || { ok: false, error: "board_trend_dom_timeout" };
}

function granularityLabel(granularity) {
  const value = [1, 5, 30].includes(Number(granularity)) ? Number(granularity) : 5;
  return value === 1 ? "每分钟粒度" : `${value}分钟粒度`;
}

async function selectGranularity(client, granularity = 5) {
  const label = granularityLabel(granularity);
  const openResult = await evaluate(client, `(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 20 && rect.height > 12 && style.visibility !== "hidden" && style.display !== "none";
    };
    const nodes = Array.from(document.querySelectorAll("button, div, span"));
    const control = nodes.find((el) => visible(el) && /分钟粒度/.test(el.innerText || el.textContent || ""));
    if (!control) return { ok: false, error: "granularity_control_missing" };
    control.click();
    return { ok: true, text: control.innerText || control.textContent || "" };
  })()`).catch((error) => ({ ok: false, error: error.message }));
  await randomDelay(300);
  const clickResult = await evaluate(client, `(() => {
    const target = ${JSON.stringify(label)};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
    };
    const options = Array.from(document.querySelectorAll(".ovui-option, [role='option'], li, div, span"));
    const option = options.find((el) => visible(el) && String(el.innerText || el.textContent || "").replace(/\\s+/g, "").includes(target));
    if (!option) return { ok: false, error: "granularity_option_missing", opened: ${JSON.stringify(openResult)} };
    option.click();
    return { ok: true, text: option.innerText || option.textContent || "" };
  })()`).catch((error) => ({ ok: false, error: error.message, opened: openResult }));
  await randomDelay(500);
  return { opened: openResult, selected: clickResult };
}

async function clickRefresh(client) {
  return evaluate(client, `(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 20 && rect.height > 12 && style.visibility !== "hidden" && style.display !== "none";
    };
    const nodes = Array.from(document.querySelectorAll("button, div, span"));
    const refresh = nodes.find((el) => visible(el) && /刷新数据/.test(el.innerText || el.textContent || ""));
    if (!refresh) return { ok: false, error: "refresh_button_missing" };
    refresh.click();
    return { ok: true, text: refresh.innerText || refresh.textContent || "" };
  })()`).catch((error) => ({ ok: false, error: error.message }));
}

function findStatsData(value, depth = 0) {
  if (!value || depth > 6) return null;
  if (Array.isArray(value?.StatsData?.Rows)) return value.StatsData;
  if (Array.isArray(value?.data?.StatsData?.Rows)) return value.data.StatsData;
  if (Array.isArray(value?.data?.data?.StatsData?.Rows)) return value.data.data.StatsData;
  if (typeof value !== "object") return null;
  for (const child of Object.values(value)) {
    const found = findStatsData(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function dimensionTime(dimensions = {}) {
  const preferred = [
    dimensions.stat_time_1_minute,
    dimensions.stat_time_minute,
    dimensions.stat_time_5_minute,
    dimensions.stat_time_30_minute,
  ].filter(Boolean);
  const dimension = preferred[0] || Object.entries(dimensions).find(([key]) => /stat_time/i.test(key))?.[1] || null;
  if (!dimension) return { ts: null, text: "" };
  const text = dimension.ValueStr || dimension.Name || dimension.Text || "";
  return { ts: tsMs(dimension.Value, text), text };
}

function trendPointsFromPayload(payload, granularity = 5) {
  const stats = findStatsData(payload);
  const rows = stats?.Rows;
  if (!Array.isArray(rows) || !rows.length) return [];
  const points = rows.map((row) => {
    const metrics = row?.Metrics || {};
    const dimensions = row?.Dimensions || {};
    const time = dimensionTime(dimensions);
    const cost = firstFiniteMetric(
      metrics.stat_real_cost_for_overall_roi2?.Value,
      metrics.stat_cost_for_overall_roi2?.Value,
      metrics.stat_real_cost_for_roi2?.Value,
      metrics.stat_cost_for_roi2?.Value,
      metrics.total_stat_cost?.Value,
      metrics.stat_cost?.Value,
    );
    const revenue = firstFiniteMetric(
      metrics.total_order_settle_amount_realtime_for_roi2_1h?.Value,
      metrics.total_order_settle_amount_realtime_for_overall_roi2_1h?.Value,
      metrics.total_pay_order_gmv_include_coupon_realtime_for_roi2?.Value,
      metrics.total_pay_order_gmv_realtime_for_roi2?.Value,
      metrics.total_order_settle_amount?.Value,
      metrics.pay_order_gmv?.Value,
    );
    return {
      ts: time.ts,
      time: time.text,
      cost: Number.isFinite(cost) ? money(cost) : null,
      revenue: Number.isFinite(revenue) ? money(revenue) : null,
      roi: Number.isFinite(cost) && cost > 0 && Number.isFinite(revenue) ? money(revenue / cost) : null,
      intervalMinutes: Number(granularity) || 5,
      source: "qianchuan_board_trend",
    };
  }).filter((point) => Number.isFinite(point.ts) && (Number.isFinite(point.cost) || Number.isFinite(point.revenue)));
  const normalized = removeCumulativeFirstSpike(dedupePoints(points));
  const actualGranularity = inferPointGranularity(normalized) || Number(granularity) || 5;
  return normalized.map((point) => ({ ...point, intervalMinutes: actualGranularity }));
}

function inferPointGranularity(points = []) {
  const diffs = points
    .map((point, index) => index > 0 ? point.ts - points[index - 1].ts : null)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value / 60000))
    .filter((value) => value >= 1);
  if (!diffs.length) return null;
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 2) return 1;
  if (median <= 10) return 5;
  return 30;
}

function dedupePoints(points = []) {
  const byTs = new Map();
  points.forEach((point) => {
    const previous = byTs.get(point.ts);
    if (!previous) {
      byTs.set(point.ts, point);
      return;
    }
    const score = (Number.isFinite(point.cost) ? 1 : 0) + (Number.isFinite(point.revenue) ? 1 : 0);
    const previousScore = (Number.isFinite(previous.cost) ? 1 : 0) + (Number.isFinite(previous.revenue) ? 1 : 0);
    byTs.set(point.ts, score >= previousScore ? { ...previous, ...point } : previous);
  });
  return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function removeCumulativeFirstSpike(points = []) {
  if (points.length < 4) return points;
  const first = points[0];
  const laterCosts = points.slice(1, 8).map((point) => num(point.cost)).filter((value) => Number.isFinite(value) && value > 0);
  const laterRevenues = points.slice(1, 8).map((point) => num(point.revenue)).filter((value) => Number.isFinite(value) && value > 0);
  const medianCost = median(laterCosts);
  const medianRevenue = median(laterRevenues);
  const firstCost = num(first.cost);
  const firstRevenue = num(first.revenue);
  const costSpike = Number.isFinite(firstCost) && Number.isFinite(medianCost) && medianCost > 0 && firstCost > medianCost * 8;
  const revenueSpike = Number.isFinite(firstRevenue) && Number.isFinite(medianRevenue) && medianRevenue > 0 && firstRevenue > medianRevenue * 8;
  if (!costSpike && !revenueSpike) return points;
  return points.slice(1);
}

function shouldInspectResponse(response = {}) {
  const url = String(response.url || "");
  if (!url.includes("qianchuan.jinritemai.com")) return false;
  const mime = String(response.mimeType || "");
  if (/totalTrend|StatsData|trend|statQuery|common\/statQuery/i.test(url)) return true;
  return mime.includes("json") && /\/ad\/api\/data\/v1\/common\/statQuery/i.test(url);
}

function parseBodyPayload(body = {}) {
  const raw = body.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : String(body.body || "");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectTrendFromNetwork(client, granularity = 5, waitMs = 9000) {
  const watched = new Map();
  const captures = [];
  const bodyPromises = [];

  const offResponse = client.on("Network.responseReceived", (params = {}) => {
    if (!params.requestId || !shouldInspectResponse(params.response || {})) return;
    watched.set(params.requestId, {
      url: params.response.url || "",
      status: params.response.status || null,
      mimeType: params.response.mimeType || "",
    });
  });
  const offFinished = client.on("Network.loadingFinished", (params = {}) => {
    const record = watched.get(params.requestId);
    if (!record) return;
    watched.delete(params.requestId);
    const bodyPromise = client.send("Network.getResponseBody", { requestId: params.requestId })
      .then((body) => {
        const payload = parseBodyPayload(body);
        if (!payload) return;
        const points = trendPointsFromPayload(payload, granularity);
        if (!points.length) return;
        const actualGranularity = inferPointGranularity(points) || Number(points[0]?.intervalMinutes) || Number(granularity) || 5;
        if (Number(granularity) === 1 && actualGranularity !== 1) return;
        if (Number(granularity) === 5 && actualGranularity > 10) return;
        if (Number(granularity) === 30 && actualGranularity < 15) return;
        captures.push({
          url: record.url,
          status: record.status,
          pointCount: points.length,
          points,
          actualGranularity,
          totals: extractTrendTotals(payload),
          capturedAt: Date.now(),
        });
      })
      .catch(() => null);
    bodyPromises.push(bodyPromise);
  });

  try {
    await client.send("Network.enable").catch(() => null);
    await selectGranularity(client, granularity);
    await clickRefresh(client);
    const startedAt = Date.now();
    while (Date.now() - startedAt < waitMs) {
      await Promise.allSettled(bodyPromises.splice(0));
      if (captures.length) break;
      await sleep(300);
    }
    await Promise.allSettled(bodyPromises.splice(0));
  } finally {
    offResponse();
    offFinished();
  }

  return captures.sort((a, b) => b.pointCount - a.pointCount || b.capturedAt - a.capturedAt)[0] || null;
}

function extractTrendTotals(payload) {
  const stats = findStatsData(payload);
  const totals = stats?.Totals || {};
  const cost = firstFiniteMetric(
    totals.stat_real_cost_for_overall_roi2?.Value,
    totals.stat_cost_for_overall_roi2?.Value,
    totals.stat_real_cost_for_roi2?.Value,
    totals.stat_cost_for_roi2?.Value,
  );
  const revenue = firstFiniteMetric(
    totals.total_order_settle_amount_realtime_for_roi2_1h?.Value,
    totals.total_order_settle_amount_realtime_for_overall_roi2_1h?.Value,
    totals.total_pay_order_gmv_include_coupon_realtime_for_roi2?.Value,
    totals.total_pay_order_gmv_realtime_for_roi2?.Value,
  );
  return {
    cost: Number.isFinite(cost) ? money(cost) : null,
    revenue: Number.isFinite(revenue) ? money(revenue) : null,
    roi: Number.isFinite(cost) && cost > 0 && Number.isFinite(revenue) ? money(revenue / cost) : null,
  };
}

async function runBoardTrendCollector(options = {}) {
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const granularity = [1, 5, 30].includes(Number(options.granularity)) ? Number(options.granularity) : 5;
  const startedAt = Date.now();
  let client = null;
  try {
    const tab = await ensureBoardTab(cdpUrl, accountId);
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Runtime.enable").catch(() => null);
    await client.send("Page.enable").catch(() => null);
    let page = await waitForTrendDom(client, 8000);
    let reloaded = false;
    if (!page?.ok) {
      reloaded = true;
      await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
      await sleep(1500);
      page = await waitForTrendDom(client, 8000);
    }
    if (!page?.ok) {
      return { ok: false, status: "skipped", error: "board_trend_dom_timeout", startedAt, finishedAt: Date.now(), reloaded, page };
    }

    let capture = await collectTrendFromNetwork(client, granularity, 14000);
    if (!capture) {
      reloaded = true;
      await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
      await sleep(1500);
      await waitForTrendDom(client, 8000);
      capture = await collectTrendFromNetwork(client, granularity, 14000);
    }
    if (!capture?.points?.length) {
      return {
        ok: false,
        status: "skipped",
        error: "board_trend_api_timeout",
        startedAt,
        finishedAt: Date.now(),
        reloaded,
        page,
      };
    }

    return {
      ok: true,
      status: "ok",
      startedAt,
      finishedAt: Date.now(),
      reloaded,
      granularity: capture.actualGranularity || granularity,
      requestedGranularity: granularity,
      points: capture.points,
      totals: capture.totals,
      page: {
        title: page.title || tab.title || "",
        url: page.url || tab.url || "",
        textSample: cleanText(page.textSample || "").slice(0, 500),
      },
      sourceUrl: capture.url,
    };
  } catch (error) {
    return { ok: false, status: "error", error: error.message, startedAt, finishedAt: Date.now() };
  } finally {
    if (client) client.close();
  }
}

module.exports = { runBoardTrendCollector };
