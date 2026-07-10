---
name: qianchuan-five-minute-trend
description: Stabilize the Qianchuan live board trend route. Use when diagnosing or changing the opening trend chart, every-minute/5-minute/30-minute granularity, net deal amount trend, board-trend-collector.js, boardTrend, or boardTrendCollectStatus in the project workspace.
---

# Qianchuan Five Minute Trend

## Core Rule

Treat the Qianchuan live board trend chart as its own route. Do not infer this chart from visual snapshots, plan metrics, hourly details, or local cumulative totals when a board trend response is available.

## Required Workflow

For any change involving the opening trend chart or `boardTrendCollectStatus`, read [references/trend-workflow.md](references/trend-workflow.md) before editing code.

This route owns:

- `state.boardTrend.points`
- `state.boardTrend.granularity`
- `state.boardTrendCollectStatus`
- the dashboard opening trend chart when `state.boardTrend.points` exists

## Project Files

- Collector logic: `local-backend/executor/board-trend-collector.js`
- CDP event support: `local-backend/executor/cdp-client.js`
- Routes and scheduler: `local-backend/server.js`
- Chart rendering: `local-backend/public/preview.js`
- Runtime state: `local-backend/data/state.json`

## Validation

After edits, run:

```bash
node --check local-backend/executor/cdp-client.js
node --check local-backend/executor/board-trend-collector.js
node --check local-backend/server.js
node --check local-backend/public/preview.js
```

Then verify:

```bash
curl -s http://127.0.0.1:8788/api/board-trend/status
curl -s -X POST http://127.0.0.1:8788/api/board-trend/run -H 'content-type: application/json' -d '{"granularity":5}'
```

Expected behavior:

- `state.boardTrend.points` matches the Qianchuan live board trend API.
- The chart legend says `千川大屏趋势`.
- Net deal amount comes from the board trend response, not a guessed local calculation.
- A timeout reloads the board page once, then marks the route skipped without blocking other skills.
