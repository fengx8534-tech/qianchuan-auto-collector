const assert = require("assert");
const { recordCollectionIntegrity, integrityFor } = require("../lib/collection-integrity");

const state = {};
recordCollectionIntegrity(state, "task_collect", {
  label: "调控任务",
  accepted: true,
  count: 6,
  at: 1000,
});
assert.equal(state.collectionIntegrity.task_collect.status, "ok");
assert.equal(state.collectionIntegrity.task_collect.lastCompleteAt, 1000);

recordCollectionIntegrity(state, "task_collect", {
  label: "调控任务",
  accepted: true,
  partial: true,
  warnings: ["material_timeout", "material_timeout"],
  count: 6,
  at: 2000,
});
assert.equal(state.collectionIntegrity.task_collect.status, "partial");
assert.equal(state.collectionIntegrity.task_collect.lastAcceptedAt, 2000);
assert.equal(state.collectionIntegrity.task_collect.lastCompleteAt, 1000);
assert.deepEqual(state.collectionIntegrity.task_collect.warnings, ["material_timeout"]);

recordCollectionIntegrity(state, "task_collect", {
  label: "调控任务",
  accepted: false,
  reason: "task_center_timeout",
  at: 3000,
});
assert.equal(state.collectionIntegrity.task_collect.status, "failed");
assert.equal(state.collectionIntegrity.task_collect.lastAcceptedAt, 2000);
assert.equal(integrityFor(state, "task_collect", 2000).stale, false);
assert.equal(integrityFor(state, "task_collect", 2000 + 10 * 60 * 1000 + 1).stale, true);

console.log(JSON.stringify({ ok: true, status: state.collectionIntegrity.task_collect.status }));
