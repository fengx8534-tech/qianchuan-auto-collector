---
name: qianchuan-hourly-collector
description: Stabilize the Qianchuan live ops hourly collection route. Use when diagnosing or changing single-hour spend, hourly base spend, hourly ROI, hour boost ratio, DOM visual collection, scheduled visual routes, or source-mismatch failures in the project workspace.
---

# Qianchuan Hourly Collector

## Core Rule

Treat hourly boost metrics as a same-page, same-hour calculation. Do not mix API totalTrend, metric history deltas, and DOM hourly detail rows when computing:

- `currentHourCost`
- `currentHourRoi`
- `hourSegmentSpend`
- `hourSegmentBaseSpend`
- `hourSegmentBoostRatio`

Use the DOM hourly detail route as the source of truth when both total and base rows are available.

## Required Workflow

For any change involving hourly spend, hourly base spend, or hourly boost ratio, read [references/hourly-workflow.md](references/hourly-workflow.md) before editing code.

Use this invariant:

```text
hourSegmentBoostRatio = (hourSegmentSpend - hourSegmentBaseSpend) / hourSegmentSpend * 100
```

Only compute the ratio when `hourSegmentSpend > 0`, `hourSegmentBaseSpend >= 0`, `hourSegmentBaseSpend <= hourSegmentSpend`, and both numbers came from the same hour key.

## Project Files

- Backend merge and scheduling: `local-backend/server.js`
- Visual DOM collection: `local-backend/executor/visual-capture.js`
- Dashboard rendering: `local-backend/public/preview.js`, `local-backend/public/preview.html`, `local-backend/public/preview.css`
- Live state: `local-backend/data/state.json`

## Validation

After edits, run:

```bash
node --check local-backend/server.js
node --check local-backend/executor/visual-capture.js
```

Then restart the local backend and trigger:

```bash
curl -s -X POST http://127.0.0.1:8788/api/visual/collect-hourly
```

Confirm state shows:

- `metricSources.currentHourCost.source === "hourly_detail_dom"`
- `metricSources.hourSegmentSpend.source === "hourly_detail_dom"`
- `metricSources.hourSegmentBaseSpend.source === "hourly_detail_base_only_dom"`
- `metricSources.hourSegmentBoostRatio.source === "hourly_detail_total_minus_base"`

If API hourly trend refreshes later, it must not overwrite a fresh DOM hourly detail result.
