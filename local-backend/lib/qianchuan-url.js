function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function extractAdContextFromUrl(value) {
  const url = String(value || "");
  if (!url.includes("qianchuan.jinritemai.com")) return {};
  const rawMatch = url.match(/[?&#](?:adId|uAId)=([^&#]+)/);
  const rawId = rawMatch ? safeDecode(rawMatch[1]).match(/\d{8,}/)?.[0] : "";
  if (rawId) return { adId: rawId, sourceUrl: url };

  const decoded = safeDecode(url);
  const nested = decoded.match(/"uAId"\s*:\s*"(\d{8,})"/) || decoded.match(/"adId"\s*:\s*"(\d{8,})"/);
  if (nested) return { adId: nested[1], sourceUrl: url };

  return {};
}

function extractLiveContextFromUrl(value) {
  const sourceUrl = String(value || "");
  if (!sourceUrl.includes("qianchuan.jinritemai.com") || !sourceUrl.includes("/board-next")) return {};
  try {
    const parsed = new URL(sourceUrl);
    const liveRoomId = String(parsed.searchParams.get("live_room_id") || "").match(/\d{8,}/)?.[0] || "";
    if (!liveRoomId) return {};
    return {
      liveRoomId,
      anchorId: String(parsed.searchParams.get("anchorId") || "").match(/\d{6,}/)?.[0] || "",
      accountId: String(parsed.searchParams.get("aavid") || "").match(/\d{8,}/)?.[0] || "",
      sourceUrl,
    };
  } catch {
    return {};
  }
}

function walkUrls(value, urls, seen) {
  if (urls.length >= 500 || value == null) return;
  if (typeof value === "string") {
    if (value.includes("qianchuan.jinritemai.com")) urls.push(value);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walkUrls(item, urls, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (urls.length >= 500) return;
    if (/secret|token|cookie/i.test(key)) continue;
    walkUrls(item, urls, seen);
  }
}

function scoreContextUrl(url) {
  const value = String(url || "");
  const today = shanghaiDate();
  let score = 0;
  if (value.includes("/uni-prom/detail")) score += 80;
  if (value.includes("uni_task_center")) score += 40;
  if (value.includes("tb%22%3A%22data") || value.includes("tb%22%3A%22creative")) score += 20;
  if (value.includes("adId=")) score += 30;
  if (value.includes("uAId")) score += 20;
  if (value.includes(today)) score += 100;
  return score;
}

function findAdContextFromState(state = {}) {
  const urls = [];
  walkUrls(state, urls, new Set());
  return urls
    .map((url) => ({ ...extractAdContextFromUrl(url), score: scoreContextUrl(url) }))
    .filter((item) => item.adId)
    .sort((a, b) => b.score - a.score)[0] || {};
}

function objectTimestamp(value = {}, inheritedAt = 0) {
  const candidates = [value.receivedAt, value.timestamp, value.capturedAt, value.collectedAt, value.finishedAt]
    .map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
  return candidates.length ? Math.max(...candidates) : inheritedAt;
}

function walkLiveContexts(value, contexts, seen, inheritedAt = 0) {
  if (contexts.length >= 500 || value == null) return;
  if (typeof value === "string") {
    const context = extractLiveContextFromUrl(value);
    if (context.liveRoomId) contexts.push({ ...context, receivedAt: inheritedAt || 0 });
    return;
  }
  if (typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const receivedAt = Array.isArray(value) ? inheritedAt : objectTimestamp(value, inheritedAt);
  if (Array.isArray(value)) {
    value.forEach((item) => walkLiveContexts(item, contexts, seen, receivedAt));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (contexts.length >= 500) return;
    if (/secret|token|cookie/i.test(key)) continue;
    walkLiveContexts(item, contexts, seen, receivedAt);
  }
}

function findLiveContextFromState(state = {}, expectedAccountId = "") {
  const contexts = [];
  walkLiveContexts(state, contexts, new Set());
  const expected = String(expectedAccountId || "");
  return contexts
    .filter((item) => !expected || !item.accountId || item.accountId === expected)
    .sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0) || Number(Boolean(b.anchorId)) - Number(Boolean(a.anchorId)))[0] || {};
}

function buildLiveScreenUrl(accountId, context = {}) {
  if (!context.liveRoomId) return "";
  try {
    const parsed = context.sourceUrl ? new URL(context.sourceUrl) : new URL("https://qianchuan.jinritemai.com/board-next");
    parsed.pathname = "/board-next";
    parsed.searchParams.set("live_room_id", context.liveRoomId);
    parsed.searchParams.set("aavid", accountId);
    if (context.anchorId) parsed.searchParams.set("anchorId", context.anchorId);
    if (!parsed.searchParams.get("fromModule")) parsed.searchParams.set("fromModule", "uni_promotion_v2");
    return parsed.toString();
  } catch {
    return "";
  }
}

function buildTaskCenterUrl(accountId, context = {}) {
  const params = new URLSearchParams({ aavid: accountId });
  const today = shanghaiDate();
  if (context.adId) params.set("adId", context.adId);
  params.set("dr", `${today},${today}`);
  params.set("uniDetail", "{}");
  const hashParams = new URLSearchParams();
  hashParams.set("dut", `${today} ${shanghaiTime()}`);
  hashParams.set("uniDetail", JSON.stringify({ tb: "uni_task_center", edc: "liveRace", cst: "0" }));
  return `https://qianchuan.jinritemai.com/uni-prom/detail?${params.toString()}#${hashParams.toString()}`;
}

function taskCenterUrlFromSource(sourceUrl, accountId) {
  try {
    const parsed = new URL(sourceUrl);
    if (!parsed.hostname.includes("qianchuan.jinritemai.com")) return "";
    const context = extractAdContextFromUrl(sourceUrl);
    const today = shanghaiDate();
    parsed.pathname = "/uni-prom/detail";
    parsed.searchParams.set("aavid", accountId);
    parsed.searchParams.set("uniDetail", "{}");
    parsed.searchParams.set("dr", `${today},${today}`);
    if (context.adId) parsed.searchParams.set("adId", context.adId);

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
    hashParams.set("dut", `${today} ${shanghaiTime()}`);
    hashParams.set("uniDetail", JSON.stringify(detail));
    parsed.hash = hashParams.toString();
    return parsed.toString();
  } catch {
    return "";
  }
}

function shanghaiDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shanghaiTime(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function hasAdContext(url, adId = "") {
  const context = extractAdContextFromUrl(url);
  if (!context.adId) return false;
  return !adId || context.adId === String(adId);
}

module.exports = {
  buildLiveScreenUrl,
  buildTaskCenterUrl,
  extractAdContextFromUrl,
  extractLiveContextFromUrl,
  findAdContextFromState,
  findLiveContextFromState,
  hasAdContext,
  shanghaiDate,
  taskCenterUrlFromSource,
};
