// ==========================================================================
// utils/list-search.js — 列表本地检索（老板 2026-10 拍板「每个列表页面都要增加一个检索功能」）
//
// 为什么放在 utils 而不是各页各写一份：
//   · 11 处列表页的匹配口径必须**一模一样**（不区分大小写、支持中文、空关键词=不过滤），
//     各写各的迟早会出现「这个页面能搜、那个页面搜不到」的鬼故事。
//   · 纯本地过滤，**不调云函数**：老板打一个字就出结果（不等网络），也不消耗月 20 万调用配额。
//
// 约定（全站统一）：
//   kw 为空 / 只有空格 → 原样返回（调用方把过滤结果写回同一个 data 字段即可）
//   fields 是要匹配的字段名数组，如 ['name']、['_id', 'storeName']
// ==========================================================================

/** 归一：转字符串 + 转小写；null/undefined 当空串（不拼出 "undefined" 这种脏词） */
function norm(v) {
  if (v === undefined || v === null) { return ''; }
  return String(v).toLowerCase();
}

/**
 * 这一行是否命中
 * @param {object} row    行数据
 * @param {string} kw     搜索词（空 = 全部命中）
 * @param {Array<string>} fields 参与匹配的字段名
 * @returns {boolean}
 */
function hit(row, kw, fields) {
  var k = norm(kw).replace(/^\s+|\s+$/g, '');
  if (!k) { return true; }
  var src = row || {};
  for (var i = 0; i < (fields || []).length; i++) {
    var v = src[fields[i]];
    if (Array.isArray(v)) { v = v.join(' '); }   // 数组字段（如账号列表）拼起来一起匹配
    if (norm(v).indexOf(k) >= 0) { return true; }
  }
  return false;
}

/**
 * 过滤列表（**返回新数组**，不改动原数组 —— 原数组要留作重新过滤的底稿）
 * @param {Array<object>} rows    全量行（页面实例上缓存的那份）
 * @param {string} kw             搜索词
 * @param {Array<string>} fields  参与匹配的字段名
 * @returns {Array<object>}
 */
function filter(rows, kw, fields) {
  var list = rows || [];
  var k = norm(kw).replace(/^\s+|\s+$/g, '');
  if (!k) { return list.slice(); }
  return list.filter(function (r) { return hit(r, k, fields); });
}

module.exports = { filter: filter, hit: hit, norm: norm };