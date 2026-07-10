const fs = require("fs");
const path = require("path");

const SNAPSHOT_FILE = path.join(__dirname, "..", "data", "snapshots.jsonl");
const LEARNING_LOG_FILE = path.join(__dirname, "..", "data", "learning-log.jsonl");

function num(value) {
  const parsed = Number.parseFloat(String(value ?? "").replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function readSnapshots(limit = 2000) {
  if (!fs.existsSync(SNAPSHOT_FILE)) return [];
  return fs.readFileSync(SNAPSHOT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readJsonl(file, limit = 500) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function taskId(task = {}) {
  return task.taskId || task.id || String(task.name || "").match(/ID:\s*(\d+)/)?.[1] || "";
}

function taskTypeLabel(type = "") {
  return {
    materialBoost: "素材放量/追投",
    materialCostControl: "素材控成本",
    oneClickLift: "一键起量",
  }[type] || type || "未知类型";
}

function actionTypeLabel(type = "") {
  return {
    pause_task: "暂停任务",
    increase_task_budget: "追加预算",
    decrease_task_budget: "降低预算",
    extend_task_duration: "延长时长",
    change_roi_target: "修改 ROI",
    end_task: "结束任务",
    adjust_task_budget_duration: "调整预算和时长",
    create_boost_task: "新建追投",
    create_oneclick_task: "新建一键起量",
    raise_roi_target: "提高 ROI 目标",
    lower_roi_target: "降低 ROI 目标",
  }[type] || type || "未知动作";
}

function feedbackParamText(item = {}) {
  const parts = [];
  const budgetIncrease = num(item.budgetIncrease);
  const budget = num(item.budget);
  const durationHours = num(item.durationHours);
  if (Number.isFinite(budgetIncrease)) parts.push(`+${budgetIncrease}`);
  if (Number.isFinite(budget)) parts.push(`新预算 ${budget}`);
  if (Number.isFinite(durationHours)) parts.push(`${durationHours} 小时`);
  return parts.length ? ` (${parts.join("，")})` : "";
}

function recentFeedbackPrompt() {
  const feedback = readJsonl(LEARNING_LOG_FILE, 300)
    .filter((item) => item.type === "action_feedback")
    .slice(-5);
  const header = "最近 5 条用户反馈（仅供参考，不禁止再次建议）：";
  if (!feedback.length) return `${header}\n- 暂无`;
  const lines = feedback.map((item) => {
    const verdict = item.verdict === "approved" ? "批准了" : "拒了";
    const actionText = `${item.actionType || "unknown"}（${actionTypeLabel(item.actionType)}）`;
    const roi = Number.isFinite(num(item.atRoi)) ? ` (ROI ${num(item.atRoi)})` : "";
    const reason = String(item.reason || "").trim();
    const executionText = item.verdict === "approved" && item.executionOk !== undefined
      ? `，执行${item.executionOk ? "成功" : "未成功"}`
      : "";
    return `- ${verdict} ${actionText}${feedbackParamText(item)}${roi}${reason ? `：${reason}` : ""}${executionText}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

function formatInvestmentSop(sop = {}) {
  if (!sop || typeof sop !== "object") return "## 投放SOP（运营制定，严格遵守）\n未配置，按默认谨慎策略执行。";
  const faq = Array.isArray(sop.faq) ? sop.faq.map((group) => {
    const items = Array.isArray(group.items) ? group.items.map((item) => `  - Q：${item.q || "--"}\n    排查：${item.a || "--"}`).join("\n") : "";
    return `- ${group.category || "未分类"}\n${items}`;
  }).join("\n") : "暂无";
  return [
    "## 投放SOP（运营制定，严格遵守）",
    "",
    "基础参数：",
    `- 品类：${sop.category || "--"}`,
    `- 目标ROI：${sop.targetRoi ?? "--"}`,
    `- 追投占比上限：${sop.boostRatioLimit ?? "--"}%`,
    `- 单次加量上限：${sop.maxBudgetIncrease ?? "--"}元`,
    `- ROI调整单步：${sop.roiStep ?? "--"}`,
    `- 客单价参考：${sop.avgOrderValue ?? "--"}元 | 毛利率参考：${sop.grossMargin ?? "--"}% | 退货率参考：${sop.returnRate ?? "--"}%`,
    "",
    `- 直播时间：${sop.openTime || "--"} - ${sop.closeTime || "--"}`,
    `- 换播时间：${Array.isArray(sop.shiftTimes) ? sop.shiftTimes.join("、") : "--"}`,
    "",
    "场景规则：",
    sop.scenarioRules || "--",
    "",
    `暂停条件：${sop.pauseCondition || "--"}`,
    `加量条件：${sop.increaseCondition || "--"}`,
    `降ROI条件：${sop.lowerRoiCondition || "--"}`,
    "",
    "自主追投场景：",
    sop.autonomousBoostRules || "--",
    "",
    "常见问题排查参考：",
    faq,
  ].join("\n");
}

function materialIdOf(item = {}) {
  return String(item.materialId || item["素材ID"] || "").trim();
}

function materialMetric(item = {}, key = "") {
  const aliases = {
    spend: ["spend", "消耗"],
    ctr: ["ctr", "CTR"],
    cvr: ["cvr", "CVR"],
    materialRoi: ["materialRoi", "素材ROI"],
    boostRoi: ["boostRoi", "追投ROI"],
  }[key] || [key];
  for (const alias of aliases) {
    const value = num(item[alias]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function materialCreatedAt(item = {}) {
  const text = String(item.createdAt || item["创建日期"] || "").trim();
  const match = text.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?/);
  if (!match) return null;
  const normalized = match[0].replaceAll("/", "-");
  const parsed = new Date(normalized.length <= 10 ? `${normalized} 00:00:00` : normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function compactMaterialLine(item = {}) {
  const id = materialIdOf(item) || "--";
  const spend = materialMetric(item, "spend");
  const roi = materialMetric(item, "materialRoi");
  const ctr = materialMetric(item, "ctr");
  const cvr = materialMetric(item, "cvr");
  const boostRoi = materialMetric(item, "boostRoi");
  const status = item.auditStatus || item["审核状态"] || "";
  const type = item.materialType || item["类型"] || "";
  return `${id}（消耗${Number.isFinite(spend) ? spend : "--"}，ROI ${Number.isFinite(roi) ? roi : "--"}，CTR ${Number.isFinite(ctr) ? `${ctr}%` : "--"}，CVR ${Number.isFinite(cvr) ? `${cvr}%` : "--"}${Number.isFinite(boostRoi) ? `，追投ROI ${boostRoi}` : ""}${status ? `，${status}` : ""}${type ? `，${type}` : ""}）`;
}

function materialLibrarySummary(state = {}) {
  const materials = Array.isArray(state.materialLibrary) ? state.materialLibrary : [];
  const meta = state.materialLibraryMeta || {};
  const targetRoi = num(state.config?.targetRoi) || 6;
  const spendful = materials.filter((item) => Number.isFinite(materialMetric(item, "spend")));
  const ctrValues = materials.map((item) => materialMetric(item, "ctr")).filter(Number.isFinite);
  const cvrValues = materials.map((item) => materialMetric(item, "cvr")).filter(Number.isFinite);
  const avgCtr = Number.isFinite(num(meta.avgCtr)) ? num(meta.avgCtr) : ctrValues.length ? Math.round((ctrValues.reduce((sum, value) => sum + value, 0) / ctrValues.length) * 100) / 100 : null;
  const highCvrThreshold = Number.isFinite(num(meta.highCvrThreshold)) ? num(meta.highCvrThreshold) : cvrValues.length ? Math.round((cvrValues.reduce((sum, value) => sum + value, 0) / cvrValues.length) * 100) / 100 : null;
  const now = Date.now();
  const auditOk = (item) => !/(未通过|拒绝|失败)/.test(String(item.auditStatus || item["审核状态"] || ""));
  const bySpend = spendful.slice().sort((a, b) => materialMetric(b, "spend") - materialMetric(a, "spend")).slice(0, 3);
  const highRoi = materials.filter((item) => auditOk(item) && Number(materialMetric(item, "materialRoi")) >= targetRoi).sort((a, b) => materialMetric(b, "materialRoi") - materialMetric(a, "materialRoi")).slice(0, 8);
  const potential = materials.filter((item) => auditOk(item) && Number(materialMetric(item, "materialRoi")) >= 5 && Number(materialMetric(item, "materialRoi")) < targetRoi).sort((a, b) => materialMetric(b, "materialRoi") - materialMetric(a, "materialRoi")).slice(0, 8);
  const newMaterials = materials.filter((item) => auditOk(item) && Number.isFinite(materialCreatedAt(item)) && now - materialCreatedAt(item) <= 48 * 60 * 60 * 1000 && Number(materialMetric(item, "spend")) > 0).slice(0, 8);
  const highCvr = Number.isFinite(highCvrThreshold) ? materials.filter((item) => auditOk(item) && Number(materialMetric(item, "cvr")) > highCvrThreshold).sort((a, b) => materialMetric(b, "cvr") - materialMetric(a, "cvr")).slice(0, 8) : [];
  const highCtr = Number.isFinite(avgCtr) ? materials.filter((item) => auditOk(item) && Number(materialMetric(item, "ctr")) > avgCtr * 1.3).sort((a, b) => materialMetric(b, "ctr") - materialMetric(a, "ctr")).slice(0, 8) : [];
  const boostGood = materials.filter((item) => auditOk(item) && Number(materialMetric(item, "boostRoi")) >= 2).sort((a, b) => materialMetric(b, "boostRoi") - materialMetric(a, "boostRoi")).slice(0, 8);
  const lines = (items) => items.length ? items.map(compactMaterialLine).join("；") : "暂无";
  return {
    materialCount: materials.length,
    avgCtr,
    highCvrThreshold,
    prompt: [
      `## 素材库（每 30 分钟更新，共 ${materials.length} 条）`,
      "",
      `消耗 TOP 3：${lines(bySpend)}`,
      `高 ROI 素材（ROI ≥ ${targetRoi}）：${lines(highRoi)}`,
      `潜力素材（ROI ≥ 5.0）：${lines(potential)}`,
      `新素材（48h内）：${lines(newMaterials)}`,
      `高转化素材（CVR > ${Number.isFinite(highCvrThreshold) ? `${highCvrThreshold}%` : "页面高转化阈值"}）：${lines(highCvr)}`,
      `高点击素材（CTR > 平均 × 1.3，平均 ${Number.isFinite(avgCtr) ? `${avgCtr}%` : "未知"}）：${lines(highCtr)}`,
      `追投效果好的（追投 ROI ≥ 2.0）：${lines(boostGood)}`,
    ].join("\n"),
    groups: { bySpend, highRoi, potential, newMaterials, highCvr, highCtr, boostGood },
  };
}

function taskRecentSnapshots(task, snapshots) {
  const id = taskId(task), name = String(task.name || "").split("\n")[0], since = Date.now() - 30 * 60 * 1000;
  return snapshots.filter((item) => item.pageType === "controlTable" && item.receivedAt >= since && Array.isArray(item.fields)).flatMap((item) => {
    const row = item.fields.find((field) => (id && taskId(field) === id) || (name && String(field.name || "").includes(name)));
    return row ? [{ ts: item.receivedAt, spend: num(row.spend), roi: num(row.roi), dealAmount: num(row.dealAmount), impressions: num(row.impressions) }] : [];
  }).slice(-10);
}

function trendSummary(trend = []) {
  const points = trend.filter((point) => Number.isFinite(num(point.ts)) && Number.isFinite(num(point.cost)));
  const latestTs = points.at(-1)?.ts;
  if (!latestTs) return { direction: "unknown", recent15Spend: null, previous15Spend: null, delta: null };
  const recent = points.filter((point) => point.ts > latestTs - 15 * 60 * 1000);
  const previous = points.filter((point) => point.ts <= latestTs - 15 * 60 * 1000 && point.ts > latestTs - 30 * 60 * 1000);
  const sum = (items) => Math.round(items.reduce((total, point) => total + num(point.cost), 0) * 100) / 100;
  const recent15Spend = sum(recent), previous15Spend = sum(previous), delta = Math.round((recent15Spend - previous15Spend) * 100) / 100;
  return { direction: delta > 20 ? "accelerating" : delta < -20 ? "slowing" : "stable", recent15Spend, previous15Spend, delta };
}

function liveRemainingMinutes(config = {}, date = new Date()) {
  const [hour, minute] = String(config.closeTime || "02:00").split(":").map(Number);
  const close = new Date(date);
  close.setHours(hour, minute, 0, 0);
  if (close <= date) close.setDate(close.getDate() + 1);
  return Math.max(0, Math.round((close - date) / 60000));
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    dateText: `${parts.year}-${parts.month}-${parts.day}`,
    timeText: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function liveDurationText(config = {}, date = new Date()) {
  const parts = shanghaiParts(date);
  const [openHour, openMinute] = String(config.openTime || "06:00").split(":").map(Number);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const openMinutes = openHour * 60 + openMinute;
  const duration = nowMinutes >= openMinutes ? nowMinutes - openMinutes : nowMinutes + 24 * 60 - openMinutes;
  return `${Math.floor(duration / 60)} 小时 ${duration % 60} 分钟`;
}

function hourRoiTrend(snapshots) {
  return snapshots.filter((item) => ["investOverview", "investData"].includes(item.pageType)).map((item) => ({
    ts: item.receivedAt,
    hourRoi: num(item.fields?.hourRoi),
  })).filter((point) => Number.isFinite(point.hourRoi)).slice(-6);
}

function buildSystemPrompt() {
  return [
    "你是直播间投放调控助手，服务已配置的千川账户。全程使用中文。",
    "目标 ROI 必须以 userPayload.constraints.targetRoi / userPayload.metrics.targetRoi 为准，这是调控台里的系统目标 ROI；直播时段 06:00-02:00。只能从 raise_roi_target / lower_roi_target / pause_task / increase_task_budget / decrease_task_budget / create_boost_task / create_oneclick_task 七种动作里选择。",
    "涉及当前时间、当前时段、凌晨/上午/下午/晚上判断时，只能使用 userPayload.currentTimeLocal 和 userPayload.config.liveDuration；禁止根据 UTC 时间、旧日志时间或直播关闭时间自行推断。",
    "顶层 reasoning 必须分三段，用两个换行分隔，段落标题固定为：当前盘况：、主要问题：、建议方向：。当前盘况段必须包含：综合ROI、基础消耗、追投消耗、追投占比（从 boostAnalysis 字段读取）、小时段消耗、小时段追投占比、GPM（metrics.gpm）、实时在线人数（metrics.onlineCount）、曝光观看率（metrics.exposureWatchRate）、观看成交率（metrics.watchDealRate）。结合直播间承接能力（在线人数+GPM+曝光观看率+观看成交率）判断是否适合放量。",
    "每条 action.reason 必须分三段，用两个换行分隔，段落标题固定为：诊断：、动作：、预期：。",
    "increase_task_budget 只有 task.roi > targetRoi × 1.2 才允许；budget 必须是新预算具体数字；加量幅度 = min(原预算 × 0.5, userPayload.constraints.maxBudgetIncrease)，新预算 = 原预算 + 加量幅度，不要直接乘 1.5。",
    "pause_task 只有 task.roi < targetRoi × 0.5 且 spend > budget × 0.5 才允许。",
    "create_boost_task 必须给出 materialId、budget、durationHours、targetRoi，并说明素材属于哪一层；追投占比达到 28% 或素材 ROI < 2.0 或审核未通过时禁止创建。",
    "create_oneclick_task 只能在综合 ROI > 目标 × 0.8 且在线人数 > 20 时建议；预算 ≤ 基础消耗 × 20%、≤ 500 元，时长 ≤ 3 小时。注意：这里的目标 × 0.8 只是最低准入/观察线，不代表高 ROI。",
    "ROI 分档硬规则：当前小时 ROI >= 目标 ROI 才能称为高 ROI；目标 × 0.8 <= 当前小时 ROI < 目标 ROI 只能称为观察区/接近观察线，必须明确“不达标、不算高 ROI”；当前小时 ROI < 目标 × 0.8 称为低于观察线；task 加预算必须 task.roi > 目标 × 1.2。",
    "ROI 调整单步不超过 0.2。如果不确定，必须返回 decision: observe，actions 为空数组。",
    "重要：当 userPayload.shiftProtection=true 或 firstHourProtection=true 时，必须返回 decision:observe。当 userPayload.quadrant.quadrant='C' 时优先暂停追投。禁止自行发明象限；只有 userPayload.quadrant.quadrant='A' 且当前小时 ROI >= 目标 ROI 时，才允许说“低消耗高ROI/象限A”。",
    "输出面向运营人员，reasoning 中禁止出现代码字段名或内部枚举（如 userPayload、shiftProtection、quadrant、firstHourProtection、materialBoost、oneClickLift、materialCostControl）。可以用人话表达，例如'当前处于换播保护期'、'处于开播首小时'、'当前处于高消耗低ROI状态'、'素材放量/追投任务'、'一键起量任务'。禁止把高于目标0.8倍说成高ROI。",
    "推理输出额外禁止以下英文：spend、budget、task.roi、targetRoi、boostRatio、create_boost_task、create_oneclick_task、increase_task_budget、lower_roi_target、pause_task、decision:observe、decision:act。对应中文：消耗、预算、任务ROI、目标ROI、追投占比。",
    "当前已取消利润口径；投放判断只按千川账户目标ROI、消耗、成交、追投占比、任务ROI和直播间承接指标。",
    "用户反馈只作为语气和风险判断参考，不能变成硬性禁令；例如用户上次拒绝 ROI 3.2 暂停，不代表本次 ROI 继续恶化时禁止再次建议暂停，但需要说明'上次你拒绝过，这次因为数据继续恶化所以谨慎建议'。",
    "输出必须是严格 JSON：{\"decision\":\"act|observe\",\"reasoning\":\"当前盘况：...\\n\\n主要问题：...\\n\\n建议方向：...\",\"actions\":[{\"type\":\"...\",\"params\":{},\"reason\":\"诊断：...\\n\\n动作：...\\n\\n预期：...\",\"confidence\":0.8}]}",
    "每次决策必须读取 userPayload.config.investmentSop，并严格遵守其中的基础参数、场景规则、暂停条件、加量条件、降ROI条件和排查路径。",
    "每次涉及追投建议时必须读取 userPayload.materialLibrarySummary；如果生成 create_boost_task 或 create_oneclick_task，reason 必须写明选了什么素材、属于哪一层、为什么选它、预测效果。",
    "基础消耗优先原则：基础消耗（全天 + 单小时）是跑量核心。基础消耗差时，即使使用一键起量或素材追投效果也不会好。必须先观察基础消耗趋势再决定是否调控。",
    "低流速测试原则：每 5 分钟流速 < 100 时，可以小额测试素材追投（预算 ≤ 150 元），目标是提升流速至 130 以上。但此操作仅在基础消耗不差时适用。",
    "高流速判断：每 5 分钟流速 > 200 时，如果单小时转化没有断成交、直播大屏成交金额曲线不下滑，则不调整；只有转化困难时才小幅度上抬 0.5 ROI。",
    "稳定不干预：单小时综合成本稳定且基础流速满足当前需求时，不做任何调控动作。单小时消耗稳定但 ROI 过低时更不能调控——调控只会增加空消耗。",
    "开播冷启动：直播时间 06:00-02:00。早 6:00 开播 5 分钟后，自动建议启用一键起量（直播间购买，预算 200-300 元，时长 1 小时）。注意：只在开播首小时触发此规则。",
    "ROI 调整冷静期：两次 ROI 调整间隔必须 ≥ 30 分钟。每次调整后观察至少 1 小时。禁止频繁调整 ROI 目标。如有违背此规则的历史动作记录在 userPayload.config.recentFeedback 中，当前决策直接 observe。",
    "ROI 下调硬约束：下调最低到 6.0（安全界限），不能再低。每次下调只能用 0.2 步长。下调必须经过操作人同意——如果 userPayload.constraints.targetRoi 已是 6.0，禁止再建议 lower_roi_target。",
    "ROI 上调看流速：上调只能用 0.2 步长。如果当前流速很快（每 5 分钟 > 150），可以用 0.5 区间上调。上调必须在单小时转化稳定、成交曲线不下滑时才能建议。",
    "加量上限：每次决策提出的加量任务（create_boost_task + create_oneclick_task + increase_task_budget）合计不超过 2 个。超过 2 个时优先保留 ROI 最高的建议。",
    "起量追投互斥：create_oneclick_task 和 create_boost_task（放量追投）不能同时建议——两者会互相抢量导致调控不稳定。同一次决策只能选其一。",
    "素材控成本出价公式：create_boost_task（控成本模式）的出价 = 客单价 329 ÷ userPayload.constraints.targetRoi。例如 targetRoi=6.3 时出价=52。支付 ROI 等于目标 ROI。",
    "直播间画面追投条件：单小时 ROI 达到 4-5（目标 ROI 为 6.3 时），可以使用直播间画面放量追投补充流速，预算 100-200 元、时长 1 小时。单小时 ROI < 4 时不建议画面追投。",
    "放量追投预算：create_boost_task 放量模式预算 200-300 元/1 小时。如果当前转化低，降为 150 元/1 小时。追投后消耗超预算 70% 仍无转化时，触发’建议手动关闭’。",
    "新素材策略：48 小时内创建的新素材，优先使用控成本追投方式，不用放量追投。",
    "调控后观察期：任何调控动作执行后，接下来 30 分钟内只观察不追加新动作。如果 30 分钟内出现空消耗，或消耗 > 100 元且 ROI 降至 2-3，提醒操作人手动关闭。",
    "素材筛选方式：素材追投选品时，先按综合 ROI 排序筛选高 ROI 潜力素材，再参考点击率和转化率筛选高点击、高转化素材。ROI 处于 2-3 且转化率低的素材不追投。",
    "主播轮班保护：换播时间 10:00/14:00/18:00/22:00，各 ±15 分钟不调控。userPayload.shiftProtection=true 时直接 observe。",
    "",
    recentFeedbackPrompt(),
  ].join("\n");
}

function taskMaterialId(task = {}) {
  const match = String(task.object || "").match(/素材ID[：:]\s*(\d+)/);
  return match?.[1] || null;
}

function buildUserPayload(state) {
  const config = state.config || {}, snapshots = readSnapshots();
  const materialSummary = materialLibrarySummary(state);
  const now = new Date();
  const nowParts = shanghaiParts(now);
  const tasks = (state.metrics?.tasks || []).map((task) => {
    const recentSnapshots = taskRecentSnapshots(task, snapshots);
    const materialId = taskMaterialId(task);
    const obj = String(task.object || "").split("\n")[0];
    return { ...task, taskType: taskTypeLabel(task.taskType || task.type), materialId, object: obj, recentSnapshots };
  });
  // 追投结构分析
  const overallCost = num(state.metrics?.overallCost) || 0;
  const baseSpend = num(state.metrics?.baseSpend) || 0;
  const canCalcBoost = overallCost > 10 && baseSpend > 0 && baseSpend <= overallCost;
  const boostSpend = canCalcBoost ? Math.round((overallCost - baseSpend) * 100) / 100 : null;
  const boostRatioValue = num(state.metrics?.boostRatio);
  const boostRatio = Number.isFinite(boostRatioValue)
    ? boostRatioValue
    : canCalcBoost ? Math.round(((overallCost - baseSpend) / overallCost) * 1000) / 10 : null;
  const boostTasks = tasks.filter((task) => ["素材放量/追投", "一键起量"].includes(task.taskType));
  const boostAnalysis = {
    overallCost,
    baseSpend,
    boostSpend,
    boostRatio: Number.isFinite(boostRatio) ? `${boostRatio}%` : "未知（总消耗与基础消耗来源不一致，暂不硬算）",
    hourSegmentSpend: num(state.metrics?.hourSegmentSpend),
    hourSegmentBaseSpend: num(state.metrics?.hourSegmentBaseSpend),
    hourSegmentBoostRatio: Number.isFinite(num(state.metrics?.hourSegmentBoostRatio)) ? `${num(state.metrics.hourSegmentBoostRatio)}%` : "未知",
    hourSegmentBoostRatioFormula: "(小时段综合消耗 - 小时基础消耗) / 小时段综合消耗",
    boostTaskCount: boostTasks.length,
    boostTasks: boostTasks.map((t) => ({
      name: (t.name || "").replace(/^20\d{6}_/, ""),
      taskId: taskId(t),
      taskType: t.taskType,
      spend: t.spend,
      budget: t.budget,
      roi: t.roi,
      boostMethod: t.boostMethod,
      status: t.status,
    })),
  };

  return {
    currentTime: now.toISOString(),
    currentTimeLocal: `${nowParts.dateText} ${nowParts.timeText} Asia/Shanghai`,
    metrics: {
      ...(state.metrics || {}),
      tasks,
      dealAmount: num(state.metrics?.dealAmount),
      fiveMinSpend: state.fiveMinSpend ?? null,
      targetRoi: config.targetRoi,
      watchDealRate: num(state.metrics?.watchDealRate),
    },
    boostAnalysis,
    assistMetrics: state.assistMetrics || null,
    hourlyBreakdown: state.hourlyBreakdown ? {
      status: state.hourlyBreakdown.status,
      receivedAt: state.hourlyBreakdown.receivedAt || state.hourlyBreakdown.collectedAt,
      current: state.hourlyBreakdown.current || null,
      rows: Array.isArray(state.hourlyBreakdown.rows) ? state.hourlyBreakdown.rows.slice(-24) : [],
      segments: Array.isArray(state.hourlyBreakdown.segments) ? state.hourlyBreakdown.segments.slice(-24) : [],
    } : null,
    trend: (state.trendData || []).slice(-12),
    trendSummary: trendSummary(state.trendData || []),
    accountHealth: {
      overallRoi: num(state.metrics?.overallRoi),
      targetRoi: num(config.targetRoi),
      roiGap: num(state.metrics?.overallRoi) !== null && num(config.targetRoi) !== null ? Math.round((num(state.metrics.overallRoi) - num(config.targetRoi)) * 100) / 100 : null,
      currentHourRoi: num(state.metrics?.currentHourRoi),
      currentHourRoiTrend: hourRoiTrend(snapshots),
      remainingLiveMinutes: liveRemainingMinutes(config),
    },
    tasks,
    recentActions: (state.actions || []).slice(0, 5),
    constraints: {
      accountId: config.expectedAccountId,
      openTime: config.openTime,
      closeTime: config.closeTime,
      targetRoi: config.targetRoi,
      maxRoiStep: num(config.investmentSop?.roiStep) || 0.2,
      maxBudgetIncrease: num(config.investmentSop?.maxBudgetIncrease) || 200,
      increaseBudgetRule: "仅当 task.roi > targetRoi * 1.2；新预算 = 原预算 + min(原预算 * 0.5, maxBudgetIncrease)",
      pauseTaskRule: "仅当 task.roi < targetRoi * 0.5 且 spend > budget * 0.5",
      allowedActions: ["raise_roi_target", "lower_roi_target", "pause_task", "increase_task_budget", "decrease_task_budget", "create_boost_task", "create_oneclick_task"],
      createActionRules: "create_boost_task/create_oneclick_task 需要人工审批；首次强制 dryRun；追投占比 >= 28% 禁止新增追投；单日自主建任务 <= 5；两次建任务间隔 >= 30 分钟。",
    },
    materialLibrarySummary: materialSummary.prompt,
    materialLibrary: {
      count: materialSummary.materialCount,
      avgCtr: materialSummary.avgCtr,
      highCvrThreshold: materialSummary.highCvrThreshold,
      groups: Object.fromEntries(Object.entries(materialSummary.groups).map(([key, list]) => [key, list.map((item) => ({
        materialId: materialIdOf(item),
        spend: materialMetric(item, "spend"),
        ctr: materialMetric(item, "ctr"),
        cvr: materialMetric(item, "cvr"),
        materialRoi: materialMetric(item, "materialRoi"),
        boostRoi: materialMetric(item, "boostRoi"),
        createdAt: item.createdAt || item["创建日期"] || "",
        auditStatus: item.auditStatus || item["审核状态"] || "",
        materialType: item.materialType || item["类型"] || "",
      }))])),
    },
    config: {
      openTime: config.openTime,
      closeTime: config.closeTime,
      liveDuration: liveDurationText(config, now),
      investmentSop: config.investmentSop || null,
    },
  };
}

function compactTask(task = {}) {
  return {
    name: String(task.name || task.taskName || "").slice(0, 80),
    taskId: taskId(task),
    taskType: taskTypeLabel(task.taskType || task.type),
    status: task.status || "",
    spend: num(task.spend),
    budget: num(task.budget),
    roi: num(task.roi),
    targetRoi: num(task.targetRoi),
    dealAmount: num(task.dealAmount),
    boostMethod: task.boostMethod || "",
    duration: task.duration || "",
  };
}

function buildChatPrompt(state, rulesContext = "", message = "", memory = {}) {
  const config = state.config || {};
  const metrics = state.metrics || {};
  const assistMetrics = state.assistMetrics || {};
  const tasks = Array.isArray(metrics.tasks) ? metrics.tasks.map(compactTask) : [];
  const chatMetrics = {
    overallCost: num(metrics.overallCost),
    baseSpend: num(metrics.baseSpend),
    boostSpend: num(metrics.boostSpend),
    boostRatio: num(metrics.boostRatio),
    hourSegmentSpend: num(metrics.hourSegmentSpend),
    hourSegmentBaseSpend: num(metrics.hourSegmentBaseSpend),
    hourSegmentBoostRatio: num(metrics.hourSegmentBoostRatio),
    currentHourCost: num(metrics.currentHourCost),
    currentHourRoi: num(metrics.currentHourRoi),
    currentHourDealAmount: num(metrics.currentHourDealAmount),
    currentHourOrders: num(metrics.currentHourOrders),
    overallRoi: num(metrics.overallRoi),
    targetRoi: num(config.targetRoi),
    dealAmount: num(metrics.dealAmount),
    orderCount: num(assistMetrics.orderCount ?? metrics.orderCount),
    orderCost: num(assistMetrics.orderCost ?? metrics.orderCost),
    gpm: num(metrics.gpm),
    onlineCount: num(metrics.onlineCount),
    exposureWatchRate: num(metrics.exposureWatchRate),
    watchDealRate: num(metrics.watchDealRate),
    fiveMinSpend: state.fiveMinSpend ?? metrics.fiveMinSpend ?? null,
  };
  const systemPrompt = [
    "你是千川投放智能 Agent，也是运营的全能型 AI 助手。",
    "你可以回答千川实时数据、调控策略、投放 SOP、页面操作、项目功能、模型身份、复盘分析、排障建议和通用运营问题。",
    "回答前先判断用户真正想问什么，第一段必须直接回应用户问题；不要因为出现'追投'、'素材'、'ROI'等关键词就套固定模板。",
    "你的回答要像有经验的投手在看盘：先看现象，再给可能原因，再说需要补采哪些数据，最后给下一步动作。",
    "必须参考 input.memory.preferences 和 input.memory.recentConversation；如果用户前文已经纠正过口径，本轮要延续，不要重复旧错。",
    "涉及实时投放数据时，必须只根据输入的 state 数据回答，不编造数值；涉及通用知识或操作方法时，可以基于你的知识给建议。",
    "涉及当前时间和已直播时长时，只能使用 input.currentTimeLocal 和 input.config.liveDuration；不要根据 UTC 时间自行换算。",
    "涉及单小时 ROI/当前小时 ROI/高低 ROI 判断时，优先使用 input.hourlyBreakdown.current 和 input.metrics.currentHourRoi；没有这些数据时必须说明未采集到，不能用全天 ROI 冒充单小时 ROI。",
    "小时段追投占比的唯一口径是：(input.metrics.hourSegmentSpend - input.metrics.hourSegmentBaseSpend) / input.metrics.hourSegmentSpend；如果缺少小时基础消耗，就说未采集到，不能用全天追投占比代替。",
    "高 ROI 的判断口径：当前小时 ROI >= 目标 ROI 才算高 ROI；目标 ROI × 0.8 只是观察线/一键起量最低准入线，不等于高 ROI。目标 ×0.8 <= ROI < 目标 时，必须说“不达标、不算高 ROI，只是高于观察线”。",
    "当前已取消利润口径；投放判断只按千川账户目标ROI、消耗、成交、追投占比、任务ROI和直播间承接指标。",
    "用户问点击少、点击率低、流量少、素材放量为什么点不动时，必须围绕曝光、点击、点击率、消耗、素材承接来分析，不要泛泛回答追投占比或低 ROI 排名。",
    "回答必须简洁、直接、运营可执行；有实时数据就优先给具体数值、任务名、任务ID后6位、ROI、消耗、预算。",
    "如果用户问的是实时数据但 state 中没有，就明确说'当前未采集到'，不要猜。",
    "如果用户问你是什么模型或能做什么，直接说明当前对话通道使用 input.runtime.model，并说明你是本地千川调控台里的 AI 分析/执行辅助 Agent。",
    "生成 pause_task / increase_task_budget / decrease_task_budget / extend_task_duration / adjust_task_budget_duration 时，taskId 必须来自 input.tasks 中的 taskId；禁止使用直播间ID、房间ID、计划ID或页面ID代替任务ID。如果 input.tasks 没有对应任务，就只分析原因，不要生成 action。",
    "可以用 Markdown，支持加粗、列表、换行。",
    "如果你认为需要操作，在 actions 中给出建议动作；否则 actions 返回空数组。",
    "actions 只允许这些 type：pause_task、increase_task_budget、decrease_task_budget、extend_task_duration、adjust_task_budget_duration、raise_roi_target、lower_roi_target。",
    "每个 action 尽量包含 taskId、taskName；预算动作包含 budget 或 budgetIncrease；时长动作包含 durationHours。",
    "输出必须是严格 JSON：{\"reply\":\"Markdown 分析文本\",\"actions\":[{\"type\":\"pause_task\",\"taskId\":\"...\",\"taskName\":\"...\",\"reason\":\"...\"}]}。",
    "",
    "--- 投放 SOP 规则 ---",
    rulesContext || "未加载到规则，按谨慎原则只做分析。",
    "",
    formatInvestmentSop(config.investmentSop),
  ].join("\n");
  const userPayload = {
    question: message,
    currentTime: new Date().toISOString(),
    currentTimeLocal: `${shanghaiParts().dateText} ${shanghaiParts().timeText} Asia/Shanghai`,
    runtime: {
      model: config.aiModel || "deepseek-v4-pro",
      agentName: "千川 AI 分析智能 Agent",
      mode: "chat_analysis",
      capabilities: ["实时盘况分析", "追投占比分析", "低效任务识别", "风险扫描", "SOP解释", "动作建议", "执行流辅助", "通用运营问答"],
    },
    config: {
      targetRoi: config.targetRoi,
      openTime: config.openTime,
      closeTime: config.closeTime,
      aiModel: config.aiModel,
      liveDuration: liveDurationText(config),
      investmentSop: config.investmentSop || null,
    },
    memory: {
      preferences: Array.isArray(memory.preferences) ? memory.preferences.slice(-20) : [],
      recentConversation: Array.isArray(memory.messages) ? memory.messages.slice(-12).map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, 800),
        ts: item.ts,
      })) : [],
    },
    metrics: chatMetrics,
    hourlyBreakdown: state.hourlyBreakdown ? {
      status: state.hourlyBreakdown.status,
      receivedAt: state.hourlyBreakdown.receivedAt || state.hourlyBreakdown.collectedAt,
      current: state.hourlyBreakdown.current || null,
      rows: Array.isArray(state.hourlyBreakdown.rows) ? state.hourlyBreakdown.rows.slice(-24) : [],
      segments: Array.isArray(state.hourlyBreakdown.segments) ? state.hourlyBreakdown.segments.slice(-24) : [],
    } : null,
    tasks,
    latestSources: state.metricSources || {},
    recentActions: (state.actions || []).slice(0, 10).map((action) => ({
      type: action.type,
      status: action.status,
      taskId: action.payload?.taskId,
      taskName: action.payload?.taskName,
      createdAt: action.createdAt,
    })),
  };
  return { systemPrompt, userPayload };
}

module.exports = { buildSystemPrompt, buildUserPayload, buildChatPrompt };
