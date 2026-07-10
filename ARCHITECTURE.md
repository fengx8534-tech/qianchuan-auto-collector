# 千川实时调控台 — 架构文档

## 系统架构

```text
┌─────────────────────────────────────────────────────┐
│                    千川实时调控台                    │
├─────────────────────────────────────────────────────┤
│ 前端层   preview.html/js/css：监控面板、SOP、AI 弹窗 │
├─────────────────────────────────────────────────────┤
│ 调度层   server.js：串行调度与状态合并               │
│          board -> trend -> plan -> hourly -> task    │
│          -> material -> AI                           │
├─────────────────────────────────────────────────────┤
│ 采集层   Chrome CDP + DOM/API 读取                   │
│          board / trend / plan / hourly / task /      │
│          material / material-screener                │
├─────────────────────────────────────────────────────┤
│ 决策层   ai-prompt.js：三段式分析与约束              │
│          lib/deepseek.js：模型 API 调用              │
├─────────────────────────────────────────────────────┤
│ 执行层   action-executor.js：受控 CDP 页面操作       │
│          暂停、预算、时长、ROI、追投、一键起量       │
├─────────────────────────────────────────────────────┤
│ 通知层   lib/dingtalk.js：五类钉钉推送               │
├─────────────────────────────────────────────────────┤
│ 外部依赖 Chrome CDP :9222 / DeepSeek / DingTalk      │
└─────────────────────────────────────────────────────┘
```

## 数据流

```text
CDP 页面与接口响应
  -> DOM/API 解析
  -> local-backend/data/state.json
  -> buildUserPayload()
  -> DeepSeek reasoning + actions
  -> 调控台弹窗 / 钉钉推送
  -> 用户审批
  -> action-executor.js
  -> CDP 操作千川页面
```

`state.json` 是本地运行态，不属于开源仓库；公开配置应放在本机的 `config.json`。

## 安全护栏

- 创建类动作强制经过 dry-run 和截图确认。
- 每小时执行次数有上限。
- 追投占比达到 28% 时禁止新建追投。
- AI 连续两次失败会自动关停 AI 盯盘。
- 所有密钥通过 `config.json` 或环境变量注入，不写入源码。
- 所有真实千川点击都需要明确人工确认。

## 采集器

| 路线 | 模块 | 主要输出 |
|---|---|---|
| 直播大屏 | `board-collector.js` | 订单、GPM、观看与在线指标 |
| 趋势 | `board-trend-collector.js` | 1/5/30 分钟消耗、成交、ROI 趋势 |
| 计划表 | `plan-collector.js` | 基础消耗、计划总消耗、计划 ROI |
| 小时明细 | `visual-capture.js` | 当前小时消耗、ROI、基础消耗 |
| 任务中心 | `task-collector.js` | 追投、控成本、一键起量任务 |
| 素材库 | `material-collector.js` | 素材 ROI、CTR、CVR、审核状态 |
| 素材筛选 | `material-screener.js` | 实时排序候选，供 AI 推荐 TOP 3 |

## 决策与执行

1. `ai-prompt.js` 组装当前指标、任务、SOP 与约束。
2. `deepseek.js` 返回三段式 reasoning 与候选 actions。
3. `server.js` 进行去重、冷却、审批和风险校验。
4. `action-executor.js` 在正确页面与任务行定位后执行，保留前后或失败截图。
5. 钉钉模块以不阻塞主流程的方式推送异常、建议、结果、汇总和告警。

## 配置层次

```text
环境变量（最高优先级）
  -> 根目录 config.json（本机私有，Git 忽略）
  -> state.json 的已有运行态配置
  -> 代码默认值
```

`config.example.json` 是唯一可提交的配置模板。复制后填写自己的账户、API Key 与 SOP，再以 `config.json` 保存在本机。
