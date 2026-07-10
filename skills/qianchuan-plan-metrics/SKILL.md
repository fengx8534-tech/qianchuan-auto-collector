---
name: qianchuan-plan-metrics
description: Stabilize the Qianchuan plan table metrics route. Use when diagnosing or changing plan detail collection for base spend, plan total cost, plan ROI, plan-collector.js, planCollectStatus, or baseSpend source priority in the project workspace.
---

# Qianchuan Plan Metrics

## Core Rule

Treat the plan detail table as the source for plan-level spend fields. Plan collection may fill missing base spend, but it must not override a fresh `investOverview.fields.baseSpend` value.

## Required Workflow

For any change involving plan table metrics, `baseSpend` source priority, plan collection scheduling, or `planCollectStatus`, read [references/plan-workflow.md](references/plan-workflow.md) before editing code.

The plan collector owns these fields:

- `planBaseSpend`
- `planTotalCost`
- `planRoi`

It may update `metrics.baseSpend` only when invest overview does not already provide `baseSpend`.

## Project Files

- Collector logic: `local-backend/executor/plan-collector.js`
- Routes and scheduler: `local-backend/server.js`
- Runtime state: `local-backend/data/state.json`
- Warning log: `local-backend/data/learning-log.jsonl`

## Validation

After edits, run:

```bash
node --check local-backend/executor/plan-collector.js
node --check local-backend/server.js
```

Then verify:

```bash
curl -s http://127.0.0.1:8788/api/plan-collect/status
curl -s -X POST http://127.0.0.1:8788/api/plan-collect/run
```

Expected state behavior:

- `state.planCollectStatus.status === "ok"` when the plan table DOM is readable
- `state.metrics.planBaseSpend`, `state.metrics.planTotalCost`, and `state.metrics.planRoi` update from `plan_collector`
- `state.metrics.baseSpend` remains the invest-overview value when invest overview is present
- timeout triggers one reload before marking the run skipped
