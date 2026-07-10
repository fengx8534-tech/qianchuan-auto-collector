function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,，%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function calcBoostRatio(overallCost, baseSpend) {
  const overall = num(overallCost);
  const base = num(baseSpend);
  if (!Number.isFinite(overall) || overall <= 0) return null;
  if (!Number.isFinite(base) || base <= 0) return null;
  if (base > overall) return null;
  return Math.round(((overall - base) / overall) * 10000) / 100;
}

function chooseBaseSpendCandidate(overallCost, candidates = [], options = {}) {
  const overall = num(overallCost);
  const maxOverTotalRatio = Number(options.maxOverTotalRatio || 1.02);
  const freshnessWindowMs = Number(options.freshnessWindowMs || 15 * 60 * 1000);
  const valid = candidates
    .map((candidate) => ({
      ...candidate,
      value: money(num(candidate?.value)),
      receivedAt: Number(candidate?.receivedAt || 0),
    }))
    .filter((candidate) => {
      if (!Number.isFinite(candidate.value) || candidate.value <= 0) return false;
      if (Number.isFinite(overall) && overall > 0 && candidate.value > overall * maxOverTotalRatio) return false;
      return true;
    });
  if (!valid.length) return null;
  const newestAt = Math.max(0, ...valid.map((candidate) => candidate.receivedAt).filter(Number.isFinite));
  const fresh = newestAt
    ? valid.filter((candidate) => !candidate.receivedAt || newestAt - candidate.receivedAt <= freshnessWindowMs)
    : valid;
  const pool = fresh.length ? fresh : valid;
  const valueThreshold = Math.max(20, (Number.isFinite(overall) && overall > 0 ? overall : Math.max(...pool.map((item) => item.value))) * 0.03);
  return pool
    .slice()
    .sort((a, b) => {
      const valueDelta = b.value - a.value;
      if (Math.abs(valueDelta) > valueThreshold) return valueDelta;
      return (b.receivedAt || 0) - (a.receivedAt || 0);
    })[0];
}

module.exports = { calcBoostRatio, chooseBaseSpendCandidate };
