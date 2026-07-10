#!/usr/bin/env node
const assert = require("assert");
const { createSingleFlight } = require("../lib/single-flight");

async function main() {
  const runSingleFlight = createSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = async () => {
    calls += 1;
    await gate;
    return { calls };
  };

  const first = runSingleFlight(runner);
  const second = runSingleFlight(runner);
  assert.strictEqual(first, second, "concurrent calls must share the same promise");
  assert.strictEqual(calls, 0, "runner starts on the next microtask");
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepStrictEqual(firstResult, secondResult);
  assert.strictEqual(calls, 1, "concurrent calls must execute the runner once");

  await runSingleFlight(async () => {
    calls += 1;
  });
  assert.strictEqual(calls, 2, "a completed flight must allow the next run");
  console.log(JSON.stringify({ ok: true, calls }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
