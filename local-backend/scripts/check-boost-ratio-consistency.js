const assert = require("assert");
const { calcBoostRatio, chooseBaseSpendCandidate } = require("../lib/spend-metrics");

const screenshotOverallCost = 2299.35;
const screenshotBaseSpend = 1856.94;
const staleOverviewBaseSpend = 1048.46;

const chosen = chooseBaseSpendCandidate(screenshotOverallCost, [
  { value: staleOverviewBaseSpend, source: "stale_overview", receivedAt: 1783618200000 },
  { value: screenshotBaseSpend, source: "plan_collector", receivedAt: 1783618343000 },
]);

assert(chosen, "base spend candidate should be selected");
assert.strictEqual(chosen.value, screenshotBaseSpend);

const ratio = calcBoostRatio(screenshotOverallCost, chosen.value);
assert.strictEqual(ratio, 19.24);

console.log(JSON.stringify({
  ok: true,
  overallCost: screenshotOverallCost,
  baseSpend: chosen.value,
  boostRatio: ratio,
  formula: "(综合成本 - 基础消耗) / 综合成本",
}));
