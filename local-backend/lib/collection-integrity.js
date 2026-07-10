const DEFAULT_FRESHNESS_MS = {
  board_collect: 10 * 60 * 1000,
  board_trend: 10 * 60 * 1000,
  plan_collect: 15 * 60 * 1000,
  hourly_collect: 10 * 60 * 1000,
  task_collect: 10 * 60 * 1000,
  material_collect: 30 * 60 * 1000,
};

function cleanReason(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function uniqueWarnings(warnings = []) {
  return Array.from(new Set((Array.isArray(warnings) ? warnings : [])
    .map(cleanReason)
    .filter(Boolean))).slice(0, 8);
}

function recordCollectionIntegrity(state = {}, key, details = {}) {
  if (!key) return null;
  const now = Number(details.at || Date.now());
  const accepted = details.accepted === true;
  const warnings = uniqueWarnings(details.warnings);
  const reason = cleanReason(details.reason || warnings[0]);
  const partial = accepted && (details.partial === true || warnings.length > 0);
  const status = accepted ? (partial ? "partial" : "ok") : "failed";
  const previous = state.collectionIntegrity?.[key] || {};
  const failureCount = status === "ok" ? 0 : Number(previous.failureCount || 0) + 1;

  state.collectionIntegrity = state.collectionIntegrity || {};
  state.collectionIntegrity[key] = {
    ...previous,
    key,
    label: String(details.label || previous.label || key),
    status,
    source: String(details.source || previous.source || key),
    lastAttemptAt: now,
    lastAcceptedAt: accepted ? now : (previous.lastAcceptedAt || null),
    lastCompleteAt: status === "ok" ? now : (previous.lastCompleteAt || null),
    lastIssueAt: status === "ok" ? (previous.lastIssueAt || null) : now,
    lastIssue: status === "ok" ? "" : reason || (status === "partial" ? "partial_result" : "collect_failed"),
    count: Number.isFinite(Number(details.count)) ? Number(details.count) : (previous.count ?? null),
    warnings,
    failureCount,
    freshnessMs: Number(details.freshnessMs || previous.freshnessMs || DEFAULT_FRESHNESS_MS[key] || 10 * 60 * 1000),
  };
  return state.collectionIntegrity[key];
}

function integrityFor(state = {}, key, now = Date.now()) {
  const item = state.collectionIntegrity?.[key];
  if (!item) return null;
  const lastAcceptedAt = Number(item.lastAcceptedAt || 0);
  const ageMs = lastAcceptedAt > 0 ? Math.max(0, now - lastAcceptedAt) : Infinity;
  return {
    ...item,
    ageMs,
    stale: !Number.isFinite(ageMs) || ageMs > Number(item.freshnessMs || DEFAULT_FRESHNESS_MS[key] || 10 * 60 * 1000),
  };
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  recordCollectionIntegrity,
  integrityFor,
};
