#!/usr/bin/env node
const assert = require("assert");
const { summarizeEngineeringHealth } = require("../lib/health-monitor");

const collectors = [
  { name: "board_collect", label: "大屏", level: "error", reason: "board_live_context_missing" },
  { name: "board_trend", label: "趋势", level: "error", reason: "board_live_context_missing" },
  { name: "plan_collect", label: "计划", level: "ok", reason: "" },
  { name: "hourly_collect", label: "小时", level: "ok", reason: "" },
  { name: "task_collect", label: "任务", level: "ok", reason: "" },
  { name: "material_collect", label: "素材", level: "warn", reason: "stale_31m" },
];
const tabs = { level: "warn", missing: ["liveScreen"], message: "缺少采集页：liveScreen" };
const summary = summarizeEngineeringHealth(collectors, tabs);

assert.strictEqual(summary.score, 72, "one live-screen root error and one material warning should score 72");
assert.deepStrictEqual(summary.summary, { ok: 3, warn: 1, error: 1 });
assert.strictEqual(summary.alerts.length, 1, "the live-screen root cause must produce one error alert");
assert.strictEqual(summary.alerts[0].name, "live_screen_context");

const healthy = summarizeEngineeringHealth(
  collectors.map((item) => ({ ...item, level: "ok", reason: "" })),
  { level: "ok", missing: [], message: "CDP 标签页完整" },
);
assert.strictEqual(healthy.score, 100);
assert.deepStrictEqual(healthy.summary, { ok: 7, warn: 0, error: 0 });

console.log(JSON.stringify({ ok: true, summary, healthy: healthy.summary }));
