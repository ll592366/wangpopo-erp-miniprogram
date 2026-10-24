// ==========================================================================
// cloudfunctions/stocktake — 剩余实点（ARCH v1.5 §4.5；事务 ✅）
// create：差异 = 实际 − 理论（理论 = 期初 + 当日入 − 当日出）；余额覆盖为实际值；
//         同营业日同食材重复提交 = 再次覆盖余额 + 新增一条差异流水（审计链完整）。
// theory：理论剩余查询（录入页实时展示）；list：当日实点记录。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 精度口径 = 3 位（老板 2026-09-19 拍板；与 changeBalance / snapStock / quantizeStock 同口径）。
 *  ⚠️ 绝不可退回 2 位：实盘数量若被截 2 位，下面的 diff/delta 会跟着算错，
 *  「覆盖为实际值」就会把余额写成错的数（账面 0.005、实盘 0.333 → 余额成 0.33）。 */
function num(v) {
  return dbh.quantizeStock(v);
}

/**
 * 下架食材的「库存方向守卫」（2026-10-09 老板拍板 · 与 inventory/index.js 里的孪生实现保持一致）
 *
 * 背景：老板口径是「下架 → 把余货处理掉 → 库存归 0 → 自动隐藏」。原先 create 一律拦
 *       `isActive === false`，下架食材**连盘点清零都做不了**，余货永远出不去、那一行永远藏不掉。
 *
 * 不变式（⚠️ 三条，改动前必读）：
 *   · 已下架（isActive === false）→ **只允许往下**（把余货盘掉），允许盘成 0；
 *   · 已下架 **绝不允许盘出更大的数** —— 那等于给它加库存、让它「复活」；
 *   · 未下架（在售）→ **完全不拦截**，行为一字不变。
 *
 * 落到 delta 上就是一条：delta > 0 且已下架 → 拒。
 * 本函数是覆盖式：delta = 实际 − 账面，故「实点比账面多」= 加库存 → 拒。
 *
 * @param {Object|null} mat  material 文档（null 不拦，任凭调用方处理「食材不存在」）
 * @param {number} delta     有符号变化量（正 = 加库存，负 = 减库存，0 = 不动）
 * @throws {BizError} 3001「「XX」已下架，只能将库存清零，不能增加」
 */
function guardOffShelfNoIncrease(mat, delta) {
  if (!mat || mat.isActive !== false) { return; }
  if (dbh.quantizeStock(delta) > 0) {
    throw new R.BizError(C.CODE.NOT_FOUND,
      '「' + (mat.name || '该食材') + '」已下架，只能将库存清零，不能增加');
  }
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'create');

  /* ---------------- create：实点覆盖（事务） ---------------- */
  if (action === 'create') {
    return auth.requireUser(db, C.ACTION.STOCKTAKE_CREATE, event.storeId || null, event).then(function (ctx) {
      var storeId = String(event.storeId || ctx.user.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      if (ctx.user.role === C.ROLE.SHOP && storeId !== ctx.user.storeId) {
        throw new R.BizError(C.CODE.FORBIDDEN, C.CODE_MSG[1003] + '：非本店');
      }
      var itemId = String(event.itemId || '');
      var actualQty = num(event.actualQty);
      if (!itemId) { throw new R.BizError(C.CODE.NEGATIVE, '请选择食材'); }
      if (actualQty < 0) { throw new R.BizError(C.CODE.NEGATIVE, '实点数量不能为负'); }

      var mat = null;
      var storeName = storeId;
      return db.collection('material').doc(itemId).get().then(function (mres) {
        mat = mres.data;
        // ⚠️ 2026-10-09 改：不再一刀切拦 isActive === false（下架食材要能盘成 0，否则余货永远出不去），
        //    改由 guardOffShelfNoIncrease 按**方向**守：只允许往下（清零），不允许盘出更大的数。
        if (!mat) { throw new R.BizError(C.CODE.NOT_FOUND, '食材未找到或已停用'); }
        return db.collection('store').doc(storeId).get().then(function (sres) {
          if (!sres.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
          storeName = sres.data.name;
          return dbh.genId(db, 'stk', sres.data.code || 'SHOP', 'stocktake');
        });
      }).then(function (stkId) {
        var today = dbh.bizDate();
        return dbh.withTx(db, function (t) {
          return dbh.readBalance(t.collection('stock_balance'), storeId, itemId).then(function (bal) {
            var theory = dbh.theoryOf(bal);
            var diff = dbh.quantizeStock(actualQty - theory);
            var diffType = diff === 0 ? C.DIFF_TYPE.NONE : (diff < 0 ? C.DIFF_TYPE.SHORT : C.DIFF_TYPE.OVER);
            // 余额覆盖为实际值（delta 方向决定日结记 in / out）
            var delta = dbh.quantizeStock(actualQty - bal.qty);
            // 已下架且实点高于账面（要加库存）→ 3001；等于 / 低于账面（往下盘、清零）一律放行
            guardOffShelfNoIncrease(mat, delta);
            var dir = delta >= 0 ? 'in' : 'out';
            // 注意：doc(stkId).set() 的 data 不允许带 _id
            var doc = {
              storeId: storeId, itemId: itemId,
              actualQty: actualQty, theoryQty: theory, diff: diff, diffType: diffType,
              source: 'stocktake', operatorId: ctx.user._id,
              bizDate: today, createdAt: dbh.nowIso()
            };
            return dbh.changeBalance(t, storeId, itemId, delta, dir).then(function () {
              return t.collection('stocktake').doc(stkId).set({ data: doc }).then(function () { return doc; });
            });
          });
        }).then(function (doc) {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.STOCKTAKE_CREATE,
            storeName + ' / ' + mat.name + ' 实点 ' + doc.actualQty + ' ' + mat.unit,
            '理论 ' + doc.theoryQty + ' ' + mat.unit,
            '实际 ' + doc.actualQty + ' ' + mat.unit + '；差异 ' + doc.diff + ' ' + mat.unit + '（' + C.DIFF_TYPE_LABEL[doc.diffType] + '）')
            .then(function () { return { stocktake: Object.assign({ _id: stkId }, doc) }; });
        });
      });
    });
  }

  /* ---------------- theory：理论剩余（录入页实时显示） ---------------- */
  if (action === 'theory') {
    return auth.requireUser(db, C.ACTION.STOCKTAKE_CREATE, event.storeId || null, event).then(function (ctx) {
      var storeId = ctx.user.role === C.ROLE.SHOP ? ctx.user.storeId : String(event.storeId || '');
      var itemId = String(event.itemId || '');
      if (!itemId) { throw new R.BizError(C.CODE.NEGATIVE, '请先选择食材'); }
      return dbh.readBalance(db.collection('stock_balance'), storeId, itemId).then(function (bal) {
        return { itemId: itemId, qty: dbh.theoryOf(bal), bookQty: bal.qty };
      });
    });
  }

  /* ---------------- list：当日实点记录 ---------------- */
  if (action === 'list') {
    return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function (ctx) {
      var storeId = ctx.user.role === C.ROLE.SHOP ? ctx.user.storeId : String(event.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      return db.collection('stocktake')
        .where({ storeId: storeId, bizDate: event.bizDate || dbh.bizDate(), source: 'stocktake' })
        .orderBy('createdAt', 'desc').limit(100).get()
        .then(function (res) { return { list: res.data || [] }; });
    });
  }

  // 原始 action 只写日志，不外泄给用户
  console.error('[UNKNOWN_ACTION]', 'stocktake', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
