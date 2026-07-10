# Board Metrics Workflow

## Purpose

This route collects stable live-room board metrics from:

```text
https://qianchuan.jinritemai.com/board-next?live_room_id=xxx&anchorId=xxx&aavid=xxx
```

It exists so visual board metrics do not fight with plan-table, task-table, one-click lift, material boost, or hourly-detail collection.

## Collection Flow

```text
navigate or reuse live board tab
  -> wait up to 8s for DOM signals
  -> collect 7 board metrics
  -> if timeout, reload once
  -> wait up to 8s again
  -> write boardCollectStatus and merge state.metrics
```

Use DOM readiness signals. Do not use fixed sleeps as the primary success condition.

## Field Mapping

| UI Field | State Key | Notes |
| --- | --- | --- |
| 成交订单数 | `assistMetrics.orderCount` | keep dashboard assist card compatible |
| 成交订单成本 | `assistMetrics.orderCost` | money rounded to 2 decimals |
| 千次观看成交金额 / GPM | `metrics.gpm` | board source of truth |
| 观看-成交率 | `metrics.watchDealRate` | collector metric name is `watchConversionRate` |
| 观看人数 | `metrics.totalViewers` | integer |
| 在线人数 | `metrics.onlineCount` | integer |
| 曝光-观看率 | `metrics.exposureWatchRate` | percent number |

## Merge Rules

- Set metric source to `board_collector`.
- Preserve existing non-board metrics.
- Do not compute boost ratio here.
- Do not open task tabs from this route.

## Retry And Failure

- Wait 8 seconds for useful DOM text and at least one metric.
- If unreadable, `Page.reload({ ignoreCache: true })` once.
- If still unreadable, return `ok: false`, `status: "skipped"`, and write `board_collect_warning`.
- The unified scheduler must continue to plan/task/hourly collection after this failure.

## Validation Checklist

- `POST /api/board-collect/run` returns `{ ok: true }` when the board tab is logged in and readable.
- `GET /api/board-collect/status` shows latest page and metrics.
- `state.metricSources.gpm.source === "board_collector"`.
- Existing task and hourly collection do not run at the same time.
