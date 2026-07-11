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

function buildDetailUrl(accountId) {
  const detail = encodeURIComponent(JSON.stringify({ tb: "material" }));
  return `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${encodeURIComponent(accountId)}&uniDetail=%7B%7D#uniDetail=${detail}`;
}

function materialUrlFromSource(sourceUrl, accountId) {
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
    detail.tb = "material";
    hashParams.set("uniDetail", JSON.stringify(detail));
    parsed.hash = hashParams.toString();
    return parsed.toString();
  } catch {
    return "";
  }
}

function buildMaterialUrlFromTabs(accountId, tabs = []) {
  const detailTabs = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com/uni-prom/detail"))
    .map((tab) => {
      const url = String(tab.url || "");
      let score = scoreQianchuanTab(tab);
      if (url.includes("material")) score += 80;
      if (url.includes("tb%22%3A%22data") || url.includes("uni_task_center")) score += 20;
      return { tab, url, score };
    })
    .sort((a, b) => b.score - a.score);
  for (const item of detailTabs) {
    const url = materialUrlFromSource(item.url, accountId);
    if (url) return { url, tab: item.tab };
  }
  return { url: buildDetailUrl(accountId), tab: null };
}

function buildEnsureMaterialTabExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .map((el) => {
        const text = clean(el.innerText || el.textContent || "");
        const node = el.closest("button,[role='tab'],[role='button'],a,.semi-tabs-tab,.arco-tabs-header-title") || el;
        const rect = node.getBoundingClientRect();
        let score = 0;
        if (text === "素材") score += 160;
        if (text.includes("素材")) score += 80;
        if (node.getAttribute("role") === "tab") score += 60;
        if (node.closest("tr,tbody,table")) score -= 120;
        if (/素材ID|素材名称|消耗|ROI|点击率|转化率/.test(text)) score -= 80;
        return { node, text, score, top: rect.top };
      })
      .filter((item) => item.score > 0 && visible(item.node))
      .sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (target) {
      target.node.scrollIntoView({ block: "center", inline: "center" });
      target.node.click();
    }
    return {
      ok: Boolean(target),
      clicked: target ? target.text : "",
      candidates: candidates.slice(0, 5).map((item) => ({ text: item.text.slice(0, 80), score: item.score, top: Math.round(item.top) })),
      url: location.href,
      title: document.title
    };
  })()`;
}

function buildMaterialPrepareExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const touched = [];
    const materialArea = Array.from(document.querySelectorAll("button,div,span,a,h1,h2,h3,th,[role='columnheader']"))
      .find((el) => /素材ID|素材名称|素材|消耗|点击率|转化率|ROI/.test(clean(el.innerText || el.textContent || "")));
    if (materialArea) {
      materialArea.scrollIntoView({ block: "center", inline: "nearest" });
      touched.push({ reason: "scroll_material_area", text: clean(materialArea.innerText || materialArea.textContent || "").slice(0, 80) });
    }
    const vertical = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.scrollHeight > el.clientHeight + 160 && el.clientHeight > 220)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
      .slice(0, 6);
    vertical.forEach((el) => {
      const before = el.scrollTop || 0;
      el.scrollTop = Math.min(el.scrollTop || 0, Math.max(0, el.scrollHeight - el.clientHeight));
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ reason: "vertical_probe", before, after: el.scrollTop });
    });
    return { touched };
  })()`;
}

function buildHorizontalScrollExpression() {
  return `(() => {
    const touched = [];
    const containers = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.scrollWidth > el.clientWidth + 120 && el.clientWidth > 180)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))
      .slice(0, 10);
    containers.forEach((el) => {
      const before = el.scrollLeft || 0;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollLeft = max;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      touched.push({ tag: el.tagName, className: String(el.className || "").slice(0, 80), before, after: el.scrollLeft || max, max });
    });
    return { touched };
  })()`;
}

function buildSortConversionExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = Array.from(document.querySelectorAll("th,[role='columnheader'],button,span,div"))
      .map((node) => ({ node, text: clean(node.innerText || node.textContent || "") }))
      .filter((item) => visible(item.node) && /转化率|CVR/i.test(item.text))
      .sort((a, b) => {
        const at = a.node.closest("th,[role='columnheader']") ? 1 : 0;
        const bt = b.node.closest("th,[role='columnheader']") ? 1 : 0;
        return bt - at;
      })[0];
    if (!target) return { ok: false, error: "conversion_column_not_found" };
    const clickable = target.node.closest("th,[role='columnheader'],button,[role='button']") || target.node;
    clickable.scrollIntoView({ block: "center", inline: "center" });
    clickable.click();
    return { ok: true, text: target.text.slice(0, 80) };
  })()`;
}

function buildExtractMaterialsExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const num = (value) => {
      const raw = String(value || "").replaceAll(",", "");
      const match = raw.match(/-?\\d+(?:\\.\\d+)?/);
      if (!match) return null;
      const parsed = parseFloat(match[0]);
      if (!Number.isFinite(parsed)) return null;
      const unitText = raw.slice(match.index, match.index + match[0].length + 4);
      return /万/.test(unitText) ? parsed * 10000 : parsed;
    };
    const money = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const cellSelector = "th,td,[role='columnheader'],[role='cell'],.arco-table-th,.arco-table-td,.semi-table-cell,.byted-table-cell";
    const rowSelector = "tr,[role='row'],.arco-table-tr,.semi-table-row,.byted-table-row";
    const cellsOf = (row) => Array.from(row.querySelectorAll(cellSelector))
      .filter((cell) => !Array.from(row.querySelectorAll(cellSelector)).some((other) => other !== cell && other.contains(cell)))
      // Keep blank cells so data cells remain aligned with the header indexes.
      .map((cell) => clean(cell.innerText || cell.textContent || ""));
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const headerCells = rows.map(cellsOf).find((cells) => cells.some((item) => /素材ID|素材名称|消耗|点击率|转化率|ROI/.test(item))) || [];
    const headerText = headerCells.join(" ");
    const indexOf = (patterns) => {
      let best = -1;
      let score = -1;
      headerCells.forEach((label, index) => {
        const text = label.replace(/\\s+/g, "");
        const current = patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
        if (current > score) {
          score = current;
          best = index;
        }
      });
      return score > 0 ? best : -1;
    };
    const indexes = {
      materialId: indexOf([/素材ID/, /^ID$/]),
      spend: indexOf([/消耗/, /成本/]),
      ctr: indexOf([/点击率/, /CTR/i]),
      cvr: indexOf([/转化率/, /CVR/i]),
      roi: indexOf([/素材ROI/, /^ROI$/, /综合ROI/]),
      boostRoi: indexOf([/追投ROI/, /调控ROI/]),
      boostStatus: indexOf([/^素材追投$/, /^视频追投$/]),
      createdAt: indexOf([/创建时间/, /创建日期/, /日期/]),
      auditStatus: indexOf([/审核状态/, /状态/]),
      materialType: indexOf([/素材类型/, /类型/]),
    };
    const materials = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      const text = clean(cells.length ? cells.join(" ") : row.innerText || row.textContent || "");
      if (!text || /素材ID.*消耗|点击率.*转化率/.test(text)) continue;
      const id = indexes.materialId >= 0 ? (cells[indexes.materialId] || "").match(/\\d{8,}/)?.[0] : text.match(/(?:素材ID[：:]?\\s*)?(\\d{12,})/)?.[1];
      if (!id) continue;
      const spend = indexes.spend >= 0 ? money(num(cells[indexes.spend])) : money(num(text.match(/消耗[^\\d-]*(-?\\d[\\d,.]*)/)?.[1]));
      const ctr = indexes.ctr >= 0 ? money(num(cells[indexes.ctr])) : money(num(text.match(/点击率[^\\d-]*(-?\\d[\\d,.]*%?)/)?.[1]));
      const cvr = indexes.cvr >= 0 ? money(num(cells[indexes.cvr])) : money(num(text.match(/转化率[^\\d-]*(-?\\d[\\d,.]*%?)/)?.[1]));
      const materialRoi = indexes.roi >= 0 ? money(num(cells[indexes.roi])) : null;
      const boostRoi = indexes.boostRoi >= 0 ? money(num(cells[indexes.boostRoi])) : null;
      const boostStatusText = indexes.boostStatus >= 0 ? clean(cells[indexes.boostStatus]) : "";
      const boostStatus = /调控中|追投中|投放中/.test(boostStatusText)
        ? "追投中"
        : /调控结束|已暂停|未追投|^-$/.test(boostStatusText) || !boostStatusText
          ? "未追投"
          : "未识别";
      const createdAt = indexes.createdAt >= 0 ? cells[indexes.createdAt] : (text.match(/20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?/)?.[0] || "");
      const auditStatus = indexes.auditStatus >= 0 ? cells[indexes.auditStatus] : (text.match(/审核通过|审核中|审核未通过|未通过|已通过/)?.[0] || "");
      const materialType = indexes.materialType >= 0 ? cells[indexes.materialType] : (/视频/.test(text) ? "视频" : /图片|图文/.test(text) ? "图片" : "");
      materials.push({
        materialId: id,
        "素材ID": id,
        spend,
        "消耗": spend,
        ctr,
        "CTR": ctr,
        cvr,
        "CVR": cvr,
        materialRoi,
        "素材ROI": materialRoi,
        boostRoi,
        "追投ROI": boostRoi,
        boostStatus,
        "追投状态": boostStatus,
        createdAt,
        "创建日期": createdAt,
        auditStatus,
        "审核状态": auditStatus,
        materialType,
        "类型": materialType,
        rawText: text.slice(0, 500),
      });
    }
    return {
      ok: materials.length > 0,
      title: document.title,
      url: location.href,
      rowCount: rows.length,
      headerCells,
      headerText,
      indexes,
      materials,
      textSample: clean(document.body?.innerText || "").slice(0, 1200),
    };
  })()`;
}

function buildNextPageExpression() {
  return `(() => {
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],li,a"))
      .map((node) => {
        const text = clean(node.innerText || node.textContent || node.getAttribute("aria-label") || node.getAttribute("title") || "");
        const cls = String(node.className || "");
        let score = 0;
        if (/下一页|下一|next/i.test(text)) score += 100;
        if (/right|next|arrow/.test(cls)) score += 40;
        if (node.disabled || /disabled/.test(cls) || node.getAttribute("aria-disabled") === "true") score -= 200;
        return { node, text, score };
      })
      .filter((item) => item.score > 0 && visible(item.node))
      .sort((a, b) => b.score - a.score);
    const target = candidates[0];
    if (!target) return { ok: false, hasNext: false, reason: "next_button_not_found" };
    target.node.scrollIntoView({ block: "center", inline: "center" });
    target.node.click();
    return { ok: true, hasNext: true, text: target.text };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value || null;
}

async function waitForMaterials(client, timeoutMs = 8000) {
  const startedAt = Date.now();
  let last = null;
  const expression = buildExtractMaterialsExpression();
  while (Date.now() - startedAt < timeoutMs) {
    last = await evaluate(client, expression).catch((error) => ({ ok: false, error: error.message }));
    if (last?.ok) return last;
    await sleep(500);
  }
  return last || { ok: false, error: "material_timeout" };
}

async function ensureMaterialTab(cdpUrl, accountId) {
  const tabs = await listTabs(cdpUrl);
  const target = buildMaterialUrlFromTabs(accountId, tabs);
  const tab = target.tab?.webSocketDebuggerUrl ? target.tab : await openTab(cdpUrl, target.url);
  return { tab, url: target.url };
}

function dedupeMaterials(items = []) {
  const map = new Map();
  items.forEach((item) => {
    const id = String(item.materialId || item["素材ID"] || "").trim();
    if (!id) return;
    map.set(id, { ...(map.get(id) || {}), ...item, materialId: id, "素材ID": id });
  });
  return Array.from(map.values());
}

async function runMaterialCollector(options = {}) {
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const accountId = options.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 30), 60));
  const startedAt = Date.now();
  let client = null;
  const pages = [];
  const warnings = [];
  try {
    const { tab, url } = await ensureMaterialTab(cdpUrl, accountId);
    client = connect(tab.webSocketDebuggerUrl);
    await client.send("Runtime.enable").catch(() => null);
    await client.send("Page.enable").catch(() => null);
    if (!String(tab.url || "").includes("material")) {
      await client.send("Page.navigate", { url }).catch(() => null);
      await sleep(1800);
    }
    await randomDelay();
    const materialTab = await evaluate(client, buildEnsureMaterialTabExpression()).catch((error) => ({ ok: false, error: error.message }));
    await sleep(1500);
    await evaluate(client, buildMaterialPrepareExpression()).catch(() => null);
    let first = await waitForMaterials(client, 8000);
    let reloaded = false;
    if (!first?.ok) {
      reloaded = true;
      await client.send("Page.reload", { ignoreCache: true }).catch(() => null);
      await sleep(1800);
      await evaluate(client, buildEnsureMaterialTabExpression()).catch(() => null);
      await sleep(1500);
      first = await waitForMaterials(client, 8000);
    }
    if (!first?.ok) {
      return {
        ok: false,
        status: "skipped",
        error: first?.error || "material_timeout_after_reload",
        startedAt,
        finishedAt: Date.now(),
        reloaded,
        materialTab,
        first,
      };
    }
    const sortConversion = await evaluate(client, buildHorizontalScrollExpression()).catch((error) => ({ error: error.message }));
    await sleep(500);
    const conversionSort = await evaluate(client, buildSortConversionExpression()).catch((error) => ({ ok: false, error: error.message }));
    if (!conversionSort?.ok) warnings.push(conversionSort?.error || "conversion_sort_failed");
    await sleep(conversionSort?.ok ? 1200 : 300);

    let current = await waitForMaterials(client, 8000);
    let materials = [];
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      if (!current?.ok) break;
      pages.push({
        page: pageIndex,
        count: current.materials?.length || 0,
        rowCount: current.rowCount || 0,
        headerCells: current.headerCells || [],
        url: current.url,
      });
      materials.push(...(current.materials || []));
      const beforeIds = new Set((current.materials || []).map((item) => item.materialId).filter(Boolean));
      const next = await evaluate(client, buildNextPageExpression()).catch((error) => ({ ok: false, error: error.message }));
      if (!next?.ok || !next.hasNext) break;
      await sleep(1300);
      current = await waitForMaterials(client, 8000);
      const afterIds = new Set((current?.materials || []).map((item) => item.materialId).filter(Boolean));
      const same = beforeIds.size === afterIds.size && Array.from(beforeIds).every((id) => afterIds.has(id));
      if (same) {
        warnings.push("next_page_no_change");
        break;
      }
    }
    materials = dedupeMaterials(materials);
    const cvrValues = materials.map((item) => num(item.cvr)).filter(Number.isFinite);
    const ctrValues = materials.map((item) => num(item.ctr)).filter(Number.isFinite);
    return {
      ok: true,
      status: "ok",
      startedAt,
      finishedAt: Date.now(),
      reloaded,
      materialTab,
      sortConversion,
      conversionSort,
      pages,
      warnings,
      total: materials.length,
      materials,
      meta: {
        source: "material_table_dom",
        accountId,
        collectedAt: Date.now(),
        pageCount: pages.length,
        avgCtr: ctrValues.length ? money(ctrValues.reduce((sum, value) => sum + value, 0) / ctrValues.length) : null,
        avgCvr: cvrValues.length ? money(cvrValues.reduce((sum, value) => sum + value, 0) / cvrValues.length) : null,
        highCvrThreshold: cvrValues.length ? money(cvrValues.reduce((sum, value) => sum + value, 0) / cvrValues.length) : null,
      },
    };
  } catch (error) {
    return { ok: false, status: "error", error: error.message, startedAt, finishedAt: Date.now(), pages, warnings };
  } finally {
    if (client) client.close();
  }
}

module.exports = { runMaterialCollector };
