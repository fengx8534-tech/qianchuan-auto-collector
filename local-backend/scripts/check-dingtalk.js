const assert = require("assert");
const crypto = require("crypto");

const { __test } = require("../lib/dingtalk");

const timestamp = 1700000000123;
const secret = "SEC-test-secret";
const webhook = "https://oapi.dingtalk.com/robot/send?access_token=test-token";
const signedUrl = __test.buildSignedWebhookUrl(webhook, secret, timestamp);
const expectedSign = crypto
  .createHmac("sha256", secret)
  .update(`${timestamp}\n${secret}`)
  .digest("base64");

assert.strictEqual(signedUrl.protocol, "https:");
assert.strictEqual(signedUrl.searchParams.get("access_token"), "test-token");
assert.strictEqual(signedUrl.searchParams.get("timestamp"), String(timestamp));
assert.strictEqual(signedUrl.searchParams.get("sign"), expectedSign);
assert.throws(
  () => __test.buildSignedWebhookUrl("http://oapi.dingtalk.com/robot/send", secret, timestamp),
  /dingtalk_webhook_must_use_https/,
);
assert.strictEqual(__test.normalizeMessageText("当前盘况：A\\n\\n主要问题：B\r\n建议方向：C"), "当前盘况：A\n\n主要问题：B\n建议方向：C");
assert.strictEqual(__test.normalizeMessageText("A\n\n\n\nB"), "A\n\nB");

console.log(JSON.stringify({ ok: true, timestamp, signed: true }));
