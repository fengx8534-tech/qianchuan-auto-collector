---
name: qianchuan-action-executor
description: CDP-based real-click executor for Qianchuan control tasks. Covers create_boost_task, create_oneclick_task, pause_task, previewTask, and the screenshot verification chain. Use when debugging CDP click flows, DOM selectors, or action outcomes.
---

# Qianchuan Action Executor

## Core Rule

Every real-click action MUST capture `beforeScreenshot` and `afterScreenshot`. `previewTask` fills forms and takes screenshots without submitting; confirmed actions submit via CDP. Create actions always require a dry-run screenshot preview before real submission.

For any change to executor behavior, read [references/action-workflow.md](references/action-workflow.md) first.

## Action Capabilities

| Type | CDP Flow |
|---|---|
| `create_boost_task` | 任务中心 -> 新建追投 -> 选素材/填预算/设 ROI -> 预览截图 -> 确认提交 |
| `create_oneclick_task` | 任务中心 -> 新建一键起量 -> 直播间购买 -> 大屏截图 -> 填预算/时长 -> 同上 |
| `pause_task` | 任务列表找目标行 -> 暂停 -> 确认弹窗 -> 截图 |
| `end_task` | 同上点结束 |
| `increase_task_budget` | 加预算 -> 填新预算 -> 确认 |
| `decrease_task_budget` | 降预算 |
| `extend_task_duration` | 延时长 -> 设新时长 -> 确认 |
| `change_roi_target` | 改 ROI -> 输新值 -> 确认 |
| `previewTask` | 只填表 + 截图，不提交，返回截图路径和表单摘要 |

## Invariants

- Create 类强制先 dry-run 再截图，等待用户确认后才能真实提交。
- 每次点击前检查目标元素可见、可点击且位于正确任务行。
- 任一步骤失败都要保留 `failureScreenshot`，并返回具体步骤。
- DOM 选择器应使用精确的 class + 文本/任务 ID 组合，不使用裸 `button` 选择器。
- 截图只存放在 `/tmp/` 或项目截图目录，不包含或输出密钥。
- 未经用户明确确认，不得点击千川真实提交、暂停、结束或调控按钮。

## Project Files

- `local-backend/executor/action-executor.js`
- `local-backend/server.js`（action 路由）
- `local-backend/executor/cdp-client.js`
- `local-backend/data/state.json`

## Validation

```bash
node --check local-backend/executor/action-executor.js
```
