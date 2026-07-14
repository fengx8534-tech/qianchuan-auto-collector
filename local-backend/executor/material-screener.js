const { runMaterialCollector } = require("./material-collector");

let consecutiveFailures = 0;
let paused = false;
let pausedAt = 0;
const PAUSE_RESET_MS = 5 * 60 * 1000;

function numberOf(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function materialIdOf(item = {}) {
  return String(item.materialId || item["素材ID"] || "").trim();
}

function sortBy(items, field) {
  return [...items].sort((left, right) => (numberOf(right[field]) || -Infinity) - (numberOf(left[field]) || -Infinity));
}

function potentialMaterials(items = []) {
  const candidates = items.filter((item) => {
    const ctr = numberOf(item.ctr);
    const spend = numberOf(item.spend);
    const clickCount = numberOf(item.clickCount ?? item["点击次数"]);
    const boostStatus = String(item.boostStatus ?? item["追投状态"] ?? "");
    const auditStatus = String(item.auditStatus ?? item["审核状态"] ?? "");
    const materialRoi = numberOf(item.materialRoi ?? item["素材ROI"]);
    return Number.isFinite(ctr) && ctr > 0
      && Number.isFinite(clickCount) && clickCount > 0
      && Number.isFinite(spend) && spend >= 0
      && item.boostStatusKnown === true && boostStatus === "未追投"
      && !/未通过|拒绝|失败/.test(auditStatus)
      && Number.isFinite(materialRoi) && materialRoi >= 2;
  });
  const spends = candidates.map((item) => numberOf(item.spend)).sort((a, b) => a - b);
  if (!spends.length) return [];
  const medianSpend = spends[Math.floor((spends.length - 1) / 2)];
  const highestSpend = spends.at(-1);
  return candidates
    .filter((item) => numberOf(item.spend) <= medianSpend && numberOf(item.spend) < highestSpend)
    .sort((left, right) => numberOf(right.clickCount ?? right["点击次数"]) - numberOf(left.clickCount ?? left["点击次数"])
      || numberOf(right.ctr) - numberOf(left.ctr)
      || numberOf(left.spend) - numberOf(right.spend));
}

async function screenMaterials(type, manualIds = [], options = {}) {
  if (paused) {
    if (Date.now() - pausedAt >= PAUSE_RESET_MS) {
      paused = false;
      consecutiveFailures = 0;
      pausedAt = 0;
    } else {
      const retryInSeconds = Math.ceil((PAUSE_RESET_MS - (Date.now() - pausedAt)) / 1000);
      return { ok: false, error: "material_screener_paused_after_3_failures", paused: true, retryInSeconds, materials: [] };
    }
  }
  const accepted = new Set(["topSpend", "comprehensiveRoi", "highCtr", "highCvr", "potentialMaterial", "manual"]);
  if (!accepted.has(type)) return { ok: false, error: "invalid_screen_type", materials: [] };

  // Reuse the isolated CDP material route. It includes randomized 500-760ms
  // delays and one cache-bypass retry, so screening never touches task tabs.
  const result = await runMaterialCollector({
    cdpUrl: options.cdpUrl,
    accountId: options.accountId,
    maxPages: 1,
  });
  if (!result.ok) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= 3) {
      paused = true;
      pausedAt = Date.now();
    }
    return { ok: false, error: result.error || "material_screen_failed", paused, materials: [] };
  }

  consecutiveFailures = 0;
  const all = Array.isArray(result.materials) ? result.materials : [];
  let materials = all;
  const maxCandidates = 10;
  let limit = maxCandidates;
  if (type === "manual") {
    const wanted = new Set((Array.isArray(manualIds) ? manualIds : []).map((id) => String(id).trim()).filter(Boolean));
    materials = all.filter((item) => wanted.has(materialIdOf(item)));
    limit = Math.min(wanted.size, maxCandidates);
  } else if (type === "comprehensiveRoi") {
    materials = sortBy(all, "materialRoi");
    limit = maxCandidates;
  } else if (type === "highCtr") {
    materials = sortBy(all, "ctr");
    limit = maxCandidates;
  } else if (type === "highCvr") {
    materials = sortBy(all, "cvr");
    limit = maxCandidates;
  } else if (type === "potentialMaterial") {
    materials = potentialMaterials(all);
    limit = maxCandidates;
  } else {
    materials = sortBy(all, "spend");
  }
  return {
    ok: true,
    type,
    source: "material_table_dom",
    total: all.length,
    materials: materials.slice(0, limit),
    warnings: result.warnings || [],
  };
}

function resetMaterialScreener() {
  consecutiveFailures = 0;
  paused = false;
  pausedAt = 0;
}

module.exports = { screenMaterials, resetMaterialScreener };
