# 千川本地调控后台

## 启动

```bash
node local-backend/server.js
```

默认地址：

- 可视化面板：`http://127.0.0.1:8788/preview.html`
- 看板状态：`http://127.0.0.1:8788/api/dashboard.php`
- 快照接收：`http://127.0.0.1:8788/api/snapshot.php`
- 学习日志：`http://127.0.0.1:8788/api/learning-log.php`

## 当前链路

Chrome 扩展读取千川页面数据后，会同步到本地后台：

`Chrome 页面采集 -> chrome.storage.local -> background.js -> 本地后台 -> 规则引擎 -> 动作队列/学习日志`

## 动作模式

当前默认 `ACTION_MODE=review`，后台只生成动作队列，需要在面板确认或拒绝。

开启武装准备态：

```bash
ACTION_MODE=armed node local-backend/server.js
```

注意：真正点击千川页面执行“暂停、加预算、改 ROI 目标”等动作，还需要补充对应页面的按钮和弹窗 DOM 选择器。
