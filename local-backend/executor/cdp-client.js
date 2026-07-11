const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTodayDateRange(url, today) {
  try {
    const target = new URL(url);
    target.searchParams.set("dr", `${today},${today}`);
    return target.toString();
  } catch {
    return "";
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value || null;
}

function buildDateProbeExpression(today) {
  return `(() => {
    const today = ${JSON.stringify(today)};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalizeDate = (value) => {
      const match = String(value || "").match(/(20\\d{2})[\\/.-](\\d{1,2})[\\/.-](\\d{1,2})/);
      if (!match) return "";
      return match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0");
    };
    const dateList = (value) => Array.from(String(value || "").matchAll(/(20\\d{2})[\\/.-](\\d{1,2})[\\/.-](\\d{1,2})/g))
      .map((match) => match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0"));
    const url = new URL(location.href);
    const urlDates = String(url.searchParams.get("dr") || "").split(",").map(normalizeDate).filter(Boolean);
    const candidates = Array.from(document.querySelectorAll("input,button,[role='button'],[role='combobox'],.arco-picker,.semi-datepicker,[class*='date'],[class*='Date']"))
      .filter(visible)
      .map((node) => {
        const parent = node.closest(".arco-picker,.semi-datepicker,[class*='range'],[class*='Range']");
        const value = clean([node.value, node.innerText, node.textContent, node.getAttribute("aria-label"), node.getAttribute("title"), parent?.innerText, parent?.textContent].filter(Boolean).join(" "));
        const dates = dateList(value);
        const date = dates[0] || "";
        const rect = node.getBoundingClientRect();
        const cls = String(node.className || "");
        let score = 0;
        if (dates.length >= 2) score += 180;
        else if (date) score += 140;
        if (/picker|date|range|calendar/i.test(cls + " " + node.getAttribute("role"))) score += 60;
        if (node.tagName === "INPUT") score += 35;
        if (rect.top < Math.max(420, window.innerHeight * 0.45)) score += 25;
        if (rect.top > window.innerHeight * 0.8) score -= 80;
        return { node, value, date, dates, score };
      })
      .filter((item) => item.date || item.score >= 60)
      .sort((a, b) => b.score - a.score);
    const current = candidates.find((item) => item.dates?.length >= 2) || candidates.find((item) => item.date) || candidates[0];
    const currentDates = current?.dates?.length ? current.dates : urlDates;
    const rangeStart = currentDates[0] || "";
    const rangeEnd = currentDates[1] || currentDates[0] || "";
    const rangeConfirmed = Boolean(rangeStart && rangeEnd && rangeStart === today && rangeEnd === today);
    const loading = Array.from(document.querySelectorAll("[aria-busy='true'],[class*='loading'],[class*='Loading'],[class*='spin'],[class*='Spin']"))
      .some((node) => {
        if (!visible(node)) return false;
        if (node.getAttribute("aria-busy") === "true") return true;
        const text = clean(node.innerText || node.textContent || "");
        return /loading|spin|加载/i.test(String(node.className || "")) && /^(loading|loading\\.{1,3}|加载中|加载中\\.{1,3}|加载\\.{1,3})$/i.test(text);
      });
    return {
      ok: Boolean(current || urlDates.length), today, currentDate: rangeStart, currentText: current?.value || "", currentDates,
      rangeStart, rangeEnd, rangeConfirmed, urlRange: urlDates, urlRangeConfirmed: urlDates.length === 2 && urlDates[0] === today && urlDates[1] === today,
      needsSwitch: Boolean((rangeStart || rangeEnd) && !rangeConfirmed), loading, url: location.href,
    };
  })()`;
}

function buildOpenDatePickerExpression(today) {
  return `(() => {
    const today = ${JSON.stringify(today)};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => { const rect = node?.getBoundingClientRect?.(); const style = node ? getComputedStyle(node) : null; return Boolean(rect && style && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"); };
    const normalizeDate = (value) => { const match = String(value || "").match(/(20\\d{2})[\\/.-](\\d{1,2})[\\/.-](\\d{1,2})/); return match ? match[1] + "-" + match[2].padStart(2, "0") + "-" + match[3].padStart(2, "0") : ""; };
    const target = Array.from(document.querySelectorAll("input,button,[role='button'],[role='combobox'],.arco-picker,.semi-datepicker,[class*='date'],[class*='Date']"))
      .filter(visible).map((node) => { const text = clean(node.value || node.innerText || node.textContent || node.getAttribute("aria-label") || ""); const date = normalizeDate(text); const rect = node.getBoundingClientRect(); const cls = String(node.className || ""); let score = date ? 160 : 0; if (/picker|date|range|calendar/i.test(cls + " " + node.getAttribute("role"))) score += 60; if (node.tagName === "INPUT") score += 35; if (rect.top < Math.max(420, window.innerHeight * 0.45)) score += 25; return { node, date, text, score }; }).sort((a, b) => b.score - a.score)[0];
    if (!target) return { ok: false, error: "date_picker_not_found", today };
    const clickable = target.node.closest("button,[role='button'],[role='combobox'],.arco-picker,.semi-datepicker,label") || target.node;
    clickable.scrollIntoView({ block: "center", inline: "center" }); clickable.click();
    return { ok: true, currentDate: target.date, currentText: target.text, today };
  })()`;
}

function buildSelectTodayExpression(today) {
  return `(() => {
    const today = ${JSON.stringify(today)};
    const day = String(Number(today.slice(-2)));
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const visible = (node) => { const rect = node?.getBoundingClientRect?.(); const style = node ? getComputedStyle(node) : null; return Boolean(rect && style && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"); };
    const nodes = Array.from(document.querySelectorAll("[data-value],[data-date],[title],[aria-label],button,td,[role='gridcell'],[role='button']")).filter(visible);
    const exact = nodes.map((node) => ({ node, marker: [node.getAttribute("data-value"), node.getAttribute("data-date"), node.getAttribute("title"), node.getAttribute("aria-label"), clean(node.innerText || node.textContent || "")].join(" ") }))
      .find((item) => item.marker.includes(today));
    const todayButton = nodes.find((node) => /^(今天|今日)$/.test(clean(node.innerText || node.textContent || node.getAttribute("aria-label") || "")));
    const dayCell = nodes.find((node) => clean(node.innerText || node.textContent || "") === day && !/disabled|outside|prev|next/.test(String(node.className || "")));
    const target = exact?.node || todayButton || dayCell;
    if (!target) return { ok: false, error: "today_cell_not_found", today };
    const clickable = target.closest("button,td,[role='gridcell'],[role='button']") || target;
    clickable.scrollIntoView({ block: "center", inline: "center" }); clickable.click();
    return { ok: true, today, selected: clean(clickable.innerText || clickable.textContent || clickable.getAttribute("aria-label") || "") };
  })()`;
}

async function switchToTodayDate(client) {
  const today = shanghaiToday();
  const before = await evaluate(client, buildDateProbeExpression(today)).catch((error) => ({ ok: false, error: error.message }));
  if (!before?.ok) return { ok: false, skipped: true, reason: before?.error || "date_picker_not_found", today };
  if (before.rangeConfirmed && before.urlRangeConfirmed && !before.loading) {
    return { ok: true, changed: false, today, currentDate: before.currentDate, currentRange: [before.rangeStart, before.rangeEnd] };
  }

  const targetUrl = withTodayDateRange(before.url, today);
  if (targetUrl && !before.urlRangeConfirmed) {
    await client.send("Page.navigate", { url: targetUrl });
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < 12000) {
      last = await evaluate(client, buildDateProbeExpression(today)).catch((error) => ({ ok: false, error: error.message }));
      if (last?.rangeConfirmed && last?.urlRangeConfirmed && !last.loading) {
        return { ok: true, changed: true, method: "url", today, previousRange: [before.rangeStart, before.rangeEnd], currentRange: [last.rangeStart, last.rangeEnd] };
      }
      await sleep(300 + Math.floor(Math.random() * 201));
    }
  }

  const opened = await evaluate(client, buildOpenDatePickerExpression(today)).catch((error) => ({ ok: false, error: error.message }));
  if (!opened?.ok) return { ok: false, reason: opened?.error || "date_picker_open_failed", today };
  const startedAt = Date.now();
  let selected = [];
  while (Date.now() - startedAt < 6000 && selected.length < 2) {
    const next = await evaluate(client, buildSelectTodayExpression(today)).catch((error) => ({ ok: false, error: error.message }));
    if (next?.ok) selected.push(next);
    const probe = await evaluate(client, buildDateProbeExpression(today)).catch(() => null);
    if (probe?.rangeConfirmed && probe?.urlRangeConfirmed) break;
    await sleep(300 + Math.floor(Math.random() * 201));
  }
  if (!selected.length) return { ok: false, reason: "today_cell_timeout", today };
  let last = null;
  while (Date.now() - startedAt < 12000) {
    last = await evaluate(client, buildDateProbeExpression(today)).catch((error) => ({ ok: false, error: error.message }));
    if (last?.rangeConfirmed && last?.urlRangeConfirmed && !last.loading) {
      return { ok: true, changed: true, method: "picker_range", today, previousRange: [before.rangeStart, before.rangeEnd], currentRange: [last.rangeStart, last.rangeEnd] };
    }
    await sleep(300 + Math.floor(Math.random() * 201));
  }
  return { ok: false, reason: "date_range_unconfirmed", today, previousRange: [before.rangeStart, before.rangeEnd], currentRange: [last?.rangeStart || "", last?.rangeEnd || ""] };
}

async function listTabs(cdpUrl = DEFAULT_CDP_URL) {
  const response = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/list`);
  if (!response.ok) throw new Error(`cdp_http_${response.status}`);
  return response.json();
}

function connect(wsUrl) {
  if (typeof WebSocket !== "function") throw new Error("node_websocket_unavailable");
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const eventHandlers = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method) {
      const handlers = eventHandlers.get(message.method) || [];
      handlers.forEach((handler) => {
        try {
          handler(message.params || {});
        } catch {
          // CDP event handlers are best-effort observers; keep command replies flowing.
        }
      });
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || "cdp_error"));
    else resolve(message.result || {});
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("cdp_socket_error")), { once: true });
  });

  async function send(method, params = {}) {
    await ready;
    const id = ++seq;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`cdp_timeout_${method}`));
      }, 8000);
    });
  }

  function on(method, handler) {
    const handlers = eventHandlers.get(method) || [];
    handlers.push(handler);
    eventHandlers.set(method, handlers);
    return () => {
      const next = (eventHandlers.get(method) || []).filter((item) => item !== handler);
      if (next.length) eventHandlers.set(method, next);
      else eventHandlers.delete(method);
    };
  }

  return { send, on, close: () => socket.close() };
}

function scoreQianchuanTab(tab) {
  const url = String(tab.url || "");
  const title = String(tab.title || "");
  let score = 0;
  if (tab.type === "page") score += 10;
  if (url.includes("qianchuan.jinritemai.com")) score += 20;
  if (url.includes("/board-next")) score += 80;
  if (title.includes("直播大屏")) score += 70;
  if (url.includes("/uni-prom/overall")) score += 30;
  if (url.includes("/uni-prom/detail")) score += 20;
  if (url.includes("aavid=")) score += 5;
  return score;
}

async function findQianchuanTab(cdpUrl) {
  const tabs = await listTabs(cdpUrl);
  const candidates = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com"))
    .map((tab) => ({ ...tab, captureScore: scoreQianchuanTab(tab) }))
    .sort((a, b) => b.captureScore - a.captureScore);
  return candidates[0] || null;
}

async function openTab(cdpUrl, url) {
  const base = cdpUrl.replace(/\/$/, "");
  const target = `${base}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(target, { method: "PUT" });
  if (!response.ok) throw new Error(`cdp_open_tab_http_${response.status}`);
  return response.json();
}

module.exports = { DEFAULT_CDP_URL, listTabs, findQianchuanTab, connect, scoreQianchuanTab, openTab, switchToTodayDate };
