const fs = require("fs");
const path = require("path");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "snapshots.jsonl");
const TARGETS = ["gpm", "online", "watch_user", "total_watch", "exposure", "show_to_watch", "view_conversion", "audience", "viewer"];

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url || "unknown").split("?")[0] || "unknown";
  }
}

function scanTargets(value) {
  const text = JSON.stringify(value || {}).toLowerCase();
  return TARGETS.filter((target) => text.includes(target));
}

const groups = new Map();
const lines = fs.existsSync(SNAPSHOT_FILE) ? fs.readFileSync(SNAPSHOT_FILE, "utf8").trim().split("\n").filter(Boolean) : [];

for (const line of lines) {
  let item;
  try { item = JSON.parse(line); } catch { continue; }
  if (item.pageType !== "apiIntercept") continue;
  const url = item.fields?.url || item.url || "";
  const route = pathOf(url);
  const current = groups.get(route) || { count: 0, targets: new Set() };
  current.count += 1;
  scanTargets(item.fields?.data ?? item.fields).forEach((target) => current.targets.add(target));
  groups.set(route, current);
}

const rows = [...groups.entries()].map(([route, data]) => ({
  route,
  count: data.count,
  targets: [...data.targets].sort(),
})).sort((a, b) => b.targets.length - a.targets.length || b.count - a.count || a.route.localeCompare(b.route));

console.log("path | 命中次数 | 含目标字段");
rows.forEach((row) => {
  console.log(`${row.route} | ${row.count} | ${row.targets.join(", ") || "--"}`);
});
