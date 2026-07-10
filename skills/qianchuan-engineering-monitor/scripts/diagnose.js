#!/usr/bin/env node

const BASE_URL = process.env.QIANCHUAN_DASHBOARD_URL || "http://127.0.0.1:8788";

function icon(level = "ok") {
  if (level === "error") return "🔴";
  if (level === "warn" || level === "warning") return "🟡";
  return "🟢";
}

function ageText(ms) {
  if (!Number.isFinite(Number(ms))) return "--";
  const minutes = Math.max(0, Math.round(Number(ms) / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.round(minutes / 60)}小时`;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    cache: "no-store",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function collectorLine(collectors = []) {
  const icons = collectors.map((item) => icon(item.level)).join("");
  const problems = collectors
    .filter((item) => item.level !== "ok")
    .map((item) => `${item.label}${item.reason ? ` ${item.reason}` : ""}${item.ageMs ? `，${ageText(item.ageMs)}未更新` : ""}`);
  return `采集器: ${icons}${problems.length ? ` (${problems.join("；")})` : " (全部正常)"}`;
}

function suggestionFor(item = {}) {
  const commands = {
    board_collect: "curl -s -X POST http://127.0.0.1:8788/api/board-collect/run",
    board_trend: "curl -s -X POST http://127.0.0.1:8788/api/board-trend/run -H 'content-type:application/json' -d '{\"granularity\":5}'",
    plan_collect: "curl -s -X POST http://127.0.0.1:8788/api/plan-collect/run",
    hourly_collect: "curl -s -X POST http://127.0.0.1:8788/api/visual/collect-hourly",
    task_collect: "curl -s -X POST http://127.0.0.1:8788/api/task-collect/run",
    material_collect: "curl -s -X POST http://127.0.0.1:8788/api/material-collect/run",
    tabs: "curl -s -X POST http://127.0.0.1:8788/api/tabs/init",
  };
  return commands[item.name] || "";
}

function dedupeAlerts(alerts = []) {
  const seen = new Set();
  return alerts.filter((alert) => {
    const key = `${alert.level || ""}:${alert.msg || alert.name || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  let autoFix = null;
  try {
    autoFix = await request("/api/health-check/auto-fix", { method: "POST", body: "{}" });
  } catch (error) {
    console.error(`自动修复: 🔴 ${error.message}`);
  }

  const health = await request("/api/health-check");
  console.log(collectorLine(health.collectors || []));

  const alerts = dedupeAlerts([
    ...((autoFix && Array.isArray(autoFix.alerts)) ? autoFix.alerts : []),
    ...((health && Array.isArray(health.alerts)) ? health.alerts : []),
  ]);
  if (alerts.length) {
    alerts.slice(0, 8).forEach((alert) => {
      console.log(`告警: ${icon(alert.level)} ${alert.msg || alert.name || "--"}`);
    });
  } else {
    console.log("告警: 🟢 暂无");
  }

  const unhealthy = [
    ...((health.collectors || []).filter((item) => item.level !== "ok")),
    ...(health.tabs?.level === "ok" ? [] : [{ name: "tabs", label: "采集页", reason: health.tabs?.message }]),
  ];
  const suggestions = unhealthy.map(suggestionFor).filter(Boolean);
  if (autoFix?.fixed?.length) console.log(`自动修复: ${autoFix.fixed.join(", ")}`);
  if (autoFix?.skipped?.length) console.log(`跳过: ${autoFix.skipped.map((item) => `${item.name}:${item.reason}`).join(", ")}`);
  console.log(suggestions.length ? `修复建议: ${suggestions[0]}` : "修复建议: 当前无需手动修复");
}

main().catch((error) => {
  console.error(`诊断失败: ${error.message}`);
  process.exitCode = 1;
});
