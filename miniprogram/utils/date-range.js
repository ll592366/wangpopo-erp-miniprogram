// ==========================================================================
// utils/date-range.js — 时间范围工具（消耗汇总页 / 管理端门店详情 / 门店端消耗 三处共用）
//   老板 2026-09-19 拍板：消耗记录要能按 本周 / 本月 / 自定义 / 全部 筛选。
//   本项目禁 ES Module（CommonJS）。日期一律 'YYYY-MM-DD'（营业日口径，见 format.bizDate）。
//   这里只做「范围计算 + 文案」，不发请求、不碰云函数。
// ==========================================================================
var fmt = require('./format');

/** 预设档位（消耗记录两处 tab 用；汇总页在此基础上多一档「今日」，见 consume-summary.js） */
var PRESETS = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'custom', label: '自定义' },
  { key: 'all', label: '全部' }
];

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 营业日今天（YYYY-MM-DD） */
function today() { return fmt.bizDate(); }

/** 本周一（老板已认可中国习惯：周一为一周起点） */
function weekStart(ymd) {
  var p = String(ymd).split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var back = d.getDay() === 0 ? 6 : d.getDay() - 1;   // 周日 → 回退 6 天到周一
  var t = new Date(d.getTime() - back * 24 * 3600 * 1000);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

/** 本月 1 号（YYYY-MM-DD） */
function monthStart(ymd) {
  var p = String(ymd).split('-');
  return p[0] + '-' + p[1] + '-01';
}

/** MM-DD（胶囊/标题简写用） */
function mmdd(ymd) {
  var p = String(ymd).split('-');
  return p.length === 3 ? (p[1] + '-' + p[2]) : String(ymd);
}

var RE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 归一化自定义区间：缺值兜底成「本月」，并保证 from <= to（非法区间自动纠正）。
 * @returns {{from:string,to:string}}
 */
function normCustom(custom) {
  var from = (custom && custom.from) || '';
  var to = (custom && custom.to) || '';
  if (!RE_YMD.test(from)) { from = monthStart(today()); }
  if (!RE_YMD.test(to)) { to = today(); }
  if (from > to) { to = from; }        // from > to → 把 to 拉到 from（保持合法区间）
  return { from: from, to: to };
}

/**
 * 计算 [from, to]（含当天）。
 * @param {string} kind 'today' | 'week' | 'month' | 'custom' | 'all'
 * @param {{from:string,to:string}} [custom] kind='custom' 时使用，缺值兜底成「本月」
 * @returns {{from:string,to:string}} 'all' 用极早日期表示无下界
 */
function rangeOf(kind, custom) {
  if (kind === 'custom') { return normCustom(custom); }
  var t = today();
  if (kind === 'today') { return { from: t, to: t }; }
  if (kind === 'week') { return { from: weekStart(t), to: t }; }
  if (kind === 'month') { return { from: monthStart(t), to: t }; }
  return { from: '1970-01-01', to: t };   // 'all'
}

/** 范围中文名：'本周' / '本月' / '09-01~09-19'（自定义）/ '全部' / '今日' */
function labelOf(kind, custom) {
  if (kind === 'custom') {
    var r = normCustom(custom);
    return mmdd(r.from) + '~' + mmdd(r.to);
  }
  for (var i = 0; i < PRESETS.length; i++) {
    if (PRESETS[i].key === kind) { return PRESETS[i].label; }
  }
  if (kind === 'today') { return '今日'; }
  return '';
}

/** 空态文案按档换词：'本月暂无消耗记录' / '2026-09-01~2026-09-19 暂无消耗记录' / '暂无消耗记录' */
function emptyText(kind, custom) {
  if (kind === 'all') { return '暂无消耗记录'; }
  if (kind === 'custom') {
    var r = normCustom(custom);
    return r.from + '~' + r.to + ' 暂无消耗记录';
  }
  return labelOf(kind, custom) + '暂无消耗记录';
}

/**
 * 文件名用范围标签（导出防重名）：
 *   固定档 → '20260901-20260919'（同一日则 '20260919'）；'all' → '全部'
 */
function rangeTag(kind, custom) {
  if (kind === 'all') { return '全部'; }
  var r = rangeOf(kind, custom);
  var f = r.from.replace(/-/g, '');
  var t = r.to.replace(/-/g, '');
  return f === t ? f : (f + '-' + t);
}

module.exports = {
  PRESETS: PRESETS,
  rangeOf: rangeOf,
  labelOf: labelOf,
  emptyText: emptyText,
  rangeTag: rangeTag,
  today: today,
  weekStart: weekStart,
  monthStart: monthStart,
  normCustom: normCustom,
  mmdd: mmdd
};
