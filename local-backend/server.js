const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const PROJECT_CONFIG_FILE = path.join(__dirname, "..", "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECRET_FILE = path.join(DATA_DIR, "secret.json");
const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshots.jsonl");
const LOG_FILE = path.join(DATA_DIR, "learning-log.jsonl");
const AI_LOG_FILE = path.join(DATA_DIR, "ai-log.jsonl");
const AI_MEMORY_FILE = path.join(DATA_DIR, "ai-memory.json");
const VISUAL_LOG_FILE = path.join(DATA_DIR, "visual-log.jsonl");
const RULES_FILE = path.join(__dirname, "INVESTMENT_RULES.md");
const { shouldCallAI } = require("./lib/trigger");
const { buildSystemPrompt, buildUserPayload, buildChatPrompt } = require("./lib/ai-prompt");
const deepseek = require("./lib/deepseek");
const dingtalk = require("./lib/dingtalk");
const claude = require("./lib/claude");
const { runVisualCapture } = require("./executor/visual-capture");
const { executeAction, previewTask } = require("./executor/action-executor");
const { runTaskCollector, stopTaskCollector, defaultStatus: defaultTaskCollectStatus } = require("./executor/task-collector");
const { runBoardCollector } = require("./executor/board-collector");
const { runBoardTrendCollector } = require("./executor/board-trend-collector");
const { runPlanCollector } = require("./executor/plan-collector");
const { runMaterialCollector } = require("./executor/material-collector");
const { screenMaterials } = require("./executor/material-screener");
const { chooseBaseSpendCandidate } = require("./lib/spend-metrics");
const { summarizeEngineeringHealth } = require("./lib/health-monitor");
const { buildLiveScreenUrl, buildTaskCenterUrl, findAdContextFromState, findLiveContextFromState, hasAdContext, taskCenterUrlFromSource } = require("./lib/qianchuan-url");
const { createSingleFlight } = require("./lib/single-flight");
const { recordCollectionIntegrity, integrityFor } = require("./lib/collection-integrity");
const { detectManualOperations, snapshotTasks } = require("./lib/operation-learner");

function loadInvestmentRules() {
  try {
    const content = fs.readFileSync(RULES_FILE, "utf8");
    const coreSections = content.match(/## 二[\s\S]*?(?=## 七|$)/)?.[0] || "";
    const scheduleSection = content.match(/## 七[\s\S]*?(?=## 八|$)/)?.[0] || "";
    return `${coreSections}\n${scheduleSection}`.trim();
  } catch {
    return "";
  }
}

const INVESTMENT_RULES_CONTEXT = loadInvestmentRules();

function loadProjectConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, "utf8"));
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

const PROJECT_CONFIG = loadProjectConfig();
const PROJECT_SOP = PROJECT_CONFIG.sop && typeof PROJECT_CONFIG.sop === "object" ? PROJECT_CONFIG.sop : {};
const PROJECT_ACCOUNT_ID = String(PROJECT_CONFIG.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "").trim();
const PROJECT_CDP_URL = String(PROJECT_CONFIG.cdp?.url || process.env.QIANCHUAN_CDP_URL || "http://127.0.0.1:9222").trim();
const PROJECT_DINGTALK = PROJECT_CONFIG.dingtalk && typeof PROJECT_CONFIG.dingtalk === "object" ? PROJECT_CONFIG.dingtalk : {};

const DEFAULT_AI_MEMORY = {
  version: 1,
  preferences: [
    "目标 ROI 必须按调控台系统目标 ROI，也就是 config.targetRoi；不要使用旧对话里的目标值。",
    "回答不能像模板框架，要先理解用户真实问题，再给投手视角的判断思路。",
    "自然语言问题按现象 -> 可能原因 -> 需要补采的数据 -> 下一步动作回答。",
    "素材点击少/点击率低问题优先看曝光、点击、点击率、消耗、素材承接和人群匹配，不要直接套追投占比模板。",
    "涉及执行动作必须保守，所有真实点击都需要用户确认。",
  ],
  messages: [],
  updatedAt: "",
};

function detectQuadrant(state) {
  const config = state.config || {};
  const targetRoi = config.targetRoi || 6.5;
  const currentHourRoi = Number(state.metrics?.currentHourRoi);
  const fiveMinSpend = Number(state.fiveMinSpend);
  const trendData = state.trendData || [];
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentPoints = trendData.filter((point) => Number(point.ts) > oneHourAgo && Number.isFinite(Number(point.cost)));
  const avgSpend = recentPoints.length
    ? recentPoints.reduce((sum, point) => sum + Number(point.cost), 0) / recentPoints.length
    : null;
  let spendLevel = "normal";
  if (avgSpend && Number.isFinite(fiveMinSpend)) {
    if (fiveMinSpend > avgSpend * 1.3) spendLevel = "high";
    else if (fiveMinSpend < avgSpend * 0.7) spendLevel = "low";
  }
  let roiLevel = "normal";
  if (Number.isFinite(currentHourRoi)) {
    if (currentHourRoi >= targetRoi) roiLevel = "high";
    else if (currentHourRoi < targetRoi * 0.5) roiLevel = "low";
  }
  if (spendLevel === "low" && roiLevel === "high") return { quadrant: "A", label: "低消耗·高ROI", strategy: "维稳为主，小幅放量" };
  if (spendLevel === "high" && roiLevel === "high") return { quadrant: "B", label: "高消耗·高ROI", strategy: "不动=最好的动作" };
  if (spendLevel === "high" && roiLevel === "low") return { quadrant: "C", label: "高消耗·低ROI", strategy: "止损优先" };
  if (spendLevel === "low" && roiLevel === "low") return { quadrant: "D", label: "低消耗·低ROI", strategy: "诊断优先，小额测试" };
  return { quadrant: "normal", label: "正常运行", strategy: "持续观察" };
}

function roiText(value) {
  const parsed = num(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed * 100) / 100) : "--";
}

function appendRoiLanguageCorrection(result = {}, state = {}) {
  if (!result || typeof result.reasoning !== "string") return result;
  const currentHourRoi = num(state.metrics?.currentHourRoi ?? state.hourlyBreakdown?.current?.roi);
  const targetRoi = num(state.config?.targetRoi) || DEFAULT_CONFIG.targetRoi;
  if (!Number.isFinite(currentHourRoi) || !Number.isFinite(targetRoi) || currentHourRoi >= targetRoi) return result;
  const text = result.reasoning;
  const mentionsWrongHighRoi = /(高于目标\s*0?\.?8|目标\s*[×x*]\s*0?\.?8|高\s*ROI|高ROI|象限A|低消耗高ROI|低消耗·高ROI|小幅放量)/i.test(text);
  const alreadyCorrected = /口径修正|不算高\s*ROI|不属于高\s*ROI|不达标/.test(text);
  if (!mentionsWrongHighRoi || alreadyCorrected) return result;
  const watchLine = Math.round(targetRoi * 0.8 * 100) / 100;
  return {
    ...result,
    reasoning: [
      text,
      "",
      `口径修正：当前单小时 ROI ${roiText(currentHourRoi)} 低于目标 ${roiText(targetRoi)}，不算高 ROI；目标 × 0.8 = ${roiText(watchLine)} 只是观察线/一键起量最低准入线，不能据此归为“低消耗高ROI”或“象限A”，也不能因为这个口径直接建议放量。`,
    ].join("\n"),
  };
}

function recoverFiveMinSpendFromBoardTrend(state, receivedAt = Date.now()) {
  const source = state.metricSources?.fiveMinSpend?.source;
  if (Number.isFinite(num(state.fiveMinSpend)) || Number.isFinite(num(state.metrics?.fiveMinSpend))) return false;
  if (source && source !== "qianchuan_board_trend") return false;
  const granularity = Number(state.boardTrend?.granularity || 5);
  if (granularity !== 5) return false;
  const latest = (state.boardTrend?.points || []).slice().reverse().find((point) => Number.isFinite(num(point.cost)));
  if (!latest) return false;
  state.metrics = state.metrics || {};
  state.fiveMinSpend = num(latest.cost);
  state.metrics.fiveMinSpend = num(latest.cost);
  setMetricSource(state, "fiveMinSpend", "qianchuan_board_trend", state.boardTrend?.receivedAt || receivedAt, {
    granularity,
    time: latest.time || "",
  });
  return true;
}

function isShiftProtection(config = {}) {
  const now = new Date();
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const shiftPoints = (config.investmentSop?.shiftTimes || ["10:00", "14:00", "18:00", "22:00"]).map(minutesOfDay);
  return shiftPoints.some((point) => Math.abs(totalMinutes - point) <= 15);
}

function isFirstHourProtection(config = {}) {
  const now = new Date();
  const open = minutesOfDay(config.openTime || config.investmentSop?.openTime || "06:00");
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return totalMinutes >= open && totalMinutes < open + 60;
}

const DEFAULT_INVESTMENT_SOP = {
  category: typeof PROJECT_SOP.category === "string" ? PROJECT_SOP.category.trim() : "",
  targetRoi: Number.isFinite(Number(PROJECT_SOP.targetRoi)) ? Number(PROJECT_SOP.targetRoi) : null,
  boostRatioLimit: Number.isFinite(Number(PROJECT_SOP.boostRatioLimit)) ? Number(PROJECT_SOP.boostRatioLimit) : null,
  maxBudgetIncrease: Number.isFinite(Number(PROJECT_SOP.maxBudgetIncrease)) ? Number(PROJECT_SOP.maxBudgetIncrease) : null,
  roiStep: Number.isFinite(Number(PROJECT_SOP.roiStep)) ? Number(PROJECT_SOP.roiStep) : null,
  avgOrderValue: Number.isFinite(Number(PROJECT_SOP.avgOrderValue)) ? Number(PROJECT_SOP.avgOrderValue) : null,
  grossMargin: Number.isFinite(Number(PROJECT_SOP.grossMargin)) ? Number(PROJECT_SOP.grossMargin) : null,
  returnRate: Number.isFinite(Number(PROJECT_SOP.returnRate)) ? Number(PROJECT_SOP.returnRate) : null,
  openTime: typeof PROJECT_SOP.openTime === "string" ? PROJECT_SOP.openTime.slice(0, 5) : "",
  closeTime: typeof PROJECT_SOP.closeTime === "string" ? PROJECT_SOP.closeTime.slice(0, 5) : "",
  shiftTimes: Array.isArray(PROJECT_SOP.shiftTimes) ? PROJECT_SOP.shiftTimes.map((item) => String(item).slice(0, 5)).filter(Boolean).slice(0, 8) : [],
  scenarioRules: typeof PROJECT_SOP.scenarioRules === "string" ? PROJECT_SOP.scenarioRules.trim() : "",
  pauseCondition: typeof PROJECT_SOP.pauseCondition === "string" ? PROJECT_SOP.pauseCondition.trim() : "",
  increaseCondition: typeof PROJECT_SOP.increaseCondition === "string" ? PROJECT_SOP.increaseCondition.trim() : "",
  lowerRoiCondition: typeof PROJECT_SOP.lowerRoiCondition === "string" ? PROJECT_SOP.lowerRoiCondition.trim() : "",
  autonomousBoostRules: typeof PROJECT_SOP.autonomousBoostRules === "string" ? PROJECT_SOP.autonomousBoostRules.trim() : "",
  faq: Array.isArray(PROJECT_SOP.faq) ? PROJECT_SOP.faq : [],
};

const DEFAULT_CONFIG = {
  actionMode: process.env.ACTION_MODE === "armed" ? "armed" : "review",
  accountId: PROJECT_ACCOUNT_ID,
  expectedAccountId: PROJECT_ACCOUNT_ID,
  roomStage: "normal",
  targetRoi: Number(PROJECT_CONFIG.targetRoi) || Number(PROJECT_SOP.targetRoi) || 6.5,
  baselineTargetRoi: Number(PROJECT_CONFIG.targetRoi) || Number(PROJECT_SOP.targetRoi) || 6.5,
  openTime: String(PROJECT_CONFIG.live?.openTime || PROJECT_SOP.openTime || "06:00").slice(0, 5),
  closeTime: String(PROJECT_CONFIG.live?.closeTime || PROJECT_SOP.closeTime || "02:00").slice(0, 5),
  highFiveMinSpend: 50,
  lowFiveMinSpend: 20,
  actionCooldownMs: 12 * 60 * 1000,
  actionExpiresMs: 30 * 60 * 1000,
  snapshotFreshnessMs: 10 * 60 * 1000,
  maxActionsPerHour: 3,
  maxRoiTarget: 9,
  minRoiTarget: 4.5,
  maxBudgetIncrease: 200,
  aiEnabled: false,
  aiMinIntervalMs: 5 * 60 * 1000,
  aiModel: String(PROJECT_CONFIG.deepseek?.model || "deepseek-v4-pro").trim(),
  cdpUrl: PROJECT_CDP_URL || "http://127.0.0.1:9222",
  executorDryRun: true,
  autoCollectEnabled: true,
  aiAutoCollectEnabled: true,
  aiAutoCollectRefreshOnStuck: true,
  visualCollectStaleMs: 15 * 60 * 1000,
  offAirLookbackMs: 12 * 60 * 1000,
  offAirConfirmationsRequired: 2,
  autoReviewAfterOffAir: true,
  materialCollectIntervalMs: 30 * 60 * 1000,
  dingtalk: {
    enabled: PROJECT_DINGTALK.enabled === true,
    webhook: typeof PROJECT_DINGTALK.webhook === "string" ? PROJECT_DINGTALK.webhook.trim() : "",
    secret: typeof PROJECT_DINGTALK.secret === "string" ? PROJECT_DINGTALK.secret.trim() : "",
    notifyCollectorError: true,
    notifyAiSuggestion: true,
    notifyActionResult: true,
    notifyHourlySummary: true,
    notifySystemAlert: true,
  },
  investmentSop: DEFAULT_INVESTMENT_SOP,
};

const TASK_SNAPSHOT_FRESHNESS_MS = 10 * 60 * 1000;
const HEALTH_FIX_COOLDOWN_MS = 60 * 60 * 1000;
const HEALTH_SILENT_FIX_LIMIT = 3;

function validTargetRoi(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 20 ? money(parsed) : null;
}

function cleanSopText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 4000) : fallback;
}

function validSopNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, money(parsed)));
}

function normalizeProfitModel(input = {}, fallback = DEFAULT_INVESTMENT_SOP.profitModel) {
  if (!input || typeof input !== "object") return null;
  const source = input && typeof input === "object" ? input : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const breakEvenSource = Array.isArray(source.breakEvenRoiByGmv) ? source.breakEvenRoiByGmv : base.breakEvenRoiByGmv;
  return {
    source: cleanSopText(source.source, base.source || "").slice(0, 120),
    product: cleanSopText(source.product, base.product || "").slice(0, 120),
    price: validSopNumber(source.price, base.price || 0, 0, 1000000),
    productGrossMargin: validSopNumber(source.productGrossMargin, base.productGrossMargin || 0, 0, 100),
    otherProductGrossMargin: validSopNumber(source.otherProductGrossMargin, base.otherProductGrossMargin || 0, 0, 100),
    productCost: validSopNumber(source.productCost, base.productCost || 0, 0, 1000000),
    nominalUnitGrossProfit: validSopNumber(source.nominalUnitGrossProfit, base.nominalUnitGrossProfit || 0, 0, 1000000),
    returnRate: validSopNumber(source.returnRate, base.returnRate || 0, 0, 100),
    vatDivisor: validSopNumber(source.vatDivisor, base.vatDivisor || 1, 0.01, 100),
    platformFeeRate: validSopNumber(source.platformFeeRate, base.platformFeeRate || 0, 0, 100),
    logisticsRate: validSopNumber(source.logisticsRate, base.logisticsRate || 0, 0, 100),
    lowCostRate: validSopNumber(source.lowCostRate, base.lowCostRate || 0, 0, 100),
    adTaxDivisor: validSopNumber(source.adTaxDivisor, base.adTaxDivisor || 1, 0.01, 100),
    laborCostPerHour: validSopNumber(source.laborCostPerHour, base.laborCostPerHour || 0, 0, 1000000),
    modelRoi: validSopNumber(source.modelRoi ?? source.targetRoi, base.modelRoi || 8, 1, 20),
    breakEvenRoiByGmv: (breakEvenSource || []).map((item) => ({
      gmv: validSopNumber(item?.gmv, 0, 0, 100000000),
      roi: validSopNumber(item?.roi, 0, 0, 100),
    })).filter((item) => item.gmv > 0 && item.roi > 0).slice(0, 12),
  };
}

function normalizeInvestmentSop(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const base = DEFAULT_INVESTMENT_SOP;
  const shiftTimes = Array.isArray(source.shiftTimes)
    ? source.shiftTimes.map((item) => cleanSopText(item)).filter(Boolean).slice(0, 8)
    : base.shiftTimes;
  const faqSource = Array.isArray(source.faq) ? source.faq : base.faq;
  const faq = faqSource.map((group, index) => {
    const fallbackGroup = base.faq[index] || { category: "未分类", items: [] };
    const items = Array.isArray(group?.items) ? group.items : fallbackGroup.items;
    return {
      category: cleanSopText(group?.category, fallbackGroup.category).slice(0, 40),
      items: items.map((item) => ({
        q: cleanSopText(item?.q).slice(0, 160),
        a: cleanSopText(item?.a).slice(0, 500),
      })).filter((item) => item.q || item.a).slice(0, 20),
    };
  }).filter((group) => group.category).slice(0, 12);
  return {
    category: cleanSopText(source.category, base.category).slice(0, 60),
    targetRoi: validSopNumber(source.targetRoi, base.targetRoi, 1, 20),
    boostRatioLimit: validSopNumber(source.boostRatioLimit, base.boostRatioLimit, 1, 100),
    maxBudgetIncrease: validSopNumber(source.maxBudgetIncrease, base.maxBudgetIncrease, 1, 100000),
    roiStep: validSopNumber(source.roiStep, base.roiStep, 0.01, 5),
    avgOrderValue: validSopNumber(source.avgOrderValue, base.avgOrderValue, 0, 1000000),
    grossMargin: validSopNumber(source.grossMargin, base.grossMargin, 0, 100),
    returnRate: validSopNumber(source.returnRate, base.returnRate, 0, 100),
    openTime: cleanSopText(source.openTime, base.openTime).slice(0, 5),
    closeTime: cleanSopText(source.closeTime, base.closeTime).slice(0, 5),
    shiftTimes,
    scenarioRules: cleanSopText(source.scenarioRules, base.scenarioRules),
    pauseCondition: cleanSopText(source.pauseCondition, base.pauseCondition).slice(0, 500),
    increaseCondition: cleanSopText(source.increaseCondition, base.increaseCondition).slice(0, 500),
    lowerRoiCondition: cleanSopText(source.lowerRoiCondition, base.lowerRoiCondition).slice(0, 500),
    autonomousBoostRules: cleanSopText(source.autonomousBoostRules, base.autonomousBoostRules),
    faq,
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function hasDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return true;
  if (typeof PROJECT_CONFIG.deepseek?.apiKey === "string" && PROJECT_CONFIG.deepseek.apiKey.trim()) return true;
  return Boolean(readJson(SECRET_FILE, {}).deepseekApiKey);
}

function saveSecret(patch) {
  const key = typeof patch.deepseekApiKey === "string" ? patch.deepseekApiKey.trim() : "";
  if (!key) return { ok: false, error: "deepseek_api_key_required" };
  writeJson(SECRET_FILE, { deepseekApiKey: key });
  return { ok: true };
}

function defaultAiMemory() {
  return { ...DEFAULT_AI_MEMORY, preferences: [...DEFAULT_AI_MEMORY.preferences], messages: [], updatedAt: new Date().toISOString() };
}

function readAiMemory() {
  const memory = readJson(AI_MEMORY_FILE, null);
  if (!memory || typeof memory !== "object") return defaultAiMemory();
  return {
    version: 1,
    preferences: Array.isArray(memory.preferences) ? memory.preferences.filter(Boolean).slice(0, 30) : [...DEFAULT_AI_MEMORY.preferences],
    messages: Array.isArray(memory.messages) ? memory.messages.filter((item) => item && item.role && item.content).slice(-50) : [],
    updatedAt: memory.updatedAt || "",
  };
}

function writeAiMemory(memory) {
  writeJson(AI_MEMORY_FILE, {
    version: 1,
    preferences: Array.isArray(memory.preferences) ? memory.preferences.filter(Boolean).slice(0, 30) : [...DEFAULT_AI_MEMORY.preferences],
    messages: Array.isArray(memory.messages) ? memory.messages.filter((item) => item && item.role && item.content).slice(-50) : [],
    updatedAt: new Date().toISOString(),
  });
}

function mergePreference(preferences = [], item = "") {
  const text = String(item || "").trim();
  if (!text || preferences.includes(text)) return preferences;
  return [...preferences, text].slice(-30);
}

function inferMemoryPreferences(message = "") {
  const text = String(message || "");
  const preferences = [];
  if (/6\.5|目标\s*roi|ROI\s*目标/i.test(text)) preferences.push("用户强调 ROI 目标值是 6.5，回答和判断不要写成 6.6。");
  if (/不是框架|不要.*框架|有大脑|思路|不要.*模板|别.*模板/.test(text)) preferences.push("用户希望 AI 像有大脑的投手一样先理解问题和推理，不要关键词套模板。");
  if (/点击少|点击率|点击次数|流量少|曝光少/.test(text)) preferences.push("用户关注素材放量点击少时，要围绕曝光、点击率、素材吸引力、冷启动、人群和承接拆解。");
  if (/记住|以后|以后都|下次|固定/.test(text)) preferences.push(`用户明确要求记住：${text.slice(0, 120)}`);
  return preferences;
}

function rememberAiChat(message = "", reply = "", actions = []) {
  const memory = readAiMemory();
  inferMemoryPreferences(message).forEach((item) => {
    memory.preferences = mergePreference(memory.preferences, item);
  });
  const now = Date.now();
  memory.messages.push({ role: "user", content: String(message || "").slice(0, 1000), ts: now });
  memory.messages.push({
    role: "assistant",
    content: String(reply || "").slice(0, 1500),
    actions: Array.isArray(actions) ? actions.map((action) => ({ type: action.type, taskId: action.payload?.taskId || action.taskId })).slice(0, 5) : [],
    ts: now,
  });
  memory.messages = memory.messages.slice(-50);
  writeAiMemory(memory);
  return memory;
}

function rotateJsonl(file, maxLines = 2000, keepLines = 500, maxBytes = 20 * 1024 * 1024) {
  if (!fs.existsSync(file)) return;
  // 先看文件大小，超过 maxBytes（默认 20MB）直接按 tail 命令裁剪，避免读入内存
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) {
    try {
      const { execSync } = require("child_process");
      const tmp = `${file}.tmp`;
      execSync(`tail -n ${keepLines} ${JSON.stringify(file)} > ${JSON.stringify(tmp)} && mv ${JSON.stringify(tmp)} ${JSON.stringify(file)}`);
      return;
    } catch {
      // tail 失败时跳过裁剪，不阻断启动
      return;
    }
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length > maxLines) fs.writeFileSync(file, `${lines.slice(-keepLines).join("\n")}\n`);
}

function migrateConfig(config = {}) {
  const migrated = { ...config };
  const legacyModeKey = "auto" + "Execute";
  if (migrated.actionMode === undefined && migrated[legacyModeKey] !== undefined) {
    migrated.actionMode = migrated[legacyModeKey] ? "armed" : "review";
  }
  delete migrated[legacyModeKey];
  const accountId = String(migrated.accountId || migrated.expectedAccountId || DEFAULT_CONFIG.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "").trim();
  migrated.accountId = accountId;
  migrated.expectedAccountId = accountId;
  if (Number(migrated.actionExpiresMs || 0) < DEFAULT_CONFIG.actionExpiresMs) {
    migrated.actionExpiresMs = DEFAULT_CONFIG.actionExpiresMs;
  }
  if (Number(migrated.visualCollectStaleMs || 0) < DEFAULT_CONFIG.visualCollectStaleMs) {
    migrated.visualCollectStaleMs = DEFAULT_CONFIG.visualCollectStaleMs;
  }
  migrated.investmentSop = normalizeInvestmentSop(migrated.investmentSop);
  if (Number.isFinite(Number(migrated.investmentSop.targetRoi))) {
    migrated.targetRoi = migrated.investmentSop.targetRoi;
    migrated.baselineTargetRoi = migrated.investmentSop.targetRoi;
  }
  if (migrated.investmentSop.openTime) migrated.openTime = migrated.investmentSop.openTime;
  if (migrated.investmentSop.closeTime) migrated.closeTime = migrated.investmentSop.closeTime;
  if (Number.isFinite(Number(migrated.investmentSop.maxBudgetIncrease))) migrated.maxBudgetIncrease = migrated.investmentSop.maxBudgetIncrease;
  const dingtalkConfig = migrated.dingtalk && typeof migrated.dingtalk === "object" ? migrated.dingtalk : DEFAULT_CONFIG.dingtalk;
  migrated.dingtalk = {
    enabled: dingtalkConfig.enabled === true,
    webhook: typeof dingtalkConfig.webhook === "string" ? dingtalkConfig.webhook.trim() : "",
    secret: typeof dingtalkConfig.secret === "string" ? dingtalkConfig.secret.trim() : "",
    notifyCollectorError: dingtalkConfig.notifyCollectorError !== false,
    notifyAiSuggestion: dingtalkConfig.notifyAiSuggestion !== false,
    notifyActionResult: dingtalkConfig.notifyActionResult !== false,
    notifyHourlySummary: dingtalkConfig.notifyHourlySummary !== false,
    notifySystemAlert: dingtalkConfig.notifySystemAlert !== false,
  };
  return { ...DEFAULT_CONFIG, ...migrated, investmentSop: migrated.investmentSop, dingtalk: migrated.dingtalk };
}

function maskConfigValue(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "********";
  return `${text.slice(0, 4)}********${text.slice(-4)}`;
}

function maskDingTalkWebhook(webhook = "") {
  if (!webhook) return "";
  try {
    const url = new URL(webhook);
    Array.from(url.searchParams.keys()).forEach((key) => {
      url.searchParams.set(key, maskConfigValue(url.searchParams.get(key)));
    });
    return url.toString();
  } catch {
    return "configured";
  }
}

function publicDingTalkConfig(config = {}) {
  const dingtalkConfig = config.dingtalk && typeof config.dingtalk === "object" ? config.dingtalk : {};
  const webhook = typeof dingtalkConfig.webhook === "string" ? dingtalkConfig.webhook.trim() : "";
  const secret = typeof dingtalkConfig.secret === "string" ? dingtalkConfig.secret.trim() : "";
  return {
    enabled: dingtalkConfig.enabled === true,
    configured: Boolean(webhook && secret),
    webhook: maskDingTalkWebhook(webhook),
    hasSecret: Boolean(secret),
    notifyCollectorError: dingtalkConfig.notifyCollectorError !== false,
    notifyAiSuggestion: dingtalkConfig.notifyAiSuggestion !== false,
    notifyActionResult: dingtalkConfig.notifyActionResult !== false,
    notifyHourlySummary: dingtalkConfig.notifyHourlySummary !== false,
    notifySystemAlert: dingtalkConfig.notifySystemAlert !== false,
  };
}

function publicConfig(config = {}) {
  const migrated = migrateConfig(config);
  return { ...migrated, dingtalk: publicDingTalkConfig(migrated) };
}

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "visual"), { recursive: true });
  rotateJsonl(SNAPSHOT_FILE);
  rotateJsonl(LOG_FILE);
  rotateJsonl(AI_LOG_FILE);
  rotateJsonl(VISUAL_LOG_FILE);
  if (!fs.existsSync(AI_MEMORY_FILE)) writeAiMemory(defaultAiMemory());
  const state = readJson(STATE_FILE, null);
  if (!state) {
    writeJson(STATE_FILE, {
      config: DEFAULT_CONFIG,
      latestByPage: {},
      metrics: {},
      actions: [],
      lastActionAt: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  state.config = migrateConfig(state.config);
  cancelObsoleteAiBoostPauseActions(state);
  if (state.taskCollectStatus?.running) {
    state.taskCollectStatus = {
      ...(state.taskCollectStatus || {}),
      running: false,
      paused: false,
      status: "stopped",
      currentStep: "stopped_after_restart",
      stepLabel: "上次采集已随后端重启中止",
      lastError: "后端重启，已中止上一轮未完成采集",
      stopRequested: false,
      finishedAt: Date.now(),
    };
  }
  if (!hasMaterialIndex(state.materialIndex)) state.materialIndex = loadMaterialIndexFromSnapshots();
  writeJson(STATE_FILE, state);
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

function firstReasonableTotalMetric(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (Number.isFinite(parsed) && parsed > 10) return parsed;
  }
  return null;
}

function calcBoostRatio(overallCost, baseSpend) {
  if (!Number.isFinite(overallCost) || overallCost <= 0) return null;
  if (!Number.isFinite(baseSpend) || baseSpend <= 0) return null;
  if (baseSpend > overallCost) return null;
  return Math.round((overallCost - baseSpend) / overallCost * 10000) / 100;
}

function cleanMetricPatch(metrics = {}) {
  const patch = {};
  Object.entries(metrics || {}).forEach(([key, value]) => {
    if (key === "baseSpendSource" && typeof value === "string") {
      patch[key] = value;
      return;
    }
    const parsed = num(value);
    if (!Number.isFinite(parsed)) return;
    if ((key === "overallCost" || key === "dealAmount") && parsed <= 10) return;
    if (key === "orderCost" && parsed <= 1) return;
    if (key === "overallRoi" && parsed <= 0) return;
    patch[key] = parsed;
  });
  return patch;
}

function isActiveTask(task = {}) {
  return String(task.status || "").includes("调控中");
}

function normalizeTask(task = {}) {
  if (task.taskId) return task;
  // 从 name 字段里提取 taskId，格式："任务名\nID: 1869xxx" 或 "任务名 ID: 1869xxx"
  const nameText = String(task.name || "");
  const match = nameText.match(/ID[：:\s]*(\d{12,})/);
  const taskId = match?.[1] || "";
  // taskName 取 ID 前面的部分（去掉换行和多余空格）
  const taskName = nameText.split(/\n|ID[：:\s]*\d{12,}/)[0].trim();
  return { ...task, taskId, taskName: taskName || task.taskName || task.name };
}

function isRegulationTaskType(taskType = "") {
  return ["materialBoost", "materialCostControl", "oneClickLift"].includes(taskType);
}

function hasNumericTaskId(task = {}) {
  return /^\d{8,}$/.test(String(task.taskId || task.id || "").trim());
}

function isMaterialAssetRecord(task = {}) {
  if (task.taskType !== "materialBoost") return false;
  const id = String(task.taskId || task.id || "").trim();
  const text = String(`${task.name || ""} ${task.taskName || ""} ${task.rawText || ""}`);
  return /^7\d{12,}$/.test(id) && /素材ID[：:\s]*\d{8,}/.test(text) && !/任务ID[：:\s]*\d{8,}/.test(text);
}

function isVisualPageNoiseTask(task = {}, state = {}) {
  const id = String(task.taskId || task.id || "").trim();
  const name = String(task.name || task.taskName || "").trim();
  const text = `${name} ${task.rawText || ""}`;
  if (id && id === String(state.config?.expectedAccountId || "")) return true;
  const pageNoise = /首页\s*乘方|千川可用余额|千川日预算|授权待处理|计划ID[：:\s]*\d{8,}|抖音号ID[：:\s]*\d{8,}/.test(text);
  if (!pageNoise) return false;
  return !/^20\d{6}_/.test(name);
}

function filterDisplayableTasks(tasks = [], state = {}) {
  return tasks.filter((task) => {
    if (!isRegulationTaskType(task.taskType || "")) return true;
    if (!hasNumericTaskId(task)) return false;
    if (isVisualPageNoiseTask(task, state)) return false;
    return !isMaterialAssetRecord(task);
  });
}

function taskIdentity(task = {}) {
  const id = String(task.taskId || task.id || "").trim();
  if (id) return `id:${id}`;
  const name = String(task.name || task.taskName || "").replace(/\s+/g, " ").trim();
  return name ? `name:${name}` : "";
}

function taskQualityScore(task = {}) {
  const finite = (value) => Number.isFinite(Number(value));
  let score = 0;
  if (task.taskId || task.id) score += 5;
  if (task.name || task.taskName) score += 3;
  if (task.sourceUrl) score += 3;
  if (Array.isArray(task.materialIds) && task.materialIds.length) score += 2;
  if (finite(task.budget)) score += 3;
  if (finite(task.spend)) score += 3;
  if (finite(task.roi)) score += 3;
  if (finite(task.dealAmount)) score += 3;
  if (finite(task.impressions)) score += 1;
  if (finite(task.clicks)) score += 1;
  if (String(task.status || "").trim()) score += 2;
  if (task.taskType && task.taskType !== "unknown") score += 1;
  return score;
}

function preferTaskRecord(current = {}, candidate = {}) {
  if (candidate.source === "task_collector" && current.source !== "task_collector") return candidate;
  if (current.source === "task_collector" && candidate.source !== "task_collector") return current;
  const currentScore = taskQualityScore(current);
  const candidateScore = taskQualityScore(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  const currentSpend = Number(current.spend);
  const candidateSpend = Number(candidate.spend);
  if (Number.isFinite(candidateSpend) && Number.isFinite(currentSpend) && candidateSpend !== currentSpend) {
    return candidateSpend > currentSpend ? candidate : current;
  }
  const currentReceivedAt = Number(current.receivedAt);
  const candidateReceivedAt = Number(candidate.receivedAt);
  if (Number.isFinite(candidateReceivedAt) && Number.isFinite(currentReceivedAt) && candidateReceivedAt !== currentReceivedAt) {
    return candidateReceivedAt > currentReceivedAt ? candidate : current;
  }
  return candidate;
}

function dedupeTasks(tasks = []) {
  const byKey = new Map();
  const result = [];
  tasks.forEach((task) => {
    const key = taskIdentity(task);
    if (!key) {
      result.push(task);
      return;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, task);
      result.push(task);
      return;
    }
    const preferred = preferTaskRecord(existing, task);
    if (preferred === existing) return;
    byKey.set(key, preferred);
    const index = result.indexOf(existing);
    if (index >= 0) result[index] = preferred;
  });
  return result;
}

function compactTaskForState(task = {}) {
  if (!["materialBoost", "materialCostControl", "oneClickLift"].includes(task.taskType || "")) return task;
  const { materialIds, materialId, materialSource, ...rest } = task;
  return rest;
}

function compactTasksForState(tasks = []) {
  return tasks.map(compactTaskForState);
}

function taskListForState(tasks = [], state = {}) {
  return compactTasksForState(filterDisplayableTasks(dedupeTasks(enrichTasksWithMaterialMap(
    enrichTasksWithMaterialInfo(tasks.map(normalizeTask), state.materialIndex || {}),
    state.materialMap || {},
  )), state));
}

function pickMaterialInfoMap(fields) {
  const map = fields?.data?.data?.materialInfoMap;
  if (!map || typeof map !== "object") return null;
  return map;
}

function materialIndexKeysFromPageUrl(pageUrl = "") {
  const keys = new Set();
  const raw = String(pageUrl || "");
  if (!raw) return [];
  keys.add(raw);
  (raw.match(/\d{12,}/g) || []).forEach((id) => keys.add(id));
  const addUrlParts = (value) => {
    try {
      const parsed = new URL(value);
      ["adId", "materialId", "taskId", "promotionId", "uniPromotionId", "id"].forEach((key) => {
        const item = parsed.searchParams.get(key);
        if (item) keys.add(item);
      });
      const hashText = decodeURIComponent(String(parsed.hash || ""));
      (hashText.match(/\d{12,}/g) || []).forEach((id) => keys.add(id));
      const hashMatch = hashText.match(/uniDetail=([^&]+)/);
      if (hashMatch) {
        try {
          const detail = JSON.parse(decodeURIComponent(hashMatch[1]));
          Object.values(detail || {}).forEach((item) => {
            if (/^\d{12,}$/.test(String(item || ""))) keys.add(String(item));
          });
        } catch {}
      }
    } catch {}
  };
  addUrlParts(raw);
  return Array.from(keys);
}

function mergeMaterialIndex(existing = {}, materialInfoMap = {}, receivedAt = Date.now(), context = {}) {
  const pageUrl = String(context.pageUrl || "");
  const pageKeys = materialIndexKeysFromPageUrl(pageUrl);
  const records = Object.entries(materialInfoMap).map(([materialObjectId, info = {}]) => ({
    materialObjectId: String(materialObjectId),
    materialId: String(info.materialId || ""),
    aggregateAid: String(info.aggregateAid || ""),
    pageUrl,
    pageKeys,
    receivedAt,
  })).filter((record) => record.materialObjectId);
  const next = {
    byMaterialObjectId: { ...(existing.byMaterialObjectId || {}) },
    byAggregateAid: { ...(existing.byAggregateAid || {}) },
    byTaskPageKey: { ...(existing.byTaskPageKey || {}) },
    receivedAt,
  };
  records.forEach((record) => {
    next.byMaterialObjectId[record.materialObjectId] = record;
    if (record.aggregateAid) {
      next.byAggregateAid[record.aggregateAid] = [
        record,
        ...(next.byAggregateAid[record.aggregateAid] || []).filter((item) => item.materialObjectId !== record.materialObjectId),
      ].slice(0, 20);
    }
    record.pageKeys.forEach((key) => {
      next.byTaskPageKey[key] = [
        record,
        ...(next.byTaskPageKey[key] || []).filter((item) => item.materialObjectId !== record.materialObjectId),
      ].slice(0, 20);
    });
  });
  return next;
}

function taskCandidateIds(task = {}) {
  const values = [task.taskId, task.id, task.object, task.rawText, task.sourceUrl, task.name].map((value) => String(value || ""));
  const ids = new Set();
  values.forEach((value) => {
    (value.match(/\d{12,}/g) || []).forEach((id) => ids.add(id));
  });
  try {
    const sourceUrl = new URL(String(task.sourceUrl || ""));
    ["adId", "materialId", "live_room_id"].forEach((key) => {
      const value = sourceUrl.searchParams.get(key);
      if (value) ids.add(value);
    });
  } catch {}
  return Array.from(ids);
}

function enrichTaskWithMaterialInfo(task = {}, materialIndex = {}) {
  const ids = taskCandidateIds(task);
  const matches = [];
  ids.forEach((id) => {
    const direct = materialIndex.byMaterialObjectId?.[id];
    if (direct) matches.push(direct);
    (materialIndex.byTaskPageKey?.[id] || []).forEach((record) => matches.push(record));
    (materialIndex.byAggregateAid?.[id] || []).forEach((record) => matches.push(record));
  });
  materialIndexKeysFromPageUrl(task.sourceUrl).forEach((key) => {
    (materialIndex.byTaskPageKey?.[key] || []).forEach((record) => matches.push(record));
  });
  const unique = matches.filter((record, index, list) => list.findIndex((item) => item.materialObjectId === record.materialObjectId) === index);
  if (!unique.length) return task;
  const materialIds = unique.map((record) => record.materialObjectId).filter(Boolean);
  const aggregateAids = unique.map((record) => record.aggregateAid).filter(Boolean);
  return {
    ...task,
    materialIds,
    materialId: materialIds[0] || task.materialId,
    aggregateAid: aggregateAids[0] || task.aggregateAid,
    materialSource: "api_material_list_optional",
  };
}

function enrichTasksWithMaterialInfo(tasks = [], materialIndex = {}) {
  return tasks.map((task) => enrichTaskWithMaterialInfo(task, materialIndex));
}

function enrichTaskWithMaterialMap(task = {}, materialMap = {}) {
  if (Array.isArray(task.materialIds) && task.materialIds.length) return task;
  const adIdMatch = String(task.sourceUrl || "").match(/adId=(\d+)/);
  const adId = adIdMatch ? adIdMatch[1] : "";
  const materialIds = materialMap[adId]?.materialIds || [];
  if (!materialIds.length) return task;
  return {
    ...task,
    materialIds,
    materialId: materialIds[0] || task.materialId,
    aggregateAid: adId || task.aggregateAid,
    materialSource: "api_material_list_optional",
  };
}

function enrichTasksWithMaterialMap(tasks = [], materialMap = {}) {
  return tasks.map((task) => enrichTaskWithMaterialMap(task, materialMap));
}

function loadJsonl(file, limit = 500) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadMaterialIndexFromSnapshots(limit = 1000) {
  return loadJsonl(SNAPSHOT_FILE, limit).reduce((index, snapshot) => {
    const map = pickMaterialInfoMap(snapshot.fields);
    return map ? mergeMaterialIndex(index, map, snapshot.receivedAt || Date.now(), { pageUrl: snapshot.fields?.pageUrl }) : index;
  }, {});
}

function hasMaterialIndex(index = {}) {
  return Object.keys(index.byMaterialObjectId || {}).length > 0
    || Object.keys(index.byAggregateAid || {}).length > 0
    || Object.keys(index.byTaskPageKey || {}).length > 0;
}

function minutesOfDay(value) {
  const [hour, minute] = String(value || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function isInLiveWindow(config, date = new Date()) {
  const now = date.getHours() * 60 + date.getMinutes();
  const open = minutesOfDay(config.openTime);
  const close = minutesOfDay(config.closeTime);
  return open <= close ? now >= open && now <= close : now >= open || now <= close;
}

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function liveDayBounds(config = {}, date = new Date()) {
  const open = minutesOfDay(config.openTime);
  const close = minutesOfDay(config.closeTime);
  const now = date.getHours() * 60 + date.getMinutes();
  const start = new Date(date);
  start.setHours(Math.floor(open / 60), open % 60, 0, 0);
  if (open > close && now < open) start.setDate(start.getDate() - 1);
  if (open <= close && now < open) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  const durationMinutes = open <= close ? close - open : 24 * 60 - open + close;
  end.setMinutes(end.getMinutes() + durationMinutes);
  return { dayKey: dateKey(start), startAt: start.getTime(), endAt: end.getTime() };
}

function tsMs(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return null;
  return ts < 1000000000000 ? ts * 1000 : ts;
}

function pointsForLiveDay(points = [], bounds) {
  return points
    .map((point) => ({ ...point, ts: tsMs(point.ts) }))
    .filter((point) => Number.isFinite(point.ts) && point.ts >= bounds.startAt && point.ts <= bounds.endAt);
}

function currentHourStart(ts = Date.now()) {
  const date = new Date(ts);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function sumCurrentHourTrendSpend(points = [], receivedAt = Date.now()) {
  const start = currentHourStart(receivedAt);
  const end = start + 60 * 60 * 1000;
  const total = points
    .map((point) => ({ ...point, ts: tsMs(point.ts), cost: num(point.cost) }))
    .filter((point) => Number.isFinite(point.ts) && point.ts >= start && point.ts < end && Number.isFinite(point.cost) && point.cost >= 0)
    .reduce((sum, point) => sum + point.cost, 0);
  return total > 0 ? money(total) : null;
}

function applyHourBoostRatioFromBaseSpend(state, hourSpend, hourBaseSpend, receivedAt = Date.now(), meta = {}) {
  state.metrics = state.metrics || {};
  const total = num(hourSpend);
  const base = num(hourBaseSpend);
  const { missingBaseReason, ...sourceMeta } = meta;
  const baseConsistent = Number.isFinite(base) && base >= 0 && (!Number.isFinite(total) || total <= 0 || base <= total);
  if (baseConsistent) {
    state.metrics.hourSegmentBaseSpend = money(base);
    setMetricSource(state, "hourSegmentBaseSpend", sourceMeta.baseSource || "metric_history", receivedAt, sourceMeta);
  }
  if (Number.isFinite(total) && total > 0 && baseConsistent && base <= total) {
    state.metrics.hourSegmentBoostRatio = calcBoostRatio(total, base);
    setMetricSource(state, "hourSegmentBoostRatio", sourceMeta.ratioSource || "hour_total_minus_base", receivedAt, {
      ...sourceMeta,
      formula: "(hourSegmentSpend - hourSegmentBaseSpend) / hourSegmentSpend",
      hourSegmentSpend: total,
      hourSegmentBaseSpend: base,
    });
    return true;
  }
  delete state.metrics.hourSegmentBoostRatio;
  if (!baseConsistent) delete state.metrics.hourSegmentBaseSpend;
  if (state.metricSources) {
    if (Number.isFinite(total) && Number.isFinite(base) && base > total) {
      delete state.metrics.hourSegmentBaseSpend;
      setMetricSource(state, "hourSegmentBaseSpend", "invalid_mixed_source", receivedAt, {
        ...sourceMeta,
        status: "error",
        message: "小时基础消耗大于小时综合消耗，疑似小时段或来源不一致，已暂不展示",
        hourSegmentSpend: total,
        hourSegmentBaseSpend: base,
      });
      setMetricSource(state, "hourSegmentBoostRatio", "invalid_mixed_source", receivedAt, {
        ...sourceMeta,
        status: "error",
        message: "小时基础消耗大于小时综合消耗，疑似小时段或来源不一致，已暂不计算",
        hourSegmentSpend: total,
        hourSegmentBaseSpend: base,
      });
    } else {
      delete state.metricSources.hourSegmentBoostRatio;
    }
    if (!Number.isFinite(base)) {
      delete state.metricSources.hourSegmentBaseSpend;
      if (missingBaseReason) {
        setMetricSource(state, "hourSegmentBaseSpend", "hourly_base_dom_missing", receivedAt, {
          ...sourceMeta,
          status: "error",
          message: missingBaseReason,
        });
        setMetricSource(state, "hourSegmentBoostRatio", "hourly_base_dom_missing", receivedAt, {
          ...sourceMeta,
          status: "error",
          message: "当前小时基础消耗未采集到，已暂不计算小时追投占比",
        });
      }
    }
  }
  return false;
}

function updateHourlySegmentMetrics(state, receivedAt = Date.now()) {
  state.metrics = state.metrics || {};
  if (isFreshDomHourlyBreakdown(state.hourlyBreakdown, receivedAt)) {
    applyHourlyCurrentMetricsFromState(state);
    return;
  }
  const overallCost = num(state.metrics.overallCost);
  const baseSpend = num(state.metrics.baseSpend);
  state.metricHistory = Array.isArray(state.metricHistory) ? state.metricHistory : [];
  const last = state.metricHistory.at(-1);
  if (
    Number.isFinite(overallCost)
    && Number.isFinite(baseSpend)
    && overallCost > 10
    && baseSpend > 0
    && baseSpend <= overallCost
    && (!last || receivedAt - Number(last.ts || 0) >= 60 * 1000 || overallCost !== Number(last.overallCost) || baseSpend !== Number(last.baseSpend))
  ) {
    state.metricHistory.push({ ts: receivedAt, overallCost, baseSpend });
  }
  state.metricHistory = state.metricHistory
    .filter((point) => Number(point.ts) >= receivedAt - 30 * 60 * 60 * 1000)
    .slice(-500);

  const hourStart = currentHourStart(receivedAt);
  const baseline = state.metricHistory
    .filter((point) => Number(point.ts) <= hourStart && Number(point.overallCost) <= overallCost)
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0]
    || state.metricHistory
      .filter((point) => Number(point.ts) >= hourStart && Number(point.ts) < receivedAt && Number(point.overallCost) <= overallCost)
      .sort((a, b) => Number(a.ts) - Number(b.ts))[0];

  let hourSpend = null;
  let hourBaseSpend = null;
  if (baseline) {
    const totalDelta = overallCost - Number(baseline.overallCost);
    const baseDelta = baseSpend - Number(baseline.baseSpend);
    if (Number.isFinite(totalDelta) && totalDelta >= 0) hourSpend = money(totalDelta);
    if (Number.isFinite(baseDelta) && baseDelta >= 0) hourBaseSpend = money(baseDelta);
  }
  if (!Number.isFinite(hourSpend)) {
    hourSpend = sumCurrentHourTrendSpend(state.trendData || [], receivedAt);
  }
  if (Number.isFinite(hourSpend) && (hourSpend > 0 || !Number.isFinite(num(state.metrics.hourSegmentSpend)))) {
    state.metrics.hourSegmentSpend = hourSpend;
    setMetricSource(state, "hourSegmentSpend", baseline ? "metric_history" : "totalTrend", receivedAt, { hourStart });
  }
  applyHourBoostRatioFromBaseSpend(state, state.metrics.hourSegmentSpend, hourBaseSpend, receivedAt, {
    hourStart,
    baselineTs: baseline?.ts,
    baseSource: "metric_history_base_delta",
    ratioSource: "hour_total_minus_base",
  });
}

function buildDailyReview(state, reason = "manual") {
  const bounds = liveDayBounds(state.config || {});
  const snapshots = loadJsonl(SNAPSHOT_FILE, 5000).filter((item) => {
    const ts = Number(item.receivedAt || item.timestamp);
    return Number.isFinite(ts) && ts >= bounds.startAt && ts <= bounds.endAt;
  });
  const visualLogs = loadJsonl(VISUAL_LOG_FILE, 800).filter((item) => {
    const ts = Number(item.capturedAt || item.collectedAt);
    return Number.isFinite(ts) && ts >= bounds.startAt && ts <= bounds.endAt;
  });
  const metrics = state.metrics || {};
  const overviewFields = state.latestByPage?.investOverview?.fields || {};
  const autoCollectFields = state.latestByPage?.autoCollect?.fields || {};
  const totalCost = firstFiniteMetric(overviewFields.overallCost, autoCollectFields.overallCost, metrics.overallCost);
  const dealAmount = firstFiniteMetric(overviewFields.dealAmount, autoCollectFields.dealAmount, metrics.dealAmount);
  const overallRoi = Number.isFinite(totalCost) && totalCost > 0 && Number.isFinite(dealAmount)
    ? money(dealAmount / totalCost)
    : firstFiniteMetric(overviewFields.overallRoi, autoCollectFields.overallRoi, metrics.overallRoi);
  const baseSpend = firstFiniteMetric(overviewFields.baseSpend, autoCollectFields.baseSpend, metrics.baseSpend);
  const apiTrendPoints = pointsForLiveDay(state.trendData || [], bounds);
  const visualTrendPoints = pointsForLiveDay(state.visualTrend || [], bounds);
  const trendPoints = [
    ...apiTrendPoints,
    ...visualTrendPoints,
  ].filter((point) => Number.isFinite(Number(point.cost)) || Number.isFinite(Number(point.revenue)));
  const spendPoints = (apiTrendPoints.length ? apiTrendPoints : visualTrendPoints)
    .filter((point) => Number.isFinite(Number(point.cost)) && Number(point.cost) >= 0);
  const boostRatio = calcBoostRatio(totalCost, baseSpend);
  const boostSpend = Number.isFinite(totalCost) && Number.isFinite(baseSpend) ? money(totalCost - baseSpend) : null;
  const maxFiveMinSpend = spendPoints.reduce((max, point) => {
    const cost = Number(point.cost);
    return Math.max(max, cost);
  }, 0);
  const tasks = Array.isArray(metrics.tasks) ? metrics.tasks : [];
  const activeTasks = tasks.filter(isActiveTask);
  const notes = [];
  if (Number.isFinite(overallRoi) && Number.isFinite(state.config?.targetRoi) && overallRoi < state.config.targetRoi) {
    notes.push(`全天综合 ROI ${overallRoi} 低于目标 ${state.config.targetRoi}`);
  }
  if (Number.isFinite(boostRatio) && boostRatio >= 40) notes.push(`追投占比 ${boostRatio}% 偏高，复盘需重点看追投效率`);
  if (!tasks.length) notes.push("未采集到调控任务明细，任务级复盘需要打开调控任务页后补采");
  if (!notes.length) notes.push("全天核心指标已归档，暂无明显异常信号");
  const review = {
    status: "ready",
    dayKey: bounds.dayKey,
    generatedAt: Date.now(),
    triggerReason: reason,
    range: {
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      startText: new Date(bounds.startAt).toISOString(),
      endText: new Date(bounds.endAt).toISOString(),
    },
    metrics: {
      totalCost,
      baseSpend,
      boostSpend,
      boostRatio: Number.isFinite(boostRatio) ? boostRatio : null,
      dealAmount,
      overallRoi,
      gpm: money(num(metrics.gpm)),
      totalViewers: Number.isFinite(num(metrics.totalViewers)) ? Math.round(num(metrics.totalViewers)) : null,
      exposureWatchRate: money(num(metrics.exposureWatchRate)),
      watchDealRate: money(num(metrics.watchDealRate)),
      maxFiveMinSpend: Number.isFinite(maxFiveMinSpend) ? money(maxFiveMinSpend) : null,
    },
    tasks: {
      total: tasks.length,
      active: activeTasks.length,
      groups: Object.fromEntries(Object.entries(state.taskGroups || {}).map(([key, list]) => [key, Array.isArray(list) ? list.length : 0])),
    },
    dataCoverage: {
      snapshots: snapshots.length,
      visualCaptures: visualLogs.length,
      trendPoints: trendPoints.length,
      latestPages: Object.keys(state.latestByPage || {}),
    },
    notes,
  };
  const reviewDir = path.join(DATA_DIR, "reviews");
  fs.mkdirSync(reviewDir, { recursive: true });
  const filePath = path.join(reviewDir, `daily-review-${bounds.dayKey}.json`);
  writeJson(filePath, review);
  return { ...review, file: `/reviews/daily-review-${bounds.dayKey}.json` };
}

function visualLiveSignals(visualCapture = {}) {
  const signals = [];
  if (visualCapture.liveStatus) signals.push({ ...visualCapture.liveStatus, source: "visualCapture" });
  (visualCapture.pages || []).forEach((page) => {
    if (page?.liveStatus) signals.push({
      ...page.liveStatus,
      source: page.pageType || page.label || "page",
      title: page.title || page.label || "",
    });
  });
  if (!signals.length && visualCapture.route === "overall" && Number(visualCapture.extractedMetrics?.onlineCount) === 0) {
    signals.push({ status: "suspected_off_air", confidence: 0.6, reason: "整体采集在线人数为 0", source: "overall_metrics" });
  }
  return signals.filter((signal) => signal.status && signal.status !== "unknown");
}

function strongestLiveSignal(signals = []) {
  return signals.find((signal) => signal.status === "off_air")
    || signals.find((signal) => signal.status === "live")
    || signals.find((signal) => signal.status === "suspected_off_air")
    || null;
}

function applyLiveLifecycleSignal(state, signal, receivedAt = Date.now()) {
  if (!signal) return false;
  state.config = migrateConfig(state.config);
  const previous = state.liveLifecycle || {};
  const day = liveDayBounds(state.config, new Date(receivedAt));
  if (signal.status === "live") {
    state.liveLifecycle = {
      ...previous,
      status: "live",
      dayKey: day.dayKey,
      offAirHitCount: 0,
      lastSignalAt: receivedAt,
      lastSignal: signal,
    };
    return JSON.stringify(previous) !== JSON.stringify(state.liveLifecycle);
  }
  if (signal.status !== "off_air" && signal.status !== "suspected_off_air") return false;
  const lookbackMs = Number(state.config.offAirLookbackMs) || DEFAULT_CONFIG.offAirLookbackMs;
  const freshPrevious = previous.lastSignalAt && receivedAt - previous.lastSignalAt <= lookbackMs;
  const hitCount = freshPrevious ? Number(previous.offAirHitCount || 0) + 1 : 1;
  const required = signal.status === "off_air" ? 1 : Number(state.config.offAirConfirmationsRequired || DEFAULT_CONFIG.offAirConfirmationsRequired);
  const confirmed = hitCount >= required;
  state.liveLifecycle = {
    ...previous,
    status: confirmed ? "off_air" : "suspected_off_air",
    dayKey: day.dayKey,
    offAirHitCount: hitCount,
    requiredConfirmations: required,
    lastSignalAt: receivedAt,
    lastSignal: signal,
  };
  if (confirmed && previous.status !== "off_air") {
    state.config.autoCollectEnabled = false;
    state.config.aiEnabled = false;
    state.liveLifecycle.autoCollectStoppedAt = receivedAt;
    state.liveLifecycle.aiStoppedAt = receivedAt;
    appendJsonl(LOG_FILE, {
      id: `${receivedAt}-off-air-auto-stop`,
      receivedAt,
      type: "off_air_auto_stop",
      signal,
      dayKey: day.dayKey,
      message: "识别到直播下播，已关闭自动采集和 AI 自动盯盘",
    });
  }
  if (confirmed && state.config.autoReviewAfterOffAir !== false && state.dailyReview?.dayKey !== day.dayKey) {
    state.dailyReview = buildDailyReview(state, "off_air_auto_stop");
    appendJsonl(LOG_FILE, {
      id: `${receivedAt}-daily-review`,
      receivedAt,
      type: "daily_review",
      dayKey: day.dayKey,
      review: state.dailyReview,
    });
  }
  return true;
}

function applyLiveLifecycleFromVisual(state, visualCapture) {
  return applyLiveLifecycleSignal(state, strongestLiveSignal(visualLiveSignals(visualCapture)), visualCapture?.capturedAt || Date.now());
}

function reconcileLiveLifecycleForNow(state, date = new Date()) {
  state.config = migrateConfig(state.config);
  const currentDay = liveDayBounds(state.config, date);
  const lifecycle = state.liveLifecycle || {};
  const staleOffAir = ["off_air", "suspected_off_air"].includes(lifecycle.status) && lifecycle.dayKey && lifecycle.dayKey !== currentDay.dayKey;
  const stoppedByPreviousDay = state.config.autoCollectEnabled === false && lifecycle.dayKey && lifecycle.dayKey !== currentDay.dayKey;
  if (!isInLiveWindow(state.config, date) || (!staleOffAir && !stoppedByPreviousDay)) return false;
  state.liveLifecycle = {
    status: "waiting_live",
    dayKey: currentDay.dayKey,
    offAirHitCount: 0,
    requiredConfirmations: state.config.offAirConfirmationsRequired || DEFAULT_CONFIG.offAirConfirmationsRequired,
    lastSignalAt: Date.now(),
    lastSignal: {
      status: "waiting_live",
      confidence: 0,
      reason: `进入新直播日 ${currentDay.dayKey}，自动解除上一场下播停采`,
      previousStatus: lifecycle.status || null,
      previousDayKey: lifecycle.dayKey || null,
    },
  };
  state.config.autoCollectEnabled = true;
  state.assistMetrics = state.assistMetrics || {};
  delete state.assistMetrics.orderCount;
  delete state.assistMetrics.orderCost;
  delete state.assistMetrics.source;
  delete state.assistMetrics.receivedAt;
  state.metrics = state.metrics || {};
  delete state.metrics.orderCount;
  delete state.metrics.orderCost;
  state.metricSources = state.metricSources || {};
  delete state.metricSources.orderCount;
  delete state.metricSources.orderCost;
  delete state.orderMetricStatus;
  appendJsonl(LOG_FILE, {
    id: `${Date.now()}-live-day-reset`,
    receivedAt: Date.now(),
    type: "live_day_reset",
    previousDayKey: lifecycle.dayKey || null,
    dayKey: currentDay.dayKey,
    message: "进入新直播日，已恢复自动采集",
  });
  return true;
}

function autoCollectBlocked(state) {
  state.config = migrateConfig(state.config);
  if (state.config.autoCollectEnabled === false) return "auto_collect_disabled";
  if (state.liveLifecycle?.status === "off_air") return "live_off_air";
  return "";
}

function shouldRunAutoAi(state, receivedAt) {
  state.config = migrateConfig(state.config);
  if (state.liveLifecycle?.status === "off_air") return false;
  if (state.config.aiEnabled !== true) return false;
  const minInterval = Number(state.config.aiMinIntervalMs || DEFAULT_CONFIG.aiMinIntervalMs);
  const lastAiCallAt = Number(state.lastAiCallAt || 0);
  return receivedAt - lastAiCallAt >= minInterval;
}

function calcBoostShare(metrics) {
  const boostRatio = calcBoostRatio(metrics.overallCost, metrics.baseSpend);
  return Number.isFinite(boostRatio) ? money(boostRatio / 100) : null;
}

function parseLocalDateTime(value) {
  const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function formatLocalDateTime(ts) {
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isRoi2LogUrl(url = "") {
  return String(url || "").includes("/roi2Log");
}

function pickRoi2Field(text = "", label = "") {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`\\$\\$\\{${escaped}\\s*[:：]\\s*([^}]*)\\}`));
  return match ? match[1].trim() : "";
}

function roi2LogTaskType(typeText = "", showText = "") {
  const text = `${typeText} ${showText}`;
  if (/一键调速|一键起量/.test(text)) return "oneClickLift";
  if (/控成本|成本调控/.test(text)) return "materialCostControl";
  if (/画面追投|素材追投|放量追投|追投/.test(text)) return "materialBoost";
  return "";
}

function taskLabelForType(taskType = "") {
  return {
    oneClickLift: "一键起量",
    materialBoost: "素材放量/追投",
    materialCostControl: "素材控成本",
  }[taskType] || "未知调控";
}

function pickRoi2LogTasks(fields = {}, receivedAt = Date.now(), config = {}) {
  const list = fields?.data?.data?.Roi2LogItemsList;
  if (!Array.isArray(list)) return [];
  const bounds = liveDayBounds(config, new Date(receivedAt));
  const tasks = [];
  list.forEach((group = {}) => {
    const logs = Array.isArray(group.Roi2RegulateLogItems) ? group.Roi2RegulateLogItems : [];
    logs.forEach((log = {}) => {
      const typeText = String(log.Roi2ActionType || "");
      const showText = String(log.Roi2ActionShow || "");
      const taskType = roi2LogTaskType(typeText, showText);
      if (!taskType) return;
      const textTime = parseLocalDateTime(showText);
      const actionTime = tsMs(log.Roi2ActionTime);
      const startedAt = textTime || actionTime || receivedAt;
      if (startedAt < bounds.startAt || startedAt > bounds.endAt) return;

      const taskName = pickRoi2Field(showText, "任务名称");
      const scene = pickRoi2Field(showText, "调控场景");
      const budget = num(pickRoi2Field(showText, "任务预算"));
      const fieldDurationHours = num(pickRoi2Field(showText, "任务时长"));
      const durationHours = firstFiniteMetric(fieldDurationHours, showText.match(/预计\s*([\d.]+)\s*小时后\s*结束/)?.[1]);
      const expectedEndAt = Number.isFinite(durationHours) ? startedAt + durationHours * 60 * 60 * 1000 : null;
      const taskIdFromField = pickRoi2Field(showText, "任务ID").match(/\d{8,}/)?.[0] || "";
      const explicitTaskIdMatch = showText.match(/任务ID[：:\s]*(\d{8,})/);
      const genericTaskIdMatch = taskType === "oneClickLift" ? showText.match(/(?:^|[^素材])ID[：:\s]*(\d{8,})/) : null;
      const taskId = taskIdFromField || explicitTaskIdMatch?.[1] || genericTaskIdMatch?.[1] || "";
      if (!taskId) return;
      const stillActive = (/生效中|调控中|进行中|新增/.test(showText) || taskType !== "oneClickLift") && (!expectedEndAt || receivedAt <= expectedEndAt + 10 * 60 * 1000);
      const startedText = formatLocalDateTime(startedAt);
      const label = taskLabelForType(taskType);
      tasks.push({
        id: taskId,
        taskId,
        taskName: taskName || `${label}_${startedText || taskId}`,
        name: `${taskName || `${label}_${startedText || taskId}`} ID: ${taskId}`,
        object: scene || "直播间购买",
        status: stillActive ? "调控中" : "调控结束",
        taskType,
        type: label,
        budget: Number.isFinite(budget) ? budget : undefined,
        boostMethod: scene || typeText || label,
        createTime: startedText,
        duration: Number.isFinite(durationHours) ? `${durationHours}小时` : "",
        expectedEndAt,
        source: "api_roi2_log",
        sourceUrl: String(fields.url || ""),
        receivedAt,
        rawText: showText,
      });
    });
  });
  return dedupeTasks(tasks);
}

function mergeMetrics(latestByPage, materialIndex = {}, materialMap = {}) {
  const overview = latestByPage.investOverview?.fields || {};
  const live = latestByPage.liveScreen?.fields || {};
  const visual = live.visualMetrics || latestByPage.visualLiveScreen?.fields?.visualMetrics || {};
  const autoCollect = latestByPage.autoCollect?.fields?.summary || latestByPage.autoCollect?.fields || {};
  const investData = latestByPage.investData?.fields || {};
  const isFreshTaskSnapshot = (snapshot, maxAgeMs = TASK_SNAPSHOT_FRESHNESS_MS) => (
    Array.isArray(snapshot?.fields)
    && Number.isFinite(Number(snapshot?.receivedAt))
    && Date.now() - Number(snapshot.receivedAt) <= maxAgeMs
  );
  const visualTaskCenterFresh = isFreshTaskSnapshot(latestByPage.visualTaskCenter);
  const controlTableFresh = isFreshTaskSnapshot(latestByPage.controlTable);
  const roi2LogFresh = isFreshTaskSnapshot(latestByPage.roi2LogTaskCenter);
  const visualTasks = visualTaskCenterFresh
    ? latestByPage.visualTaskCenter.fields.map(normalizeTask)
    : [];
  const controlTasks = controlTableFresh
    ? latestByPage.controlTable.fields.map(normalizeTask)
    : [];
  const roi2LogTasks = roi2LogFresh ? latestByPage.roi2LogTaskCenter.fields.map(normalizeTask) : [];
  const taskCollectorFresh = isFreshTaskSnapshot(latestByPage.taskCollector);
  const taskCollectorTasks = taskCollectorFresh ? latestByPage.taskCollector.fields.map(normalizeTask) : [];
  const primaryTasks = visualTaskCenterFresh && latestByPage.visualTaskCenter.receivedAt >= (controlTableFresh ? latestByPage.controlTable.receivedAt : 0)
    ? visualTasks
    : controlTasks;
  const primaryFallbackTasks = taskCollectorTasks.length
    ? primaryTasks.filter((task) => !isRegulationTaskType(task.taskType || ""))
    : primaryTasks;
  const visualTypes = new Set(primaryTasks.map((task) => task.taskType).filter(Boolean));
  const sourceTasks = [
    ...primaryFallbackTasks,
    ...(taskCollectorFresh ? [] : roi2LogTasks.filter((task) => !visualTypes.has(task.taskType))),
    ...taskCollectorTasks,
  ];
  const tasks = compactTasksForState(dedupeTasks(enrichTasksWithMaterialMap(enrichTasksWithMaterialInfo(sourceTasks, materialIndex), materialMap)));
  const overallCost = firstReasonableTotalMetric(overview.overallCost, autoCollect.overallCost, visual.overallCost, live.overallCost);
  const planFields = latestByPage.planMetrics?.fields || {};
  const baseCandidate = chooseBaseSpendCandidate(overallCost, [
    { value: overview.baseSpend, source: "investOverview_dom", receivedAt: latestByPage.investOverview?.receivedAt },
    { value: planFields.baseSpend, source: "plan_collector", receivedAt: latestByPage.planMetrics?.receivedAt },
    { value: autoCollect.baseSpend, source: "auto_collect", receivedAt: latestByPage.autoCollect?.receivedAt },
  ]);
  const baseSpend = baseCandidate?.value ?? null;
  const dealAmount = firstReasonableTotalMetric(overview.dealAmount, autoCollect.dealAmount, visual.dealAmount, live.dealAmount);
  const derivedOverallRoi = Number.isFinite(overallCost) && overallCost > 0 && Number.isFinite(dealAmount)
    ? money(dealAmount / overallCost)
    : null;
  const merged = {
    overallCost,
    baseSpend,
    dealAmount,
    currentHourRoi: num(investData.hourRoi ?? overview.hourRoi),
    currentHourCost: num(overview.hourCost),
    overallRoi: firstFiniteMetric(derivedOverallRoi, overview.overallRoi, autoCollect.overallRoi, visual.overallRoi, live.overallRoi),
    flowSpeed: num(live.flowSpeed),
    tasks,
    boostTasks: tasks.length,
    boostRatio: null,
  };
  const gpm = num(autoCollect.gpm ?? visual.gpm ?? live.gpm ?? overview.gpm);
  const onlineCount = num(autoCollect.onlineCount ?? visual.onlineCount ?? live.onlineCount ?? overview.onlineCount);
  const totalViewers = num(autoCollect.totalViewers ?? visual.totalViewers ?? live.totalViewers ?? overview.totalViewers);
  const exposureWatchRate = num(autoCollect.exposureWatchRate ?? visual.exposureWatchRate ?? live.exposureWatchRate ?? overview.exposureWatchRate);
  const watchDealRate = num(autoCollect.watchDealRate ?? visual.watchDealRate ?? live.watchDealRate ?? overview.watchDealRate);
  if (Number.isFinite(gpm)) merged.gpm = gpm;
  if (Number.isFinite(onlineCount)) merged.onlineCount = onlineCount;
  if (Number.isFinite(totalViewers)) merged.totalViewers = totalViewers;
  if (Number.isFinite(exposureWatchRate)) merged.exposureWatchRate = exposureWatchRate;
  if (Number.isFinite(watchDealRate)) merged.watchDealRate = watchDealRate;
  const boostRatio = calcBoostRatio(overallCost, baseSpend);
  if (Number.isFinite(boostRatio)) merged.boostRatio = boostRatio;
  return merged;
}

function pickTrendPoints(fields) {
  const rows = fields?.data?.data?.StatsData?.Rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const ts = num(row.Dimensions?.stat_time_5_minute?.Value);
    const metrics = row.Metrics || {};
    const cost = firstFiniteMetric(
      metrics.stat_real_cost_for_overall_roi2?.Value,
      metrics.stat_cost_for_overall_roi2?.Value,
      metrics.stat_real_cost_for_roi2?.Value,
      metrics.stat_cost_for_roi2?.Value,
    );
    const revenue = firstFiniteMetric(
      metrics.total_order_settle_amount_realtime_for_roi2_1h?.Value,
      metrics.total_order_settle_amount_realtime_for_overall_roi2_1h?.Value,
      metrics.total_pay_order_gmv_include_coupon_realtime_for_roi2?.Value,
      metrics.total_pay_order_gmv_realtime_for_roi2?.Value,
    );
    return { ts, cost, revenue, intervalMinutes: 5, source: "totalTrend" };
  }).filter((point) => Number.isFinite(point.ts) && (Number.isFinite(point.cost) || Number.isFinite(point.revenue)));
}

function localHourKey(date = new Date()) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${dateKey(date)} ${hour}:00:00`;
}

function trendRowHourKey(row) {
  const text = String(row?.Dimensions?.stat_time_5_minute?.ValueStr || "");
  const matched = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/);
  if (matched) return `${matched[1]} ${matched[2]}:00:00`;
  const ts = tsMs(row?.Dimensions?.stat_time_5_minute?.Value);
  return Number.isFinite(ts) ? localHourKey(new Date(ts)) : null;
}

function hourRangeText(hourKey) {
  const matched = String(hourKey || "").match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):/);
  if (!matched) return hourKey || "";
  const hour = Number(matched[2]);
  const next = (hour + 1) % 24;
  return `${matched[1]} ${String(hour).padStart(2, "0")}:00-${String(next).padStart(2, "0")}:00`;
}

function hourlyRowHourKey(row) {
  if (row?.hourKey) return row.hourKey;
  const text = String(row?.time || row?.raw || "");
  const matched = text.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}):/);
  if (matched) return `${matched[1]} ${String(Number(matched[2])).padStart(2, "0")}:00:00`;
  return null;
}

function pickHourlyBreakdown(fields, receivedAt = Date.now(), source = "api_hourly_trend") {
  const rows = fields?.data?.data?.StatsData?.Rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  const groups = new Map();
  const segments = [];
  rows.forEach((row) => {
    const metrics = row?.Metrics || {};
    const dimensions = row?.Dimensions || {};
    const ts = tsMs(dimensions.stat_time_5_minute?.Value);
    const time = dimensions.stat_time_5_minute?.ValueStr || (Number.isFinite(ts) ? new Date(ts).toISOString() : "");
    const cost = firstFiniteMetric(
      metrics.stat_real_cost_for_overall_roi2?.Value,
      metrics.stat_cost_for_overall_roi2?.Value,
      metrics.stat_real_cost_for_roi2?.Value,
      metrics.stat_cost_for_roi2?.Value,
    );
    const dealAmount = firstFiniteMetric(
      metrics.total_order_settle_amount_realtime_for_roi2_1h?.Value,
      metrics.total_order_settle_amount_realtime_for_overall_roi2_1h?.Value,
      metrics.total_pay_order_gmv_include_coupon_realtime_for_roi2?.Value,
      metrics.total_pay_order_gmv_realtime_for_roi2?.Value,
    );
    const orders = firstFiniteMetric(metrics.total_pay_order_count_realtime_for_roi2?.Value);
    if (!Number.isFinite(cost) && !Number.isFinite(dealAmount) && !Number.isFinite(orders)) return;

    const segment = {
      time,
      ts,
      cost: Number.isFinite(cost) ? money(cost) : null,
      dealAmount: Number.isFinite(dealAmount) ? money(dealAmount) : null,
      orders: Number.isFinite(orders) ? orders : null,
      roi: Number.isFinite(cost) && cost > 0 && Number.isFinite(dealAmount) ? money(dealAmount / cost) : null,
    };
    segments.push(segment);

    const hourKey = trendRowHourKey(row);
    if (!hourKey) return;
    const group = groups.get(hourKey) || {
      hourKey,
      time: hourRangeText(hourKey),
      startAt: Number.isFinite(ts) ? currentHourStart(ts) : null,
      cost: 0,
      dealAmount: 0,
      orders: 0,
      pointCount: 0,
    };
    if (Number.isFinite(cost)) group.cost += cost;
    if (Number.isFinite(dealAmount)) group.dealAmount += dealAmount;
    if (Number.isFinite(orders)) group.orders += orders;
    group.pointCount += 1;
    groups.set(hourKey, group);
  });

  const hourlyRows = Array.from(groups.values())
    .map((row) => ({
      hourKey: row.hourKey,
      time: row.time,
      startAt: row.startAt,
      cost: money(row.cost),
      dealAmount: money(row.dealAmount),
      orders: row.orders > 0 ? money(row.orders) : null,
      roi: row.cost > 0 && row.dealAmount > 0 ? money(row.dealAmount / row.cost) : null,
      pointCount: row.pointCount,
    }))
    .sort((a, b) => String(a.hourKey).localeCompare(String(b.hourKey)));
  if (!hourlyRows.length && !segments.length) return null;
  const currentKey = localHourKey(new Date(receivedAt));
  const current = hourlyRows.find((row) => row.hourKey === currentKey) || null;
  return {
    status: hourlyRows.length ? "ok" : "empty",
    source,
    receivedAt,
    current,
    rows: hourlyRows,
    segments: segments.slice(-72),
  };
}

function mergeHourlyBreakdown(state, hourly, receivedAt = Date.now(), source = "api_hourly_trend") {
  if (!hourly) return false;
  const previous = state.hourlyBreakdown || null;
  const previousCurrent = previous?.current || null;
  const nextCurrent = hourly.current || null;
  if (source !== "hourly_detail_dom" && isFreshDomHourlyBreakdown(previous, receivedAt)) {
    applyHourlyCurrentMetricsFromState(state);
    return false;
  }
  const previousKey = hourlyRowHourKey(previousCurrent);
  const nextKey = hourlyRowHourKey(nextCurrent);
  const previousQuality = (Number.isFinite(num(previousCurrent?.roi)) ? 3 : (Number.isFinite(num(previousCurrent?.cost)) ? 2 : 0))
    + (Number.isFinite(num(previousCurrent?.baseCost)) ? 3 : 0);
  const nextQuality = (Number.isFinite(num(nextCurrent?.roi)) ? 3 : (Number.isFinite(num(nextCurrent?.cost)) ? 2 : 0))
    + (Number.isFinite(num(nextCurrent?.baseCost)) ? 3 : 0);
  if (
    previousKey
    && nextKey
    && previousKey === nextKey
    && previousQuality > nextQuality
  ) {
    applyHourlyCurrentMetricsFromState(state);
    return false;
  }
  state.metrics = state.metrics || {};
  state.latestByPage = state.latestByPage || {};
  state.hourlyBreakdown = {
    ...(state.hourlyBreakdown || {}),
    ...hourly,
    source,
    receivedAt,
  };
  state.latestByPage.hourlyDetail = {
    pageType: "hourlyDetail",
    timestamp: receivedAt,
    receivedAt,
    fields: state.hourlyBreakdown,
  };
  const current = hourly.current || null;
  if (current) {
    const currentCost = num(current.cost);
    const currentBaseCost = num(current.baseCost);
    const currentRoi = num(current.roi);
    const currentDealAmount = num(current.dealAmount);
    const currentOrders = num(current.orders);
    if (Number.isFinite(currentCost)) {
      state.metrics.currentHourCost = currentCost;
      state.metrics.hourSegmentSpend = currentCost;
      setMetricSource(state, "currentHourCost", source, receivedAt, { time: current.time });
      setMetricSource(state, "hourSegmentSpend", source, receivedAt, { time: current.time });
      if (Number.isFinite(currentBaseCost) || source === "hourly_detail_dom") {
        applyHourBoostRatioFromBaseSpend(state, currentCost, Number.isFinite(currentBaseCost) ? currentBaseCost : null, receivedAt, {
          time: current.time,
          baseSource: "hourly_detail_base_only_dom",
          ratioSource: "hourly_detail_total_minus_base",
          missingBaseReason: "当前小时的基础消耗行未采集到，已暂不展示",
        });
      } else {
        delete state.metrics.hourSegmentBaseSpend;
        delete state.metrics.hourSegmentBoostRatio;
        if (state.metricSources) {
          delete state.metricSources.hourSegmentBaseSpend;
          delete state.metricSources.hourSegmentBoostRatio;
        }
      }
    }
    if (Number.isFinite(currentRoi)) {
      state.metrics.currentHourRoi = currentRoi;
      setMetricSource(state, "currentHourRoi", source, receivedAt, { time: current.time });
    }
    if (Number.isFinite(currentDealAmount)) {
      state.metrics.currentHourDealAmount = currentDealAmount;
      setMetricSource(state, "currentHourDealAmount", source, receivedAt, { time: current.time });
    }
    if (Number.isFinite(currentOrders)) {
      state.metrics.currentHourOrders = currentOrders;
      setMetricSource(state, "currentHourOrders", source, receivedAt, { time: current.time });
    }
  }
  return true;
}

function pickTrendTotals(fields) {
  const totals = fields?.data?.data?.StatsData?.Totals || {};
  const overallCost = firstFiniteMetric(
    totals.stat_real_cost_for_overall_roi2?.Value,
    totals.stat_cost_for_overall_roi2?.Value,
    totals.stat_real_cost_for_roi2?.Value,
    totals.stat_cost_for_roi2?.Value,
  );
  const dealAmount = firstFiniteMetric(
    totals.total_order_settle_amount_realtime_for_roi2_1h?.Value,
    totals.total_order_settle_amount_realtime_for_overall_roi2_1h?.Value,
    totals.total_pay_order_gmv_include_coupon_realtime_for_roi2?.Value,
    totals.total_pay_order_gmv_realtime_for_roi2?.Value,
  );
  return {
    overallCost,
    dealAmount,
    overallRoi: Number.isFinite(overallCost) && overallCost > 0 && Number.isFinite(dealAmount) ? money(dealAmount / overallCost) : null,
  };
}

function pickAssistMetrics(fields) {
  if (fields?.data?.status_code && fields.data.status_code !== 0) return null;
  const stats = fields?.data?.data?.StatsData;
  const rows = stats?.Rows;
  const fallbackRow = Array.isArray(rows)
    ? rows.slice().reverse().find((row) => Number.isFinite(num(row.Metrics?.total_pay_order_count_for_roi2_assist?.Value)) || Number.isFinite(num(row.Metrics?.total_cost_per_pay_order_settle_for_overall_roi2_1h_assist?.Value)))
    : null;
  const metrics = stats?.Totals || fallbackRow?.Metrics || {};
  const result = {
    orderCount: num(metrics.total_pay_order_count_for_roi2_assist?.Value),
    orderCost: num(metrics.total_cost_per_pay_order_settle_for_overall_roi2_1h_assist?.Value),
  };
  return Number.isFinite(result.orderCount) || Number.isFinite(result.orderCost) ? result : null;
}

function pickMaterialLiveMetrics(fields) {
  if (fields?.data?.status_code && fields.data.status_code !== 0) return null;
  const metrics = fields?.data?.data?.StatsData?.Totals || {};
  const orderCount = num(metrics.total_pay_order_count_realtime_for_roi2?.Value);
  const cost = num(metrics.stat_cost_for_roi2?.Value);
  const result = {
    orderCount,
    orderCost: Number.isFinite(cost) && Number.isFinite(orderCount) && orderCount > 0 ? money(cost / orderCount) : null,
  };
  return Number.isFinite(result.orderCount) || Number.isFinite(result.orderCost) ? result : null;
}

function setMetricSource(state, metric, source, receivedAt, extra = {}) {
  state.metricSources = state.metricSources || {};
  state.metricSources[metric] = { source, receivedAt, status: "ok", ...extra };
}

function setOrderMetricError(state, source, receivedAt, fields) {
  const statusCode = fields?.data?.status_code ?? fields?.data?.code ?? null;
  const message = fields?.data?.status_msg || fields?.data?.message || fields?.data?.msg || "接口返回异常";
  state.orderMetricStatus = { source, status: "error", receivedAt, statusCode, message };
  setMetricSource(state, "orderCount", source, receivedAt, { status: "error", statusCode, message });
  setMetricSource(state, "orderCost", source, receivedAt, { status: "error", statusCode, message });
}

function mergeFiniteAssistMetrics(state, metrics = {}, source = "unknown", receivedAt = Date.now()) {
  state.assistMetrics = state.assistMetrics || {};
  let changed = false;
  if (Number.isFinite(metrics.orderCount)) {
    state.assistMetrics.orderCount = metrics.orderCount;
    setMetricSource(state, "orderCount", source, receivedAt);
    changed = true;
  }
  if (Number.isFinite(metrics.orderCost) && metrics.orderCost > 1) {
    state.assistMetrics.orderCost = metrics.orderCost;
    setMetricSource(state, "orderCost", source, receivedAt);
    changed = true;
  }
  if (changed) {
    state.assistMetrics.source = source;
    state.assistMetrics.receivedAt = receivedAt;
    state.orderMetricStatus = { source, status: "ok", receivedAt };
  }
  return changed;
}

function recoverOrderMetricsFromLatestPages(state, receivedAt = Date.now()) {
  const liveFields = state.latestByPage?.liveScreen?.fields || {};
  return mergeFiniteAssistMetrics(state, {
    orderCount: firstFiniteMetric(liveFields.orderCount, liveFields.visualMetrics?.orderCount),
    orderCost: firstFiniteMetric(liveFields.orderCost, liveFields.visualMetrics?.orderCost),
  }, "visual_live_screen", liveFields.receivedAt || state.latestByPage?.liveScreen?.receivedAt || receivedAt);
}

function recoverConsistentSpendMetrics(state, receivedAt = Date.now()) {
  state.metrics = state.metrics || {};
  const overallCost = num(state.metrics.overallCost);
  const baseSpend = num(state.metrics.baseSpend);
  if (!Number.isFinite(baseSpend) || baseSpend <= 0) return false;
  if (Number.isFinite(overallCost) && overallCost >= baseSpend) return false;
  const review = state.dailyReview || {};
  const reviewMetrics = review.metrics || {};
  const currentLiveDay = liveDayBounds(state.config || {}, new Date(receivedAt)).dayKey;
  if (review.dayKey !== currentLiveDay) {
    if (state.metrics.boostRatio !== null) state.metrics.boostRatio = null;
    setMetricSource(state, "boostRatio", "invalid_mixed_source", receivedAt, { status: "error", message: "复盘日期与当前直播日不一致，已停用追投占比兜底" });
    return true;
  }
  const reviewTotalCost = num(reviewMetrics.totalCost);
  const reviewBaseSpend = num(reviewMetrics.baseSpend);
  const reviewGeneratedAt = Number(review.generatedAt);
  const freshReview = Number.isFinite(reviewGeneratedAt) && receivedAt - reviewGeneratedAt <= 18 * 60 * 60 * 1000;
  const baseMatches = Number.isFinite(reviewBaseSpend) && Math.abs(reviewBaseSpend - baseSpend) <= Math.max(5, baseSpend * 0.02);
  if (!freshReview || !baseMatches || !Number.isFinite(reviewTotalCost) || reviewTotalCost < baseSpend) return false;
  state.metrics.overallCost = reviewTotalCost;
  if (Number.isFinite(num(reviewMetrics.dealAmount))) state.metrics.dealAmount = num(reviewMetrics.dealAmount);
  if (Number.isFinite(num(reviewMetrics.overallRoi))) state.metrics.overallRoi = num(reviewMetrics.overallRoi);
  const boostRatio = calcBoostRatio(state.metrics.overallCost, baseSpend);
  if (Number.isFinite(boostRatio)) state.metrics.boostRatio = boostRatio;
  setMetricSource(state, "overallCost", "daily_review_fallback", receivedAt, { reviewDayKey: review.dayKey });
  if (Number.isFinite(state.metrics.dealAmount)) setMetricSource(state, "dealAmount", "daily_review_fallback", receivedAt, { reviewDayKey: review.dayKey });
  if (Number.isFinite(state.metrics.overallRoi)) setMetricSource(state, "overallRoi", "daily_review_fallback", receivedAt, { reviewDayKey: review.dayKey });
  if (Number.isFinite(state.metrics.boostRatio)) setMetricSource(state, "boostRatio", "daily_review_fallback", receivedAt, { reviewDayKey: review.dayKey });
  return true;
}

function sanitizeStaleMetricState(state, receivedAt = Date.now()) {
  state.metrics = state.metrics || {};
  state.metricSources = state.metricSources || {};
  const currentLiveDay = liveDayBounds(state.config || {}, new Date(receivedAt)).dayKey;
  Object.entries(state.metricSources).forEach(([key, source]) => {
    if (source?.source === "daily_review_fallback" && source.reviewDayKey !== currentLiveDay) {
      delete state.metricSources[key];
    }
  });
  ["baseSpend", "boostRatio", "hourSegmentBaseSpend", "hourSegmentBoostRatio"].forEach((key) => {
    if (!Number.isFinite(num(state.metrics[key])) && state.metricSources[key]?.status !== "error") delete state.metricSources[key];
  });
  if (!Number.isFinite(num(state.metrics.baseSpend))) delete state.metrics.boostRatio;
  if (!Number.isFinite(num(state.metrics.hourSegmentSpend)) || !Number.isFinite(num(state.metrics.hourSegmentBaseSpend))) {
    delete state.metrics.hourSegmentBoostRatio;
    if (state.metricSources.hourSegmentBoostRatio?.status !== "error") delete state.metricSources.hourSegmentBoostRatio;
  }
}

function applyHourlyCurrentMetricsFromState(state) {
  const current = state.hourlyBreakdown?.current;
  if (!current) return state;
  const receivedAt = state.hourlyBreakdown?.receivedAt || Date.now();
  const source = state.hourlyBreakdown?.source || "hourly_detail_dom";
  state.metrics = state.metrics || {};
  const currentCost = num(current.cost);
  const currentBaseCost = num(current.baseCost);
  const currentRoi = num(current.roi);
  const currentDealAmount = num(current.dealAmount);
  const currentOrders = num(current.orders);
  if (Number.isFinite(currentCost)) {
    state.metrics.currentHourCost = currentCost;
    state.metrics.hourSegmentSpend = currentCost;
    setMetricSource(state, "currentHourCost", source, receivedAt, { time: current.time });
    setMetricSource(state, "hourSegmentSpend", source, receivedAt, { time: current.time });
    applyHourBoostRatioFromBaseSpend(state, currentCost, Number.isFinite(currentBaseCost) ? currentBaseCost : null, receivedAt, {
      time: current.time,
      baseSource: "hourly_detail_base_only_dom",
      ratioSource: "hourly_detail_total_minus_base",
      missingBaseReason: "当前小时的基础消耗行未采集到，已暂不展示",
    });
  }
  if (Number.isFinite(currentRoi)) {
    state.metrics.currentHourRoi = currentRoi;
    setMetricSource(state, "currentHourRoi", source, receivedAt, { time: current.time });
  }
  if (Number.isFinite(currentDealAmount)) {
    state.metrics.currentHourDealAmount = currentDealAmount;
    setMetricSource(state, "currentHourDealAmount", source, receivedAt, { time: current.time });
  }
  if (Number.isFinite(currentOrders)) {
    state.metrics.currentHourOrders = currentOrders;
    setMetricSource(state, "currentHourOrders", source, receivedAt, { time: current.time });
  }
  return state;
}

function isFreshDomHourlyBreakdown(hourly = {}, receivedAt = Date.now()) {
  const current = hourly.current || null;
  const source = String(hourly.source || (Number.isFinite(num(current?.baseCost)) ? "hourly_detail_dom" : ""));
  const sourceAt = Number(hourly.receivedAt || hourly.collectedAt || 0);
  const maxAgeMs = 5 * 60 * 1000;
  return source === "hourly_detail_dom"
    && Number.isFinite(sourceAt)
    && receivedAt - sourceAt <= maxAgeMs
    && Number.isFinite(num(current?.cost))
    && Number.isFinite(num(current?.baseCost));
}

function preserveConcurrentHourlyState(state) {
  const diskState = readJson(STATE_FILE, {});
  const diskAt = Number(diskState.hourlyBreakdown?.receivedAt || diskState.hourlyBreakdown?.collectedAt || 0);
  const stateAt = Number(state.hourlyBreakdown?.receivedAt || state.hourlyBreakdown?.collectedAt || 0);
  if (!Number.isFinite(diskAt) || diskAt <= stateAt) return applyHourlyCurrentMetricsFromState(state);
  state.hourlyBreakdown = diskState.hourlyBreakdown;
  state.latestByPage = state.latestByPage || {};
  if (diskState.latestByPage?.hourlyDetail) state.latestByPage.hourlyDetail = diskState.latestByPage.hourlyDetail;
  state.metrics = state.metrics || {};
  ["currentHourCost", "currentHourRoi", "currentHourDealAmount", "currentHourOrders", "currentHourOrderCost", "hourSegmentSpend", "hourSegmentBaseSpend", "hourSegmentBoostRatio"].forEach((key) => {
    if (Number.isFinite(num(diskState.metrics?.[key]))) state.metrics[key] = diskState.metrics[key];
  });
  state.metricSources = state.metricSources || {};
  ["currentHourCost", "currentHourRoi", "currentHourDealAmount", "currentHourOrders", "currentHourOrderCost", "hourSegmentSpend", "hourSegmentBaseSpend", "hourSegmentBoostRatio"].forEach((key) => {
    if (diskState.metricSources?.[key]) state.metricSources[key] = diskState.metricSources[key];
  });
  return applyHourlyCurrentMetricsFromState(state);
}

function mergeVisualCaptureIntoState(state, visualCapture) {
  if (!visualCapture || visualCapture.status !== "ok") return false;
  const metrics = visualCapture.extractedMetrics || {};
  const receivedAt = visualCapture.capturedAt || Date.now();
  let changed = false;
  state.metrics = state.metrics || {};
  state.assistMetrics = state.assistMetrics || {};
  state.latestByPage = state.latestByPage || {};

  if (Array.isArray(visualCapture.pages)) {
    visualCapture.pages.forEach((page) => {
      if (!page || page.error || !page.pageType) return;
      const previousFields = state.latestByPage[page.pageType]?.fields || {};
      const safeMetrics = cleanMetricPatch(page.metrics || {});
      const fields = page.pageType === "controlTable"
        ? (Array.isArray(page.tasks) ? page.tasks.map(normalizeTask) : [])
        : { ...previousFields, ...safeMetrics, visualMetrics: { ...(previousFields.visualMetrics || {}), ...safeMetrics } };
      state.latestByPage[page.pageType] = {
        pageType: page.pageType,
        accountId: state.config?.expectedAccountId || null,
        timestamp: receivedAt,
        receivedAt,
        fields,
      };
      changed = true;
    });
  }

  if (visualCapture.hourlyBreakdown) {
    const hourly = visualCapture.hourlyBreakdown || {};
    const rows = Array.isArray(hourly.rows) ? hourly.rows : [];
    const current = hourly.current || rows.slice().reverse().find((row) => Number.isFinite(num(row.roi)) || Number.isFinite(num(row.cost))) || null;
    state.hourlyBreakdown = {
      ...hourly,
      status: rows.length ? "ok" : (hourly.status || "empty"),
      source: hourly.source || "hourly_detail_dom",
      rows,
      current,
      receivedAt,
    };
    state.latestByPage.hourlyDetail = {
      pageType: "hourlyDetail",
      accountId: state.config?.expectedAccountId || null,
      timestamp: receivedAt,
      receivedAt,
      fields: state.hourlyBreakdown,
    };
    if (current) {
      const currentCost = num(current.cost);
      const currentBaseCost = num(current.baseCost);
      const currentRoi = num(current.roi);
      const currentDealAmount = num(current.dealAmount);
      const currentOrders = num(current.orders);
      const currentOrderCost = num(current.orderCost);
      if (Number.isFinite(currentCost)) {
        state.metrics.currentHourCost = currentCost;
        state.metrics.hourSegmentSpend = currentCost;
        setMetricSource(state, "currentHourCost", "hourly_detail_dom", receivedAt, { time: current.time });
        setMetricSource(state, "hourSegmentSpend", "hourly_detail_dom", receivedAt, { time: current.time });
        applyHourBoostRatioFromBaseSpend(state, currentCost, Number.isFinite(currentBaseCost) ? currentBaseCost : null, receivedAt, {
          time: current.time,
          baseSource: "hourly_detail_base_only_dom",
          ratioSource: "hourly_detail_total_minus_base",
          missingBaseReason: "当前小时的基础消耗行未采集到，已暂不展示",
        });
      }
      if (Number.isFinite(currentRoi)) {
        state.metrics.currentHourRoi = currentRoi;
        setMetricSource(state, "currentHourRoi", "hourly_detail_dom", receivedAt, { time: current.time });
      }
      if (Number.isFinite(currentDealAmount)) {
        state.metrics.currentHourDealAmount = currentDealAmount;
        setMetricSource(state, "currentHourDealAmount", "hourly_detail_dom", receivedAt, { time: current.time });
      }
      if (Number.isFinite(currentOrders)) {
        state.metrics.currentHourOrders = currentOrders;
        setMetricSource(state, "currentHourOrders", "hourly_detail_dom", receivedAt, { time: current.time });
      }
      if (Number.isFinite(currentOrderCost)) {
        state.metrics.currentHourOrderCost = currentOrderCost;
        setMetricSource(state, "currentHourOrderCost", "hourly_detail_dom", receivedAt, { time: current.time });
      }
    }
    changed = true;
  }

  ["overallCost", "overallRoi", "dealAmount"].forEach((key) => {
    if (!Number.isFinite(metrics[key])) return;
    // 合理性校验：overallCost/dealAmount <= 10 明显是页面占位符，丢弃
    if ((key === "overallCost" || key === "dealAmount") && metrics[key] <= 10) return;
    // overallRoi <= 0 也不合理
    if (key === "overallRoi" && metrics[key] <= 0) return;
    // overallCost/dealAmount: investOverview（全天）优先，视觉大屏值不覆盖
    if ((key === "overallCost" || key === "dealAmount") && Number.isFinite(state.metrics[key]) && state.metrics[key] > metrics[key] * 1.5) return;
    state.metrics[key] = metrics[key];
    setMetricSource(state, key, "visual_live_screen", receivedAt, { pageType: visualCapture.pageType || "visual" });
    changed = true;
  });
  [
    ["hourCost", "currentHourCost"],
    ["hourRoi", "currentHourRoi"],
    ["gpm", "gpm"],
    ["onlineCount", "onlineCount"],
    ["totalViewers", "totalViewers"],
    ["exposureWatchRate", "exposureWatchRate"],
    ["watchDealRate", "watchDealRate"],
  ].forEach(([sourceKey, targetKey]) => {
    if (!Number.isFinite(metrics[sourceKey])) return;
    state.metrics[targetKey] = metrics[sourceKey];
    setMetricSource(state, targetKey, "visual_live_screen", receivedAt, { pageType: visualCapture.pageType || "visual" });
    changed = true;
  });
  const overviewSnapshot = state.latestByPage?.investOverview || {};
  const overviewFields = overviewSnapshot.fields || {};
  const autoCollect = state.latestByPage?.autoCollect?.fields?.summary || state.latestByPage?.autoCollect?.fields || {};
  const overviewOverallCost = firstFiniteMetric(overviewFields.overallCost);
  const overviewDealAmount = firstFiniteMetric(overviewFields.dealAmount);
  const overviewBaseSpend = firstFiniteMetric(overviewFields.baseSpend);
  const overviewBaseSpendSource = overviewFields.baseSpendSource === "plan_table_dom" ? "plan_table_dom" : "investOverview_dom";
  const autoCollectDealAmount = firstFiniteMetric(autoCollect.dealAmount);
  const autoCollectBaseSpend = firstFiniteMetric(autoCollect.baseSpend);
  const planSnapshot = state.latestByPage?.planMetrics || {};
  const planFields = planSnapshot.fields || {};
  const planBaseSpend = firstFiniteMetric(planFields.baseSpend);
  const liveScreenFields = state.latestByPage?.liveScreen?.fields || {};
  const liveScreenOrderCount = firstFiniteMetric(liveScreenFields.orderCount, liveScreenFields.visualMetrics?.orderCount);
  const liveScreenOrderCost = firstFiniteMetric(liveScreenFields.orderCost, liveScreenFields.visualMetrics?.orderCost);
  if (Number.isFinite(overviewOverallCost) && overviewOverallCost > 10) {
    state.metrics.overallCost = overviewOverallCost;
    setMetricSource(state, "overallCost", "investOverview_dom", overviewSnapshot.receivedAt || receivedAt);
    changed = true;
  }
  if (Number.isFinite(overviewDealAmount) && overviewDealAmount > 10) {
    state.metrics.dealAmount = overviewDealAmount;
    setMetricSource(state, "dealAmount", "investOverview_dom", overviewSnapshot.receivedAt || receivedAt);
    changed = true;
  } else if (Number.isFinite(autoCollectDealAmount) && autoCollectDealAmount > 10) {
    state.metrics.dealAmount = autoCollectDealAmount;
    setMetricSource(state, "dealAmount", "auto_collect", state.latestByPage?.autoCollect?.receivedAt || receivedAt);
    changed = true;
  }
  if (Number.isFinite(state.metrics.overallCost) && state.metrics.overallCost > 0 && Number.isFinite(state.metrics.dealAmount)) {
    state.metrics.overallRoi = money(state.metrics.dealAmount / state.metrics.overallCost);
    setMetricSource(state, "overallRoi", "investOverview_dom", overviewSnapshot.receivedAt || receivedAt);
    changed = true;
  }
  const baseCandidate = chooseBaseSpendCandidate(state.metrics.overallCost, [
    { value: overviewBaseSpend, source: overviewBaseSpendSource, receivedAt: overviewSnapshot.receivedAt || receivedAt },
    { value: planBaseSpend, source: "plan_collector", receivedAt: planSnapshot.receivedAt || planFields.receivedAt },
    { value: autoCollectBaseSpend, source: "auto_collect", receivedAt: state.latestByPage?.autoCollect?.receivedAt || receivedAt },
  ]);
  if (Number.isFinite(baseCandidate?.value)) {
    state.metrics.baseSpend = baseCandidate.value;
    setMetricSource(state, "baseSpend", baseCandidate.source || "spend_candidate", baseCandidate.receivedAt || receivedAt, {
      candidates: baseCandidate.source,
    });
    changed = true;
  } else if (Number.isFinite(state.metrics.overallCost) && Number.isFinite(state.metrics.baseSpend) && state.metrics.baseSpend > state.metrics.overallCost * 1.02) {
    delete state.metrics.baseSpend;
    delete state.metrics.boostRatio;
    setMetricSource(state, "baseSpend", "invalid_mixed_source", receivedAt, { status: "error", message: "基础消耗大于总消耗，疑似跨日期或来源不一致，已暂不展示" });
    changed = true;
  }
  const boostRatio = calcBoostRatio(state.metrics.overallCost, state.metrics.baseSpend);
  if (Number.isFinite(boostRatio)) {
    state.metrics.boostRatio = boostRatio;
    setMetricSource(state, "boostRatio", "derived_spend_ratio", receivedAt, {
      overallSource: state.metricSources?.overallCost?.source || "unknown",
      baseSource: state.metricSources?.baseSpend?.source || "unknown",
    });
    changed = true;
  }
  if (recoverConsistentSpendMetrics(state, receivedAt)) changed = true;
  sanitizeStaleMetricState(state, receivedAt);

  if (Number.isFinite(liveScreenOrderCount) || Number.isFinite(metrics.orderCount)) {
    const orderCount = firstFiniteMetric(liveScreenOrderCount, metrics.orderCount);
    state.assistMetrics.orderCount = orderCount;
    setMetricSource(state, "orderCount", "visual_live_screen", receivedAt, { pageType: "liveScreen" });
    changed = true;
  }
  if ((Number.isFinite(liveScreenOrderCost) && liveScreenOrderCost > 1) || (Number.isFinite(metrics.orderCost) && metrics.orderCost > 1)) {
    const orderCost = firstFiniteMetric(
      Number.isFinite(liveScreenOrderCost) && liveScreenOrderCost > 1 ? liveScreenOrderCost : null,
      Number.isFinite(metrics.orderCost) && metrics.orderCost > 1 ? metrics.orderCost : null,
    );
    state.assistMetrics.orderCost = orderCost;
    setMetricSource(state, "orderCost", "visual_live_screen", receivedAt, { pageType: "liveScreen" });
    changed = true;
  }
  if (Number.isFinite(state.assistMetrics.orderCount) || Number.isFinite(state.assistMetrics.orderCost)) {
    state.assistMetrics.source = "visual_live_screen";
    state.assistMetrics.receivedAt = receivedAt;
    state.orderMetricStatus = { source: "visual_live_screen", status: "ok", receivedAt };
  }
  recoverOrderMetricsFromLatestPages(state, receivedAt);

  state.visualTrend = Array.isArray(state.visualTrend) ? state.visualTrend : [];
  const liveScreenPageMetrics = (visualCapture.pages || []).find((page) => page.pageType === "liveScreen")?.metrics || {};
  const currentTotalCost = firstFiniteMetric(liveScreenPageMetrics.overallCost);
  const currentTrendRoi = firstFiniteMetric(liveScreenPageMetrics.overallRoi);
  const currentTotalRevenue = firstFiniteMetric(
    liveScreenPageMetrics.dealAmount,
    Number.isFinite(currentTotalCost) && Number.isFinite(currentTrendRoi) ? money(currentTotalCost * currentTrendRoi) : null,
  );
  const previousVisual = state.visualTrend.slice().reverse().find((point) => Number.isFinite(point.totalCost));
  if (previousVisual
    && previousVisual.trendBasis !== "liveScreen"
    && Number.isFinite(currentTotalCost)
    && Number.isFinite(previousVisual.totalCost)
    && currentTotalCost < previousVisual.totalCost * 0.95) {
    state.visualTrend = state.visualTrend.filter((point) => point.trendBasis === "liveScreen");
  }
  const previousPoint = state.visualTrend.slice().reverse().find((point) => (
    Number.isFinite(point.totalCost)
    && (point.trendBasis || "liveScreen") === "liveScreen"
    && point.ts < receivedAt
    && receivedAt - point.ts >= 15 * 1000
    && Number.isFinite(currentTotalCost)
    && point.totalCost < currentTotalCost
  ));
  const minutes = previousPoint ? (receivedAt - previousPoint.ts) / 60000 : null;
  const flowSpeed = previousPoint && Number.isFinite(currentTotalCost) && minutes >= 1.5 && currentTotalCost >= previousPoint.totalCost
    ? money((currentTotalCost - previousPoint.totalCost) / minutes * 5)
    : null;
  const revenueSpeed = previousPoint
    && Number.isFinite(currentTotalRevenue)
    && Number.isFinite(previousPoint.totalRevenue)
    && minutes >= 1.5
    && currentTotalRevenue >= previousPoint.totalRevenue
    ? money((currentTotalRevenue - previousPoint.totalRevenue) / minutes * 5)
    : null;
  state.visualTrend.push({
    ts: receivedAt,
    totalCost: currentTotalCost ?? null,
    totalRevenue: currentTotalRevenue ?? null,
    cost: flowSpeed,
    revenue: revenueSpeed,
    roi: currentTrendRoi ?? null,
    intervalMinutes: 5,
    sampleMinutes: Number.isFinite(minutes) ? money(minutes) : null,
    trendBasis: "liveScreen",
    basisSource: "liveScreen_page",
    source: "visual_live_screen",
  });
  state.visualTrend = state.visualTrend.slice(-80);
  if (Number.isFinite(flowSpeed) && flowSpeed > 0) {
    state.metrics.flowSpeed = flowSpeed;
    state.fiveMinSpend = flowSpeed;
    state.metrics.fiveMinSpend = flowSpeed;
    setMetricSource(state, "flowSpeed", "visual_live_screen", receivedAt, { estimated: true });
    changed = true;
  }
  updateHourlySegmentMetrics(state, receivedAt);
  if (state.hourlyBreakdown?.current) {
    const current = state.hourlyBreakdown.current;
    const currentCost = num(current.cost);
    const currentBaseCost = num(current.baseCost);
    const currentRoi = num(current.roi);
    if (Number.isFinite(currentCost)) {
      state.metrics.currentHourCost = currentCost;
      state.metrics.hourSegmentSpend = currentCost;
      setMetricSource(state, "currentHourCost", "hourly_detail_dom", receivedAt, { time: current.time });
      setMetricSource(state, "hourSegmentSpend", "hourly_detail_dom", receivedAt, { time: current.time });
      applyHourBoostRatioFromBaseSpend(state, currentCost, Number.isFinite(currentBaseCost) ? currentBaseCost : null, receivedAt, {
        time: current.time,
        baseSource: "hourly_detail_base_only_dom",
        ratioSource: "hourly_detail_total_minus_base",
        missingBaseReason: "当前小时的基础消耗行未采集到，已暂不展示",
      });
    }
    if (Number.isFinite(currentRoi)) {
      state.metrics.currentHourRoi = currentRoi;
      setMetricSource(state, "currentHourRoi", "hourly_detail_dom", receivedAt, { time: current.time });
    }
  }

  const scannedTasks = visualCapture.taskScan?.tasks || [];
  const isTaskCollectRoute = ["control", "materialBoost", "oneClickLift"].includes(visualCapture.route);
  const taskCollectorSnapshot = state.latestByPage?.taskCollector;
  const hasFreshTaskCollectorSnapshot = Array.isArray(taskCollectorSnapshot?.fields)
    && Number.isFinite(Number(taskCollectorSnapshot?.receivedAt))
    && Date.now() - Number(taskCollectorSnapshot.receivedAt) <= TASK_SNAPSHOT_FRESHNESS_MS;
  // Visual control scans enumerate every open detail tab. Those tabs can retain
  // finished tasks, so a fresh task-center collector snapshot is authoritative.
  if (isTaskCollectRoute && !hasFreshTaskCollectorSnapshot && Array.isArray(scannedTasks) && scannedTasks.length) {
    const routeTaskTypes = visualCapture.route === "materialBoost"
      ? ["materialBoost", "materialCostControl"]
      : visualCapture.route === "oneClickLift"
        ? ["oneClickLift"]
        : [];
    const routeTasks = taskListForState(scannedTasks.map((task) => ({
      ...task,
      id: task.taskId || task.id || "",
      source: "visual_task_scan",
      receivedAt,
    })), state);
    const visualTaskCenterFresh = Number.isFinite(Number(state.latestByPage?.visualTaskCenter?.receivedAt))
      && Date.now() - Number(state.latestByPage.visualTaskCenter.receivedAt) <= TASK_SNAPSHOT_FRESHNESS_MS;
    const existingVisualTasks = visualTaskCenterFresh && Array.isArray(state.latestByPage?.visualTaskCenter?.fields)
      ? state.latestByPage.visualTaskCenter.fields
      : [];
    const normalizedTasks = routeTaskTypes.length
      ? taskListForState([
          ...existingVisualTasks.filter((task) => !routeTaskTypes.includes(task.taskType)),
          ...routeTasks,
        ], state)
      : routeTasks;
    state.latestByPage.visualTaskCenter = {
      pageType: "visualTaskCenter",
      accountId: state.config?.expectedAccountId || null,
      timestamp: receivedAt,
      receivedAt,
      fields: normalizedTasks,
    };
    const mergedTasks = mergeMetrics(state.latestByPage, state.materialIndex || {}, state.materialMap || {}).tasks || normalizedTasks;
    state.metrics.tasks = mergedTasks;
    state.metrics.boostTasks = mergedTasks.length;
    state.taskGroups = groupTasksByType(mergedTasks);
    state.taskSource = {
      source: "visual_task_scan",
      status: "ok",
      receivedAt,
      total: mergedTasks.length,
      pages: visualCapture.taskScan.pages?.map((page) => ({
        title: page.title,
        url: page.url,
        pageType: page.pageType,
        count: page.tasks?.length || 0,
        error: page.error || null,
      })) || [],
    };
    changed = true;
  } else if (isTaskCollectRoute || visualCapture.mode === "read_only") {
    const hasFreshCollectorTasks = hasFreshTaskCollectorSnapshot
      && Array.isArray(state.metrics?.tasks)
      && state.metrics.tasks.length > 0;
    // A visual scan can legitimately see an unfinished/re-rendering task page.
    // Do not let that empty snapshot replace fresher task-collector data.
    if (!hasFreshCollectorTasks) {
      state.taskSource = {
        ...(state.taskSource || {}),
        source: "visual_task_scan",
        status: "empty",
        receivedAt,
        message: visualCapture.route === "materialBoost"
          ? "未采集到素材追投任务，请确认任务中心已加载素材追投数据"
          : visualCapture.route === "oneClickLift"
            ? "未采集到一键起量任务，请确认任务中心已加载一键起量数据"
            : "未在千川页面中识别到调控任务表，请打开或初始化任务中心后重试",
        pages: visualCapture.taskScan?.pages?.map((page) => ({
          title: page.title,
          url: page.url,
          pageType: page.pageType,
          count: page.tasks?.length || 0,
          error: page.error || null,
        })) || [],
      };
    }
  }

  const pageType = visualCapture.pageType || "visual";
  state.latestByPage = state.latestByPage || {};
  state.latestByPage[pageType] = {
    ...(state.latestByPage[pageType] || {}),
    pageType,
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields: {
      ...metrics,
      visualMetrics: metrics,
      overallRoi: metrics.overallRoi ?? state.latestByPage[pageType]?.fields?.overallRoi,
    },
  };
  if (applyLiveLifecycleFromVisual(state, visualCapture)) changed = true;
  return changed;
}

function mergeBoardCollectIntoState(state, result = {}) {
  const receivedAt = result.finishedAt || Date.now();
  const metrics = result.metrics || {};
  state.metrics = state.metrics || {};
  state.assistMetrics = state.assistMetrics || {};
  state.latestByPage = state.latestByPage || {};
  let changed = false;
  const watchDealRate = Number.isFinite(num(metrics.watchConversionRate)) ? num(metrics.watchConversionRate) : num(metrics.watchDealRate);
  const fields = {
    ...metrics,
    watchDealRate,
    visualMetrics: { ...metrics, watchDealRate },
    source: "board_collector",
    receivedAt,
  };
  state.latestByPage.liveScreen = {
    pageType: "liveScreen",
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields,
  };
  [
    ["gpm", "gpm"],
    ["onlineCount", "onlineCount"],
    ["totalViewers", "totalViewers"],
    ["exposureWatchRate", "exposureWatchRate"],
    ["watchConversionRate", "watchDealRate"],
  ].forEach(([sourceKey, targetKey]) => {
    const value = num(metrics[sourceKey]);
    if (!Number.isFinite(value)) return;
    state.metrics[targetKey] = value;
    if (sourceKey === "watchConversionRate") state.metrics.watchConversionRate = value;
    setMetricSource(state, targetKey, "board_collector", receivedAt, { pageType: "liveScreen" });
    if (sourceKey === "watchConversionRate") setMetricSource(state, "watchConversionRate", "board_collector", receivedAt, { pageType: "liveScreen" });
    changed = true;
  });
  if (Number.isFinite(num(metrics.orderCount))) {
    const value = num(metrics.orderCount);
    state.assistMetrics.orderCount = value;
    state.metrics.orderCount = value;
    setMetricSource(state, "orderCount", "board_collector", receivedAt, { pageType: "liveScreen" });
    changed = true;
  }
  if (Number.isFinite(num(metrics.orderCost)) && num(metrics.orderCost) > 1) {
    const value = num(metrics.orderCost);
    state.assistMetrics.orderCost = value;
    state.metrics.orderCost = value;
    setMetricSource(state, "orderCost", "board_collector", receivedAt, { pageType: "liveScreen" });
    changed = true;
  }
  if (Number.isFinite(state.assistMetrics.orderCount) || Number.isFinite(state.assistMetrics.orderCost)) {
    state.assistMetrics.source = "board_collector";
    state.assistMetrics.receivedAt = receivedAt;
    state.orderMetricStatus = { source: "board_collector", status: "ok", receivedAt };
  }
  return changed;
}

function mergeBoardTrendCollectIntoState(state, result = {}) {
  const receivedAt = result.finishedAt || Date.now();
  const points = Array.isArray(result.points) ? result.points : [];
  if (!points.length) return false;
  const inferredGranularity = (() => {
    const diffs = points
      .map((point, index) => index > 0 ? num(point.ts) - num(points[index - 1]?.ts) : null)
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.round(value / 60000));
    if (!diffs.length) return Number(result.granularity || points[0]?.intervalMinutes || 5);
    const sorted = diffs.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 2) return 1;
    if (median <= 10) return 5;
    return 30;
  })();
  const granularity = Number(result.actualGranularity || inferredGranularity || result.granularity || 5);
  const normalizedPoints = points
    .map((point) => ({
      ...point,
      ts: num(point.ts),
      cost: Number.isFinite(num(point.cost)) ? money(num(point.cost)) : null,
      revenue: Number.isFinite(num(point.revenue)) ? money(num(point.revenue)) : null,
      roi: Number.isFinite(num(point.roi)) ? money(num(point.roi)) : null,
      intervalMinutes: Number(point.intervalMinutes || granularity),
      source: "qianchuan_board_trend",
      receivedAt,
    }))
    .filter((point) => Number.isFinite(point.ts) && (Number.isFinite(num(point.cost)) || Number.isFinite(num(point.revenue))))
    .sort((a, b) => a.ts - b.ts);
  if (!normalizedPoints.length) return false;

  state.metrics = state.metrics || {};
  state.latestByPage = state.latestByPage || {};
  state.boardTrend = {
    status: "ok",
    source: "qianchuan_board_trend",
    granularity,
    requestedGranularity: Number(result.requestedGranularity || result.granularity || granularity),
    receivedAt,
    page: result.page || null,
    sourceUrl: result.sourceUrl || "",
    totals: result.totals || {},
    points: normalizedPoints,
  };
  state.latestByPage.boardTrend = {
    pageType: "boardTrend",
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields: state.boardTrend,
  };
  state.trendData = normalizedPoints.map((point) => ({
    ts: point.ts,
    cost: point.cost,
    revenue: point.revenue,
    roi: point.roi,
    intervalMinutes: Number(point.intervalMinutes || granularity),
    source: "qianchuan_board_trend",
  }));

  if (granularity === 5) {
    const latestCostPoint = normalizedPoints.slice().reverse().find((point) => Number.isFinite(num(point.cost)));
    if (latestCostPoint) {
      state.fiveMinSpend = num(latestCostPoint.cost);
      state.metrics.fiveMinSpend = num(latestCostPoint.cost);
      setMetricSource(state, "fiveMinSpend", "qianchuan_board_trend", receivedAt, { granularity, time: latestCostPoint.time || "" });
    }
  }
  return true;
}

function mergePlanCollectIntoState(state, result = {}) {
  const receivedAt = result.finishedAt || Date.now();
  const metrics = result.metrics || {};
  state.metrics = state.metrics || {};
  state.latestByPage = state.latestByPage || {};
  let changed = false;
  state.latestByPage.planMetrics = {
    pageType: "planMetrics",
    accountId: state.config?.expectedAccountId || null,
    timestamp: receivedAt,
    receivedAt,
    fields: {
      ...metrics,
      source: "plan_collector",
      receivedAt,
    },
  };
  if (Number.isFinite(num(metrics.planTotalCost))) {
    state.metrics.planTotalCost = num(metrics.planTotalCost);
    setMetricSource(state, "planTotalCost", "plan_collector", receivedAt);
    changed = true;
  }
  if (Number.isFinite(num(metrics.planRoi))) {
    state.metrics.planRoi = num(metrics.planRoi);
    setMetricSource(state, "planRoi", "plan_collector", receivedAt);
    changed = true;
  }
  if (Number.isFinite(num(metrics.baseSpend))) {
    state.metrics.planBaseSpend = num(metrics.baseSpend);
    setMetricSource(state, "planBaseSpend", "plan_collector", receivedAt);
    const overviewBaseSpend = firstFiniteMetric(state.latestByPage?.investOverview?.fields?.baseSpend);
    const currentOverallCost = firstFiniteMetric(state.metrics.overallCost);
    const selectedBase = chooseBaseSpendCandidate(currentOverallCost, [
      {
        value: state.metrics.baseSpend,
        source: state.metricSources?.baseSpend?.source || "current_state",
        receivedAt: state.metricSources?.baseSpend?.receivedAt,
      },
      {
        value: overviewBaseSpend,
        source: state.latestByPage?.investOverview?.fields?.baseSpendSource === "plan_table_dom" ? "plan_table_dom" : "investOverview_dom",
        receivedAt: state.latestByPage?.investOverview?.receivedAt,
      },
      { value: metrics.baseSpend, source: "plan_collector", receivedAt },
    ]);
    if (Number.isFinite(selectedBase?.value)) {
      state.metrics.baseSpend = selectedBase.value;
      setMetricSource(state, "baseSpend", selectedBase.source || "plan_collector", selectedBase.receivedAt || receivedAt);
    }
    changed = true;
  }
  const boostRatio = calcBoostRatio(state.metrics.overallCost, state.metrics.baseSpend);
  if (Number.isFinite(boostRatio)) {
    state.metrics.boostRatio = boostRatio;
    setMetricSource(state, "boostRatio", "derived_spend_ratio", receivedAt, {
      overallSource: state.metricSources?.overallCost?.source || "unknown",
      baseSource: state.metricSources?.baseSpend?.source || "unknown",
    });
    changed = true;
  }
  return changed;
}

function groupTasksByType(tasks = []) {
  const groups = {
    materialBoost: [],
    materialCostControl: [],
    oneClickLift: [],
    unknown: [],
  };
  tasks.forEach((task) => {
    const key = groups[task.taskType] ? task.taskType : "unknown";
    groups[key].push(task);
  });
  return groups;
}

function reqFromOf(url) {
  try {
    return new URL(url).searchParams.get("reqFrom");
  } catch {
    return "";
  }
}

function isAssistReq(reqFrom) {
  return String(reqFrom || "").includes("assist_task_data_modal");
}

function isOrderMetricReq(reqFrom) {
  return isAssistReq(reqFrom) || reqFrom === "materialLive";
}

function calcFiveMinSpend(current, snapshots) {
  if (!Number.isFinite(current.overallCost)) return null;
  const now = Date.now();
  const candidates = snapshots
    .filter((item) => item.pageType === "investOverview" && Number.isFinite(num(item.fields?.overallCost)))
    .filter((item) => now - item.receivedAt >= 3 * 60 * 1000 && now - item.receivedAt <= 10 * 60 * 1000)
    .sort((a, b) => Math.abs(now - a.receivedAt - 5 * 60 * 1000) - Math.abs(now - b.receivedAt - 5 * 60 * 1000));
  if (!candidates.length) return null;
  return money(current.overallCost - num(candidates[0].fields.overallCost));
}

const ACTIVE_ACTION_STATUSES = new Set(["pending_review", "approved", "ready_to_execute"]);

function activeActionCount(state, now) {
  return (state.actions || []).filter((action) => {
    if (!ACTIVE_ACTION_STATUSES.has(action.status)) return false;
    const expiresAt = Number(action.expiresAt);
    if (!Number.isFinite(expiresAt) || now > expiresAt) return false;
    return true;
  }).length;
}

function executionsLastHour(state) {
  const now = Date.now();
  return (state.actions || []).filter((action) => action.executedAt && now - action.executedAt < 60 * 60 * 1000 && action.execution?.dryRun !== true).length;
}

function expireActions(state, now) {
  (state.actions || []).forEach((action) => {
    const expiresAt = Number(action.expiresAt);
    if (ACTIVE_ACTION_STATUSES.has(action.status) && Number.isFinite(expiresAt) && now > expiresAt) action.status = "expired";
  });
}

function cleanupExpiredActions(state, now = Date.now(), limit = 50) {
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  expireActions(state, now);
  state.actions = state.actions.filter((action) => action.status !== "expired").slice(-limit);
  state.updatedAt = new Date().toISOString();
  return state;
}

function normalizeActionSources(state) {
  (state.actions || []).forEach((action) => {
    if (!action.source) action.source = String(action.reason || "").startsWith("AI建议") ? "ai" : "rule";
  });
}

function taskIdFromPayload(payload = {}) {
  const direct = String(payload.taskId || "").trim();
  if (direct) return direct;
  const materialId = String(payload.materialId || "").trim();
  if (materialId) return materialId;
  const text = [payload.taskName, payload.command].map((value) => String(value || "")).join(" ");
  const match = text.match(/ID[：:]?\s*(\d{8,})/) || text.match(/\b(\d{12,})\b/);
  return match?.[1] || "";
}

function materialIdsFromPayload(value, fallback = "") {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/);
  const ids = raw.map((item) => String(item || "").trim()).filter((item) => /^\d{8,}$/.test(item));
  if (!ids.length && /^\d{8,}$/.test(String(fallback || "").trim())) ids.push(String(fallback).trim());
  return Array.from(new Set(ids)).slice(0, 10);
}

function isCreateActionType(type = "") {
  return ["create_boost_task", "create_oneclick_task"].includes(String(type || ""));
}

function actionKey(type, payload) {
  return `${type}:${taskIdFromPayload(payload) || "global"}`;
}

function actionId(type, payload, now, state = {}) {
  const keyPart = (taskIdFromPayload(payload) || "global").replace(/[^\w.-]/g, "_");
  const duplicateTimeCount = (state.actions || []).filter((action) => String(action.id || "").startsWith(`${now}-${type}`)).length;
  return `${now}-${type}-${keyPart}${duplicateTimeCount ? `-${duplicateTimeCount + 1}` : ""}`;
}

function findPendingDuplicateAction(state = {}, type = "", payload = {}, now = Date.now()) {
  const key = actionKey(type, payload);
  return (state.actions || []).find((action) => {
    if (actionKey(action.type, action.payload) !== key) return false;
    if (!["pending_review", "ready_to_execute"].includes(action.status)) return false;
    const expiresAt = Number(action.expiresAt);
    return !Number.isFinite(expiresAt) || now <= expiresAt;
  }) || null;
}

function currentBoostRatioValue(state = {}) {
  const direct = num(state.metrics?.boostRatio ?? state.metrics?.boostShare);
  if (Number.isFinite(direct)) return direct;
  const overallCost = num(state.metrics?.overallCost);
  const baseSpend = num(state.metrics?.baseSpend);
  if (Number.isFinite(overallCost) && overallCost > 0 && Number.isFinite(baseSpend) && baseSpend <= overallCost) {
    return money(((overallCost - baseSpend) / overallCost) * 100);
  }
  return null;
}

function createActionLimitResult(state = {}, type = "", now = Date.now(), options = {}) {
  if (!isCreateActionType(type)) return { ok: true };
  const boostRatio = currentBoostRatioValue(state);
  const boostRatioLimit = 28;
  if (Number.isFinite(boostRatio) && boostRatio >= boostRatioLimit && options.allowManualBoostOverride !== true) {
    return {
      ok: false,
      reason: "boost_ratio_guard",
      boostRatio,
      boostRatioLimit,
      message: `追投占比 ${boostRatio}% 已达到/超过 ${boostRatioLimit}% 安全线，禁止新建追投或一键起量。`,
    };
  }
  const bounds = liveDayBounds(state.config || DEFAULT_CONFIG, new Date(now));
  const countableStatuses = new Set(["pending_review", "ready_to_execute", "approved", "executing", "executed"]);
  const createActions = (state.actions || []).filter((action) => isCreateActionType(action.type) && countableStatuses.has(action.status));
  const createdToday = createActions.filter((action) => Number(action.createdAt || 0) >= bounds.startAt && Number(action.createdAt || 0) <= now);
  if (createdToday.length >= 5) return { ok: false, reason: "daily_create_limit", count: createdToday.length };
  const latestCreatedAt = Math.max(0, ...createActions.map((action) => Number(action.createdAt || action.executedAt || 0)).filter(Number.isFinite));
  if (latestCreatedAt && now - latestCreatedAt < 30 * 60 * 1000) {
    return { ok: false, reason: "create_interval_limit", nextAt: latestCreatedAt + 30 * 60 * 1000 };
  }
  return { ok: true };
}

function canCreateAction(state, type, payload, now, options = {}) {
  const config = state.config;
  const key = actionKey(type, payload);
  state.lastCreateActionReject = null;
  const createLimit = createActionLimitResult(state, type, now, options);
  if (!createLimit.ok) {
    state.lastCreateActionReject = { type, payload, at: now, ...createLimit };
    return false;
  }
  if (activeActionCount(state, now) >= config.maxActionsPerHour) {
    state.lastCreateActionReject = { type, payload, at: now, ok: false, reason: "active_action_limit", activeCount: activeActionCount(state, now), maxActionsPerHour: config.maxActionsPerHour };
    return false;
  }
  const duplicate = findPendingDuplicateAction(state, type, payload, now);
  if (duplicate) {
    state.lastCreateActionReject = { type, payload, at: now, ok: false, reason: "duplicate_pending_action", duplicateActionId: duplicate.id };
    return false;
  }
  if (state.lastActionAt[key] && now - state.lastActionAt[key] < config.actionCooldownMs) {
    state.lastCreateActionReject = { type, payload, at: now, ok: false, reason: "action_cooldown", nextAt: state.lastActionAt[key] + config.actionCooldownMs };
    return false;
  }
  return true;
}

function pushAction(state, type, title, payload, reason, now, source = "rule", options = {}) {
  if (!canCreateAction(state, type, payload, now, options)) return null;
  const key = actionKey(type, payload);
  const action = {
    id: actionId(type, payload, now, state),
    type,
    title,
    payload,
    reason,
    source,
    status: state.config.actionMode === "armed" ? "ready_to_execute" : "pending_review",
    createdAt: now,
    expiresAt: now + state.config.actionExpiresMs,
  };
  state.actions.unshift(action);
  state.actions = state.actions.slice(0, 100);
  state.lastActionAt[key] = now;
  return action;
}

function judgeTask(task, globalTargetRoi) {
  const target = num(task.targetRoi) ?? globalTargetRoi;
  const roi = num(task.roi);
  const spend = num(task.spend);
  const budget = num(task.budget);
  if (isBoostTask(task) && taskHasConfirmedZeroDeals(task) && Number.isFinite(roi) && Number.isFinite(spend) && Number.isFinite(budget) && budget > 0 && roi < target * 0.5 && spend >= budget * 0.8) return "pause";
  if (Number.isFinite(roi) && roi >= target * 1.1 && Number.isFinite(budget) && Number.isFinite(spend) && spend > budget * 0.6) return "increase_budget";
  return "";
}

function isBoostTask(task = {}) {
  return ["materialBoost", "materialCostControl"].includes(String(task.taskType || task.type || ""));
}

function taskHasConfirmedZeroDeals(task = {}) {
  const values = [task.dealAmount, task.orderCount, task.orders, task.transactions]
    .map((value) => num(value))
    .filter(Number.isFinite);
  return values.length > 0 && values.every((value) => value <= 0);
}

function findAiActionTask(state = {}, action = {}) {
  const params = action.params || {};
  const taskId = String(params.taskId || action.taskId || "").trim();
  const taskName = String(params.taskName || action.taskName || "").trim();
  return (state.metrics?.tasks || []).find((task) => String(task.taskId || task.id || "") === taskId
    || (taskName && String(task.name || task.taskName || "").includes(taskName))) || null;
}

function boostPauseGuardReason(state = {}, action = {}) {
  if (!["pause_task", "end_task"].includes(String(action.type || ""))) return "";
  const task = findAiActionTask(state, action);
  if (!task || !isBoostTask(task)) return "";
  const spend = num(task.spend);
  const budget = num(task.budget);
  if (!Number.isFinite(spend) || !Number.isFinite(budget) || budget <= 0) return "追投任务缺少有效消耗或预算，不能建议关闭，应继续观察。";
  if (spend < budget * 0.8) return `追投任务仅消耗 ${spend}/${budget} 元，未达到预算80%，按低消耗保护继续观察。`;
  if (!taskHasConfirmedZeroDeals(task)) return "追投任务已有成交或未采集到确认的零成交数据，不能按零成交规则建议关闭。";
  return "";
}

function applyBoostPauseGuard(state = {}, result = {}) {
  if (result?.decision !== "act" || !Array.isArray(result.actions)) return result;
  const blocked = [];
  const actions = result.actions.filter((action) => {
    const reason = boostPauseGuardReason(state, action);
    if (!reason) return true;
    blocked.push({ type: action.type, taskId: action.params?.taskId || action.taskId || "", reason });
    return false;
  });
  if (!blocked.length) return result;
  result.actions = actions;
  result.boostPauseGuard = blocked;
  if (!actions.length) result.decision = "observe";
  return result;
}

function cancelObsoleteAiBoostPauseActions(state = {}, now = Date.now()) {
  let cancelled = 0;
  (state.actions || []).forEach((action) => {
    if (action.source !== "ai" || !["pending_review", "ready_to_execute", "approved"].includes(action.status)) return;
    const reason = boostPauseGuardReason(state, action) || historicalLowSpendBoostPauseReason(action);
    if (!reason) return;
    action.status = "cancelled";
    action.cancelledAt = now;
    action.cancelReason = `已按追投低消耗保护撤销：${reason}`;
    cancelled += 1;
  });
  return cancelled;
}

function historicalLowSpendBoostPauseReason(action = {}) {
  if (!["pause_task", "end_task"].includes(String(action.type || ""))) return "";
  const text = String(action.reason || action.title || "");
  if (!/素材放量追投|素材控成本追投|素材追投/.test(text) || !/无任何转化|零成交|0\s*成交|成交\s*0/.test(text)) return "";
  const match = text.match(/预算\s*(\d+(?:\.\d+)?)\s*元?[，,。\s]*已消耗\s*(\d+(?:\.\d+)?)/);
  if (!match) return "";
  const budget = Number(match[1]);
  const spend = Number(match[2]);
  if (!Number.isFinite(budget) || !Number.isFinite(spend) || budget <= 0 || spend >= budget * 0.8) return "";
  return `AI 建议生成时记录为消耗 ${spend}/${budget} 元且零成交，未达到预算80%，按低消耗保护继续观察。`;
}

function ruleLog(name, triggered, reason) {
  return { name, triggered, reason };
}

function runRules(state, snapshots) {
  const now = Date.now();
  const metrics = state.metrics;
  const config = state.config;
  const fiveMinSpend = calcFiveMinSpend(metrics, snapshots);
  const created = [];
  const rulesEvaluated = [];
  expireActions(state, now);

  if (state.skipRulesReason) {
    rulesEvaluated.push(ruleLog("snapshot_freshness", false, state.skipRulesReason));
    return { fiveMinSpend, created, rulesEvaluated };
  }

  if (!isInLiveWindow(config)) {
    rulesEvaluated.push(ruleLog("live_window", false, "非直播时段"));
    return { fiveMinSpend, created, rulesEvaluated };
  }
  rulesEvaluated.push(ruleLog("live_window", true, "直播时段内"));

  const drifted = Math.abs(config.targetRoi - config.baselineTargetRoi) > 1;
  if (drifted) {
    const action = pushAction(state, "roi_drift_alert", "ROI 目标漂移告警", {}, `当前目标 ${config.targetRoi} 相比基准 ${config.baselineTargetRoi} 偏离超过 1.0`, now, "rule");
    if (action) created.push(action);
    rulesEvaluated.push(ruleLog("roi_drift_guard", true, "停止自动调整 ROI 目标"));
  } else {
    rulesEvaluated.push(ruleLog("roi_drift_guard", false, "目标 ROI 未明显漂移"));
  }

  const canAdjustRoi = !drifted;
  const shouldRaise = canAdjustRoi && Number.isFinite(fiveMinSpend) && fiveMinSpend > config.highFiveMinSpend && metrics.overallRoi < config.targetRoi;
  rulesEvaluated.push(ruleLog("raise_roi_target", shouldRaise, shouldRaise ? "高消耗且 ROI 未达标" : "未满足高消耗低 ROI"));
  if (shouldRaise) {
    const next = Math.min(config.maxRoiTarget, money(config.targetRoi + 0.1));
    const action = pushAction(state, "raise_roi_target", "提高 ROI 目标止损", { previousTargetRoi: config.targetRoi, targetRoi: next }, `最近5分钟消耗${fiveMinSpend}元，综合ROI ${metrics.overallRoi} 低于目标 ${config.targetRoi}`, now, "rule");
    if (action) {
      created.push(action);
    }
  }

  const shouldLower = canAdjustRoi && Number.isFinite(fiveMinSpend) && fiveMinSpend < config.lowFiveMinSpend && metrics.overallRoi >= config.targetRoi;
  rulesEvaluated.push(ruleLog("lower_roi_target", shouldLower, shouldLower ? "低消耗且 ROI 达标" : "未满足低消耗达标 ROI"));
  if (shouldLower) {
    const next = Math.max(config.minRoiTarget, money(config.targetRoi - 0.05));
    const action = pushAction(state, "lower_roi_target", "降低 ROI 目标放量", { previousTargetRoi: config.targetRoi, targetRoi: next }, `最近5分钟消耗${fiveMinSpend}元，综合ROI ${metrics.overallRoi} 达标但跑量偏慢`, now, "rule");
    if (action) {
      created.push(action);
    }
  }

  (metrics.tasks || []).forEach((task) => {
    const decision = judgeTask(task, config.targetRoi);
    rulesEvaluated.push(ruleLog(`task_${task.name || "unknown"}`, Boolean(decision), decision || "任务未触发动作"));
    if (decision === "pause") {
      const action = pushAction(state, `pause_task_${task.name || task.id || "unknown"}`, "暂停零成交且预算消耗达80%的追投任务", { taskName: task.name, taskId: task.id }, `任务已消耗预算80%及以上且确认零成交，ROI ${task.roi} 明显低于目标`, now, "rule");
      if (action) created.push(action);
    }
    if (decision === "increase_budget") {
      const action = pushAction(state, `increase_budget_${task.name || task.id || "unknown"}`, "小额追加追投预算", { taskName: task.name, budgetIncrease: config.maxBudgetIncrease }, `任务ROI ${task.roi} 达标且已消耗预算超过60%`, now, "rule");
      if (action) created.push(action);
    }
  });

  return { fiveMinSpend, created, rulesEvaluated };
}

function writeWarning(type, payload) {
  appendJsonl(LOG_FILE, { id: `${Date.now()}-${type}`, receivedAt: Date.now(), type, ...payload });
}

async function runAiDecision(state, receivedAt) {
  recoverOrderMetricsFromLatestPages(state, receivedAt);
  recoverConsistentSpendMetrics(state, receivedAt);
  updateHourlySegmentMetrics(state, receivedAt);
  sanitizeStaleMetricState(state, receivedAt);
  state.aiInProgress = true;
  writeJson(STATE_FILE, state);
  const userPayload = buildUserPayload(state);
  const quadrant = detectQuadrant(state);
  const shiftProtection = isShiftProtection(state.config);
  const firstHourProtection = isFirstHourProtection(state.config);
  userPayload.quadrant = quadrant;
  userPayload.shiftProtection = shiftProtection;
  userPayload.firstHourProtection = firstHourProtection;
  const enrichedSystemPrompt = `${buildSystemPrompt()}\n\n--- 以下是完整投放 SOP 规则 ---\n\n${INVESTMENT_RULES_CONTEXT}`;
  const payload = { config: state.config, systemPrompt: enrichedSystemPrompt, userPayload };
  let result = await deepseek.decide(payload);
  result = appendRoiLanguageCorrection(result, state);
  result = applyBoostPauseGuard(state, result);
  cancelObsoleteAiBoostPauseActions(state, receivedAt);
  state.aiInProgress = false;
  state.lastAiCallAt = receivedAt;
  appendJsonl(AI_LOG_FILE, { ts: receivedAt, payload: userPayload, result });
  if (result.decision === "act" && Array.isArray(result.actions)) {
    result.actions.forEach((action) => {
      pushAction(state, action.type, action.reason, action.params || {}, `AI建议(置信度${action.confidence ?? "--"})：${action.reason}`, receivedAt, "ai");
    });
  }
  return result;
}

async function triggerAiNow(options = {}) {
  const initialState = readJson(STATE_FILE, {});
  initialState.config = migrateConfig(initialState.config);
  if (reconcileLiveLifecycleForNow(initialState)) writeJson(STATE_FILE, initialState);
  if (initialState.liveLifecycle?.status === "off_air" && options.force !== true) {
    return { error: "live_off_air_ai_disabled", reasoning: "直播已下播，已禁止继续调用 AI 自动分析", actions: [], collect: null };
  }
  let collect = null;
  if (options.collectVisual !== false) {
    collect = await runVisualCaptureForState();
  }
  const state = readJson(STATE_FILE, {});
  const receivedAt = Date.now();
  state.config = migrateConfig(state.config);
  reconcileLiveLifecycleForNow(state, new Date(receivedAt));
  if (state.liveLifecycle?.status === "off_air" && options.force !== true) {
    return { error: "live_off_air_ai_disabled", reasoning: "直播已下播，已禁止继续调用 AI 自动分析", actions: [], collect };
  }
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  state.lastActionAt = state.lastActionAt || {};
  normalizeActionSources(state);
  recoverOrderMetricsFromLatestPages(state, receivedAt);
  recoverConsistentSpendMetrics(state, receivedAt);
  updateHourlySegmentMetrics(state, receivedAt);
  sanitizeStaleMetricState(state, receivedAt);
  cancelObsoleteAiBoostPauseActions(state, receivedAt);
  state.aiInProgress = true;
  writeJson(STATE_FILE, state);
  const userPayload = buildUserPayload(state);
  const quadrant = detectQuadrant(state);
  const shiftProtection = isShiftProtection(state.config);
  const firstHourProtection = isFirstHourProtection(state.config);
  userPayload.quadrant = quadrant;
  userPayload.shiftProtection = shiftProtection;
  userPayload.firstHourProtection = firstHourProtection;
  const enrichedSystemPrompt = `${buildSystemPrompt()}\n\n--- 以下是完整投放 SOP 规则 ---\n\n${INVESTMENT_RULES_CONTEXT}`;
  const payload = { config: state.config, systemPrompt: enrichedSystemPrompt, userPayload };
  let result = await deepseek.decide(payload);
  result = appendRoiLanguageCorrection(result, state);
  result = applyBoostPauseGuard(state, result);
  state.aiInProgress = false;
  state.lastAiCallAt = receivedAt;
  appendJsonl(AI_LOG_FILE, { ts: receivedAt, payload: userPayload, result });
  const created = [];
  if (result.decision === "act" && Array.isArray(result.actions)) {
    result.actions.forEach((action) => {
      const createdAction = pushAction(state, action.type, action.reason, action.params || {}, `AI建议(置信度${action.confidence ?? "--"})：${action.reason}`, receivedAt, "ai");
      if (createdAction) created.push(createdAction);
    });
  }
  applyAiFailureGuard(state, result, receivedAt);
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  const autoExecutions = [];
  if (state.config.actionMode === "armed") {
    for (const action of created.filter((item) => item.status === "ready_to_execute")) {
      const executionResult = await executeApprovedAction(action.id);
      autoExecutions.push({
        actionId: action.id,
        type: action.type,
        ok: executionResult.ok,
        error: executionResult.error,
        execution: executionResult.execution,
      });
    }
  }
  const latest = readJson(STATE_FILE, state);
  const latestActions = created.map((action) => (latest.actions || []).find((item) => item.id === action.id) || action);
  notifyAiSuggestion(latest, result, latestActions, receivedAt);
  return { decision: result.decision, reasoning: result.reasoning, actions: latestActions, autoExecutions, error: result.error, collect };
}

function normalizeChatAction(action = {}, state = {}, now = Date.now(), index = 0) {
  const type = String(action.type || "").trim();
  if (!type) return null;
  const taskId = String(action.taskId || action.params?.taskId || "").trim();
  const taskName = String(action.taskName || action.params?.taskName || "").trim();
  const matchedTask = (state.metrics?.tasks || []).find((task) => String(task.taskId || task.id || "") === taskId || (taskName && String(task.name || "").includes(taskName))) || {};
  const taskActionTypes = new Set(["pause_task", "end_task", "increase_task_budget", "decrease_task_budget", "extend_task_duration", "change_roi_target", "adjust_task_budget_duration"]);
  const matchedTaskId = String(matchedTask.taskId || matchedTask.id || "").trim();
  if (taskActionTypes.has(type) && (!matchedTaskId || (taskId && String(taskId) !== matchedTaskId))) {
    const reason = taskId
      ? `AI 生成的任务 ID ${taskId} 不在当前已采集任务列表中，已拦截，避免误点。请先重新采集对应任务页，或让 AI 使用当前任务列表里的任务 ID。`
      : "AI 没有给出任务 ID，已拦截，避免误点。请先指定当前任务列表中的任务 ID。";
    return {
      id: `${now}-ai-chat-${index}-${type}-invalid`,
      type,
      title: "AI 对话建议动作未通过校验",
      payload: {
        taskId: taskId || undefined,
        taskName: taskName || undefined,
        validationError: "task_not_in_current_scan",
      },
      reason,
      source: "ai_chat",
      status: "invalid",
      createdAt: now,
      expiresAt: now,
    };
  }
  const pauseGuardReason = boostPauseGuardReason(state, {
    type,
    taskId: taskId || matchedTaskId,
    taskName: taskName || matchedTask.name,
  });
  if (pauseGuardReason) {
    return {
      id: `${now}-ai-chat-${index}-${type}-guarded`,
      type,
      title: "AI 对话建议不满足追投关闭条件",
      payload: { taskId: taskId || matchedTaskId || undefined, taskName: taskName || matchedTask.name || undefined, validationError: "boost_pause_threshold_not_met" },
      reason: pauseGuardReason,
      source: "ai_chat",
      status: "invalid",
      createdAt: now,
      expiresAt: now,
    };
  }
  const payload = {
    taskId: taskId || matchedTaskId || undefined,
    taskName: taskName || matchedTask.name || undefined,
    budget: action.budget ?? action.params?.budget,
    budgetIncrease: action.budgetIncrease ?? action.params?.budgetIncrease,
    durationHours: action.durationHours ?? action.params?.durationHours,
    targetRoi: action.targetRoi ?? action.params?.targetRoi,
    reason: action.reason || undefined,
    requiresExecutor: true,
  };
  return {
    id: `${now}-ai-chat-${index}-${type}`,
    type,
    title: action.reason || "AI 对话建议动作",
    payload,
    reason: action.reason || "AI 对话分析建议",
    source: "ai_chat",
    status: "approved",
    createdAt: now,
    expiresAt: now + (state.config?.actionExpiresMs || DEFAULT_CONFIG.actionExpiresMs),
  };
}

function shanghaiNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return { hour: Number(parts.hour), minute: Number(parts.minute), timeText: `${parts.hour}:${parts.minute}:${parts.second}` };
}

function liveDurationFromConfig(config = {}, date = new Date()) {
  const now = shanghaiNowParts(date);
  const [openHour, openMinute] = String(config.openTime || "06:00").split(":").map(Number);
  const nowMinutes = now.hour * 60 + now.minute;
  const openMinutes = openHour * 60 + openMinute;
  const duration = nowMinutes >= openMinutes ? nowMinutes - openMinutes : nowMinutes + 24 * 60 - openMinutes;
  return `${Math.floor(duration / 60)} 小时 ${duration % 60} 分钟`;
}

function moneyText(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString("zh-CN") : "--";
}

function ratioText(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${Math.round(parsed * 100) / 100}` : "--";
}

function percentText(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${Math.round(parsed * 10000) / 100}%` : "--";
}

function taskShortId(task = {}) {
  const id = String(task.taskId || task.id || "").trim();
  return id ? id.slice(-6) : "--";
}

function taskDisplayName(task = {}) {
  return String(task.name || task.taskName || "--")
    .replace(/^20\d{6}_/, "")
    .replace(/\s*ID[：:]\s*\d+/g, "")
    .slice(0, 48);
}

function chatMetrics(state = {}) {
  const metrics = state.metrics || {};
  const assist = state.assistMetrics || {};
  const overallCost = num(metrics.overallCost) || 0;
  const baseSpend = num(metrics.baseSpend);
  const boostSpend = Number.isFinite(overallCost) && Number.isFinite(baseSpend) && baseSpend <= overallCost
    ? Math.round((overallCost - baseSpend) * 100) / 100
    : num(metrics.boostSpend);
  return {
    overallCost,
    overallRoi: num(metrics.overallRoi),
    dealAmount: num(metrics.dealAmount),
    orderCount: num(assist.orderCount ?? metrics.orderCount),
    orderCost: num(assist.orderCost ?? metrics.orderCost),
    baseSpend,
    boostSpend,
    boostRatio: num(metrics.boostRatio),
    hourSegmentSpend: num(metrics.hourSegmentSpend),
    hourSegmentBaseSpend: num(metrics.hourSegmentBaseSpend),
    hourSegmentBoostRatio: num(metrics.hourSegmentBoostRatio),
    currentHourCost: num(metrics.currentHourCost),
    currentHourRoi: num(metrics.currentHourRoi),
    currentHourDealAmount: num(metrics.currentHourDealAmount),
    currentHourOrders: num(metrics.currentHourOrders),
    watchDealRate: num(metrics.watchDealRate),
    targetRoi: num(state.config?.targetRoi) || DEFAULT_CONFIG.targetRoi,
  };
}

function lowEfficiencyTasks(state = {}, limit = 5) {
  const target = num(state.config?.targetRoi) || DEFAULT_CONFIG.targetRoi;
  return (state.metrics?.tasks || [])
    .filter((task) => Number.isFinite(num(task.roi)) && Number.isFinite(num(task.spend)) && num(task.spend) > 0)
    .filter((task) => num(task.roi) < target)
    .sort((a, b) => (num(a.roi) - num(b.roi)) || (num(b.spend) - num(a.spend)))
    .slice(0, limit);
}

function boostTasks(state = {}) {
  return (state.metrics?.tasks || []).filter((task) => ["materialBoost", "oneClickLift"].includes(task.taskType));
}

function materialBoostTasks(state = {}) {
  return (state.metrics?.tasks || []).filter((task) => task.taskType === "materialBoost");
}

function taskLines(tasks = []) {
  if (!tasks.length) return ["当前未采集到明确低效任务。"];
  return tasks.map((task, index) => `${index + 1}. **${taskDisplayName(task)}**（ID 后6位 ${taskShortId(task)}）：ROI ${ratioText(task.roi)}，消耗 ${moneyText(task.spend)} 元，预算 ${moneyText(task.budget)} 元`);
}

function clickTaskLines(tasks = []) {
  if (!tasks.length) return ["当前未采集到素材追投任务的点击/曝光数据。"];
  return tasks.map((task, index) => {
    const impressions = num(task.impressions);
    const clicks = num(task.clicks);
    const ctr = Number.isFinite(impressions) && impressions > 0 && Number.isFinite(clicks) ? clicks / impressions : null;
    return `${index + 1}. **${taskDisplayName(task)}**（ID 后6位 ${taskShortId(task)}）：曝光 ${moneyText(impressions)}，点击 ${moneyText(clicks)}，点击率 ${percentText(ctr)}，消耗 ${moneyText(task.spend)} 元，ROI ${ratioText(task.roi)}`;
  });
}

function shouldUseFastChatReply(message = "") {
  const text = String(message || "").trim();
  if (!text) return false;
  if (/^(哈喽|你好|您好|hi|hello|在吗|嗨)[！!。.\s]*$/i.test(text)) return true;
  if (/(为什么|为啥|怎么|咋|原因|判断|分析一下|要不要|该不该|能不能|是否|是不是|哪里|思路|策略|建议)/.test(text)) return false;
  if (text.length > 12) return false;
  return /^(当前盘况|现在盘况|追投分析|追投占比|低效任务|ROI最低|roi最低|风险扫描|今天数据|实时数据)$/i.test(text);
}

function buildFastChatReply(message = "", state = {}, model = "") {
  const text = String(message || "").trim();
  const m = chatMetrics(state);
  const now = shanghaiNowParts();
  const duration = liveDurationFromConfig(state.config || {});
  if (/^(哈喽|你好|您好|hi|hello|在吗|嗨)[！!。.\s]*$/i.test(text)) {
    return [
      "我在。你可以直接问我：",
      "",
      "- 当前盘况",
      "- 追投占比和追投任务",
      "- ROI 最低的任务",
      "- 风险扫描",
      "- 某个任务要不要加预算或暂停",
    ].join("\n");
  }
  if (/(当前盘况|现在盘况|盘况怎么样|整体情况|今天数据|实时数据)/.test(text)) {
    return [
      `**当前盘况（北京时间 ${now.timeText}）**`,
      "",
      `- 已直播：${duration}`,
      `- 综合成本：${moneyText(m.overallCost)} 元，净成交 ROI：${ratioText(m.overallRoi)} / 目标 ${ratioText(m.targetRoi)}`,
      `- 单小时 ROI：${ratioText(m.currentHourRoi)}，单小时消耗：${moneyText(m.currentHourCost)} 元`,
      `- 净成交金额：${moneyText(m.dealAmount)} 元，订单数：${moneyText(m.orderCount)}，订单成本：${moneyText(m.orderCost)} 元`,
      `- 基础消耗：${moneyText(m.baseSpend)} 元，追投消耗：${moneyText(m.boostSpend)} 元，追投占比：${ratioText(m.boostRatio)}%`,
      `- 小时段消耗：${moneyText(m.hourSegmentSpend)} 元，小时基础消耗：${moneyText(m.hourSegmentBaseSpend)} 元，小时追投占比：${ratioText(m.hourSegmentBoostRatio)}%`,
      "",
      Number.isFinite(m.overallRoi) && m.overallRoi < m.targetRoi ? "**判断：** ROI 低于目标，优先看低效追投和一键起量任务，不建议盲目加预算。" : "**判断：** ROI 达标或接近目标，可以继续观察高 ROI 任务是否有小幅加量空间。",
    ].join("\n");
  }
  if (/(高.{0,6}roi|低.{0,6}roi|当前小时|单小时.{0,4}roi|小时.{0,4}roi|怎么判断.*roi|判断.*roi)/i.test(text)) {
    const highThreshold = Math.round(m.targetRoi * 100) / 100;
    const watchThreshold = Math.round(m.targetRoi * 0.8 * 100) / 100;
    if (!Number.isFinite(m.currentHourRoi)) {
      return [
        "**当前还不能准确判断单小时 ROI。**",
        "",
        `高 ROI 必须达到目标 ROI：**${ratioText(highThreshold)}**；目标 × 0.8 = **${ratioText(watchThreshold)}** 只是观察线。`,
        `目前只有全天 ROI：${ratioText(m.overallRoi)}，不能直接当作单小时 ROI。`,
        "",
        "请先点顶部 **采集单小时明细**，采到投放管理直播间明细里的分时段 ROI 后，我再按当前小时判断高低。",
      ].join("\n");
    }
    const isHigh = m.currentHourRoi >= highThreshold;
    const nearWatchLine = !isHigh && m.currentHourRoi >= watchThreshold;
    return [
      `**单小时 ROI 判断**`,
      "",
      `- 目标 ROI：${ratioText(m.targetRoi)}`,
      `- 高 ROI 阈值：达到目标 ROI = **${ratioText(highThreshold)}**`,
      `- 观察线：目标 ROI × 0.8 = **${ratioText(watchThreshold)}**`,
      `- 当前单小时 ROI：**${ratioText(m.currentHourRoi)}**`,
      `- 当前单小时消耗：${moneyText(m.currentHourCost)} 元`,
      "",
      isHigh
        ? "**结论：当前小时属于高 ROI 区间。**"
        : nearWatchLine
          ? "**结论：当前小时未达目标，不算高 ROI；只是高于观察线，可以继续观察，不建议直接放量。**"
          : "**结论：当前小时不属于高 ROI 区间。**",
      "注意：动作建议还要结合单小时消耗速度、追投占比和任务级 ROI，不能只看 ROI 一个数。",
    ].join("\n");
  }
  if (/(点击|点进|点击次数|点击量|点击率|流量少|曝光少|为什么.*少|为啥.*少)/.test(text) && /(素材|追投|放量)/.test(text)) {
    const tasks = materialBoostTasks(state);
    const withTraffic = tasks
      .filter((task) => Number.isFinite(num(task.impressions)) || Number.isFinite(num(task.clicks)) || Number.isFinite(num(task.spend)))
      .sort((a, b) => (num(a.clicks) - num(b.clicks)) || (num(b.spend) - num(a.spend)))
      .slice(0, 6);
    const lowClick = withTraffic.filter((task) => num(task.clicks) < 10);
    return [
      `**素材放量点击少分析（北京时间 ${now.timeText}）**`,
      "",
      ...clickTaskLines(withTraffic),
      "",
      lowClick.length
        ? `**判断：** 当前有 ${lowClick.length} 条素材追投点击低于 10。优先看两件事：曝光是否也低、点击率是否低。曝光低多半是放量还没跑开或预算/出价不够；曝光有了但点击低，才更像素材封面/前3秒/人群不匹配。`
        : "**判断：** 当前素材追投不是明显“无点击”，下一步应结合点击率和转化 ROI 判断是否继续放量。",
      "",
      "建议：先不要只按 ROI 暂停，先看每条素材的曝光、点击、点击率；如果曝光低且刚启动，观察 10-15 分钟；如果曝光高但点击率低，再换素材或停掉该条追投。",
    ].join("\n");
  }
  if (/(追投|追投占比|素材追投|一键起量)/.test(text)) {
    const tasks = boostTasks(state);
    const low = tasks.filter((task) => Number.isFinite(num(task.roi)) && num(task.roi) < m.targetRoi);
    return [
      `**追投分析（北京时间 ${now.timeText}）**`,
      "",
      `- 追投占比：${ratioText(m.boostRatio)}%`,
      `- 追投消耗：${moneyText(m.boostSpend)} 元，基础消耗：${moneyText(m.baseSpend)} 元`,
      `- 小时追投占比：${ratioText(m.hourSegmentBoostRatio)}%，小时段消耗：${moneyText(m.hourSegmentSpend)} 元，小时基础消耗：${moneyText(m.hourSegmentBaseSpend)} 元`,
      `- 当前采集到追投/一键起量任务：${tasks.length} 条`,
      "",
      low.length ? ["**低于目标 ROI 的追投任务：**", ...taskLines(low.slice(0, 5))].join("\n") : "**低于目标 ROI 的追投任务：** 当前未采集到。",
    ].join("\n");
  }
  if (/(低效任务|ROI 最低|roi最低|谁最差|异常任务)/i.test(text)) {
    const tasks = lowEfficiencyTasks(state, 6);
    return [
      `**低效任务（目标 ROI ${ratioText(m.targetRoi)}）**`,
      "",
      ...taskLines(tasks),
      "",
      tasks.length ? "建议先核对这些任务是否还在投放中，再决定暂停或收预算。" : "当前任务明细可能未采集完整，建议先点“采集调控任务 / 采集素材追投 / 采集一键起量”。",
    ].join("\n");
  }
  if (/(风险扫描|风险|预警|哪里不对|问题)/.test(text)) {
    const risks = [];
    if (Number.isFinite(m.boostRatio) && m.boostRatio > 30) risks.push(`追投占比 ${ratioText(m.boostRatio)}%，高于 30% 红线。`);
    if (Number.isFinite(m.overallRoi) && m.overallRoi < m.targetRoi) risks.push(`净成交 ROI ${ratioText(m.overallRoi)} 低于目标 ${ratioText(m.targetRoi)}。`);
    if (Number.isFinite(m.currentHourRoi) && m.currentHourRoi < m.targetRoi) risks.push(`单小时 ROI ${ratioText(m.currentHourRoi)} 未达目标 ${ratioText(m.targetRoi)}，不能按高 ROI 放量。`);
    if (Number.isFinite(m.hourSegmentBoostRatio) && m.hourSegmentBoostRatio > 30) risks.push(`小时段追投占比 ${ratioText(m.hourSegmentBoostRatio)}%，短时追投偏高。`);
    const low = lowEfficiencyTasks(state, 3);
    if (low.length) risks.push(`存在 ${low.length} 条低效任务，最低 ROI 为 ${ratioText(low[0].roi)}（${taskDisplayName(low[0])}，ID 后6位 ${taskShortId(low[0])}）。`);
    return [
      `**风险扫描（北京时间 ${now.timeText}）**`,
      "",
      risks.length ? risks.map((item) => `- ${item}`).join("\n") : "- 当前未发现明确红线风险。",
      "",
      "优先级：先控低效追投，再观察 ROI 和小时段消耗变化。",
    ].join("\n");
  }
  return null;
}

async function handleAiChat(body = {}, modelOverride = "") {
  const message = String(body.message || "").trim();
  if (!message) return { ok: false, error: "请输入问题" };
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  const memory = readAiMemory();
  const model = modelOverride || state.config.aiModel || "deepseek-v4-pro";
  const isMetaQuestion = /(什么模型|哪个模型|模型是|你是谁|你能做什么|能力|功能|介绍一下你|全能)/i.test(message);
  if (isMetaQuestion) {
    const reply = [
      `我现在是本地千川调控台里的 **AI 分析智能 Agent**，当前对话通道使用模型：**${model}**。`,
      "",
      "我可以做这些事：",
      "1. 看当前盘况、追投占比、ROI、订单成本、小时段消耗。",
      "2. 找低效任务和异常任务，解释为什么有风险。",
      "3. 按投放 SOP 给调控建议，并在需要时生成待执行动作。",
      "4. 记住你的偏好和最近对话，连续跟你一起看盘。",
      "",
      "涉及实时数据时，我只按当前采集到的 state 回答；没采到的数据我会明确说没采到，不会乱编。",
    ].join("\n");
    rememberAiChat(message, reply, []);
    return { ok: true, reply, actions: [], memory: readAiMemory() };
  }
  const fastReply = shouldUseFastChatReply(message) ? buildFastChatReply(message, state, model) : null;
  if (fastReply) {
    appendJsonl(AI_LOG_FILE, { ts: Date.now(), type: "ai_chat_fast", message, reply: fastReply, actions: [] });
    rememberAiChat(message, fastReply, []);
    return { ok: true, reply: fastReply, actions: [], memory: readAiMemory() };
  }
  const { systemPrompt, userPayload } = buildChatPrompt(state, INVESTMENT_RULES_CONTEXT, message, memory);
  if (userPayload.runtime) userPayload.runtime.model = model;
  const client = /^claude|^anthropic[:/]/i.test(model) ? claude : deepseek;
  const result = await client.chat({
    config: state.config,
    model,
    systemPrompt,
    userPayload,
  });
  if (result.error) return { ok: false, error: "AI 分析失败，请稍后重试" };
  const now = Date.now();
  const actions = (result.actions || []).map((action, index) => normalizeChatAction(action, state, now, index)).filter(Boolean);
  if (actions.length) {
    state.actions.unshift(...actions);
    state.actions = state.actions.slice(0, 100);
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
    appendJsonl(AI_LOG_FILE, { ts: now, type: "ai_chat", message, reply: result.reply, actions });
  } else {
    appendJsonl(AI_LOG_FILE, { ts: now, type: "ai_chat", message, reply: result.reply, actions: [] });
  }
  const latestMemory = rememberAiChat(message, result.reply || "当前没有明确结论。", actions);
  return { ok: true, reply: result.reply || "当前没有明确结论。", actions, memory: latestMemory };
}

async function updateState(snapshot) {
  const state = readJson(STATE_FILE, {});
  const receivedAt = Date.now();
  state.config = migrateConfig(state.config);
  reconcileLiveLifecycleForNow(state, new Date(receivedAt));
  delete state.skipRulesReason;

  if (snapshot.accountId && snapshot.accountId !== state.config.expectedAccountId) {
    writeWarning("account_mismatch", { received: snapshot.accountId, expected: state.config.expectedAccountId, pageType: snapshot.pageType });
    return { rejected: true, error: "account_mismatch", received: snapshot.accountId };
  }

  if (snapshot.pageType === "apiIntercept") {
    const normalized = { ...snapshot, receivedAt };
    appendJsonl(SNAPSHOT_FILE, normalized);
    const reqFrom = reqFromOf(snapshot.fields?.url);
    console.log("[apiIntercept]", reqFrom || "null", snapshot.fields?.url || "");
    const points = reqFrom === "totalTrend" ? pickTrendPoints(snapshot.fields) : [];
    const interceptUrl = String(snapshot.fields?.url || "");
    const isRoi2Log = isRoi2LogUrl(interceptUrl);
    if ((reqFrom === "totalTrend" && points.length) || interceptUrl.includes("/room_message")) {
      applyLiveLifecycleSignal(state, {
        status: "live",
        confidence: interceptUrl.includes("/room_message") ? 0.9 : 0.75,
        reason: interceptUrl.includes("/room_message") ? "直播间消息接口仍在刷新" : "投放趋势接口返回当前直播数据",
        source: reqFrom || "apiIntercept",
      }, receivedAt);
    }
    const materialInfoMap = pickMaterialInfoMap(snapshot.fields);
    state.trendData = Array.isArray(state.trendData) ? state.trendData : [];
    state.metrics = state.metrics || {};
    if (materialInfoMap) {
      const materialIds = Object.keys(materialInfoMap);
      if (String(snapshot.fields?.url || "").includes("material/list-optional") && materialIds.length > 0) {
        const firstMaterial = materialInfoMap[materialIds[0]] || {};
        const aggregateAid = firstMaterial.aggregateAid || "";
        if (aggregateAid) {
          state.materialMap = state.materialMap || {};
          const previous = state.materialMap[aggregateAid]?.materialIds || [];
          state.materialMap[aggregateAid] = {
            materialIds: Array.from(new Set([...materialIds, ...previous])).slice(0, 50),
            updatedAt: Date.now(),
          };
        }
      }
      state.materialIndex = mergeMaterialIndex(state.materialIndex || {}, materialInfoMap, receivedAt, { pageUrl: snapshot.fields?.pageUrl });
      if (Array.isArray(state.metrics.tasks)) {
        state.metrics.tasks = taskListForState(state.metrics.tasks, state);
        state.taskGroups = groupTasksByType(state.metrics.tasks);
      }
    }
    if (isRoi2Log) {
      const roi2LogTasks = pickRoi2LogTasks(snapshot.fields, receivedAt, state.config);
      state.latestByPage = state.latestByPage || {};
      state.latestByPage.roi2LogTaskCenter = {
        pageType: "roi2LogTaskCenter",
        accountId: snapshot.accountId || state.config?.expectedAccountId || null,
        timestamp: receivedAt,
        receivedAt,
        fields: roi2LogTasks,
      };
      if (roi2LogTasks.length) {
        state.metrics = {
          ...(state.metrics || {}),
          ...mergeMetrics(state.latestByPage, state.materialIndex || {}, state.materialMap || {}),
        };
        state.taskGroups = groupTasksByType(state.metrics.tasks || []);
        state.taskSource = {
          ...(state.taskSource || {}),
          source: state.taskSource?.source === "visual_task_scan" ? state.taskSource.source : "api_roi2_log",
          status: "ok",
          receivedAt: Math.max(Number(state.taskSource?.receivedAt || 0), receivedAt),
          total: state.metrics.tasks?.length || roi2LogTasks.length,
          message: state.taskSource?.source === "visual_task_scan"
            ? "一键起量/素材追投来自 roi2Log，当前页表格来自视觉扫描"
            : "一键起量/素材追投来自 roi2Log 接口日志",
        };
      }
    }
    if (points.length) {
      state.trendData = points;
      const trendTotals = pickTrendTotals(snapshot.fields);
      const baseSpend = num(state.metrics?.baseSpend);
      const totalIsConsistent = !Number.isFinite(baseSpend) || trendTotals.overallCost >= baseSpend;
      if (Number.isFinite(trendTotals.overallCost) && trendTotals.overallCost > 10 && totalIsConsistent) {
        state.metrics.overallCost = trendTotals.overallCost;
        setMetricSource(state, "overallCost", "totalTrend", receivedAt);
      }
      if (Number.isFinite(trendTotals.dealAmount) && trendTotals.dealAmount > 10 && totalIsConsistent) {
        state.metrics.dealAmount = trendTotals.dealAmount;
        setMetricSource(state, "dealAmount", "totalTrend", receivedAt);
      }
      if (Number.isFinite(trendTotals.overallRoi) && totalIsConsistent) {
        state.metrics.overallRoi = trendTotals.overallRoi;
        setMetricSource(state, "overallRoi", "totalTrend", receivedAt);
      }
    }
    recoverConsistentSpendMetrics(state, receivedAt);
    updateHourlySegmentMetrics(state, receivedAt);
    const hourlySource = reqFrom === "material_trend_live" ? "api_hourly_trend" : (reqFrom === "totalTrend" ? "api_total_trend_hourly" : "");
    const mergedHourlyBreakdown = hourlySource
      ? mergeHourlyBreakdown(state, pickHourlyBreakdown(snapshot.fields, receivedAt, hourlySource), receivedAt, hourlySource)
      : false;
    sanitizeStaleMetricState(state, receivedAt);
    if (isAssistReq(reqFrom)) {
      const assistMetrics = pickAssistMetrics(snapshot.fields);
      if (assistMetrics) {
        mergeFiniteAssistMetrics(state, assistMetrics, "assist", receivedAt);
      } else if (snapshot.fields?.data?.status_code && snapshot.fields.data.status_code !== 0) {
        setOrderMetricError(state, "assist", receivedAt, snapshot.fields);
      }
    }
    if (reqFrom === "materialLive") {
      const orderMetrics = pickMaterialLiveMetrics(snapshot.fields);
      if (orderMetrics) {
        mergeFiniteAssistMetrics(state, orderMetrics, "materialLive", receivedAt);
      } else if (snapshot.fields?.data?.status_code && snapshot.fields.data.status_code !== 0) {
        setOrderMetricError(state, "materialLive", receivedAt, snapshot.fields);
      }
    }
    if (reqFrom !== "totalTrend" && !isOrderMetricReq(reqFrom) && !materialInfoMap && !isRoi2Log && !mergedHourlyBreakdown) {
      state.unmatchedIntercepts = [{ receivedAt, reqFrom: reqFrom || null, url: snapshot.fields?.url || "" }, ...(state.unmatchedIntercepts || [])].slice(0, 20);
    }
    state.trendData = state.trendData.slice(-60);
    state.lastInterceptAt = receivedAt;
    state.updatedAt = new Date().toISOString();
    if (shouldRunAutoAi(state, receivedAt)) {
      state.actions = Array.isArray(state.actions) ? state.actions : [];
      const beforeIds = new Set(state.actions.map((action) => action.id));
      const aiResult = await runAiDecision(state, receivedAt);
      const createdActions = state.actions.filter((action) => !beforeIds.has(action.id) && action.source === "ai");
      applyAiFailureGuard(state, aiResult, receivedAt);
      notifyAiSuggestion(state, aiResult, createdActions, receivedAt);
    }
    preserveConcurrentHourlyState(state);
    writeJson(STATE_FILE, state);
    notifySystemAlerts(state);
    appendJsonl(LOG_FILE, { id: `${receivedAt}`, receivedAt, pageType: "apiIntercept", accountId: snapshot.accountId || null, trendPoints: points.length });
    return { state, ruleResult: { fiveMinSpend: state.fiveMinSpend ?? null, created: [] } };
  }

  const previousSnapshot = state.latestByPage?.[snapshot.pageType];
  const normalized = { ...snapshot, receivedAt };
  const sourceTimestamp = Number.isFinite(snapshot.timestamp) ? snapshot.timestamp : receivedAt;
  if (receivedAt - sourceTimestamp > state.config.snapshotFreshnessMs) {
    state.skipRulesReason = `快照超过${Math.round(state.config.snapshotFreshnessMs / 60000)}分钟，不跑规则`;
  }
  state.latestByPage = { ...(state.latestByPage || {}), [snapshot.pageType]: normalized };
  state.metrics = mergeMetrics(state.latestByPage, state.materialIndex || {}, state.materialMap || {});
  recoverConsistentSpendMetrics(state, receivedAt);
  updateHourlySegmentMetrics(state, receivedAt);
  sanitizeStaleMetricState(state, receivedAt);
  if (snapshot.pageType === "investOverview") {
    if (Number.isFinite(state.metrics.overallCost)) setMetricSource(state, "overallCost", "investOverview_dom", receivedAt);
    if (Number.isFinite(state.metrics.dealAmount)) setMetricSource(state, "dealAmount", "investOverview_dom", receivedAt);
    if (Number.isFinite(state.metrics.overallRoi)) setMetricSource(state, "overallRoi", "investOverview_dom", receivedAt);
  }
  if (snapshot.pageType === "liveScreen" && Number.isFinite(state.metrics.overallRoi)) {
    setMetricSource(state, "overallRoi", "liveScreen_dom", receivedAt);
  }
  if (snapshot.pageType === "liveScreen") {
    ["gpm", "onlineCount", "totalViewers", "exposureWatchRate", "watchDealRate"].forEach((key) => {
      if (Number.isFinite(num(state.metrics?.[key]))) setMetricSource(state, key, "liveScreen_dom", receivedAt);
    });
  }
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  state.lastActionAt = state.lastActionAt || {};
  appendJsonl(SNAPSHOT_FILE, normalized);
  const shouldRunRules = !state.lastRuleRunAt || receivedAt - state.lastRuleRunAt >= 180000;
  const ruleResult = shouldRunRules
    ? runRules(state, loadJsonl(SNAPSHOT_FILE))
    : { fiveMinSpend: state.fiveMinSpend ?? null, created: [], rulesEvaluated: [ruleLog("rule_throttle", false, "3分钟内不重复运行规则")] };
  if (shouldRunRules && !state.skipRulesReason) state.lastRuleRunAt = receivedAt;
  delete state.skipRulesReason;
  state.updatedAt = new Date().toISOString();
  state.fiveMinSpend = ruleResult.fiveMinSpend;
  state.metrics.fiveMinSpend = ruleResult.fiveMinSpend;
  if (shouldRunAutoAi(state, receivedAt)) {
    const beforeIds = new Set(state.actions.map((action) => action.id));
    const aiResult = await runAiDecision(state, receivedAt);
    const createdActions = state.actions.filter((action) => !beforeIds.has(action.id) && action.source === "ai");
    applyAiFailureGuard(state, aiResult, receivedAt);
    notifyAiSuggestion(state, aiResult, createdActions, receivedAt);
  }
  preserveConcurrentHourlyState(state);
  writeJson(STATE_FILE, state);
  notifySystemAlerts(state);
  appendJsonl(LOG_FILE, {
    id: `${receivedAt}`,
    receivedAt,
    pageType: snapshot.pageType,
    accountId: snapshot.accountId || null,
    roomStage: state.config.roomStage,
    metrics: state.metrics,
    boostShare: calcBoostShare(state.metrics),
    snapshotInterval: previousSnapshot?.receivedAt ? receivedAt - previousSnapshot.receivedAt : null,
    fiveMinSpend: ruleResult.fiveMinSpend,
    rulesEvaluated: ruleResult.rulesEvaluated,
    actions: ruleResult.created,
  });
  return { state, ruleResult };
}

function updateActionStatus(id, nextStatus, options = {}) {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  const action = state.actions.find((item) => item.id === id);
  if (!action) return { ok: false, error: "action_not_found" };
  const allowed = {
    pending_review: ["approved", "rejected", "expired"],
    ready_to_execute: ["approved", "expired"],
    approved: ["rejected", "expired"],
  };
  if (!allowed[action.status]?.includes(nextStatus)) return { ok: false, error: "invalid_transition", current: action.status };
  action.status = nextStatus;
  action.reviewedAt = Date.now();
  const reviewReason = String(options.reason || "").trim();
  if (reviewReason) action.reviewReason = reviewReason;
  writeJson(STATE_FILE, state);
  appendJsonl(LOG_FILE, { id: `${Date.now()}-action-${nextStatus}`, receivedAt: Date.now(), type: "action_status", actionId: id, status: nextStatus, reason: reviewReason || undefined });
  return { ok: true, action };
}

function taskForAction(state = {}, action = {}) {
  const id = taskIdFromPayload(action.payload || {});
  if (!id) return null;
  return (state.metrics?.tasks || []).find((task) => String(task.taskId || task.id || "") === String(id)) || null;
}

function appendActionFeedback(state = {}, action = {}, verdict = "", reason = "", execution = null) {
  if (!action?.id) return null;
  const task = taskForAction(state, action);
  const payload = action.payload || {};
  const taskId = taskIdFromPayload(payload);
  const feedback = {
    id: `${Date.now()}-action-feedback`,
    receivedAt: Date.now(),
    type: "action_feedback",
    verdict,
    reason: String(reason || "").trim(),
    actionId: action.id,
    actionType: action.type,
    taskId: taskId || undefined,
    taskName: payload.taskName || task?.name || undefined,
    atRoi: num(task?.roi ?? payload.roi ?? payload.targetRoi),
    budget: num(payload.budget),
    budgetIncrease: num(payload.budgetIncrease),
    durationHours: num(payload.durationHours),
    executionOk: execution ? execution.ok === true : undefined,
    executionDryRun: execution?.execution?.dryRun ?? execution?.dryRun,
    executionError: execution?.error || execution?.execution?.error || undefined,
  };
  appendJsonl(LOG_FILE, feedback);
  return feedback;
}

async function executeApprovedAction(id, options = {}) {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  const action = state.actions.find((item) => item.id === id);
  if (!action) return { ok: false, error: "action_not_found" };
  if (!["approved", "ready_to_execute"].includes(action.status)) return { ok: false, error: "action_not_approved", current: action.status };
  if (Date.now() > action.expiresAt) {
    action.status = "expired";
    writeJson(STATE_FILE, state);
    return { ok: false, error: "action_expired" };
  }
  const failPreflight = (error) => {
    action.status = "failed";
    action.executedAt = Date.now();
    action.execution = { ok: false, error, preflight: true };
    state.lastActionAt = state.lastActionAt || {};
    delete state.lastActionAt[actionKey(action.type, action.payload || {})];
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
    appendJsonl(LOG_FILE, { id: `${Date.now()}-action-preflight-failed`, receivedAt: Date.now(), type: "action_execution", actionId: id, error, preflight: true });
    return { ok: false, error, action };
  };
  const createAction = isCreateActionType(action.type);
  if (!createAction && !action.payload?.taskId) {
    return failPreflight("missing_task_id");
  }
  const taskExists = createAction || (state.metrics?.tasks || []).some((task) => String(task.taskId || task.id || "") === String(action.payload.taskId));
  if (!taskExists) {
    return failPreflight("task_not_in_current_scan");
  }
  if (!createAction) {
    const currentTask = taskForAction(state, action);
    if (currentTask) {
      action.payload = action.payload || {};
      action.payload.taskType = action.payload.taskType || currentTask.taskType || currentTask.type || undefined;
      action.payload.taskName = action.payload.taskName || currentTask.name || currentTask.taskName || undefined;
    }
  }
  const previousDryRunOk = action.execution?.dryRun === true && action.execution?.ok === true;
  const forceReal = options.forceReal === true;
  if (action.execution && !(previousDryRunOk && forceReal)) {
    return { ok: false, error: "already_executed" };
  }
  if (forceReal && createAction && !previousDryRunOk && !action.payload?.dryRunVerifiedAt) {
    return { ok: false, error: "create_dry_run_required" };
  }
  if (executionsLastHour(state) >= 3) {
    return { ok: false, error: "hourly_execute_limit_reached" };
  }
  const firstRealExecute = executionsLastHour(state) === 0;
  action.status = "executing";
  action.executingAt = Date.now();
  writeJson(STATE_FILE, state);
  try {
    const result = await executeAction(action, {
      dataDir: DATA_DIR,
      cdpUrl: state.config.cdpUrl,
      expectedAccountId: state.config.expectedAccountId,
      dryRun: createAction ? !forceReal : state.config.executorDryRun !== false,
      firstRealExecute,
    });
    const latest = readJson(STATE_FILE, state);
    const latestAction = (latest.actions || []).find((item) => item.id === id);
    if (latestAction) {
      latestAction.status = result.dryRun ? "approved" : result.ok ? "executed" : "failed";
      latestAction.executedAt = Date.now();
      latestAction.execution = result;
      if (createAction && result.dryRun && result.ok) {
        latestAction.payload = latestAction.payload || {};
        latestAction.payload.dryRunVerifiedAt = Date.now();
        latestAction.payload.requiresSecondConfirm = true;
      }
    }
    if (!result.ok && latestAction) {
      latest.lastActionAt = latest.lastActionAt || {};
      delete latest.lastActionAt[actionKey(latestAction.type, latestAction.payload)];
    }
    if (!result.ok && !result.dryRun) {
      const failedLastHour = (latest.actions || []).filter((item) => item.executedAt && Date.now() - item.executedAt < 60 * 60 * 1000 && item.status === "failed").length;
      if (failedLastHour >= 2) {
        latest.config = migrateConfig(latest.config);
        latest.config.aiEnabled = false;
        writeWarning("ai_auto_disabled", {
          reason: "executor_failures_exceeded",
          failedCount: failedLastHour,
        });
      }
    }
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    appendJsonl(LOG_FILE, { id: `${Date.now()}-action-execution`, receivedAt: Date.now(), type: "action_execution", actionId: id, result });
    notifyActionExecutionResult(latest, latestAction || action, { ok: result.ok, execution: result });
    return { ok: result.ok, action: latestAction, execution: result };
  } catch (error) {
    const latest = readJson(STATE_FILE, state);
    const latestAction = (latest.actions || []).find((item) => item.id === id);
    if (latestAction) {
      latestAction.status = "failed";
      latestAction.executedAt = Date.now();
      latestAction.execution = { ok: false, error: error.message };
      latest.lastActionAt = latest.lastActionAt || {};
      delete latest.lastActionAt[actionKey(latestAction.type, latestAction.payload)];
    }
    if (state.config.executorDryRun === false) {
      const failedLastHour = (latest.actions || []).filter((item) => item.executedAt && Date.now() - item.executedAt < 60 * 60 * 1000 && item.status === "failed").length;
      if (failedLastHour >= 2) {
        latest.config = migrateConfig(latest.config);
        latest.config.aiEnabled = false;
        writeWarning("ai_auto_disabled", {
          reason: "executor_failures_exceeded",
          failedCount: failedLastHour,
        });
      }
    }
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    appendJsonl(LOG_FILE, { id: `${Date.now()}-action-execution-failed`, receivedAt: Date.now(), type: "action_execution", actionId: id, error: error.message });
    notifyActionExecutionResult(latest, latestAction || action, { ok: false, error: error.message });
    return { ok: false, error: error.message, action: latestAction };
  }
}

function batchApproveActions(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: "ids_required" };
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  const approved = [];
  ids.forEach((id) => {
    const action = state.actions.find((item) => item.id === id);
    if (action && ["pending_review", "ready_to_execute"].includes(action.status)) {
      action.status = "approved";
      action.reviewedAt = Date.now();
      approved.push(id);
    }
  });
  writeJson(STATE_FILE, state);
  appendJsonl(LOG_FILE, { id: `${Date.now()}-action-batch-approved`, receivedAt: Date.now(), type: "action_status", status: "approved", actionIds: approved });
  return { ok: true, approved };
}

async function batchApproveAndMaybeExecute(ids) {
  const approvedResult = batchApproveActions(ids);
  if (!approvedResult.ok) return approvedResult;
  const executions = [];
  for (const id of approvedResult.approved) {
    const executionResult = await executeApprovedAction(id);
    const latest = readJson(STATE_FILE, {});
    const latestAction = (latest.actions || []).find((action) => action.id === id);
    const feedback = latestAction ? appendActionFeedback(latest, latestAction, "approved", "用户批量审批通过", executionResult) : null;
    executions.push({ actionId: id, ok: executionResult.ok, error: executionResult.error || "", executionResult, feedback });
  }
  return { ...approvedResult, executions };
}

function createManualActionCommand(body = {}) {
  const state = readJson(STATE_FILE, {});
  const receivedAt = Date.now();
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  state.lastActionAt = state.lastActionAt || {};
  normalizeActionSources(state);

  const taskId = String(body.taskId || "").trim();
  const taskName = String(body.taskName || "").trim();
  const command = String(body.command || "").trim();
  const actionType = String(body.actionType || "").trim();
  const budget = Number(body.budget);
  const budgetIncrease = Number(body.budgetIncrease);
  const durationHours = Number(body.durationHours ?? body.newDurationHours ?? body.extendHours);
  const targetRoi = Number(body.targetRoi ?? body.roi);
  const payRoi = Number(body.payRoi);
  const bidPrice = Number(body.bidPrice);
  const materialId = String(body.materialId || "").trim();
  const materialIds = materialIdsFromPayload(body.materialIds, materialId);
  const boostType = String(body.boostType || body.type || "").trim();
  const useLiveRoomImage = body.useLiveRoomImage !== false;
  const manualBoostOverride = body.manualBoostOverride === true;
  if (!command && !actionType) return { ok: false, error: "command_required" };

  const inferredType = actionType || (command.includes("新建") && command.includes("一键") ? "create_oneclick_task" : command.includes("新建") || command.includes("追投") ? "create_boost_task" : command.includes("结束") ? "end_task" : command.includes("暂停") ? "pause_task" : command.includes("ROI") || command.includes("roi") ? "change_roi_target" : command.includes("时长") ? "extend_task_duration" : command.includes("降") ? "decrease_task_budget" : "increase_task_budget");
  const hasDuration = Number.isFinite(durationHours) && durationHours > 0;
  const hasBudget = (Number.isFinite(budget) && budget > 0) || (Number.isFinite(budgetIncrease) && budgetIncrease > 0);
  const type = hasDuration && hasBudget && ["increase_task_budget", "extend_task_duration"].includes(inferredType)
    ? "adjust_task_budget_duration"
    : inferredType;
  const payloadTaskId = taskId || taskIdFromPayload({ taskName, command }) || "";
  const task = (state.metrics?.tasks || []).find((item) => String(item.taskId || item.id || "") === String(payloadTaskId)
    || String(item.name || "").includes(payloadTaskId)
    || (taskName && item.name === taskName));
  if (!isCreateActionType(type) && !task) {
    return { ok: false, error: "task_not_in_current_scan", detail: { taskId: payloadTaskId || undefined } };
  }
  const currentBudget = num(task?.budget);
  const commandUsesTargetBudget = /加到|调到|改到|预算到|新预算|设为|设置为|调整到/.test(command);
  let nextBudget = Number.isFinite(budget) && budget > 0 ? budget : undefined;
  let increaseAmount = Number.isFinite(budgetIncrease) && budgetIncrease > 0 ? budgetIncrease : undefined;
  if (["increase_task_budget", "adjust_task_budget_duration"].includes(type)) {
    const amount = increaseAmount ?? nextBudget;
    if (Number.isFinite(amount)) {
      if (commandUsesTargetBudget || !Number.isFinite(currentBudget)) {
        nextBudget = amount;
        increaseAmount = Number.isFinite(currentBudget) ? money(nextBudget - currentBudget) : undefined;
      } else {
        increaseAmount = amount;
        nextBudget = money(currentBudget + amount);
      }
    }
  }
  const payload = {
    taskId: payloadTaskId || undefined,
    taskName: taskName || undefined,
    taskType: task?.taskType || task?.type || undefined,
    command,
    materialId: materialIds[0] || undefined,
    materialIds: materialIds.length ? materialIds : undefined,
    boostType: boostType || undefined,
    budget: Number.isFinite(nextBudget) ? nextBudget : undefined,
    budgetIncrease: Number.isFinite(increaseAmount) ? increaseAmount : undefined,
    durationHours: Number.isFinite(durationHours) && durationHours > 0 ? durationHours : undefined,
    targetRoi: Number.isFinite(targetRoi) && targetRoi > 0 ? targetRoi : undefined,
    payRoi: Number.isFinite(payRoi) && payRoi > 0 ? payRoi : undefined,
    bidPrice: Number.isFinite(bidPrice) && bidPrice > 0 ? bidPrice : undefined,
    useLiveRoomImage,
    manualBoostOverride: manualBoostOverride || undefined,
    requiresExecutor: true,
  };
  if (!isCreateActionType(type) && !payload.taskId) return { ok: false, error: "task_id_required" };
  if (type === "change_roi_target" && !payload.targetRoi) return { ok: false, error: "target_roi_required" };
  if (type === "extend_task_duration" && !payload.durationHours) return { ok: false, error: "duration_required" };
  if (type === "create_boost_task" && !payload.materialIds?.length && !payload.useLiveRoomImage) return { ok: false, error: "material_id_required" };
  if (isCreateActionType(type) && !payload.budget) return { ok: false, error: "budget_required" };
  const titleByType = {
    increase_task_budget: "人工加预算",
    extend_task_duration: "人工延时长",
    change_roi_target: "人工改 ROI",
    pause_task: "人工暂停任务",
    end_task: "人工结束任务",
    create_boost_task: "人工新建追投",
    create_oneclick_task: "人工新建一键起量",
  };
  const title = titleByType[type] || "人工输入调控动作";
  const boostRatio = currentBoostRatioValue(state);
  const manualBoostOverrideAllowed = type === "create_boost_task" && manualBoostOverride;
  const manualBoostRisk = manualBoostOverrideAllowed && Number.isFinite(boostRatio) && boostRatio >= 28
    ? `当前追投占比 ${boostRatio}% 已达安全线，本次为人工主动创建，已保留风险提示。`
    : "";
  const reason = `用户输入动作：${command || title}。${manualBoostRisk}当前仅生成待审批动作，真正点击千川页面前仍需要执行器护栏校验。${isCreateActionType(type) ? "新建类动作会先 dryRun 截图验证，再二次确认真点。" : ""}`;
  const duplicate = findPendingDuplicateAction(state, type, payload, receivedAt);
  if (duplicate) {
    duplicate.reason = duplicate.reason || reason;
    duplicate.source = duplicate.source || "manual";
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
    return { ok: true, action: duplicate, reused: true, notice: "duplicate_pending_action_reused" };
  }
  const originalConfig = state.config;
  state.config = {
    ...originalConfig,
    actionMode: "review",
    actionCooldownMs: 0,
    maxActionsPerHour: Math.max(originalConfig.maxActionsPerHour || 3, activeActionCount(state, receivedAt) + 1),
  };
  const action = pushAction(state, type, title, payload, reason, receivedAt, "manual", {
    allowManualBoostOverride: manualBoostOverrideAllowed,
  });
  state.config = originalConfig;
  if (!action) return { ok: false, error: state.lastCreateActionReject?.reason || "action_dedup_or_throttled", detail: state.lastCreateActionReject || undefined };
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  appendJsonl(LOG_FILE, { id: `${receivedAt}-manual-action`, receivedAt, type: "manual_action", action });
  return { ok: true, action };
}

function materialBoostStatus(state = {}, item = {}) {
  const materialId = String(item.materialId || item["素材ID"] || "");
  const taskIds = (state.metrics?.tasks || [])
    .filter((task) => ["materialBoost", "materialCostControl"].includes(String(task.taskType || "")))
    .filter((task) => /调控中|进行中|投放中/.test(String(task.status || task.material?.status || "")))
    .filter((task) => (task.materialIds || task.material?.materialIds || []).map(String).includes(materialId))
    .map((task) => String(task.taskId || task.id || ""))
    .filter(Boolean);
  if (taskIds.length) return { label: "追投中", source: "task_center", taskIds };
  const collected = String(item.boostStatus || item["追投状态"] || "");
  if (collected === "追投中" || collected === "未追投") return { label: collected, source: "material_table", taskIds: [] };
  return { label: "未识别", source: "unresolved", taskIds: [] };
}

function materialScreenCandidate(item = {}, recommendation = {}, state = {}) {
  const materialId = String(item.materialId || item["素材ID"] || recommendation.materialId || "");
  const boost = materialBoostStatus(state, item);
  return {
    name: item.name || item.materialName || item["素材名称"] || materialId,
    materialId,
    spend: num(item.spend ?? item["消耗"]),
    roi: num(item.materialRoi ?? item["素材ROI"]),
    ctr: num(item.ctr ?? item.CTR),
    cvr: num(item.cvr ?? item.CVR),
    boostStatus: boost.label,
    boostTaskIds: boost.taskIds,
    boostStatusSource: boost.source,
    auditStatus: item.auditStatus || item["审核状态"] || "",
    materialType: item.materialType || item["类型"] || "",
    budget: Number(recommendation.budget) || 150,
    durationHours: Number(recommendation.durationHours) || 1,
    reason: String(recommendation.reason || "基于当前筛选结果，建议先小额预览验证。").slice(0, 50),
  };
}

async function screenMaterialRecommendations(body = {}) {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  const boostRatio = currentBoostRatioValue(state);
  const manualBoostOverride = body.manualBoostOverride === true;
  const boostRisk = Number.isFinite(boostRatio) && boostRatio >= 28;
  if (boostRisk && !manualBoostOverride) {
    return { ok: true, candidates: [], boostRatio, blocked: true, message: "追投占比已达28%，禁止新建追投" };
  }
  const screened = await screenMaterials(String(body.type || ""), body.manualIds, {
    cdpUrl: state.config.cdpUrl,
    accountId: state.config.expectedAccountId,
  });
  if (!screened.ok) return { ok: false, error: screened.error, paused: screened.paused, candidates: [] };
  const source = (screened.materials || []).slice(0, 10);
  const payload = {
    current: {
      overallRoi: num(state.metrics?.overallRoi),
      boostRatio,
      hourSpend: num(state.metrics?.hourSegmentSpend),
      onlineCount: num(state.metrics?.onlineCount),
      targetRoi: num(state.config?.targetRoi),
    },
    sop: state.config?.investmentSop?.autonomousBoostRules || "审核未通过和素材ROI低于2的素材不推荐。",
    manualBoostOverride,
    materials: source.map((item) => materialScreenCandidate(item, {}, state)),
  };
  const ai = await deepseek.decide({
    config: state.config,
    systemPrompt: "你是素材追投推荐助手。只返回严格 JSON：decision=act，actions 最多3条；每条 actions[].params 必须含 materialId、budget、durationHours，actions[].reason 不超过50字。仅从用户给出的素材中选择，审核未通过或素材ROI小于2的素材不能推荐。若 manualBoostOverride=true，用户正在主动创建追投；追投占比只作为风险提示，不能据此拒绝筛选。",
    userPayload: payload,
  });
  const recommendations = new Map((ai.actions || [])
    .map((action) => [String(action.params?.materialId || ""), { ...action.params, reason: action.reason }])
    .filter(([materialId]) => materialId));
  const candidates = source.map((item) => materialScreenCandidate(item, recommendations.get(String(item.materialId || item["素材ID"])) || {}, state));
  return {
    ok: true,
    candidates: candidates.length ? candidates : source.slice(0, 3).map((item) => materialScreenCandidate(item, {}, state)),
    boostRatio,
    blocked: false,
    manualBoostOverride,
    warning: boostRisk ? `当前追投占比 ${boostRatio}% 已达安全线；本次为人工主动创建，仍请核对风险后预览。` : "",
    warnings: screened.warnings || [],
    aiError: ai.error || "",
  };
}

function pendingAiActions(state) {
  return (state.actions || []).filter((action) => action.source === "ai" && ["pending_review", "ready_to_execute"].includes(action.status));
}

function readStateForDashboard() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  const lifecycleChanged = reconcileLiveLifecycleForNow(state);
  const metricsBefore = JSON.stringify({ metrics: state.metrics || {}, assistMetrics: state.assistMetrics || {}, metricSources: state.metricSources || {} });
  if (!hasMaterialIndex(state.materialIndex)) state.materialIndex = loadMaterialIndexFromSnapshots();
  if (state.latestByPage) {
    state.metrics = {
      ...(state.metrics || {}),
      ...mergeMetrics(state.latestByPage, state.materialIndex || {}, state.materialMap || {}),
    };
    recoverOrderMetricsFromLatestPages(state);
    recoverConsistentSpendMetrics(state);
    updateHourlySegmentMetrics(state);
    if (state.hourlyBreakdown?.current) {
      const current = state.hourlyBreakdown.current;
      const receivedAt = state.hourlyBreakdown.receivedAt || Date.now();
      const source = state.hourlyBreakdown.source || "hourly_detail_dom";
      const currentBaseCost = num(current.baseCost);
      if (Number.isFinite(num(current.cost))) {
        state.metrics.currentHourCost = num(current.cost);
        state.metrics.hourSegmentSpend = num(current.cost);
        setMetricSource(state, "currentHourCost", source, receivedAt, { time: current.time });
        setMetricSource(state, "hourSegmentSpend", source, receivedAt, { time: current.time });
        applyHourBoostRatioFromBaseSpend(state, state.metrics.hourSegmentSpend, Number.isFinite(currentBaseCost) ? currentBaseCost : null, receivedAt, {
          time: current.time,
          baseSource: "hourly_detail_base_only_dom",
          ratioSource: "hourly_detail_total_minus_base",
          missingBaseReason: "当前小时的基础消耗行未采集到，已暂不展示",
        });
      }
      if (Number.isFinite(num(current.roi))) {
        state.metrics.currentHourRoi = num(current.roi);
        setMetricSource(state, "currentHourRoi", source, receivedAt, { time: current.time });
      }
    }
  }
  if (state.metricSources?.flowSpeed?.source === "visual_live_screen" && !((state.metrics?.flowSpeed || 0) > 0)) {
    if (state.metrics) {
      state.metrics.flowSpeed = null;
    }
    if (state.metricSources?.fiveMinSpend?.source === "visual_live_screen") {
      if (state.metrics) state.metrics.fiveMinSpend = null;
      state.fiveMinSpend = null;
    }
    delete state.metricSources.flowSpeed;
  }
  recoverFiveMinSpendFromBoardTrend(state);
  if (state.metrics?.tasks) {
    state.metrics.tasks = taskListForState(state.metrics.tasks, state);
    state.metrics.boostTasks = state.metrics.tasks.length;
    state.taskGroups = groupTasksByType(state.metrics.tasks);
    if (state.taskSource?.status === "ok") state.taskSource.total = state.metrics.tasks.length;
  }
  const sourceBefore = JSON.stringify(state.actions.map((action) => [action.id, action.source]));
  normalizeActionSources(state);
  const before = JSON.stringify(state.actions.map((action) => [action.id, action.status]));
  expireActions(state, Date.now());
  const after = JSON.stringify(state.actions.map((action) => [action.id, action.status]));
  const sourceAfter = JSON.stringify(state.actions.map((action) => [action.id, action.source]));
  const metricsAfter = JSON.stringify({ metrics: state.metrics || {}, assistMetrics: state.assistMetrics || {}, metricSources: state.metricSources || {} });
  if (lifecycleChanged || before !== after || sourceBefore !== sourceAfter || metricsBefore !== metricsAfter) writeJson(STATE_FILE, state);
  return { ...state, config: publicConfig(state.config) };
}

function updateConfigPatch(patch) {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  if (patch.aiEnabled !== undefined) state.config.aiEnabled = patch.aiEnabled === true;
  if (patch.aiModel !== undefined && typeof patch.aiModel === "string" && patch.aiModel.trim()) state.config.aiModel = patch.aiModel.trim();
  if (patch.aiMinIntervalMs !== undefined && Number.isFinite(Number(patch.aiMinIntervalMs))) state.config.aiMinIntervalMs = Number(patch.aiMinIntervalMs);
  const targetRoi = validTargetRoi(patch.targetRoi);
  if (targetRoi !== null) state.config.targetRoi = targetRoi;
  const baselineTargetRoi = validTargetRoi(patch.baselineTargetRoi);
  if (baselineTargetRoi !== null) state.config.baselineTargetRoi = baselineTargetRoi;
  if (patch.cdpUrl !== undefined && typeof patch.cdpUrl === "string" && patch.cdpUrl.trim()) state.config.cdpUrl = patch.cdpUrl.trim();
  if (patch.actionMode !== undefined && ["review", "armed"].includes(patch.actionMode)) {
    state.config.actionMode = patch.actionMode === "armed" && patch.allowArmed !== true ? "review" : patch.actionMode;
  }
  if (patch.executorDryRun !== undefined) state.config.executorDryRun = patch.executorDryRun !== false;
  if (patch.autoCollectEnabled !== undefined) state.config.autoCollectEnabled = patch.autoCollectEnabled === true;
  if (patch.aiAutoCollectEnabled !== undefined) state.config.aiAutoCollectEnabled = patch.aiAutoCollectEnabled === true;
  if (patch.aiAutoCollectRefreshOnStuck !== undefined) state.config.aiAutoCollectRefreshOnStuck = patch.aiAutoCollectRefreshOnStuck !== false;
  if (patch.visualCollectStaleMs !== undefined && Number.isFinite(Number(patch.visualCollectStaleMs))) {
    state.config.visualCollectStaleMs = Math.max(60 * 1000, Number(patch.visualCollectStaleMs));
  }
  if (patch.autoReviewAfterOffAir !== undefined) state.config.autoReviewAfterOffAir = patch.autoReviewAfterOffAir !== false;
  if (patch.offAirConfirmationsRequired !== undefined && Number.isFinite(Number(patch.offAirConfirmationsRequired))) {
    state.config.offAirConfirmationsRequired = Math.max(1, Number(patch.offAirConfirmationsRequired));
  }
  if (patch.investmentSop !== undefined) {
    state.config.investmentSop = normalizeInvestmentSop(patch.investmentSop);
    state.config.targetRoi = state.config.investmentSop.targetRoi;
    state.config.baselineTargetRoi = state.config.investmentSop.targetRoi;
    state.config.openTime = state.config.investmentSop.openTime;
    state.config.closeTime = state.config.investmentSop.closeTime;
    state.config.maxBudgetIncrease = state.config.investmentSop.maxBudgetIncrease;
  }
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  return state.config;
}

function readDingTalkConfigForApi() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  return publicDingTalkConfig(state.config);
}

function saveDingTalkConfig(patch = {}) {
  const input = patch.dingtalk && typeof patch.dingtalk === "object" ? patch.dingtalk : patch;
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  const current = state.config.dingtalk || DEFAULT_CONFIG.dingtalk;
  const submittedWebhook = typeof input.webhook === "string" ? input.webhook.trim() : null;
  const submittedSecret = typeof input.secret === "string" ? input.secret.trim() : null;
  const webhook = submittedWebhook === null || submittedWebhook.includes("********") ? current.webhook : submittedWebhook;
  let secret = submittedSecret === null || submittedSecret === "" || submittedSecret.includes("********") ? current.secret : submittedSecret;
  if (input.clearSecret === true) secret = "";
  if (webhook.length > 4096) return { ok: false, error: "dingtalk_webhook_too_long" };
  if (secret.length > 512) return { ok: false, error: "dingtalk_secret_too_long" };
  if (webhook) {
    try {
      const url = new URL(webhook);
      if (url.protocol !== "https:") return { ok: false, error: "dingtalk_webhook_must_use_https" };
    } catch {
      return { ok: false, error: "dingtalk_webhook_invalid" };
    }
  }
  const enabled = input.enabled === undefined
    ? (Boolean(webhook && secret) || current.enabled === true)
    : input.enabled === true;
  if (enabled && (!webhook || !secret)) return { ok: false, error: "dingtalk_webhook_and_secret_required" };
  state.config.dingtalk = {
    enabled,
    webhook,
    secret,
    notifyCollectorError: input.notifyCollectorError === undefined ? current.notifyCollectorError !== false : input.notifyCollectorError === true,
    notifyAiSuggestion: input.notifyAiSuggestion === undefined ? current.notifyAiSuggestion !== false : input.notifyAiSuggestion === true,
    notifyActionResult: input.notifyActionResult === undefined ? current.notifyActionResult !== false : input.notifyActionResult === true,
    notifyHourlySummary: input.notifyHourlySummary === undefined ? current.notifyHourlySummary !== false : input.notifyHourlySummary === true,
    notifySystemAlert: input.notifySystemAlert === undefined ? current.notifySystemAlert !== false : input.notifySystemAlert === true,
  };
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  return { ok: true, config: publicDingTalkConfig(state.config) };
}

const DINGTALK_COLLECTOR_SUPPRESS_MS = 5 * 60 * 1000;
const DINGTALK_SYSTEM_ALERT_SUPPRESS_MS = 30 * 60 * 1000;
const dingtalkNoticeAt = new Map();
const dingtalkCollectorFailureCounts = new Map();
let dingtalkHourlySummaryHour = "";

function canSendDingTalk(state = {}, option = "") {
  const config = state.config?.dingtalk || {};
  return config.enabled === true && config[option] === true;
}

function safeDingTalkMarkdown(state, option, key, title, text, cooldownMs = 0) {
  if (!canSendDingTalk(state, option)) return false;
  const now = Date.now();
  const previous = Number(dingtalkNoticeAt.get(key) || 0);
  if (cooldownMs > 0 && now - previous < cooldownMs) return false;
  dingtalkNoticeAt.set(key, now);
  try {
    Promise.resolve(dingtalk.sendMarkdown(title, dingtalk.normalizeMessageText(text))).catch((error) => {
      console.error(`[dingtalk] markdown dispatch failed: ${error?.message || error}`);
    });
    return true;
  } catch (error) {
    console.error(`[dingtalk] markdown dispatch failed: ${error?.message || error}`);
    return false;
  }
}

function safeDingTalkText(state, option, key, content, cooldownMs = 0) {
  if (!canSendDingTalk(state, option)) return false;
  const now = Date.now();
  const previous = Number(dingtalkNoticeAt.get(key) || 0);
  if (cooldownMs > 0 && now - previous < cooldownMs) return false;
  dingtalkNoticeAt.set(key, now);
  try {
    Promise.resolve(dingtalk.sendText(dingtalk.normalizeMessageText(content))).catch((error) => {
      console.error(`[dingtalk] text dispatch failed: ${error?.message || error}`);
    });
    return true;
  } catch (error) {
    console.error(`[dingtalk] text dispatch failed: ${error?.message || error}`);
    return false;
  }
}

function actionNotificationLabel(type = "") {
  return {
    pause_task: "暂停任务",
    increase_task_budget: "加预算",
    decrease_task_budget: "降预算",
    extend_task_duration: "延长时长",
    adjust_task_budget_duration: "调整预算和时长",
    change_roi_target: "修改 ROI",
    end_task: "结束任务",
    create_boost_task: "新建追投",
    create_oneclick_task: "新建一键起量",
    raise_roi_target: "提高 ROI 目标",
    lower_roi_target: "降低 ROI 目标",
  }[type] || type || "未知动作";
}

function dingTalkReasonText(value, fallback = "--") {
  const text = dingtalk.normalizeMessageText(value || fallback).trim();
  return text || fallback;
}

function formatAiReasoningForDingTalk(value) {
  const text = dingTalkReasonText(value, "AI 已触发调控建议。");
  const withSections = text.replace(/(?:^|\s*)(当前盘况|主要问题|建议方向)[：:]\s*/g, "\n\n**$1：**\n");
  return withSections.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

function trackCollectorDingTalkOutcome(state, collector, label, ok, error = "") {
  if (ok) {
    dingtalkCollectorFailureCounts.delete(collector);
    return 0;
  }
  const failureCount = Number(dingtalkCollectorFailureCounts.get(collector) || 0) + 1;
  dingtalkCollectorFailureCounts.set(collector, failureCount);
  if (failureCount >= 2) {
    safeDingTalkMarkdown(
      state,
      "notifyCollectorError",
      `collector:${collector}`,
      `采集异常：${label}`,
      `<font color=#FF0000>采集异常告警</font>\n\n采集器：${label}\n\n连续失败：${failureCount} 次\n\n原因：${dingTalkReasonText(error, "unknown_error")}\n\n已保留主流程，等待下一轮自动重试。`,
      DINGTALK_COLLECTOR_SUPPRESS_MS,
    );
  }
  return failureCount;
}

function notifyAiSuggestion(state, result = {}, actions = [], receivedAt = Date.now()) {
  const rows = (actions.length ? actions : result.actions || []).map((action) => {
    const params = action.payload || action.params || {};
    const task = params.taskName || params.taskId || action.taskName || action.taskId || "全局策略";
    const reason = action.reason ? dingTalkReasonText(action.reason, "") : "";
    return [
      `- **${actionNotificationLabel(action.type)}**：${task}`,
      reason ? `  诊断：${reason}` : "",
    ].filter(Boolean).join("\n");
  });
  const verdict = result.decision === "act"
    ? `**需人工确认**\n已生成 ${actions.length} 条待审批建议`
    : "本次无需操作，继续观察";
  const text = [
    formatAiReasoningForDingTalk(result.reasoning),
    verdict,
    rows.length ? `**建议动作**\n\n${rows.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
  safeDingTalkMarkdown(state, "notifyAiSuggestion", `ai:${receivedAt}`, "千川 AI 调控建议", text);
}

function applyAiFailureGuard(state, result = {}, receivedAt = Date.now()) {
  const previous = state.aiFailureState || {};
  if (!result.error) {
    state.aiFailureState = { consecutiveFailures: 0, lastSuccessAt: receivedAt, lastError: "" };
    return false;
  }
  const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
  const disabled = consecutiveFailures >= 2 && state.config?.aiEnabled === true;
  state.aiFailureState = {
    consecutiveFailures,
    lastFailureAt: receivedAt,
    lastError: String(result.error),
    disabledAt: disabled ? receivedAt : previous.disabledAt || null,
  };
  if (disabled) {
    state.config.aiEnabled = false;
    writeWarning("ai_auto_disabled", { reason: "ai_decision_failures_exceeded", failedCount: consecutiveFailures });
    safeDingTalkMarkdown(
      state,
      "notifySystemAlert",
      "system:ai_disabled",
      "系统告警：AI 自动盯盘已关停",
      `<font color=#FF0000>系统告警</font>\n\nAI 连续 ${consecutiveFailures} 次决策失败，已自动关闭 AI 盯盘。\n\n最近错误：${dingTalkReasonText(result.error, "unknown_error")}\n\n请检查模型配置和网络后再手动开启。`,
      DINGTALK_SYSTEM_ALERT_SUPPRESS_MS,
    );
  }
  return disabled;
}

function notifyActionExecutionResult(state, action = {}, execution = {}) {
  const result = execution.execution || execution || {};
  const dryRun = result.dryRun === true;
  const ok = execution.ok === true || result.ok === true;
  const task = action.payload?.taskName || action.payload?.taskId || "--";
  const content = [
    "[千川执行结果]",
    `动作：${actionNotificationLabel(action.type)}`,
    `对象：${task}`,
    `结果：${dryRun ? (ok ? "dryRun 验证成功" : "dryRun 验证失败") : (ok ? "执行成功" : "执行失败")}`,
    `详情：${dingTalkReasonText(execution.error || result.error || action.reason || "--")}`,
  ].join("\n");
  safeDingTalkText(state, "notifyActionResult", `action:${action.id || Date.now()}`, content);
}

function shanghaiHourKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { key: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}`, hour: parts.hour, minute: parts.minute };
}

function boostRatioPercentText(value) {
  const ratio = num(value);
  if (!Number.isFinite(ratio)) return "--";
  const percent = ratio <= 1 ? ratio * 100 : ratio;
  return `${Math.round(percent * 100) / 100}%`;
}

function maybeSendDingTalkHourlySummary() {
  const now = shanghaiHourKey();
  if (now.minute !== "00" || now.key === dingtalkHourlySummaryHour) return false;
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  if (state.dingtalkNotificationStatus?.hourlySummaryHour === now.key) return false;
  const metrics = state.metrics || {};
  const pending = (state.actions || []).filter((action) => ["pending_review", "ready_to_execute"].includes(action.status)).length;
  const text = [
    "### 千川整点汇总",
    `时间：${now.key}:00（北京时间）`,
    `综合消耗：${moneyText(metrics.overallCost)} 元`,
    `综合 ROI：${ratioText(metrics.overallRoi)}`,
    `追投占比：${boostRatioPercentText(metrics.boostRatio)}`,
    `当前小时消耗：${moneyText(metrics.currentHourCost)} 元`,
    `当前小时 ROI：${ratioText(metrics.currentHourRoi)}`,
    `待审批动作：${pending} 条`,
  ].join("\n\n");
  const sent = safeDingTalkMarkdown(state, "notifyHourlySummary", `summary:${now.key}`, `千川整点汇总 ${now.hour}:00`, text);
  if (sent) {
    dingtalkHourlySummaryHour = now.key;
    state.dingtalkNotificationStatus = { ...(state.dingtalkNotificationStatus || {}), hourlySummaryHour: now.key, hourlySummaryAt: Date.now() };
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
  }
  return sent;
}

function notifySystemAlerts(state) {
  const boostRatio = num(state.metrics?.boostRatio ?? state.metrics?.boostShare);
  const boostPercent = Number.isFinite(boostRatio) ? (boostRatio <= 1 ? boostRatio * 100 : boostRatio) : null;
  if (Number.isFinite(boostPercent) && boostPercent >= 28) {
    safeDingTalkMarkdown(
      state,
      "notifySystemAlert",
      "system:boost_ratio_over_28",
      "系统告警：追投占比偏高",
      `<font color=#FF0000>系统告警</font>\n\n当前追投占比：${Math.round(boostPercent * 100) / 100}%\n\n告警阈值：28%\n\n请优先检查低效追投和一键起量任务，避免继续新增抢量。`,
      DINGTALK_SYSTEM_ALERT_SUPPRESS_MS,
    );
  }
}

let visualCaptureQueue = Promise.resolve();
let visualCollectRunning = false;
let taskCollectRunning = false;
let taskCollectPromise = null;
let boardCollectRunning = false;
let boardTrendCollectRunning = false;
let planCollectRunning = false;
let materialCollectRunning = false;
let unifiedSkillCollectRunning = false;
let unifiedSkillCollectRetryTimer = null;
const UNIFIED_SKILL_COLLECT_INTERVAL_MS = 5 * 60 * 1000;
const UNIFIED_SKILL_COLLECT_RETRY_MS = 60 * 1000;

function routeResultIssue(route = "overall", result = {}) {
  if (!result || result.status === "error" || result.error) return result?.error || "collect_error";
  if (result.status === "skipped") return "";
  if (route === "materialBoost" || route === "oneClickLift" || route === "control") {
    const count = Array.isArray(result.taskScan?.tasks) ? result.taskScan.tasks.length : 0;
    const pageErrors = (result.taskScan?.pages || result.pages || []).map((page) => page.error).filter(Boolean);
    if (pageErrors.length) return pageErrors[0];
    if (count <= 0) return `${route}_empty_tasks`;
  }
  if (route === "hourly") {
    const rows = Array.isArray(result.hourlyBreakdown?.rows) ? result.hourlyBreakdown.rows.length : 0;
    const current = result.hourlyBreakdown?.current;
    const hasCurrent = Boolean(current);
    if (!rows && !hasCurrent) return "hourly_empty";
    if (Number.isFinite(num(current?.cost)) && !Number.isFinite(num(current?.baseCost))) return "hourly_base_current_missing";
  }
  if (route === "overall") {
    const metrics = result.extractedMetrics || result.summary || {};
    const useful = ["overallCost", "overallRoi", "dealAmount", "baseSpend", "onlineCount", "totalViewers"]
      .some((key) => Number.isFinite(Number(metrics[key])));
    if (!useful) return "overall_empty_metrics";
  }
  return "";
}

function routeResultCount(route = "overall", result = {}) {
  if (route === "materialBoost" || route === "oneClickLift" || route === "control") {
    return Array.isArray(result.taskScan?.tasks) ? result.taskScan.tasks.length : 0;
  }
  if (route === "hourly") return Array.isArray(result.hourlyBreakdown?.rows) ? result.hourlyBreakdown.rows.length : 0;
  return Object.values(result.extractedMetrics || result.summary || {}).filter((value) => Number.isFinite(Number(value))).length;
}

function updateVisualRouteHealth(state, route = "overall", result = {}, options = {}) {
  if (!route) return;
  const now = result.capturedAt || result.collectedAt || Date.now();
  const issue = routeResultIssue(route, result);
  state.visualRouteHealth = state.visualRouteHealth || {};
  const previous = state.visualRouteHealth[route] || {};
  const failureCount = issue ? Number(previous.failureCount || 0) + 1 : 0;
  state.visualRouteHealth[route] = {
    ...previous,
    route,
    status: issue ? "warning" : "ok",
    lastAttemptAt: now,
    lastOkAt: issue ? previous.lastOkAt || null : now,
    lastIssueAt: issue ? now : previous.lastIssueAt || null,
    failureCount,
    lastIssue: issue || "",
    lastCount: routeResultCount(route, result),
    lastRefreshAt: options.refreshBeforeCollect ? now : previous.lastRefreshAt || null,
    lastRefreshReason: options.refreshBeforeCollect ? (options.watchdogReason || "manual_refresh_before_collect") : previous.lastRefreshReason || "",
    retry: options.watchdogRetry === true,
  };
  const integrityKey = route === "hourly" ? "hourly_collect" : `visual_${route}`;
  recordCollectionIntegrity(state, integrityKey, {
    label: route === "hourly" ? "小时明细" : `视觉/${route}`,
    source: "visual_capture",
    accepted: result.status === "ok" && result.ok !== false,
    partial: Boolean(issue),
    count: routeResultCount(route, result),
    reason: issue,
    at: now,
  });
  result.routeHealth = state.visualRouteHealth[route];
  trackCollectorDingTalkOutcome(state, `visual:${route}`, `视觉采集/${route}`, !issue, issue);
}

function shouldRefreshRouteBeforeCollect(state, route = "overall") {
  state.config = migrateConfig(state.config);
  if (state.config.aiAutoCollectRefreshOnStuck === false) return { refresh: false, reason: "" };
  const health = state.visualRouteHealth?.[route] || {};
  if (Number(health.failureCount || 0) >= 2) return { refresh: true, reason: health.lastIssue || "consecutive_collect_issue" };
  return { refresh: false, reason: "" };
}

async function runVisualCaptureForState(options = {}) {
  const run = () => runVisualCaptureForStateNow(options);
  const next = visualCaptureQueue.then(run, run);
  visualCaptureQueue = next.catch(() => null);
  return next;
}

async function runVisualCaptureForStateNow(options = {}) {
  visualCollectRunning = true;
  const state = readJson(STATE_FILE, {});
  try {
    state.config = migrateConfig(state.config);
    const lifecycleChanged = reconcileLiveLifecycleForNow(state);
    if (lifecycleChanged) writeJson(STATE_FILE, state);
    const blockedReason = options.autoCollect && options.force !== true ? autoCollectBlocked(state) : "";
    if (blockedReason) {
      const skipped = {
        status: "skipped",
        ok: true,
        capturedAt: Date.now(),
        route: options.route || "overall",
        mode: `auto_collect_${options.route || "overall"}`,
        pageType: options.route === "overall" || !options.route ? "autoCollect" : `${options.route}Collect`,
        title: "自动采集已停用",
        reason: blockedReason,
        liveLifecycle: state.liveLifecycle || null,
      };
      state.visualCapture = skipped;
      state.updatedAt = new Date().toISOString();
      writeJson(STATE_FILE, state);
      return skipped;
    }
    state.visualCapture = { ...(state.visualCapture || {}), status: "running", startedAt: Date.now(), error: null };
    writeJson(STATE_FILE, state);
    try {
      const result = await runVisualCapture({
        dataDir: DATA_DIR,
        cdpUrl: state.config.cdpUrl,
        accountId: state.config.expectedAccountId,
        expectedAccountId: state.config.expectedAccountId,
        ...options,
      });
      const latestState = readJson(STATE_FILE, state);
      latestState.config = migrateConfig(latestState.config);
      latestState.actions = Array.isArray(latestState.actions) ? latestState.actions : [];
      latestState.lastActionAt = latestState.lastActionAt || {};
      latestState.visualCapture = { ...result, status: "ok" };
      latestState.visualCapture.metricsUpdated = mergeVisualCaptureIntoState(latestState, latestState.visualCapture);
      updateVisualRouteHealth(latestState, latestState.visualCapture.route || options.route || "overall", latestState.visualCapture, options);
      appendJsonl(VISUAL_LOG_FILE, latestState.visualCapture);
      latestState.updatedAt = new Date().toISOString();
      writeJson(STATE_FILE, latestState);
      return latestState.visualCapture;
    } catch (error) {
      const latestState = readJson(STATE_FILE, state);
      latestState.config = migrateConfig(latestState.config);
      latestState.visualCapture = { status: "error", capturedAt: Date.now(), error: error.message, mode: options.autoCollect ? "auto_collect" : "read_only" };
      updateVisualRouteHealth(latestState, options.route || "overall", latestState.visualCapture, options);
      appendJsonl(VISUAL_LOG_FILE, latestState.visualCapture);
      latestState.updatedAt = new Date().toISOString();
      writeJson(STATE_FILE, latestState);
      return latestState.visualCapture;
    }
  } finally {
    visualCollectRunning = false;
  }
}

async function runVisualCollectRoute(route, options = {}) {
  return runVisualCaptureForState({ autoCollect: true, route, ...options });
}

function taskCollectStatusFromState() {
  const state = readJson(STATE_FILE, {});
  return state.taskCollectStatus || defaultTaskCollectStatus();
}

function simpleCollectStatusFromState(key) {
  const state = readJson(STATE_FILE, {});
  return state[key] || { running: false, startedAt: null, finishedAt: null, status: "idle", lastError: "", metrics: {} };
}

function materialCollectStatusFromState() {
  const state = readJson(STATE_FILE, {});
  return state.materialCollectStatus || { running: false, startedAt: null, finishedAt: null, status: "idle", lastError: "", total: Array.isArray(state.materialLibrary) ? state.materialLibrary.length : 0 };
}

function writeSimpleCollectStatus(key, patch = {}) {
  const state = readJson(STATE_FILE, {});
  state[key] = { ...(state[key] || {}), ...patch, updatedAt: Date.now() };
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  return state[key];
}

async function runBoardCollectForState(options = {}) {
  if (boardCollectRunning) return { ok: false, error: "already_running", boardCollectStatus: simpleCollectStatusFromState("boardCollectStatus") };
  if ((visualCollectRunning || taskCollectRunning || planCollectRunning || boardTrendCollectRunning || materialCollectRunning) && !options.fromUnifiedScheduler) {
    return { ok: false, error: options.scheduled ? "collect_busy" : "collect_busy", skipped: Boolean(options.scheduled) };
  }
  boardCollectRunning = true;
  const startedAt = Date.now();
  writeSimpleCollectStatus("boardCollectStatus", { running: true, status: "running", startedAt, finishedAt: null, lastError: "" });
  try {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    const result = await runBoardCollector({
      cdpUrl: state.config.cdpUrl,
      accountId: state.config.expectedAccountId,
    });
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    let metricsUpdated = false;
    if (result.ok) metricsUpdated = mergeBoardCollectIntoState(latest, result);
    latest.boardCollectStatus = {
      ...(latest.boardCollectStatus || {}),
      running: false,
      status: result.ok ? "ok" : (result.status || "error"),
      startedAt,
      finishedAt: result.finishedAt || Date.now(),
      lastError: result.ok ? "" : (result.error || "board_collect_failed"),
      metrics: result.metrics || {},
      page: result.page || null,
      reloaded: result.reloaded === true,
    };
    latest.boardCollectResult = { ...result, metricsUpdated };
    recordCollectionIntegrity(latest, "board_collect", {
      label: "直播大屏",
      source: "board_collector",
      accepted: result.ok === true,
      count: Object.keys(result.metrics || {}).length,
      reason: result.error || result.status,
      at: result.finishedAt || Date.now(),
    });
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    trackCollectorDingTalkOutcome(latest, "board_collect", "直播大屏", result.ok || result.skipped, result.error || result.status);
    if (!result.ok) writeWarning("board_collect_warning", { error: result.error || "board_collect_failed" });
    return { ...result, metricsUpdated };
  } finally {
    boardCollectRunning = false;
  }
}

async function runBoardTrendCollectForState(options = {}) {
  if (boardTrendCollectRunning) return { ok: false, error: "already_running", boardTrendCollectStatus: simpleCollectStatusFromState("boardTrendCollectStatus") };
  if ((visualCollectRunning || taskCollectRunning || planCollectRunning || boardCollectRunning || materialCollectRunning) && !options.fromUnifiedScheduler) {
    return { ok: false, error: options.scheduled ? "collect_busy" : "collect_busy", skipped: Boolean(options.scheduled) };
  }
  boardTrendCollectRunning = true;
  const startedAt = Date.now();
  writeSimpleCollectStatus("boardTrendCollectStatus", {
    running: true,
    status: "running",
    startedAt,
    finishedAt: null,
    lastError: "",
    granularity: Number(options.granularity || 5),
  });
  try {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    const result = await runBoardTrendCollector({
      cdpUrl: state.config.cdpUrl,
      accountId: state.config.expectedAccountId,
      granularity: options.granularity,
    });
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    let metricsUpdated = false;
    if (result.ok) metricsUpdated = mergeBoardTrendCollectIntoState(latest, result);
    latest.boardTrendCollectStatus = {
      ...(latest.boardTrendCollectStatus || {}),
      running: false,
      status: result.ok ? "ok" : (result.status || "error"),
      startedAt,
      finishedAt: result.finishedAt || Date.now(),
      updatedAt: result.finishedAt || Date.now(),
      lastError: result.ok ? "" : (result.error || "board_trend_collect_failed"),
      granularity: Number(result.granularity || options.granularity || 5),
      pointCount: Array.isArray(result.points) ? result.points.length : 0,
      page: result.page || null,
      reloaded: result.reloaded === true,
    };
    latest.boardTrendCollectResult = { ...result, metricsUpdated };
    recordCollectionIntegrity(latest, "board_trend", {
      label: "直播趋势",
      source: "board_trend_collector",
      accepted: result.ok === true,
      count: Array.isArray(result.points) ? result.points.length : 0,
      reason: result.error || result.status,
      at: result.finishedAt || Date.now(),
    });
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    trackCollectorDingTalkOutcome(latest, "board_trend", "直播趋势", result.ok || result.skipped, result.error || result.status);
    if (!result.ok) writeWarning("board_trend_collect_warning", { error: result.error || "board_trend_collect_failed" });
    return { ...result, metricsUpdated };
  } finally {
    boardTrendCollectRunning = false;
  }
}

async function runPlanCollectForState(options = {}) {
  if (planCollectRunning) return { ok: false, error: "already_running", planCollectStatus: simpleCollectStatusFromState("planCollectStatus") };
  if ((visualCollectRunning || taskCollectRunning || boardCollectRunning || boardTrendCollectRunning || materialCollectRunning) && !options.fromUnifiedScheduler) {
    return { ok: false, error: options.scheduled ? "collect_busy" : "collect_busy", skipped: Boolean(options.scheduled) };
  }
  planCollectRunning = true;
  const startedAt = Date.now();
  writeSimpleCollectStatus("planCollectStatus", { running: true, status: "running", startedAt, finishedAt: null, lastError: "" });
  try {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    const result = await runPlanCollector({
      cdpUrl: state.config.cdpUrl,
      accountId: state.config.expectedAccountId,
    });
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    let metricsUpdated = false;
    if (result.ok) metricsUpdated = mergePlanCollectIntoState(latest, result);
    latest.planCollectStatus = {
      ...(latest.planCollectStatus || {}),
      running: false,
      status: result.ok ? "ok" : (result.status || "error"),
      startedAt,
      finishedAt: result.finishedAt || Date.now(),
      lastError: result.ok ? "" : (result.error || "plan_collect_failed"),
      metrics: result.metrics || {},
      page: result.page || null,
      reloaded: result.reloaded === true,
    };
    latest.planCollectResult = { ...result, metricsUpdated };
    const planBaseSpend = num(result.metrics?.baseSpend);
    recordCollectionIntegrity(latest, "plan_collect", {
      label: "计划表",
      source: "plan_collector",
      accepted: result.ok === true,
      partial: result.ok === true && !Number.isFinite(planBaseSpend),
      count: Object.keys(result.metrics || {}).length,
      reason: result.ok && !Number.isFinite(planBaseSpend) ? "plan_base_spend_missing" : (result.error || result.status),
      at: result.finishedAt || Date.now(),
    });
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    trackCollectorDingTalkOutcome(latest, "plan_collect", "计划表", result.ok || result.skipped, result.error || result.status);
    if (!result.ok) writeWarning("plan_collect_warning", { error: result.error || "plan_collect_failed" });
    return { ...result, metricsUpdated };
  } finally {
    planCollectRunning = false;
  }
}

function mergeMaterialLibraryIntoState(state, result = {}) {
  if (!result.ok) return false;
  const materials = Array.isArray(result.materials) ? result.materials : [];
  state.materialLibrary = materials;
  state.materialLibraryMeta = {
    ...(result.meta || {}),
    status: "ok",
    total: materials.length,
    updatedAt: result.finishedAt || Date.now(),
    warnings: result.warnings || [],
  };
  return true;
}

async function runMaterialCollectForState(options = {}) {
  if (materialCollectRunning) return { ok: false, error: "already_running", materialCollectStatus: materialCollectStatusFromState() };
  if ((visualCollectRunning || taskCollectRunning || boardCollectRunning || boardTrendCollectRunning || planCollectRunning) && !options.fromUnifiedScheduler) {
    return { ok: false, error: options.scheduled ? "collect_busy" : "collect_busy", skipped: Boolean(options.scheduled) };
  }
  materialCollectRunning = true;
  const startedAt = Date.now();
  writeSimpleCollectStatus("materialCollectStatus", { running: true, status: "running", startedAt, finishedAt: null, lastError: "", total: 0 });
  try {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    const result = await runMaterialCollector({
      cdpUrl: state.config.cdpUrl,
      accountId: state.config.expectedAccountId,
      maxPages: options.maxPages,
    });
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    const libraryUpdated = mergeMaterialLibraryIntoState(latest, result);
    latest.materialCollectStatus = {
      ...(latest.materialCollectStatus || {}),
      running: false,
      status: result.ok ? "ok" : (result.status || "error"),
      startedAt,
      finishedAt: result.finishedAt || Date.now(),
      lastError: result.ok ? "" : (result.error || "material_collect_failed"),
      total: result.total || (Array.isArray(latest.materialLibrary) ? latest.materialLibrary.length : 0),
      pageCount: Array.isArray(result.pages) ? result.pages.length : 0,
      warnings: result.warnings || [],
      meta: result.meta || null,
    };
    latest.materialCollectResult = {
      ok: result.ok,
      status: result.status,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      total: result.total || 0,
      pageCount: Array.isArray(result.pages) ? result.pages.length : 0,
      warnings: result.warnings || [],
      pages: result.pages || [],
      libraryUpdated,
    };
    recordCollectionIntegrity(latest, "material_collect", {
      label: "素材库",
      source: "material_collector",
      accepted: result.ok === true && libraryUpdated,
      partial: result.ok === true && Array.isArray(result.warnings) && result.warnings.length > 0,
      count: result.total || (Array.isArray(latest.materialLibrary) ? latest.materialLibrary.length : 0),
      reason: result.error || result.status,
      warnings: result.warnings || [],
      at: result.finishedAt || Date.now(),
    });
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    trackCollectorDingTalkOutcome(latest, "material_collect", "素材库", result.ok || result.skipped, result.error || result.status);
    if (!result.ok) writeWarning("material_collect_warning", { error: result.error || "material_collect_failed" });
    return { ...result, materials: undefined, libraryUpdated };
  } finally {
    materialCollectRunning = false;
  }
}

function shouldRunMaterialCollect(state = {}, now = Date.now()) {
  state.config = migrateConfig(state.config);
  const interval = Number(state.config.materialCollectIntervalMs || DEFAULT_CONFIG.materialCollectIntervalMs);
  const lastOk = Number(state.materialCollectStatus?.finishedAt || state.materialLibraryMeta?.updatedAt || 0);
  return !lastOk || now - lastOk >= interval;
}

function healthAgoMs(ts, now = Date.now()) {
  const parsed = Number(ts || 0);
  return Number.isFinite(parsed) && parsed > 0 ? now - parsed : Infinity;
}

function collectStatusTime(status = {}) {
  return Number(status.finishedAt || status.lastOkAt || status.updatedAt || status.receivedAt || 0);
}

function collectorHealthItem({
  name,
  label,
  status = {},
  integrity = null,
  warnAfterMs,
  errorAfterMs,
  count = null,
  message = "",
}, now = Date.now()) {
  const lastAt = Number(integrity?.lastAcceptedAt || 0) || collectStatusTime(status);
  const ageMs = healthAgoMs(lastAt, now);
  const running = status.running === true;
  let level = "ok";
  let reason = message || "";
  const rawStatus = String(status.status || "");
  if (running) {
    level = "ok";
    reason = "running";
  } else if (integrity?.status === "failed") {
    level = "error";
    reason = integrity.lastIssue || "collect_failed";
  } else if (integrity?.status === "partial") {
    level = "warn";
    reason = integrity.lastIssue || "partial_result";
  } else if (["error", "failed"].includes(rawStatus) || status.lastError) {
    level = "error";
    reason = status.lastError || rawStatus || "collect_failed";
  } else if (!Number.isFinite(ageMs)) {
    level = "warn";
    reason = "never_collected";
  } else if (ageMs > errorAfterMs) {
    level = "error";
    reason = `stale_${Math.round(ageMs / 60000)}m`;
  } else if (ageMs > warnAfterMs) {
    level = "warn";
    reason = `stale_${Math.round(ageMs / 60000)}m`;
  } else if (Array.isArray(status.warnings) && status.warnings.length) {
    level = "warn";
    reason = status.warnings[0];
  }
  return {
    name,
    label,
    level,
    status: rawStatus || (running ? "running" : "idle"),
    running,
    lastAt: Number.isFinite(ageMs) ? lastAt : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    count,
    integrityStatus: integrity?.status || "unknown",
    failureCount: Number(integrity?.failureCount || 0),
    reason,
    unhealthy: level !== "ok",
  };
}

async function inspectCdpTabs(state = {}) {
  const { listTabs, DEFAULT_CDP_URL } = require("./executor/cdp-client");
  const cdpUrl = state.config?.cdpUrl || DEFAULT_CDP_URL;
  try {
    const tabs = await listTabs(cdpUrl);
    const pages = tabs.filter((tab) => tab.type === "page");
    const qianchuan = pages.filter((tab) => String(tab.url || "").includes("qianchuan.jinritemai.com"));
    const hasDetail = qianchuan.some((tab) => String(tab.url || "").includes("/uni-prom/detail"));
    const hasOverall = qianchuan.some((tab) => String(tab.url || "").includes("/uni-prom/overall"));
    const hasLive = qianchuan.some((tab) => String(tab.url || "").includes("/board-next"));
    const missing = [
      hasDetail ? "" : "detail",
      hasOverall ? "" : "overall",
      hasLive ? "" : "liveScreen",
    ].filter(Boolean);
    return {
      level: missing.length ? "warn" : "ok",
      cdpUrl,
      totalTabs: pages.length,
      qianchuanTabs: qianchuan.length,
      missing,
      message: missing.length ? `缺少采集页：${missing.join(", ")}` : "CDP 标签页完整",
    };
  } catch (error) {
    return {
      level: "error",
      cdpUrl,
      totalTabs: 0,
      qianchuanTabs: 0,
      missing: ["cdp"],
      message: `CDP 不可用：${error.message}`,
    };
  }
}

function metricHealthItems(state = {}, now = Date.now()) {
  const metrics = state.metrics || {};
  const config = migrateConfig(state.config || {});
  const targetRoi = Number(config.targetRoi || DEFAULT_CONFIG.targetRoi);
  const boostLimit = Number(config.investmentSop?.boostRatioLimit || 30);
  const currentHourRoi = num(metrics.currentHourRoi ?? state.hourlyBreakdown?.current?.roi);
  const overallRoi = num(metrics.overallRoi);
  const boostRatio = num(metrics.boostRatio ?? metrics.boostShare);
  const items = [];

  if (Number.isFinite(currentHourRoi) && Number.isFinite(targetRoi)) {
    const roiLine = currentHourRoi < targetRoi * 0.5 ? "error" : currentHourRoi < targetRoi * 0.8 ? "warn" : "ok";
    items.push({
      name: "roi_drop",
      label: "ROI突降",
      level: roiLine,
      value: currentHourRoi,
      target: targetRoi,
      reason: roiLine === "ok" ? "" : `单小时 ROI ${currentHourRoi} 低于目标 ${targetRoi}`,
      unhealthy: roiLine !== "ok",
    });
  } else {
    items.push({ name: "roi_drop", label: "ROI突降", level: "warn", value: null, target: targetRoi, reason: "单小时 ROI 缺失", unhealthy: true });
  }

  if (Number.isFinite(boostRatio)) {
    const boostPercent = boostRatio <= 1 ? boostRatio * 100 : boostRatio;
    const level = boostPercent >= boostLimit ? "error" : boostPercent >= boostLimit * 0.9 ? "warn" : "ok";
    items.push({
      name: "boost_over_limit",
      label: "追投占比",
      level,
      value: Math.round(boostPercent * 100) / 100,
      target: boostLimit,
      reason: level === "ok"
        ? ""
        : level === "warn"
          ? `追投占比 ${Math.round(boostPercent * 100) / 100}% 接近阈值 ${boostLimit}%`
          : `追投占比 ${Math.round(boostPercent * 100) / 100}% 超过阈值 ${boostLimit}%`,
      unhealthy: level !== "ok",
    });
  } else {
    items.push({ name: "boost_over_limit", label: "追投超标", level: "warn", value: null, target: boostLimit, reason: "追投占比缺失", unhealthy: true });
  }

  if (Number.isFinite(overallRoi) && Number.isFinite(targetRoi)) {
    const level = overallRoi < targetRoi * 0.6 ? "warn" : "ok";
    items.push({
      name: "overall_roi_watch",
      label: "综合ROI",
      level,
      value: overallRoi,
      target: targetRoi,
      reason: level === "ok" ? "" : `综合 ROI ${overallRoi} 明显低于目标 ${targetRoi}`,
      unhealthy: level !== "ok",
    });
  }
  return items;
}

async function buildHealthCheck(state = readJson(STATE_FILE, {})) {
  const now = Date.now();
  state.config = migrateConfig(state.config);
  const visualRoutes = state.visualRouteHealth || {};
  const materialTotal = Array.isArray(state.materialLibrary) ? state.materialLibrary.length : Number(state.materialCollectStatus?.total || 0);
  const taskTotal = Array.isArray(state.metrics?.tasks) ? state.metrics.tasks.length : Number(state.taskSource?.total || 0);
  const quality = (key) => integrityFor(state, key, now);
  const collectors = [
    collectorHealthItem({ name: "board_collect", label: "大屏", status: state.boardCollectStatus || {}, integrity: quality("board_collect"), warnAfterMs: 10 * 60 * 1000, errorAfterMs: 20 * 60 * 1000, count: Number(state.boardCollectStatus?.metrics ? Object.keys(state.boardCollectStatus.metrics).length : 0) }, now),
    collectorHealthItem({ name: "board_trend", label: "趋势", status: state.boardTrendCollectStatus || {}, integrity: quality("board_trend"), warnAfterMs: 10 * 60 * 1000, errorAfterMs: 20 * 60 * 1000, count: Number(state.boardTrendCollectStatus?.pointCount || state.boardTrend?.points?.length || 0) }, now),
    collectorHealthItem({ name: "plan_collect", label: "计划", status: state.planCollectStatus || {}, integrity: quality("plan_collect"), warnAfterMs: 15 * 60 * 1000, errorAfterMs: 30 * 60 * 1000, count: Number(state.planCollectStatus?.metrics ? Object.keys(state.planCollectStatus.metrics).length : 0) }, now),
    collectorHealthItem({ name: "hourly_collect", label: "小时", status: visualRoutes.hourly || {}, integrity: quality("hourly_collect"), warnAfterMs: 10 * 60 * 1000, errorAfterMs: 20 * 60 * 1000, count: Number(state.hourlyBreakdown?.rows?.length || visualRoutes.hourly?.lastCount || 0) }, now),
    collectorHealthItem({ name: "task_collect", label: "任务", status: state.taskCollectStatus || {}, integrity: quality("task_collect"), warnAfterMs: 10 * 60 * 1000, errorAfterMs: 20 * 60 * 1000, count: taskTotal }, now),
    collectorHealthItem({ name: "material_collect", label: "素材", status: state.materialCollectStatus || {}, integrity: quality("material_collect"), warnAfterMs: 30 * 60 * 1000, errorAfterMs: 90 * 60 * 1000, count: materialTotal }, now),
  ];
  const metrics = metricHealthItems(state, now);
  const tabs = await inspectCdpTabs(state);
  const engineering = summarizeEngineeringHealth(collectors, tabs);
  return {
    ok: true,
    level: engineering.level,
    score: engineering.score,
    checkedAt: now,
    collectors,
    metrics,
    businessAlerts: metrics.filter((item) => item.level !== "ok"),
    tabs,
    unhealthyCollectors: collectors.filter((item) => item.unhealthy),
    unhealthyMetrics: metrics.filter((item) => item.unhealthy),
    alerts: engineering.alerts,
    issues: engineering.issues,
    summary: engineering.summary,
  };
}

function updateHealthHistoryForHealthyItems(state = {}, health = {}) {
  state.healthFixHistory = state.healthFixHistory || {};
  [...(health.collectors || []), ...(health.metrics || [])].forEach((item) => {
    if (item.level !== "ok") return;
    const previous = state.healthFixHistory[item.name] || {};
    state.healthFixHistory[item.name] = {
      ...previous,
      fixCount: 0,
      lastOkAt: Date.now(),
      lastIssue: "",
    };
  });
}

function dedupeHealthAlerts(alerts = []) {
  const seen = new Set();
  return alerts.filter((alert) => {
    const key = `${alert.level || ""}:${alert.name || ""}:${alert.msg || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startHealthFix(name, runner) {
  Promise.resolve()
    .then(runner)
    .catch((error) => writeWarning("health_auto_fix_failed", { name, error: error.message }));
}

async function runInitializeCollectorTabs() {
  const { openTab, listTabs, DEFAULT_CDP_URL } = require("./executor/cdp-client");
  const currentState = readJson(STATE_FILE, {});
  currentState.config = migrateConfig(currentState.config);
  const cdpUrl = currentState.config?.cdpUrl || DEFAULT_CDP_URL;
  const accountId = currentState.config?.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  const adContext = findAdContextFromState(currentState);
  const recoveredLiveContext = findLiveContextFromState(currentState, accountId);
  const taskCenterUrl = adContext.sourceUrl
    ? taskCenterUrlFromSource(adContext.sourceUrl, accountId) || buildTaskCenterUrl(accountId, adContext)
    : buildTaskCenterUrl(accountId, adContext);
  let liveRoomId = recoveredLiveContext.liveRoomId || null;
  let anchorId = recoveredLiveContext.anchorId || null;
  let liveScreenUrl = buildLiveScreenUrl(accountId, recoveredLiveContext);
  let tabs = [];

  tabs = await listTabs(cdpUrl);
  for (const tab of tabs) {
    const tabUrl = String(tab.url || "");
    if (!tabUrl.includes("qianchuan.jinritemai.com")) continue;
    const rid = tabUrl.match(/live_room_id=(\d+)/);
    if (rid) {
      liveRoomId = rid[1];
      liveScreenUrl = tabUrl;
    }
    const aid = tabUrl.match(/anchorId=(\d+)/);
    if (aid) anchorId = aid[1];
    if (liveRoomId) break;
  }

  const targets = [
    {
      pageType: "investOverview",
      label: "投放管理总览",
      url: `https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${encodeURIComponent(accountId)}`,
      urlMatch: (value) => value.includes("/uni-prom/overall"),
    },
    {
      pageType: "controlTable",
      label: "任务中心",
      url: taskCenterUrl,
      urlMatch: (value) => value.includes("/uni-prom/detail") && (!adContext.adId || hasAdContext(value, adContext.adId)),
    },
  ];

  if (liveRoomId) {
    if (!liveScreenUrl) liveScreenUrl = buildLiveScreenUrl(accountId, { liveRoomId, anchorId });
    targets.push({
      pageType: "liveScreen",
      label: "直播大屏",
      url: liveScreenUrl,
      urlMatch: (value) => value.includes("/board-next"),
    });
  } else {
    targets.push({
      pageType: "liveScreen",
      label: "直播大屏",
      url: null,
      urlMatch: (value) => value.includes("/board-next"),
      skipReason: "no_live_room_id",
    });
  }

  let existingTabs = tabs;
  try {
    existingTabs = await listTabs(cdpUrl);
  } catch {
    existingTabs = tabs;
  }

  const results = [];
  for (const target of targets) {
    if (target.skipReason) {
      results.push({ pageType: target.pageType, label: target.label, status: "skip", reason: target.skipReason });
      continue;
    }
    const already = existingTabs.find((tab) => tab.type === "page" && target.urlMatch(String(tab.url || "")));
    if (already) {
      results.push({ pageType: target.pageType, label: target.label, status: "exists", url: already.url });
      continue;
    }
    try {
      const opened = await openTab(cdpUrl, target.url);
      results.push({ pageType: target.pageType, label: target.label, status: "opened", url: opened.url || target.url });
    } catch (error) {
      results.push({ pageType: target.pageType, label: target.label, status: "error", error: error.message });
    }
  }
  return { ok: results.every((item) => item.status !== "error"), results, cdpUrl };
}

const initializeCollectorTabsSingleFlight = createSingleFlight();

function initializeCollectorTabs() {
  return initializeCollectorTabsSingleFlight(runInitializeCollectorTabs);
}

async function runHealthAutoFix() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  const health = await buildHealthCheck(state);
  const now = Date.now();
  const fixed = [];
  const skipped = [];
  const alerts = [...(health.alerts || [])];
  state.healthFixHistory = state.healthFixHistory || {};
  updateHealthHistoryForHealthyItems(state, health);

  const runners = {
    board_collect: () => runBoardCollectForState({ fromUnifiedScheduler: true, scheduled: true }),
    board_trend: () => runBoardTrendCollectForState({ fromUnifiedScheduler: true, scheduled: true, granularity: 5 }),
    plan_collect: () => runPlanCollectForState({ fromUnifiedScheduler: true, scheduled: true }),
    hourly_collect: () => runVisualCollectRoute("hourly", { force: true, openMissingTabs: true, fromUnifiedScheduler: true }),
    task_collect: () => runTaskCollectForState({ fromUnifiedScheduler: true, scheduled: true }),
    material_collect: () => runMaterialCollectForState({ fromUnifiedScheduler: true, scheduled: true }),
  };

  const attemptFix = (name, label, runner) => {
    const previous = state.healthFixHistory[name] || {};
    const fixCount = Number(previous.fixCount || 0);
    if (fixCount >= HEALTH_SILENT_FIX_LIMIT) {
      const msg = `${label}连续 ${fixCount} 次异常，需手动排查`;
      skipped.push({ name, reason: "silent_fix_limit" });
      alerts.push({ level: "error", name, msg });
      return;
    }
    if (previous.lastFixAt && now - Number(previous.lastFixAt) < HEALTH_FIX_COOLDOWN_MS) {
      skipped.push({ name, reason: "cooldown_1h" });
      alerts.push({ level: "error", name, msg: `${label}仍异常且 1 小时内已自动修复过，需手动排查` });
      return;
    }
    state.healthFixHistory[name] = {
      ...previous,
      lastFixAt: now,
      fixCount: fixCount + 1,
      lastIssueAt: now,
      lastIssue: label,
    };
    fixed.push(`${name}_restarted`);
    startHealthFix(name, runner);
  };

  if (health.tabs?.level !== "ok") {
    const previous = state.healthFixHistory.tabs_init || {};
    if (previous.lastFixAt && now - Number(previous.lastFixAt) < HEALTH_FIX_COOLDOWN_MS) {
      skipped.push({ name: "tabs_init", reason: "cooldown_1h" });
      alerts.push({ level: "error", name: "tabs_init", msg: "采集页仍缺失且 1 小时内已初始化过，需手动排查 CDP Chrome" });
    } else {
      state.healthFixHistory.tabs_init = { ...previous, lastFixAt: now, fixCount: Number(previous.fixCount || 0) + 1, lastIssueAt: now, lastIssue: health.tabs.message };
      fixed.push("tabs_reinitialized");
      startHealthFix("tabs_init", initializeCollectorTabs);
    }
  }

  for (const item of health.unhealthyCollectors || []) {
    if (item.running) continue;
    const runner = runners[item.name];
    if (!runner) continue;
    attemptFix(item.name, item.label, runner);
  }

  for (const item of health.unhealthyMetrics || []) {
    const previous = state.healthFixHistory[item.name] || {};
    const nextCount = Number(previous.fixCount || 0) + 1;
    state.healthFixHistory[item.name] = {
      ...previous,
      fixCount: nextCount,
      lastIssueAt: now,
      lastIssue: item.reason,
    };
  }

  state.healthMonitorStatus = {
    checkedAt: now,
    level: health.level,
    score: health.score,
    fixed,
    skipped,
    alerts: dedupeHealthAlerts(alerts),
    businessAlerts: health.businessAlerts || [],
  };
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  notifySystemAlerts(state);
  return {
    ok: true,
    checkedAt: now,
    fixed,
    skipped,
    alerts: state.healthMonitorStatus.alerts,
    health,
  };
}

async function runTaskCollectForState(options = {}) {
  if (taskCollectRunning) return { ok: false, error: "already_running", taskCollectStatus: taskCollectStatusFromState() };
  if ((visualCollectRunning || boardCollectRunning || boardTrendCollectRunning || planCollectRunning || materialCollectRunning) && !options.fromUnifiedScheduler) return { ok: false, error: options.scheduled ? "visual_collect_running" : "collect_busy", skipped: Boolean(options.scheduled) };
  taskCollectRunning = true;
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  const previousTasks = Array.isArray(state.operationLearning?.lastTasks) ? state.operationLearning.lastTasks : [];
  taskCollectPromise = runTaskCollector({
    stateFile: STATE_FILE,
    logFile: LOG_FILE,
    cdpUrl: state.config.cdpUrl,
    accountId: state.config.expectedAccountId,
    maxTasks: options.maxTasks,
  }).then((result) => {
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    if (result.ok) {
      const observedAt = result.finishedAt || Date.now();
      const currentTasks = Array.isArray(latest.metrics?.tasks) ? latest.metrics.tasks : [];
      const operations = detectManualOperations(previousTasks, currentTasks, {
        observedAt,
        overallRoi: latest.metrics?.overallRoi,
        boostRatio: latest.metrics?.boostRatio,
        onlineCount: latest.metrics?.onlineCount,
        targetRoi: latest.config?.targetRoi,
      });
      const priorOperations = Array.isArray(latest.operationLearning?.recentOperations) ? latest.operationLearning.recentOperations : [];
      latest.operationLearning = {
        version: 1,
        initializedAt: latest.operationLearning?.initializedAt || observedAt,
        lastComparedAt: observedAt,
        lastTasks: snapshotTasks(currentTasks),
        recentOperations: [...priorOperations, ...operations].slice(-50),
      };
      operations.forEach((operation, index) => appendJsonl(LOG_FILE, {
        id: `${observedAt}-user-operation-${index}`,
        receivedAt: observedAt,
        type: "user_manual_operation",
        operation,
      }));
    }
    trackCollectorDingTalkOutcome(latest, "task_collect", "调控任务", result.ok || result.skipped, result.error || result.status);
    latest.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, latest);
    return result;
  }).catch((error) => {
    const latest = readJson(STATE_FILE, state);
    latest.config = migrateConfig(latest.config);
    trackCollectorDingTalkOutcome(latest, "task_collect", "调控任务", false, error.message || "task_collect_failed");
    throw error;
  }).finally(() => {
    taskCollectRunning = false;
    taskCollectPromise = null;
  });
  return taskCollectPromise;
}

function stopTaskCollectForState() {
  return stopTaskCollector({ stateFile: STATE_FILE });
}

function send(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png" };
  fs.readFile(filePath, (error, content) => {
    if (error) return send(res, 404, { ok: false, error: "file not found" });
    res.writeHead(200, { "content-type": types[ext] || "text/plain; charset=utf-8" });
    res.end(content);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
  });
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if ((url.pathname === "/" || url.pathname === "/preview.html") && req.method === "GET") return sendFile(res, path.join(PUBLIC_DIR, "preview.html"));
  if (url.pathname.startsWith("/assets/") && req.method === "GET") {
    const filePath = path.join(PUBLIC_DIR, url.pathname.replace("/assets/", ""));
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { ok: false, error: "forbidden" });
    return sendFile(res, filePath);
  }
  if (url.pathname.startsWith("/visual/") && req.method === "GET") {
    const filePath = path.join(DATA_DIR, url.pathname);
    if (!filePath.startsWith(path.join(DATA_DIR, "visual"))) return send(res, 403, { ok: false, error: "forbidden" });
    return sendFile(res, filePath);
  }
  if (url.pathname.startsWith("/execution/") && req.method === "GET") {
    const filePath = path.join(DATA_DIR, url.pathname);
    if (!filePath.startsWith(path.join(DATA_DIR, "execution"))) return send(res, 403, { ok: false, error: "forbidden" });
    return sendFile(res, filePath);
  }
  if (url.pathname.startsWith("/reviews/") && req.method === "GET") {
    const filePath = path.join(DATA_DIR, url.pathname);
    if (!filePath.startsWith(path.join(DATA_DIR, "reviews"))) return send(res, 403, { ok: false, error: "forbidden" });
    return sendFile(res, filePath);
  }

  if (url.pathname === "/api/snapshot.php" && req.method === "POST") {
    const body = await readBody(req);
    if (!body.pageType || body.fields === undefined) return send(res, 400, { ok: false, error: "missing pageType or fields" });
    const result = await updateState(body);
    if (result.rejected) return send(res, 200, { ok: false, error: result.error, received: result.received });
    return send(res, 200, { ok: true, fiveMinSpend: result.ruleResult.fiveMinSpend, actions: pendingAiActions(result.state) });
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    const config = updateConfigPatch(await readBody(req));
    return send(res, 200, { ok: true, config: publicConfig(config) });
  }

  if (url.pathname === "/api/config" && req.method === "GET") {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    return send(res, 200, { ok: true, config: publicConfig(state.config) });
  }

  if (url.pathname === "/api/dingtalk/config" && req.method === "GET") {
    return send(res, 200, { ok: true, config: readDingTalkConfigForApi() });
  }

  if (url.pathname === "/api/dingtalk/config" && req.method === "POST") {
    const result = saveDingTalkConfig(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/dingtalk/test" && req.method === "POST") {
    const result = await dingtalk.sendText("千川机器人已连接 ✓");
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/secret" && req.method === "POST") {
    const result = saveSecret(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/secret/status" && req.method === "GET") {
    return send(res, 200, { ok: true, configured: hasDeepSeekKey() });
  }

  if (url.pathname === "/api/ai/trigger" && req.method === "POST") {
    const ai = await triggerAiNow();
    return send(res, ai.error ? 400 : 200, { ok: !ai.error, ai });
  }

  if (url.pathname === "/api/ai/chat" && req.method === "POST") {
    const result = await handleAiChat(await readBody(req), url.searchParams.get("model") || "");
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/ai/memory" && req.method === "GET") {
    return send(res, 200, { ok: true, memory: readAiMemory() });
  }

  if (url.pathname === "/api/ai/memory/clear" && req.method === "POST") {
    writeAiMemory(defaultAiMemory());
    appendJsonl(AI_LOG_FILE, { ts: Date.now(), type: "ai_memory_clear" });
    return send(res, 200, { ok: true, memory: readAiMemory() });
  }

  if (url.pathname === "/api/review/daily" && req.method === "GET") {
    return send(res, 200, { ok: true, dailyReview: readJson(STATE_FILE, {}).dailyReview || null });
  }

  if (url.pathname === "/api/review/daily/run" && req.method === "POST") {
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    state.dailyReview = buildDailyReview(state, "manual");
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
    return send(res, 200, { ok: true, dailyReview: state.dailyReview });
  }

  if (url.pathname === "/api/health-check" && req.method === "GET") {
    const health = await buildHealthCheck();
    return send(res, 200, health);
  }

  if (url.pathname === "/api/health-check/auto-fix" && req.method === "POST") {
    const result = await runHealthAutoFix();
    return send(res, 200, result);
  }

  if (url.pathname === "/api/visual/status" && req.method === "GET") {
    return send(res, 200, { ok: true, visualCapture: readJson(STATE_FILE, {}).visualCapture || null });
  }

  if (url.pathname === "/api/visual/capture" && req.method === "POST") {
    const visualCapture = await runVisualCaptureForState();
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", visualCapture });
  }

  if (url.pathname === "/api/visual/collect-overall" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("overall", { force: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/visual/collect-control" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("control", { force: true, openMissingTabs: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/visual/collect-material-boost" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("materialBoost", { force: true, openMissingTabs: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/visual/collect-one-click-lift" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("oneClickLift", { force: true, openMissingTabs: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/visual/collect-hourly" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("hourly", { force: true, openMissingTabs: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/visual/collect-material" && req.method === "POST") {
    return send(res, 200, { ok: false, disabled: true, error: "material_collect_disabled", message: "素材详情采集已暂时停用" });
  }

  if (url.pathname === "/api/visual/auto-collect" && req.method === "POST") {
    const visualCapture = await runVisualCollectRoute("overall", { force: true });
    return send(res, visualCapture.status === "error" ? 400 : 200, { ok: visualCapture.status !== "error", deprecated: true, ...visualCapture, visualCapture });
  }

  if (url.pathname === "/api/board-collect/status" && req.method === "GET") {
    return send(res, 200, { ok: true, boardCollectStatus: simpleCollectStatusFromState("boardCollectStatus") });
  }

  if (url.pathname === "/api/board-collect/run" && req.method === "POST") {
    if (boardCollectRunning) return send(res, 409, { ok: false, error: "already_running", boardCollectStatus: simpleCollectStatusFromState("boardCollectStatus") });
    const result = await runBoardCollectForState(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/board-trend/status" && req.method === "GET") {
    return send(res, 200, { ok: true, boardTrendCollectStatus: simpleCollectStatusFromState("boardTrendCollectStatus") });
  }

  if (url.pathname === "/api/board-trend/run" && req.method === "POST") {
    if (boardTrendCollectRunning) return send(res, 409, { ok: false, error: "already_running", boardTrendCollectStatus: simpleCollectStatusFromState("boardTrendCollectStatus") });
    const result = await runBoardTrendCollectForState(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/plan-collect/status" && req.method === "GET") {
    return send(res, 200, { ok: true, planCollectStatus: simpleCollectStatusFromState("planCollectStatus") });
  }

  if (url.pathname === "/api/plan-collect/run" && req.method === "POST") {
    if (planCollectRunning) return send(res, 409, { ok: false, error: "already_running", planCollectStatus: simpleCollectStatusFromState("planCollectStatus") });
    const result = await runPlanCollectForState(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/material-collect/status" && req.method === "GET") {
    return send(res, 200, { ok: true, materialCollectStatus: materialCollectStatusFromState() });
  }

  if (url.pathname === "/api/material-collect/run" && req.method === "POST") {
    if (materialCollectRunning) return send(res, 409, { ok: false, error: "already_running", materialCollectStatus: materialCollectStatusFromState() });
    const result = await runMaterialCollectForState(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/task-collect/status" && req.method === "GET") {
    return send(res, 200, { ok: true, taskCollectStatus: taskCollectStatusFromState() });
  }

  if (url.pathname === "/api/task-collect/run" && req.method === "POST") {
    if (taskCollectRunning) return send(res, 409, { ok: false, error: "already_running", taskCollectStatus: taskCollectStatusFromState() });
    const result = await runTaskCollectForState(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/task-collect/stop" && req.method === "POST") {
    const result = stopTaskCollectForState();
    return send(res, 200, result);
  }

  if (url.pathname === "/api/tabs/init" && req.method === "POST") {
    try {
      const result = await initializeCollectorTabs();
      return send(res, result.ok ? 200 : 400, result);
    } catch (error) {
      return send(res, 500, { ok: false, error: `tabs_init_failed: ${error.message}` });
    }
  }

  if (url.pathname === "/api/action/manual.php" && req.method === "POST") {
    const body = await readBody(req);
    const { type, taskId, reason } = body;
    if (!type || !taskId) return send(res, 400, { ok: false, error: "type and taskId required" });
    const state = readJson(STATE_FILE, {});
    const now = Date.now();
    const originalConfig = migrateConfig(state.config);
    state.actions = Array.isArray(state.actions) ? state.actions : [];
    state.lastActionAt = state.lastActionAt || {};
    const title = reason || "手动操作";
    state.config = {
      ...originalConfig,
      actionMode: "review",
      actionCooldownMs: 0,
      maxActionsPerHour: Math.max(originalConfig.maxActionsPerHour || 3, activeActionCount(state, now) + 1),
    };
    const action = pushAction(state, type, title, { taskId, taskName: taskId }, `手动操作：${title}`, now, "manual");
    state.config = originalConfig;
    if (!action) return send(res, 409, { ok: false, error: "action_dedup_or_throttled" });
    state.updatedAt = new Date().toISOString();
    writeJson(STATE_FILE, state);
    return send(res, 200, { ok: true, action });
  }

  if (url.pathname === "/api/action/approve" && req.method === "POST") {
    const body = await readBody(req);
    const result = updateActionStatus(body.id, "approved");
    if (!result.ok) return send(res, 400, result);
    const executionResult = await executeApprovedAction(body.id);
    const latest = readJson(STATE_FILE, {});
    const latestAction = (latest.actions || []).find((action) => action.id === body.id) || result.action;
    const feedback = appendActionFeedback(latest, latestAction, "approved", "用户审批通过", executionResult);
    return send(res, 200, {
      ...result,
      action: latestAction,
      executionResult,
      feedback,
    });
  }

  if (url.pathname === "/api/action/reject" && req.method === "POST") {
    const body = await readBody(req);
    const reason = String(body.reason || "").trim();
    const result = updateActionStatus(body.id, "rejected", { reason });
    if (result.ok) {
      const latest = readJson(STATE_FILE, {});
      const latestAction = (latest.actions || []).find((action) => action.id === body.id) || result.action;
      const feedback = appendActionFeedback(latest, latestAction, "rejected", reason);
      return send(res, 200, { ...result, action: latestAction, feedback });
    }
    return send(res, 400, result);
  }

  if (url.pathname === "/api/action/batch-approve" && req.method === "POST") {
    const result = await batchApproveAndMaybeExecute((await readBody(req)).ids);
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/action/command" && req.method === "POST") {
    const result = createManualActionCommand(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/material/screen" && req.method === "POST") {
    const result = await screenMaterialRecommendations(await readBody(req));
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/task/preview" && req.method === "POST") {
    const body = await readBody(req);
    const state = readJson(STATE_FILE, {});
    state.config = migrateConfig(state.config);
    const boostType = String(body.type || "");
    const boostRatio = currentBoostRatioValue(state);
    const manualBoostOverride = body.manualBoostOverride === true;
    if (boostType !== "oneClickLift" && !manualBoostOverride && Number.isFinite(boostRatio) && boostRatio >= 28) {
      return send(res, 400, { ok: false, blocked: true, boostRatio, error: "boost_ratio_guard", message: "追投占比已达28%，禁止新建追投" });
    }
    const result = await previewTask(body, {
      dataDir: DATA_DIR,
      cdpUrl: state.config.cdpUrl,
      expectedAccountId: state.config.expectedAccountId,
    });
    return send(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === "/api/action/execute" && req.method === "POST") {
    const body = await readBody(req);
    const result = await executeApprovedAction(body.id, { forceReal: body.forceReal === true });
    return send(res, result.ok ? 200 : 400, result);
  }

  if ((url.pathname === "/api/dashboard.php" || url.pathname === "/api/state.php") && req.method === "GET") {
    return send(res, 200, { ok: true, ...readStateForDashboard() });
  }
  if (url.pathname === "/api/learning-log.php" && req.method === "GET") return send(res, 200, { ok: true, logs: loadJsonl(LOG_FILE, Number(url.searchParams.get("limit") || 100)) });
  if (url.pathname === "/api/ai-log" && req.method === "GET") return send(res, 200, { ok: true, logs: loadJsonl(AI_LOG_FILE, Number(url.searchParams.get("limit") || 20)) });
  return send(res, 404, { ok: false, error: "not found" });
}

ensureDataFiles();
{
  const state = readJson(STATE_FILE, {});
  cleanupExpiredActions(state, Date.now(), 50);
  writeJson(STATE_FILE, state);
}
http.createServer((req, res) => {
  route(req, res).catch((error) => send(res, 500, { ok: false, error: error.message }));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`千川本地调控面板已启动：http://127.0.0.1:${PORT}/preview.html`);
  console.log(`后台状态接口：http://127.0.0.1:${PORT}/api/dashboard.php`);
  console.log(`动作模式：${DEFAULT_CONFIG.actionMode === "armed" ? "武装模式（待执行器）" : "审批模式"}`);
});

function anyCollectRunning() {
  return visualCollectRunning || taskCollectRunning || boardCollectRunning || boardTrendCollectRunning || planCollectRunning || materialCollectRunning || unifiedSkillCollectRunning;
}

function collectBusyReason() {
  if (visualCollectRunning) return "visual_collect_running";
  if (taskCollectRunning) return "task_collect_running";
  if (boardCollectRunning) return "board_collect_running";
  if (boardTrendCollectRunning) return "board_trend_collect_running";
  if (planCollectRunning) return "plan_collect_running";
  if (materialCollectRunning) return "material_collect_running";
  if (unifiedSkillCollectRunning) return "unified_skill_collect_running";
  return "";
}

function schedulerSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function randomSchedulerDelay() {
  await schedulerSleep(800 + Math.floor(Math.random() * 701));
}

function writeUnifiedSkillStatus(patch = {}) {
  const state = readJson(STATE_FILE, {});
  state.skillCollectStatus = { ...(state.skillCollectStatus || {}), ...patch, updatedAt: Date.now() };
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  return state.skillCollectStatus;
}

function scheduleUnifiedSkillCollectRetry(reason = "collect_busy") {
  if (unifiedSkillCollectRetryTimer) return Date.now() + UNIFIED_SKILL_COLLECT_RETRY_MS;
  const nextRetryAt = Date.now() + UNIFIED_SKILL_COLLECT_RETRY_MS;
  unifiedSkillCollectRetryTimer = setTimeout(async () => {
    unifiedSkillCollectRetryTimer = null;
    try {
      await runUnifiedSkillCollectScheduler({ retry: true, retryReason: reason });
    } catch (error) {
      writeWarning("unified_skill_collect_retry_failed", { error: error.message, reason });
    }
  }, UNIFIED_SKILL_COLLECT_RETRY_MS);
  return nextRetryAt;
}

function canRunAutoCollectNow() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  if (reconcileLiveLifecycleForNow(state)) writeJson(STATE_FILE, state);
  if (!isInLiveWindow(state.config)) return { ok: false, reason: "outside_live_window", state };
  if (state.config.aiAutoCollectEnabled === false) return { ok: false, reason: "auto_collect_disabled", state };
  const blockedReason = autoCollectBlocked(state);
  if (blockedReason) return { ok: false, reason: blockedReason, state };
  return { ok: true, state };
}

async function runScheduledVisualRoute(route, options = {}) {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  if (reconcileLiveLifecycleForNow(state)) writeJson(STATE_FILE, state);
  if (!isInLiveWindow(state.config)) return false;
  if (state.config.aiAutoCollectEnabled === false) return false;
  if (autoCollectBlocked(state)) return;
  if (!options.fromUnifiedScheduler && anyCollectRunning()) return false;
  const refreshPlan = shouldRefreshRouteBeforeCollect(state, route);
  const first = await runVisualCollectRoute(route, {
    openMissingTabs: route !== "overall",
    refreshBeforeCollect: refreshPlan.refresh,
    watchdogReason: refreshPlan.reason,
  });
  const issue = routeResultIssue(route, first);
  if (issue && state.config.aiAutoCollectRefreshOnStuck !== false && first.status !== "skipped") {
    writeWarning("auto_collect_watchdog_deferred", { route, issue });
  }
  return true;
}

async function runScheduledTaskCollect() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  if (reconcileLiveLifecycleForNow(state)) writeJson(STATE_FILE, state);
  if (!isInLiveWindow(state.config)) return false;
  if (state.config.aiAutoCollectEnabled === false) return false;
  if (autoCollectBlocked(state)) return false;
  if (visualCollectRunning || taskCollectRunning) return false;
  const result = await runTaskCollectForState({ scheduled: true });
  if (!result.ok && !result.skipped && result.error !== "already_running") {
    writeWarning("task_collect_failed", { error: result.error || "unknown" });
  }
  return true;
}

async function runUnifiedAutoAiDecision() {
  const state = readJson(STATE_FILE, {});
  state.config = migrateConfig(state.config);
  const receivedAt = Date.now();
  if (reconcileLiveLifecycleForNow(state, new Date(receivedAt))) writeJson(STATE_FILE, state);
  if (state.liveLifecycle?.status === "off_air") {
    return { ok: true, skipped: true, reason: "live_off_air" };
  }
  if (state.config.aiEnabled !== true) {
    return { ok: true, skipped: true, reason: "ai_disabled" };
  }
  if (!shouldRunAutoAi(state, receivedAt)) {
    return { ok: true, skipped: true, reason: "ai_interval_or_no_trigger" };
  }
  state.actions = Array.isArray(state.actions) ? state.actions : [];
  state.lastActionAt = state.lastActionAt || {};
  normalizeActionSources(state);
  const beforeIds = new Set(state.actions.map((action) => action.id));
  const aiResult = await runAiDecision(state, receivedAt);
  const createdActions = (state.actions || []).filter((action) => !beforeIds.has(action.id) && action.source === "ai");
  applyAiFailureGuard(state, aiResult, receivedAt);
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  notifyAiSuggestion(state, aiResult, createdActions, receivedAt);
  return {
    ok: !aiResult.error,
    skipped: false,
    createdActions: createdActions.length,
    pendingActions: createdActions.filter((action) => action.status === "pending_review" || action.status === "ready_to_execute").length,
    error: aiResult.error || "",
  };
}

async function runUnifiedSkillCollectScheduler(options = {}) {
  const ready = canRunAutoCollectNow();
  if (!ready.ok) {
    writeUnifiedSkillStatus({
      running: false,
      status: "skipped",
      skippedAt: Date.now(),
      lastSkipReason: ready.reason,
      retry: options.retry === true,
    });
    return false;
  }
  const busyReason = collectBusyReason();
  if (busyReason) {
    const nextRetryAt = scheduleUnifiedSkillCollectRetry(busyReason);
    if (busyReason !== "unified_skill_collect_running") {
      writeUnifiedSkillStatus({
        running: false,
        status: "skipped",
        skippedAt: Date.now(),
        lastSkipReason: busyReason,
        nextRetryAt,
        retry: options.retry === true,
      });
    }
    return false;
  }
  if (unifiedSkillCollectRetryTimer) {
    clearTimeout(unifiedSkillCollectRetryTimer);
    unifiedSkillCollectRetryTimer = null;
  }
  unifiedSkillCollectRunning = true;
  const startedAt = Date.now();
  const steps = [];
  writeUnifiedSkillStatus({
    running: true,
    status: "running",
    startedAt,
    finishedAt: null,
    currentStep: "hourly",
    stepLabel: "小时明细采集",
    completed: 0,
    total: 7,
    lastError: "",
    lastSkipReason: "",
    nextRetryAt: null,
    retry: options.retry === true,
    retryReason: options.retryReason || "",
  });
  try {
    const runStep = async (step, stepLabel, runner) => {
      writeUnifiedSkillStatus({ currentStep: step, stepLabel, lastError: "" });
      try {
        const result = await runner();
        steps.push({ step, ok: result === true || result?.ok === true, result });
        if (result !== true && result?.ok !== true) {
          writeWarning(`skill_collect_${step}_failed`, { error: result?.error || "collect_failed" });
        }
      } catch (error) {
        steps.push({ step, ok: false, error: error.message });
        writeWarning(`skill_collect_${step}_failed`, { error: error.message });
      }
      writeUnifiedSkillStatus({ completed: steps.length, steps });
      await randomSchedulerDelay();
    };

    await runStep("hourly", "小时明细采集", () => runScheduledVisualRoute("hourly", { fromUnifiedScheduler: true }));
    await runStep("board", "大屏指标采集", () => runBoardCollectForState({ scheduled: true, fromUnifiedScheduler: true }));
    await runStep("boardTrend", "大屏趋势采集", () => runBoardTrendCollectForState({ scheduled: true, fromUnifiedScheduler: true, granularity: 5 }));
    await runStep("plan", "计划表指标采集", () => runPlanCollectForState({ scheduled: true, fromUnifiedScheduler: true }));
    await runStep("task", "任务采集", () => runTaskCollectForState({ scheduled: true, fromUnifiedScheduler: true }));
    await runStep("material", "素材库采集", async () => {
      const state = readJson(STATE_FILE, {});
      if (!shouldRunMaterialCollect(state, Date.now())) return { ok: true, skipped: true, reason: "material_collect_interval_not_due" };
      return runMaterialCollectForState({ scheduled: true, fromUnifiedScheduler: true });
    });
    await runStep("ai", "AI 决策分析", () => runUnifiedAutoAiDecision());

    writeUnifiedSkillStatus({
      running: false,
      status: steps.every((step) => step.ok) ? "ok" : "partial",
      finishedAt: Date.now(),
      currentStep: "",
      stepLabel: "",
      completed: steps.length,
      total: 7,
      steps,
      retry: options.retry === true,
      retryReason: options.retryReason || "",
    });
    return true;
  } finally {
    unifiedSkillCollectRunning = false;
  }
}

setInterval(async () => {
  try {
    await runScheduledVisualRoute("overall");
  } catch (error) {
    writeWarning("auto_collect_failed", { error: error.message });
  }
}, 3 * 60 * 1000);

setInterval(() => {
  try {
    const state = readJson(STATE_FILE, {});
    cleanupExpiredActions(state, Date.now(), 50);
    writeJson(STATE_FILE, state);
  } catch (error) {
    writeWarning("action_cleanup_failed", { error: error.message });
  }
}, 10 * 60 * 1000);

setInterval(() => {
  try {
    maybeSendDingTalkHourlySummary();
  } catch (error) {
    console.error(`[dingtalk] hourly summary check failed: ${error.message}`);
  }
}, 30 * 1000);

setTimeout(() => {
  runUnifiedSkillCollectScheduler().catch((error) => {
    writeWarning("unified_skill_collect_failed", { error: error.message });
  });
  setInterval(async () => {
    try {
      await runUnifiedSkillCollectScheduler();
    } catch (error) {
      writeWarning("unified_skill_collect_failed", { error: error.message });
    }
  }, UNIFIED_SKILL_COLLECT_INTERVAL_MS);
}, 120 * 1000);
