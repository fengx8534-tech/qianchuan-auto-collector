# Board Trend Workflow

## Purpose

This route collects the Qianchuan live board trend chart from:

```text
https://qianchuan.jinritemai.com/board-next?live_room_id=xxx&anchorId=xxx&aavid=xxx
```

It exists because the trend chart is a canvas and local visual snapshots can confuse cumulative totals with per-bucket values.

## Collection Flow

```text
reuse or open live board tab
  -> wait for "整体趋势 / 综合成本 / 净成交金额"
  -> select granularity: every 1, 5, or 30 minutes
  -> click "刷新数据"
  -> listen to Qianchuan JSON responses through CDP Network events
  -> parse StatsData.Rows into cost/revenue points
  -> if no trend response appears, reload once and retry
  -> write state.boardTrend and boardTrendCollectStatus
```

## Field Mapping

| Board Trend Field | State Key | Notes |
| --- | --- | --- |
| 综合成本 | `point.cost` | per bucket, not all-day total |
| 净成交金额 | `point.revenue` | per bucket, not inferred when missing |
| ROI | `point.roi` | computed only when cost and revenue are available |
| 粒度 | `state.boardTrend.granularity` | `1`, `5`, or `30` |

## Merge Rules

- `state.boardTrend.points` is the dashboard chart source of truth.
- The dashboard may fall back to old `trendData` only when `boardTrend.points` is empty.
- For 5-minute granularity, the latest cost point may update `state.fiveMinSpend`.
- Do not overwrite big board KPI fields here; those belong to `qianchuan-board-metrics`.

## Failure Handling

- Wait for DOM readiness first; if unreadable, reload once.
- Wait for trend API responses; if absent, reload once and retry.
- If still absent, return `ok: false`, `status: "skipped"`, and write `board_trend_collect_warning`.
- The unified scheduler must continue to plan, task, and hourly collection after a failure.

## Validation Checklist

- `POST /api/board-trend/run` writes `state.boardTrend.points`.
- The local chart no longer shows old cumulative spikes such as a single 5-minute point equal to a large all-day total.
- The tooltip shows both `综合成本` and `净成交金额` when Qianchuan provides both values.
- Clicking `每分钟`, `每5分钟`, or `每30分钟` triggers that granularity collection.
