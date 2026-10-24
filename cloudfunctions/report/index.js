// ==========================================================================
// cloudfunctions/report — 分店经营 / 食材预警（ARCH v1.5 §4.5；只读）
// type=business：区间内各分店出品 / 消耗 / 实点差异（纯数量，无金额；闭店店仍列出）
// type=lowStock：总仓食材预警（阈值 = material.lowStockThreshold || 默认 2；alert.view 显式传 WAREHOUSE，§4.4 注）
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 精度口径 = 3 位（与余额写入同口径）。报表数值必须能对上明细，2 位截断会出现「合计不等于明细」。 */
function r2(n) { return dbh.quantizeStock(n); }

/** 预警页一次拉取食材档案的上限（2026-10-09 修静默截断）。
 *  ⚠️ 原先写死 limit(100) 且无 orderBy：食材破 100 条后，第 101 条起被云开发直接截掉 ——
 *     少掉的可能正是**该预警的那一条**（新建的食材没被扫到 → 不报警），且没有任何报错。 */
var MAX_LIST = 500;

exports.main = R.wrap(function (event) {
  var type = String(event.type || 'business');

  /* ---------------- business：分店经营（manager） ---------------- */
  if (type === 'business') {
    return auth.requireUser(db, C.ACTION.REPORT_BUSINESS, null, event).then(function () {
      var today = dbh.bizDate();
      var from = event.from || today;
      var to = event.to || today;
      return Promise.all([
        db.collection('store').limit(100).get(),
        db.collection('production')
          .where({ status: C.PROD_STATUS.CONFIRMED, bizDate: db.command.gte(from).and(db.command.lte(to)) })
          .limit(1000).get(),
        db.collection('stocktake')
          .where({ source: 'stocktake', bizDate: db.command.gte(from).and(db.command.lte(to)) })
          .limit(1000).get()
      ]).then(function (rs) {
        var stores = rs[0].data || [];
        var prods = rs[1].data || [];
        var takes = rs[2].data || [];
        var rows = stores.map(function (s) {
          var dishMap = {};
          var consumeMap = {};
          prods.filter(function (p) { return p.storeId === s._id; }).forEach(function (p) {
            dishMap[p.dishId] = r2((dishMap[p.dishId] || 0) + p.qty);
            (p.consumeItems || []).forEach(function (ci) {
              consumeMap[ci.itemId] = r2((consumeMap[ci.itemId] || 0) + ci.qty);
            });
          });
          var diff = 0;
          takes.filter(function (t2) { return t2.storeId === s._id; }).forEach(function (t2) {
            diff = r2(diff + Number(t2.diff));
          });
          return {
            storeId: s._id, name: s.name,
            status: s.status || C.STORE_STATUS.OPEN, closedAt: s.closedAt || null,
            dishQty: dishMap, consumeQty: consumeMap, diff: diff
          };
        });
        return { from: from, to: to, rows: rows };
      });
    });
  }

  /* ---------------- lowStock：总仓食材预警（manager · 显式 WAREHOUSE） ---------------- */
  if (type === 'lowStock') {
    return auth.requireUser(db, C.ACTION.ALERT_VIEW, C.STORE_WAREHOUSE, event).then(function () {
      /* ⚠️ 原先 limit(100) 且无 orderBy（2026-10-09 修静默截断）：食材破 100 条后
       *   第 101 条起被直接截掉，**该报预警的可能正好是被截掉的那条**（新建食材不报警）。
       *   orderBy('createdAt','desc')：新建的排最前，一定落在拉取窗口内。
       *   ⚠️ 本 type 的 rows 是**预警行**（经过阈值过滤），不是食材行，
       *      所以**不套** truncated = total > rows.length（那是假截断信号），改为命中上限打日志。 */
      return db.collection('material').orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(MAX_LIST).get().then(function (mres) {
        var mats = (mres.data || []).filter(function (m) { return m.isActive !== false; });
        if ((mres.data || []).length >= MAX_LIST) {
          console.error('[TRUNCATED] report.lowStock 食材数已达上限 ' + MAX_LIST
            + ' 条，可能还有更多（真被截断：请加分页，不要静默漏报预警）');
        }
        var reads = mats.map(function (m) {
          return dbh.readBalance(db.collection('stock_balance'), C.STORE_WAREHOUSE, m._id).then(function (bal) {
            var th = (m.lowStockThreshold !== null && m.lowStockThreshold !== undefined && Number(m.lowStockThreshold) > 0)
              ? r2(m.lowStockThreshold) : C.CONFIG.LOW_STOCK_THRESHOLD;
            var qty = r2(bal.qty);
            return { itemId: m._id, name: m.name, unit: m.unit, qty: qty, threshold: th, gap: r2(th - qty) };
          });
        });
        return Promise.all(reads);
      }).then(function (all) {
        var rows = all.filter(function (r) { return r.qty < r.threshold; })
          .sort(function (a, b) { return b.gap - a.gap; });
        return { storeId: C.STORE_WAREHOUSE, rows: rows, defaultThreshold: C.CONFIG.LOW_STOCK_THRESHOLD };
      });
    });
  }

  // 原始 type 只写日志，不外泄给用户
  console.error('[UNKNOWN_TYPE]', 'report', type);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
