# Hourly Collection Workflow

## Purpose

Keep the Qianchuan dashboard hourly cards accurate:

- single-hour spend
- single-hour ROI
- hourly base spend
- hourly boost ratio

The fragile part is that Qianchuan exposes total hourly data and base-only hourly data through a UI toggle on the same detail page. A stable collector must read both states and merge rows by hour.

## Stable DOM Route

Use this sequence exactly:

1. Enter Qianchuan promotion detail from 投放管理 by clicking the blue live-room text.
2. Open 数据 / 详细数据.
3. Scroll to the hourly table.
4. Ensure the base-only toggle is off.
5. Read total hourly rows.
6. Turn the base-only toggle on.
7. Wait for the table to refresh.
8. Read base-only hourly rows.
9. Turn the base-only toggle off again.
10. Wait for the table to refresh.
11. Re-read total hourly rows.
12. Merge final total rows with base-only rows by normalized hour key, such as `2026-07-02 20:00`.

Prefer the final total rows over the initial total rows because the table can remain in a partially refreshed state after toggling.

## Merge Rules

For each hour row:

- `cost` comes from final total rows.
- `roi`, `dealAmount`, `orders`, and `orderCost` come from final total rows.
- `baseCost` comes from the matching base-only row.
- `baseRoi` comes from the matching base-only row.

The current hour is the most recent row with a finite `cost` or `roi`.

Set source labels:

- Hour total metrics: `hourly_detail_dom`
- Hour base metrics: `hourly_detail_base_only_dom`
- Hour boost ratio: `hourly_detail_total_minus_base`

## Ratio Rule

Compute:

```text
hourSegmentBoostRatio = round((hourSegmentSpend - hourSegmentBaseSpend) / hourSegmentSpend * 10000) / 100
```

Reject the ratio when:

- total spend is missing or <= 0
- base spend is missing
- base spend is greater than total spend
- total and base rows are from different hour keys
- either value came from API totalTrend or metric history while the other came from DOM

When rejecting, show source mismatch instead of inventing a value.

## Source Priority

For hourly cards:

1. Fresh DOM hourly detail with total and base rows.
2. API hourly trend only for `currentHourCost` and `currentHourRoi` when DOM hourly detail is stale or missing.
3. Never compute `hourSegmentBaseSpend` or `hourSegmentBoostRatio` from API totalTrend plus metric history deltas.

Fresh means collected within about 5 minutes.

## Scheduler Rule

Run the hourly DOM route automatically, separate from material boost and one-click lift routes. The route should run often enough to keep DOM hourly detail fresh, currently every 2 minutes.

If a route appears stuck or stale:

- refresh only that route's target tab
- retry the route
- do not refresh all collection tabs together

## Debug Checklist

When the UI shows `来源不一致` for hourly base spend or boost ratio:

1. Inspect `local-backend/data/state.json`.
2. Check `state.hourlyBreakdown.source`.
3. Check `state.hourlyBreakdown.current.cost` and `state.hourlyBreakdown.current.baseCost`.
4. Check `state.metricSources.hourSegmentSpend.source`.
5. Check `state.metricSources.hourSegmentBaseSpend.source`.
6. Check whether API hourly trend overwrote DOM data after collection.

Healthy state should look like:

```json
{
  "metricSources": {
    "currentHourCost": { "source": "hourly_detail_dom" },
    "hourSegmentSpend": { "source": "hourly_detail_dom" },
    "hourSegmentBaseSpend": { "source": "hourly_detail_base_only_dom" },
    "hourSegmentBoostRatio": { "source": "hourly_detail_total_minus_base" }
  }
}
```

## Common Failure Modes

- The collector reads base rows, then forgets to toggle back and re-read total rows.
- API totalTrend overwrites a fresh DOM hourly detail row.
- Metric history deltas produce a base spend for a different time range.
- The UI table is still refreshing when rows are read.
- The current row has `cost` but no matching base row, so ratio must be withheld.
