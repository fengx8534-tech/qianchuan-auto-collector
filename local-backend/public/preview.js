const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
let controlMode = localStorage.getItem("controlMode") || "learning";
let currentView = localStorage.getItem("currentView") || "monitor";
let currentAiBatch = null;
let latestState = null;
let armedOnceRestoreTimer = null;
let aiMemoryLoaded = false;
let trendGranularity = localStorage.getItem("trendGranularity") || "5";
let sopDraft = null;
let sopSaveTimer = null;
let sopEditing = false;
let dingtalkEditing = false;
localStorage.removeItem("engineeringMonitorExpanded");
let engineeringMonitorExpanded = localStorage.getItem("engineeringMonitorExpandedV2") === "1";
let lastEngineeringAlertKey = "";
let lastEngineeringAlertAt = 0;
let engineeringPollRunning = false;
const ENGINEERING_POLL_INTERVAL_MS = 30000;
const ENGINEERING_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const ENGINEERING_MODAL_ALERT_NAMES = new Set([
  "tabs_init",
  "board_collect",
  "board_trend",
  "plan_collect",
  "hourly_collect",
  "task_collect",
]);

const DEFAULT_INVESTMENT_SOP = {
  category: "",
  targetRoi: null,
  boostRatioLimit: null,
  maxBudgetIncrease: null,
  roiStep: null,
  avgOrderValue: null,
  grossMargin: null,
  returnRate: null,
  openTime: "",
  closeTime: "",
  shiftTimes: [],
  scenarioRules: "",
  pauseCondition: "",
  increaseCondition: "",
  lowerRoiCondition: "",
  autonomousBoostRules: "",
  faq: [],
};

const COLLAPSE_KEYS = {
  taskHealth: "collapse:taskHealth",
  actions: "collapse:actions",
  aiLogs: "collapse:aiLogs",
  logs: "collapse:logs",
};

const ruleLabels = {
  live_window: "直播时段检查",
  snapshot_freshness: "快照时效",
  roi_drift_guard: "ROI漂移护栏",
  raise_roi_target: "提高ROI目标",
  lower_roi_target: "降低ROI目标",
  rule_throttle: "规则节流",
};

const pageLabels = {
  apiIntercept: "接口趋势采集",
  investOverview: "投放总览采集",
  investData: "投放数据采集",
  controlTable: "调控任务采集",
  hourlyDetail: "单小时明细采集",
  hourlyCollect: "单小时明细采集",
  liveScreen: "直播大屏采集",
  unknown: "未识别页面采集",
};

const sourceLabels = {
  totalTrend: "接口 totalTrend",
  assist: "接口 assist",
  materialLive: "接口 materialLive",
  api_roi2_log: "接口 roi2Log",
  visual_live_screen: "视觉大屏",
  visual_task_scan: "视觉任务扫描",
  metric_history: "小时差分",
  metric_history_base_delta: "基础消耗小时差分",
  hour_total_minus_base: "小时总耗-基础",
  hourly_detail_total_minus_base: "单小时总耗-基础",
  hourly_detail_base_only_dom: "单小时基础口径",
  boost_ratio_estimated: "按全天估算",
  derived_spend_ratio: "消耗差值计算",
  daily_review_fallback: "复盘兜底",
  invalid_mixed_source: "来源不一致",
  investOverview_dom: "总览 DOM",
  hourly_detail_dom: "单小时明细 DOM",
  api_hourly_trend: "接口单小时明细",
  api_total_trend_hourly: "接口整体小时趋势",
  plan_table_dom: "计划表 DOM",
  liveScreen_dom: "大屏 DOM",
  task_collector: "任务采集器",
};

const taskTypeLabels = {
  materialBoost: "素材放量/追投",
  materialCostControl: "素材控成本",
  oneClickLift: "一键起量",
  unknown: "未识别类型",
};

function $(id) { return document.getElementById(id); }
function normalizeAiDisplayText(value = "") {
  return String(value ?? "")
    .replace(/\bmaterialCostControl\b/g, "素材控成本")
    .replace(/\bmaterialBoost\b/g, "素材放量/追投")
    .replace(/\boneClickLift\b/g, "一键起量")
    .replace(/\btaskType\b/g, "任务类型")
    .replace(/\btargetRoi\b/g, "目标 ROI")
    .replace(/\bGPM\b/g, "千次观看成交金额")
    .replace(/\buserPayload\b/g, "系统输入")
    .replace(/\bshiftProtection\b/g, "换播保护")
    .replace(/\bfirstHourProtection\b/g, "首小时保护")
    .replace(/\bquadrant\b/g, "象限判断");
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function formatReasonHtml(value) {
  let text = escapeHtml(normalizeAiDisplayText(value || "--"));
  // Convert literal \n to real newlines (AI returns \\n in JSON strings)
  text = text.replace(/\\n/g, "\n");
  // Strip "AI建议(置信度X)：" prefix
  text = text.replace(/^AI建议\(置信度[^)]*\)[：:]\s*/, "");
  return `<pre class="reason-text">${text.replace(/(诊断|动作|预期|当前盘况|主要问题|建议方向)：/g, '<span class="reason-label">$1：</span>')}</pre>`;
}
function renderMarkdown(value = "") {
  const lines = escapeHtml(normalizeAiDisplayText(value)).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").split(/\n+/);
  let inList = false;
  const html = [];
  lines.forEach((line) => {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
    if (item) {
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${item[1]}</li>`);
      return;
    }
    if (inList) { html.push("</ul>"); inList = false; }
    if (line.trim()) html.push(`<p>${line}</p>`);
  });
  if (inList) html.push("</ul>");
  return html.join("");
}
function money(value) { return Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "--"; }
function ratio(value) { return Number.isFinite(value) ? value.toFixed(2) : "--"; }
function timeText(value) { return value ? new Date(value).toLocaleString("zh-CN") : "--"; }
function hhmm(value) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function hms(value) { return value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--"; }
function agoText(value) {
  if (!value) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  return seconds < 60 ? `${seconds}秒前` : `${Math.floor(seconds / 60)}分钟前`;
}

function sourceText(source = {}) {
  if (!source || !source.source) return "来源：未获取";
  const label = sourceLabels[source.source] || source.source;
  const status = source.status === "error" ? "失败" : "成功";
  return `来源：${label} · ${status} · ${agoText(source.receivedAt)}`;
}

function statusLabel(status) {
  return { pending_review: "待确认", ready_to_execute: "武装待确认", approved: "已确认", executing: "执行中", executed: "已执行", failed: "执行失败", rejected: "已拒绝", expired: "已过期", invalid: "未通过校验" }[status] || status || "--";
}

function actionTone(action) {
  if (["rejected", "expired", "failed", "invalid"].includes(action.status)) return "danger";
  if (["approved", "executed"].includes(action.status)) return "ready";
  if (action.status === "executing") return "warn";
  if (String(action.type || "").includes("raise")) return "warn";
  return String(action.type || "").includes("pause") ? "danger" : "ready";
}

function badge(text, tone = "") { return `<span class="badge ${tone}">${text}</span>`; }
function isExpanded(key) { return localStorage.getItem(COLLAPSE_KEYS[key]) === "expanded"; }
function setExpanded(key, value) { localStorage.setItem(COLLAPSE_KEYS[key], value ? "expanded" : "collapsed"); }
function configureToggle(id, key, total, visible) {
  const node = $(id);
  if (!node) return;
  const shouldShow = total > 0 && (total > visible || isExpanded(key));
  node.hidden = !shouldShow;
  node.textContent = isExpanded(key) ? "收起" : `展开全部 (共 ${total} 条)`;
  node.dataset.collapseKey = key;
}
function linePath(points) {
  if (points.length < 3) return points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const commands = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    commands.push(`Q ${current.x.toFixed(2)} ${current.y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`);
  }
  const last = points[points.length - 1];
  commands.push(`T ${last.x.toFixed(2)} ${last.y.toFixed(2)}`);
  return commands.join(" ");
}
async function getJson(url) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`${response.status}`); return response.json(); }
async function postJson(url, body = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `${response.status}`);
    error.detail = data.detail;
    error.payload = data;
    throw error;
  }
  return data;
}

function healthIcon(level = "ok") {
  if (level === "error") return "🔴";
  if (level === "warn" || level === "warning") return "🟡";
  return "🟢";
}

function healthTone(level = "ok") {
  if (level === "error") return "danger";
  if (level === "warn" || level === "warning") return "warn";
  return "ready";
}

function shortAge(ms) {
  if (!Number.isFinite(Number(ms))) return "--";
  const minutes = Math.max(0, Math.round(Number(ms) / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.round(minutes / 60)}小时`;
}

function renderEngineeringMonitor(health = {}, autoFix = null) {
  const panel = $("engineeringMonitorPanel");
  if (!panel) return;
  const level = health.level || "ok";
  const shouldExpand = engineeringMonitorExpanded;
  panel.classList.toggle("collapsed", !shouldExpand);
  panel.classList.remove("tone-ok", "tone-warn", "tone-error");
  panel.classList.add(`tone-${level}`);
  $("engineeringMonitorToggle").setAttribute("aria-expanded", shouldExpand ? "true" : "false");
  $("engineeringMonitorDot").textContent = level === "error" ? "●" : level === "warn" ? "●" : "●";
  $("engineeringMonitorScore").textContent = `${Number.isFinite(Number(health.score)) ? health.score : "--"} 分`;
  if ($("engineeringMonitorDetails")) $("engineeringMonitorDetails").textContent = shouldExpand ? "收起" : "展开详情";

  const collectors = Array.isArray(health.collectors) ? health.collectors : [];
  $("engineeringCollectorGrid").innerHTML = collectors.map((item) => `
    <div class="engineering-chip ${healthTone(item.level)}" title="${escapeHtml(item.reason || "")}">
      <span>${healthIcon(item.level)}</span>
      <strong>${escapeHtml(item.label || item.name)}</strong>
      <small>${item.running ? "运行中" : item.integrityStatus === "partial" ? "部分成功" : item.integrityStatus === "failed" ? "采集失败" : item.ageMs === null ? "--" : shortAge(item.ageMs)}</small>
    </div>
  `).join("");

  const alerts = [
    ...(Array.isArray(autoFix?.alerts) ? autoFix.alerts : []),
    ...(Array.isArray(health.alerts) ? health.alerts : []),
  ];
  const uniqueAlerts = [];
  const seen = new Set();
  alerts.forEach((alert) => {
    const key = `${alert.level}:${alert.msg}`;
    if (seen.has(key)) return;
    seen.add(key);
    uniqueAlerts.push(alert);
  });
  $("engineeringAlertList").innerHTML = uniqueAlerts.length
    ? uniqueAlerts.slice(0, 5).map((alert) => `<p class="${healthTone(alert.level)}">${healthIcon(alert.level)} ${escapeHtml(alert.msg || "--")}</p>`).join("")
    : `<p class="ready">🟢 全部采集路线正常</p>`;
  const fixedCount = Array.isArray(autoFix?.fixed) ? autoFix.fixed.length : 0;
  const skippedCount = Array.isArray(autoFix?.skipped) ? autoFix.skipped.length : 0;
  $("engineeringFixMeta").textContent = fixedCount || skippedCount
    ? `已自动修复 ${fixedCount} 项，跳过 ${skippedCount} 项`
    : `最近检查：${hms(health.checkedAt)}`;

  const initStatus = $("initTabsStatus");
  if (initStatus && health.tabs?.level === "ok") {
    initStatus.hidden = true;
    initStatus.textContent = "初始化完成：采集页已就绪";
  }

  const modalAlerts = uniqueAlerts.filter(isModalEngineeringAlert);
  if (level === "error" && modalAlerts.length) {
    const key = modalAlerts.map((item) => `${item.name || ""}:${item.msg || ""}`).join("|");
    const cooledDown = Date.now() - lastEngineeringAlertAt >= ENGINEERING_ALERT_COOLDOWN_MS;
    if (key && (key !== lastEngineeringAlertKey || cooledDown)) {
      lastEngineeringAlertKey = key;
      lastEngineeringAlertAt = Date.now();
      showEngineeringAlert(modalAlerts, fixedCount);
    }
  }
}

function isModalEngineeringAlert(alert = {}) {
  if (alert.level !== "error") return false;
  const name = String(alert.name || "");
  if (ENGINEERING_MODAL_ALERT_NAMES.has(name)) return true;
  return String(alert.msg || "").includes("工程监控不可用");
}

function showEngineeringAlert(alerts = [], fixedCount = 0) {
  const dialog = $("engineeringAlertDialog");
  if (!dialog) return;
  $("engineeringAlertBody").innerHTML = formatReasonHtml([
    `已自动修复 ${fixedCount} 项，以下需手动关注：`,
    ...alerts.slice(0, 8).map((item) => `- ${item.msg || "--"}`),
  ].join("\n"));
  if (!dialog.open) dialog.showModal();
}

async function pollEngineeringMonitor() {
  if (engineeringPollRunning) return;
  engineeringPollRunning = true;
  let autoFix = null;
  try {
    autoFix = await postJson("/api/health-check/auto-fix");
    const health = await getJson("/api/health-check");
    renderEngineeringMonitor(health, autoFix);
  } catch (error) {
    renderEngineeringMonitor({
      level: "error",
      score: 0,
      checkedAt: Date.now(),
      collectors: [],
      metrics: [],
      alerts: [{ level: "error", msg: `工程监控不可用：${error.message}` }],
    }, autoFix);
  } finally {
    engineeringPollRunning = false;
  }
}

function friendlyError(error) {
  const raw = String(error?.message || error || "");
  const detail = error?.detail || error?.payload?.detail || {};
  if (raw === "boost_ratio_guard") {
    const boostRatio = Number(detail.boostRatio);
    const boostRatioLimit = Number(detail.boostRatioLimit || 28);
    return Number.isFinite(boostRatio)
      ? `当前追投占比 ${ratio(boostRatio)}% 已达到/超过 ${ratio(boostRatioLimit)}% 安全线，系统禁止新建追投或一键起量。请先暂停低效追投，等占比回落后再新建。`
      : "当前追投占比已超过安全线，系统禁止新建追投或一键起量。请先暂停低效追投，等占比回落后再新建。";
  }
  if (raw === "duplicate_pending_action") return "同一任务已有待确认动作，请直接确认上方已有动作，不需要重复生成。";
  if (raw === "active_action_limit") return "当前待确认动作已达到上限，请先处理上方待确认动作后再生成新的调控动作。";
  if (raw === "action_cooldown") return "同一任务刚生成过动作，仍在冷却期。请先处理已有动作，或稍后再试。";
  if (raw === "action_dedup_or_throttled") return "动作被去重或冷却拦截。通常是同一任务已有待确认动作，或当前待确认动作过多。";
  const map = {
    task_not_in_current_scan: "任务 ID 不在当前已采集任务列表中。请先点“采集素材追投”或“采集一键起量”，确认该任务出现在任务健康度里，再执行。",
    action_expired: "动作已过期，请重新让 AI 生成暂停建议。",
    action_too_old: "动作生成超过 5 分钟，请重新生成后再执行。",
    action_not_approved: "动作还没有进入可执行状态，请先确认动作。",
    already_executed: "这条动作已经执行过了。",
    hourly_execute_limit_reached: "最近 1 小时执行次数已达上限。",
    missing_task_id: "动作缺少任务 ID，不能执行。",
    action_not_found: "动作不存在，可能页面数据已刷新。",
    budget_input_not_found: "已打开千川编辑弹窗，但未找到预算输入框。请保留该弹窗并重新采集后再试。",
    duration_input_not_found: "已打开千川编辑弹窗，但未找到时长输入框。请保留该弹窗并重新采集后再试。",
    roi_input_not_found: "已打开千川编辑弹窗，但未找到 ROI 输入框。请保留该弹窗并重新采集后再试。",
    action_target_not_found_or_not_clickable: "执行器未能定位任务行或对应操作按钮。请先重新采集任务后再试。",
    confirm_dialog_not_visible: "千川确认弹窗没有识别到，请确认任务按钮可见后重试。",
    task_row_not_found: "执行器没有在当前千川页面找到对应任务行，请先打开对应任务页并重新采集。",
    material_id_not_found: "千川素材选择页未找到所选素材。请刷新素材库后重新筛选，再预览。",
    materials_not_added_to_create_form: "素材未被带入千川新建表单。请重新预览；系统已停止在提交前，不会创建空素材任务。",
    confirm_material_picker: "素材选择页未找到确认按钮，未继续提交。",
  };
  return map[raw] || raw || "未知错误";
}

function isLiveNow(config = {}, date = new Date()) {
  const toMin = (v) => { const [h, m] = String(v || "00:00").split(":").map(Number); return h * 60 + m; };
  const now = date.getHours() * 60 + date.getMinutes(), open = toMin(config.openTime), close = toMin(config.closeTime);
  return open <= close ? now >= open && now <= close : now >= open || now <= close;
}

function liveDurationText(config = {}, date = new Date()) {
  const [h, m] = String(config.openTime || "06:00").split(":").map(Number);
  const start = new Date(date); start.setHours(h, m, 0, 0);
  if (date < start) start.setDate(start.getDate() - 1);
  const mins = Math.max(0, Math.floor((date - start) / 60000));
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
}

function liveDayStartMs(config = {}, date = new Date()) {
  const toMin = (value) => {
    const [h, m] = String(value || "00:00").split(":").map(Number);
    return h * 60 + m;
  };
  const open = toMin(config.openTime || "06:00");
  const close = toMin(config.closeTime || "02:00");
  const now = date.getHours() * 60 + date.getMinutes();
  const start = new Date(date);
  start.setHours(Math.floor(open / 60), open % 60, 0, 0);
  if ((open > close && now < open) || (open <= close && now < open)) start.setDate(start.getDate() - 1);
  return start.getTime();
}

function trendPointTs(point = {}) {
  const raw = point.ts ?? point.timestamp ?? point.time;
  let ts = Number(raw);
  if (!Number.isFinite(ts)) ts = new Date(raw).getTime();
  if (!Number.isFinite(ts)) return null;
  return ts < 1000000000000 ? ts * 1000 : ts;
}

function trendBucketMinutes() {
  const value = Number(trendGranularity);
  return [1, 5, 30].includes(value) ? value : 5;
}

function inferTrendIntervalMinutes(points = []) {
  const diffs = points
    .map((point, index) => index > 0 ? trendPointTs(point) - trendPointTs(points[index - 1]) : null)
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.round(value / 60000));
  if (!diffs.length) return null;
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 2) return 1;
  if (median <= 10) return 5;
  return 30;
}

function trendIntervalMatches(points = [], expected = trendBucketMinutes(), declared = null) {
  const actual = inferTrendIntervalMinutes(points) || Number(declared) || Number(points[0]?.intervalMinutes) || null;
  if (!Number.isFinite(actual)) return false;
  if (expected === 1) return actual === 1;
  if (expected === 5) return actual >= 3 && actual <= 10;
  if (expected === 30) return actual >= 15;
  return false;
}

function metricNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestPendingAction(actions = []) {
  return actions.find((action) => action.status === "pending_review" || action.status === "ready_to_execute");
}

function normalizeSop(sop = {}) {
  const source = sop && typeof sop === "object" ? sop : {};
  return {
    ...DEFAULT_INVESTMENT_SOP,
    ...source,
    shiftTimes: Array.isArray(source.shiftTimes) && source.shiftTimes.length ? source.shiftTimes : DEFAULT_INVESTMENT_SOP.shiftTimes,
    faq: Array.isArray(source.faq) && source.faq.length
      ? source.faq.map((group) => ({
        category: group.category || "未分类",
        items: Array.isArray(group.items) ? group.items.map((item) => ({ q: item.q || "", a: item.a || "" })) : [],
      }))
      : DEFAULT_INVESTMENT_SOP.faq.map((group) => ({ category: group.category, items: group.items.map((item) => ({ ...item })) })),
  };
}

function setSopSaveStatus(text, tone = "muted") {
  const node = $("sopSaveStatus");
  if (!node) return;
  node.textContent = text;
  node.className = `badge ${tone}`;
}

function setDingtalkConfigStatus(text, tone = "muted") {
  const node = $("dingtalkConfigStatus");
  if (!node) return;
  node.textContent = text;
  node.className = `badge ${tone}`;
}

function renderDingtalkConfig(config = {}) {
  if (!$("dingtalkConfigPanel")) return;
  if (dingtalkEditing && document.activeElement?.closest("#dingtalkConfigPanel")) return;
  const dingtalk = config.dingtalk || {};
  $("dingtalkWebhookInput").value = dingtalk.webhook || "";
  $("dingtalkSecretInput").value = "";
  $("dingtalkEnabledInput").checked = dingtalk.enabled === true;
  $("dingtalkNotifyCollectorError").checked = dingtalk.notifyCollectorError !== false;
  $("dingtalkNotifyAiSuggestion").checked = dingtalk.notifyAiSuggestion !== false;
  $("dingtalkNotifyActionResult").checked = dingtalk.notifyActionResult !== false;
  $("dingtalkNotifyHourlySummary").checked = dingtalk.notifyHourlySummary !== false;
  $("dingtalkNotifySystemAlert").checked = dingtalk.notifySystemAlert !== false;
  if (dingtalk.configured) setDingtalkConfigStatus(dingtalk.enabled ? "已启用" : "已保存，未启用", dingtalk.enabled ? "ready" : "warn");
  else setDingtalkConfigStatus("未配置", "muted");
}

function readDingtalkConfigForm() {
  return {
    enabled: $("dingtalkEnabledInput").checked,
    webhook: $("dingtalkWebhookInput").value.trim(),
    secret: $("dingtalkSecretInput").value.trim(),
    notifyCollectorError: $("dingtalkNotifyCollectorError").checked,
    notifyAiSuggestion: $("dingtalkNotifyAiSuggestion").checked,
    notifyActionResult: $("dingtalkNotifyActionResult").checked,
    notifyHourlySummary: $("dingtalkNotifyHourlySummary").checked,
    notifySystemAlert: $("dingtalkNotifySystemAlert").checked,
  };
}

async function saveDingtalkConfig() {
  setDingtalkConfigStatus("保存中", "warn");
  try {
    const data = await postJson("/api/dingtalk/config", readDingtalkConfigForm());
    if (latestState?.config) latestState.config.dingtalk = data.config;
    dingtalkEditing = false;
    renderDingtalkConfig(latestState?.config || { dingtalk: data.config });
    const gitText = data.gitSync?.ok ? (data.gitSync.changed ? "，已同步 Git" : "，Git 已是最新") : "，Git 同步失败";
    setDingtalkConfigStatus(`${data.config?.enabled ? "已保存并启用" : "已保存"}${gitText}`, data.gitSync?.ok === false ? "warn" : (data.config?.enabled ? "ready" : "muted"));
  } catch (error) {
    setDingtalkConfigStatus(`保存失败：${error.message}`, "danger");
  }
}

async function sendDingtalkTest() {
  setDingtalkConfigStatus("发送中", "warn");
  try {
    await postJson("/api/dingtalk/test");
    setDingtalkConfigStatus("测试消息已发送", "ready");
  } catch (error) {
    setDingtalkConfigStatus(`发送失败：${error.message}`, "danger");
  }
}

function renderInvestmentSop(config = {}) {
  if (!$("sopPage")) return;
  if (sopEditing && document.activeElement?.closest("#sopPage")) return;
  sopDraft = normalizeSop(config.investmentSop || {});
  $("sopCategory").value = sopDraft.category || "";
  $("sopTargetRoi").value = sopDraft.targetRoi ?? "";
  $("sopBoostRatioLimit").value = sopDraft.boostRatioLimit ?? "";
  $("sopMaxBudgetIncrease").value = sopDraft.maxBudgetIncrease ?? "";
  $("sopRoiStep").value = sopDraft.roiStep ?? "";
  $("sopAvgOrderValue").value = sopDraft.avgOrderValue ?? "";
  $("sopGrossMargin").value = sopDraft.grossMargin ?? "";
  $("sopReturnRate").value = sopDraft.returnRate ?? "";
  if ($("sopProfitModelText")) $("sopProfitModelText").value = sopDraft.profitModelText || "";
  $("sopOpenTime").value = sopDraft.openTime || "";
  $("sopCloseTime").value = sopDraft.closeTime || "";
  $("sopShiftTimes").value = (sopDraft.shiftTimes || []).join(" ");
  $("sopScenarioRules").value = sopDraft.scenarioRules || "";
  $("sopPauseCondition").value = sopDraft.pauseCondition || "";
  $("sopIncreaseCondition").value = sopDraft.increaseCondition || "";
  $("sopLowerRoiCondition").value = sopDraft.lowerRoiCondition || "";
  if ($("sopAutonomousBoostRules")) $("sopAutonomousBoostRules").value = sopDraft.autonomousBoostRules || "";
  renderSopFaq();
  renderDingtalkConfig(config);
  setSopSaveStatus("已同步", "muted");
}

async function loadInvestmentSopConfig() {
  const data = await getJson("/api/config");
  const config = data.config || {};
  if (latestState) latestState.config = { ...(latestState.config || {}), ...config };
  renderInvestmentSop(config);
}

function renderSopFaq() {
  const list = $("sopFaqList");
  if (!list || !sopDraft) return;
  list.innerHTML = (sopDraft.faq || []).map((group, groupIndex) => `
    <details class="sop-faq-group" open>
      <summary>
        <input data-sop-faq-category="${groupIndex}" value="${escapeHtml(group.category || "")}" aria-label="问题分类" />
        <button type="button" data-sop-add-question="${groupIndex}">添加问题</button>
      </summary>
      <div class="sop-faq-items">
        ${(group.items || []).map((item, itemIndex) => `
          <div class="sop-faq-item">
            <label>Q<input data-sop-faq-q="${groupIndex}:${itemIndex}" value="${escapeHtml(item.q || "")}" /></label>
            <label>排查路径<textarea data-sop-faq-a="${groupIndex}:${itemIndex}" rows="2">${escapeHtml(item.a || "")}</textarea></label>
            <button type="button" data-sop-remove-question="${groupIndex}:${itemIndex}">删除</button>
          </div>
        `).join("")}
      </div>
    </details>
  `).join("");
}

function readOptionalSopNumber(id) {
  const value = $(id)?.value.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSopForm() {
  const draft = normalizeSop(sopDraft || latestState?.config?.investmentSop || {});
  draft.category = $("sopCategory")?.value.trim() || "";
  draft.targetRoi = readOptionalSopNumber("sopTargetRoi");
  draft.boostRatioLimit = readOptionalSopNumber("sopBoostRatioLimit");
  draft.maxBudgetIncrease = readOptionalSopNumber("sopMaxBudgetIncrease");
  draft.roiStep = readOptionalSopNumber("sopRoiStep");
  draft.avgOrderValue = readOptionalSopNumber("sopAvgOrderValue");
  draft.grossMargin = readOptionalSopNumber("sopGrossMargin");
  draft.returnRate = readOptionalSopNumber("sopReturnRate");
  delete draft.profitModelText;
  delete draft.profitModel;
  draft.openTime = $("sopOpenTime")?.value || "";
  draft.closeTime = $("sopCloseTime")?.value || "";
  draft.shiftTimes = String($("sopShiftTimes")?.value || "").split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean);
  draft.scenarioRules = $("sopScenarioRules")?.value.trim() || "";
  draft.pauseCondition = $("sopPauseCondition")?.value.trim() || "";
  draft.increaseCondition = $("sopIncreaseCondition")?.value.trim() || "";
  draft.lowerRoiCondition = $("sopLowerRoiCondition")?.value.trim() || "";
  draft.autonomousBoostRules = $("sopAutonomousBoostRules")?.value.trim() || "";
  return draft;
}

async function saveInvestmentSop() {
  if (!$("sopPage")) return;
  sopDraft = readSopForm();
  setSopSaveStatus("保存中", "warn");
  try {
    const data = await postJson("/api/config", { investmentSop: sopDraft });
    if (latestState?.config) latestState.config = data.config || { ...latestState.config, investmentSop: sopDraft };
    sopEditing = false;
    const gitText = data.gitSync?.ok ? (data.gitSync.changed ? "，已同步 Git" : "，Git 已是最新") : "，Git 同步失败";
    setSopSaveStatus(`已自动保存${gitText}`, data.gitSync?.ok === false ? "warn" : "ready");
    renderAiConfig(latestState?.config || data.config || {});
  } catch (error) {
    setSopSaveStatus(`保存失败：${error.message}`, "danger");
  }
}

function queueSopSave(delay = 500) {
  sopEditing = true;
  setSopSaveStatus("待保存", "warn");
  if (sopSaveTimer) clearTimeout(sopSaveTimer);
  sopSaveTimer = setTimeout(saveInvestmentSop, delay);
}

function extractMaterialId(task = {}) {
  if (Array.isArray(task.materialIds) && task.materialIds[0]) return String(task.materialIds[0]);
  if (task.materialId) return String(task.materialId);
  const match = String(task.object || "").match(/素材ID[：:]\s*(\d+)/);
  return match?.[1] || null;
}

function materialObjectText(task = {}) {
  const ids = Array.isArray(task.materialIds) ? task.materialIds.filter(Boolean) : [];
  if (ids.length) return `素材ID：${ids.slice(0, 2).join("、")}${ids.length > 2 ? "…" : ""}`;
  if (task.materialId) return `素材ID：${task.materialId}`;
  return String(task.object || "--").split("\n")[0];
}

function shortTaskId(value = "") {
  const text = String(value || "");
  return text.length > 6 ? text.slice(-6) : text;
}

function roundedMoney(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num).toLocaleString("zh-CN") : "--";
}

function renderStatusBar(state) {
  const config = state.config || {}, trend = selectTrendData(state);
  const lifecycle = state.liveLifecycle || {};
  const spend5m = state.fiveMinSpend ?? state.metrics?.fiveMinSpend ?? state.metrics?.flowSpeed ?? trend.at(-1)?.cost;
  const roi5m = spend5m && trend.at(-1)?.revenue ? ratio(Number(trend.at(-1).revenue) / Number(spend5m)) : null;
  $("liveStatus").textContent = lifecycle.status === "off_air" ? "⚫ 已下播" : lifecycle.status === "suspected_off_air" ? "🟠 疑似下播" : isLiveNow(config) ? "🟢 直播中" : "🔴 未开播";
  $("openTime").textContent = `开播时间：${config.openTime || "--"}`;
  $("liveDuration").textContent = `已直播：${liveDurationText(config)}`;
  $("statusFiveMinSpend").textContent = `最近 5 分钟：消耗 ${money(spend5m)} 元${roi5m ? "，ROI " + roi5m : ""}`;
  const pending = state.actions?.filter((a) => a.status === "pending_review" || a.status === "ready_to_execute").length || 0;
  $("currentAdvice").textContent = pending ? `${pending} 条待确认建议` : "暂无待确认建议";
}

function renderSystemStatus(state) {
  const config = state.config || {}, lastAi = state.lastAiCallAt, updated = state.updatedAt;
  const lifecycle = state.liveLifecycle || {};
  const stopped = lifecycle.status === "off_air";
  $("monitorStatus").textContent = stopped ? "■ 已下播停采" : config.aiEnabled ? "● 自动盯盘中" : "○ AI 已关";
  $("monitorStatus").className = stopped ? "status-warn" : config.aiEnabled ? "status-good" : "";
  $("lastCollectStatus").textContent = `最近采集：${hms(updated)}（${agoText(updated)}）`;
  $("lastAiStatus").textContent = `最近 AI 决策：${hms(lastAi)}（${agoText(lastAi)}）`;
  const left = lastAi ? Math.max(0, Math.ceil((config.aiMinIntervalMs - (Date.now() - lastAi)) / 60000)) : 0;
  $("nextAiStatus").textContent = stopped ? "下次 AI 决策：下播已停止" : config.aiEnabled ? `下次 AI 决策：约 ${left} 分钟后` : "下次 AI 决策：未开启";
  if (state.aiInProgress) {
    $("aiProgressStatus").innerHTML = `<span class="spinner"></span>AI 正在分析：${state.aiProgressStep || "读取数据中…"}`;
  } else if (stopped) {
    $("aiProgressStatus").textContent = isReviewForCurrentLiveDay(state) && state.dailyReview?.status === "ready" ? `复盘已生成：${state.dailyReview.dayKey}` : "已下播，等待生成复盘";
  } else {
    $("aiProgressStatus").textContent = "AI 待机";
  }
}

function renderAiStatusBar(state) {
  const bar = $("aiStatusBar");
  if (!bar) return;
  const config = state.config || {};
  const lifecycle = state.liveLifecycle || {};
  const stopped = lifecycle.status === "off_air";
  const aiOn = config.aiEnabled === true;
  const collectOn = config.aiAutoCollectEnabled !== false && config.autoCollectEnabled !== false;
  const dryRunOn = config.executorDryRun !== false;
  const actionMode = config.actionMode === "armed" ? "武装" : "审批";
  const pending = (state.actions || []).filter((action) => ["pending_review", "ready_to_execute", "approved", "executing"].includes(action.status)).length;
  const lastAi = state.lastAiCallAt;
  const interval = Number(config.aiMinIntervalMs || 300000);
  const nextMs = lastAi ? Math.max(0, interval - (Date.now() - new Date(lastAi).getTime())) : 0;
  const nextText = !aiOn ? "不会自动决策" : stopped ? "下播已停止" : lastAi ? `约 ${Math.ceil(nextMs / 60000)} 分钟后` : "等待首次触发";
  let tone = "off";
  let title = "AI 盯盘：已关闭";
  if (state.aiInProgress) {
    tone = "running";
    title = "AI 盯盘：分析中";
  } else if (stopped) {
    tone = "paused";
    title = "AI 盯盘：下播停用";
  } else if (aiOn) {
    tone = dryRunOn ? "on" : "danger";
    title = dryRunOn ? "AI 盯盘：已开启" : "AI 盯盘：已开启，真点放行";
  }

  bar.className = `ai-status-bar tone-${tone}`;
  $("aiStatusTitle").textContent = title;
  $("aiStatusDetail").textContent = `最近决策：${hms(lastAi)}（${agoText(lastAi)}） · 下次：${nextText}`;
  $("aiStatusCollect").textContent = `采集：${collectOn ? "自动" : "关闭"}`;
  $("aiStatusCollect").className = `ai-status-pill ${collectOn ? "ready" : "muted"}`;
  $("aiStatusAction").textContent = `执行：${actionMode}`;
  $("aiStatusAction").className = `ai-status-pill ${config.actionMode === "armed" ? "warn" : "muted"}`;
  $("aiStatusDryRun").textContent = `dryRun：${dryRunOn ? "开启" : "关闭"}`;
  $("aiStatusDryRun").className = `ai-status-pill ${dryRunOn ? "ready" : "danger"}`;
  $("aiStatusPending").textContent = `待确认：${pending}`;
  $("aiStatusPending").className = `ai-status-pill ${pending ? "warn" : "muted"}`;
  const stopBtn = $("stopAiMonitorBtn");
  if (stopBtn) {
    stopBtn.disabled = !aiOn && dryRunOn;
    stopBtn.textContent = aiOn || !dryRunOn ? "关闭盯盘" : "已关闭";
  }
}

function taskCollectStepText(detail = {}, step) {
  const value = detail.stepStatus?.[step];
  if (value === "ok") return `<span class="task-collect-ok">✅</span>`;
  if (value === "pending") return `<span class="muted">—</span>`;
  if (!value) return `<span class="muted">—</span>`;
  return `<span class="task-collect-error">❌ ${escapeHtml(String(value).replace(/_/g, " "))}</span>`;
}

function renderTaskCollectStatus(status = {}) {
  const bar = $("taskCollectBar");
  if (!bar) return;
  const running = status.running === true;
  const paused = status.paused === true;
  const completed = Number(status.completed || 0);
  const total = Number(status.total || 0);
  const hasDetails = Array.isArray(status.details) && status.details.length > 0;
  const done = !running && !paused && total > 0 && completed >= total;
  const empty = status.status === "empty";
  const errorText = String(status.lastError || "");
  const failed = status.status === "failed" || (!running && !paused && Boolean(errorText));
  const retrying = running && /超时|重试|timeout/i.test(errorText);
  const error = failed || (paused && /连续3个任务失败|异常|失败/.test(errorText));
  if (!running && !paused && !done && !hasDetails && !failed && !empty) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.classList.remove("status-running", "status-retrying", "status-paused", "status-done", "status-error");
  const tone = error ? "status-error" : retrying ? "status-retrying" : running ? "status-running" : (done || empty) ? "status-done" : "status-paused";
  bar.classList.add(tone);
  const icon = error ? "🔴" : retrying ? "🟡" : running ? "🟢" : (done || empty) ? "✅" : "⚪";
  const current = status.stepLabel || status.currentStep || "";
  const title = error
    ? `任务采集失败：${escapeHtml(errorText || "等待下轮自动重试")}`
    : retrying
      ? `任务采集卡住：${escapeHtml(errorText)}`
      : running
        ? `任务采集：${completed}/${total || "--"} 完成`
        : done
          ? `任务采集完成：${completed}/${total}`
          : empty
            ? "任务采集完成：当前未采集到调控任务"
          : `任务采集暂停：${completed}/${total || "--"}`;
  $("taskCollectIcon").textContent = icon;
  $("taskCollectText").innerHTML = title;
  $("taskCollectMeta").textContent = current ? `当前：${current}${status.currentTaskName ? ` · ${status.currentTaskName}` : ""}` : "";
  const details = $("taskCollectDetails");
  const rows = (status.details || []).map((detail) => {
    const rowStatus = detail.status === "complete" ? `<span class="task-collect-ok">完整</span>`
      : detail.status === "partial" ? `<span class="task-collect-warn">部分成功</span>`
        : detail.status === "failed" ? `<span class="task-collect-error">失败</span>` : escapeHtml(detail.status || "进行中");
    return `<tr>
      <td>${escapeHtml(detail.taskName || detail.taskId || "--")}</td>
      <td>${taskCollectStepText(detail, "oneclick_lift")}</td>
      <td>${taskCollectStepText(detail, "material_boost")}</td>
      <td>${rowStatus}</td>
    </tr>`;
  }).join("");
  const warnings = (status.warnings || []).map((item) => `<p class="task-collect-warn">${escapeHtml(item)}</p>`).join("");
  details.innerHTML = rows
    ? `<table class="task-collect-table">
        <thead><tr><th>任务</th><th>一键起量</th><th>素材追投</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>${warnings}`
    : `<p class="muted">暂无任务采集详情</p>`;
}

function renderMetrics(state) {
  const metrics = state.metrics || {}, assist = state.assistMetrics || {};
  const sources = state.metricSources || {};
  $("metricCost").textContent = money(metrics.overallCost);
  $("metricRoi").textContent = ratio(metrics.overallRoi ?? metrics.currentHourRoi);
  $("metricRevenue").textContent = money(metrics.dealAmount);
  $("metricOrders").textContent = money(assist.orderCount);
  $("metricOrderCost").textContent = money(assist.orderCost);
  $("metricBaseSpend").textContent = money(metrics.baseSpend);
  $("metricGpm").textContent = money(metrics.gpm);
  $("metricBoostRatio").textContent = Number.isFinite(metrics.boostRatio) ? `${ratio(metrics.boostRatio)}%` : "--";
  $("metricCurrentHourRoi").textContent = ratio(metrics.currentHourRoi);
  $("metricCurrentHourCost").textContent = money(metrics.currentHourCost);
  $("metricWatchDealRate").textContent = Number.isFinite(metrics.watchDealRate) ? `${ratio(metrics.watchDealRate)}%` : "--";
  $("metricHourSegmentBaseSpend").textContent = money(metrics.hourSegmentBaseSpend);
  $("metricHourSegmentBoostRatio").textContent = Number.isFinite(metrics.hourSegmentBoostRatio) ? `${ratio(metrics.hourSegmentBoostRatio)}%` : "--";
  $("metricTotalViewers").textContent = Number.isFinite(metrics.totalViewers) ? metrics.totalViewers.toLocaleString("zh-CN") : "--";
  $("metricOnlineCount").textContent = Number.isFinite(metrics.onlineCount) ? String(metrics.onlineCount) : "--";
  $("metricExposureWatchRate").textContent = Number.isFinite(metrics.exposureWatchRate) ? `${ratio(metrics.exposureWatchRate)}%` : "--";
  $("metricCostSource").textContent = sourceText(sources.overallCost);
  $("metricRoiSource").textContent = sourceText(sources.overallRoi);
  $("metricRevenueSource").textContent = sourceText(sources.dealAmount);
  $("metricOrdersSource").textContent = sourceText(sources.orderCount);
  $("metricOrderCostSource").textContent = sourceText(sources.orderCost);
  $("metricBaseSpendSource").textContent = sourceText(sources.baseSpend);
  $("metricGpmSource").textContent = sourceText(sources.gpm);
  $("metricBoostRatioSource").textContent = sourceText(sources.boostRatio);
  $("metricCurrentHourRoiSource").textContent = sourceText(sources.currentHourRoi);
  $("metricCurrentHourCostSource").textContent = sourceText(sources.currentHourCost);
  $("metricWatchDealRateSource").textContent = sourceText(sources.watchDealRate);
  $("metricHourSegmentBaseSpendSource").textContent = sourceText(sources.hourSegmentBaseSpend);
  $("metricHourSegmentBoostRatioSource").textContent = sourceText(sources.hourSegmentBoostRatio);
  $("metricTotalViewersSource").textContent = sourceText(sources.totalViewers);
  $("metricOnlineCountSource").textContent = sourceText(sources.onlineCount);
  $("metricExposureWatchRateSource").textContent = sourceText(sources.exposureWatchRate);
  $("metricOrdersSource").classList.toggle("source-error", sources.orderCount?.status === "error");
  $("metricOrderCostSource").classList.toggle("source-error", sources.orderCost?.status === "error");
  $("metricCurrentHourRoiSource").classList.toggle("source-error", sources.currentHourRoi?.status === "error");
  $("metricCurrentHourCostSource").classList.toggle("source-error", sources.currentHourCost?.status === "error");
  $("metricHourSegmentBaseSpendSource").classList.toggle("source-error", sources.hourSegmentBaseSpend?.status === "error");
  $("metricHourSegmentBoostRatioSource").classList.toggle("source-error", sources.hourSegmentBoostRatio?.status === "error");
  $("updatedAt").textContent = `更新 ${timeText(state.updatedAt)}`;
}

function renderAiConfig(config = {}) {
  $("aiEnabledInput").checked = config.aiEnabled === true;
  if ($("aiAutoCollectInput")) $("aiAutoCollectInput").checked = config.aiAutoCollectEnabled !== false && config.autoCollectEnabled !== false;
  if ($("targetRoiInput")) $("targetRoiInput").value = String(config.targetRoi || 6.5);
  $("aiModelInput").value = config.aiModel || "deepseek-v4-pro";
  $("aiIntervalInput").value = String(config.aiMinIntervalMs || 300000);
  renderAiTakeover(config);
  renderArmedOncePanel(config);
}

function isAiTakeoverOn(config = {}) {
  return config.aiEnabled === true && config.actionMode === "review" && config.executorDryRun === false;
}

function renderAiTakeover(config = {}) {
  const button = $("aiTakeoverBtn"), status = $("aiTakeoverStatus");
  if (!button || !status) return;
  const enabled = isAiTakeoverOn(config);
  button.textContent = enabled ? "关闭 AI 全盘接管" : "AI 全盘接管测试";
  button.classList.toggle("active", enabled);
  status.textContent = enabled ? "待确认真点" : config.executorDryRun === false ? "真点已开" : "待开启";
  status.className = enabled ? "badge warn" : config.executorDryRun === false ? "badge ready" : "badge muted";
}

function stopArmedOnceCountdown() {
  if (armedOnceRestoreTimer) clearInterval(armedOnceRestoreTimer);
  armedOnceRestoreTimer = null;
}

function renderArmedOncePanel(config = {}) {
  const panel = $("armed-once-panel"), button = $("btn-armed-once"), status = $("armed-once-status");
  if (!panel || !button || !status) return;
  const dryRunOn = config.executorDryRun !== false;
  panel.style.display = "";
  button.hidden = !dryRunOn;
  if (dryRunOn) {
    if (armedOnceRestoreTimer) {
      stopArmedOnceCountdown();
      status.textContent = "已自动恢复 dryRun";
    } else if (!status.textContent.includes("已自动恢复")) {
      status.textContent = "";
    }
  } else if (!armedOnceRestoreTimer) {
    status.textContent = "⚠️ dryRun 已关闭，等待执行";
  }
}

function startArmedOnceCountdown(seconds = 30) {
  const status = $("armed-once-status");
  if (!status) return;
  stopArmedOnceCountdown();
  let left = seconds;
  const render = () => {
    status.textContent = `⚠️ dryRun 已关闭，等待执行；${left} 秒后自动恢复`;
  };
  render();
  armedOnceRestoreTimer = setInterval(async () => {
    left -= 1;
    if (left > 0) {
      render();
      return;
    }
    stopArmedOnceCountdown();
    try {
      await postJson("/api/config", { executorDryRun: true });
      if (latestState?.config) latestState.config.executorDryRun = true;
      status.textContent = "已自动恢复 dryRun";
      await refresh();
    } catch (error) {
      status.textContent = `恢复失败：${error.message}`;
    }
  }, 1000);
}

async function enableArmedOnce() {
  if (!confirm("确认关闭 dryRun 执行一次真点？此操作将真实点击千川页面。")) return;
  const status = $("armed-once-status");
  try {
    await postJson("/api/config", { executorDryRun: false });
    if (latestState?.config) latestState.config.executorDryRun = false;
    startArmedOnceCountdown();
    await refresh();
  } catch (error) {
    if (status) status.textContent = `开启失败：${error.message}`;
  }
}

async function toggleAiTakeover() {
  const enabled = isAiTakeoverOn(latestState?.config || {});
  if (!enabled && !confirm("开启后 AI 会生成可真实点击的动作，但每次执行前仍需要你确认。确认开启？")) return;
  const status = $("aiTakeoverStatus");
  try {
    const patch = enabled
      ? { aiEnabled: false, actionMode: "review", executorDryRun: true }
      : { aiEnabled: true, actionMode: "review", executorDryRun: false };
    await postJson("/api/config", patch);
    controlMode = enabled ? "learning" : "auto";
    localStorage.setItem("controlMode", controlMode);
    localStorage.setItem("aiTakeoverDisabled", enabled ? "1" : "0");
    if (status) status.textContent = enabled ? "已关闭" : "待确认真点";
    await refresh();
  } catch (error) {
    if (status) status.textContent = `切换失败：${error.message}`;
  }
}

function renderVisualCapture(visual = null) {
  const badgeNode = $("visualStatusBadge");
  if (!visual) {
    badgeNode.textContent = "未运行";
    badgeNode.className = "badge muted";
    $("visualTitle").textContent = "等待连接浏览器";
    $("visualMeta").textContent = "用于补足接口采集缺口，目前只读取页面和截图，不执行投放动作。";
    $("autoCollectStatus").textContent = "分路线采集：等待运行";
    $("visualResult").textContent = "等待补采";
    return;
  }
  const isAutoCollect = String(visual.mode || "").startsWith("auto_collect");
  badgeNode.textContent = visual.status === "ok" ? (isAutoCollect ? "已分路线采集" : "已补采") : visual.status === "running" ? "补采中" : visual.status === "skipped" ? "已停采" : "连接失败";
  badgeNode.className = visual.status === "ok" ? "badge ready" : visual.status === "running" || visual.status === "skipped" ? "badge warn" : "badge danger";
  $("visualTitle").textContent = visual.title || (visual.status === "running" ? "正在连接浏览器" : "未识别到页面");
  $("visualMeta").textContent = visual.status === "skipped" ? `自动采集已跳过：${visual.reason || "--"}` : visual.status === "ok" ? "只读模式 · 数据已采集" : (visual.error || "只读模式");
  const hints = (visual.detectedHints || []).length ? visual.detectedHints.join("、") : "未识别到订单数/订单成本相关文字";
  const scan = visual.taskScan || {};
  const taskCount = scan.tasks?.length || 0;
  const hourlyCount = visual.hourlyBreakdown?.rows?.length || visual.pages?.reduce((sum, page) => sum + (page.hourlyRows?.length || 0), 0) || 0;
  const autoPages = (visual.pages || []).map((page) => {
    const mark = page.error ? "失败" : "成功";
    const count = page.tasks?.length ? ` · 任务 ${page.tasks.length} 条` : "";
    const hourly = page.hourlyRows?.length ? ` · 时段 ${page.hourlyRows.length} 条` : "";
    const refreshed = page.watchdogRefresh ? ` · 已刷新重试${page.watchdogReason ? `(${escapeHtml(page.watchdogReason)})` : ""}` : "";
    return `<span>${mark} ${escapeHtml(page.label || pageLabels[page.pageType] || page.pageType || "--")}${count}${hourly}${refreshed}${page.error ? ` · ${escapeHtml(page.error)}` : ""}</span>`;
  }).join("");
  const routeLabels = { overall: "整体指标", control: "调控任务", materialBoost: "素材追投", oneClickLift: "一键起量", hourly: "单小时明细", material: "素材详情" };
  const routeLabel = routeLabels[visual.route] || "分路线";
  const materialText = visual.materialRotation
    ? `<span>素材轮询：${visual.materialRotation.ok ? "已触发" : escapeHtml(visual.materialRotation.error || "未触发")}</span>`
    : "";
  $("autoCollectStatus").innerHTML = isAutoCollect
    ? visual.status === "skipped"
      ? `分路线采集：已停采（${escapeHtml(visual.reason || "--")}）`
      : `${routeLabel}采集：${visual.collectedAt ? timeText(visual.collectedAt) : "--"}${autoPages || materialText ? `<div class="visual-summary">${autoPages}${materialText}</div>` : ""}`
    : "分路线采集：等待运行";
  const tabs = (visual.tabCandidates || []).length
    ? `<details><summary>识别到的千川页面</summary>${visual.tabCandidates.map((tab) => `<p>${tab.preferred ? "当前抓取：" : "候选："}${escapeHtml(tab.title || "--")} · ${escapeHtml(tab.url || "")}</p>`).join("")}</details>`
    : "";
  $("visualResult").innerHTML = visual.status === "ok"
    ? `<div class="visual-summary"><span>指标写回：${visual.metricsUpdated ? "已写入后台" : "未抽到可写入指标"}</span><span>任务扫描：${taskCount} 条</span>${hourlyCount ? `<span>单小时明细：${hourlyCount} 条</span>` : ""}${visual.screenshot ? `<a href="${visual.screenshot}" target="_blank" rel="noreferrer">打开截图</a>` : ""}</div>`
    : escapeHtml(visual.error || "等待补采");
}

async function refreshSecretStatus() {
  const data = await getJson("/api/secret/status");
  $("aiSecretStatus").textContent = data.configured ? "已配置 ✓" : "请先填 key";
  $("aiSecretStatus").className = data.configured ? "badge ready" : "badge warn";
  $("aiConfigCard").classList.toggle("warn", !data.configured);
  if (!data.configured) $("aiConfigCard").open = true;
}

function selectTrendData(state = {}) {
  const startAt = liveDayStartMs(state.config || {});
  const maxTs = Date.now() + 10 * 60 * 1000;
  const expectedGranularity = trendBucketMinutes();
  const boardTrendGranularity = Number(state.boardTrend?.granularity);
  const boardTrendPoints = Array.isArray(state.boardTrend?.points) ? state.boardTrend.points : [];
  const currentLivePoints = (points = []) => {
    let previousVisualTotal = null;
    return points
    .map((point) => {
      const totalCost = metricNumber(point.totalCost);
      const totalRevenue = metricNumber(point.totalRevenue)
        ?? (Number.isFinite(totalCost) && Number.isFinite(metricNumber(point.roi))
          ? totalCost * metricNumber(point.roi)
          : null);
      const normalized = {
        ...point,
        ts: trendPointTs(point),
        cost: metricNumber(point.cost),
        revenue: metricNumber(point.revenue),
        totalCost,
        totalRevenue,
      };
      if (normalized.source === "visual_live_screen" && Number.isFinite(normalized.ts)) {
        const sampleMinutes = metricNumber(normalized.sampleMinutes)
          ?? (previousVisualTotal && Number.isFinite(normalized.totalCost)
            ? (normalized.ts - previousVisualTotal.ts) / 60000
            : null);
        if (!Number.isFinite(normalized.revenue)
          && Number.isFinite(totalRevenue)
          && Number.isFinite(previousVisualTotal?.totalRevenue)
          && Number.isFinite(sampleMinutes)
          && sampleMinutes >= 1.5
          && totalRevenue >= previousVisualTotal.totalRevenue) {
          normalized.revenue = (totalRevenue - previousVisualTotal.totalRevenue) / sampleMinutes * 5;
        }
        if (Number.isFinite(sampleMinutes) && sampleMinutes < 1.5) {
          normalized.cost = null;
          normalized.revenue = null;
        }
        if (Number.isFinite(normalized.totalCost) || Number.isFinite(totalRevenue)) {
          previousVisualTotal = { ts: normalized.ts, totalCost: normalized.totalCost, totalRevenue };
        }
      }
      return normalized;
    })
    .filter((point) => Number.isFinite(point.ts)
      && point.ts >= startAt
      && point.ts <= maxTs
      && (Number.isFinite(metricNumber(point.cost)) || Number.isFinite(metricNumber(point.revenue))))
    .sort((a, b) => a.ts - b.ts);
  };
  const directBoardTrend = currentLivePoints(boardTrendPoints)
    .map((point) => ({
      ...point,
      source: "qianchuan_board_trend",
      sourceGranularity: boardTrendGranularity || metricNumber(point.intervalMinutes) || 5,
    }));
  if (directBoardTrend.length && trendIntervalMatches(directBoardTrend, expectedGranularity, boardTrendGranularity)) return directBoardTrend;
  const apiTrend = currentLivePoints(state.trendData || []);
  const matchedApiTrend = trendIntervalMatches(apiTrend, expectedGranularity) ? apiTrend : [];
  const latestBoardCost = metricNumber(state.latestByPage?.liveScreen?.fields?.overallCost);
  if (expectedGranularity === 1) {
    if (matchedApiTrend.length) return matchedApiTrend;
    return currentLivePoints(state.visualTrend || [])
      .filter((point) => point.source === "visual_live_screen"
        && point.trendBasis === "liveScreen"
        && Number.isFinite(metricNumber(point.sampleMinutes))
        && metricNumber(point.sampleMinutes) <= 3.5
        && (!Number.isFinite(latestBoardCost)
          || !Number.isFinite(metricNumber(point.totalCost))
          || metricNumber(point.totalCost) <= latestBoardCost * 1.1))
      .map((point) => ({
        ...point,
        cost: Number.isFinite(metricNumber(point.cost)) ? metricNumber(point.cost) / 5 : null,
        revenue: Number.isFinite(metricNumber(point.revenue)) ? metricNumber(point.revenue) / 5 : null,
        sourceGranularity: 1,
        source: "visual_live_screen",
        estimatedMinute: true,
      }));
  }
  const allVisualTrend = currentLivePoints(state.visualTrend || [])
    .filter((point) => !Number.isFinite(latestBoardCost)
      || !Number.isFinite(metricNumber(point.totalCost))
      || metricNumber(point.totalCost) <= latestBoardCost * 1.1);
  const boardVisualTrend = allVisualTrend.filter((point) => point.trendBasis === "liveScreen");
  const visualTrend = (boardVisualTrend.length ? boardVisualTrend : allVisualTrend)
    .filter((point) => (Number.isFinite(metricNumber(point.cost)) && metricNumber(point.cost) > 0) || Number.isFinite(metricNumber(point.revenue)));
  const byMinute = new Map();
  [...visualTrend, ...matchedApiTrend].forEach((point) => {
    const minuteKey = Math.floor(point.ts / 60000) * 60000;
    const previous = byMinute.get(minuteKey);
    if (!previous) {
      byMinute.set(minuteKey, point);
      return;
    }
    const previousRevenue = metricNumber(previous.revenue);
    const pointRevenue = metricNumber(point.revenue);
    const preferPoint = Number.isFinite(pointRevenue) && (!Number.isFinite(previousRevenue) || point.source !== "visual_live_screen");
    byMinute.set(minuteKey, preferPoint ? { ...previous, ...point } : { ...point, ...previous });
  });
  return Array.from(byMinute.values()).sort((a, b) => a.ts - b.ts);
}

function aggregateTrendPoints(points = [], state = {}) {
  const bucketMinutes = trendBucketMinutes();
  const bucketMs = bucketMinutes * 60 * 1000;
  const startAt = liveDayStartMs(state.config || {});
  const buckets = new Map();
  points.forEach((point) => {
    const bucketIndex = Math.max(0, Math.floor((point.ts - startAt) / bucketMs));
    const bucketTs = startAt + bucketIndex * bucketMs;
    const bucket = buckets.get(bucketTs) || {
      ts: bucketTs,
      cost: 0,
      revenue: 0,
      costCount: 0,
      revenueCount: 0,
      source: point.source,
    };
    const cost = metricNumber(point.cost);
    const revenue = metricNumber(point.revenue);
    if (Number.isFinite(cost)) {
      bucket.cost += cost;
      bucket.costCount += 1;
    }
    if (Number.isFinite(revenue)) {
      bucket.revenue += revenue;
      bucket.revenueCount += 1;
    }
    if (point.source !== "visual_live_screen") bucket.source = point.source;
    buckets.set(bucketTs, bucket);
  });
  return Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      cost: bucket.costCount ? bucket.cost : null,
      revenue: bucket.revenueCount ? bucket.revenue : null,
    }))
    .filter((point) => Number.isFinite(metricNumber(point.cost)) || Number.isFinite(metricNumber(point.revenue)))
    .sort((a, b) => a.ts - b.ts);
}

function trendDisplayWindow(points = []) {
  const bucketMinutes = trendBucketMinutes();
  const maxPoints = bucketMinutes === 1 ? 30 : bucketMinutes === 5 ? 30 : 18;
  return points.length > maxPoints ? points.slice(-maxPoints) : points;
}

function renderTrendChart(state = {}) {
  document.querySelectorAll("[data-trend-granularity]").forEach((button) => {
    button.classList.toggle("active", button.dataset.trendGranularity === String(trendBucketMinutes()));
  });
  const selectedPoints = selectTrendData(state);
  const data = aggregateTrendPoints(selectedPoints, state);
  const rawPoints = data.filter((point) => Number.isFinite(metricNumber(point.cost)) || Number.isFinite(metricNumber(point.revenue)));
  const points = trendDisplayWindow(rawPoints);
  if (points.length < 1) { $("trendChart").innerHTML = `<div class="empty dark-empty">暂无数据</div>`; return; }
  const hasBoardTrend = selectedPoints.some((point) => point.source === "qianchuan_board_trend");
  const hasEstimatedMinute = selectedPoints.some((point) => point.estimatedMinute);
  const source = hasBoardTrend ? "千川大屏趋势" : hasEstimatedMinute ? "近实时估算趋势" : (points.some((point) => point.source !== "visual_live_screen") ? "接口趋势" : "视觉估算趋势");
  const sourceGranularity = selectedPoints.find((point) => Number.isFinite(metricNumber(point.sourceGranularity)))?.sourceGranularity;
  const bucketLabel = `${sourceGranularity || trendBucketMinutes()} 分钟粒度`;
  const chartNode = $("trendChart");
  const width = Math.max(920, Math.round((chartNode?.clientWidth || 1180) - 36));
  const height = 380, pad = { l: 84, r: 92, t: 56, b: 64 };
  const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
  const valueOf = metricNumber;
  const costs = points.map((p) => valueOf(p.cost)).filter(Number.isFinite);
  const revenues = points.map((p) => valueOf(p.revenue)).filter(Number.isFinite);
  const maxCost = Math.max(...costs, 1);
  const maxRevenue = Math.max(...revenues, 1);
  const gap = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i) => points.length > 1 ? pad.l + gap * i : pad.l + plotW / 2;
  const yCost = (value) => pad.t + plotH - (Math.max(0, Number(value || 0)) / maxCost) * plotH;
  const yRevenue = (value) => pad.t + plotH - (Math.max(0, Number(value || 0)) / maxRevenue) * plotH;
  const costLine = points.map((p, i) => ({ x: x(i), y: yCost(p.cost) })).filter((point, i) => Number.isFinite(valueOf(points[i].cost)));
  const revenueLine = points.map((p, i) => ({ x: x(i), y: yRevenue(p.revenue) })).filter((point, i) => Number.isFinite(valueOf(points[i].revenue)));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const bucketMinutes = trendBucketMinutes();
  const labelEvery = bucketMinutes === 1 ? 3 : bucketMinutes === 5 ? 3 : 1;
  const showTimeLabel = (index) => index === 0 || index === points.length - 1 || index % labelEvery === 0;
  chartNode.innerHTML = `<div class="chart-legend"><span>${source} · ${bucketLabel}</span><span class="legend cost"></span>综合成本（元）<span class="legend revenue"></span>净成交金额（元）</div>
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="trend-svg" role="img">
      <line x1="${pad.l}" y1="${pad.t + plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" class="axis"/>
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" class="axis"/>
      <line x1="${pad.l + plotW}" y1="${pad.t}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" class="axis"/>
      ${ticks.map((r) => `<line x1="${pad.l}" y1="${pad.t + plotH - r * plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH - r * plotH}" class="grid"/><text x="${pad.l - 8}" y="${pad.t + plotH - r * plotH + 4}" text-anchor="end" class="tick">${money(maxCost * r)}</text><text x="${pad.l + plotW + 8}" y="${pad.t + plotH - r * plotH + 4}" class="tick">${money(maxRevenue * r)}</text>`).join("")}
      <text x="${pad.l}" y="${pad.t - 14}" class="axis-label">综合成本</text>
      <text x="${pad.l + plotW}" y="${pad.t - 14}" text-anchor="end" class="axis-label">净成交金额</text>
      ${costLine.length > 1 ? `<path d="${linePath(costLine)}" class="trend-line cost-line"/>` : ""}
      ${revenueLine.length > 1 ? `<path d="${linePath(revenueLine)}" class="trend-line revenue-line"/>` : ""}
      ${points.map((p, i) => {
        const cx = x(i), cost = valueOf(p.cost), revenue = valueOf(p.revenue);
        const roi = cost > 0 && Number.isFinite(revenue) ? revenue / cost : null;
        const timeLabel = hhmm(p.ts);
        const tipW = 208, tipH = 92;
        const tipX = cx > width - tipW - 36 ? cx - tipW - 18 : Math.max(6, Math.min(width - tipW - 6, cx + 18));
        const dotYs = [Number.isFinite(cost) ? yCost(cost) : null, Number.isFinite(revenue) ? yRevenue(revenue) : null].filter(Number.isFinite);
        const tipY = Math.max(8, Math.min(height - tipH - 8, Math.min(...dotYs, pad.t + plotH) - tipH - 8));
        return `<g class="trend-point">
          <line x1="${cx}" y1="${pad.t}" x2="${cx}" y2="${pad.t + plotH}" class="hover-line"/>
          ${Number.isFinite(cost) ? `<circle cx="${cx}" cy="${yCost(cost)}" r="4.5" class="cost-dot hover-dot"/>` : ""}
          ${Number.isFinite(revenue) ? `<circle cx="${cx}" cy="${yRevenue(revenue)}" r="4.5" class="revenue-dot hover-dot"/>` : ""}
          <rect x="${cx - Math.max(12, gap / 2)}" y="${pad.t}" width="${Math.max(24, gap)}" height="${plotH}" class="hover-hit"/>
          <g class="chart-tooltip" transform="translate(${tipX} ${tipY})">
            <rect width="${tipW}" height="${tipH}" rx="6"/>
            <text x="12" y="22">时间：${timeLabel}</text>
            <text x="12" y="42">综合成本：${money(cost)}</text>
            <text x="12" y="62">净成交金额：${money(revenue)}</text>
            <text x="12" y="82">ROI：${ratio(roi)}</text>
          </g>
          ${showTimeLabel(i) ? `<text x="${cx}" y="${pad.t + plotH + 24}" text-anchor="middle" class="tick">${hhmm(p.ts)}</text>` : ""}
        </g>`;
      }).join("")}
    </svg>`;
}

function reviewMetric(label, value, tone = "") {
  return `<article class="review-metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "--")}</strong></article>`;
}

function isReviewForCurrentLiveDay(state = {}) {
  const review = state.dailyReview || null;
  const liveDayKey = state.liveLifecycle?.dayKey;
  return !!review && (!liveDayKey || review.dayKey === liveDayKey);
}

function renderDailyReview(state = {}) {
  const section = $("dailyReviewSection");
  const badge = $("dailyReviewBadge");
  const body = $("dailyReviewBody");
  const review = state.dailyReview || null;
  const isOffAir = state.liveLifecycle?.status === "off_air";
  const isCurrentReview = isReviewForCurrentLiveDay(state);
  if ((!review || !isCurrentReview) && !isOffAir) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (!review || !isCurrentReview) {
    const dayKey = state.liveLifecycle?.dayKey || "--";
    badge.textContent = `${dayKey} 未生成`;
    badge.className = "badge warn";
    body.innerHTML = `<div class="empty">当前直播日复盘未生成${review?.dayKey ? `；历史复盘 ${escapeHtml(review.dayKey)} 已保留，未用于今天看板` : ""}</div>`;
    return;
  }
  const m = review.metrics || {};
  const tasks = review.tasks || {};
  const coverage = review.dataCoverage || {};
  const notes = Array.isArray(review.notes) ? review.notes : [];
  badge.textContent = review.status === "ready" ? `${review.dayKey || "--"} 已生成` : "生成中";
  badge.className = review.status === "ready" ? "badge ready" : "badge warn";
  body.innerHTML = `
    <div class="daily-review-grid">
      ${reviewMetric("总消耗", `${money(m.totalCost)} 元`)}
      ${reviewMetric("成交金额", `${money(m.dealAmount)} 元`)}
      ${reviewMetric("综合 ROI", ratio(m.overallRoi), Number(m.overallRoi) < Number(state.config?.targetRoi || 6.5) ? "warn" : "good")}
      ${reviewMetric("基础消耗", `${money(m.baseSpend)} 元`)}
      ${reviewMetric("追投消耗", `${money(m.boostSpend)} 元`)}
      ${reviewMetric("追投占比", Number.isFinite(Number(m.boostRatio)) ? `${ratio(Number(m.boostRatio))}%` : "--", Number(m.boostRatio) >= 40 ? "warn" : "")}
      ${reviewMetric("观看人数", money(m.totalViewers))}
      ${reviewMetric("观看成交率", Number.isFinite(Number(m.watchDealRate)) ? `${ratio(Number(m.watchDealRate))}%` : "--")}
      ${reviewMetric("峰值 5 分钟消耗", `${money(m.maxFiveMinSpend)} 元`)}
    </div>
    <div class="daily-review-block">
      <h3>复盘结论</h3>
      ${notes.length ? `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : `<div class="empty">暂无明显异常信号</div>`}
    </div>
    <div class="daily-review-block compact">
      <span>任务明细：${tasks.total || 0} 条，调控中 ${tasks.active || 0} 条</span>
      <span>数据覆盖：接口快照 ${coverage.snapshots || 0} 条，视觉采集 ${coverage.visualCaptures || 0} 次，趋势点 ${coverage.trendPoints || 0} 个</span>
      ${review.file ? `<a href="${escapeHtml(review.file)}" target="_blank" rel="noreferrer">打开原始复盘 JSON</a>` : ""}
    </div>
  `;
}

function taskName(task = {}) {
  return task.name ? String(task.name).split("\n")[0] : "";
}

function roiTone(roi, target) {
  if (!Number.isFinite(roi) || !Number.isFinite(target)) return "";
  if (roi >= target * 1.2) return "good";
  if (roi < target * 0.5) return "bad";
  return "neutral";
}

function isRegulationTaskType(type = "") {
  return ["materialBoost", "materialCostControl", "oneClickLift"].includes(type);
}

function isActiveRegulationTask(task = {}) {
  return String(task.status || "").includes("调控中");
}

function isVisualPageNoiseTask(task = {}, state = {}) {
  const taskId = String(task.taskId || task.id || "").trim();
  const name = String(task.name || task.taskName || "").trim();
  const text = `${name} ${task.rawText || ""}`;
  if (taskId && taskId === String(state.config?.expectedAccountId || "")) return true;
  const pageNoise = /首页\s*乘方|千川可用余额|千川日预算|授权待处理|计划ID[：:\s]*\d{8,}|抖音号ID[：:\s]*\d{8,}/.test(text);
  if (!pageNoise) return false;
  return !/^20\d{6}_/.test(name);
}

function shouldDisplayTask(task = {}, state = {}) {
  if (isVisualPageNoiseTask(task, state)) return false;
  if (!isRegulationTaskType(task.taskType || "")) return true;
  return isActiveRegulationTask(task);
}

function taskGroupEmptyText(state = {}, key = "", rawGroupTasks = []) {
  if (!["materialBoost", "materialCostControl", "oneClickLift"].includes(key)) return "未采集到";
  const now = Date.now();
  const freshTaskSource = state.taskSource?.receivedAt && now - state.taskSource.receivedAt < 10 * 60 * 1000;
  if (freshTaskSource && rawGroupTasks.length) return "当前未做调控动作";
  const routeHealth = state.visualRouteHealth?.[key] || {};
  const routeFresh = routeHealth.lastAttemptAt && now - routeHealth.lastAttemptAt < 10 * 60 * 1000;
  if (routeFresh && routeHealth.status === "ok" && Number(routeHealth.lastCount || 0) === 0) return "当前未做调控动作";
  if (freshTaskSource && state.taskSource?.status === "empty") return "当前未做调控动作";
  return "未采集到";
}

function renderTaskHealth(state) {
  const rawTasks = (state.metrics?.tasks || []);
  const tasks = rawTasks.filter((task) => shouldDisplayTask(task, state));
  const target = Number(state.config?.targetRoi || 6.5);
  const taskSource = state.taskSource || {};
  const stale = !taskSource.receivedAt || Date.now() - taskSource.receivedAt > 10 * 60 * 1000;
  const collectedCount = Number.isFinite(Number(taskSource.collectedCount ?? taskSource.count)) ? Number(taskSource.collectedCount ?? taskSource.count) : rawTasks.length;
  const filteredCount = Number.isFinite(Number(taskSource.filteredCount)) ? Number(taskSource.filteredCount) : Math.max(0, collectedCount - rawTasks.length);
  const filterText = filteredCount > 0 ? ` · 历史过滤 ${filteredCount} 条` : "";
  const taskQualityPartial = taskSource.qualityStatus === "partial";
  $("taskSourceBadge").textContent = taskSource.status === "ok"
    ? `调控中 ${tasks.length} 条 · 本轮采集 ${collectedCount} 条${filterText} · ${taskQualityPartial ? `部分成功（${taskSource.partialCount || 0} 项明细缺失）` : stale ? "可能旧" : "新鲜"}`
    : "未采集到任务";
  $("taskSourceBadge").className = taskSource.status === "ok" && !stale && !taskQualityPartial ? "badge ready" : taskSource.status === "empty" || taskQualityPartial ? "badge warn" : "badge muted";
  $("taskSourceMeta").innerHTML = taskSource.receivedAt
    ? `来源：${sourceLabels[taskSource.source] || taskSource.source || "--"} · ${agoText(taskSource.receivedAt)}${taskSource.message ? ` · ${escapeHtml(taskSource.message)}` : ""}`
    : "来源：等待打开素材调控/一键起量页面后采集";
  if (!rawTasks.length) {
    configureToggle("taskHealthToggle", "taskHealth", 0, 0);
    $("taskHealthList").innerHTML = `<div class="empty">暂无调控任务数据。请在 CDP Chrome 打开素材调控或一键起量页面后执行视觉补采。</div>`;
    return;
  }
  const rawGroups = rawTasks.reduce((acc, task) => {
    const key = task.taskType || "unknown";
    (acc[key] ||= []).push(task);
    return acc;
  }, {});
  const groups = tasks.reduce((acc, task) => {
    const key = task.taskType || "unknown";
    (acc[key] ||= []).push(task);
    return acc;
  }, {});
  // Active regulation tasks are operational data, so do not hide a fourth task
  // behind a generic list collapse. Every active task must be visible at once.
  const visibleCount = tasks.length;
  configureToggle("taskHealthToggle", "taskHealth", tasks.length, visibleCount);
  $("taskHealthList").innerHTML = Object.entries(taskTypeLabels).map(([key, label]) => {
    const rawGroupTasks = rawGroups[key] || [];
    const allGroupTasks = groups[key] || [];
    const groupTasks = allGroupTasks;
    if (!groupTasks.length) return `<section class="task-group empty-group"><h3>${label}</h3><div class="empty">${taskGroupEmptyText(state, key, rawGroupTasks)}</div></section>`;
    return `<section class="task-group"><h3>${label}<span>${groupTasks.length}${groupTasks.length < allGroupTasks.length ? `/${allGroupTasks.length}` : ""} 条</span></h3>
      <table class="task-table">
        <thead><tr><th>任务</th><th>任务ID/对象</th><th>ROI</th><th>消耗/预算</th><th>成交</th><th>操作</th></tr></thead>
        <tbody>${groupTasks.map((task) => renderTaskCard(task, target)).join("")}</tbody>
      </table>
    </section>`;
  }).join("");
}

function renderTaskCard(task, target) {
  const spend = Number(task.spend), budget = Number(task.budget), roi = Number(task.roi);
  const progress = Number.isFinite(spend) && Number.isFinite(budget) && budget > 0 ? Math.min(100, Math.max(0, spend / budget * 100)) : 0;
  const shortName = (task.name || task.taskId || "--").replace(/^20\d{6}_/, "").replace(/ ID: \d+$/, "");
  const taskId = task.taskId || task.id || "";
  const mids = Array.isArray(task.materialIds) ? task.materialIds.filter(Boolean).map(String) : [];
  let objectText, objectTitle;
  if (taskId && ["materialBoost", "materialCostControl", "oneClickLift"].includes(task.taskType || "")) {
    objectText = taskId;
    objectTitle = `任务ID：${taskId}`;
  } else if (mids.length === 1) {
    objectText = mids[0];
    objectTitle = mids[0];
  } else if (mids.length > 1) {
    objectText = mids.join("\n");
    objectTitle = mids.join(", ");
  } else {
    objectText = String(task.object || "--").split("\n")[0];
    objectTitle = task.object || "";
  }
  const objectHtml = taskId && ["materialBoost", "materialCostControl", "oneClickLift"].includes(task.taskType || "")
    ? `<span class="task-id-pill">${escapeHtml(taskId)}</span>`
    : mids.length > 1
    ? mids.map((id) => `<div class="material-id">${escapeHtml(id)}</div>`).join("")
    : escapeHtml(objectText);
  const statusText = String(task.status || "");
  const isActive = statusText.includes("调控中");
  const isPaused = statusText.includes("暂停");
  const isEnded = statusText.includes("已完成") || statusText.includes("已结束");
  return `<tr class="task-row ${isPaused ? "task-paused" : ""} ${isEnded ? "task-ended" : ""}">
    <td class="task-name" title="${escapeHtml(task.name || "")}">${escapeHtml(shortName)}</td>
    <td class="task-object" title="${escapeHtml(objectTitle)}">${objectHtml}</td>
    <td class="task-roi-cell ${roiTone(roi, target)}">${ratio(roi)}</td>
    <td><div class="task-progress"><div class="task-progress-fill" style="width:${progress}%"></div><span>${money(spend)}/${money(budget)}</span></div></td>
    <td>${money(Number(task.dealAmount))}</td>
    <td class="task-actions">
      <button class="task-btn task-btn-budget" data-task-action="budget" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(task.name || "")}">加预算</button>
      <button class="task-btn task-btn-duration" data-task-action="duration" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(task.name || "")}">延时长</button>
      <button class="task-btn task-btn-roi" data-task-action="roi" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(task.name || "")}">改ROI</button>
      ${isActive ? `<button class="task-btn task-btn-pause" data-task-action="pause" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(task.name || "")}">暂停</button>` : ""}
      <button class="task-btn task-btn-stop" data-task-action="end" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(task.name || "")}">结束</button>
    </td>
  </tr>`;
}

function findActionTask(action, state) {
  const tasks = state.metrics?.tasks || [], payload = action.payload || {};
  return tasks.find((task) => String(task.taskId || task.id || "") === String(payload.taskId || "")
    || String(task.name || "").includes(payload.taskId || "")
    || task.name === payload.taskName) || {};
}

function actionSummary(action, task, targetRoi) {
  const payload = action.payload || {}, budget = Number(task.budget), nextBudget = Number(payload.budget), increase = Number(payload.budgetIncrease);
  if (action.type === "increase_task_budget" && Number.isFinite(nextBudget)) return `<strong class="action-suggestion ready">追加预算：${Number.isFinite(increase) ? `+${money(increase)} 元，` : ""}原 ${money(budget)} → 新 ${money(nextBudget)}</strong>`;
  if (action.type === "decrease_task_budget" && Number.isFinite(nextBudget)) return `<strong class="action-suggestion warn">建议预算：原 ${money(budget)} → 新 ${money(nextBudget)}</strong>`;
  if (action.type === "extend_task_duration") return `<strong class="action-suggestion ready">建议时长：延长到 ${escapeHtml(payload.durationHours || payload.newDurationHours || "--")} 小时</strong>`;
  if (action.type === "change_roi_target") return `<strong class="action-suggestion warn">建议 ROI：改到 ${escapeHtml(payload.targetRoi || payload.roi || "--")}</strong>`;
  if (action.type === "adjust_task_budget_duration") return `<strong class="action-suggestion ready">建议预算/时长：${Number.isFinite(increase) ? `追加 +${money(increase)} 元，` : ""}${Number.isFinite(nextBudget) ? `新预算 ${money(nextBudget)}，` : ""}时长 ${escapeHtml(payload.durationHours || payload.newDurationHours || "--")} 小时</strong>`;
  if (action.type === "pause_task") return `<strong class="action-suggestion danger">建议立即暂停</strong>`;
  if (action.type === "end_task") return `<strong class="action-suggestion danger">建议结束任务</strong>`;
  if (action.type === "create_boost_task") return `<strong class="action-suggestion ready">新建追投：素材 ${escapeHtml(payload.materialId || "--")}，预算 ${money(Number(payload.budget))}</strong>`;
  if (action.type === "create_oneclick_task") return `<strong class="action-suggestion ready">新建一键起量：预算 ${money(Number(payload.budget))}</strong>`;
  if (action.type === "raise_roi_target") { const next = Number(payload.targetRoi ?? payload.roi); const prev = Number(payload.previousTargetRoi); return `<strong class="action-suggestion warn">建议目标 ROI${Number.isFinite(prev) ? `：原 ${ratio(prev)} →` : "："} 新 ${ratio(next)}</strong>`; }
  if (action.type === "lower_roi_target") { const next = Number(payload.targetRoi ?? payload.roi); const prev = Number(payload.previousTargetRoi); return `<strong class="action-suggestion ready">建议目标 ROI${Number.isFinite(prev) ? `：原 ${ratio(prev)} →` : "："} 新 ${ratio(next)}</strong>`; }
  return `<strong class="action-suggestion">${escapeHtml(actionTypeLabels[action.type] || action.type)}</strong>`;
}

function canReview(action) { return ["pending_review", "ready_to_execute"].includes(action.status); }
function canExecute(action) { return action.status === "approved"; }
function canCancel(action) { return action.status === "approved"; }
function isCreateAction(action = {}) { return ["create_boost_task", "create_oneclick_task"].includes(action.type); }
function needsRealCreateConfirm(action = {}) { return isCreateAction(action) && action.execution?.dryRun === true && action.execution?.ok === true; }
function renderActions(actions = [], state = {}) {
  const activeStatuses = ["pending_review", "approved", "ready_to_execute"];
  const activeActions = actions.filter((action) => activeStatuses.includes(action.status));
  const visibleActions = isExpanded("actions") ? actions.slice(0, 20) : (activeActions.length ? activeActions.slice(0, 5) : actions.slice(0, 3));
  configureToggle("actionListToggle", "actions", actions.length, visibleActions.length);
  $("actionList").innerHTML = visibleActions.length ? visibleActions.map((action) => {
    const typeLabel = actionTypeLabels[action.type] || action.type;
    return `
    <article class="action-item">
      <div class="action-title"><strong>${escapeHtml(typeLabel)}</strong>${badge(statusLabel(action.status), actionTone(action))}</div>
      ${(() => {
        const task = findActionTask(action, state), target = Number(state.config?.targetRoi || 6.5), spend = Number(task.spend), budget = Number(task.budget), progress = Number.isFinite(spend) && Number.isFinite(budget) && budget > 0 ? Math.min(100, spend / budget * 100) : 0;
        const tid = task.taskId || task.id || action.payload?.taskId || "";
        return `<div class="action-facts"><span>任务：${escapeHtml(taskName(task) || action.payload?.taskName || "--")}${tid ? `（任务ID：${escapeHtml(tid)}）` : ""}</span><span>ROI：<b class="${roiTone(Number(task.roi), target)}">${ratio(Number(task.roi))}</b> / 目标 ${ratio(target)}</span><span>消耗：${money(spend)} / ${money(budget)}</span><div class="trend-bar"><div class="trend-fill" style="width:${progress}%"></div></div>${actionSummary(action, task, target)}</div>`;
      })()}
      ${formatReasonHtml(action.reason || "--")}
      <p>生成：${timeText(action.createdAt)} / 过期：${timeText(action.expiresAt)}</p>
      ${action.execution ? `<p>${action.execution.dryRun ? "DryRun" : "执行"}：${action.execution.ok ? "成功" : `失败：${escapeHtml(friendlyError(action.execution.error))}`}${action.execution.beforeScreenshot ? ` · <a href="${action.execution.beforeScreenshot}" target="_blank" rel="noreferrer">执行前截图</a>` : ""}${action.execution.afterScreenshot ? ` · <a href="${action.execution.afterScreenshot}" target="_blank" rel="noreferrer">执行后截图</a>` : ""}</p>` : ""}
      ${needsRealCreateConfirm(action) ? `<p class="action-warning">新建动作 dryRun 已通过。请确认截图和表单无误后，再点“二次确认真点”。</p>` : ""}
      ${action.payload?.validationError ? `<p class="action-error">校验失败：${escapeHtml(friendlyError(action.payload.validationError))}</p>` : ""}
      ${canReview(action) ? `<div class="action-buttons"><button type="button" data-action-id="${action.id}" data-review="approve">确认</button><button type="button" data-action-id="${action.id}" data-review="reject">拒绝</button></div>` : ""}
      ${canExecute(action) ? `<div class="action-buttons"><button type="button" data-action-id="${action.id}" data-execute="1" ${needsRealCreateConfirm(action) ? `data-force-real="1"` : ""}>${needsRealCreateConfirm(action) ? "二次确认真点" : "执行"}</button>${canCancel(action) ? `<button type="button" data-action-id="${action.id}" data-review="reject">取消</button>` : ""}</div>` : ""}
    </article>
  `;
  }).join("") : `<div class="empty">${actions.length ? "历史动作已收起，当前无待处理动作" : "当前无调控建议，持续观察中"}</div>`;
}

function renderAccountWarning(state) {
  const latest = Object.values(state.latestByPage || {}).filter(Boolean), missing = latest.filter((item) => !item.accountId);
  const mismatched = latest.filter((item) => item.accountId && item.accountId !== state.config?.expectedAccountId), node = $("accountWarning");
  if (!missing.length && !mismatched.length) { node.hidden = true; node.textContent = ""; return; }
  node.hidden = false;
  node.textContent = mismatched.length ? `账户校验异常：${mismatched.map((item) => item.accountId).join("、")}` : "部分页面未读取到账户 ID，当前快照只做谨慎参考";
}

function renderLogs(logs = [], actions = [], aiLogs = []) {
  // Filter to only show logs with actual rule evaluations or meaningful data
  const meaningfulLogs = logs.filter((log) => (log.rulesEvaluated && log.rulesEvaluated.length > 0) || Number.isFinite(log.fiveMinSpend));
  const visibleLogs = isExpanded("logs") ? meaningfulLogs : meaningfulLogs.slice(0, 10);
  configureToggle("logToggle", "logs", meaningfulLogs.length, visibleLogs.length);
  $("logList").innerHTML = visibleLogs.length ? visibleLogs.map((log) => {
    const triggered = (log.rulesEvaluated || []).filter((r) => r.triggered);
    return `
    <article class="log-item">
      <strong>${timeText(log.receivedAt)}</strong>
      ${Number.isFinite(log.fiveMinSpend) ? `<span>5分钟消耗：${money(log.fiveMinSpend)}</span>` : ""}
      ${triggered.length ? `<p>触发规则：${triggered.map((r) => ruleLabels[r.name] || r.name).join("、")}</p>` : ""}
    </article>
  `;
  }).join("") : `<div class="empty">暂无有效调控日志</div>`;
}

function renderAiLogs(logs = []) {
  if (!logs.length) {
    configureToggle("aiLogToggle", "aiLogs", 0, 0);
    $("aiLogList").innerHTML = `<div class="empty">暂无 AI 决策，等待触发</div>`;
    return;
  }
  const visibleLogs = isExpanded("aiLogs") ? logs : logs.slice(0, 3);
  configureToggle("aiLogToggle", "aiLogs", logs.length, visibleLogs.length);
  $("aiLogList").innerHTML = visibleLogs.map((log) => {
    const result = log.result || {}, actions = result.actions || [];
    return `<article class="ai-log-item">
      <strong>${result.decision === "act" ? "建议动作" : "继续观察"}</strong>
      <p>时间：${timeText(log.ts)}</p>
      ${formatReasonHtml(result.reasoning || result.error || "--")}
      ${actions.length ? actions.map((action) => `<p><strong>${escapeHtml(actionTypeLabels[action.type] || action.type)}</strong></p>${formatReasonHtml(action.reason)}`).join("") : "<p>动作：无</p>"}
    </article>`;
  }).join("");
}

function latestAiBatch(actions = [], aiLogs = []) {
  const actionableSources = new Set(["ai", "manual", "ai_chat"]);
  const actionable = actions
    .filter((action) => actionableSources.has(action.source) && (action.status === "pending_review" || action.status === "ready_to_execute"))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const logsByNewest = [...aiLogs].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const first = actionable[0];
  if (first) {
    const items = actionable.filter((action) => action.createdAt === first.createdAt);
    const log = logsByNewest.find((item) => item.ts === first.createdAt);
    return { id: `action-batch-${first.createdAt}`, ts: first.createdAt, actions: items, reasoning: log?.result?.reasoning || first.reason || first.title };
  }
  const latestObservation = logsByNewest.find((log) => {
    const result = log.result || {};
    return result.decision && !((result.actions || []).length);
  });
  if (!latestObservation) return null;
  const result = latestObservation.result || {};
  return {
    id: `ai-observe-${latestObservation.ts}`,
    ts: latestObservation.ts,
    actions: [],
    reasoning: result.reasoning || result.error || "AI 已完成本次分析，暂无需要执行的动作。",
    readOnly: true,
  };
}

async function playDing() {
  try {
    const response = await fetch("/assets/ding.mp3", { method: "HEAD", cache: "no-store" });
    if (response.ok) await new Audio("/assets/ding.mp3").play();
  } catch {}
}

function showActionConfirmDialog(actions = [], reasoning = "") {
  const visibleActions = actions.filter(Boolean);
  if (!visibleActions.length) return;
  const first = visibleActions[0];
  const batchId = `action-batch-${first.createdAt || Date.now()}`;
  unmarkAiBatchDismissed(batchId);
  currentAiBatch = {
    id: batchId,
    ts: first.createdAt || Date.now(),
    actions: visibleActions,
    reasoning: reasoning || first.reason || first.title || "已生成待确认动作，点同意后系统会立即执行。",
  };
  renderAiDialog(currentAiBatch, false);
  if (!$("aiDialog").open) $("aiDialog").showModal();
  playDing();
}

function markAiBatchDismissed(id) {
  const dismissed = JSON.parse(localStorage.getItem("dismissedAiActionBatches") || "[]");
  if (!dismissed.includes(id)) localStorage.setItem("dismissedAiActionBatches", JSON.stringify([...dismissed, id].slice(-50)));
}

function unmarkAiBatchDismissed(id) {
  const dismissed = JSON.parse(localStorage.getItem("dismissedAiActionBatches") || "[]");
  localStorage.setItem("dismissedAiActionBatches", JSON.stringify(dismissed.filter((item) => item !== id)));
}

const actionTypeLabels = {
  raise_roi_target: "提高 ROI 目标",
  lower_roi_target: "降低 ROI 目标",
  pause_task: "暂停任务",
  end_task: "结束任务",
  increase_task_budget: "追加预算",
  decrease_task_budget: "缩减预算",
  extend_task_duration: "延长时长",
  change_roi_target: "修改 ROI",
  adjust_task_budget_duration: "预算+时长",
  create_boost_task: "新建追投",
  create_oneclick_task: "新建一键起量",
};

function formatActionParams(action) {
  const p = action.payload || {};
  if (action.type === "lower_roi_target" || action.type === "raise_roi_target") { const v = p.targetRoi ?? p.roi; return v != null ? `目标 ROI → ${v}` : ""; }
  if (action.type === "pause_task") return p.taskId ? `任务 ID：${p.taskId}` : "";
  if (action.type === "end_task") return p.taskId ? `任务 ID：${p.taskId}` : "";
  if (action.type === "increase_task_budget") return [p.budgetIncrease != null ? `追加：${p.budgetIncrease} 元` : "", p.budget != null ? `新预算：${p.budget} 元` : ""].filter(Boolean).join(" / ");
  if (action.type === "decrease_task_budget") return p.budget != null ? `新预算：${p.budget} 元` : "";
  if (action.type === "extend_task_duration") return p.durationHours != null ? `新时长：${p.durationHours} 小时` : "";
  if (action.type === "change_roi_target") return p.targetRoi != null ? `ROI → ${p.targetRoi}` : "";
  if (action.type === "adjust_task_budget_duration") return [`追加：${p.budgetIncrease ?? "--"} 元`, `新预算：${p.budget ?? "--"} 元`, `新时长：${p.durationHours ?? "--"} 小时`].join(" / ");
  if (action.type === "create_boost_task") return [`素材ID：${p.materialId || "--"}`, `预算：${p.budget ?? "--"} 元`, `时长：${p.durationHours ?? "--"} 小时`, p.targetRoi != null ? `ROI：${p.targetRoi}` : ""].filter(Boolean).join(" / ");
  if (action.type === "create_oneclick_task") return [`预算：${p.budget ?? "--"} 元`, `时长：${p.durationHours ?? "--"} 小时`, p.useLiveRoomImage !== false ? "素材：直播间画面" : ""].filter(Boolean).join(" / ");
  return "";
}

function renderAiDialog(batch, eachMode = false) {
  $("aiDialogReason").innerHTML = formatReasonHtml(batch.reasoning || "AI 生成了新的调控建议");
  if (!batch.actions.length) {
    $("aiDialogActions").innerHTML = `<article class="dialog-action"><div class="dialog-action-head"><strong>继续观察</strong>${badge("无需执行", "info")}</div><p>AI 暂未生成需要人工确认的调控动作。</p></article>`;
    $("aiDialogBatch").hidden = true;
    return;
  }
  $("aiDialogActions").innerHTML = batch.actions.map((action) => {
    const label = actionTypeLabels[action.type] || action.type;
    const params = formatActionParams(action);
    return `
    <article class="dialog-action">
      <div class="dialog-action-head"><strong>${escapeHtml(label)}</strong>${badge(statusLabel(action.status), actionTone(action))}</div>
      ${formatReasonHtml(action.title || action.reason || "--")}
      ${params ? `<p class="action-params">${escapeHtml(params)}</p>` : ""}
      ${eachMode ? `<div class="action-buttons"><button type="button" data-dialog-review="approve" data-action-id="${escapeHtml(action.id)}">同意</button><button type="button" data-dialog-review="reject" data-action-id="${escapeHtml(action.id)}">拒绝</button></div>` : ""}
    </article>
  `;
  }).join("");
  $("aiDialogBatch").hidden = eachMode;
}

function maybeShowAiDialog(state, aiLogs) {
  const batch = latestAiBatch(state.actions || [], aiLogs);
  if (!batch) return;
  const dismissed = JSON.parse(localStorage.getItem("dismissedAiActionBatches") || "[]");
  if (dismissed.includes(batch.id) || $("aiDialog").open) return;
  currentAiBatch = batch;
  renderAiDialog(batch, false);
  $("aiDialog").showModal();
  playDing();
}

function showAiTriggerResult(ai) {
  const actions = ai.actions || [];
  const collect = ai.collect;
  const collectText = collect
    ? collect.status === "ok"
      ? `采集：${collect.metricsUpdated ? "已更新核心指标" : "成功但未抽到新指标"}`
      : `采集失败：${collect.error || "--"}`
    : "采集：未执行";
  // 左侧面板只显示摘要：采集状态 + 决策结论 + 动作数
  const decision = ai.decision === "act" ? "建议操作" : "继续观察";
  const summary = ai.error ? `调用失败：${ai.error}` : `决策：${decision}，动作 ${actions.length} 条`;
  $("aiTriggerResult").innerHTML = `<p>${escapeHtml(collectText)}</p><p>${escapeHtml(summary)}</p>`;
  if (!actions.length) return;
  showActionConfirmDialog(actions, ai.reasoning || ai.error || "AI 已完成本次分析");
}

async function syncAiConfig() {
  const autoCollectOn = $("aiAutoCollectInput") ? $("aiAutoCollectInput").checked : true;
  const targetRoi = Number($("targetRoiInput")?.value);
  await postJson("/api/config", {
    aiEnabled: $("aiEnabledInput").checked,
    autoCollectEnabled: autoCollectOn,
    aiAutoCollectEnabled: autoCollectOn,
    ...(Number.isFinite(targetRoi) && targetRoi >= 1 && targetRoi <= 20 ? { targetRoi, baselineTargetRoi: targetRoi } : {}),
    aiModel: $("aiModelInput").value,
    aiMinIntervalMs: Number($("aiIntervalInput").value),
  });
}

function applyMode(mode, options = {}) {
  controlMode = mode === "auto" ? "auto" : "learning";
  localStorage.setItem("controlMode", controlMode);
  if (controlMode === "auto" && options.userAction) localStorage.setItem("aiTakeoverDisabled", "0");
  document.querySelectorAll(".execution-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.execMode === (controlMode === "auto" ? "auto" : "review")));
  $("actionSection").classList.toggle("auto-mode", controlMode === "auto");
  $("autoMode").textContent = controlMode === "auto" ? "自动执行" : "调控学习";
  $("autoMode").className = mode === "auto" ? "badge warn" : "badge muted";
  if (!options.userAction) return;
  const patch = controlMode === "auto"
    ? { actionMode: "review", aiEnabled: true, executorDryRun: false }
    : { actionMode: "review" };
  const takeoverDisabled = localStorage.getItem("aiTakeoverDisabled") === "1";
  if (!takeoverDisabled && (latestState?.config?.actionMode !== "review" || (controlMode === "auto" && (latestState?.config?.aiEnabled !== true || latestState?.config?.executorDryRun !== false)))) {
    postJson("/api/config", patch).then(() => {
      if (latestState?.config) Object.assign(latestState.config, patch);
      renderAiConfig(latestState?.config || {});
    }).catch(() => {});
  }
}

function applyView(view) {
  currentView = ["monitor", "sop", "learning"].includes(view) ? view : "monitor";
  localStorage.setItem("currentView", currentView);
  document.querySelectorAll(".page-nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === currentView));
  document.querySelectorAll(".app-view").forEach((node) => { node.hidden = node.id !== `${currentView}Page`; });
  const executionSwitch = $("executionModeSwitch");
  if (executionSwitch) executionSwitch.hidden = currentView !== "monitor";
  if (currentView === "sop") loadInvestmentSopConfig().catch(() => renderInvestmentSop(latestState?.config || {}));
}

async function reviewAction(id, type) {
  const action = (latestState?.actions || []).find((item) => item.id === id) || null;
  const reason = type === "reject" ? askRejectReason(action) : "";
  if (reason === null) return;
  try {
    const result = await postJson(`/api/action/${type}`, { id, reason });
    if (type === "approve" && result.executionResult?.ok === false) throw new Error(result.executionResult.error || "execute_failed");
    await refresh();
  } catch (error) {
    $("systemError").hidden = false;
    $("systemError").textContent = `执行失败：${friendlyError(error)}`;
  }
}

async function executeAction(id, options = {}) {
  try {
    await postJson("/api/action/execute", { id, forceReal: options.forceReal === true });
    await refresh();
  } catch (error) {
    $("systemError").hidden = false;
    $("systemError").textContent = `执行失败：${friendlyError(error)}`;
  }
}

function chatActionParams(action = {}) {
  const p = action.payload || action.params || {};
  const items = [];
  if (p.taskId || action.taskId) items.push(`ID ${shortTaskId(p.taskId || action.taskId)}`);
  if (p.budgetIncrease != null) items.push(`加预算 ${roundedMoney(p.budgetIncrease)} 元`);
  if (p.budget != null) items.push(`预算 ${roundedMoney(p.budget)} 元`);
  if (p.durationHours != null) items.push(`时长 ${p.durationHours} 小时`);
  if (p.targetRoi != null || p.roi != null) items.push(`ROI ${p.targetRoi ?? p.roi}`);
  return items.join(" · ");
}

function renderChatActionCard(action = {}) {
  const p = action.payload || action.params || {};
  const label = actionTypeLabels[action.type] || action.type || "建议动作";
  const taskName = p.taskName || action.taskName || p.taskId || action.taskId || "--";
  const params = chatActionParams(action);
  const canRun = action.id && (action.status === "approved" || action.status === "ready_to_execute");
  const validationText = p.validationError ? friendlyError(p.validationError) : "";
  return `
    <article class="chat-action-card">
      <div class="chat-action-icon">⚙</div>
      <div class="chat-action-main">
        <strong>${escapeHtml(label)}</strong>
        <span title="${escapeHtml(taskName)}">${escapeHtml(taskName)}</span>
        ${params ? `<small>${escapeHtml(params)}</small>` : ""}
        ${validationText ? `<small class="action-error">${escapeHtml(validationText)}</small>` : ""}
      </div>
      ${canRun ? `<button type="button" data-chat-execute="${escapeHtml(action.id)}">执行</button>` : ""}
    </article>
  `;
}

function appendChatMessage(role, content, actions = [], options = {}) {
  const list = $("aiChatMessages");
  if (!list) return null;
  const row = document.createElement("div");
  row.className = `ai-chat-msg ${role}`;
  if (options.loading) row.dataset.loading = "1";
  row.innerHTML = `
    <div class="ai-chat-bubble">
      ${options.loading ? `<span class="ai-chat-loading">AI 正在分析<span>.</span><span>.</span><span>.</span></span>` : renderMarkdown(content || "")}
      ${actions.length ? `<div class="chat-action-list">${actions.map(renderChatActionCard).join("")}</div>` : ""}
    </div>
  `;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  return row;
}

function renderAiMemoryMessages(memory = {}) {
  const list = $("aiChatMessages");
  if (!list) return;
  list.innerHTML = "";
  const messages = Array.isArray(memory.messages) ? memory.messages.slice(-30) : [];
  if (!messages.length) {
    appendChatMessage("assistant", "我会记住这次会话里的判断口径和你的偏好。你可以直接问盘面、素材点击、小时 ROI 或具体任务。");
    return;
  }
  messages.forEach((item) => appendChatMessage(item.role === "user" ? "user" : "assistant", item.content || ""));
}

async function loadAiMemory(force = false) {
  if (aiMemoryLoaded && !force) return;
  try {
    const data = await getJson("/api/ai/memory");
    renderAiMemoryMessages(data.memory || {});
  } catch {
    // 记忆加载失败不影响实时面板使用。
  } finally {
    aiMemoryLoaded = true;
  }
}

async function clearAiMemory() {
  if (!window.confirm("确认清空 AI 对话记忆？实时数据不会删除，但近期聊天和偏好记忆会重置。")) return;
  await postJson("/api/ai/memory/clear", {});
  aiMemoryLoaded = false;
  await loadAiMemory(true);
}

async function sendAiChat(message) {
  const text = String(message || "").trim();
  if (!text) return;
  const input = $("aiChatInput");
  const form = $("aiChatForm");
  appendChatMessage("user", text);
  if (input) input.value = "";
  if (form) form.classList.add("is-sending");
  const loading = appendChatMessage("assistant", "", [], { loading: true });
  try {
    const data = await postJson("/api/ai/chat", { message: text });
    if (loading) loading.remove();
    appendChatMessage("assistant", data.reply || "AI 没有返回有效分析。", data.actions || []);
    aiMemoryLoaded = true;
    await refresh();
  } catch (error) {
    if (loading) loading.remove();
    appendChatMessage("assistant", "分析失败，请检查 AI 配置或稍后重试。");
  } finally {
    if (form) form.classList.remove("is-sending");
    if (input) input.focus();
  }
}

async function approveAiBatch() {
  if (!currentAiBatch) return;
  try {
    const result = await postJson("/api/action/batch-approve", { ids: currentAiBatch.actions.map((action) => action.id) });
    const failed = (result.executions || []).find((item) => item && item.ok === false);
    if (failed) {
      $("systemError").hidden = false;
      $("systemError").textContent = `执行失败：${friendlyError(failed.error || "execute_failed")}`;
    }
    markAiBatchDismissed(currentAiBatch.id);
    $("aiDialog").close();
    await refresh();
  } catch (error) {
    $("systemError").hidden = false;
    $("systemError").textContent = `执行失败：${friendlyError(error)}`;
  }
}

function askRejectReason(action = null) {
  const label = action ? (actionTypeLabels[action.type] || action.type || "该动作") : "这些动作";
  const reason = window.prompt(`拒绝${label}的原因：`, "ROI 还不够低，先观察");
  if (reason === null) return null;
  return String(reason || "").trim();
}

async function rejectAiBatch() {
  if (!currentAiBatch) return;
  const reason = askRejectReason();
  if (reason === null) return;
  await Promise.all(currentAiBatch.actions.map((action) => fetch("/api/action/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: action.id, reason }) })));
  markAiBatchDismissed(currentAiBatch.id);
  $("aiDialog").close();
  await refresh();
}

async function reviewDialogAction(id, type) {
  const action = currentAiBatch?.actions?.find((item) => item.id === id) || null;
  const reason = type === "reject" ? askRejectReason(action) : "";
  if (reason === null) return;
  try {
    const result = await postJson(`/api/action/${type}`, { id, reason });
    if (type === "approve" && result.executionResult?.ok === false) {
      $("systemError").hidden = false;
      $("systemError").textContent = `执行失败：${friendlyError(result.executionResult.error || "execute_failed")}`;
    }
  } catch (error) {
    $("systemError").hidden = false;
    $("systemError").textContent = `执行失败：${friendlyError(error)}`;
    return;
  }
  currentAiBatch.actions = currentAiBatch.actions.filter((action) => action.id !== id);
  if (!currentAiBatch.actions.length) {
    markAiBatchDismissed(currentAiBatch.id);
    $("aiDialog").close();
  }
  else renderAiDialog(currentAiBatch, true);
  await refresh();
}

async function refresh() {
  try {
    const [state, logData, aiLogData, taskCollectData] = await Promise.all([getJson("/api/dashboard.php"), getJson("/api/learning-log.php?limit=50"), getJson("/api/ai-log?limit=50"), getJson("/api/task-collect/status")]);
    latestState = state;
    $("systemError").hidden = true;
    $("syncStatus").textContent = "后台在线"; $("syncStatus").className = "pill live";
    renderStatusBar(state); renderSystemStatus(state); renderAiStatusBar(state); renderTaskCollectStatus(taskCollectData.taskCollectStatus || state.taskCollectStatus || {}); renderMetrics(state); renderVisualCapture(state.visualCapture); renderAiConfig(state.config || {}); renderInvestmentSop(state.config || {}); renderTrendChart(state); renderDailyReview(state); renderTaskHealth(state); renderActions(state.actions || [], state); renderAccountWarning(state); renderAiLogs(aiLogData.logs || []); renderLogs(logData.logs || [], state.actions || [], aiLogData.logs || []); maybeShowAiDialog(state, aiLogData.logs || []); applyMode(controlMode); applyView(currentView);
  } catch (error) {
    $("syncStatus").textContent = "后台离线"; $("syncStatus").className = "pill";
    $("systemError").hidden = false;
    $("systemError").textContent = `刷新失败：${error.message}`;
  }
}

function tickSystemStatus() {
  if (latestState) renderSystemStatus(latestState);
  if (latestState) renderAiStatusBar(latestState);
}

$("refreshBtn").addEventListener("click", refresh);
const stopAiMonitorBtn = $("stopAiMonitorBtn");
if (stopAiMonitorBtn) stopAiMonitorBtn.addEventListener("click", async () => {
  stopAiMonitorBtn.disabled = true;
  stopAiMonitorBtn.textContent = "关闭中";
  try {
    await postJson("/api/config", { aiEnabled: false, actionMode: "review", executorDryRun: true });
    localStorage.setItem("aiTakeoverDisabled", "1");
    controlMode = controlMode === "auto" ? "learning" : controlMode;
    localStorage.setItem("controlMode", controlMode);
    await refresh();
  } catch (error) {
    $("systemError").hidden = false;
    $("systemError").textContent = `关闭 AI 盯盘失败：${error.message}`;
  } finally {
    stopAiMonitorBtn.disabled = false;
  }
});
document.querySelectorAll(".panel-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.collapseKey;
    if (!key) return;
    setExpanded(key, !isExpanded(key));
    refresh();
  });
});
const taskCollectToggle = $("taskCollectToggle");
if (taskCollectToggle) taskCollectToggle.addEventListener("click", () => {
  const details = $("taskCollectDetails");
  const expanded = details.hidden;
  details.hidden = !expanded;
  taskCollectToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  taskCollectToggle.querySelector(".task-collect-caret").textContent = expanded ? "详情 ▲" : "详情 ▼";
});
$("runVisualCapture").addEventListener("click", async () => {
  renderVisualCapture({ status: "running", title: "正在连接浏览器", tabUrl: "请保持千川页面已在 CDP Chrome 中打开" });
  try {
    const result = await postJson("/api/visual/capture");
    renderVisualCapture(result.visualCapture);
    await refresh();
  } catch (error) {
    renderVisualCapture({ status: "error", error: error.message });
    $("systemError").hidden = false;
    $("systemError").textContent = `视觉补采失败：${error.message}`;
  }
});
async function runCollectRoute(route, endpoint, title, hint) {
  renderVisualCapture({ status: "running", title, tabUrl: hint, mode: `auto_collect_${route}`, route });
  try {
    const result = await postJson(endpoint);
    renderVisualCapture(result.visualCapture || result);
    await refresh();
  } catch (error) {
    renderVisualCapture({ status: "error", error: error.message, mode: `auto_collect_${route}`, route });
    $("systemError").hidden = false;
    $("systemError").textContent = `${title}失败：${error.message}`;
  }
}
const collectOverallBtn = $("collectOverallBtn");
const collectControlBtn = $("collectControlBtn");
const collectMaterialBoostBtn = $("collectMaterialBoostBtn");
const collectOneClickLiftBtn = $("collectOneClickLiftBtn");
const collectHourlyBtn = $("collectHourlyBtn");
if (collectOverallBtn) collectOverallBtn.addEventListener("click", () => {
  runCollectRoute("overall", "/api/visual/collect-overall", "正在采集整体指标", "只读取投放总览和直播大屏，不进入任务详情页");
});
if (collectControlBtn) collectControlBtn.addEventListener("click", () => {
  runCollectRoute("control", "/api/visual/collect-control", "正在采集调控任务", "只读取任务中心/调控页，不刷新整体指标");
});
if (collectMaterialBoostBtn) collectMaterialBoostBtn.addEventListener("click", () => {
  runCollectRoute("materialBoost", "/api/visual/collect-material-boost", "正在采集素材追投", "自动打开任务中心并只写回素材追投任务");
});
if (collectOneClickLiftBtn) collectOneClickLiftBtn.addEventListener("click", () => {
  runCollectRoute("oneClickLift", "/api/visual/collect-one-click-lift", "正在采集一键起量", "自动打开任务中心并只写回一键起量任务");
});
if (collectHourlyBtn) collectHourlyBtn.addEventListener("click", () => {
  runCollectRoute("hourly", "/api/visual/collect-hourly", "正在采集单小时明细", "自动进入直播间明细页并读取分时段 ROI / 消耗 / 转化");
});
const runDailyReviewBtn = $("runDailyReview");
if (runDailyReviewBtn) runDailyReviewBtn.addEventListener("click", async () => {
  runDailyReviewBtn.disabled = true;
  $("dailyReviewBadge").textContent = "生成中";
  $("dailyReviewBadge").className = "badge warn";
  try {
    await postJson("/api/review/daily/run");
    await refresh();
  } catch (error) {
    $("dailyReviewBody").innerHTML = `<div class="empty">复盘生成失败：${escapeHtml(error.message)}</div>`;
  } finally {
    runDailyReviewBtn.disabled = false;
  }
});
const initTabsBtn = $("initTabsBtn");
const initTabsStatus = $("initTabsStatus");
if (initTabsBtn) {
  initTabsBtn.addEventListener("click", async () => {
    initTabsBtn.disabled = true;
    initTabsStatus.hidden = false;
    initTabsStatus.textContent = "初始化中...";
    try {
      const data = await postJson("/api/tabs/init");
      if (!data.ok) {
        initTabsStatus.textContent = `初始化失败：${data.error || "unknown"}`;
        return;
      }
      const iconMap = { opened: "🆕", exists: "✅", skip: "⏭️", error: "❌" };
      const summary = (data.results || []).map((result) => {
        const icon = iconMap[result.status] || "•";
        const detail = result.status === "skip" ? `(${result.reason})` : result.status === "error" ? `(${result.error})` : "";
        return `${icon} ${result.label}${detail}`;
      }).join("　");
      initTabsStatus.textContent = `初始化完成：${summary}`;
    } catch (error) {
      initTabsStatus.textContent = `初始化异常：${error.message}`;
    } finally {
      initTabsBtn.disabled = false;
    }
  });
}
$("saveDeepseekKey").addEventListener("click", async () => {
  try {
    await postJson("/api/secret", { deepseekApiKey: $("deepseekKeyInput").value });
    $("deepseekKeyInput").value = "";
    await refreshSecretStatus();
  } catch (error) {
    $("aiTriggerResult").textContent = `保存失败：${error.message}`;
  }
});
$("aiEnabledInput").addEventListener("change", syncAiConfig);
$("aiAutoCollectInput")?.addEventListener("change", syncAiConfig);
$("targetRoiInput")?.addEventListener("change", syncAiConfig);
$("aiModelInput").addEventListener("change", syncAiConfig);
$("aiIntervalInput").addEventListener("change", syncAiConfig);
$("btn-armed-once")?.addEventListener("click", enableArmedOnce);
$("aiTakeoverBtn")?.addEventListener("click", toggleAiTakeover);
document.querySelectorAll(".page-nav-btn").forEach((btn) => btn.addEventListener("click", () => applyView(btn.dataset.view)));
document.querySelectorAll(".execution-btn").forEach((btn) => btn.addEventListener("click", () => applyMode(btn.dataset.execMode === "auto" ? "auto" : "learning", { userAction: true })));
document.querySelectorAll("[data-sop-field]").forEach((node) => {
  node.addEventListener("input", () => queueSopSave(900));
  node.addEventListener("blur", () => queueSopSave(0));
});
if ($("sopFaqList")) {
  $("sopFaqList").addEventListener("input", (event) => {
    const target = event.target;
    if (!sopDraft) sopDraft = normalizeSop(latestState?.config?.investmentSop || {});
    const categoryIndex = target.dataset.sopFaqCategory;
    const qIndex = target.dataset.sopFaqQ;
    const aIndex = target.dataset.sopFaqA;
    if (categoryIndex !== undefined) {
      sopDraft.faq[Number(categoryIndex)].category = target.value;
      queueSopSave(900);
    }
    if (qIndex) {
      const [group, item] = qIndex.split(":").map(Number);
      sopDraft.faq[group].items[item].q = target.value;
      queueSopSave(900);
    }
    if (aIndex) {
      const [group, item] = aIndex.split(":").map(Number);
      sopDraft.faq[group].items[item].a = target.value;
      queueSopSave(900);
    }
  });
  $("sopFaqList").addEventListener("focusout", () => queueSopSave(0));
  $("sopFaqList").addEventListener("click", (event) => {
    const add = event.target.closest("[data-sop-add-question]");
    const remove = event.target.closest("[data-sop-remove-question]");
    if (!sopDraft) sopDraft = normalizeSop(latestState?.config?.investmentSop || {});
    if (add) {
      const group = Number(add.dataset.sopAddQuestion);
      sopDraft.faq[group].items.push({ q: "新问题", a: "填写排查路径。" });
      renderSopFaq();
      queueSopSave(0);
    }
    if (remove) {
      const [group, item] = remove.dataset.sopRemoveQuestion.split(":").map(Number);
      sopDraft.faq[group].items.splice(item, 1);
      renderSopFaq();
      queueSopSave(0);
    }
  });
}
if ($("sopAddCategory")) $("sopAddCategory").addEventListener("click", () => {
  if (!sopDraft) sopDraft = normalizeSop(latestState?.config?.investmentSop || {});
  sopDraft.faq.push({ category: "新分类", items: [{ q: "新问题", a: "填写排查路径。" }] });
  renderSopFaq();
  queueSopSave(0);
});
[
  "dingtalkWebhookInput",
  "dingtalkSecretInput",
  "dingtalkEnabledInput",
  "dingtalkNotifyCollectorError",
  "dingtalkNotifyAiSuggestion",
  "dingtalkNotifyActionResult",
  "dingtalkNotifyHourlySummary",
  "dingtalkNotifySystemAlert",
].forEach((id) => {
  const node = $(id);
  if (!node) return;
  node.addEventListener("input", () => {
    dingtalkEditing = true;
    setDingtalkConfigStatus("待保存", "warn");
  });
  node.addEventListener("change", () => {
    dingtalkEditing = true;
    setDingtalkConfigStatus("待保存", "warn");
  });
});
$("dingtalkSaveBtn")?.addEventListener("click", saveDingtalkConfig);
$("dingtalkTestBtn")?.addEventListener("click", sendDingtalkTest);

const TASK_ACTION_CONFIG = {
  budget: { title: "加预算", actionType: "increase_task_budget", fields: ["budget"], hint: "填写追加预算金额；审批后执行器会打开任务编辑并改预算。" },
  duration: { title: "延时长", actionType: "extend_task_duration", fields: ["durationHours"], hint: "填写新的任务时长，单位小时。" },
  roi: { title: "改 ROI", actionType: "change_roi_target", fields: ["targetRoi"], hint: "填写新的 ROI 目标；执行器会找 ROI 输入框修改。" },
  pause: { title: "暂停任务", actionType: "pause_task", fields: [], hint: "生成暂停待确认动作；同意后执行器会找任务行并点击暂停。" },
  end: { title: "结束任务", actionType: "end_task", fields: [], hint: "生成结束待确认动作；同意后执行器会找任务行并点击结束。" },
  create_boost: { title: "新建追投", actionType: "create_boost_task", fields: ["boostType", "budget", "durationHours", "targetRoi", "materialId"], hint: "新建类会先 dryRun 截图验证，再二次确认真点。" },
  create_oneclick: { title: "新建一键起量", actionType: "create_oneclick_task", fields: ["budget", "durationHours", "useLiveRoomImage"], hint: "默认选择直播间画面；新建类会先 dryRun 截图验证，再二次确认真点。" },
};
let pendingTaskAction = null;

function fieldHtml(name) {
  const fields = {
    boostType: `<label>类型<select name="boostType"><option value="materialBoost">素材追投</option><option value="materialCostControl">素材控成本</option></select></label>`,
    budget: `<label>预算/追加金额<input name="budget" type="number" min="1" step="1" required /></label>`,
    durationHours: `<label>时长(小时)<input name="durationHours" type="number" min="0.5" step="0.5" required /></label>`,
    targetRoi: `<label>ROI目标<input name="targetRoi" type="number" min="0.1" step="0.01" required /></label>`,
    materialId: `<label>素材ID<input name="materialId" type="text" inputmode="numeric" required /></label>`,
    useLiveRoomImage: `<label class="checkbox-line"><input name="useLiveRoomImage" type="checkbox" checked /> 使用直播间画面</label>`,
  };
  return fields[name] || "";
}

function openTaskActionDialog(kind, options = {}) {
  const config = TASK_ACTION_CONFIG[kind];
  if (!config) return;
  pendingTaskAction = { kind, config, ...options };
  $("taskActionTitle").textContent = config.title;
  $("taskActionFields").innerHTML = `
    ${options.taskId ? `<label>任务ID<input name="taskId" type="text" value="${escapeHtml(options.taskId)}" readonly /></label>` : ""}
    ${options.taskName ? `<label>任务名<input name="taskName" type="text" value="${escapeHtml(options.taskName)}" readonly /></label>` : ""}
    ${config.fields.map(fieldHtml).join("")}
    <label class="task-action-wide">备注<input name="command" type="text" placeholder="可选，例如：手动从任务行发起" /></label>
  `;
  $("taskActionHint").textContent = config.hint;
  $("taskActionDialog").showModal();
}

async function submitTaskActionDialog(event) {
  event.preventDefault();
  if (!pendingTaskAction) return;
  const form = new FormData($("taskActionForm"));
  const payload = {
    actionType: pendingTaskAction.config.actionType,
    taskId: form.get("taskId") || pendingTaskAction.taskId || undefined,
    taskName: form.get("taskName") || pendingTaskAction.taskName || undefined,
    boostType: form.get("boostType") || undefined,
    materialId: String(form.get("materialId") || "").trim() || undefined,
    budget: form.get("budget") ? Number(form.get("budget")) : undefined,
    durationHours: form.get("durationHours") ? Number(form.get("durationHours")) : undefined,
    targetRoi: form.get("targetRoi") ? Number(form.get("targetRoi")) : undefined,
    useLiveRoomImage: form.has("useLiveRoomImage"),
    command: String(form.get("command") || pendingTaskAction.config.title || "").trim(),
  };
  if (payload.actionType === "increase_task_budget") {
    payload.budgetIncrease = payload.budget;
    delete payload.budget;
  }
  try {
    const result = await postJson("/api/action/command", payload);
    $("taskActionDialog").close();
    pendingTaskAction = null;
    if (result.action) showActionConfirmDialog([result.action], result.action.reason || "已生成待确认动作，点同意后系统会立即执行。");
    await refresh();
  } catch (error) {
    $("taskActionHint").textContent = `无法生成动作：${friendlyError(error)}`;
  }
}

$("triggerAiNow").addEventListener("click", async () => {
  const steps = ["视觉刷新当前大屏", "写入核心指标", "调用 DeepSeek 分析", "生成调控建议"];
  let stepIdx = 0;
  const updateProgress = () => {
    if (stepIdx < steps.length) {
      $("aiTriggerResult").textContent = `${steps[stepIdx]}...`;
      stepIdx++;
      setTimeout(updateProgress, 800);
    }
  };
  updateProgress();
  try {
    const result = await postJson("/api/ai/trigger");
    showAiTriggerResult(result.ai || {});
    await refresh();
  } catch (error) {
    $("aiTriggerResult").textContent = `调用失败：${error.message}`;
  }
});
$("manualActionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const taskText = $("manualActionTask").value;
    const taskId = taskText.match(/ID[：:]?\s*(\d{8,})/)?.[1] || taskText.match(/\b(\d{12,})\b/)?.[1] || "";
    const budgetText = $("manualActionBudget").value.trim();
    const durationText = $("manualActionDuration")?.value.trim() || "";
    const selectedType = $("manualActionType").value;
    const hasBudget = budgetText && Number(budgetText) > 0;
    const hasDuration = durationText && Number(durationText) > 0;
    const actionType = hasBudget && hasDuration && (selectedType === "increase_task_budget" || selectedType === "extend_task_duration")
      ? "adjust_task_budget_duration"
      : selectedType;
    const result = await postJson("/api/action/command", {
      actionType,
      taskId,
      taskName: taskText,
      budgetIncrease: hasBudget && (actionType === "increase_task_budget" || actionType === "adjust_task_budget_duration") ? Number(budgetText) : undefined,
      budget: hasBudget && actionType === "decrease_task_budget" ? Number(budgetText) : undefined,
      durationHours: durationText ? Number(durationText) : undefined,
      command: $("manualActionCommand").value,
    });
    $("manualActionResult").textContent = `已生成待确认动作：${result.action?.type || "--"}，同意后会立即执行`;
    $("manualActionCommand").value = "";
    if (result.action) showActionConfirmDialog([result.action], result.action.reason || "已按你的输入生成动作，点同意后系统会立即执行。");
    await refresh();
  } catch (error) {
    $("manualActionResult").textContent = `生成失败：${friendlyError(error)}`;
  }
});
$("themeToggle").addEventListener("click", () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); });
document.querySelectorAll("[data-trend-granularity]").forEach((btn) => btn.addEventListener("click", async () => {
  trendGranularity = btn.dataset.trendGranularity || "5";
  localStorage.setItem("trendGranularity", trendGranularity);
  if (latestState) renderTrendChart(latestState);
  try {
    await postJson("/api/board-trend/run", { granularity: Number(trendGranularity) });
    await refresh();
  } catch {
    if (latestState) renderTrendChart(latestState);
  }
}));
$("actionList").addEventListener("click", (event) => {
  const reviewButton = event.target.closest("button[data-review]");
  if (reviewButton) reviewAction(reviewButton.dataset.actionId, reviewButton.dataset.review);
  const executeButton = event.target.closest("button[data-execute]");
  if (executeButton) {
    const forceReal = executeButton.dataset.forceReal === "1";
    if (forceReal && !window.confirm("确认真实点击千川创建动作？请先核对 dryRun 截图和表单内容。")) return;
    executeAction(executeButton.dataset.actionId, { forceReal }).catch((error) => {
    $("systemError").hidden = false;
    $("systemError").textContent = `执行失败：${friendlyError(error)}`;
    refresh();
    });
  }
});
if ($("aiChatToggle")) $("aiChatToggle").addEventListener("click", () => {
  $("aiChatPanel").classList.add("open");
  loadAiMemory();
  $("aiChatInput").focus();
});
if ($("aiChatClose")) $("aiChatClose").addEventListener("click", () => {
  $("aiChatPanel").classList.remove("open");
});
if ($("aiMemoryClear")) $("aiMemoryClear").addEventListener("click", () => {
  clearAiMemory().catch((error) => appendChatMessage("assistant", `清空记忆失败：${friendlyError(error)}`));
});
if ($("aiChatForm")) $("aiChatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  sendAiChat($("aiChatInput").value);
});
document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
  button.addEventListener("click", () => sendAiChat(button.dataset.chatPrompt));
});
if ($("aiChatMessages")) $("aiChatMessages").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-chat-execute]");
  if (!button) return;
  const ok = window.confirm("确认执行这条 AI 建议动作？执行前请确认千川页面里目标任务可见。");
  if (!ok) return;
  const originalText = button.textContent;
  try {
    button.disabled = true;
    button.textContent = "执行中";
    await executeAction(button.dataset.chatExecute);
    button.textContent = "已执行";
  } catch (error) {
    button.disabled = false;
    button.textContent = originalText;
    appendChatMessage("assistant", `执行失败：${friendlyError(error)}`);
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-task-action]");
  if (!button) return;
  const action = button.dataset.taskAction;
  const taskId = button.dataset.taskId;
  if (!taskId) return;
  openTaskActionDialog(action, { taskId, taskName: button.dataset.taskName || "" });
});
let createTaskDraft = { type: "", candidate: null, preview: null, candidates: [], selectedMaterialIds: [] };
const createTaskTypeLabel = (type) => ({ materialBoost: "素材放量追投", materialCostControlPayRoi: "控成本·支付ROI", materialCostControlBid: "控成本·直播出价", oneClickLift: "一键起量·直播间购买", liveScreenBoost: "直播间画面追投" }[type] || "新建追投");
const createTaskSkipsMaterial = (type) => ["oneClickLift", "liveScreenBoost"].includes(type);
const createTaskUsesGenericRoi = (type) => !["materialBoost", "oneClickLift"].includes(type);
function setCreateTaskPreviewStatus(text = "") {
  $("createTaskScreenStatus").textContent = text;
  $("createTaskPreviewStatus").textContent = text;
}
function openCreateTaskModal(presetType = "") {
  createTaskDraft = { type: "", candidate: null, preview: null, candidates: [], selectedMaterialIds: [] };
  ["createTaskStepMaterial", "createTaskStepParams", "createTaskStepPreview"].forEach((id) => { $(id).hidden = true; });
  $("createTaskCandidates").innerHTML = ""; setCreateTaskPreviewStatus(""); $("createTaskBatch").hidden = true;
  document.querySelectorAll("[data-create-type]").forEach((item) => item.classList.remove("selected"));
  $("createTaskModal").showModal();
  if (presetType) selectCreateTaskType(presetType);
}
function selectedCreateMaterialIds() {
  const available = new Set(createTaskDraft.candidates.map((item) => String(item.materialId || "")));
  return Array.from(new Set(createTaskDraft.selectedMaterialIds || [])).filter((id) => available.has(id)).slice(0, 10);
}
function selectedCreateCandidates() {
  const selected = new Set(selectedCreateMaterialIds());
  return createTaskDraft.candidates.filter((item) => selected.has(String(item.materialId || "")));
}
function renderCreateTaskBatch() {
  const total = createTaskDraft.candidates.length;
  const selected = selectedCreateMaterialIds();
  $("createTaskBatch").hidden = total === 0;
  $("createTaskSelectionCount").textContent = `已选 ${selected.length} / ${total} 条`;
  $("createTaskSelectAll").disabled = total === 0 || selected.length === total;
  $("createTaskClearAll").disabled = selected.length === 0;
  $("createTaskUseSelected").disabled = selected.length === 0;
}
function renderCreateCandidates(items = []) {
  createTaskDraft.candidates = items;
  createTaskDraft.selectedMaterialIds = selectedCreateMaterialIds();
  const selected = new Set(createTaskDraft.selectedMaterialIds);
  $("createTaskCandidates").innerHTML = items.map((item, index) => { const boostStatus = item.boostStatus || "未识别"; const tone = boostStatus === "追投中" ? "live" : boostStatus === "未追投" ? "idle" : "unknown"; return `<article class="create-task-candidate ${selected.has(String(item.materialId)) ? "selected" : ""}"><div><strong>${escapeHtml(item.name || item.materialId)}</strong><span>ID: ${escapeHtml(item.materialId)}</span><span>ROI ${money(item.roi)} · 消耗 ${money(item.spend)} · CTR ${ratio(item.ctr)}% · CVR ${ratio(item.cvr)}%</span><span class="create-task-boost-status ${tone}">追投状态：${escapeHtml(boostStatus)}</span><p>${escapeHtml(item.reason || "")}</p></div><label class="create-task-select"><input type="checkbox" data-create-candidate="${index}" ${selected.has(String(item.materialId)) ? "checked" : ""} />选择</label></article>`; }).join("") || "<p class=\"manual-action-result\">未找到可用素材。</p>";
  renderCreateTaskBatch();
}
function showCreateTaskParams() {
  const type = createTaskDraft.type;
  createTaskDraft.candidate = selectedCreateCandidates()[0] || null;
  $("createTaskStepParams").hidden = false;
  $("createTaskPayRoiField").hidden = type !== "materialCostControlPayRoi";
  $("createTaskBidField").hidden = type !== "materialCostControlBid";
  $("createTaskRoiField").hidden = !createTaskUsesGenericRoi(type);
  if (type === "oneClickLift") { $("createTaskBudget").value = 200; $("createTaskDuration").value = 1; return; }
  if (type === "liveScreenBoost") { $("createTaskBudget").value = 100; $("createTaskDuration").value = 1; $("createTaskRoi").value = 6; return; }
  if (type === "materialBoost") { $("createTaskBudget").value = 200; $("createTaskDuration").value = 1; return; }
  if (createTaskDraft.candidate) { $("createTaskBudget").value = createTaskDraft.candidate.budget || 200; $("createTaskDuration").value = createTaskDraft.candidate.durationHours || 1; }
}
async function screenCreateMaterials(type, manualIds) {
  $("createTaskScreenStatus").textContent = "分析中...";
  try {
    const result = await postJson("/api/material/screen", { type, manualIds, manualBoostOverride: true });
    if (result.blocked) { $("createTaskScreenStatus").textContent = result.message || "素材筛选暂不可用"; $("createTaskCandidates").innerHTML = ""; return; }
    const status = result.aiError ? "已按筛选结果给出建议。" : "已生成推荐素材。";
    $("createTaskScreenStatus").textContent = result.warning ? `${status} ${result.warning}` : status;
    createTaskDraft.selectedMaterialIds = [];
    renderCreateCandidates(result.candidates || []);
  } catch (error) { $("createTaskScreenStatus").textContent = `筛选失败：${friendlyError(error)}`; }
}
function selectCreateTaskType(type) {
  createTaskDraft.type = type; createTaskDraft.candidate = null; createTaskDraft.selectedMaterialIds = [];
  document.querySelectorAll("[data-create-type]").forEach((item) => item.classList.toggle("selected", item.dataset.createType === type));
  if (createTaskSkipsMaterial(type)) { $("createTaskStepMaterial").hidden = true; showCreateTaskParams(); }
  else { $("createTaskStepMaterial").hidden = false; $("createTaskStepParams").hidden = true; }
}
document.querySelectorAll("[data-create-type]").forEach((button) => button.addEventListener("click", () => selectCreateTaskType(button.dataset.createType)));
document.querySelectorAll("[data-material-screen]").forEach((button) => button.addEventListener("click", () => screenCreateMaterials(button.dataset.materialScreen)));
$("createTaskManualScreen")?.addEventListener("click", () => screenCreateMaterials("manual", $("createTaskManualIds").value.split(",").map((id) => id.trim()).filter(Boolean)));
$("createTaskCandidates")?.addEventListener("change", (event) => { const input = event.target.closest("input[data-create-candidate]"); if (!input) return; const candidate = createTaskDraft.candidates[Number(input.dataset.createCandidate)]; if (!candidate) return; const id = String(candidate.materialId || ""); const selected = new Set(selectedCreateMaterialIds()); if (input.checked) selected.add(id); else selected.delete(id); createTaskDraft.selectedMaterialIds = Array.from(selected).slice(0, 10); renderCreateCandidates(createTaskDraft.candidates); });
$("createTaskSelectAll")?.addEventListener("click", () => { createTaskDraft.selectedMaterialIds = createTaskDraft.candidates.map((item) => String(item.materialId || "")).filter(Boolean).slice(0, 10); renderCreateCandidates(createTaskDraft.candidates); });
$("createTaskClearAll")?.addEventListener("click", () => { createTaskDraft.selectedMaterialIds = []; renderCreateCandidates(createTaskDraft.candidates); });
$("createTaskUseSelected")?.addEventListener("click", () => { if (selectedCreateMaterialIds().length) showCreateTaskParams(); });
$("createTaskPreview")?.addEventListener("click", async () => {
  const type = createTaskDraft.type; const materialIds = selectedCreateMaterialIds(); if (!type || (!createTaskSkipsMaterial(type) && !materialIds.length)) return;
  const button = $("createTaskPreview"); button.disabled = true; button.textContent = "预览中...";
  const payload = {
    type,
    materialId: materialIds[0],
    materialIds,
    budget: Number($("createTaskBudget").value),
    durationHours: Number($("createTaskDuration").value),
    targetRoi: createTaskUsesGenericRoi(type) ? Number($("createTaskRoi").value) : undefined,
    payRoi: type === "materialCostControlPayRoi" ? Number($("createTaskPayRoi").value) : undefined,
    bidPrice: type === "materialCostControlBid" ? Number($("createTaskBid").value) : undefined,
    useLiveRoomImage: createTaskSkipsMaterial(type),
    manualBoostOverride: type !== "oneClickLift",
  };
  try { const result = await postJson("/api/task/preview", payload); createTaskDraft.preview = { ...result, payload }; const materialText = createTaskSkipsMaterial(type) ? result.formSummary.materialId : `已选 ${result.formSummary.materialIds?.length || 1} 条素材`; $("createTaskPreviewImage").src = result.screenshotPath; $("createTaskPreviewSummary").textContent = `${createTaskTypeLabel(type)}｜${materialText}｜预算 ${result.formSummary.budget} 元｜${result.formSummary.durationHours} 小时`; setCreateTaskPreviewStatus(""); $("createTaskStepPreview").hidden = false; } catch (error) { setCreateTaskPreviewStatus(`预览失败：${friendlyError(error)}`); } finally { button.disabled = false; button.textContent = "预览"; }
});
$("createTaskBack")?.addEventListener("click", () => { $("createTaskStepPreview").hidden = true; });
$("createTaskConfirm")?.addEventListener("click", async () => {
  const preview = createTaskDraft.preview; if (!preview) return; const payload = preview.payload;
  const result = await postJson("/api/action/command", { actionType: payload.type === "oneClickLift" ? "create_oneclick_task" : "create_boost_task", materialId: payload.materialId, materialIds: payload.materialIds, budget: payload.budget, durationHours: payload.durationHours, targetRoi: payload.targetRoi, payRoi: payload.payRoi, bidPrice: payload.bidPrice, boostType: payload.type === "liveScreenBoost" ? "liveScreenBoost" : payload.type.startsWith("materialCostControl") ? "materialCostControl" : "materialBoost", useLiveRoomImage: payload.useLiveRoomImage, manualBoostOverride: payload.manualBoostOverride, command: `${createTaskTypeLabel(payload.type)}（已预览）` });
  $("createTaskModal").close(); if (result.action) showActionConfirmDialog([result.action], "表单预览已完成。确认后将先进行 dryRun，再由你进行第二次真实执行确认。"); await refresh();
});
$("createTaskClose")?.addEventListener("click", () => $("createTaskModal").close());
$("createBoostTaskBtn")?.addEventListener("click", openCreateTaskModal);
$("createOneClickBtn")?.addEventListener("click", () => openCreateTaskModal("oneClickLift"));
$("taskActionForm")?.addEventListener("submit", (event) => {
  submitTaskActionDialog(event).catch((error) => {
    $("taskActionHint").textContent = `生成失败：${friendlyError(error)}`;
  });
});
$("taskActionClose")?.addEventListener("click", () => $("taskActionDialog").close());
$("taskActionCancel")?.addEventListener("click", () => $("taskActionDialog").close());
$("engineeringMonitorToggle")?.addEventListener("click", () => {
  engineeringMonitorExpanded = !engineeringMonitorExpanded;
  localStorage.setItem("engineeringMonitorExpandedV2", engineeringMonitorExpanded ? "1" : "0");
  pollEngineeringMonitor();
});
$("engineeringMonitorDetails")?.addEventListener("click", () => {
  engineeringMonitorExpanded = !engineeringMonitorExpanded;
  localStorage.setItem("engineeringMonitorExpandedV2", engineeringMonitorExpanded ? "1" : "0");
  pollEngineeringMonitor();
});
$("engineeringAlertClose")?.addEventListener("click", () => $("engineeringAlertDialog").close());
$("engineeringAlertOk")?.addEventListener("click", () => $("engineeringAlertDialog").close());
$("aiDialogClose").addEventListener("click", () => { if (currentAiBatch) markAiBatchDismissed(currentAiBatch.id); $("aiDialog").close(); });
$("aiApproveAll").addEventListener("click", approveAiBatch);
$("aiRejectAll").addEventListener("click", rejectAiBatch);
$("aiReviewEach").addEventListener("click", () => { if (currentAiBatch) renderAiDialog(currentAiBatch, true); });
$("aiDialogActions").addEventListener("click", (event) => { const button = event.target.closest("button[data-dialog-review]"); if (button) reviewDialogAction(button.dataset.actionId, button.dataset.dialogReview); });
applyMode(controlMode);
applyView(currentView);
refreshSecretStatus().catch(() => {});
refresh();
pollEngineeringMonitor();
setInterval(refresh, 3000);
setInterval(tickSystemStatus, 1000);
setInterval(pollEngineeringMonitor, ENGINEERING_POLL_INTERVAL_MS);
