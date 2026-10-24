// ==========================================================================
// utils/format.js — 格式化工具（ARCH v1.5 §2）
// 全库只记数量、不记金额：只保留 formatQty(n, unit) / fmt3(n)，无 formatMoney；
// 单位自由文本，无 UNIT_LABEL[unit] || '斤' 兜底映射（单位原样展示，不换算）。
// ==========================================================================

/** 四舍五入到 2 位小数 */
function round2(n) {
  var v = Number(n);
  if (isNaN(v)) { v = 0; }
  return Math.round(v * 100) / 100;
}

/** 宽松转数字（空串 / undefined / 非法 → fallback） */
function toNum(v, fallback) {
  if (v === undefined || v === null || v === '') { return fallback === undefined ? 0 : fallback; }
  var n = Number(v);
  return isNaN(n) ? (fallback === undefined ? 0 : fallback) : n;
}

/**
 * 数量格式化（唯一数量出口；单位由调用方传食材 material.unit，自由文本）
 * @param {number} n     数量
 * @param {string} [unit] 单位（可空；为空只出数字）
 * @returns {string}
 */
function formatQty(n, unit) {
  var s = round2(n).toFixed(2);
  return unit ? s + ' ' + unit : s;
}

/**
 * 数量格式化 · 3 位小数且去掉末尾多余的 0（消耗汇总 / 导出统一口径，2026-09-19）
 *   2.000 → '2'；3.3333 → '3.333'；0.500 → '0.5'；0 → '0'
 * @param {number} n 数量
 * @returns {string}
 */
function fmt3(n) {
  var v = Number(n);
  if (isNaN(v)) { v = 0; }
  var s = (Math.round(v * 1000) / 1000).toFixed(3);
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s || '0';
}

/** 补零 */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/**
 * 营业日 YYYY-MM-DD（04:00 切分，UTC+8）
 * 04:00 之前算前一个营业日（D8：报数按营业日分桶）
 */
function bizDate(d) {
  var t = d ? new Date(d) : new Date();
  // 转 UTC+8
  var cn = new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000);
  if (cn.getHours() < 4) {
    cn = new Date(cn.getTime() - 24 * 3600 * 1000);
  }
  return cn.getFullYear() + '-' + pad2(cn.getMonth() + 1) + '-' + pad2(cn.getDate());
}

/** YYYYMMDD（单据号用） */
function yyyymmdd(d) {
  return bizDate(d).replace(/-/g, '');
}

/** 当前 UTC+8 ISO 串（含 +08:00 后缀） */
function nowIso() {
  var t = new Date();
  var cn = new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000);
  return cn.getFullYear() + '-' + pad2(cn.getMonth() + 1) + '-' + pad2(cn.getDate()) +
    'T' + pad2(cn.getHours()) + ':' + pad2(cn.getMinutes()) + ':' + pad2(cn.getSeconds()) + '+08:00';
}

/** MM-DD HH:mm（列表时间展示） */
function fmtShort(iso) {
  if (!iso) { return '—'; }
  var m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) { return String(iso); }
  return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}

/** YYYY-MM-DD HH:mm */
function fmtYmdHm(iso) {
  if (!iso) { return '—'; }
  var m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) { return String(iso); }
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}

/** 相对今天的偏移营业日（-1 = 昨天） */
function shiftDay(ymd, delta) {
  var parts = String(ymd).split('-');
  var t = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  t = new Date(t.getTime() + delta * 24 * 3600 * 1000);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

module.exports = {
  round2: round2,
  toNum: toNum,
  formatQty: formatQty,
  fmt3: fmt3,
  bizDate: bizDate,
  yyyymmdd: yyyymmdd,
  nowIso: nowIso,
  fmtShort: fmtShort,
  fmtYmdHm: fmtYmdHm,
  shiftDay: shiftDay
};
