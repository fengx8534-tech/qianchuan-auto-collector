#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const launcher = process.argv[2] || path.join(process.env.HOME || "", "Desktop", "千川调控台.command");
const source = fs.readFileSync(launcher, "utf8");

if (/open\s+-a\s+["']Google Chrome["']\s+--args/.test(source)) {
  throw new Error("launcher_reuses_existing_chrome_without_cdp");
}
if (!source.includes("--remote-debugging-port=9222")) {
  throw new Error("launcher_missing_remote_debugging_port");
}
if (!source.includes("--user-data-dir=/tmp/qianchuan-cdp")) {
  throw new Error("launcher_missing_dedicated_profile");
}

const startsDedicatedChrome = /open\s+-n[a-z]*\s+["']Google Chrome["']/.test(source);
if (!startsDedicatedChrome) {
  throw new Error("launcher_does_not_start_dedicated_chrome");
}

console.log(JSON.stringify({ ok: true, launcher }));
