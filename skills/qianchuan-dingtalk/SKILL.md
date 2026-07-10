---
name: qianchuan-dingtalk
description: DingTalk robot integration for Qianchuan. 5 push types, Outgoing callback for @robot queries, webhook signing, SOP panel config UI.
---

# Qianchuan DingTalk Integration

## Core Rule

Push failures never block the main flow. Wrap all sends in `try/catch`. Webhooks use HMAC-SHA256 signing. Outgoing callbacks use `sessionWebhook` and do not require signing.

## 5 Notification Types

| Type | Trigger | Format | Cooldown |
|---|---|---|---|
| 采集异常 | 采集器连续失败 2 次 | Markdown 红色 | 5 分钟/采集器 |
| AI 建议 | 每次 AI 决策（`act` + `observe`） | Markdown + reasoning | 无 |
| 执行结果 | 审批后执行完成 | Text | 无 |
| 整点汇总 | 北京时间每小时整点 | Markdown | 1 条/小时 |
| 系统告警 | 追投占比 >= 28% 或 AI 连续 2 次失败关停 | Markdown 红色 | 30 分钟 |

## Outgoing 回调

群内 @机器人后，DingTalk POST 到 `/api/dingtalk/outgoing`（经 ngrok 暴露），再按关键词回复：

| 触发词 | 回复 |
|---|---|
| 盘况 / 状态 / 数据 | 8 行指标摘要 |
| 追投 / 任务 | 追投占比 + 最多 5 条任务 |
| 告警 / 异常 | 告警状态 |
| 汇总 / 今日 | 日累计 |
| 其他 | 引导提示 |

回复通过 `sessionWebhook` 发送，不需要加签。

## Configuration

配置位于 `state.json -> config.dingtalk`。相关路由：

- `POST /api/dingtalk/config`
- `GET /api/dingtalk/config`
- `POST /api/dingtalk/test`

前端入口：`投放SOP` -> `钉钉通知配置`。

不要读取、回显或把真实 webhook / secret 写入代码、日志、文档或界面默认值。

## Project Files

- `local-backend/lib/dingtalk.js`
- `local-backend/server.js`（`notify*` 函数和路由）
- `local-backend/public/preview.html`（`dingtalkConfigPanel`）
- `local-backend/public/preview.js`
- `local-backend/scripts/check-dingtalk.js`

## Validation

```bash
node --check local-backend/lib/dingtalk.js
curl -X POST http://127.0.0.1:8788/api/dingtalk/test
```
