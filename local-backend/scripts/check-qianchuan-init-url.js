#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  buildTaskCenterUrl,
  findAdContextFromState,
  hasAdContext,
  taskCenterUrlFromSource,
} = require("../lib/qianchuan-url");

const STATE_FILE = path.join(__dirname, "..", "data", "state.json");
const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
const accountId = state.config?.accountId || state.config?.expectedAccountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
const context = findAdContextFromState(state);
const url = context.sourceUrl
  ? taskCenterUrlFromSource(context.sourceUrl, accountId) || buildTaskCenterUrl(accountId, context)
  : buildTaskCenterUrl(accountId, context);

if (!context.adId) {
  throw new Error("missing_ad_context_in_state");
}

if (!url.includes("/uni-prom/detail")) {
  throw new Error(`not_detail_url: ${url}`);
}

if (!url.includes("uni_task_center")) {
  throw new Error(`not_task_center_url: ${url}`);
}

if (!hasAdContext(url, context.adId)) {
  throw new Error(`lost_ad_context: expected ${context.adId}, got ${url}`);
}

console.log(JSON.stringify({
  ok: true,
  accountId,
  adId: context.adId,
  url,
}, null, 2));
