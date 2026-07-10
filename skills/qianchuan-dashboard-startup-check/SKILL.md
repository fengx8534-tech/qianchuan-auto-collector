---
name: qianchuan-dashboard-startup-check
description: Check and open the local Qianchuan control dashboard after restarting Terminal or Chrome. Use when the user asks to verify the local panel, backend 8788 service, CDP Chrome 9222, Qianchuan tabs, collector status endpoints, or wants one command that checks everything before opening preview.html.
---

# Qianchuan Dashboard Startup Check

## Quick Command

Run from the project root:

```bash
node skills/qianchuan-dashboard-startup-check/scripts/check-and-open-dashboard.js --open
```

`--open` waits briefly for the local backend to finish booting, then opens `preview.html` immediately once the local panel and `/api/dashboard.php` are reachable. CDP, Qianchuan tab, and collector checks continue afterward; their warnings are still printed, but they do not delay or block the local panel from appearing.

Use `--init-tabs` when CDP is connected but required Qianchuan tabs are missing:

```bash
node skills/qianchuan-dashboard-startup-check/scripts/check-and-open-dashboard.js --init-tabs --open
```

## What To Check

Use the bundled script first. It checks:

- local backend page: `http://127.0.0.1:8788/preview.html`
- backend state/API: `/api/dashboard.php`
- AI key status: `/api/secret/status`
- CDP Chrome: `http://127.0.0.1:9222/json/version`
- CDP tabs: `http://127.0.0.1:9222/json/list`
- Qianchuan pages in CDP: `投放管理`, `直播大屏`, or any `qianchuan.jinritemai.com` page
- collector status endpoints:
  - `/api/task-collect/status`
  - `/api/board-collect/status`
  - `/api/board-trend/status`
  - `/api/plan-collect/status`
  - `/api/material-collect/status`
  - `/api/visual/status`

## Safety Rules

- Do not echo or read `local-backend/data/secret.json`.
- Do not run real action executor commands from this skill.
- Do not trigger collector `/run` endpoints as part of startup check unless the user explicitly asks.
- `--init-tabs` may open missing Qianchuan tabs through `/api/tabs/init`; it must not click mutation buttons.
- Default `--open` may open `preview.html` once the local backend panel is reachable, even if CDP, Qianchuan tabs, or collectors still need attention. This is safe because it only opens the local read-only/control panel.
- Use `--strict-open` when you want the old behavior: only open `preview.html` when backend, CDP, Qianchuan tabs, and collector status checks have no failures or warnings.

## Failure Guidance

If backend `8788` is down, tell the user to start it:

```bash
cd <PROJECT_ROOT>/local-backend
PORT=8788 node server.js
```

If CDP `9222` is down, tell the user to start Chrome:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/qianchuan-cdp --no-first-run --no-default-browser-check about:blank
```

Use `open -na`, not `open -a`: when a normal Chrome instance is already running, `open -a ... --args` may reuse it and discard the remote-debugging startup context, leaving port 9222 unavailable.

If CDP is up but Qianchuan tabs are missing, run the script with `--init-tabs`.
