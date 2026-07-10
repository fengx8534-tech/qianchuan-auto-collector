const fs = require("fs");
const path = require("path");

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const SECRET_FILE = path.join(__dirname, "..", "data", "secret.json");
const PROJECT_CONFIG_FILE = path.join(__dirname, "..", "..", "config.json");

function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const config = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, "utf8"));
    if (typeof config?.deepseek?.apiKey === "string" && config.deepseek.apiKey.trim()) return config.deepseek.apiKey.trim();
  } catch {
    // The root config is optional; preserve the legacy local-secret fallback.
  }
  try {
    return JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")).deepseekApiKey || "";
  } catch {
    return "";
  }
}

function parseJsonContent(content = "") {
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek response is not JSON");
    return JSON.parse(match[0]);
  }
}

async function decide(payload) {
  try {
    const apiKey = readApiKey();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: payload.config?.aiModel || "deepseek-v4-pro",
        messages: [
          { role: "system", content: payload.systemPrompt },
          { role: "user", content: JSON.stringify(payload.userPayload) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const raw = await response.json();
    const content = raw.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonContent(content);
    return {
      decision: parsed.decision,
      reasoning: parsed.reasoning,
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      raw,
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

async function chat(payload) {
  try {
    const apiKey = readApiKey();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is missing");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: payload.model || payload.config?.aiModel || "deepseek-v4-pro",
        messages: [
          { role: "system", content: payload.systemPrompt },
          { role: "user", content: JSON.stringify(payload.userPayload) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const raw = await response.json();
    const content = raw.choices?.[0]?.message?.content || "{}";
    const parsed = parseJsonContent(content);
    return {
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      raw,
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

module.exports = { decide, chat };
