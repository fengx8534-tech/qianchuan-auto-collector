---
name: qianchuan-task-collector
description: Stabilize the Qianchuan task collection route for control tasks, one-click lift tasks, and material boost tasks. Use when diagnosing or changing task collection status, taskCollectStatus, task-collector.js, task collection retries, material/oneclick tab timeouts, or the preview task collection status bar in the project workspace.
---

# Qianchuan Task Collector

## Core Rule

Treat task collection as a resumable state machine. Every meaningful step must write progress to `state.taskCollectStatus` before continuing, so the dashboard can show where collection is running, retrying, paused, or failed.

## Required Workflow

For any change involving task collection, one-click lift collection, material boost collection, task collection scheduling, or the task collection status bar, read [references/task-workflow.md](references/task-workflow.md) before editing code.

Keep these invariants:

- Only one browser collection route runs at a time.
- Each task step writes state immediately.
- A tab timeout retries once before the step is marked failed.
- Three consecutive failed tasks pause the whole collector.
- Failed material or one-click steps must not block already collected basic fields.

## Project Files

- Collector logic: `local-backend/executor/task-collector.js`
- Routes and scheduler: `local-backend/server.js`
- Status UI: `local-backend/public/preview.html`
- Status rendering: `local-backend/public/preview.js`
- Status styling: `local-backend/public/preview.css`
- Runtime state: `local-backend/data/state.json`
- Warning log: `local-backend/data/learning-log.jsonl`

## Validation

After edits, run:

```bash
node --check local-backend/executor/task-collector.js
node --check local-backend/server.js
node --check local-backend/public/preview.js
```

Then verify:

```bash
curl -s http://127.0.0.1:8788/api/task-collect/status
curl -s -X POST http://127.0.0.1:8788/api/task-collect/run
```

Expected status behavior:

- running: green bar with current step
- retrying: amber flashing bar with timeout/retry message
- paused/error: red bar after consecutive task failures
- done: gray bar with completed count
