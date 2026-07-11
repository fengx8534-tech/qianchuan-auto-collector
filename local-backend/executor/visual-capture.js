const fs = require("fs");
const path = require("path");
const { DEFAULT_CDP_URL, listTabs, findQianchuanTab, connect, scoreQianchuanTab, openTab, switchToTodayDate } = require("./cdp-client");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function detectHints(text) {
  const names = ["整体成交订单数", "成交订单数", "整体成交订单成本", "订单成本", "素材", "追投", "调控", "一键起量", "控成本", "综合ROI"];
  return names.filter((name) => text.includes(name));
}

function num(value) {
  const parsed = parseFloat(String(value ?? "").replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function readNumberAfter(text, label, maxChars = 90) {
  const index = text.indexOf(label);
  if (index < 0) return null;
  const segment = text.slice(index + label.length, index + label.length + maxChars);
  const match = segment.match(/-?\d[\d,]*(?:\.\d+)?/);
  return match ? num(match[0]) : null;
}

function parseVisualMetrics(text) {
  const orderCount = readNumberAfter(text, "整体成交订单数") ?? readNumberAfter(text, "成交订单数");
  const orderCost = readNumberAfter(text, "整体成交订单成本") ?? readNumberAfter(text, "综合订单成本") ?? readNumberAfter(text, "订单成本");
  const overallCost = readNumberAfter(text, "综合成本");
  const overallRoi = readNumberAfter(text, "综合ROI");
  const dealAmount = readNumberAfter(text, "净成交金额", 120);
  const gpm = readNumberAfter(text, "GPM");
  const onlineCount = readNumberAfter(text, "实时在线人数");
  const totalViewers = readNumberAfter(text, "直播间整体观看人数") ?? readNumberAfter(text, "整体观看人数");
  const exposureWatchRate = readNumberAfter(text, "曝光观看率");
  const watchDealRate = readNumberAfter(text, "观看成交率") ?? readNumberAfter(text, "观看成交转化率");
  const metrics = {
    overallCost: money(overallCost),
    overallRoi: money(overallRoi),
    dealAmount: money(dealAmount),
    orderCount: Number.isFinite(orderCount) ? orderCount : null,
    orderCost: money(orderCost),
    gpm: money(gpm),
    onlineCount: Number.isFinite(onlineCount) ? Math.round(onlineCount) : null,
    totalViewers: Number.isFinite(totalViewers) ? Math.round(totalViewers) : null,
    exposureWatchRate: money(exposureWatchRate),
    watchDealRate: money(watchDealRate),
  };
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => Number.isFinite(value)));
}

function detectLiveStatus(text, metrics = {}, pageType = "") {
  const source = cleanText(text);
  const offAirPatterns = [
    /已下播/,
    /直播已结束/,
    /本场直播已结束/,
    /已结束\d*小时/,
    /已结束\d*分钟/,
    /已关播/,
    /下播/,
    /未开播/,
    /直播未开始/,
    /暂无直播/,
    /当前无直播/,
    /主播不在直播/,
  ];
  const livePatterns = [/直播中/, /实时在线人数/, /曝光观看率/, /直播间整体观看人数/, /GPM/];
  const matchedOffAir = offAirPatterns.find((pattern) => pattern.test(source));
  if (matchedOffAir) {
    return {
      status: "off_air",
      confidence: 0.95,
      reason: `页面出现下播文案：${matchedOffAir.source}`,
      pageType,
    };
  }
  if (Number(metrics.onlineCount) > 0) {
    return { status: "live", confidence: 0.9, reason: "实时在线人数大于 0", pageType };
  }
  if (pageType === "liveScreen" && Number(metrics.onlineCount) === 0 && livePatterns.some((pattern) => pattern.test(source))) {
    return { status: "suspected_off_air", confidence: 0.65, reason: "直播大屏在线人数为 0", pageType };
  }
  return { status: "unknown", confidence: 0, reason: "未识别到直播状态", pageType };
}

function summarizeLiveStatus(pages = []) {
  const signals = pages.map((page) => page.liveStatus).filter(Boolean);
  const off = signals.find((signal) => signal.status === "off_air");
  if (off) return { ...off, signals };
  const live = signals.find((signal) => signal.status === "live");
  if (live) return { ...live, signals };
  const suspected = signals.find((signal) => signal.status === "suspected_off_air");
  if (suspected) return { ...suspected, signals };
  return { status: "unknown", confidence: 0, reason: "未识别到直播状态", signals };
}

function classifyPage(page) {
  const url = String(page.url || "");
  const title = String(page.title || "");
  if (url.includes("/board-next") || title.includes("直播大屏")) return "liveScreen";
  if (url.includes("/uni-prom/overall")) return "investOverview";
  if (url.includes("/uni-prom/detail")) return "detail";
  return "qianchuan";
}

function classifyTabUrl(url) {
  const value = String(url || "");
  if (!value.includes("qianchuan.jinritemai.com")) return null;
  if (value.includes("/board-next")) return "liveScreen";
  if (value.includes("/uni-prom/overall")) return "investOverview";
  if (value.includes("/uni-prom/detail")) return "controlTable";
  return null;
}

function pickTabsByType(tabs = []) {
  const buckets = { liveScreen: [], investOverview: [], controlTable: [] };
  for (const tab of tabs) {
    if (tab.type !== "page") continue;
    const type = classifyTabUrl(tab.url);
    if (type && buckets[type]) buckets[type].push(tab);
  }
  const picked = {};
  for (const [type, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    list.sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a));
    picked[type] = list[0];
  }
  return picked;
}

function extractLiveContext(tabs = []) {
  for (const tab of tabs) {
    const url = String(tab.url || "");
    if (!url.includes("qianchuan.jinritemai.com")) continue;
    const rid = url.match(/live_room_id=(\d+)/);
    if (!rid) continue;
    const aid = url.match(/anchorId=(\d+)/);
    return { liveRoomId: rid[1], anchorId: aid ? aid[1] : null };
  }
  return null;
}

function summarizeTabs(tabs = []) {
  return tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com"))
    .map((tab) => ({
      title: tab.title || "",
      url: tab.url || "",
      score: scoreQianchuanTab(tab),
      preferred: false,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function buildPageProbeExpression() {
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
    const typeOf = (text) => {
      if (/一键调速|一键起量|起量/.test(text)) return "oneClickLift";
      if (/控成本|成本调控/.test(text)) return "materialCostControl";
      if (/画面追投|放量追投|素材追投|追投/.test(text)) return "materialBoost";
      return "";
    };
    const typeLabel = (type) => ({
      oneClickLift: "一键起量",
      materialCostControl: "素材控成本",
      materialBoost: "素材放量/追投",
    }[type] || "未知调控");
    const readCell = (cells, index) => clean(cells[index]?.innerText || cells[index]?.textContent || "");
    const parseTaskFromText = (text, cellTexts = []) => {
      text = clean(text);
      if (!/(调控中|已暂停|已结束|进行中|预算|ROI|追投|起量|控成本)/.test(text)) return null;
      // 排除操作日志行：含 "->"、"调控状态："、"操作内容：" 的是日志，不是任务
      if (/->|→|调控状态[：:]|操作内容[：:]/.test(text)) return null;
      if (/首页\\s*乘方|千川可用余额|千川日预算|授权待处理|计划ID[：:]?\\s*\\d{8,}|抖音号ID[：:]?\\s*\\d{8,}/.test(text) && !/^20\\d{6}_/.test(text)) return null;
      const idMatch = text.match(/(?:任务ID|ID)[：:]?\\s*(\\d{8,})/);
      const type = typeOf(text);
      const sourceCells = cellTexts.length ? cellTexts : text.split(/\\s+/);
      const numeric = sourceCells.map(num).filter((value) => Number.isFinite(value));
      const status = cellTexts.find((item) => /(调控中|调控结束|已暂停|已结束|进行中|审核|暂停)/.test(item)) || "";
      const boostMethod = cellTexts.find((item) => /(画面追投|放量追投|一键起量|控成本|成本调控|智能调速|搜索)/.test(item)) || typeLabel(type);
      const isLift = type === "oneClickLift";
      const isCompact = isLift || sourceCells.length <= 12;
      const task = {
        name: isCompact ? (cellTexts[0] || "") : (cellTexts[1] || cellTexts[0] || ""),
        taskId: idMatch?.[1] || "",
        object: isCompact ? (cellTexts[1] || "") : (cellTexts[2] || ""),
        status,
        budget: isCompact ? num(sourceCells[3]) : num(sourceCells[4]),
        targetRoi: isCompact ? null : num(sourceCells[5]),
        payRoi: isCompact ? null : num(sourceCells[6]),
        bid: isCompact ? null : num(sourceCells[7]),
        duration: isCompact ? (sourceCells[4] || "") : (sourceCells[8] || ""),
        boostMethod: isCompact ? (sourceCells[2] || boostMethod) : boostMethod,
        createTime: isCompact ? (sourceCells[5] || "") : (sourceCells[10] || ""),
        spend: isCompact ? num(sourceCells[6]) : num(sourceCells[11]),
        dealAmount: isCompact ? num(sourceCells[7]) : num(sourceCells[12]),
        roi: isCompact ? num(sourceCells[8]) : num(sourceCells[13]),
        impressions: isCompact ? num(sourceCells[9]) : num(sourceCells[14]),
        clicks: isCompact ? num(sourceCells[10]) : num(sourceCells[15]),
        type: typeLabel(type),
        taskType: type || "unknown",
        rawText: text.slice(0, 500),
        numericFallback: numeric.slice(0, 8),
      };
      if (isLift) {
        const liftMatch = text.match(/(.+?ID[：:]?\\s*\\d{8,})\\s+(调控中|调控结束[^\\d]*|已暂停|已结束|进行中)?\\s*一键起量\\s*(.*?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(.*?)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)/);
        if (liftMatch) {
          task.name = clean(liftMatch[1]);
          task.status = clean(liftMatch[2] || task.status);
          task.object = clean(liftMatch[3] || task.object);
          task.budget = num(liftMatch[4]);
          task.duration = clean(liftMatch[5] + " " + liftMatch[6]);
          task.createTime = clean(liftMatch[7]);
          task.spend = num(liftMatch[8]);
          task.dealAmount = num(liftMatch[9]);
          task.roi = num(liftMatch[10]);
          task.impressions = num(liftMatch[11]);
          task.clicks = num(liftMatch[12]);
          task.boostMethod = "一键起量";
        }
      }
      const materialMatch = text.match(/(.+?ID[：:]?\\s*\\d{8,})\\s+(.*?)\\s+(调控中(?:\\s*审核建议)?|调控结束|已暂停|已结束|进行中)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:-|\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:-|\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:-|\\d[\\d,]*(?:\\.\\d+)?)\\s+(.*?)\\s+(画面追投|放量追投|控成本追投|素材追投|控成本)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)/);
      if ((type === "materialBoost" || type === "materialCostControl") && materialMatch) {
        task.name = clean(materialMatch[1]);
        task.object = clean(materialMatch[2] || task.object);
        task.status = clean(materialMatch[3] || task.status);
        task.budget = num(materialMatch[4]);
        task.duration = clean(materialMatch[5] || task.duration);
        task.boostMethod = clean(materialMatch[6] || task.boostMethod);
        task.createTime = clean(materialMatch[7]);
        task.spend = num(materialMatch[8]);
        task.dealAmount = num(materialMatch[9]);
        task.roi = num(materialMatch[10]);
        task.impressions = num(materialMatch[11]);
        task.clicks = num(materialMatch[12]);
      }
      if (!task.taskId || !type) return null;
      // 再次确认：任务行的 ROI 必须是数字，操作日志行的 ROI 列通常是空/None
      if (!Number.isFinite(task.roi) && !Number.isFinite(task.spend)) return null;
      return task;
    };
    const rowTasks = Array.from(document.querySelectorAll("tr")).map((row) => {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 4) return null;
      const cellTexts = cells.map((cell) => clean(cell.innerText || cell.textContent || ""));
      return parseTaskFromText(clean(cellTexts.join(" ")), cellTexts);
    }).filter(Boolean);
    const textTasks = Array.from(document.querySelectorAll("div,section,article,li,[role='row'],[role='listitem']"))
      .map((el) => clean(el.innerText || el.textContent || ""))
      .filter((text) => text
        && text.length >= 60
        && text.length <= 900
        && /(?:任务ID|ID)[：:]?\\s*\\d{8,}/.test(text)
        && /(一键起量|一键调速|素材追投|放量追投|画面追投|控成本追投)/.test(text)
        && !(/首页\\s*乘方|千川可用余额|千川日预算|授权待处理|计划ID[：:]?\\s*\\d{8,}|抖音号ID[：:]?\\s*\\d{8,}/.test(text) && !/^20\\d{6}_/.test(text)))
      .map((text) => parseTaskFromText(text))
      .filter(Boolean);

    const unique = [];
    const seen = new Set();
    [...rowTasks, ...textTasks].forEach((task) => {
      const key = task.taskId || task.name + task.rawText.slice(0, 40);
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(task);
    });

    const cellSelector = "th,td,[role='columnheader'],[role='cell'],.arco-table-th,.arco-table-td,.semi-table-cell,.byted-table-cell";
    const rowSelector = "tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row";
    const cellsOf = (row) => {
      const cells = Array.from(row.querySelectorAll(cellSelector));
      return cells
        .filter((cell) => !cells.some((other) => other !== cell && other.contains(cell)))
        .map((cell) => clean(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
    };
    const baseSpendLabelScore = (label) => {
      const value = clean(label).replace(/\\s+/g, "");
      if (!value) return 0;
      if (/整体|综合|追投|调控|成交|订单|成本|ROI|GPM|预算/.test(value)) return 0;
      if (value === "基础消耗") return 100;
      if (value.includes("基础消耗")) return 90;
      if (value === "消耗") return 70;
      if (/^消耗\\(.*\\)$/.test(value)) return 65;
      return 0;
    };
    const extractPlanBaseSpend = () => {
      const inlineBodies = Array.from(document.querySelectorAll(".ovui-table__body-wrapper,.ovui-table__body,[class*='table__body'],[class*='table-body'],[class*='body-wrapper']"));
      for (const body of inlineBodies) {
        const bodyText = clean(body.innerText || body.textContent || "");
        if (!/基础/.test(bodyText) || !/投放中|直播大屏|乘方投放|综合ROI|整体消耗/.test(bodyText)) continue;
        const match = bodyText.match(/(?:^|\\s)基础\\s+(-?\\d[\\d,]*(?:\\.\\d+)?)(?=\\s|$)/);
        const value = money(num(match?.[1]));
        if (Number.isFinite(value) && value > 0) {
          return {
            baseSpend: value,
            baseSpendSource: "plan_table_dom",
            baseSpendRows: 1,
            baseSpendColumn: "基础",
            rowSamples: [{ value, text: bodyText.slice(0, 180), cellText: match[1] }],
            headers: [],
          };
        }
      }
      const rows = Array.from(document.querySelectorAll(rowSelector));
      const candidates = [];
      rows.forEach((row, rowIndex) => {
        const cells = cellsOf(row);
        cells.forEach((label, cellIndex) => {
          const score = baseSpendLabelScore(label);
          if (score > 0) candidates.push({ rowIndex, cellIndex, score, label, headers: cells.slice(0, 24) });
        });
      });
      candidates.sort((a, b) => b.score - a.score);
      for (const candidate of candidates.slice(0, 4)) {
        const values = [];
        const totals = [];
        for (let index = candidate.rowIndex + 1; index < rows.length; index += 1) {
          const cells = cellsOf(rows[index]);
          if (cells.length <= candidate.cellIndex) continue;
          const rowText = clean(cells.join(" "));
          if (!rowText || /基础消耗|^消耗$|计划名称|投放内容|广告组|操作/.test(rowText)) continue;
          const value = money(num(cells[candidate.cellIndex]));
          if (!Number.isFinite(value) || value <= 0) continue;
          const item = {
            value,
            text: rowText.slice(0, 160),
            cellText: cells[candidate.cellIndex],
          };
          if (/合计|总计|汇总/.test(rowText)) totals.push(item);
          else values.push(item);
        }
        const chosenRows = totals.length ? totals.slice(0, 1) : values.slice(0, 80);
        const total = totals.length
          ? totals[0].value
          : money(chosenRows.reduce((sum, item) => sum + item.value, 0));
        if (Number.isFinite(total) && total > 0) {
          return {
            baseSpend: total,
            baseSpendSource: "plan_table_dom",
            baseSpendRows: chosenRows.length,
            baseSpendColumn: candidate.label,
            rowSamples: chosenRows.slice(0, 3),
            headers: candidate.headers,
          };
        }
      }
      return {};
    };
    const planMetrics = extractPlanBaseSpend();

    return {
      title: document.title,
      url: location.href,
      text: document.body?.innerText || "",
      tasks: unique.slice(0, 80),
      planMetrics,
    };
  })()`;
}

function buildInvestOverviewPrepareExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const touched = [];
    const candidates = Array.from(document.querySelectorAll("button,div,span,a,h1,h2,h3"))
      .filter((el) => /计划|投放列表|广告列表|基础消耗/.test(clean(el.innerText || el.textContent || "")));
    const target = candidates.find((el) => /计划|投放列表|广告列表/.test(clean(el.innerText || el.textContent || "")));
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
      touched.push({
        tag: el.tagName,
        className: String(el.className || "").slice(0, 80),
        before,
        after: el.scrollTop,
        max,
        reason: "vertical",
      });
    });

    const horizontalContainers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el && el.scrollWidth > el.clientWidth + 80 && el.clientWidth > 120);
    horizontalContainers.forEach((el) => {
      const before = el.scrollLeft || 0;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      if (max <= 0) return;
      el.scrollLeft = max;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({
        tag: el.tagName,
        className: String(el.className || "").slice(0, 80),
        before,
        after: el.scrollLeft || max,
        max,
        reason: "horizontal",
      });
    });
    return { touched: touched.slice(0, 20) };
  })()`;
}

async function prepareTabForPageType(client, pageType) {
  if (pageType !== "investOverview") return;
  for (let i = 0; i < 2; i += 1) {
    try {
      await client.send("Runtime.evaluate", {
        expression: buildInvestOverviewPrepareExpression(),
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
    } catch {
      return;
    }
  }
}

async function autoNavigate(client, targetUrl, options = {}) {
  const timeout = options.timeout || 8000;
  await client.send("Page.navigate", { url: targetUrl });
  await new Promise((resolve) => setTimeout(resolve, timeout));
}

async function waitForControlTableReady(client, timeout = 18000) {
  const started = Date.now();
  let lastText = "";
  while (Date.now() - started < timeout) {
    try {
      const result = await client.send("Runtime.evaluate", {
        expression: `(() => String(document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 500))()`,
        returnByValue: true,
      });
      lastText = cleanText(result.result?.value || "");
      const hasTaskCenterSignal = /任务中心|任务名称|任务ID|素材追投|放量追投|画面追投|一键起量|控成本|调控/.test(lastText);
      const stillLoading = /抖音号[：:]\\s*加载中|加载中\\.\\.\\.|加载中/.test(lastText) && !hasTaskCenterSignal;
      if (hasTaskCenterSignal && !stillLoading) return { ready: true, waitedMs: Date.now() - started, lastText };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return { ready: false, waitedMs: Date.now() - started, lastText };
}

async function waitForPageTypeReady(client, pageType) {
  if (pageType !== "controlTable") return null;
  return waitForControlTableReady(client);
}

function buildTaskRoutePrepareExpression(route) {
  const wanted = route === "oneClickLift"
    ? ["一键起量", "一键调速"]
    : route === "materialBoost"
      ? ["素材追投", "放量追投", "画面追投"]
      : [];
  const avoid = route === "oneClickLift"
    ? ["素材追投", "放量追投", "画面追投"]
    : route === "materialBoost"
      ? ["一键起量", "一键调速"]
      : [];
  const pattern = wanted.join("|");
  if (!pattern) return "";
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const pattern = new RegExp(${JSON.stringify(pattern)});
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
    const activeOf = (el) => {
      const node = clickableOf(el);
      const className = String(node.className || "") + " " + String(el.className || "");
      return /active|selected|checked|current/.test(className) || node.getAttribute("aria-selected") === "true";
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .filter((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (!text || text.length > 48 || !pattern.test(text)) return false;
        if (avoid.some((item) => text.includes(item))) return false;
        if (!isVisible(el)) return false;
        return true;
      })
      .map((el) => {
        const node = clickableOf(el);
        const text = clean(el.innerText || el.textContent || "");
        const nodeText = clean(node.innerText || node.textContent || text);
        const rect = node.getBoundingClientRect();
        const className = String(node.className || "") + " " + String(el.className || "");
        let score = 0;
        if (node.getAttribute("role") === "tab") score += 70;
        if (node.tagName === "BUTTON") score += 55;
        if (/tabs|tab|segmented|radio|filter|筛选|类型|ovui-radio|oc-radio/.test(className)) score += 45;
        if (wanted.some((item) => nodeText === item)) score += 140;
        else if (wanted.some((item) => nodeText.startsWith(item + " "))) score += 80;
        if (avoid.some((item) => nodeText.includes(item))) score -= 160;
        if (activeOf(el)) score += 25;
        if (rect.top >= 0 && rect.top < Math.max(window.innerHeight, 900)) score += 15;
        if (node.closest("tr,tbody,table")) score -= 120;
        if (/ID[：:]?\\s*\\d{8,}|预算|ROI|消耗|成交/.test(nodeText)) score -= 100;
        if (nodeText.length > 24) score -= 30;
        return { el: node, text: nodeText.slice(0, 80), score, top: Math.round(rect.top) };
      })
      .sort((a, b) => b.score - a.score);
    const target = candidates[0]?.el;
    if (!target) return { clicked: false, reason: "tab_not_found" };
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return {
      clicked: true,
      route: ${JSON.stringify(route)},
      text: candidates[0].text,
      score: candidates[0].score,
      top: candidates[0].top,
      candidates: candidates.slice(0, 5).map((item) => ({ text: item.text, score: item.score, top: item.top })),
    };
  })()`;
}

async function prepareTabForTaskRoute(client, route) {
  const expression = buildTaskRoutePrepareExpression(route);
  if (!expression) return null;
  try {
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    const value = result.result?.value || null;
    if (value?.clicked) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await waitForControlTableReady(client, 8000);
    }
    return value;
  } catch {
    return null;
  }
}

async function probeTab(tab) {
  const client = connect(tab.webSocketDebuggerUrl);
  try {
    const result = await client.send("Runtime.evaluate", {
      expression: buildPageProbeExpression(),
      returnByValue: true,
    });
    const page = result.result?.value || {};
    return {
      title: page.title || tab.title || "",
      url: page.url || tab.url || "",
      text: cleanText(page.text || ""),
      tasks: Array.isArray(page.tasks) ? page.tasks : [],
    };
  } finally {
    client.close();
  }
}

async function scanTaskTabs(tabs = []) {
  const qianchuanTabs = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com"))
    .sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a))
    .slice(0, 8);
  const pages = [];
  for (const tabItem of qianchuanTabs) {
    try {
      const page = await probeTab(tabItem);
      const pageType = classifyPage(page);
      const taskHints = detectHints(page.text).filter((hint) => ["素材", "追投", "调控", "一键起量", "控成本"].includes(hint));
      const shouldKeepTasks = pageType === "detail";
      pages.push({
        title: page.title,
        url: page.url,
        pageType,
        hints: taskHints,
        tasks: (shouldKeepTasks ? page.tasks : []).map((task) => ({
          ...task,
          sourceTitle: page.title,
          sourceUrl: page.url,
          sourcePageType: pageType,
        })),
      });
    } catch (error) {
      pages.push({ title: tabItem.title || "", url: tabItem.url || "", error: error.message, tasks: [] });
    }
  }
  const tasks = pages.flatMap((page) => page.tasks || []);
  return { capturedAt: Date.now(), pages, tasks };
}

function buildTaskCenterUrl(accountId) {
  const detail = encodeURIComponent(JSON.stringify({ tb: "uni_task_center" }));
  return `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${encodeURIComponent(accountId)}&uniDetail=%7B%7D#uniDetail=${detail}`;
}

function hasNonEmptyParam(url, key) {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.searchParams.get(key));
  } catch {
    return false;
  }
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
    if (!detail.cc) {
      detail.cc = JSON.stringify({ sk: "", ccft: "0", p: "1", ps: "10", st: "asc", sf: "" });
    }
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
      if (hasNonEmptyParam(url, "adId")) score += 60;
      if (url.includes("uAId%5C%22%3A%5C%22") || url.includes('"uAId"')) score += 40;
      if (url.includes("tb%22%3A%22data") || url.includes("tb%22%3A%22creative")) score += 20;
      return { url, score };
    })
    .sort((a, b) => b.score - a.score);
  for (const item of detailTabs) {
    const url = taskCenterUrlFromSource(item.url, accountId);
    if (url) return url;
  }
  return buildTaskCenterUrl(accountId);
}

function taskTypeForRoute(route) {
  if (route === "materialBoost") return "materialBoost";
  if (route === "oneClickLift") return "oneClickLift";
  return "";
}

function filterTasksForRoute(tasks = [], route = "control") {
  const taskType = taskTypeForRoute(route);
  if (route === "materialBoost") return tasks.filter((task) => ["materialBoost", "materialCostControl"].includes(task.taskType));
  return taskType ? tasks.filter((task) => task.taskType === taskType) : tasks;
}

function dedupeTasksById(tasks = []) {
  const result = [];
  const indexByKey = new Map();
  for (const task of tasks) {
    const key = task.taskId || task.id || `${task.name || ""}:${task.rawText || ""}`.slice(0, 120);
    if (!key) {
      result.push(task);
      continue;
    }
    if (!indexByKey.has(key)) {
      indexByKey.set(key, result.length);
      result.push(task);
      continue;
    }
    const index = indexByKey.get(key);
    const existing = result[index] || {};
    const existingSpend = Number(existing.spend);
    const nextSpend = Number(task.spend);
    if (Number.isFinite(nextSpend) && (!Number.isFinite(existingSpend) || nextSpend > existingSpend)) {
      result[index] = task;
    }
  }
  return result;
}

function buildAutoCollectTargets(accountId, liveContext = null, route = "overall", tabs = []) {
  const targets = [];
  if (route === "overall") {
    targets.push({
      pageType: "investOverview",
      label: "投放管理总览",
      url: `https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${encodeURIComponent(accountId)}`,
    });
  }
  if (["control", "materialBoost", "oneClickLift"].includes(route)) {
    targets.push({
      pageType: "controlTable",
      label: route === "materialBoost" ? "素材追投任务" : route === "oneClickLift" ? "一键起量任务" : "任务中心",
      url: buildTaskCenterUrlFromTabs(accountId, tabs),
      route,
    });
  }
  // 直播大屏永远在 targets 里，复用逻辑决定实际采集；
  // 只有走兜底导航时需要 liveRoomId（anchorId 可选，千川对空 anchorId 兼容）
  const liveTarget = {
    pageType: "liveScreen",
    label: "直播大屏",
    url: null,
  };
  if (liveContext && liveContext.liveRoomId) {
    const params = new URLSearchParams({
      live_room_id: liveContext.liveRoomId,
      aavid: accountId,
      fromModule: "uni_promotion_v2",
    });
    if (liveContext.anchorId) params.set("anchorId", liveContext.anchorId);
    liveTarget.url = `https://qianchuan.jinritemai.com/board-next?${params.toString()}`;
  }
  if (route === "overall") targets.push(liveTarget);
  return targets;
}

function parseOverviewMetrics(text, page = {}) {
  const planBaseSpend = money(num(page.planMetrics?.baseSpend));
  return Object.fromEntries(Object.entries({
    ...parseVisualMetrics(text),
    baseSpend: Number.isFinite(planBaseSpend) ? planBaseSpend : money(readNumberAfter(text, "基础消耗")),
    baseSpendRows: num(page.planMetrics?.baseSpendRows),
    baseSpendSource: page.planMetrics?.baseSpendSource || undefined,
    hourCost: money(readNumberAfter(text, "小时消耗") ?? readNumberAfter(text, "近1小时消耗")),
    hourRoi: money(readNumberAfter(text, "小时ROI") ?? readNumberAfter(text, "近1小时ROI")),
  }).filter(([, value]) => Number.isFinite(value) || (typeof value === "string" && value)));
}

function buildOpenHourlyDetailExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const isBlueish = (el) => {
      const color = getComputedStyle(el).color || "";
      const match = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (!match) return false;
      const [, r, g, b] = match.map(Number);
      return b > r + 20 || g > r + 20;
    };
    window.scrollTo(0, 0);
    const candidates = Array.from(document.querySelectorAll("a,button,[role='button'],span,div"))
      .filter((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (!text || text.length > 80) return false;
        if (!/直播间|直播大屏|修改直播规划|查看数据|数据详情|详情/.test(text)) return false;
        if (/所选周期|预估|减免|电商技术服务费|产品手册|投放锦囊|乘方掌量建议|了解详情|新建|创建|刷新|复制|帮助|设置|筛选/.test(text)) return false;
        if (!/^(直播大屏|修改直播规划)$/.test(text) && /素材|每日预算|综合ROI|投放中|投放状态|营销服务|调控工具/.test(text)) return false;
        if (!/^(直播大屏|修改直播规划)$/.test(text) && text.length > 36) return false;
        if (!visible(el)) return false;
        return true;
      })
      .map((el) => {
        const text = clean(el.innerText || el.textContent || "");
        let score = 0;
        if (/^直播大屏$/.test(text)) score += 220;
        if (/^修改直播规划$/.test(text)) score += 210;
        else if (/直播大屏/.test(text)) score += 90;
        if (/修改直播规划/.test(text)) score += 120;
        if (/直播间/.test(text)) score += 80;
        if (/详情|查看数据|数据详情/.test(text)) score += 25;
        if (el.tagName === "A") score += 30;
        if (el.tagName === "BUTTON") score += 12;
        if (isBlueish(el)) score += 35;
        if (el.closest("tr")) score += 35;
        if (clean(el.closest("tr")?.innerText || "").includes("投放中")) score += 20;
        if (text.length > 24) score -= 80;
        const rect = el.getBoundingClientRect();
        score += Math.max(0, 20 - Math.abs(rect.top - window.innerHeight / 2) / 50);
        return { el, text, score, href: el.href || el.closest("a")?.href || "" };
      })
      .sort((a, b) => b.score - a.score);
    const chosen = candidates[0];
    if (!chosen) {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight || document.body.scrollHeight || 0) * 0.65));
      return { clicked: false, reason: "live_room_link_not_found", sample: clean(document.body?.innerText || "").slice(0, 240) };
    }
    chosen.el.scrollIntoView({ block: "center", inline: "center" });
    if (chosen.href && chosen.href.includes("qianchuan.jinritemai.com")) {
      location.href = chosen.href;
    } else {
      chosen.el.click();
    }
    return { clicked: true, text: chosen.text, score: chosen.score, href: chosen.href || null };
  })()`;
}

function buildHourlyScrollExpression() {
  return `(() => {
    const touched = [];
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    window.scrollTo(0, Math.max(window.scrollY || 0, Math.round((document.documentElement.scrollHeight || document.body.scrollHeight || 0) * 0.62)));
    touched.push({ tag: "WINDOW", top: window.scrollY || 0 });
    const containers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el && el.scrollHeight > el.clientHeight + 160 && el.clientHeight > 220)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
      .slice(0, 10);
    containers.forEach((el) => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (!max) return;
      const text = clean(el.innerText || el.textContent || "");
      const isHourlyTable = /时间/.test(text) && /综合ROI|ROI/.test(text) && /整体消耗|综合成本|消耗/.test(text);
      el.scrollTop = isHourlyTable ? 0 : Math.max(el.scrollTop || 0, Math.round(max * 0.7));
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ tag: el.tagName, className: String(el.className || "").slice(0, 80), top: el.scrollTop, max, hourlyTable: isHourlyTable });
    });
    return { touched };
  })()`;
}

function buildSetHourlyTableScrollFractionExpression(fraction) {
  const safeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
  return `(() => {
    const fraction = ${safeFraction};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const touched = [];
    const containers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 120)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
      .slice(0, 16);
    containers.forEach((el) => {
      const text = clean(el.innerText || el.textContent || "");
      const isHourlyTable = /时间/.test(text) && /综合ROI|ROI/.test(text) && /整体消耗|综合成本|消耗/.test(text);
      if (!isHourlyTable) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.round(max * fraction);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ tag: el.tagName, className: String(el.className || "").slice(0, 80), top: el.scrollTop, max, fraction });
    });
    return { touched };
  })()`;
}

function buildSortHourlyByTimeExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = Array.from(document.querySelectorAll("th,[role='columnheader'],.arco-table-th,.semi-table-cell,.byted-table-cell,.byte-table-cell,span,div"))
      .map((el) => ({ el, text: clean(el.innerText || el.textContent || "") }))
      .filter((item) => item.text === "时间" && visible(item.el))
      .map((item) => {
        const header = item.el.closest("th,[role='columnheader'],.arco-table-th,.semi-table-cell,.byted-table-cell,.byte-table-cell") || item.el;
        const tableText = clean(header.closest("table,[role='table'],[role='grid'],.arco-table,.semi-table,.byted-table,.byte-table,.oc-table")?.innerText || header.parentElement?.innerText || "");
        let score = 0;
        if (/综合ROI|ROI/.test(tableText)) score += 50;
        if (/整体消耗|综合成本|消耗/.test(tableText)) score += 50;
        const rect = header.getBoundingClientRect();
        score += Math.max(0, 40 - Math.abs(rect.top - window.innerHeight / 2) / 10);
        return { el: header, score, text: item.text };
      })
      .sort((a, b) => b.score - a.score);
    const chosen = candidates[0];
    if (!chosen) return { clicked: false, reason: "time_header_not_found" };
    chosen.el.scrollIntoView({ block: "center", inline: "nearest" });
    chosen.el.click();
    return { clicked: true, score: chosen.score };
  })()`;
}

function buildEnsureHourlyDetailDataExpression() {
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
    const detailAnchor = Array.from(document.querySelectorAll("button,[role='button'],a,span,div,h2,h3"))
      .find((el) => /详细数据/.test(clean(el.innerText || el.textContent || "")) && visible(el));
    if (detailAnchor) {
      detailAnchor.scrollIntoView({ block: "center", inline: "nearest" });
      clicked.push("详细数据");
    } else {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight || document.body.scrollHeight || 0) * 0.72));
    }
    result.finalUrl = location.href;
    return result;
  })()`;
}

function buildSetHourlyBaseOnlyExpression(enabled, clickIfNeeded = true) {
  return `(() => {
    const want = ${enabled ? "true" : "false"};
    const clickIfNeeded = ${clickIfNeeded ? "true" : "false"};
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
      const pressed = candidate?.getAttribute?.("aria-pressed");
      if (pressed === "true") return true;
      if (pressed === "false") return false;
      const cls = String(candidate?.className || "");
      if (/checked|selected|active/.test(cls) && !/uncheck|unchecked/.test(cls)) return true;
      return null;
    };
    const switchSelector = "input[type='checkbox'],[role='checkbox'],[role='switch'],button[class*='switch'],span[class*='switch'],div[class*='switch'],.arco-switch,.semi-switch";
    const findSwitch = (el) => {
      const containers = [
        el,
        el.closest?.("label"),
        el.closest?.("button,[role='switch'],[role='checkbox']"),
        el.parentElement,
        el.parentElement?.parentElement,
        el.parentElement?.parentElement?.parentElement,
      ].filter(Boolean);
      for (const container of containers) {
        if (container.matches?.(switchSelector)) return container;
        const found = container.querySelector?.(switchSelector);
        if (found) return found;
      }
      return null;
    };
    const candidates = Array.from(document.querySelectorAll("label,span,div,input,button,[role='checkbox'],[role='switch']"))
      .map((el) => {
        const text = clean(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "");
        if (!/只看基础数据/.test(text)) return null;
        const foundSwitch = findSwitch(el);
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (text === "只看基础数据") score += 100;
        if (text.length <= 12) score += 60;
        if (el.matches?.("label,button,[role='switch'],[role='checkbox']")) score += 35;
        if (foundSwitch) score += 80;
        if (visible(el)) score += 20;
        if (text.length > 40) score -= 80;
        score -= Math.abs(rect.top - window.innerHeight / 2) / 80;
        return { el, text, foundSwitch, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    const label = candidates[0];
    if (!label) return { ok: false, wanted: want, reason: "base_only_toggle_not_found" };
    const container = label.el.closest("label") || label.el.parentElement || label.el;
    const checkbox = label.foundSwitch || container.querySelector?.(switchSelector) || label.el;
    const checked = isChecked(checkbox);
    if (checked === want) return { ok: true, wanted: want, checked, clicked: false };
    if (checked === null) return { ok: false, wanted: want, checked, clicked: false, reason: "base_only_state_unknown" };
    if (!clickIfNeeded) return { ok: false, wanted: want, checked, clicked: false, reason: "base_only_state_mismatch" };
    const target = checkbox || label.el;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.click();
    return {
      ok: true,
      wanted: want,
      checked,
      clicked: true,
      labelText: label.text,
      targetTag: target.tagName || null,
      targetClass: String(target.className || "").slice(0, 80),
    };
  })()`;
}

async function setHourlyBaseOnly(client, enabled, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const settleMs = Math.max(300, Number(options.settleMs) || 1800);
  const history = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const setResponse = await client.send("Runtime.evaluate", {
      expression: buildSetHourlyBaseOnlyExpression(enabled),
      returnByValue: true,
    }).catch((error) => ({ result: { value: { ok: false, reason: error.message } } }));
    const setResult = setResponse.result?.value || { ok: false, reason: "base_only_toggle_empty_result" };
    await new Promise((resolve) => setTimeout(resolve, setResult.clicked ? settleMs : 500));
    const verifyResponse = await client.send("Runtime.evaluate", {
      expression: buildSetHourlyBaseOnlyExpression(enabled, false),
      returnByValue: true,
    }).catch((error) => ({ result: { value: { ok: false, reason: error.message } } }));
    const verifyResult = verifyResponse.result?.value || { ok: false, reason: "base_only_verify_empty_result" };
    history.push({ attempt, set: setResult, verify: verifyResult });
    if (verifyResult.ok && verifyResult.checked === enabled) {
      return { ...verifyResult, clicked: Boolean(setResult.clicked), attempts: history };
    }
    await client.send("Runtime.evaluate", {
      expression: buildEnsureHourlyDetailDataExpression(),
      returnByValue: true,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const last = history.at(-1) || {};
  return {
    ok: false,
    wanted: enabled,
    clicked: false,
    reason: last.verify?.reason || last.set?.reason || "base_only_toggle_retry_exhausted",
    attempts: history,
  };
}

function buildHourlyBreakdownExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const num = (value) => {
      const raw = String(value || "").replaceAll(",", "");
      const match = raw.match(/-?\\d+(?:\\.\\d+)?/);
      if (!match) return null;
      const parsed = parseFloat(match[0]);
      if (!Number.isFinite(parsed)) return null;
      const unitText = raw.slice(match.index, match.index + match[0].length + 4);
      return /万/.test(unitText) ? Math.round(parsed * 10000 * 100) / 100 : parsed;
    };
    const money = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const cellSelector = "th,td,[role='columnheader'],[role='cell'],.arco-table-th,.arco-table-td,.semi-table-cell,.byted-table-cell,.byte-table-cell,.oc-table-cell";
    const rowSelector = "tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row,.byte-table-row,.oc-table-row";
    const tableSelector = "table,[role='table'],[role='grid'],.arco-table,.semi-table,.byted-table,.byte-table,.oc-table";
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const cellsOf = (row) => Array.from(row.querySelectorAll(cellSelector))
      .filter((cell, index, cells) => !cells.some((other, otherIndex) => otherIndex !== index && other.contains(cell)))
      .map((cell) => clean(cell.innerText || cell.textContent || ""))
      .filter(Boolean);
    const normalizeHeader = (text) => {
      const value = clean(text);
      if (/^(时间|时段)$/.test(value) || /^(单小时|小时段)/.test(value)) return "time";
      if (/ROI|roi/.test(value)) return "roi";
      if (/投放类型/.test(value)) return "type";
      if (/消耗|花费|成本\\(元\\)|费用/.test(value) && !/订单|成交|转化/.test(value)) return "cost";
      if (/成交金额|成交GMV|支付金额|净成交金额|成交额/.test(value)) return "dealAmount";
      if (/成交订单|订单数|支付订单|转化数|成交数/.test(value)) return "orders";
      if (/订单成本|转化成本|成交成本/.test(value)) return "orderCost";
      if (/点击|观看|曝光/.test(value)) return "traffic";
      return "";
    };
    const timeLike = (text) => /(?:20\\d{2}-\\d{2}-\\d{2}\\s+\\d{1,2}:\\d{2})|(?:\\d{1,2}:\\d{2}\\s*[-~—至]\\s*\\d{1,2}:\\d{2})|(?:\\d{1,2}\\s*[点时]\\s*[-~—至]\\s*\\d{1,2}\\s*[点时])|(?:\\d{1,2}:00)/.test(text);
    const rowFromCells = (cells, keys) => {
      const item = {};
      keys.forEach((key, cellIndex) => {
        if (!key || cellIndex >= cells.length) return;
        if (key === "time") item.time = cells[cellIndex];
        else if (key === "type") item.type = cells[cellIndex];
        else if (!Number.isFinite(item[key])) item[key] = money(num(cells[cellIndex]));
      });
      if (!item.time || !timeLike(item.time)) item.time = cells.find(timeLike) || item.time || "";
      if (!Number.isFinite(item.cost) && cells.length >= 2) {
        const values = cells.map(num).filter((value) => Number.isFinite(value));
        item.cost = money(values.find((value) => value > 0));
        item.roi = money(values.find((value) => value >= 0 && value <= 100 && value !== item.cost));
      }
      if (item.time && (Number.isFinite(item.cost) || Number.isFinite(item.roi) || Number.isFinite(item.dealAmount))) {
        item.raw = clean(cells.join(" ")).slice(0, 220);
        return item;
      }
      return null;
    };
    const collectFlatCells = (root) => {
      const direct = Array.from(root.querySelectorAll(cellSelector))
        .filter((cell, index, cells) => visible(cell) && !cells.some((other, otherIndex) => otherIndex !== index && other.contains(cell)))
        .map((cell) => clean(cell.innerText || cell.textContent || ""))
        .filter(Boolean);
      if (direct.length >= 12) return direct;
      return Array.from(root.querySelectorAll("*"))
        .filter((el) => visible(el) && !Array.from(el.children || []).some((child) => clean(child.innerText || child.textContent || "")))
        .map((el) => clean(el.innerText || el.textContent || ""))
        .filter((text) => text && text.length <= 80);
    };
    const flatRowsFromTable = (root, headers) => {
      if (!root || !headers?.length) return [];
      const keys = headers.map(normalizeHeader);
      if (!keys.includes("time") || !keys.includes("roi") || !keys.includes("cost")) return [];
      const all = collectFlatCells(root);
      if (all.length < headers.length + 4) return [];
      let cursor = -1;
      const headerPositions = headers.map((headerText) => {
        const found = all.findIndex((text, index) => index > cursor && clean(text) === clean(headerText));
        if (found >= 0) cursor = found;
        return found;
      }).filter((index) => index >= 0);
      const start = headerPositions.length ? Math.max(...headerPositions) + 1 : all.findIndex(timeLike);
      let data = all.slice(Math.max(0, start)).filter((text) => !headers.some((headerText) => clean(headerText) === clean(text)));
      const firstTime = data.findIndex(timeLike);
      if (firstTime > 0) data = data.slice(firstTime);
      if (data.length < 4 || !timeLike(data[0])) return [];
      const parsed = [];
      if (timeLike(data[1] || "")) {
        let rowCount = 0;
        while (rowCount < data.length && timeLike(data[rowCount])) rowCount += 1;
        if (rowCount < 1) return [];
        for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
          const cells = keys.map((_, colIndex) => data[colIndex * rowCount + rowIndex] || "");
          const item = rowFromCells(cells, keys);
          if (item) parsed.push(item);
        }
      } else {
        const columnCount = keys.length;
        for (let offset = 0; offset + columnCount <= data.length; offset += columnCount) {
          const item = rowFromCells(data.slice(offset, offset + columnCount), keys);
          if (item) parsed.push(item);
        }
      }
      return parsed;
    };
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const headerCandidates = rows.map((row, index) => ({ index, cells: cellsOf(row) }))
      .filter((item) => item.cells.length >= 3)
      .map((item) => ({ ...item, keys: item.cells.map(normalizeHeader) }))
      .filter((item) => item.keys.includes("time") && item.keys.includes("roi") && item.keys.includes("cost"));
    const header = headerCandidates[0] || null;
    const hourlyRows = [];
    if (header) {
      for (let index = header.index + 1; index < rows.length; index += 1) {
        const cells = cellsOf(rows[index]);
        if (cells.length < 3) continue;
        const allText = clean(cells.join(" "));
        if (!timeLike(allText)) continue;
        const item = rowFromCells(cells, header.keys);
        if (item) hourlyRows.push(item);
      }
      if (!hourlyRows.length) {
        const root = rows[header.index]?.closest(tableSelector) || rows[header.index]?.parentElement || document.body;
        hourlyRows.push(...flatRowsFromTable(root, header.cells));
      }
    }
    if (!hourlyRows.length) {
      const text = clean(document.body?.innerText || "");
      const matches = text.match(/\\d{1,2}:\\d{2}\\s*[-~—至]\\s*\\d{1,2}:\\d{2}[^\\n]{0,160}/g) || [];
      matches.slice(0, 36).forEach((line) => {
        const values = line.match(/-?\\d[\\d,]*(?:\\.\\d+)?%?/g) || [];
        const time = line.match(/\\d{1,2}:\\d{2}\\s*[-~—至]\\s*\\d{1,2}:\\d{2}/)?.[0] || "";
        const nums = values.map(num).filter((value) => Number.isFinite(value));
        if (time && nums.length >= 2) hourlyRows.push({ time, cost: money(nums[2] ?? nums[0]), roi: money(nums.find((value) => value >= 0 && value <= 100)), raw: line });
      });
    }
    const unique = [];
    const seen = new Set();
    hourlyRows.forEach((row) => {
      const key = clean(row.time || row.raw || "");
      if (!key || seen.has(key)) return;
      seen.add(key);
      unique.push(row);
    });
    return {
      title: document.title,
      url: location.href,
      text: document.body?.innerText || "",
      hourlyRows: unique.slice(0, 36),
      headers: header?.cells || [],
    };
  })()`;
}

function currentHourlyRow(rows = [], date = new Date()) {
  const minutesNow = date.getHours() * 60 + date.getMinutes();
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const currentHour = date.getHours();
  for (const row of rows) {
    const text = String(row.time || row.raw || "");
    const matched = text.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
    if (!matched) continue;
    if (matched[1] === dateKey && Number(matched[2]) === currentHour) return row;
  }
  for (const row of rows) {
    const text = String(row.time || row.raw || "");
    const matched = text.match(/^(\d{1,2}):00\b/);
    if (!matched) continue;
    if (Number(matched[1]) === currentHour) return row;
  }
  for (const row of rows) {
    const text = String(row.time || row.raw || "");
    const matches = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?/g)];
    if (matches.length < 2) continue;
    let start = Number(matches[0][1]) * 60 + Number(matches[0][2] || 0);
    let end = Number(matches[1][1]) * 60 + Number(matches[1][2] || 0);
    if (end <= start) end += 24 * 60;
    let now = minutesNow;
    if (now < start && end > 24 * 60) now += 24 * 60;
    if (now >= start && now < end) return row;
  }
  return null;
}

function hourlyRowKey(row, date = new Date()) {
  const text = String(row?.time || row?.raw || "").trim();
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const full = text.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
  if (full) return `${full[1]} ${String(Number(full[2])).padStart(2, "0")}:00`;
  const hour = text.match(/^(\d{1,2})(?::00)?\b/);
  if (hour) return `${dateKey} ${String(Number(hour[1])).padStart(2, "0")}:00`;
  return text;
}

function mergeHourlyBaseRows(rows = [], baseRows = [], date = new Date()) {
  const baseByKey = new Map();
  baseRows.forEach((row) => {
    const key = hourlyRowKey(row, date);
    if (key && !baseByKey.has(key)) baseByKey.set(key, row);
  });
  return rows.map((row) => {
    const base = baseByKey.get(hourlyRowKey(row, date));
    if (!base) return row;
    return {
      ...row,
      baseCost: Number.isFinite(Number(base.cost)) ? base.cost : null,
      baseRoi: Number.isFinite(Number(base.roi)) ? base.roi : null,
      baseRaw: base.raw || "",
    };
  });
}

async function collectHourlyRowsAcrossTable(client) {
  const fractions = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const byKey = new Map();
  let page = {};
  for (const fraction of fractions) {
    await client.send("Runtime.evaluate", {
      expression: buildSetHourlyTableScrollFractionExpression(fraction),
      returnByValue: true,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const evalResult = await client.send("Runtime.evaluate", {
      expression: buildHourlyBreakdownExpression(),
      returnByValue: true,
    }).catch(() => ({ result: { value: {} } }));
    const currentPage = evalResult.result?.value || {};
    if (!page.url && currentPage.url) page = currentPage;
    const rows = Array.isArray(currentPage.hourlyRows) ? currentPage.hourlyRows : [];
    rows.forEach((row) => {
      const key = hourlyRowKey(row);
      if (!key) return;
      const previous = byKey.get(key);
      const previousScore = (Number.isFinite(Number(previous?.cost)) ? 2 : 0) + (Number.isFinite(Number(previous?.roi)) ? 2 : 0) + String(previous?.raw || "").length / 1000;
      const nextScore = (Number.isFinite(Number(row?.cost)) ? 2 : 0) + (Number.isFinite(Number(row?.roi)) ? 2 : 0) + String(row?.raw || "").length / 1000;
      if (!previous || nextScore >= previousScore) byKey.set(key, row);
    });
  }
  const rows = Array.from(byKey.values()).sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));
  return { ...page, hourlyRows: rows, scanFractions: fractions };
}

async function collectHourlyRowsWithTimeSort(client) {
  await client.send("Runtime.evaluate", {
    expression: buildSortHourlyByTimeExpression(),
    returnByValue: true,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 900));
  let page = await collectHourlyRowsAcrossTable(client);
  if (currentHourlyRow(page.hourlyRows)) return page;
  await client.send("Runtime.evaluate", {
    expression: buildSortHourlyByTimeExpression(),
    returnByValue: true,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const secondPage = await collectHourlyRowsAcrossTable(client);
  return currentHourlyRow(secondPage.hourlyRows) ? secondPage : page;
}

async function collectHourlyRowsUntilReady(client, options = {}) {
  const attempts = Math.max(1, options.attempts || 1);
  const delayMs = Math.max(0, options.delayMs || 0);
  const requireCurrent = Boolean(options.requireCurrent);
  let lastPage = { hourlyRows: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const page = await collectHourlyRowsWithTimeSort(client);
    const rows = Array.isArray(page.hourlyRows) ? page.hourlyRows : [];
    lastPage = { ...page, readyAttempt: attempt };
    if (rows.length && (!requireCurrent || currentHourlyRow(rows))) return lastPage;
  }
  return { ...lastPage, readyAttempt: attempts, readyTimeout: true };
}

async function collectHourlyBreakdown(options = {}, allTabs = []) {
  const dataDir = options.dataDir;
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || options.expectedAccountId || "";
  const collectedAt = Date.now();
  ensureDir(path.join(dataDir, "visual"));
  const detailTab = allTabs.find((tab) => tab.type === "page" && String(tab.url || "").includes("/uni-prom/detail"));
  let overviewTab = allTabs.find((tab) => tab.type === "page" && String(tab.url || "").includes("/uni-prom/overall"));
  if (!overviewTab && options.openMissingTabs && accountId) {
    overviewTab = await openTab(cdpUrl, `https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${encodeURIComponent(accountId)}`);
    await new Promise((resolve) => setTimeout(resolve, 6500));
  }
  const sourceTab = detailTab || overviewTab;
  if (!sourceTab?.webSocketDebuggerUrl) {
    return {
      ok: true,
      collectedAt,
      capturedAt: collectedAt,
      title: "单小时明细采集",
      pageType: "hourlyCollect",
      route: "hourly",
      mode: "auto_collect_hourly",
      pages: [],
      hourlyBreakdown: { status: "empty", error: "no_invest_overview_tab", rows: [] },
      extractedMetrics: {},
      taskScan: { capturedAt: collectedAt, pages: [], tasks: [], taskType: "all" },
    };
  }
  const client = connect(sourceTab.webSocketDebuggerUrl);
  try {
    let opened = { reusedDetailTab: Boolean(detailTab), tabUrl: sourceTab.url };
    if (detailTab) {
      const ensureResult = await client.send("Runtime.evaluate", {
        expression: buildEnsureHourlyDetailDataExpression(),
        returnByValue: true,
      });
      opened = { ...opened, ensure: ensureResult.result?.value || {} };
      await new Promise((resolve) => setTimeout(resolve, 2500));
    } else {
      await waitForPageTypeReady(client, "investOverview");
      await prepareTabForPageType(client, "investOverview");
      const openResult = await client.send("Runtime.evaluate", {
        expression: buildOpenHourlyDetailExpression(),
        returnByValue: true,
      });
      opened = { ...opened, ...(openResult.result?.value || {}) };
      await new Promise((resolve) => setTimeout(resolve, opened.clicked ? 7500 : 1200));
      await client.send("Runtime.evaluate", {
        expression: buildEnsureHourlyDetailDataExpression(),
        returnByValue: true,
      }).catch(() => null);
    }
    const dateSwitch = await switchToTodayDate(client).catch((error) => ({ ok: false, reason: error.message }));
    if (!dateSwitch.ok) throw new Error(`hourly_date_range_unconfirmed:${dateSwitch.reason || "unknown"}`);
    const totalBaseToggle = await setHourlyBaseOnly(client, false, { attempts: 3, settleMs: 1800 });
    if (!totalBaseToggle.ok) throw new Error(`hourly_total_toggle_unconfirmed:${totalBaseToggle.reason || "unknown"}`);
    for (let i = 0; i < 3; i += 1) {
      await client.send("Runtime.evaluate", {
        expression: buildHourlyScrollExpression(),
        returnByValue: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    const page = await collectHourlyRowsUntilReady(client, { attempts: 2, delayMs: 900, requireCurrent: true });
    const totalRows = Array.isArray(page.hourlyRows) ? page.hourlyRows : [];
    const baseToggle = await setHourlyBaseOnly(client, true, { attempts: 3, settleMs: 3200 });
    let basePage = { hourlyRows: [], readyAttempt: 0, readyTimeout: true };
    if (baseToggle.ok) {
      for (let i = 0; i < 2; i += 1) {
        await client.send("Runtime.evaluate", {
          expression: buildHourlyScrollExpression(),
          returnByValue: true,
        }).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      basePage = await collectHourlyRowsUntilReady(client, { attempts: 3, delayMs: 1400, requireCurrent: true });
    }
    const baseRows = Array.isArray(basePage.hourlyRows) ? basePage.hourlyRows : [];
    await client.send("Runtime.evaluate", {
      expression: buildEnsureHourlyDetailDataExpression(),
      returnByValue: true,
    }).catch(() => null);
    const finalTotalToggle = await setHourlyBaseOnly(client, false, { attempts: 3, settleMs: 2200 });
    let finalTotalPage = page;
    if (finalTotalToggle.ok) {
      for (let i = 0; i < 2; i += 1) {
        await client.send("Runtime.evaluate", {
          expression: buildHourlyScrollExpression(),
          returnByValue: true,
        }).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      finalTotalPage = await collectHourlyRowsUntilReady(client, { attempts: 2, delayMs: 900, requireCurrent: true });
    }
    const finalTotalRows = finalTotalToggle.ok && Array.isArray(finalTotalPage.hourlyRows) && finalTotalPage.hourlyRows.length
      ? finalTotalPage.hourlyRows
      : totalRows;
    const rows = mergeHourlyBaseRows(finalTotalRows, baseRows);
    const current = currentHourlyRow(rows);
    const filename = `auto-${collectedAt}-hourly.png`;
    const screenshotPath = await saveScreenshot(client, path.join(dataDir, "visual", filename));
    const hourlyBreakdown = {
      status: rows.length ? "ok" : "empty",
      collectedAt,
      opened: {
        ...opened,
        totalBaseToggle,
        baseToggle,
        finalTotalToggle,
      },
      rows,
      baseRows,
      initialTotalRows: totalRows,
      current,
      headers: finalTotalPage.headers || page.headers || [],
      baseHeaders: basePage.headers || [],
      diagnostics: {
        totalReadyAttempt: page.readyAttempt || null,
        baseReadyAttempt: basePage.readyAttempt || null,
        baseReadyTimeout: Boolean(basePage.readyTimeout),
        finalTotalReadyAttempt: finalTotalPage.readyAttempt || null,
      },
      sourceUrl: finalTotalPage.url || page.url || sourceTab.url,
      sourceTitle: finalTotalPage.title || page.title || sourceTab.title,
      error: rows.length ? null : "hourly_rows_not_found",
    };
    return {
      ok: true,
      collectedAt,
      capturedAt: collectedAt,
      cdpUrl,
      tabUrl: finalTotalPage.url || page.url || sourceTab.url,
      title: "单小时明细采集",
      pageType: "hourlyCollect",
      route: "hourly",
      mode: "auto_collect_hourly",
      pages: [{
        label: "单小时明细",
        pageType: "hourlyDetail",
        title: finalTotalPage.title || page.title || sourceTab.title || "投放管理",
        url: finalTotalPage.url || page.url || sourceTab.url,
        metrics: {},
        tasks: [],
        hourlyRows: rows,
        hourlyBaseRows: baseRows,
        hourlyInitialRows: totalRows,
        error: rows.length ? null : "hourly_rows_not_found",
        screenshot: screenshotPath ? `/visual/${filename}` : null,
      }],
      hourlyBreakdown,
      dateSwitch,
      extractedMetrics: {},
      taskScan: { capturedAt: collectedAt, pages: [], tasks: [], taskType: "all" },
      screenshot: screenshotPath ? `/visual/${filename}` : null,
      textSample: cleanText(finalTotalPage.text || page.text || "").slice(0, 220),
      detectedHints: ["单小时", "ROI", "消耗"].filter((hint) => cleanText(finalTotalPage.text || page.text || "").includes(hint) || hint === "单小时"),
    };
  } finally {
    client.close();
  }
}

function summarizeAutoCollectPages(pages) {
  const summary = {};
  const overview = pages.find((page) => page.pageType === "investOverview" && !page.error)?.metrics || {};
  const live = pages.find((page) => page.pageType === "liveScreen" && !page.error)?.metrics || {};
  ["overallCost", "overallRoi", "dealAmount", "baseSpend", "hourCost", "hourRoi", "watchDealRate"].forEach((key) => {
    const value = overview[key] ?? live[key];
    if (Number.isFinite(value)) summary[key] = value;
  });
  ["gpm", "onlineCount", "totalViewers", "exposureWatchRate"].forEach((key) => {
    const value = live[key] ?? overview[key];
    if (Number.isFinite(value)) summary[key] = value;
  });
  summary.tasks = pages.flatMap((page) => page.pageType === "controlTable" ? (page.tasks || []) : []);
  return summary;
}

async function collectExistingTab(tab, pageType, label, dataDir, collectedAt, options = {}) {
  const client = connect(tab.webSocketDebuggerUrl);
  try {
    if (options.navigateUrl) {
      await autoNavigate(client, options.navigateUrl, { timeout: options.navigateTimeout || 6500 });
    }
    await waitForPageTypeReady(client, pageType);
    const dateSwitch = await switchToTodayDate(client).catch((error) => ({ ok: false, reason: error.message }));
    if (!dateSwitch.ok) throw new Error(`visual_date_range_unconfirmed:${dateSwitch.reason || "unknown"}`);
    const taskPrepare = await prepareTabForTaskRoute(client, options.route);
    await prepareTabForPageType(client, pageType);
    const evalResult = await client.send("Runtime.evaluate", {
      expression: buildPageProbeExpression(),
      returnByValue: true,
    });
  const page = evalResult.result?.value || {};
  const text = cleanText(page.text || "");
  const filename = `auto-${collectedAt}-${pageType}.png`;
  const screenshotPath = await saveScreenshot(client, path.join(dataDir, "visual", filename));
  const metrics = pageType === "investOverview" ? parseOverviewMetrics(text, page) : parseVisualMetrics(text);
  const tasks = pageType === "controlTable" ? (Array.isArray(page.tasks) ? page.tasks : []) : [];
  return {
      url: page.url || tab.url,
      title: page.title || tab.title || label,
      label,
      pageType,
      metrics,
      tasks: tasks.map((task) => ({
        ...task,
        sourceTitle: page.title || label,
      sourceUrl: page.url || tab.url,
      sourcePageType: pageType,
    })),
      textSample: text.slice(0, 180),
      liveStatus: detectLiveStatus(text, metrics, pageType),
      screenshot: screenshotPath ? `/visual/${filename}` : null,
      mode: "reuse_tab",
      taskPrepare,
      dateSwitch,
    };
  } finally {
    client.close();
  }
}

async function collectAutoPage(client, target, dataDir, collectedAt) {
  await autoNavigate(client, target.url, { timeout: 6000 });
  await waitForPageTypeReady(client, target.pageType);
  const dateSwitch = await switchToTodayDate(client).catch((error) => ({ ok: false, reason: error.message }));
  if (!dateSwitch.ok) throw new Error(`auto_date_range_unconfirmed:${dateSwitch.reason || "unknown"}`);
  const taskPrepare = await prepareTabForTaskRoute(client, target.route);
  await prepareTabForPageType(client, target.pageType);
  const evalResult = await client.send("Runtime.evaluate", {
    expression: buildPageProbeExpression(),
    returnByValue: true,
  });
  const page = evalResult.result?.value || {};
  const text = cleanText(page.text || "");
  const filename = `auto-${collectedAt}-${target.pageType}.png`;
  const screenshotPath = await saveScreenshot(client, path.join(dataDir, "visual", filename));
  const metrics = target.pageType === "investOverview" ? parseOverviewMetrics(text, page) : parseVisualMetrics(text);
  const tasks = target.pageType === "controlTable" ? (Array.isArray(page.tasks) ? page.tasks : []) : [];
  return {
    url: page.url || target.url,
    title: page.title || target.label,
    label: target.label,
    pageType: target.pageType,
    metrics,
    tasks: tasks.map((task) => ({
      ...task,
      sourceTitle: page.title || target.label,
      sourceUrl: page.url || target.url,
      sourcePageType: target.pageType,
    })),
    textSample: text.slice(0, 180),
    liveStatus: detectLiveStatus(text, metrics, target.pageType),
    screenshot: screenshotPath ? `/visual/${filename}` : null,
    mode: "navigate_fallback",
    taskPrepare,
    dateSwitch,
  };
}

async function saveScreenshot(client, filePath) {
  try {
    const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    fs.writeFileSync(filePath, Buffer.from(screenshot.data || "", "base64"));
    return filePath;
  } catch {
    return null;
  }
}

async function reloadTabBeforeCollect(tab) {
  let client = null;
  try {
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Page.reload", { ignoreCache: true });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch {
    // Reload is best-effort: stale-page protection should never block collection.
  } finally {
    if (client) client.close();
  }
}

async function rotateMaterialCollection(tabs = [], state = {}) {
  const tasks = Array.isArray(state.metrics?.tasks) ? state.metrics.tasks : [];
  if (!tasks.length) return { ok: false, skipped: true, error: "no_tasks" };

  const controlTab = tabs.find((tab) => String(tab.url || "").includes("uni_task_center"))
    || tabs.find((tab) => classifyTabUrl(tab.url) === "controlTable");
  if (!controlTab?.webSocketDebuggerUrl) return { ok: false, skipped: true, error: "no_control_table_tab" };

  const rotation = state.materialRotation || { index: 0 };
  const maxPerRound = 3;
  const listUrl = controlTab.url;
  const visited = [];
  const client = connect(controlTab.webSocketDebuggerUrl);
  let navigated = 0;

  try {
    for (let i = 0; i < Math.min(maxPerRound, tasks.length); i++) {
      const idx = (Number(rotation.index || 0) + i) % tasks.length;
      const task = tasks[idx] || {};
      const sourceUrl = String(task.sourceUrl || "");
      if (!sourceUrl.includes("qianchuan.jinritemai.com")) continue;

      await client.send("Page.navigate", { url: sourceUrl });
      await new Promise((resolve) => setTimeout(resolve, 6000));
      visited.push({ index: idx, taskId: task.taskId || task.id || "", sourceUrl });
      navigated += 1;
    }

    rotation.index = (Number(rotation.index || 0) + maxPerRound) % tasks.length;
    rotation.lastRotatedAt = Date.now();
    rotation.lastVisited = visited;
    rotation.lastError = null;
    state.materialRotation = rotation;
    return { ok: true, visited, index: rotation.index };
  } catch (error) {
    rotation.lastRotatedAt = Date.now();
    rotation.lastVisited = visited;
    rotation.lastError = error.message;
    state.materialRotation = rotation;
    return { ok: false, error: error.message, visited, navigated };
  } finally {
    try {
      if (listUrl) {
        await client.send("Page.navigate", { url: listUrl });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch {}
    client.close();
  }
}

async function runAutoCollect(options = {}) {
  const dataDir = options.dataDir;
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const collectedAt = Date.now();
  const route = ["overall", "control", "materialBoost", "oneClickLift", "hourly"].includes(options.route) ? options.route : "overall";
  ensureDir(path.join(dataDir, "visual"));

  let allTabs = [];
  try {
    allTabs = await listTabs(cdpUrl);
  } catch {
    throw new Error(`无法连接 CDP 浏览器：${cdpUrl}，请先用远程调试端口启动 Chrome`);
  }
  const pickedTabs = pickTabsByType(allTabs);
  const liveContext = extractLiveContext(allTabs);

  const accountId = options.accountId || options.expectedAccountId || "";
  if (!accountId) throw new Error("missing_account_id");

  if (route === "hourly") {
    return collectHourlyBreakdown({ ...options, dataDir, cdpUrl, accountId }, allTabs);
  }

  const pages = [];
  const targets = buildAutoCollectTargets(accountId, liveContext, route, allTabs);
  const pickedTabIds = new Set(Object.values(pickedTabs).map((tab) => tab.id));

  const reusedTypes = [];
  for (const target of targets) {
    const existing = pickedTabs[target.pageType];
    const isTaskRoute = target.pageType === "controlTable" && ["control", "materialBoost", "oneClickLift"].includes(route);
    if (!existing) {
      if (options.openMissingTabs && target.url) {
        try {
          const opened = await openTab(cdpUrl, target.url);
          await new Promise((resolve) => setTimeout(resolve, 7000));
          const collected = opened?.webSocketDebuggerUrl
            ? await collectExistingTab(opened, target.pageType, target.label, dataDir, collectedAt, { route: target.route })
            : {
                url: opened?.url || target.url,
                title: target.label,
                label: target.label,
                pageType: target.pageType,
                metrics: {},
                tasks: [],
                error: "opened_tab_missing_debugger_url",
                mode: "open_tab_failed",
              };
          pages.push({ ...collected, mode: collected.mode === "reuse_tab" ? "open_tab_collect" : collected.mode });
          reusedTypes.push(target.pageType);
          continue;
        } catch (error) {
          pages.push({
            url: target.url,
            title: target.label,
            label: target.label,
            pageType: target.pageType,
            metrics: {},
            tasks: [],
            error: `open_missing_tab_failed: ${error.message}`,
            mode: "open_missing_tab_failed",
          });
          continue;
        }
      }
      // 严格模式：找不到对应类型 tab 就 skip，绝不主动导航覆盖用户其他 tab
      pages.push({
        url: null,
        title: target.label,
        label: target.label,
        pageType: target.pageType,
        metrics: {},
        tasks: [],
        error: "no_reusable_tab",
        mode: "skip_no_tab",
      });
      continue;
    }
    try {
      const watchdogRefresh = options.refreshBeforeCollect === true;
      if (watchdogRefresh) await reloadTabBeforeCollect(existing);
      const collected = await collectExistingTab(existing, target.pageType, target.label, dataDir, collectedAt, {
        navigateUrl: isTaskRoute ? target.url : "",
        navigateTimeout: isTaskRoute ? 7000 : 0,
        route: target.route,
      });
      pages.push({
        ...collected,
        watchdogRefresh,
        watchdogReason: watchdogRefresh ? (options.watchdogReason || "refresh_before_collect") : "",
      });
      reusedTypes.push(target.pageType);
    } catch (error) {
      pages.push({
        url: existing.url,
        title: target.label,
        label: target.label,
        pageType: target.pageType,
        metrics: {},
        tasks: [],
        error: error.message,
        mode: "reuse_tab_failed",
      });
    }
  }

  const summary = summarizeAutoCollectPages(pages);
  const liveStatus = summarizeLiveStatus(pages);
  const shouldScanAllTaskTabs = route === "control";
  const scannedTaskTabs = shouldScanAllTaskTabs ? await scanTaskTabs(await listTabs(cdpUrl)) : null;
  const taskPages = scannedTaskTabs?.pages || pages.filter((page) => page.pageType === "controlTable");
  const extractedMetrics = Object.fromEntries(Object.entries(summary).filter(([key, value]) => key !== "tasks" && Number.isFinite(value)));
  const rawTaskScanTasks = dedupeTasksById([...(summary.tasks || []), ...((scannedTaskTabs?.tasks) || [])]);
  const taskScanTasks = dedupeTasksById(filterTasksForRoute(rawTaskScanTasks, route));
  const filteredTaskPages = route === "overall" ? taskPages : taskPages.map((page) => ({
    ...page,
    tasks: filterTasksForRoute(page.tasks || [], route),
  }));
  const titleMap = {
    overall: "整体指标采集",
    control: "调控任务采集",
    materialBoost: "素材追投采集",
    oneClickLift: "一键起量采集",
  };
  return {
    ok: true,
    collectedAt,
    capturedAt: collectedAt,
      cdpUrl,
      tabUrl: pages.find((page) => page.pageType === "liveScreen")?.url || pages[0]?.url || "",
    title: titleMap[route] || "分路线采集",
    pageType: route === "overall" ? "autoCollect" : `${route}Collect`,
    pages,
    summary,
    liveStatus,
    extractedMetrics,
    taskScan: {
      capturedAt: collectedAt,
      pages: filteredTaskPages,
      tasks: taskScanTasks,
      taskType: taskTypeForRoute(route) || "all",
      rawTaskCount: rawTaskScanTasks.length,
    },
    screenshot: pages.find((page) => page.screenshot)?.screenshot || null,
    detectedHints: pages.flatMap((page) => detectHints(JSON.stringify(page.metrics || {}))),
    textSample: "",
    mode: `auto_collect_${route}`,
    route,
    liveContext: liveContext || null,
    materialRotation: null,
    reusedTabs: reusedTypes,
  };
}

async function runVisualCapture(options = {}) {
  if (options.autoCollect) {
    return runAutoCollect(options);
  }
  const dataDir = options.dataDir;
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const startedAt = Date.now();
  ensureDir(path.join(dataDir, "visual"));

  let tab = null;
  let tabCandidates = [];
  let allTabs = [];
  try {
    allTabs = await listTabs(cdpUrl);
    tabCandidates = summarizeTabs(allTabs);
    tab = await findQianchuanTab(cdpUrl);
  } catch {
    throw new Error(`无法连接 CDP 浏览器：${cdpUrl}，请先用远程调试端口启动 Chrome`);
  }
  if (!tab) throw new Error("未找到已打开的千川页面，请用 CDP Chrome 打开千川后台");
  const client = connect(tab.webSocketDebuggerUrl);

  try {
    const evalResult = await client.send("Runtime.evaluate", {
      expression: `(() => ({ title: document.title, url: location.href, text: document.body.innerText }))()`,
      returnByValue: true,
    });
    const page = evalResult.result?.value || {};
    const filename = `visual-${startedAt}.png`;
    const screenshotPath = await saveScreenshot(client, path.join(dataDir, "visual", filename));

    const text = cleanText(page.text);
    const selectedUrl = page.url || tab.url;
    const selectedTitle = page.title || tab.title;
    tabCandidates = tabCandidates.map((candidate) => ({
      ...candidate,
      preferred: candidate.url === tab.url,
    }));
    return {
      ok: true,
      capturedAt: startedAt,
      cdpUrl,
      tabUrl: selectedUrl,
      title: selectedTitle,
      pageType: classifyPage({ url: selectedUrl, title: selectedTitle }),
      screenshot: screenshotPath ? `/visual/${filename}` : null,
      textSample: text.slice(0, 260),
      detectedHints: detectHints(text),
      extractedMetrics: parseVisualMetrics(text),
      taskScan: await scanTaskTabs(allTabs),
      tabCandidates,
      mode: "read_only",
    };
  } finally {
    client.close();
  }
}

module.exports = { runVisualCapture };
