const fs = require("fs");
const path = require("path");

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const SECRET_FILE = path.join(__dirname, "..", "data", "secret.json");

function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const secret = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
    return secret.anthropicApiKey || secret.claudeApiKey || "";
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
    if (!match) throw new Error("Claude response is not JSON");
    return JSON.parse(match[0]);
  }
}

function normalizeModel(model = "") {
  return String(model || "claude-sonnet-4-5").replace(/^anthropic[:/]/, "");
}

async function chat(payload) {
  try {
    const apiKey = readApiKey();
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: normalizeModel(payload.model || payload.config?.aiModel),
        max_tokens: 1200,
        system: payload.systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(payload.userPayload) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`Claude HTTP ${response.status}`);
    const raw = await response.json();
    const content = raw.content?.map((item) => item.text || "").join("\n") || "{}";
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

module.exports = { chat };
