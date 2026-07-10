---
name: qianchuan-board-metrics
description: Stabilize the Qianchuan live board metrics route. Use when diagnosing or changing live board collection for order count, order cost, GPM, watch conversion rate, total viewers, online count, exposure watch rate, board-collector.js, or boardCollectStatus in the project workspace.
---

# Qianchuan Board Metrics

## Core Rule

Treat the live board as a single-page metrics source. Collect board-only fields from the Qianchuan live board page and write them to `state.metrics` without opening task or plan pages during the same step.

## Required Workflow

For any change involving live board metrics, board collection scheduling, or `boardCollectStatus`, read [references/board-workflow.md](references/board-workflow.md) before editing code.

The board collector owns these fields:

- `orderCount`
- `orderCost`
- `gpm`
- `watchConversionRate`
- `totalViewers`
- `onlineCount`
- `exposureWatchRate`

## Project Files

- Collector logic: `local-backend/executor/board-collector.js`
- Routes and scheduler: `local-backend/server.js`
- Runtime state: `local-backend/data/state.json`
- Warning log: `local-backend/data/learning-log.jsonl`

## Validation

After edits, run:

```bash
node --check local-backend/executor/board-collector.js
node --check local-backend/server.js
```

Then verify:

```bash
curl -s http://127.0.0.1:8788/api/board-collect/status
curl -s -X POST http://127.0.0.1:8788/api/board-collect/run
```

Expected state behavior:

- `state.boardCollectStatus.status === "ok"` when the board DOM is readable
- `state.metrics.gpm`, `state.metrics.onlineCount`, `state.metrics.totalViewers`, `state.metrics.exposureWatchRate`, and `state.metrics.watchDealRate` update from `board_collector`
- `state.assistMetrics.orderCount` and `state.assistMetrics.orderCost` update from the board route
- timeout triggers one reload before marking the run skipped
