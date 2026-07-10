---
name: qianchuan-material-library
description: Stabilize the Qianchuan material library collection route and AI material-layer boost decisions. Use when diagnosing or changing material-collector.js, materialCollectStatus, state.materialLibrary, material pagination, CTR/CVR/ROI fields, material-based create_boost_task suggestions, or the SOP autonomous boost rules in the project workspace.
---

# Qianchuan Material Library

## Core Rule

Material library data is its own collection route. Do not mix it with task rows, plan rows, hourly rows, or board trend data.

The route owns:

- `state.materialLibrary`
- `state.materialLibraryMeta`
- `state.materialCollectStatus`
- AI prompt material-layer summaries

## Collection Workflow

Collector file:

- `local-backend/executor/material-collector.js`

Expected browser path:

```text
投放管理 detail 页 -> 素材 tab -> 等表格渲染 -> 逐页读取 -> 右滑表格 -> 点击/读取转化率列 -> 翻页
```

The collector should:

- Use CDP only.
- Keep page collection mutually exclusive with other collectors.
- Read 50-100 rows per page when the page exposes them.
- Continue until no next page or max page limit.
- Preserve clear `step` and `error` fields when DOM selectors fail.
- Avoid fabricating CTR/CVR/ROI values; missing fields stay null.

## Data Contract

Each material item should include both stable JS keys and display-compatible Chinese keys:

- `materialId` / `素材ID`
- `spend` / `消耗`
- `ctr` / `CTR`
- `cvr` / `CVR`
- `materialRoi` / `素材ROI`
- `boostRoi` / `追投ROI`
- `createdAt` / `创建日期`
- `auditStatus` / `审核状态`
- `materialType` / `类型`

## Scheduler

Material collection runs inside the unified scheduler after task collection and before AI analysis, but only every 30 minutes.

Do not make it run every 5-minute unified cycle unless the user explicitly asks, because full material pagination can take many pages and may block other collection routes.

## AI Rules

AI material-layer boost decisions must use `state.materialLibrary` and `config.investmentSop.autonomousBoostRules`.

Hard guards:

- Material ROI < 2.0: never boost.
- Audit not passed: never boost.
- Boost ratio >= 28%: never create new boost.
- Create actions require approval and first run must be dryRun.
- Daily create actions <= 5.
- Create action interval >= 30 minutes.

Allowed create actions:

- `create_boost_task`
- `create_oneclick_task`

## Project Files

- Collector: `local-backend/executor/material-collector.js`
- Routes/scheduler/guards: `local-backend/server.js`
- Prompt injection: `local-backend/lib/ai-prompt.js`
- SOP UI: `local-backend/public/preview.html`
- SOP save/render: `local-backend/public/preview.js`
- Runtime state: `local-backend/data/state.json`

## Validation

After edits, run:

```bash
node --check local-backend/executor/material-collector.js
node --check local-backend/server.js
node --check local-backend/lib/ai-prompt.js
node --check local-backend/public/preview.js
```

Then verify:

```bash
curl -s http://127.0.0.1:8788/api/material-collect/status
curl -s -X POST http://127.0.0.1:8788/api/material-collect/run
```

Expected state behavior:

- `state.materialCollectStatus.status === "ok"` when the material table DOM is readable.
- `state.materialLibrary.length` reflects the full collected material library.
- Missing CTR/CVR/ROI fields remain null rather than guessed.
- AI recommendations include material ID and layer reason when suggesting create actions.
