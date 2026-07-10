const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const STATE_FILE = path.join(__dirname, "..", "data", "state.json");
const REQUEST_TIMEOUT_MS = 10000;

function normalizeMessageText(value) {
  return String(value ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function readConfig() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const config = state?.config?.dingtalk || {};
    return {
      enabled: config.enabled === true,
      webhook: typeof config.webhook === "string" ? config.webhook.trim() : "",
      secret: typeof config.secret === "string" ? config.secret.trim() : "",
    };
  } catch {
    return { enabled: false, webhook: "", secret: "" };
  }
}

function buildSignedWebhookUrl(webhook, secret, timestamp = Date.now()) {
  const url = new URL(webhook);
  if (url.protocol !== "https:") throw new Error("dingtalk_webhook_must_use_https");
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url;
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          return reject(new Error(`dingtalk_invalid_response:${response.statusCode || 0}`));
        }
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          return reject(new Error(`dingtalk_http_${response.statusCode || 0}`));
        }
        if (Number(parsed.errcode) !== 0) {
          return reject(new Error(`dingtalk_api_${parsed.errcode ?? "unknown"}:${parsed.errmsg || "unknown"}`));
        }
        return resolve({ ok: true, response: parsed });
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("dingtalk_request_timeout")));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function sendPayload(payload) {
  try {
    const config = readConfig();
    if (!config.enabled) throw new Error("dingtalk_disabled");
    if (!config.webhook || !config.secret) throw new Error("dingtalk_not_configured");
    const url = buildSignedWebhookUrl(config.webhook, config.secret);
    return await postJson(url, payload);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[dingtalk] push failed: ${message}`);
    return { ok: false, error: message };
  }
}

function sendMarkdown(title, text) {
  return sendPayload({
    msgtype: "markdown",
    markdown: {
      title: String(title || "千川自动化通知"),
      text: normalizeMessageText(text),
    },
  });
}

function sendText(content) {
  return sendPayload({
    msgtype: "text",
    text: { content: normalizeMessageText(content) },
  });
}

module.exports = {
  sendMarkdown,
  sendText,
  normalizeMessageText,
  __test: { buildSignedWebhookUrl, normalizeMessageText },
};
