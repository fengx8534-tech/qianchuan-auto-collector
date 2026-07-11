const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SETTINGS_FILE = "dashboard-settings.json";
const SETTINGS_PATH = path.join(REPO_ROOT, SETTINGS_FILE);
let syncQueue = Promise.resolve();

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = sortObject(value[key]);
    return result;
  }, {});
}

function redactText(value) {
  return String(value)
    .replace(/\b1[3-9]\d{9}\b/g, "[redacted-phone]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function safeInvestmentSop(sop = {}) {
  const blockedKey = /(?:secret|webhook|token|api[_-]?key|account[_-]?id|cdp|password)/i;
  const sanitize = (value, key = "") => {
    if (blockedKey.test(key)) return undefined;
    if (typeof value === "string") return redactText(value);
    if (Array.isArray(value)) return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
    if (!value || typeof value !== "object") return value;
    return Object.entries(value).reduce((result, [childKey, childValue]) => {
      const next = sanitize(childValue, childKey);
      if (next !== undefined) result[childKey] = next;
      return result;
    }, {});
  };
  return sanitize(sop) || {};
}

function buildDashboardSettings(config = {}) {
  const dingtalk = config.dingtalk || {};
  return sortObject({
    schemaVersion: 1,
    managedBy: "qianchuan-dashboard",
    config: {
      actionMode: config.actionMode || "review",
      targetRoi: finiteOrNull(config.targetRoi),
      baselineTargetRoi: finiteOrNull(config.baselineTargetRoi),
      openTime: config.openTime || "",
      closeTime: config.closeTime || "",
      highFiveMinSpend: finiteOrNull(config.highFiveMinSpend),
      lowFiveMinSpend: finiteOrNull(config.lowFiveMinSpend),
      actionCooldownMs: finiteOrNull(config.actionCooldownMs),
      actionExpiresMs: finiteOrNull(config.actionExpiresMs),
      maxActionsPerHour: finiteOrNull(config.maxActionsPerHour),
      maxRoiTarget: finiteOrNull(config.maxRoiTarget),
      minRoiTarget: finiteOrNull(config.minRoiTarget),
      maxBudgetIncrease: finiteOrNull(config.maxBudgetIncrease),
      aiEnabled: config.aiEnabled === true,
      aiMinIntervalMs: finiteOrNull(config.aiMinIntervalMs),
      aiModel: config.aiModel || "",
      executorDryRun: config.executorDryRun !== false,
      autoCollectEnabled: config.autoCollectEnabled === true,
      aiAutoCollectEnabled: config.aiAutoCollectEnabled === true,
      aiAutoCollectRefreshOnStuck: config.aiAutoCollectRefreshOnStuck !== false,
      visualCollectStaleMs: finiteOrNull(config.visualCollectStaleMs),
      offAirLookbackMs: finiteOrNull(config.offAirLookbackMs),
      offAirConfirmationsRequired: finiteOrNull(config.offAirConfirmationsRequired),
      autoReviewAfterOffAir: config.autoReviewAfterOffAir !== false,
      materialCollectIntervalMs: finiteOrNull(config.materialCollectIntervalMs),
      investmentSop: safeInvestmentSop(config.investmentSop),
      dingtalk: {
        enabled: dingtalk.enabled === true,
        notifyCollectorError: dingtalk.notifyCollectorError !== false,
        notifyAiSuggestion: dingtalk.notifyAiSuggestion !== false,
        notifyActionResult: dingtalk.notifyActionResult !== false,
        notifyHourlySummary: dingtalk.notifyHourlySummary !== false,
        notifySystemAlert: dingtalk.notifySystemAlert !== false,
      },
    },
  });
}

async function git(args) {
  return execFileAsync("git", ["-C", REPO_ROOT, ...args], { maxBuffer: 1024 * 1024, timeout: 15000 });
}

async function syncNow(config = {}) {
  const content = `${JSON.stringify(buildDashboardSettings(config), null, 2)}\n`;
  const current = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : "";
  if (current === content) return { ok: true, changed: false, status: "up_to_date" };

  fs.writeFileSync(SETTINGS_PATH, content);
  try {
    await git(["add", "--", SETTINGS_FILE]);
    try {
      await git(["diff", "--cached", "--quiet", "--", SETTINGS_FILE]);
      return { ok: true, changed: false, status: "up_to_date" };
    } catch (error) {
      if (Number(error.code) !== 1) throw error;
    }
    await git(["commit", "-m", "chore: sync dashboard settings", "--", SETTINGS_FILE]);
    await git(["push", "origin", "HEAD"]);
    return { ok: true, changed: true, status: "pushed" };
  } catch (error) {
    return { ok: false, changed: true, status: "failed", error: String(error.stderr || error.message || "git_sync_failed").trim().slice(0, 500) };
  }
}

function syncDashboardSettings(config = {}) {
  const run = () => syncNow(config);
  const next = syncQueue.then(run, run);
  syncQueue = next.catch(() => null);
  return next;
}

module.exports = { buildDashboardSettings, syncDashboardSettings };
