const assert = require("assert");
const { isVerifiedPauseResult } = require("./action-executor");

assert.strictEqual(
  isVerifiedPauseResult({}, {}),
  false,
  "点击任务行暂停但未取得确认结果时，不能标记成功",
);

assert.strictEqual(
  isVerifiedPauseResult({ ok: true, step: "pause_confirm_clicked" }, { ok: false, error: "task_still_active" }),
  false,
  "确认后任务仍为调控中时，不能标记成功",
);

assert.strictEqual(
  isVerifiedPauseResult({ ok: true, step: "pause_confirm_clicked" }, { ok: true, status: "已暂停" }),
  true,
  "只有已点击确认且回读为已暂停时，才能标记成功",
);

console.log("pause_verification=ok");
