const INSPECTION_RECORDS_KEY = "inspection_records";

const inspectionRecordSchema = {
  id: "", // 记录ID
  inspectedAt: "", // 巡检时间
  metrics: {
    overallCost: null, // 综合成本
    baseSpend: null, // 基础消耗
    hourRoi: null, // 小时ROI
    overallRoi: null, // 综合ROI
    flowSpeed: null, // 5分钟流速
    boostTasks: 0, // 追投任务数
  },
  derived: {
    boostShare: null, // 追投占比
    baseShare: null, // 基础占比
  },
  ruleResult: {
    quadrantKey: "", // 四象限编码
    quadrantLabel: "", // 四象限位置
    riskFlags: [], // 风险标记
  },
  suggestedActions: [], // 建议动作列表
  userAction: {
    action: "", // 用户实际操作
    target: "", // 操作对象
    value: "", // 操作数值
    confirmedAt: "", // 确认时间
  },
  memo: "", // Memo文本
  remark: "", // 备注
};

function cleanNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function createInspectionRecord(input) {
  const now = new Date();
  return {
    ...inspectionRecordSchema,
    id: String(now.getTime()),
    inspectedAt: now.toISOString(),
    metrics: {
      overallCost: cleanNumber(input.data.overallCost),
      baseSpend: cleanNumber(input.data.baseSpend),
      hourRoi: cleanNumber(input.data.hourRoi),
      overallRoi: cleanNumber(input.data.overallRoi),
      flowSpeed: cleanNumber(input.data.flowSpeed),
      boostTasks: input.data.boostTasks || 0,
    },
    derived: {
      boostShare: cleanNumber(input.boostShare),
      baseShare: cleanNumber(input.baseShare),
    },
    ruleResult: {
      quadrantKey: input.quadrant.key,
      quadrantLabel: input.quadrant.label,
      riskFlags: input.riskFlags || [],
    },
    suggestedActions: input.suggestedActions || [],
    userAction: {
      action: "",
      target: "",
      value: "",
      confirmedAt: "",
    },
    memo: input.memo || "",
    remark: "",
  };
}

window.INSPECTION_RECORDS_KEY = INSPECTION_RECORDS_KEY;
window.inspectionRecordSchema = inspectionRecordSchema;
window.createInspectionRecord = createInspectionRecord;
