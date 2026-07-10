(function () {
  const fieldMap = {
    investOverview: {
      label: "投放管理 overall",
      fields: [
        {
          key: "overallCost",
          label: "综合成本",
          selector: ".card.stat_cost_for_overall_roi2 .oc-promotion-metric-card-number",
        },
        {
          key: "overallRoi",
          label: "综合ROI",
          selector: ".card.total_prepay_and_pay_settle_overall_roi2_1h .oc-promotion-metric-card-number",
        },
        {
          key: "dealAmount",
          label: "净成交金额",
          selector: ".card.total_order_settle_amount_for_roi2_1h .oc-promotion-metric-card-number",
        },
        {
          key: "baseSpend",
          label: "基础消耗",
          extractMethod: "tableRow",
          columnIndex: 7,
          matchText: "基础",
        },
        {
          key: "hourCost",
          label: "小时消耗",
          extractMethod: "metricList",
          matchText: "综合成本",
        },
        {
          key: "hourRoi",
          label: "小时ROI",
          extractMethod: "metricList",
          matchText: "综合ROI",
        },
      ],
    },
    liveScreen: {
      label: "乘方直播大屏",
      fields: [
        {
          key: "overallRoi",
          label: "综合ROI",
          selector: "",
          matchText: "综合ROI",
          cardSelector: ".fixed-item.card-item",
        },
        {
          key: "flowSpeed",
          label: "5分钟流速",
          selector: "",
          canvasRendered: true,
          note: "Canvas 渲染，无法 DOM 读取",
        },
      ],
    },
    investData: {
      label: "投放数据",
      fields: [
        { key: "hourRoi", label: "小时ROI", selector: "" },
        { key: "planSpend", label: "计划消耗", selector: "" },
        { key: "planRoi", label: "计划ROI", selector: "" },
      ],
    },
    controlTable: {
      label: "调控任务表",
      note: "不同调控类型（素材追投、一键起量、搜索抢首屏）表头顺序可能不同。",
      rowSelector: ".task-center-table .ovui-table__body-wrapper tr",
      fields: [
        { key: "name", label: "任务名称", columnIndex: 1 },
        { key: "object", label: "素材", columnIndex: 2 },
        { key: "status", label: "状态", columnIndex: 3 },
        { key: "budget", label: "预算", columnIndex: 4 },
        { key: "targetRoi", label: "综合ROI目标", columnIndex: 5 },
        { key: "payRoi", label: "支付ROI目标", columnIndex: 6 },
        { key: "bid", label: "出价", columnIndex: 7 },
        { key: "duration", label: "时长", columnIndex: 8 },
        { key: "boostMethod", label: "追投方式", columnIndex: 9 },
        { key: "createTime", label: "创建时间", columnIndex: 10 },
        { key: "spend", label: "消耗", columnIndex: 11 },
        { key: "dealAmount", label: "成交金额", columnIndex: 12 },
        { key: "roi", label: "调控ROI", columnIndex: 13 },
        { key: "impressions", label: "展示", columnIndex: 14 },
        { key: "clicks", label: "点击", columnIndex: 15 },
      ],
      variants: {
        materialBoost: {
          label: "素材追投",
          fields: [],
        },
        oneClickLift: {
          label: "一键起量",
          fields: [],
        },
        searchFirstScreen: {
          label: "搜索抢首屏",
          fields: [],
        },
      },
    },
  };

  globalThis.QIANCHUAN_FIELD_MAP = fieldMap;
})();
