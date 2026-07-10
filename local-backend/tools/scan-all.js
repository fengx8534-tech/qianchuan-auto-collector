const fs = require("fs");
const path = require("path");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "snapshots.jsonl");
const domains = new Map();

function parseUrl(value) {
  try {
    const url = new URL(value);
    return { host: url.host, path: url.pathname };
  } catch {
    return { host: "unknown", path: String(value || "unknown").split("?")[0] || "unknown" };
  }
}

const lines = fs.existsSync(SNAPSHOT_FILE) ? fs.readFileSync(SNAPSHOT_FILE, "utf8").trim().split("\n").filter(Boolean) : [];

for (const line of lines) {
  let item;
  try { item = JSON.parse(line); } catch { continue; }
  if (item.pageType !== "apiIntercept") continue;
  const { host, path: route } = parseUrl(item.fields?.url || item.url || "");
  if (!domains.has(host)) domains.set(host, new Map());
  const paths = domains.get(host);
  paths.set(route, (paths.get(route) || 0) + 1);
}

[...domains.entries()].sort((a, b) => {
  const aCount = [...a[1].values()].reduce((sum, count) => sum + count, 0);
  const bCount = [...b[1].values()].reduce((sum, count) => sum + count, 0);
  return bCount - aCount || a[0].localeCompare(b[0]);
}).forEach(([host, paths]) => {
  const total = [...paths.values()].reduce((sum, count) => sum + count, 0);
  console.log(`\n${host} | 总命中 ${total}`);
  [...paths.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([route, count]) => {
    console.log(`  ${route} | ${count}`);
  });
});
