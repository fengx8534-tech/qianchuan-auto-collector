const LEVEL_WEIGHT = { ok: 0, warn: 1, error: 2 };

function normalizeLevel(value) {
  return value === "error" ? "error" : value === "warn" || value === "warning" ? "warn" : "ok";
}

function engineeringIssueKey(item = {}, tabs = {}) {
  const reason = String(item.reason || "");
  const missing = Array.isArray(tabs.missing) ? tabs.missing : [];
  if (reason.includes("board_live_context_missing")) return "live_screen_context";
  if (item.name === "tabs" && missing.includes("liveScreen")) return "live_screen_context";
  return String(item.name || item.label || reason || "unknown");
}

function summarizeEngineeringHealth(collectors = [], tabs = {}) {
  const candidates = collectors
    .filter((item) => normalizeLevel(item.level) !== "ok")
    .map((item) => ({ ...item, level: normalizeLevel(item.level) }));
  const tabsLevel = normalizeLevel(tabs.level);
  if (tabsLevel !== "ok") {
    candidates.push({ name: "tabs", label: "采集页", level: tabsLevel, reason: tabs.message || "采集页异常" });
  }

  const grouped = new Map();
  candidates.forEach((item) => {
    const key = engineeringIssueKey(item, tabs);
    const previous = grouped.get(key);
    if (!previous || LEVEL_WEIGHT[item.level] > LEVEL_WEIGHT[previous.level]) grouped.set(key, { ...item, name: key });
  });
  if (grouped.has("live_screen_context")) {
    const issue = grouped.get("live_screen_context");
    grouped.set("live_screen_context", {
      ...issue,
      name: "live_screen_context",
      label: "直播大屏",
      reason: "缺少直播大屏上下文，影响大屏和趋势采集",
    });
  }

  const issues = Array.from(grouped.values());
  const warnCount = issues.filter((item) => item.level === "warn").length;
  const errorCount = issues.filter((item) => item.level === "error").length;
  const okCount = collectors.filter((item) => normalizeLevel(item.level) === "ok").length + (tabsLevel === "ok" ? 1 : 0);
  return {
    level: errorCount ? "error" : warnCount ? "warn" : "ok",
    score: Math.max(0, Math.round(100 - warnCount * 8 - errorCount * 20)),
    issues,
    alerts: issues
      .filter((item) => item.level === "error")
      .map((item) => ({ level: "error", name: item.name, msg: `${item.label || item.name}：${item.reason || "异常"}` })),
    summary: { ok: okCount, warn: warnCount, error: errorCount },
  };
}

module.exports = { summarizeEngineeringHealth };
