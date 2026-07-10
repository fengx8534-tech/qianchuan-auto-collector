function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldCallAI(state, now) {
  const config = state.config || {};
  if (config.aiEnabled !== true) return false;
  const lastAiCallAt = state.lastAiCallAt || 0;
  const minInterval = config.aiMinIntervalMs || 5 * 60 * 1000;
  if (now - lastAiCallAt < minInterval) return false;
  const metrics = state.metrics || {};
  const fiveMinSpend = num(metrics.fiveMinSpend ?? state.fiveMinSpend);
  if (fiveMinSpend > config.highFiveMinSpend) return true;
  if (Number.isFinite(num(metrics.overallRoi)) && Math.abs(metrics.overallRoi - config.targetRoi) > 0.5) return true;
  return (metrics.tasks || []).some((task) => {
    const spend = num(task.spend);
    const budget = num(task.budget);
    const roi = num(task.roi);
    const targetRoi = num(task.targetRoi) ?? config.targetRoi;
    return spend > budget * 0.8 && roi < targetRoi * 0.6;
  });
}

module.exports = { shouldCallAI };
