# 巨量千川自动化

AI 自动盯盘 -> 采集数据 -> 分析决策 -> 审批执行 -> CDP 真点千川。

> 本项目是面向巨量千川直播投放的本地辅助调控台。AI 负责分析与建议；所有真实投放动作都必须经过人工审批和执行器安全校验。

## 项目背景

巨量千川直播投放常见的难点是盯盘人力成本高、调控响应不及时，以及多维度数据难以融合。本系统通过 Chrome CDP 实时采集千川后台指标，结合 DeepSeek 生成多维度分析和决策建议；在人工审批后，由 CDP 执行器按受控流程操作页面。

## 核心架构

```text
Chrome CDP :9222 -> Node 后端 :8788 -> 前端 preview.html

7 个采集路线 + 串行调度 + AI 决策引擎 + CDP 执行器
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 快速开始

### 前置条件

- Node.js 18+
- Google Chrome（开启远程调试端口）
- DeepSeek API Key
- 已登录的千川账户

### 安装与配置

```bash
git clone <repo-url>
cd qianchuan-live-ops
cp config.example.json config.json
```

编辑 `config.json`，填入千川账户 ID、DeepSeek API Key 和你的投放 SOP。该文件已被 Git 忽略，不能提交到仓库。

以远程调试模式启动 Chrome：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/qianchuan-cdp
```

启动本地后端：

```bash
cd local-backend
PORT=8788 node server.js
```

打开 [http://localhost:8788/preview.html](http://localhost:8788/preview.html)。

## 功能

- 16 项实时指标监控：ROI、消耗、追投占比、GPM、在线人数等。
- 直播大屏、趋势、计划表、小时明细、任务中心、素材库与素材筛选采集路线。
- AI 决策引擎：DeepSeek 每 5 分钟生成三段式分析与建议动作。
- CDP 受控执行器：暂停、加预算、延时长、改 ROI、新建追投、新建一键起量。
- 审批即执行：AI 建议 -> 用户确认 -> CDP 自动点击千川。
- 任务健康度面板、投放 SOP 与钉钉机器人通知。
- 11 个项目 Skill 文档，覆盖采集器、执行器与钉钉集成。

## 技术栈

Node.js · Chrome CDP · DeepSeek API · DingTalk Webhook · PM2

## 项目结构

```text
├── local-backend/
│   ├── server.js                 # 主进程：路由、调度、AI 触发
│   ├── executor/                 # 采集器与执行器
│   ├── lib/                      # AI、钉钉与公共模块
│   └── public/                   # 调控台前端
├── skills/                       # 11 个 Skill 文档
├── config.example.json           # 配置模板
├── ARCHITECTURE.md               # 架构详解
└── LICENSE                       # MIT
```

## 安全说明

- `config.json`、`local-backend/data/`、环境变量和本地日志均被 Git 忽略。
- 不要关闭 `executorDryRun`，除非已明确完成真实投放执行确认。
- 不要在未经人工确认时执行千川真实点击。
- `previewTask` 仅填写并截图，不能提交创建动作。

## License

[MIT](LICENSE)
