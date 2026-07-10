---
name: qianchuan-engineering-monitor
description: 工程监控、自动修复和告警入口。用于检查千川自动化本地调控台、采集器、CDP 标签页、关键指标异常，并按冷却规则触发只读修复。
---

# 千川工程监控

使用场景：

- 用户说“检查工程监控”“采集器是否正常”“自动修复”“健康检查”“为什么面板有告警”。
- 重新打开终端后，需要确认本地调控台、CDP Chrome、采集器状态是否可用。
- AI 自动接管前，需要确认采集状态和关键指标没有工程异常。

## 固定流程

1. 先读项目根目录 `PROJECT_SOURCE_OF_TRUTH.md`。
2. 不读取、不回显 `local-backend/data/secret.json`。
3. 先调用：

```bash
curl -s -X POST http://127.0.0.1:8788/api/health-check/auto-fix
```

4. 再调用：

```bash
curl -s http://127.0.0.1:8788/api/health-check
```

5. 如果全部 `ok`，简短告知“工程监控正常”，不要打扰用户。
6. 如果有 `warn`，说明已尝试自动修复的项目、冷却跳过的项目和建议手动命令。
7. 如果有 `error`，明确告诉用户哪些需要人工排查，不要把异常采集数据交给 AI 自动执行。

## 本地诊断命令

```bash
node skills/qianchuan-engineering-monitor/scripts/diagnose.js
```

该脚本会：

- 调用 `/api/health-check/auto-fix`。
- 调用 `/api/health-check`。
- 输出采集器状态、告警和修复建议。

## 安全边界

- 自动修复只允许触发只读采集器和 `/api/tabs/init`。
- 不允许关闭 `executorDryRun`。
- 不允许点击千川真实执行按钮。
- 同一采集器 1 小时内只自动修复 1 次。
- 同一指标连续 3 次异常后必须提示人工排查。
