const { runMaterialCollector } = require("./material-collector");

let consecutiveFailures = 0;
let paused = false;

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

async function screenMaterials(type, manualIds = [], options = {}) {
  if (paused) return { ok: false, error: "material_screener_paused_after_3_failures", paused: true, materials: [] };
  const accepted = new Set(["topSpend", "comprehensiveRoi", "highCtr", "highCvr", "manual"]);
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
    if (consecutiveFailures >= 3) paused = true;
    return { ok: false, error: result.error || "material_screen_failed", paused, materials: [] };
  }

  consecutiveFailures = 0;
  const all = Array.isArray(result.materials) ? result.materials : [];
  let materials = all;
  let limit = 3;
  if (type === "manual") {
    const wanted = new Set((Array.isArray(manualIds) ? manualIds : []).map((id) => String(id).trim()).filter(Boolean));
    materials = all.filter((item) => wanted.has(materialIdOf(item)));
    limit = wanted.size;
  } else if (type === "comprehensiveRoi") {
    materials = sortBy(all, "materialRoi");
    limit = 5;
  } else if (type === "highCtr") {
    materials = sortBy(all, "ctr");
    limit = 5;
  } else if (type === "highCvr") {
    materials = sortBy(all, "cvr");
    limit = 5;
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

module.exports = { screenMaterials };
