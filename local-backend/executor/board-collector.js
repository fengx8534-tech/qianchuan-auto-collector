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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomDelay(base = 500) {
  await sleep(base + Math.floor(Math.random() * 260));
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

function buildBoardExpression() {
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
    const firstNextIndex = (text, from, labels = []) => {
      const indexes = labels
        .map((item) => text.indexOf(item, from))
        .filter((index) => index >= 0);
      return indexes.length ? Math.min(...indexes) : -1;
    };
    const readNumberField = (text, label, nextLabels = []) => {
      const index = text.indexOf(label);
      if (index < 0) return null;
      const start = index + label.length;
      const end = firstNextIndex(text, start, nextLabels);
      const segment = text.slice(start, end >= 0 ? end : start + 90).trim();
      if (!segment || /^[-—–]/.test(segment)) return null;
      const match = segment.match(/-?\\d[\\d,]*(?:\\.\\d+)?/);
      return match ? num(match[0]) : null;
    };
    const text = clean(document.body?.innerText || "");
    const orderCount = readNumberField(text, "整体成交订单数", ["GPM", "千次观看成交金额", "观看成交转化率", "观看成交率", "观看-成交率"])
      ?? readNumberField(text, "成交订单数", ["GPM", "千次观看成交金额", "观看成交转化率", "观看成交率", "观看-成交率", "直播实时评论"]);
    const orderCost = readNumberField(text, "整体成交订单成本(元)", ["实时在线人数", "在线人数", "曝光观看率", "曝光-观看率"])
      ?? readNumberField(text, "整体成交订单成本", ["实时在线人数", "在线人数", "曝光观看率", "曝光-观看率"])
      ?? readNumberField(text, "成交订单成本", ["实时在线人数", "在线人数", "曝光观看率", "曝光-观看率"])
      ?? readNumberField(text, "订单成本", ["实时在线人数", "在线人数", "曝光观看率", "曝光-观看率"]);
    const gpm = readNumberField(text, "千次观看成交金额", ["观看成交转化率", "观看成交率", "观看-成交率", "整体成交订单成本"])
      ?? readNumberField(text, "GPM(元)", ["观看成交转化率", "观看成交率", "观看-成交率", "整体成交订单成本"])
      ?? readNumberField(text, "GPM", ["观看成交转化率", "观看成交率", "观看-成交率", "整体成交订单成本"]);
    const watchConversionRate = readNumberField(text, "观看-成交率", ["整体成交订单成本", "成交订单成本", "订单成本"])
      ?? readNumberField(text, "观看成交率", ["整体成交订单成本", "成交订单成本", "订单成本"])
      ?? readNumberField(text, "观看成交转化率", ["整体成交订单成本", "成交订单成本", "订单成本"]);
    const totalViewers = readNumberField(text, "直播间整体观看人数", ["整体趋势", "素材表现", "成交渠道构成"])
      ?? readNumberField(text, "整体观看人数", ["整体趋势", "素材表现", "成交渠道构成"])
      ?? readNumberField(text, "观看人数", ["整体趋势", "素材表现", "成交渠道构成"]);
    const onlineCount = readNumberField(text, "实时在线人数", ["曝光观看率", "曝光-观看率", "直播间整体观看人数", "整体观看人数", "观看人数"])
      ?? readNumberField(text, "在线人数", ["曝光观看率", "曝光-观看率", "直播间整体观看人数", "整体观看人数", "观看人数"]);
    const exposureWatchRate = readNumberField(text, "曝光-观看率", ["直播间整体观看人数", "整体观看人数", "观看人数", "整体趋势"])
      ?? readNumberField(text, "曝光观看率(次数)", ["直播间整体观看人数", "整体观看人数", "观看人数", "整体趋势"])
      ?? readNumberField(text, "曝光观看率", ["直播间整体观看人数", "整体观看人数", "观看人数", "整体趋势"]);
    const metrics = {
      orderCount: Number.isFinite(orderCount) ? Math.round(orderCount) : null,
      orderCost: money(orderCost),
      gpm: money(gpm),
      watchConversionRate: money(watchConversionRate),
      totalViewers: Number.isFinite(totalViewers) ? Math.round(totalViewers) : null,
      onlineCount: Number.isFinite(onlineCount) ? Math.round(onlineCount) : null,
      exposureWatchRate: money(exposureWatchRate),
    };
    const coreLoaded = Number.isFinite(orderCount) && Number.isFinite(orderCost) && Number.isFinite(watchConversionRate);
    const domReady = text.includes("GPM") || text.includes("千次观看成交金额") || text.includes("在线人数") || text.includes("曝光观看率") || text.includes("观看-成交率");
    return {
      ok: coreLoaded && domReady,
      metrics: Object.fromEntries(Object.entries(metrics).filter(([, value]) => Number.isFinite(value))),
      title: document.title,
      url: location.href,
      textSample: text.slice(0, 500),
      hints: ["成交订单数", "成交订单成本", "GPM", "千次观看成交金额", "观看成交率", "观看-成交率", "观看人数", "在线人数", "曝光观看率", "曝光-观看率"].filter((item) => text.includes(item)),
    };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.value || null;
}

async function waitForBoard(client, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  const expression = buildBoardExpression();
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    if (last?.ok) return last;
    await sleep(500);
  }
  return last || { ok: false, error: "board_timeout" };
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

async function runBoardCollector(options = {}) {
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const startedAt = Date.now();
  let client = null;
  try {
    const tab = await ensureBoardTab(cdpUrl, accountId);
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Runtime.enable").catch(() => null);
    await client.send("Page.enable").catch(() => null);
    await randomDelay();
    let page = await waitForBoard(client, 12000);
    let reloaded = false;
    if (!page?.ok) {
      reloaded = true;
      await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
      await sleep(1500);
      await randomDelay();
      page = await waitForBoard(client, 12000);
    }
    if (!page?.ok) {
      return {
        ok: false,
        status: "skipped",
        error: "board_timeout_after_reload",
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
      metrics: page.metrics || {},
      page: {
        title: page.title || tab.title || "",
        url: page.url || tab.url || "",
        hints: page.hints || [],
        textSample: cleanText(page.textSample || "").slice(0, 500),
      },
    };
  } catch (error) {
    return { ok: false, status: "error", error: error.message, startedAt, finishedAt: Date.now() };
  } finally {
    if (client) client.close();
  }
}

module.exports = { runBoardCollector };
