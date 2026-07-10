const defaults = {
  roomName: "示例直播间",
  accountName: "示例账户",
  accountId: "",
  openTime: "06:00",
  closeTime: "02:00",
  frequency: "5",
  targetRoi: "6.5",
  roomStage: "normal",
};

const fields = [
  "roomName",
  "accountName",
  "accountId",
  "openTime",
  "closeTime",
  "frequency",
  "targetRoi",
  "roomStage",
  "overallCost",
  "baseSpend",
  "currentHourRoi",
  "currentHourCost",
  "oneClickLiftStatus",
  "oneClickLiftSpend",
  "overallRoi",
  "flowSpeed",
  "boostTasks",
  "taskNotes",
];

const $ = (id) => document.getElementById(id);
const savedTheme = localStorage.getItem("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
let taskRowId = 0;
let lastExtensionTimestamp = null;
const manualInputKey = "manual_dashboard_fields";
const manualInputIds = ["currentHourRoi", "currentHourCost", "oneClickLiftStatus", "oneClickLiftSpend"];

function numberValue(id) {
  const value = parseFloat($(id).value);
  return Number.isFinite(value) ? value : null;
}

function percent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

function money(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stageLabel(value) {
  return {
    normal: "正常承接",
    opening: "开播前 1 小时",
    handoff: "主播换播/交接",
    weak: "承接偏弱",
    strong: "承接强",
  }[value] || "未确认";
}

function classify({ overallCost, currentHourRoi, currentHourCost, hourSpendAverage, flowSpeed }) {
  const hasSpend = Number.isFinite(overallCost);
  const hasRoi = Number.isFinite(currentHourRoi);
  const spendHigh = Number.isFinite(currentHourCost) && Number.isFinite(hourSpendAverage)
    ? currentHourCost >= hourSpendAverage
    : hasSpend && (overallCost >= 10000 || (Number.isFinite(flowSpeed) && flowSpeed >= 100));
  const roiHigh = hasRoi && currentHourRoi >= 6.5;

  if (!hasSpend || !hasRoi) {
    return {
      key: "unknown",
      label: "数据不足",
      action: "复盘异常",
      tone: "muted",
    };
  }

  if (!spendHigh && roiHigh) return { key: "lowSpendHighRoi", label: "低消耗 · 高 ROI", action: "准备放量", tone: "green" };
  if (spendHigh && roiHigh) return { key: "highSpendHighRoi", label: "高消耗 · 高 ROI", action: "续追投/维稳", tone: "green" };
  if (spendHigh && !roiHigh) return { key: "highSpendLowRoi", label: "高消耗 · 低 ROI", action: "暂停追投/控量", tone: "red" };
  return { key: "lowSpendLowRoi", label: "低消耗 · 低 ROI", action: "诊断后小测", tone: "amber" };
}

function buildAdvice(data, quadrant, boostShare) {
  const reasons = [];
  const suggestions = [];
  const risks = [];

  if (!Number.isFinite(data.overallCost)) reasons.push("缺少综合成本，无法判断整体消耗速度。");
  if (!Number.isFinite(data.baseSpend)) reasons.push("缺少基础消耗，无法计算追投占比。");
  if (!Number.isFinite(data.currentHourRoi)) reasons.push("缺少投放数据里的小时 ROI。");
  if (!Number.isFinite(data.overallRoi)) reasons.push("缺少直播大屏综合 ROI。");
  if (!Number.isFinite(data.flowSpeed)) reasons.push("缺少千川乘方直播大屏 5 分钟流速。");

  if (Number.isFinite(boostShare)) {
    if (boostShare > 0.3) risks.push("追投占比已超过 30%，需要优先检查追投是否挤压基础消耗。");
    if (boostShare < 0.2) reasons.push("追投占比处于相对保守区间，仍有小额测试空间。");
  }

  const weakTasks = data.tasks.filter((task) => Number.isFinite(task.roi) && task.roi < Math.max(3.5, data.targetRoi * 0.65));
  const runningTasks = data.tasks.filter((task) => task.status === "调控中" || task.status === "跑量中" || task.pacing === "放量中");
  if (weakTasks.length > 0) risks.push(`${weakTasks.length} 条追投任务 ROI 偏低，需要检查是否继续消耗。`);
  if (runningTasks.length > 1 && Number.isFinite(boostShare) && boostShare > 0.3) {
    suggestions.push("追投任务数量和占比都偏高，先逐条看预算、剩余时间和实时 ROI，再决定是否收缩。");
  }

  if (data.roomStage === "handoff") {
    risks.push("当前处于换播/交接阶段，避免多笔高预算追投。");
    suggestions.push("先观察在线和实时成交稳定性，只保留小额测试或维持基础流量。");
  }

  if (data.roomStage === "weak") {
    risks.push("主播承接偏弱，消耗放大可能导致 ROI 下滑。");
    suggestions.push("优先用基础消耗稳定 ROI，减少频繁调控。");
  }

  if (quadrant.key === "lowSpendHighRoi") {
    reasons.push("当前更接近低消耗高 ROI：投产可用但跑量不足。");
    suggestions.push("优先检查直播间承接，如果状态健康，用 200-300 元、1 小时的小额追投测试补流。");
  }

  if (quadrant.key === "highSpendHighRoi") {
    reasons.push("当前更接近高消耗高 ROI：可以维稳，不宜频繁改 ROI 目标。");
    suggestions.push("保留主力素材，追投预算控制在主计划预算 20%-30% 内，半小时后再判断是否续 100-200 元。");
  }

  if (quadrant.key === "highSpendLowRoi") {
    reasons.push("当前更接近高消耗低 ROI：消耗速度和转化效率不匹配。");
    suggestions.push("先暂停或收缩额外追投，必要时建议抬高 ROI 目标 5%-10%，动作前需要你确认。");
    risks.push("继续放量可能形成高流速低产出，影响下一小时竞争力。");
  }

  if (quadrant.key === "lowSpendLowRoi") {
    reasons.push("当前更接近低消耗低 ROI：先诊断素材、货品、主播状态和页面数据。");
    suggestions.push("不要直接大额放量，可先用控成本方式测试高点击/高转化素材。");
  }

  if (quadrant.key === "unknown") {
    suggestions.push("先补齐综合成本、基础消耗、小时 ROI、综合 ROI、5 分钟流速，再生成投放建议。");
    risks.push("数据缺口过多时不应给出新建、暂停、加预算等动作。");
  }

  return {
    reason: reasons.join(" "),
    suggestion: suggestions.join(" "),
    risk: risks.join(" ") || "动作前仍需二次确认账号、页面、日期、预算和目标值。",
  };
}

function reviewItems(data) {
  const items = [
    {
      title: "综合成本",
      ok: Number.isFinite(data.overallCost),
      detail: "来自投放管理 / overall，用于判断整体消耗和计算追投占比。",
    },
    {
      title: "基础消耗",
      ok: Number.isFinite(data.baseSpend),
      detail: "来自投放管理 / overall，追投占比 = (综合成本 - 基础消耗) / 综合成本。",
    },
    {
      title: "小时 ROI",
      ok: Number.isFinite(data.currentHourRoi),
      detail: "来自投放数据的小时行，不用 5 分钟流速替代。",
    },
    {
      title: "直播大屏综合 ROI",
      ok: Number.isFinite(data.overallRoi),
      detail: "以直播大屏显示的综合 ROI 为准。",
    },
    {
      title: "5 分钟流速",
      ok: Number.isFinite(data.flowSpeed),
      detail: "来自千川乘方直播大屏，是判断当下流量是否达标的关键。",
    },
    {
      title: "追投任务详情",
      ok: data.tasks.length > 0 || data.taskNotes.trim().length > 0 || data.boostTasks === 0,
      detail: "在投放数据 -> 调控中逐条记录任务名称、调控类型、预算、目标 ROI、调控消耗、成交金额、调控支付 ROI、展示点击和跑量判断。",
    },
    {
      title: "直播间阶段",
      ok: data.roomStage !== "normal" || true,
      detail: "换播、开播首小时、承接偏弱时，建议更保守。",
    },
  ];

  return items;
}

function elapsedHoursSinceOpen(openTime) {
  const [hour, minute] = (openTime || "06:00").split(":").map(Number);
  const now = new Date();
  const start = new Date(now);
  start.setHours(hour || 0, minute || 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return Math.max((now - start) / 3600000, 1);
}

function collectData() {
  const overallCost = numberValue("overallCost");
  const baseSpend = numberValue("baseSpend");
  const currentHourRoi = numberValue("currentHourRoi");
  const currentHourCost = numberValue("currentHourCost");
  const oneClickLiftStatus = $("oneClickLiftStatus").value;
  const oneClickLiftSpend = oneClickLiftStatus === "on" ? numberValue("oneClickLiftSpend") : 0;
  const overallRoi = numberValue("overallRoi");
  const flowSpeed = numberValue("flowSpeed");
  const manualBoostTasks = numberValue("boostTasks") ?? 0;
  const targetRoi = numberValue("targetRoi") ?? 6.5;
  const tasks = collectTasks();
  const boostTasks = tasks.length > 0 ? tasks.length : manualBoostTasks;

  return {
    roomName: $("roomName").value.trim(),
    accountName: $("accountName").value.trim(),
    accountId: $("accountId").value.trim(),
    openTime: $("openTime").value,
    closeTime: $("closeTime").value,
    frequency: $("frequency").value,
    targetRoi,
    roomStage: $("roomStage").value,
    overallCost,
    baseSpend,
    currentHourRoi,
    currentHourCost,
    hourSpendAverage: Number.isFinite(overallCost) ? overallCost / elapsedHoursSinceOpen($("openTime").value) : null,
    oneClickLiftStatus,
    oneClickLiftSpend,
    overallRoi,
    flowSpeed,
    boostTasks,
    tasks,
    taskNotes: $("taskNotes").value.trim(),
  };
}

function collectTasks() {
  return Array.from(document.querySelectorAll("#taskTableBody tr")).map((row) => {
    const read = (selector) => row.querySelector(selector)?.value.trim() || "";
    const num = (selector) => {
      const value = parseFloat(read(selector));
      return Number.isFinite(value) ? value : null;
    };
    return {
      name: read(".task-name"),
      type: read(".task-type"),
      object: read(".task-object"),
      status: read(".task-control-status"),
      budget: num(".task-budget"),
      targetRoi: num(".task-target-roi"),
      duration: read(".task-duration"),
      spend: num(".task-spend"),
      dealAmount: num(".task-deal"),
      roi: num(".task-roi"),
      impressions: num(".task-impressions"),
      clicks: num(".task-clicks"),
      pacing: read(".task-pacing"),
      unknownBoostMethod: row.dataset.unknownBoostMethod || "",
    };
  }).filter((task) => Object.values(task).some((value) => value !== "" && value !== null));
}

function taskSummary(tasks) {
  if (tasks.length === 0) return "";
  return tasks.map((task, index) => {
    const parts = [
      `${index + 1}. ${task.name || "未命名任务"}`,
      task.type ? `类型${task.type}` : "",
      task.object ? `对象/目标${task.object}` : "",
      task.status ? `状态${task.status}` : "",
      Number.isFinite(task.budget) ? `预算${money(task.budget)}` : "",
      Number.isFinite(task.targetRoi) ? `目标ROI${task.targetRoi}` : "",
      task.duration ? `时长/结束${task.duration}` : "",
      Number.isFinite(task.spend) ? `消耗${money(task.spend)}` : "",
      Number.isFinite(task.dealAmount) ? `成交${money(task.dealAmount)}` : "",
      Number.isFinite(task.roi) ? `ROI${task.roi}` : "",
      Number.isFinite(task.impressions) ? `展示${money(task.impressions)}` : "",
      Number.isFinite(task.clicks) ? `点击${money(task.clicks)}` : "",
      task.pacing ? `跑量${task.pacing}` : "",
      task.unknownBoostMethod ? `未识别追投类型：${task.unknownBoostMethod}` : "",
    ].filter(Boolean);
    return parts.join("，");
  }).join("；");
}

function renderReview(items) {
  const missing = items.filter((item) => !item.ok).length;
  $("missingCount").textContent = `${missing} 项待补`;
  $("reviewList").innerHTML = items
    .map(
      (item) => `
        <div class="review-item ${item.ok ? "ok" : "missing"}">
          <span class="review-mark">${item.ok ? "✓" : "!"}</span>
          <div>
            <strong>${item.title}</strong>
            <p>${item.detail}</p>
          </div>
        </div>
      `,
    )
    .join("");
}

function buildMemo(data, quadrant, boostShare, baseShare, advice) {
  const now = new Date();
  return `直播间/账号：${data.roomName || "--"} / ${data.accountName || "--"}
巡检时间：${now.toLocaleString("zh-CN")}
当前阶段：${stageLabel(data.roomStage)}

关键数据：
- 综合成本：${money(data.overallCost)}
- 基础消耗：${money(data.baseSpend)}
- 追投占比：${percent(boostShare)}
- 基础占比：${percent(baseShare)}
- 小时 ROI：${Number.isFinite(data.currentHourRoi) ? data.currentHourRoi.toFixed(2) : "--"}
- 当前小时消耗（手动）：${money(data.currentHourCost)}
- 一键起量：${data.oneClickLiftStatus === "on" ? `已开启，消耗${money(data.oneClickLiftSpend)}` : "未开启"}
- 直播大屏综合 ROI：${Number.isFinite(data.overallRoi) ? data.overallRoi.toFixed(2) : "--"}
- 5 分钟流速：${Number.isFinite(data.flowSpeed) ? data.flowSpeed : "--"}
- 活跃追投数：${data.boostTasks}
- 追投任务表：${taskSummary(data.tasks) || "未记录"}
- 追投任务概要：${data.taskNotes || "未记录"}

判断：${quadrant.label}
原因：${advice.reason || "--"}
建议：${advice.suggestion || "--"}
风险：${advice.risk || "--"}
需要你确认：如需新建、暂停、续时、加预算、改出价或改 ROI 目标，需要先确认具体对象和数值。`;
}

function textList(value) {
  return (value || "")
    .split(/[。；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readInspectionRecords() {
  try {
    const raw = localStorage.getItem(window.INSPECTION_RECORDS_KEY);
    const records = raw ? JSON.parse(raw) : [];
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

function writeInspectionRecords(records) {
  localStorage.setItem(window.INSPECTION_RECORDS_KEY, JSON.stringify(records));
}

function saveInspectionRecord(data, quadrant, boostShare, baseShare, advice, memo) {
  if (!window.createInspectionRecord) return;
  const recordData = { ...data, hourRoi: data.currentHourRoi };
  const record = window.createInspectionRecord({
    data: recordData,
    quadrant,
    boostShare,
    baseShare,
    riskFlags: textList(advice.risk),
    suggestedActions: [quadrant.action],
    memo,
  });
  const records = [record, ...readInspectionRecords()];
  writeInspectionRecords(records);
  renderHistory(records);
}

function normalizeExtensionValue(value) {
  return String(value ?? "").trim();
}

function normalizeNumberText(value) {
  return normalizeExtensionValue(value).replaceAll(",", "").replaceAll("%", "");
}

function extensionNumber(value) {
  const parsed = parseFloat(normalizeNumberText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function setFieldValue(id, value, numeric = false) {
  const node = $(id);
  if (!node || value === undefined || value === null || value === "") return;
  node.value = numeric ? normalizeNumberText(value) : normalizeExtensionValue(value);
}

function setRowInput(row, selector, value, numeric = false) {
  const node = row.querySelector(selector);
  if (!node || value === undefined || value === null || value === "") return;
  node.value = numeric ? normalizeNumberText(value) : normalizeExtensionValue(value);
}

function setRowSelect(row, selector, value) {
  const node = row.querySelector(selector);
  const text = normalizeExtensionValue(value);
  if (!node || !text) return;
  const hasOption = Array.from(node.options).some((option) => option.value === text);
  if (hasOption) node.value = text;
}

function saveManualInputs() {
  const values = {};
  manualInputIds.forEach((id) => { values[id] = $(id)?.value || ""; });
  localStorage.setItem(manualInputKey, JSON.stringify(values));
}

function loadManualInputs() {
  try {
    const values = JSON.parse(localStorage.getItem(manualInputKey) || "{}");
    manualInputIds.forEach((id) => { if ($(id) && values[id] !== undefined) $(id).value = values[id]; });
  } catch {
    // Ignore malformed local data.
  }
}

function toggleOneClickLiftSpend() {
  $("oneClickLiftSpendLabel").hidden = $("oneClickLiftStatus").value !== "on";
}

function hasExtensionFields(fieldsData) {
  return Object.values(fieldsData || {}).some((value) => value !== null && normalizeExtensionValue(value) !== "");
}

function judgePacing(task, targetRoi) {
  const roi = extensionNumber(task.roi);
  const spend = extensionNumber(task.spend);
  const budget = extensionNumber(task.budget);
  if (Number.isFinite(roi) && Number.isFinite(spend) && Number.isFinite(budget) && roi < targetRoi * 0.5 && spend > budget * 0.8) return "建议暂停";
  if (Number.isFinite(roi) && roi < targetRoi * 0.65) return "ROI偏低";
  if (Number.isFinite(spend) && Number.isFinite(budget) && spend < budget * 0.1 && spend < 30) return "冷启动";
  if (Number.isFinite(spend) && Number.isFinite(budget) && spend < budget * 0.1) return "消耗慢";
  if (task.status === "放量中" || String(task.pacing || "").includes("放量")) return "放量中";
  if (Number.isFinite(roi) && roi >= targetRoi) return "跑量中";
  return "";
}

function fillTaskRowFromExtension(row, extractedFields) {
  row.dataset.unknownBoostMethod = extractedFields.unknownBoostMethod || "";
  setRowInput(row, ".task-name", extractedFields.name);
  setRowInput(row, ".task-object", extractedFields.object);
  setRowSelect(row, ".task-type", extractedFields.type || extractedFields.boostMethod);
  setRowSelect(row, ".task-control-status", extractedFields.status);
  setRowInput(row, ".task-budget", extractedFields.budget, true);
  setRowInput(row, ".task-target-roi", extractedFields.targetRoi, true);
  setRowInput(row, ".task-duration", extractedFields.duration);
  setRowInput(row, ".task-spend", extractedFields.spend, true);
  setRowInput(row, ".task-deal", extractedFields.dealAmount, true);
  setRowInput(row, ".task-roi", extractedFields.roi, true);
  setRowInput(row, ".task-impressions", extractedFields.impressions, true);
  setRowInput(row, ".task-clicks", extractedFields.clicks, true);
  setRowSelect(row, ".task-pacing", extractedFields.pacing);
  const pacingNode = row.querySelector(".task-pacing");
  if (pacingNode && !pacingNode.value) pacingNode.value = judgePacing(extractedFields, numberValue("targetRoi") ?? 6.5);
}

function receiveFromExtension(data) {
  if (!data?.pageType || !data.fields) return;
  const extractedFields = data.fields;

  if (data.pageType === "investOverview") {
    setFieldValue("overallCost", extractedFields.overallCost, true);
    setFieldValue("baseSpend", extractedFields.baseSpend, true);
    setFieldValue("overallRoi", extractedFields.overallRoi, true);
    setFieldValue("currentHourRoi", extractedFields.hourRoi, true);
  }

  if (data.pageType === "liveScreen") {
    setFieldValue("overallRoi", extractedFields.overallRoi, true);
    setFieldValue("flowSpeed", extractedFields.flowSpeed, true);
  }

  if (data.pageType === "investData") {
    setFieldValue("currentHourRoi", extractedFields.hourRoi, true);
  }

  if (data.pageType === "controlTable" && Array.isArray(extractedFields)) {
    $("taskTableBody").innerHTML = "";
    extractedFields.filter(hasExtensionFields).forEach((task) => {
      const row = createTaskRow();
      fillTaskRowFromExtension(row, task);
    });
    $("boostTasks").value = String(collectTasks().length);
    summarizeTasks(false);
  }

  analyze();
}

function pollExtensionData() {
  if (!window.chrome?.storage?.local) return;
  chrome.storage.local.get(["lastExtract"], (result) => {
    const data = result?.lastExtract;
    if (!data?.timestamp || data.timestamp === lastExtensionTimestamp) return;
    lastExtensionTimestamp = data.timestamp;
    receiveFromExtension(data);
  });
}

function renderHistory(records = readInspectionRecords()) {
  const node = $("historyList");
  if (!node) return;
  const recent = records.slice(0, 20);
  if (recent.length === 0) {
    node.innerHTML = `<p class="empty-history">暂无历史巡检记录。</p>`;
    return;
  }
  node.innerHTML = recent
    .map((record) => {
      const time = record.inspectedAt ? new Date(record.inspectedAt).toLocaleString("zh-CN") : "--";
      const metrics = record.metrics || {};
      const derived = record.derived || {};
      const rule = record.ruleResult || {};
      return `
        <div class="history-item">
          <strong>${time}</strong>
          <span>综合成本 ${money(metrics.overallCost)} / 小时ROI ${Number.isFinite(metrics.hourRoi) ? metrics.hourRoi.toFixed(2) : "--"} / 综合ROI ${Number.isFinite(metrics.overallRoi) ? metrics.overallRoi.toFixed(2) : "--"} / 流速 ${Number.isFinite(metrics.flowSpeed) ? metrics.flowSpeed : "--"} / 追投占比 ${percent(derived.boostShare)} / ${rule.quadrantLabel || "--"}</span>
        </div>
      `;
    })
    .join("");
}

function analyze(options = {}) {
  const data = collectData();
  $("boostTasks").value = String(data.boostTasks);
  const boostShare =
    Number.isFinite(data.overallCost) && data.overallCost > 0 && Number.isFinite(data.baseSpend)
      ? (data.overallCost - data.baseSpend) / data.overallCost
      : NaN;
  const baseShare =
    Number.isFinite(data.overallCost) && data.overallCost > 0 && Number.isFinite(data.baseSpend)
      ? data.baseSpend / data.overallCost
      : NaN;

  const quadrant = classify(data);
  const advice = buildAdvice(data, quadrant, boostShare);
  const memo = buildMemo(data, quadrant, boostShare, baseShare, advice);
  const items = reviewItems(data);

  $("checkTime").textContent = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  $("quadrantBadge").textContent = quadrant.label;
  $("actionLabel").textContent = quadrant.action;
  $("boostShare").textContent = percent(boostShare);
  $("baseShare").textContent = percent(baseShare);
  $("reasonText").textContent = advice.reason || "数据完整后生成原因。";
  $("suggestionText").textContent = advice.suggestion || "数据完整后生成建议。";
  $("riskText").textContent = advice.risk;
  $("memoOutput").textContent = memo;
  renderReview(items);
  if (options.save) saveInspectionRecord(data, quadrant, boostShare, baseShare, advice, memo);
}

function createTaskRow(task = {}) {
  taskRowId += 1;
  const row = document.createElement("tr");
  row.dataset.rowId = String(taskRowId);
  row.innerHTML = `
    <td>
      <input class="task-name wide-input" placeholder="任务名称/ID" value="${escapeAttr(task.name)}" />
    </td>
    <td>
      <select class="task-type status">
        <option value="">未确认</option>
        <option value="控成本追投">控成本追投</option>
        <option value="放量追投">放量追投</option>
        <option value="素材追投">素材追投</option>
        <option value="一键起量">一键起量</option>
        <option value="一键调速">一键调速</option>
        <option value="搜索抢首屏">搜索抢首屏</option>
      </select>
    </td>
    <td><input class="task-object" placeholder="共5条视频/直播间购买" value="${escapeAttr(task.object)}" /></td>
    <td>
      <select class="task-control-status status">
        <option value="">未确认</option>
        <option value="调控中">调控中</option>
        <option value="已暂停">已暂停</option>
        <option value="调控失败">调控失败</option>
        <option value="已删除">已删除</option>
      </select>
    </td>
    <td><input class="task-budget num" type="number" step="0.01" placeholder="300" value="${task.budget || ""}" /></td>
    <td><input class="task-target-roi num" type="number" step="0.01" placeholder="6.5/-" value="${task.targetRoi || ""}" /></td>
    <td><input class="task-duration" placeholder="1.0/预计00:32结束" value="${escapeAttr(task.duration)}" /></td>
    <td><input class="task-spend num" type="number" step="0.01" placeholder="消耗" value="${task.spend || ""}" /></td>
    <td><input class="task-deal num" type="number" step="0.01" placeholder="成交" value="${task.dealAmount || ""}" /></td>
    <td><input class="task-roi num" type="number" step="0.01" placeholder="支付ROI" value="${task.roi || ""}" /></td>
    <td><input class="task-impressions num" type="number" step="1" placeholder="展示" value="${task.impressions || ""}" /></td>
    <td><input class="task-clicks num" type="number" step="1" placeholder="点击" value="${task.clicks || ""}" /></td>
    <td>
      <select class="task-pacing status">
        <option value="">未判断</option>
        <option value="冷启动">冷启动</option>
        <option value="跑量中">跑量中</option>
        <option value="放量中">放量中</option>
        <option value="消耗慢">消耗慢</option>
        <option value="ROI偏低">ROI偏低</option>
        <option value="建议暂停">建议暂停</option>
      </select>
    </td>
    <td><button class="delete-task" type="button" title="删除任务">×</button></td>
  `;
  row.querySelector(".task-type").value = task.type || "";
  row.querySelector(".task-control-status").value = task.status || "";
  row.querySelector(".task-pacing").value = task.pacing || "";
  row.querySelectorAll("input, select").forEach((node) => node.addEventListener("input", analyze));
  row.querySelector(".delete-task").addEventListener("click", () => {
    row.remove();
    $("boostTasks").value = String(collectTasks().length);
    summarizeTasks(false);
    analyze();
  });
  $("taskTableBody").appendChild(row);
  $("boostTasks").value = String(collectTasks().length);
  analyze();
  return row;
}

function summarizeTasks(updateAnalyze = true) {
  const summary = taskSummary(collectTasks());
  if (summary) $("taskNotes").value = summary;
  if (updateAnalyze) analyze();
}

function resetDefaults() {
  Object.entries(defaults).forEach(([key, value]) => {
    $(key).value = value;
  });
  ["overallCost", "baseSpend", "currentHourRoi", "currentHourCost", "overallRoi", "flowSpeed", "taskNotes"].forEach((id) => {
    $(id).value = "";
  });
  $("boostTasks").value = "0";
  $("oneClickLiftStatus").value = "off";
  $("oneClickLiftSpend").value = "";
  toggleOneClickLiftSpend();
  $("taskTableBody").innerHTML = "";
  createTaskRow();
  analyze();
}

async function copyMemo() {
  const memo = $("memoOutput").textContent;
  if (!memo.trim()) analyze();
  try {
    await navigator.clipboard.writeText($("memoOutput").textContent);
    $("copyBtn").textContent = "已复制";
    setTimeout(() => {
      $("copyBtn").textContent = "复制巡检 Memo";
    }, 1200);
  } catch {
    $("copyBtn").textContent = "复制失败";
    setTimeout(() => {
      $("copyBtn").textContent = "复制巡检 Memo";
    }, 1200);
  }
}

function hydrate() {
  $("themeToggle")?.addEventListener("click", () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); });
  $("analyzeBtn").addEventListener("click", () => analyze({ save: true }));
  $("resetBtn").addEventListener("click", () => {
    resetDefaults();
    saveManualInputs();
  });
  $("copyBtn").addEventListener("click", copyMemo);
  $("addTaskBtn").addEventListener("click", () => createTaskRow());
  $("summarizeTasksBtn").addEventListener("click", () => summarizeTasks());
  fields.forEach((id) => {
    const node = $(id);
    if (node) node.addEventListener("input", () => {
      if (manualInputIds.includes(id)) {
        toggleOneClickLiftSpend();
        saveManualInputs();
      }
      analyze();
    });
  });
  resetDefaults();
  loadManualInputs();
  toggleOneClickLiftSpend();
  analyze();
  renderHistory();
  setInterval(pollExtensionData, 3000);
}

hydrate();
