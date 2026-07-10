# Task Collection Workflow

## Purpose

Keep control task, one-click lift, and material boost collection stable without requiring the operator to manually click each collection button.

The fragile parts are:

- Qianchuan tabs can render slowly or keep stale table content.
- One-click lift and material boost tabs can time out independently.
- A single stuck task must not destroy already collected task data.
- Browser automation routes can interfere with each other when run at the same time.

## Stable Route

Use this route:

1. Open or reuse the Qianchuan detail/task-center page.
2. Wait up to 8 seconds for task table DOM rows.
3. If rows do not appear, reload once and wait up to 8 seconds again.
4. Extract basic fields for all visible tasks:
   - `taskId`
   - `taskName`
   - `status`
   - `budget`
   - `roi`
   - `spend`
5. Iterate tasks one by one.
6. For each task:
   - write `currentTaskIndex`, `currentTaskName`, `currentStep`, and `stepLabel`
   - add about 500 ms random delay between steps
   - switch to one-click lift tab and match the task ID
   - switch to material boost tab and match the task ID
7. If a step times out, wait 3 seconds and retry once.
8. If the step still fails, mark only that step failed and continue to the next task.
9. If three consecutive tasks fail both one-click and material collection, pause the whole collector.

## State Contract

Write this shape into `state.taskCollectStatus`:

```json
{
  "running": true,
  "startedAt": 1782000000000,
  "currentTaskIndex": 2,
  "currentTaskName": "一键起量 #9383065",
  "currentStep": "material_boost",
  "stepLabel": "素材追投采集",
  "lastError": "页面加载超时，已重试 1 次",
  "completed": 3,
  "total": 8,
  "paused": false,
  "details": []
}
```

`details` should contain one row per task for the status bar:

```json
{
  "taskId": "1869521959383065",
  "taskName": "一键起量_直播间购买_22:11:12",
  "taskType": "oneclick_lift",
  "stepStatus": {
    "basic": "ok",
    "oneclick_lift": "ok",
    "material_boost": "timeout_after_2_retries"
  },
  "status": "partial"
}
```

## Output Contract

Return:

```json
{
  "ok": true,
  "collected": [
    {
      "taskId": "1869521959383065",
      "taskName": "一键起量_直播间购买_22:11:12",
      "taskType": "oneclick_lift",
      "basic": { "status": "调控中", "budget": 1100, "roi": 4.0, "spend": 818 },
      "oneclick": { "budget": 1100, "duration": "3小时", "roi": 4.0, "spend": 818, "dealAmount": 3270 },
      "material": null
    }
  ],
  "failedSteps": [
    { "taskId": "1869521959383065", "step": "material_boost", "error": "timeout_after_2_retries" }
  ],
  "warnings": ["累计 2 个任务步骤采集超时"]
}
```

## Logging

Write step warnings to `learning-log.jsonl`:

```json
{
  "type": "task_collect_warning",
  "taskId": "1869521959383065",
  "step": "material_boost",
  "error": "timeout_after_2_retries",
  "at": 1782000000000
}
```

When pausing after consecutive failures:

```json
{
  "type": "task_collect_paused",
  "reason": "consecutive_failures_3_tasks",
  "lastTask": "1869521959383065"
}
```

## UI Contract

The preview status bar should:

- hide when idle and no previous details exist
- show green while running normally
- show amber flashing when `lastError` mentions timeout/retry
- show red when paused after consecutive failures
- show gray when complete
- expand to a table with task, one-click lift status, material boost status, and row status

## Debug Checklist

When task collection appears stuck:

1. Check `/api/task-collect/status`.
2. Inspect `state.taskCollectStatus.currentStep`.
3. Check whether `visualCollectRunning` or `taskCollectRunning` is preventing a scheduled run.
4. Inspect `learning-log.jsonl` for `task_collect_warning`.
5. Confirm the browser has an active Qianchuan detail/task-center tab.
6. Confirm task rows contain numeric task IDs; do not use character IDs for one-click lift rows.

