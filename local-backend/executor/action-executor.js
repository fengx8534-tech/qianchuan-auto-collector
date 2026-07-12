const fs = require("fs");
const path = require("path");
const { DEFAULT_CDP_URL, listTabs, connect, scoreQianchuanTab, openTab } = require("./cdp-client");

const ICON_NAME_LABELS = {
  "oc-icon-light-edit": "编辑",
  "oc-icon-ellipsis": "更多",
  "oc-icon-logout": "退出",
  "oc-icon-video-play": "播放",
  "oc-icon-delete": "删除",
  "oc-chart-histogram": "趋势图",
  iconPause: "暂停",
  iconEdit: "编辑",
  iconDelete: "删除",
};

function clickLabel(value) {
  return ICON_NAME_LABELS[value] || value || "";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function actionKind(type = "") {
  if (type.includes("pause")) return "pause";
  if (type === "end_task" || type.includes("stop_task")) return "end";
  if (type.includes("duration") || type.includes("extend") || type.includes("time")) return "duration";
  if (type.includes("increase") || type.includes("budget")) return "budget";
  if (type.includes("decrease")) return "budget";
  if (type.includes("roi")) return "roi";
  return "unknown";
}

function isCreateAction(type = "") {
  return ["create_boost_task", "create_oneclick_task"].includes(String(type || ""));
}

function normalizeMaterialIds(value, fallback = "") {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/);
  const ids = raw.map((item) => String(item || "").trim()).filter((item) => /^\d{8,}$/.test(item));
  if (!ids.length && /^\d{8,}$/.test(String(fallback || "").trim())) ids.push(String(fallback).trim());
  return Array.from(new Set(ids)).slice(0, 10);
}

function taskIdFromNeedle(value = "") {
  const text = String(value || "");
  const match = text.match(/ID[：:]?\s*(\d{8,})/) || text.match(/\b(\d{12,})\b/);
  return match?.[1] || "";
}

function taskTabKind(action = {}) {
  const taskType = String(action.payload?.taskType || action.payload?.boostType || "").trim();
  if (/oneClick|oneclick|一键|起量/i.test(taskType) || action.type === "create_oneclick_task") return "oneclick";
  return "material";
}

function buildPrepareTaskListExpression(action, tabKind) {
  const wanted = tabKind === "oneclick"
    ? ["一键起量", "一键调速"]
    : ["素材追投", "放量追投", "画面追投", "控成本追投"];
  const avoid = tabKind === "oneclick"
    ? ["素材追投", "放量追投", "画面追投", "控成本追投"]
    : ["一键起量", "一键调速"];
  return `(async () => {
    const tabKind = ${JSON.stringify(tabKind)};
    const wanted = ${JSON.stringify(wanted)};
    const avoid = ${JSON.stringify(avoid)};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clickableOf = (el) => {
      const ownText = clean(el.innerText || el.textContent || "");
      const closest = el.closest("button,[role='tab'],[role='button'],a,.semi-tabs-tab,.semi-segmented-item,.arco-tabs-header-title,.arco-radio-button,.ovui-radio-item,.oc-radio-item");
      const closestText = clean(closest?.innerText || closest?.textContent || "");
      if (closest && avoid.some((item) => closestText.includes(item)) && !avoid.some((item) => ownText.includes(item))) return el;
      return closest || el;
    };
    const pickByText = (texts, blocked = [], exact = false) => Array.from(document.querySelectorAll("button,[role='tab'],[role='button'],a,span,div"))
      .filter((el) => {
        const text = clean(el.innerText || el.textContent || "");
        if (!text || text.length > 60) return false;
        if (exact ? !texts.includes(text) : !texts.some((item) => text.includes(item))) return false;
        if (blocked.some((item) => text.includes(item))) return false;
        return isVisible(el);
      })
      .map((el) => {
        const node = clickableOf(el);
        const text = clean(node.innerText || node.textContent || el.innerText || el.textContent || "");
        const rect = node.getBoundingClientRect();
        const cls = String(node.className || "") + " " + String(el.className || "");
        let score = 0;
        if (node.getAttribute("role") === "tab") score += 70;
        if (node.tagName === "BUTTON") score += 55;
        if (/tabs|tab|segmented|radio|filter|筛选|类型|ovui-radio|oc-radio/.test(cls)) score += 45;
        if (texts.includes(text)) score += 140;
        else if (texts.some((item) => text.startsWith(item))) score += 80;
        if (blocked.some((item) => text.includes(item))) score -= 160;
        if (node.closest("tr,tbody,table")) score -= 130;
        if (/ID[：:]?\\s*\\d{8,}|预算|ROI|消耗|成交/.test(text)) score -= 100;
        if (rect.top > window.innerHeight + 200) score -= 50;
        return { node, text: text.slice(0, 80), score, top: Math.round(rect.top) };
      })
      .sort((a, b) => b.score - a.score);
    const clicked = [];
    const control = pickByText(["调控"], [], true)[0];
    if (control) {
      control.node.scrollIntoView({ block: "center", inline: "center" });
      control.node.click();
      clicked.push({ step: "click_control_tab", text: control.text, score: control.score, top: control.top });
      await wait(700);
    }
    const subtab = pickByText(wanted, avoid, false)[0];
    if (!subtab) {
      return {
        ok: false,
        tabKind,
        error: "task_subtab_not_found",
        clicked,
        textSample: clean(document.body?.innerText || "").slice(0, 800),
        url: location.href,
        title: document.title
      };
    }
    subtab.node.scrollIntoView({ block: "center", inline: "center" });
    subtab.node.click();
    clicked.push({ step: "click_task_subtab", text: subtab.text, score: subtab.score, top: subtab.top });
    await wait(1000);
    return {
      ok: true,
      tabKind,
      clicked,
      textSample: clean(document.body?.innerText || "").slice(0, 800),
      url: location.href,
      title: document.title
    };
  })()`;
}

function buildExecuteExpression(action) {
  const payload = action.payload || {};
  const taskNeedle = String(payload.taskId || payload.taskName || "").trim();
  const taskId = taskIdFromNeedle(taskNeedle);
  const budget = Number(payload.budget || payload.newBudget || payload.budgetIncrease);
  const durationHours = Number(payload.durationHours || payload.newDurationHours || payload.extendHours);
  const kind = actionKind(action.type);
  return `(() => {
    const action = ${JSON.stringify({ id: action.id, type: action.type, kind, taskNeedle, taskId, budget, durationHours })};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const matchesTask = (text) => {
      const normalized = clean(text);
      if (action.taskId) {
        const pattern = new RegExp("(^|\\\\D)ID[：:]?\\\\s*" + action.taskId + "(?!\\\\d)");
        if (pattern.test(normalized)) return true;
        const bare = new RegExp("(^|\\\\D)" + action.taskId + "(?!\\\\d)");
        return bare.test(normalized);
      }
      return action.taskNeedle && normalized.includes(action.taskNeedle);
    };
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const rowSelectors = [
      "tr",
      "[role='row']",
      "[class*='table-row']",
      "[class*='TableRow']",
      "[class*='table_row']",
      "[class*='row']",
      "[class*='list-item']",
      "[class*='ListItem']",
    ].join(",");
    const rows = Array.from(new Set(Array.from(document.querySelectorAll(rowSelectors))))
      .filter(isVisible)
      .filter((item) => {
        const text = clean(item.innerText || item.textContent || "");
        return text.length >= 8 && text.length <= 2000;
      });
    const exactRows = rows.filter((item) => matchesTask(item.innerText || item.textContent || ""));
    const row = exactRows.sort((a, b) => clean(a.innerText || a.textContent || "").length - clean(b.innerText || b.textContent || "").length)[0];
    if (!row) return { ok: false, step: "find_row", error: "task_row_not_found", taskNeedle: action.taskNeedle, url: location.href, title: document.title };
    document.querySelectorAll('[data-qianchuan-hover-target="1"]').forEach((node) => node.removeAttribute("data-qianchuan-hover-target"));
    row.scrollIntoView({ block: "center", inline: "center" });
    const text = clean(row.innerText || row.textContent || "");
    const rect = row.getBoundingClientRect();
    const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    row.setAttribute("data-qianchuan-hover-target", "1");
    return {
      ok: true,
      step: "row_located",
      kind: action.kind,
      rowRect: { x, y, width: rect.width, height: rect.height },
      rowText: text.slice(0, 500),
      url: location.href,
      title: document.title
    };
  })()`;
}

function buildHoverButtonExpression(action, dryRun, firstRealExecute) {
  const kind = actionKind(action.type);
  const iconNameLabels = ICON_NAME_LABELS;
  return `(async () => {
    const action = ${JSON.stringify({ kind, dryRun, firstRealExecute, iconNameLabels })};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (node) => clean(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || node?.getAttribute?.("title") || node?.getAttribute?.("name") || "");
    const rawActionName = (node) => clean(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || node?.getAttribute?.("title") || node?.getAttribute?.("name") || "");
    const actionLabel = (node, fallback = "") => {
      const raw = textOf(node);
      if (action.iconNameLabels[raw]) return action.iconNameLabels[raw];
      const name = String(node?.getAttribute?.("name") || "").toLowerCase();
      if (raw.includes("暂停") || name.includes("pause")) return "暂停";
      if (raw.includes("编辑") || raw.includes("修改") || name.includes("edit")) return raw || "编辑";
      if (raw.includes("删除") || name.includes("delete")) return "删除";
      if (raw.includes("更多") || raw.includes("操作")) return raw;
      return raw || fallback;
    };
    const row = document.querySelector('[data-qianchuan-hover-target="1"]');
    if (!row) return { ok: false, step: "find_hover_row", error: "hover_row_not_found", url: location.href, title: document.title };
    const rowText = clean(row.innerText || row.textContent || "");
    const buttons = Array.from(row.querySelectorAll("button, [role=button], a, iconpark-icon, [data-auto-id='popover-hover-slot']")).filter(isVisible);
    const visibleButtons = buttons.map((button) => actionLabel(button)).filter(Boolean);
    const patternsByKind = {
      pause: ["暂停", "关停", "停止"],
      end: ["结束", "终止", "停止", "删除"],
      budget: ["编辑", "修改", "调控", "操作"],
      duration: ["编辑", "修改", "调控", "操作"],
      roi: ["编辑", "修改", "调控", "操作"]
    };
    const targetPatterns = patternsByKind[action.kind] || ["编辑", "修改", "调控", "操作", "暂停"];
    const byText = (items, patterns) => items.find((button) => {
      const label = actionLabel(button);
      const name = String(button?.getAttribute?.("name") || "").toLowerCase();
      return patterns.some((pattern) => label.includes(pattern) || (pattern === "暂停" && name.includes("pause")) || (["编辑", "修改", "调控", "操作"].includes(pattern) && name.includes("edit")));
    });
    const direct = byText(buttons, targetPatterns);
    const clearMark = () => row.removeAttribute("data-qianchuan-hover-target");
    if (direct) {
      const clickedText = rawActionName(direct);
      const clickedLabel = actionLabel(direct, clickedText);
      if (action.dryRun) {
        clearMark();
        return { ok: true, step: "hover_button_ready", dryRun: true, wouldClick: clickedText, wouldClickLabel: clickedLabel, rowText: rowText.slice(0, 500), visibleButtons, url: location.href, title: document.title };
      }
      window.__QIANCHUAN_EXECUTOR_LAST_OPEN_AT = Date.now();
      if (!action.dryRun && action.firstRealExecute) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      direct.click();
      clearMark();
      return { ok: true, step: "clicked_row_action", kind: action.kind, clickedText, clickedTextLabel: clickedLabel, rowText: rowText.slice(0, 500), visibleButtons, url: location.href, title: document.title };
    }

    const more = byText(buttons, ["更多", "操作", "...", "…"]);
    if (!more) {
      clearMark();
      return { ok: false, step: "find_button", error: "row_action_button_not_found", rowText: rowText.slice(0, 500), visibleButtons, url: location.href, title: document.title };
    }
    const moreText = actionLabel(more);
    if (action.dryRun) {
      clearMark();
      const wouldClick = targetPatterns[0] || moreText;
      return { ok: true, step: "hover_button_ready", dryRun: true, wouldClick, wouldClickLabel: action.iconNameLabels[wouldClick] || wouldClick, via: "more_menu", moreButtonText: moreText, rowText: rowText.slice(0, 500), visibleButtons, url: location.href, title: document.title };
    }

    more.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const menuSelectors = ".ovui-dropdown-menu, [role='menu'], [class*='popper'], [class*='dropdown']";
    const menus = Array.from(document.querySelectorAll(menuSelectors)).filter(isVisible);
    const menuItems = menus.flatMap((menu) => Array.from(menu.querySelectorAll("button, [role=menuitem], [role=button], a, li, div")).filter(isVisible));
    const visibleMenuItems = menuItems.map((item) => actionLabel(item)).filter(Boolean);
    const menuTarget = byText(menuItems, targetPatterns);
    if (!menuTarget) {
      clearMark();
      return { ok: false, step: "find_menu_button", error: "dropdown_action_button_not_found", rowText: rowText.slice(0, 500), visibleButtons, visibleMenuItems, via: "more_menu", url: location.href, title: document.title };
    }
    const menuText = rawActionName(menuTarget);
    const menuLabel = actionLabel(menuTarget, menuText);
    window.__QIANCHUAN_EXECUTOR_LAST_OPEN_AT = Date.now();
    if (!action.dryRun && action.firstRealExecute) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    menuTarget.click();
    clearMark();
    return { ok: true, step: "clicked_row_action", kind: action.kind, clickedText: menuText, clickedTextLabel: menuLabel, via: "more_menu", moreButtonText: moreText, rowText: rowText.slice(0, 500), visibleButtons, visibleMenuItems, url: location.href, title: document.title };
  })()`;
}

function buildFollowupExpression(action, openedAt) {
  const payload = action.payload || {};
  const budget = Number(payload.budget || payload.newBudget || payload.budgetIncrease);
  const durationHours = Number(payload.durationHours || payload.newDurationHours || payload.extendHours);
  const kind = actionKind(action.type);
  return `(async () => {
    const targetRoi = Number(${JSON.stringify(action.payload || {})}.targetRoi ?? ${JSON.stringify(action.payload || {})}.roi);
    const action = ${JSON.stringify({ kind, budget, durationHours, openedAt })};
    action.targetRoi = targetRoi;
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const visible = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const lastOpenAt = Number(window.__QIANCHUAN_EXECUTOR_LAST_OPEN_AT || action.openedAt || 0);
    const isRecent = !lastOpenAt || Date.now() - lastOpenAt <= 5000;
    const dialogSelectors = ".ovui-modal, .ovui-popconfirm, .ovui-dialog, [role='dialog'], [class*='modal'], [class*='popover'], [class*='popconfirm']";
    const dialogs = Array.from(document.querySelectorAll(dialogSelectors)).filter(isVisible);
    const recentDialogs = dialogs.filter((dialog) => {
      const text = clean(dialog.innerText || dialog.textContent || "");
      return isRecent && text && /(预算|金额|加量|出价|时长|小时|结束|确认|确定|提交|保存|暂停|关停|停止)/.test(text);
    });
    const dialog = recentDialogs.at(-1);
    if (!dialog) return { ok: true, step: "opened_dialog", inputChanged: false, warning: "confirm_dialog_not_visible", url: location.href, title: document.title };
    const buttons = visible(dialog, "button, [role=button], a");
    const buttonByText = (patterns) => buttons.find((button) => patterns.some((pattern) => clean(button.innerText || button.textContent || button.getAttribute("aria-label") || "").includes(pattern)));
    const enabledInputs = () => visible(dialog, "input").filter((input) => !input.disabled && !input.readOnly);
    const inputContext = (input) => clean(input.closest("label, .ovui-form-item, .form-item, [class*='form'], [class*='item'], div")?.innerText || "");
    const findInputWithScroll = async (contextPattern, attributePattern, exclude = null) => {
      const find = () => enabledInputs().find((item) => item !== exclude && (contextPattern.test(inputContext(item)) || attributePattern.test(clean(item.placeholder || item.name || item.id || ""))));
      let input = find();
      if (input) return input;
      const scrollTargets = [dialog, ...visible(dialog, "[class*='body'], [class*='content'], [class*='scroll']")]
        .filter((item, index, list) => list.indexOf(item) === index)
        .filter((item) => item.scrollHeight > item.clientHeight + 40);
      for (const target of scrollTargets) {
        const maxTop = Math.max(0, target.scrollHeight - target.clientHeight);
        for (const top of [Math.round(maxTop * 0.35), Math.round(maxTop * 0.7), maxTop]) {
          target.scrollTop = top;
          target.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 250));
          input = find();
          if (input) return input;
        }
      }
      return null;
    };
    const setInputValue = (input, value) => {
      input.focus();
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    let inputChanged = false;
    const shouldSetBudget = action.kind === "budget" && Number.isFinite(action.budget) && action.budget > 0;
    const shouldSetDuration = action.kind === "duration" && Number.isFinite(action.durationHours) && action.durationHours > 0;
    const shouldSetRoi = action.kind === "roi" && Number.isFinite(action.targetRoi) && action.targetRoi > 0;
    if (action.kind === "budget" && !shouldSetBudget) {
      return { ok: false, step: "validate_payload", error: "budget_required", inputChanged, url: location.href, title: document.title };
    }
    if (action.kind === "duration" && !shouldSetDuration) {
      return { ok: false, step: "validate_payload", error: "duration_required", inputChanged, url: location.href, title: document.title };
    }
    if (action.kind === "roi" && !shouldSetRoi) {
      return { ok: false, step: "validate_payload", error: "target_roi_required", inputChanged, url: location.href, title: document.title };
    }
    let budgetInput = null;
    if (shouldSetBudget) {
      budgetInput = await findInputWithScroll(/预算|金额|加量|出价/, /budget|amount|price/i);
      const input = budgetInput;
      if (!input) return { ok: false, step: "find_budget_input", error: "budget_input_not_found", inputChanged, url: location.href, title: document.title };
      setInputValue(input, action.budget);
      inputChanged = true;
    }
    if (shouldSetDuration) {
      const input = await findInputWithScroll(/时长|小时|结束|投放时长|持续/, /duration|hour|time|end/i, budgetInput);
      if (!input) return { ok: false, step: "find_duration_input", error: "duration_input_not_found", inputChanged, url: location.href, title: document.title };
      setInputValue(input, action.durationHours);
      inputChanged = true;
    }
    if (shouldSetRoi) {
      const input = await findInputWithScroll(/ROI|roi|目标|出价/, /roi|target|bid/i, budgetInput);
      if (!input) return { ok: false, step: "find_roi_input", error: "roi_input_not_found", inputChanged, url: location.href, title: document.title };
      setInputValue(input, action.targetRoi);
      inputChanged = true;
    }
    const confirm = buttonByText(["确定", "确认", "提交", "保存"]);
    if (confirm) {
      confirm.click();
      return { ok: true, step: "confirmed_dialog", inputChanged, confirmText: clean(confirm.innerText || confirm.textContent || ""), url: location.href, title: document.title };
    }
    return { ok: true, step: "opened_dialog", inputChanged, warning: "confirm_button_not_found", url: location.href, title: document.title };
  })()`;
}

function buildPauseConfirmationExpression(action) {
  const kind = actionKind(action.type);
  return `(async () => {
    const action = ${JSON.stringify({ kind })};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const dialogSelectors = ".ovui-modal, .ovui-popconfirm, .ovui-dialog, [role='dialog'], [class*='modal'], [class*='popover'], [class*='popconfirm']";
    const expectedWords = action.kind === "end" ? ["结束", "终止", "停止"] : ["暂停", "关停", "停止"];
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastDialogText = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dialogs = Array.from(document.querySelectorAll(dialogSelectors))
        .filter(isVisible)
        .map((dialog) => ({ dialog, text: clean(dialog.innerText || dialog.textContent || "") }))
        .filter(({ text }) => /确认|确定/.test(text) && expectedWords.some((word) => text.includes(word)));
      let visibleButtons = [];
      for (const candidate of dialogs.slice().reverse()) {
        lastDialogText = candidate.text.slice(0, 300);
        const rawCandidates = Array.from(candidate.dialog.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit], [class*='button'], [class*='btn'], div, span"))
          .filter(isVisible);
        const buttonCandidates = Array.from(new Set(rawCandidates.map((node) => node.closest("button, [role=button], a, input[type=button], input[type=submit], [tabindex], [class*='button'], [class*='btn']") || node)));
        visibleButtons = buttonCandidates.map((button) => clean(button.innerText || button.textContent || button.getAttribute("aria-label") || button.value || "")).filter(Boolean).slice(0, 30);
        const confirm = buttonCandidates.find((button) => {
          const text = clean(button.innerText || button.textContent || button.getAttribute("aria-label") || button.value || "");
          return /^(确定|确认|提交)$/.test(text) && !button.disabled && button.getAttribute("aria-disabled") !== "true";
        });
        if (!confirm) continue;
        const confirmText = clean(confirm.innerText || confirm.textContent || confirm.getAttribute("aria-label") || "");
        confirm.click();
        return { ok: true, step: "pause_confirm_clicked", confirmText, dialogText: lastDialogText, url: location.href, title: document.title };
      }
      if (dialogs.length) return { ok: false, step: "pause_confirmation", error: "pause_confirm_button_not_found", dialogText: lastDialogText, visibleButtons, url: location.href, title: document.title };
      await wait(500);
    }
    return { ok: false, step: "pause_confirmation", error: "pause_confirm_dialog_not_found", dialogText: lastDialogText, url: location.href, title: document.title };
  })()`;
}

function buildVerifyPausedExpression(action) {
  const payload = action.payload || {};
  const taskNeedle = String(payload.taskId || payload.taskName || "").trim();
  const taskId = taskIdFromNeedle(taskNeedle);
  return `(async () => {
    const task = ${JSON.stringify({ taskNeedle, taskId })};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const matchesTask = (text) => {
      const normalized = clean(text);
      if (task.taskId) {
        const idPattern = new RegExp("(^|\\\\D)ID[：:]?\\\\s*" + task.taskId + "(?!\\\\d)");
        return idPattern.test(normalized) || new RegExp("(^|\\\\D)" + task.taskId + "(?!\\\\d)").test(normalized);
      }
      return task.taskNeedle && normalized.includes(task.taskNeedle);
    };
    const rowSelectors = "tr,[role='row'],[class*='table-row'],[class*='TableRow'],[class*='table_row'],[class*='list-item'],[class*='ListItem']";
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastRowText = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = Array.from(document.querySelectorAll(rowSelectors))
        .filter(isVisible)
        .find((node) => matchesTask(node.innerText || node.textContent || ""));
      if (row) {
        lastRowText = clean(row.innerText || row.textContent || "").slice(0, 500);
        const statusMatch = lastRowText.match(/(调控暂停|已暂停|暂停中|调控结束|已结束|调控中|进行中)/);
        const status = statusMatch?.[1] || "";
        if (/(调控暂停|已暂停|暂停中|调控结束|已结束)/.test(status)) return { ok: true, step: "pause_status_verified", status, rowText: lastRowText, url: location.href, title: document.title };
        if (attempt === 4) return { ok: false, step: "pause_status_verified", error: "task_still_active", status: status || "unknown", rowText: lastRowText, url: location.href, title: document.title };
      }
      await wait(700);
    }
    return { ok: false, step: "pause_status_verified", error: "pause_status_not_verified", rowText: lastRowText, url: location.href, title: document.title };
  })()`;
}

function isVerifiedPauseResult(confirmation = {}, verification = {}) {
  return confirmation?.ok === true
    && confirmation.step === "pause_confirm_clicked"
    && verification?.ok === true
    && /(调控暂停|已暂停|暂停中|调控结束|已结束)/.test(String(verification.status || ""));
}

function buildCreateTaskExpression(action, dryRun) {
  const payload = action.payload || {};
  const type = String(action.type || "");
  const createKind = type === "create_oneclick_task" ? "oneclick" : "boost";
  return `(async () => {
    const action = ${JSON.stringify({
      id: action.id,
      type,
      createKind,
      dryRun,
      payload: {
        boostType: payload.boostType || payload.type || "materialBoost",
        budget: payload.budget,
        durationHours: payload.durationHours,
        targetRoi: payload.targetRoi,
        payRoi: payload.payRoi,
        bidPrice: payload.bidPrice,
        materialId: payload.materialId,
        materialIds: normalizeMaterialIds(payload.materialIds, payload.materialId),
        useLiveRoomImage: payload.useLiveRoomImage !== false,
      },
    })};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (node) => clean(node?.innerText || node?.textContent || node?.getAttribute?.("aria-label") || node?.getAttribute?.("title") || node?.getAttribute?.("placeholder") || "");
    const visible = (selector, root = document) => Array.from(root.querySelectorAll(selector)).filter(isVisible);
    const byText = (selector, patterns, root = document) => visible(selector, root).find((node) => patterns.some((pattern) => textOf(node).includes(pattern)));
    const clickByText = async (selector, patterns, step, root = document) => {
      const node = byText(selector, patterns, root);
      if (!node) return { ok: false, step, error: "target_not_found", patterns, url: location.href, title: document.title };
      node.scrollIntoView({ block: "center", inline: "center" });
      await wait(120);
      node.click();
      return { ok: true, step, text: textOf(node).slice(0, 80) };
    };
    const clickExactByText = async (values, step, root = document) => {
      const node = visible("button, [role=button], a", root).find((item) => values.includes(textOf(item)));
      if (!node) return { ok: false, step, error: "target_not_found", values, url: location.href, title: document.title };
      node.scrollIntoView({ block: "center", inline: "center" });
      await wait(120);
      node.click();
      return { ok: true, step, text: textOf(node) };
    };
    const exactText = (node) => textOf(node).replace(/\\s+/g, " ");
    const candidateRowsForMaterial = (materialId) => Array.from(new Set(visible("tr, [role=row], [class*='table-row'], [class*='TableRow'], [class*='row'], [class*='item'], li")
      .filter((node) => exactText(node).includes(String(materialId)))
      .map((node) => node.closest("tr, [role=row], [class*='table-row'], [class*='TableRow'], [class*='row'], [class*='item'], li") || node)))
      .filter((node) => exactText(node).includes(String(materialId)))
      .sort((a, b) => exactText(a).length - exactText(b).length);
    const pickMaterialControl = (row) => visible("input[type='checkbox'], [role='checkbox'], .ovui-checkbox, [class*='checkbox'], label", row)
      .find((node) => !node.disabled && node.getAttribute("aria-disabled") !== "true") || row;
    const dialogSelectors = "[role=dialog], .ovui-modal, .ovui-dialog, .ovui-drawer, [class*='modal'], [class*='dialog'], [class*='drawer']";
    const activeDialogFor = (needle = "") => visible(dialogSelectors)
      .filter((node) => !needle || exactText(node).includes(needle))
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0] || null;
    const inputContext = (input) => clean(input.closest("label, .ovui-form-item, .form-item, [class*='form'], [class*='item'], div")?.innerText || "");
    const setInput = (input, value) => {
      input.focus();
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const fillInput = (patterns, value, step) => {
      if (value === undefined || value === null || value === "") return { ok: true, step, skipped: true };
      const inputs = visible("input").filter((input) => !input.disabled && !input.readOnly);
      const input = inputs.find((item) => patterns.some((pattern) => inputContext(item).includes(pattern) || clean(item.placeholder || item.name || item.id || "").includes(pattern)));
      if (!input) return { ok: false, step, error: "input_not_found", patterns, url: location.href, title: document.title };
      setInput(input, value);
      return { ok: true, step, value };
    };
    const steps = [];
    if (action.createKind === "boost") {
      const tab = await clickByText("button, [role=tab], [role=button], a, div", ["素材"], "click_material_tab");
      steps.push(tab);
      if (!tab.ok) return { ok: false, dryRun: action.dryRun, steps };
      await wait(800);
      const create = await clickByText("button, [role=button], a", ["新建追投", "追投", "新建"], "click_create_boost");
      steps.push(create);
      if (!create.ok) return { ok: false, dryRun: action.dryRun, steps };
      await wait(1000);
      if (/materialCostControl/i.test(String(action.payload.boostType || ""))) {
        const costControl = await clickByText("button, [role=tab], [role=button], label, a, div", ["控成本", "成本控制"], "choose_cost_control");
        steps.push(costControl);
        if (!costControl.ok) return { ok: false, dryRun: action.dryRun, steps };
        await wait(500);
        const mode = action.payload.bidPrice ? ["直播出价", "自定义出价", "出价"] : ["支付ROI", "支付 ROI"];
        const modeResult = await clickByText("button, [role=tab], [role=button], label, a, div", mode, "choose_cost_control_mode");
        steps.push(modeResult);
        if (!modeResult.ok) return { ok: false, dryRun: action.dryRun, steps };
        await wait(400);
      }
      if (action.payload.useLiveRoomImage) {
        const live = await clickByText("button, [role=button], label, div", ["直播间画面", "直播画面"], "choose_live_room_image");
        steps.push(live);
        if (!live.ok) return { ok: false, dryRun: action.dryRun, steps };
        await wait(400);
      } else if (action.payload.materialIds?.length) {
        const openPicker = await clickByText("button, [role=button], a", ["添加视频", "添加素材"], "open_material_picker");
        steps.push(openPicker);
        if (!openPicker.ok) return { ok: false, dryRun: action.dryRun, steps };
        await wait(700);
        for (const materialId of action.payload.materialIds) {
          const row = candidateRowsForMaterial(materialId)[0];
          if (!row) return { ok: false, dryRun: action.dryRun, step: "find_material", error: "material_id_not_found", materialId, steps, url: location.href, title: document.title };
          row.scrollIntoView({ block: "center", inline: "center" });
          const checkbox = pickMaterialControl(row);
          steps.push({ ok: true, step: "find_material", materialId, rowText: textOf(row).slice(0, 160) });
          checkbox.click();
          await wait(400);
        }
        const picker = activeDialogFor(String(action.payload.materialIds[0] || ""));
        const confirmPicker = await clickExactByText(["确定", "确认", "添加", "完成"], "confirm_material_picker", picker || document);
        steps.push(confirmPicker);
        if (!confirmPicker.ok) return { ok: false, dryRun: action.dryRun, steps };
        await wait(700);
        const createDialog = activeDialogFor("已添加") || activeDialogFor("调控预算") || activeDialogFor("追投素材");
        const createText = exactText(createDialog || document.body);
        const addedMatch = createText.match(/已添加\\s*[：:]\\s*(\\d+)\\s*\\/\\s*20/);
        const addedCount = Number(addedMatch?.[1] || 0);
        if (!Number.isFinite(addedCount) || addedCount < action.payload.materialIds.length) {
          return { ok: false, dryRun: action.dryRun, step: "verify_materials_added", error: "materials_not_added_to_create_form", addedCount, expectedCount: action.payload.materialIds.length, steps, url: location.href, title: document.title };
        }
        steps.push({ ok: true, step: "verify_materials_added", addedCount });
      }
    } else {
      window.scrollTo({ top: document.body.scrollHeight * 0.45, behavior: "instant" });
      await wait(300);
      const create = await clickByText("button, [role=button], a", ["新建", "一键起量"], "click_create_oneclick");
      steps.push(create);
      if (!create.ok) return { ok: false, dryRun: action.dryRun, steps };
      await wait(1000);
      const purchase = byText("button, [role=tab], [role=button], label, a, div", ["直播间购买"]);
      if (purchase) {
        purchase.scrollIntoView({ block: "center", inline: "center" });
        purchase.click();
        steps.push({ ok: true, step: "choose_live_room_purchase", text: textOf(purchase) });
        await wait(400);
      } else {
        steps.push({ ok: true, step: "choose_live_room_purchase", warning: "live_room_purchase_not_found" });
      }
      if (action.payload.useLiveRoomImage) {
        const materialTab = await clickByText("button, [role=tab], [role=button], a, div", ["素材"], "click_material_source");
        steps.push(materialTab);
        await wait(400);
        const live = await clickByText("button, [role=button], label, div", ["直播间画面", "直播画面"], "choose_live_room_image");
        steps.push(live);
        await wait(400);
      }
    }
    for (const item of [
      fillInput(["预算", "金额"], action.payload.budget, "fill_budget"),
      fillInput(["时长", "小时", "持续"], action.payload.durationHours, "fill_duration"),
      fillInput(["ROI", "roi", "目标"], action.payload.targetRoi, "fill_roi"),
      fillInput(["支付ROI", "支付 ROI"], action.payload.payRoi, "fill_pay_roi"),
      fillInput(["直播出价", "自定义出价", "出价"], action.payload.bidPrice, "fill_bid_price"),
    ]) {
      steps.push(item);
      if (!item.ok) return { ok: false, dryRun: action.dryRun, steps };
    }
    const confirm = byText("button, [role=button], a", ["确定", "确认", "提交", "创建"]);
    if (!confirm) return { ok: false, dryRun: action.dryRun, step: "find_confirm", error: "confirm_button_not_found", steps, url: location.href, title: document.title };
    confirm.scrollIntoView({ block: "center", inline: "center" });
    steps.push({ ok: true, step: action.dryRun ? "confirm_ready" : "click_confirm", text: textOf(confirm) });
    if (action.dryRun) return { ok: true, dryRun: true, wouldClick: textOf(confirm), wouldClickLabel: textOf(confirm), steps, url: location.href, title: document.title };
    confirm.click();
    await wait(1000);
    const final = byText("button, [role=button], a", ["确定", "确认", "我知道了", "提交"]);
    if (final && isVisible(final)) {
      steps.push({ ok: true, step: "click_final_confirm", text: textOf(final) });
      final.click();
    }
    return { ok: true, dryRun: false, steps, url: location.href, title: document.title };
  })()`;
}

async function getOrOpenQianchuanClient(cdpUrl, targetUrl, expectedAccountId) {
  let tabs = await listTabs(cdpUrl);
  let tab = tabs
    .filter((item) => item.type === "page" && String(item.url || "").includes("qianchuan.jinritemai.com"))
    .filter((item) => !expectedAccountId || String(item.url || "").includes(`aavid=${expectedAccountId}`))
    .sort((a, b) => scoreQianchuanTab(b) - scoreQianchuanTab(a))[0];
  if (!tab) {
    tab = await openTab(cdpUrl, targetUrl);
  }
  const client = connect(tab.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Page.navigate", { url: targetUrl });
  await wait(2500);
  return { client, tab };
}

function createTargetUrl(action, expectedAccountId) {
  const accountId = expectedAccountId || action.payload?.accountId || process.env.QIANCHUAN_ACCOUNT_ID || "";
  if (action.type === "create_oneclick_task") {
    return `https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${encodeURIComponent(accountId)}`;
  }
  const tab = action.type === "create_boost_task" ? "material" : "uni_task_center";
  return `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${encodeURIComponent(accountId)}&uniDetail=%7B%7D#uniDetail=${encodeURIComponent(JSON.stringify({ tb: tab }))}`;
}

function scoreActionTab(tab = {}, action = {}) {
  const url = String(tab.url || "");
  const title = String(tab.title || "");
  let score = 0;
  if (tab.type === "page") score += 10;
  if (url.includes("qianchuan.jinritemai.com")) score += 20;
  if (url.includes("/uni-prom/detail")) score += 80;
  if (url.includes("uni_task_center")) score += 80;
  if (url.includes("%22tb%22%3A%22uni_task_center%22") || url.includes('"tb":"uni_task_center"')) score += 80;
  if (title.includes("投放管理")) score += 20;
  if (url.includes("/uni-prom/overall")) score += 10;
  if (url.includes("/board-next") || title.includes("直播大屏")) score -= 120;
  if (isCreateAction(action.type)) score += scoreQianchuanTab(tab);
  return score;
}

async function executeCreateAction(action, options = {}) {
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const dataDir = options.dataDir;
  const expectedAccountId = options.expectedAccountId;
  const dryRun = options.dryRun === true;
  const targetUrl = createTargetUrl(action, expectedAccountId);
  const attempts = [];
  const { client, tab } = await getOrOpenQianchuanClient(cdpUrl, targetUrl, expectedAccountId);
  try {
    const beforeScreenshot = await capture(client, dataDir, action.id, "before");
    const run = await client.send("Runtime.evaluate", {
      expression: buildCreateTaskExpression(action, dryRun),
      returnByValue: true,
      awaitPromise: true,
    });
    const result = run.result?.value || {};
    attempts.push({ tabUrl: tab.url, title: tab.title, result, beforeScreenshot });
    const afterScreenshot = await capture(client, dataDir, action.id, dryRun ? "preview" : "after");
    client.close();
    if (dryRun) return { ok: result.ok === true, dryRun: true, wouldClick: result.wouldClick || "确定", wouldClickLabel: result.wouldClickLabel || "确定", attempts, result, beforeScreenshot, afterScreenshot };
    return { ok: result.ok === true, attempts, result, beforeScreenshot, afterScreenshot };
  } catch (error) {
    attempts.push({ tabUrl: tab.url, title: tab.title, error: error.message });
    try {
      attempts[attempts.length - 1].failureScreenshot = await capture(client, dataDir, action.id, "create-failed");
    } catch {}
    client.close();
    return { ok: false, error: error.message, attempts };
  }
}

async function previewTask(params = {}, options = {}) {
  const type = String(params.type || "");
  const allowed = new Set(["materialBoost", "materialCostControlPayRoi", "materialCostControlBid", "oneClickLift", "liveScreenBoost"]);
  if (!allowed.has(type)) return { ok: false, error: "invalid_preview_task_type" };
  const oneclick = type === "oneClickLift";
  const liveScreenBoost = type === "liveScreenBoost";
  const action = {
    id: `preview-${Date.now()}`,
    type: oneclick ? "create_oneclick_task" : "create_boost_task",
    payload: {
      materialId: normalizeMaterialIds(params.materialIds, params.materialId)[0] || undefined,
      materialIds: normalizeMaterialIds(params.materialIds, params.materialId),
      budget: Number(params.budget),
      durationHours: Number(params.durationHours),
      targetRoi: (oneclick || type === "materialBoost") ? undefined : Number(params.targetRoi) || undefined,
      payRoi: type === "materialCostControlPayRoi" ? Number(params.payRoi) || Number(params.targetRoi) : undefined,
      bidPrice: type === "materialCostControlBid" ? Number(params.bidPrice) : undefined,
      boostType: type.startsWith("materialCostControl") ? "materialCostControl" : liveScreenBoost ? "liveScreenBoost" : "materialBoost",
      useLiveRoomImage: oneclick || liveScreenBoost,
    },
  };
  if (!Number.isFinite(action.payload.budget) || action.payload.budget <= 0) return { ok: false, error: "budget_required" };
  if (!Number.isFinite(action.payload.durationHours) || action.payload.durationHours <= 0) return { ok: false, error: "duration_required" };
  if (!oneclick && !liveScreenBoost && !action.payload.materialIds.length) return { ok: false, error: "material_id_required" };
  const liveSourceScreenshot = action.payload.useLiveRoomImage ? await captureLiveBoardScreenshot(options, action.id) : "";
  const result = await executeCreateAction(action, { ...options, dryRun: true });
  return {
    ok: result.ok === true,
    error: result.error || result.result?.error || result.result?.steps?.at(-1)?.error || "task_preview_failed",
    detail: result,
    screenshotPath: result.afterScreenshot || result.beforeScreenshot || "",
    liveSourceScreenshot,
    beforeFailureScreenshot: result.attempts?.at(-1)?.failureScreenshot || result.beforeScreenshot || "",
    formSummary: {
      type,
      materialId: action.payload.materialId || "直播间画面",
      materialIds: action.payload.materialIds,
      budget: action.payload.budget,
      durationHours: action.payload.durationHours,
      targetRoi: action.payload.targetRoi || action.payload.payRoi || null,
      payRoi: action.payload.payRoi || null,
      bidPrice: action.payload.bidPrice || null,
    },
    result,
  };
}

async function captureLiveBoardScreenshot(options = {}, actionId = "preview") {
  const tabs = await listTabs(options.cdpUrl || DEFAULT_CDP_URL);
  const board = tabs.find((tab) => tab.type === "page" && String(tab.url || "").includes("/board-next"));
  if (!board?.webSocketDebuggerUrl || !options.dataDir) return "";
  const client = connect(board.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable").catch(() => null);
    return await capture(client, options.dataDir, actionId, "live-source");
  } catch {
    return "";
  } finally {
    client.close();
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hoverRow(client, rowRect) {
  const x = Number(rowRect?.x);
  const y = Number(rowRect?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: 0 });
  await wait(50);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 2, y: y + 2, modifiers: 0 });
  await wait(50);
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: 0 });
  await wait(350);
}

async function capture(client, dataDir, actionId, phase) {
  ensureDir(path.join(dataDir, "execution"));
  const shot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const filename = `execution-${actionId}-${phase}-${Date.now()}.png`.replace(/[^\w.-]/g, "_");
  fs.writeFileSync(path.join(dataDir, "execution", filename), Buffer.from(shot.data || "", "base64"));
  return `/execution/${filename}`;
}

async function executeAction(action, options = {}) {
  if (isCreateAction(action.type)) return executeCreateAction(action, options);
  const cdpUrl = options.cdpUrl || DEFAULT_CDP_URL;
  const dataDir = options.dataDir;
  const expectedAccountId = options.expectedAccountId;
  const dryRun = options.dryRun === true;
  const firstRealExecute = options.firstRealExecute === true;
  const tabs = await listTabs(cdpUrl);
  const payload = action.payload || {};
  const taskNeedle = String(payload.taskId || payload.taskName || "").trim();
  if (!taskNeedle) throw new Error("missing_task_id_or_name");

  const candidates = tabs
    .filter((tab) => tab.type === "page" && String(tab.url || "").includes("qianchuan.jinritemai.com"))
    .filter((tab) => !expectedAccountId || String(tab.url || "").includes(`aavid=${expectedAccountId}`))
    .sort((a, b) => scoreActionTab(b, action) - scoreActionTab(a, action));
  const attempts = [];
  const tryTab = async (tab, preferredTabKind = taskTabKind(action)) => {
    const client = connect(tab.webSocketDebuggerUrl);
    try {
      await client.send("Page.enable").catch(() => null);
      const prepare = await client.send("Runtime.evaluate", {
        expression: buildPrepareTaskListExpression(action, preferredTabKind),
        returnByValue: true,
        awaitPromise: true,
      });
      const prepareValue = prepare.result?.value || {};
      const beforeScreenshot = await capture(client, dataDir, action.id, "before");
      const first = await client.send("Runtime.evaluate", {
        expression: buildExecuteExpression(action),
        returnByValue: true,
      });
      const firstValue = first.result?.value || {};
      const attempt = { tabUrl: tab.url, title: tab.title, preferredTabKind, prepare: prepareValue, first: firstValue, beforeScreenshot };
      attempts.push(attempt);
      if (!firstValue.ok) {
        attempt.failureScreenshot = await capture(client, dataDir, action.id, "locate-failed");
        client.close();
        return null;
      }
      await hoverRow(client, firstValue.rowRect);
      const hover = await client.send("Runtime.evaluate", {
        expression: buildHoverButtonExpression(action, dryRun, firstRealExecute),
        returnByValue: true,
        awaitPromise: true,
      });
      const hoverValue = hover.result?.value || {};
      attempt.hover = hoverValue;
      if (!hoverValue.ok) {
        attempt.failureScreenshot = await capture(client, dataDir, action.id, "hover-failed");
        client.close();
        return null;
      }
      if (dryRun) {
        client.close();
        const wouldClick = hoverValue.wouldClick || hoverValue.clickedText || "";
        return { ok: true, dryRun: true, wouldClick, wouldClickLabel: hoverValue.wouldClickLabel || clickLabel(wouldClick), attempts, result: hoverValue, beforeScreenshot };
      }
      const openedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const kind = actionKind(action.type);
      const confirmRequired = ["pause_task", "end_task"].includes(action.type);
      const valueOrError = (response, fallbackError) => {
        const value = response?.result?.value;
        if (value && typeof value === "object") return value;
        const detail = String(response?.exceptionDetails?.exception?.description || response?.exceptionDetails?.text || "").replace(/\s+/g, " ").trim();
        return { ok: false, error: detail ? `${fallbackError}:${detail.slice(0, 240)}` : fallbackError };
      };
      let followValue = {};
      let verificationValue = {};
      if (confirmRequired) {
        const confirmation = await client.send("Runtime.evaluate", {
          expression: buildPauseConfirmationExpression(action),
          returnByValue: true,
          awaitPromise: true,
        });
        followValue = valueOrError(confirmation, "pause_confirmation_evaluation_failed");
        if (followValue.ok === true) {
          const verification = await client.send("Runtime.evaluate", {
            expression: buildVerifyPausedExpression(action),
            returnByValue: true,
            awaitPromise: true,
          });
          verificationValue = valueOrError(verification, "pause_status_verification_evaluation_failed");
        }
      } else {
        const follow = await client.send("Runtime.evaluate", {
          expression: buildFollowupExpression(action, openedAt),
          returnByValue: true,
          awaitPromise: true,
        });
        followValue = valueOrError(follow, "followup_evaluation_failed");
        if (followValue.warning === "confirm_dialog_not_visible") {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const retry = await client.send("Runtime.evaluate", {
            expression: buildFollowupExpression(action, openedAt),
            returnByValue: true,
            awaitPromise: true,
          });
          followValue = valueOrError(retry, "followup_evaluation_failed");
        }
      }
      const afterScreenshot = await capture(client, dataDir, action.id, "after");
      client.close();
      const editRequired = ["budget", "duration", "roi"].includes(kind);
      let followupError = followValue.ok === false ? followValue.error || "followup_failed" : "";
      if (!followupError && confirmRequired && !isVerifiedPauseResult(followValue, verificationValue)) {
        followupError = verificationValue.error || "pause_status_not_verified";
      }
      if (!followupError && editRequired && followValue.warning) {
        followupError = followValue.warning || "edit_dialog_not_visible";
      }
      if (!followupError && editRequired && followValue.inputChanged !== true) {
        followupError = "edit_input_not_changed";
      }
      if (!followupError && editRequired && followValue.step !== "confirmed_dialog") {
        followupError = followValue.warning || "edit_confirm_not_clicked";
      }
      if (followupError) {
        return { ok: false, error: followupError, attempts, result: hoverValue, followup: followValue, verification: verificationValue, beforeScreenshot, afterScreenshot };
      }
      return { ok: true, attempts, result: hoverValue, followup: followValue, verification: verificationValue, beforeScreenshot, afterScreenshot };
    } catch (error) {
      attempts.push({ tabUrl: tab.url, title: tab.title, error: error.message });
      client.close();
      return null;
    }
  };
  for (const tab of candidates) {
    const result = await tryTab(tab);
    if (result) return result;
    if (taskTabKind(action) !== "oneclick") continue;
    const fallbackKindResult = await tryTab(tab, "material");
    if (fallbackKindResult) return fallbackKindResult;
  }
  const targetUrl = createTargetUrl(action, expectedAccountId);
  const opened = await openTab(cdpUrl, targetUrl);
  await wait(2500);
  const fallbackResult = await tryTab(opened);
  if (fallbackResult) {
    fallbackResult.openedFallbackTab = true;
    return fallbackResult;
  }
  return { ok: false, error: "action_target_not_found_or_not_clickable", attempts };
}

module.exports = { executeAction, previewTask, isVerifiedPauseResult, buildFollowupExpression, buildCreateTaskExpression };
