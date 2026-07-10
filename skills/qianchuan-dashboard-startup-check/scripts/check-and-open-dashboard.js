#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");

const BACKEND = process.env.QIANCHUAN_BACKEND_URL || "http://127.0.0.1:8788";
const CDP = process.env.QIANCHUAN_CDP_URL || "http://127.0.0.1:9222";
const DASHBOARD_URL = `${BACKEND}/preview.html`;

const args = new Set(process.argv.slice(2));
const shouldOpen = args.has("--open");
const shouldInitTabs = args.has("--init-tabs");
const asJson = args.has("--json");
const strictOpen = args.has("--strict-open");

function usage() {
  console.log([
    "Usage:",
    "  node skills/qianchuan-dashboard-startup-check/scripts/check-and-open-dashboard.js --open",
    "  node skills/qianchuan-dashboard-startup-check/scripts/check-and-open-dashboard.js --init-tabs --open",
    "",
    "Options:",
    "  --open       Open preview.html when critical checks pass.",
    "  --init-tabs  Ask backend to open missing read-only Qianchuan tabs.",
    "  --json       Print JSON instead of a human summary.",
    "  --strict-open  With --open, only open preview.html when every check has no failures or warnings.",
  ].join("\n"));
}

if (args.has("-h") || args.has("--help")) {
  usage();
  process.exit(0);
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function requestJson(url, options = {}) {
  const timeout = timeoutSignal(options.timeoutMs || 5000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: timeout.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  } finally {
    timeout.cancel();
  }
}

async function requestHead(url) {
  const timeout = timeoutSignal(5000);
  try {
    const response = await fetch(url, { method: "GET", signal: timeout.signal });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  } finally {
    timeout.cancel();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProbe(probe, isReady, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const intervalMs = options.intervalMs || 500;
  const startedAt = Date.now();
  let lastResult = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastResult = await probe();
    if (isReady(lastResult)) return lastResult;
    await sleep(intervalMs);
  }
  return lastResult;
}

function summarizeCollectStatus(payload, key) {
  const status = payload && payload[key] ? payload[key] : null;
  if (!status) return { status: "missing", running: false, detail: "missing status payload" };
  return {
    status: status.status || "unknown",
    running: Boolean(status.running),
    lastError: status.lastError || status.error || "",
    finishedAt: status.finishedAt || null,
    updatedAt: status.updatedAt || null,
    total: status.total,
    pointCount: status.pointCount,
  };
}

function analyzeTabs(tabs) {
  const pages = Array.isArray(tabs) ? tabs.filter((tab) => tab.type === "page") : [];
  const qianchuanPages = pages.filter((tab) => String(tab.url || "").includes("qianchuan.jinritemai.com"));
  const hasDetail = qianchuanPages.some((tab) => String(tab.url || "").includes("/uni-prom/detail") || String(tab.title || "").includes("投放管理"));
  const hasBoard = qianchuanPages.some((tab) => String(tab.url || "").includes("/board-next") || String(tab.title || "").includes("直播大屏"));
  return {
    pageCount: pages.length,
    qianchuanPageCount: qianchuanPages.length,
    hasDetail,
    hasBoard,
    titles: qianchuanPages.map((tab) => tab.title || tab.url).slice(0, 8),
  };
}

function pass(label, detail) {
  return { label, ok: true, detail };
}

function warn(label, detail) {
  return { label, ok: true, warning: true, detail };
}

function fail(label, detail) {
  return { label, ok: false, detail };
}

function marker(item) {
  if (!item.ok) return "[FAIL]";
  if (item.warning) return "[WARN]";
  return "[OK]";
}

function openDashboard() {
  if (process.env.QIANCHUAN_DASHBOARD_OPEN_DRY_RUN === "1") {
    return Promise.resolve({ ok: true, dryRun: true });
  }
  return new Promise((resolve) => {
    const child = spawn("open", [DASHBOARD_URL], { stdio: "ignore", detached: true });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function main() {
  const checks = [];
  let opened = null;

  const preview = shouldOpen
    ? await waitForProbe(() => requestHead(DASHBOARD_URL), (result) => result?.ok, { timeoutMs: 20000, intervalMs: 700 })
    : await requestHead(DASHBOARD_URL);
  checks.push(preview.ok ? pass("backend_preview", `HTTP ${preview.status} ${preview.contentType}`) : fail("backend_preview", preview.error || `HTTP ${preview.status}`));

  const dashboard = shouldOpen
    ? await waitForProbe(() => requestJson(`${BACKEND}/api/dashboard.php`), (result) => result?.ok && result.data?.ok !== false, { timeoutMs: 10000, intervalMs: 700 })
    : await requestJson(`${BACKEND}/api/dashboard.php`);
  checks.push(dashboard.ok && dashboard.data?.ok !== false ? pass("backend_state", `HTTP ${dashboard.status}`) : fail("backend_state", dashboard.error || `HTTP ${dashboard.status}`));

  const backendReadyToOpen = preview.ok && dashboard.ok && dashboard.data?.ok !== false;
  if (shouldOpen && !strictOpen && backendReadyToOpen) {
    opened = await openDashboard();
  }

  const secret = await requestJson(`${BACKEND}/api/secret/status`);
  if (!secret.ok) {
    checks.push(fail("ai_secret_status", secret.error || `HTTP ${secret.status}`));
  } else if (secret.data?.configured) {
    checks.push(pass("ai_secret_status", "configured"));
  } else {
    checks.push(warn("ai_secret_status", "not configured"));
  }

  const cdpVersion = shouldOpen
    ? await waitForProbe(() => requestJson(`${CDP}/json/version`), (result) => result?.ok && result.data?.Browser, { timeoutMs: 12000, intervalMs: 700 })
    : await requestJson(`${CDP}/json/version`);
  checks.push(cdpVersion.ok && cdpVersion.data?.Browser ? pass("cdp_version", cdpVersion.data.Browser) : fail("cdp_version", cdpVersion.error || `HTTP ${cdpVersion.status}`));

  const cdpList = await requestJson(`${CDP}/json/list`, { timeoutMs: 7000 });
  const tabInfo = analyzeTabs(cdpList.data);
  checks.push(cdpList.ok ? pass("cdp_tabs", `${tabInfo.qianchuanPageCount} Qianchuan page(s), ${tabInfo.pageCount} browser page(s)`) : fail("cdp_tabs", cdpList.error || `HTTP ${cdpList.status}`));

  if (cdpList.ok) {
    checks.push(tabInfo.qianchuanPageCount > 0 ? pass("qianchuan_tabs", tabInfo.titles.join(" | ") || "found") : fail("qianchuan_tabs", "no qianchuan.jinritemai.com pages"));
    checks.push(tabInfo.hasDetail ? pass("detail_tab", "投放管理/detail tab found") : fail("detail_tab", "missing 投放管理/detail tab"));
    checks.push(tabInfo.hasBoard ? pass("board_tab", "直播大屏 tab found") : fail("board_tab", "missing 直播大屏 tab"));
  }

  let initTabs = null;
  if (shouldInitTabs && preview.ok) {
    initTabs = await requestJson(`${BACKEND}/api/tabs/init`, { method: "POST", body: {}, timeoutMs: 15000 });
    checks.push(initTabs.ok && initTabs.data?.ok ? pass("init_tabs", JSON.stringify(initTabs.data.results || [])) : fail("init_tabs", initTabs.error || `HTTP ${initTabs.status}`));
  }

  const collectors = [
    ["task_collect", "/api/task-collect/status", "taskCollectStatus"],
    ["board_collect", "/api/board-collect/status", "boardCollectStatus"],
    ["board_trend", "/api/board-trend/status", "boardTrendCollectStatus"],
    ["plan_collect", "/api/plan-collect/status", "planCollectStatus"],
    ["material_collect", "/api/material-collect/status", "materialCollectStatus"],
    ["visual_capture", "/api/visual/status", "visualCapture"],
  ];

  const collectorResults = [];
  for (const [label, path, key] of collectors) {
    const result = await requestJson(`${BACKEND}${path}`);
    if (!result.ok) {
      checks.push(fail(label, result.error || `HTTP ${result.status}`));
      collectorResults.push({ label, ok: false, error: result.error || `HTTP ${result.status}` });
      continue;
    }
    const summary = summarizeCollectStatus(result.data, key);
    const hasHardError = summary.status === "error" || summary.status === "paused";
    const hasWarning = summary.status === "skipped" && Boolean(summary.lastError);
    const detail = `${summary.status}${summary.running ? " running" : ""}${summary.lastError ? `: ${summary.lastError}` : ""}`;
    checks.push(hasHardError ? fail(label, detail) : hasWarning ? warn(label, detail) : pass(label, detail));
    collectorResults.push({ label, ok: !hasHardError, warning: hasWarning, ...summary });
  }

  const criticalLabels = new Set(["backend_preview", "backend_state", "cdp_version", "cdp_tabs", "qianchuan_tabs"]);
  const criticalOk = checks.filter((item) => criticalLabels.has(item.label)).every((item) => item.ok);
  const hasFailure = checks.some((item) => !item.ok);
  const hasWarning = checks.some((item) => item.warning);
  const readyToOpen = criticalOk && !hasFailure && !hasWarning;
  if (shouldOpen && strictOpen && readyToOpen) opened = await openDashboard();

  const output = {
    ok: readyToOpen,
    criticalOk,
    hasFailure,
    hasWarning,
    dashboardUrl: DASHBOARD_URL,
    backend: BACKEND,
    cdp: CDP,
    strictOpen,
    backendReadyToOpen,
    checks,
    collectors: collectorResults,
    tabInfo,
    initTabs: initTabs?.data || null,
    opened,
  };

  if (asJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("千川调控台启动自检");
    console.log(`调控台: ${DASHBOARD_URL}`);
    console.log("");
    for (const item of checks) {
      console.log(`${marker(item)} ${item.label}: ${item.detail}`);
    }
    console.log("");
    if (opened?.ok) console.log(`[OK] 已打开调控台: ${DASHBOARD_URL}`);
    if (opened && !opened.ok) console.log(`[FAIL] 打开调控台失败: ${opened.error}`);
    if (opened?.ok && !readyToOpen) {
      console.log("自检仍有警告或非面板关键失败，已先打开本地调控台，请在面板/终端查看详情。");
    } else if (shouldOpen && hasWarning && !hasFailure) {
      console.log("存在警告，已按“一切没问题后再打开”的规则暂不自动打开调控台。");
    }
    if (!criticalOk || hasFailure) {
      console.log("关键检查未通过，未自动打开调控台。");
      console.log("后端启动: cd <PROJECT_ROOT>/local-backend && PORT=8788 node server.js");
      console.log("CDP 启动: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/qianchuan-cdp");
      console.log("若只是千川标签页缺失，可重跑并加 --init-tabs。");
    }
  }

  process.exit(readyToOpen || opened?.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
