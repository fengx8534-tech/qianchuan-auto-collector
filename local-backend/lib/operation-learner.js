function num(value) {
  const parsed = Number.parseFloat(String(value ?? "").replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function taskId(task = {}) {
  return String(task.taskId || task.id || String(task.name || "").match(/ID[：:\s]*(\d{8,})/)?.[1] || "").trim();
}

function taskName(task = {}) {
  return String(task.taskName || task.name || taskId(task) || "未命名任务").replace(/\s*ID[：:]\s*\d+\s*$/, "").trim();
}

function taskTypeLabel(type = "") {
  return {
    materialBoost: "素材放量追投",
    materialCostControl: "素材控成本追投",
    oneClickLift: "一键起量",
  }[type] || "调控任务";
}

function timePeriod(observedAt = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(observedAt));
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  if (hour < 6) return "凌晨";
  if (hour < 12) return "上午";
  if (hour < 18) return "下午";
  return "晚上";
}

function taskSnapshot(task = {}) {
  return {
    taskId: taskId(task),
    taskName: taskName(task),
    taskType: task.taskType || task.type || "unknown",
    status: String(task.status || ""),
    budget: num(task.budget),
    spend: num(task.spend),
    roi: num(task.roi),
    targetRoi: num(task.targetRoi),
    dealAmount: num(task.dealAmount),
    orderCount: num(task.orderCount ?? task.orders),
  };
}

function snapshotTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .map(taskSnapshot)
    .filter((task) => task.taskId);
}

function operationContext(task = {}, context = {}) {
  const budget = num(task.budget);
  const spend = num(task.spend);
  return {
    observedAt: Number(context.observedAt) || Date.now(),
    overallRoi: num(context.overallRoi),
    taskRoi: num(task.roi),
    boostRatio: num(context.boostRatio),
    onlineCount: num(context.onlineCount),
    timePeriod: context.timePeriod || timePeriod(context.observedAt),
    spend,
    budget,
    spendRatio: Number.isFinite(spend) && Number.isFinite(budget) && budget > 0
      ? Math.round((spend / budget) * 10000) / 100
      : null,
  };
}

function isLikelyManualEnd(task = {}, context = {}) {
  const budget = num(task.budget);
  const spend = num(task.spend);
  const roi = num(task.roi);
  const targetRoi = num(task.targetRoi) ?? num(context.targetRoi);
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isFinite(spend) || !Number.isFinite(roi) || !Number.isFinite(targetRoi)) return false;
  const spendRatio = spend / budget;
  const roiIsVeryLow = roi < targetRoi * 0.5;
  if (spendRatio > 0.9 || roiIsVeryLow) return false;
  return spendRatio < 0.3 && roi >= targetRoi * 0.8;
}

function detectManualOperations(previousTasks = [], currentTasks = [], context = {}) {
  const previous = snapshotTasks(previousTasks);
  const current = snapshotTasks(currentTasks);
  if (!previous.length) return [];

  const previousById = new Map(previous.map((task) => [task.taskId, task]));
  const currentById = new Map(current.map((task) => [task.taskId, task]));
  const operations = [];

  current.forEach((task) => {
    if (previousById.has(task.taskId)) return;
    operations.push({
      type: "user_create",
      action: `手动创建了${taskTypeLabel(task.taskType)}`,
      taskName: task.taskName,
      taskId: task.taskId,
      context: operationContext(task, context),
    });
  });

  previous.forEach((task) => {
    if (currentById.has(task.taskId) || !isLikelyManualEnd(task, context)) return;
    operations.push({
      type: "user_end",
      action: `手动结束了${task.taskName}`,
      taskName: task.taskName,
      taskId: task.taskId,
      context: operationContext(task, context),
    });
  });

  current.forEach((task) => {
    const previousTask = previousById.get(task.taskId);
    if (!previousTask) return;
    const previousBudget = num(previousTask.budget);
    const currentBudget = num(task.budget);
    if (Number.isFinite(previousBudget) && Number.isFinite(currentBudget) && Math.abs(previousBudget - currentBudget) >= 0.01) {
      operations.push({
        type: "user_adjust_budget",
        action: `手动调整预算：${previousBudget}→${currentBudget}`,
        taskName: task.taskName,
        taskId: task.taskId,
        context: operationContext(task, context),
      });
    }
    const previousRoi = num(previousTask.targetRoi);
    const currentRoi = num(task.targetRoi);
    if (Number.isFinite(previousRoi) && Number.isFinite(currentRoi) && Math.abs(previousRoi - currentRoi) >= 0.01) {
      operations.push({
        type: "user_adjust_roi",
        action: `手动调整ROI：${previousRoi}→${currentRoi}`,
        taskName: task.taskName,
        taskId: task.taskId,
        context: operationContext(task, context),
      });
    }
  });

  return operations;
}

module.exports = { detectManualOperations, snapshotTasks };
