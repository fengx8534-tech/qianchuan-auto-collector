---
name: qianchuan-material-screener
description: Real-time material screening on Qianchuan material page via CDP. Four filter modes: top spend, comprehensive ROI, high CTR, high CVR. Results go to DeepSeek for TOP 3 recommendation.
---

# Qianchuan Material Screener

## Core Rule

Never cache. Every session navigates live, clicks sort buttons in real time, waits for list refresh, and extracts current top materials. The DeepSeek recommendation is a separate step and uses current dashboard context.

## Screening Modes

| Mode | Action | Top N |
|---|---|---|
| `topSpend` | 默认消耗排序 | 3 |
| `comprehensiveRoi` | 点综合 ROI 列头 | 5 |
| `highCtr` | 点点击率列头 | 5 |
| `highCvr` | 点转化率列头 | 5 |
| `manual` | 验证用户输入素材 ID | 不限 |

## Workflow

1. 导航素材管理页。
2. 等表格和表头加载完成（DOM 信号）。
3. 点击对应排序按钮。
4. 等列表重排（DOM 变化信号）。
5. 提取名称、素材 ID、消耗、ROI、CTR、CVR、审核状态。
6. 将当前候选与当前盘况送入 DeepSeek，推荐 TOP 3。
7. 返回候选、建议预算、建议时长和不超过 50 字的理由。

## Invariants

- 随机延迟 500-760ms。
- DOM 信号优于固定时长。
- 失败 reload 后最多重试 2 次。
- 连续 3 次失败自动暂停。
- 追投占比大于或等于 28% 时直接拒绝新追投筛选结果。
- 不把素材候选、当前盘况或模型输入写入静态文档、代码常量或密钥文件。

## Project Files

- `local-backend/executor/material-screener.js`
- `local-backend/server.js`（`POST /api/material/screen`）
- `local-backend/executor/material-collector.js`（参考）
- `local-backend/executor/cdp-client.js`

## Validation

```bash
node --check local-backend/executor/material-screener.js
```
