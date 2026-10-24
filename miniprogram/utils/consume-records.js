// ==========================================================================
// utils/consume-records.js — 消耗记录「分页拉取」（列表加载更多 + 导出循环拉全量）
//   老板 2026-09-19：导出必须是「时间范围内全量」，不设业务条数上限 → 循环分页累加。
//   后端 production.list 契约：请求 { action:'list', storeId?, from, to, offset, limit }
//                             返回 { data: { list:[...], hasMore:bool } }
//   · limit 传 500（云函数物理上限 1000，无业务条数上限）
//   · hasMore=false → 已到底；空页 / offset 不增长 / 超过页数上限 → 防死循环中断
// ==========================================================================
var cloud = require('./cloud');
var fmt = require('./format');

var EXPORT_HEADERS = ['日期', '时间', '菜品', '份数', '状态', '食材', '单位', '消耗量'];

/** 单页拉取 production.list（列表加载更多 / 导出循环 共用） */
function fetchPage(opts) {
  var req = { action: 'list', from: opts.from, to: opts.to, offset: opts.offset || 0, limit: opts.limit || 100 };
  if (opts.storeId) { req.storeId = opts.storeId; }   // 门店端不传 → 后端强制本店
  return cloud.call('production', req);
}

/**
 * 循环分页拉「时间范围内全量」（导出用）。
 * 防呆兜底（防死循环，不是业务上限）：
 *   · hasMore=false           → 正常结束
 *   · 某页 list.length === 0   → 中断（应到底但后端仍说 hasMore）
 *   · 不足一页（< pageSize）   → 视为到底
 *   · 页数超过 GUARD_MAX       → 中断
 * @param {{storeId?:string,from:string,to:string,pageSize?:number,onProgress?:function}} opts
 * @returns Promise<{code:number, list:Array, interrupted:boolean, reason:string}>
 */
function fetchAll(opts) {
  var pageSize = opts.pageSize || 500;
  var GUARD_MAX = 1000;   // 500 条/页 × 1000 = 50 万条；正常绝碰不到
  var offset = 0;
  var acc = [];
  var guard = 0;

  function step() {
    return fetchPage({ storeId: opts.storeId, from: opts.from, to: opts.to, offset: offset, limit: pageSize })
      .then(function (res) {
        if (!res || res.code !== 0) {
          return { code: (res && res.code) || 5001, list: acc, interrupted: true,
            reason: (res && res.message) || '数据加载失败，请重试' };
        }
        var list = (res.data && res.data.list) || [];
        var hasMore = !!(res.data && res.data.hasMore);

        if (hasMore === false) {                 // 正常到底
          if (list.length > 0) { acc = acc.concat(list); }
          if (opts.onProgress) { opts.onProgress(acc.length); }
          return { code: 0, list: acc, interrupted: false, reason: '' };
        }
        if (list.length === 0) {                 // 防呆：应到底却仍 hasMore → 中断
          return { code: 0, list: acc, interrupted: true, reason: '数据加载中断，请重试' };
        }
        acc = acc.concat(list);
        offset += list.length;                   // 用「实际返回条数」推进，保证 offset 增长
        if (opts.onProgress) { opts.onProgress(acc.length); }

        if (list.length < pageSize) {            // 不足一页 → 视为到底（防死循环）
          return { code: 0, list: acc, interrupted: false, reason: '' };
        }
        guard += 1;
        if (guard > GUARD_MAX) {
          return { code: 0, list: acc, interrupted: true, reason: '数据量过大，已加载部分，请缩小时间范围后重试' };
        }
        return step();
      });
  }
  return step();
}

/**
 * 产出导出表头 + 明细行（一条出品有几种食材就输出几行，前 5 列重复，便于透视表）
 * @param {Array} list     production 记录（raw）
 * @param {Object} matMap  { itemId: material }
 * @param {Object} dishMap { dishId: dish }
 */
function buildExportRows(list, matMap, dishMap) {
  var rows = [];
  (list || []).forEach(function (p) {
    var d = (dishMap || {})[p.dishId];
    var dishName = (d && d.name) || p.dishName || ('#' + p.dishId);
    var timeHm = (String(p.createdAt || '').match(/T(\d{2}:\d{2})/) || [])[1] || '';
    var statusLabel = p.status === 'confirmed' ? '已出品' : '已撤回';
    var date = p.bizDate || fmt.bizDate(p.createdAt);
    var items = (p.consumeItems || []).map(function (ci) {
      var m = (matMap || {})[ci.itemId] || {};
      return { name: m.name || ci.itemId, unit: m.unit || '', qty: Number(ci.qty) || 0 };
    });
    if (items.length === 0) {
      rows.push([date, timeHm, dishName, String(p.qty || 0), statusLabel, '', '', '']);
    } else {
      items.forEach(function (di) {
        rows.push([date, timeHm, dishName, String(p.qty || 0), statusLabel, di.name, di.unit, fmt.fmt3(di.qty)]);
      });
    }
  });
  return { headers: EXPORT_HEADERS.slice(), rows: rows };
}

module.exports = {
  EXPORT_HEADERS: EXPORT_HEADERS,
  fetchPage: fetchPage,
  fetchAll: fetchAll,
  buildExportRows: buildExportRows
};
