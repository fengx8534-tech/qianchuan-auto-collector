# Plan Metrics Workflow

## Purpose

This route collects plan-level metrics from:

```text
https://qianchuan.jinritemai.com/uni-prom/detail?aavid=xxx&adId=xxx
```

It exists to separate plan-table data from live board, task, one-click lift, material boost, and hourly detail collection.

## Collection Flow

```text
navigate or reuse uni-prom detail tab
  -> wait up to 8s for plan table DOM
  -> collect base spend, plan total spend, plan ROI
  -> if timeout, reload once
  -> wait up to 8s again
  -> write planCollectStatus and merge state.metrics
```

Use DOM readiness signals. Do not use fixed sleeps as the primary success condition.

## Field Mapping

| UI Field | State Key | Notes |
| --- | --- | --- |
| 基础消耗 | `metrics.planBaseSpend` | plan table value |
| 总消耗 / 整体消耗 / 消耗 | `metrics.planTotalCost` | summed table rows unless a total row exists |
| ROI / 净成交ROI / 综合ROI | `metrics.planRoi` | averaged from readable rows |

## Base Spend Priority

Keep this priority order:

```text
investOverview.fields.baseSpend > plan collector baseSpend > autoCollect baseSpend
```

The plan collector must not overwrite `metrics.baseSpend` when `latestByPage.investOverview.fields.baseSpend` is a positive number. This protects the full-day base spend from being replaced by partial table or hourly-like values.

## Retry And Failure

- Wait 8 seconds for table rows and readable labels.
- If unreadable, `Page.reload({ ignoreCache: true })` once.
- If still unreadable, return `ok: false`, `status: "skipped"`, and write `plan_collect_warning`.
- The unified scheduler must continue to task/hourly collection after this failure.

## Validation Checklist

- `POST /api/plan-collect/run` returns `{ ok: true }` when the plan detail page is logged in and readable.
- `GET /api/plan-collect/status` shows latest page, metrics, and reload state.
- `state.metricSources.planBaseSpend.source === "plan_collector"`.
- If invest overview has base spend, `state.metricSources.baseSpend.source` remains invest overview.
