// ==========================================================================
// cloudfunctions/inventory — 余额查询（ARCH v1.5 §4.5；只读 ❌ 事务）
// manager：默认总仓（WAREHOUSE），可传 storeId 查任意店；shop：强制本店。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 回查食材档案名的 _id 批量上限（微信云开发单次 where in 取 100，这里保守取 50） */
var NAME_CHUNK = 50;

/** 库存页一次拉取食材档案的上限（2026-10-09 修静默截断）。
 *  ⚠️ 原先写死 limit(100) 且无 orderBy：食材破 100 条后第 101 条起被云开发直接截掉，
 *     库存页**凭空少行**且无任何报错（新建的食材看不到、它的库存也看不到）。 */
var MAX_LIST = 500;

/**
 * 门店行**行级**生效阈值（2026-10-09 库存校准加）：
 *   ① 该食材的单独阈值 store.itemThresholds[itemId]（数字 > 0 时）
 *   ② 否则本店统一阈值 storeThresholdOf(storeDoc)（含没设 → 回落默认 2）
 * ⚠️ 只用于**门店**语境；总仓行完全不走这里（总仓用 material 档案阈值，原表达式一字未动）。
 * @param {Object|null} storeDoc store 文档
 * @param {string} itemId        食材 _id
 * @returns {number} 一定 > 0
 */
function rowThresholdOf(storeDoc, itemId) {
  var map = storeDoc && storeDoc.itemThresholds;
  if (map && typeof map === 'object') {
    var n = Number(map[itemId]);
    if (isFinite(n) && n > 0) { return dbh.quantizeStock(n); }
  }
  return dbh.storeThresholdOf(storeDoc);
}

/**
 * 下架食材的「库存方向守卫」（2026-10-09 老板拍板 · 与 stocktake/index.js 里的孪生实现保持一致）
 *
 * 背景：老板口径是「下架 → 把余货处理掉 → 库存归 0 → 自动隐藏」，这条链路必须走得通。
 *      原先 adjust / calibrate / stocktake 三个入口一律拦 `isActive === false`，
 *      下架食材的库存就**永远清不掉**，那一行会一直挂在库存列表里 —— 主干流程被掐死。
 *
 * 不变式（⚠️ 三条，改动前必读）：
 *   · 已下架（isActive === false）→ **只允许往下**（把余货处理掉），允许归零；
 *   · 已下架 **绝不允许增加库存** —— 那等于让它「复活」，与「下架」语义直接冲突；
 *   · 未下架（在售）→ **完全不拦截**，行为一字不变（可增可减）。
 *
 * 落到「delta」上就是一条：delta > 0 且已下架 → 拒。
 * 覆盖式（target）与增量式（delta）都先算出「有符号变化量」再调本函数，口径统一。
 *
 * @param {Object|null} mat   material 文档（null 不拦，任凭调用方自己处理「食材不存在」）
 * @param {number} delta      有符号变化量（正 = 加库存，负 = 减库存，0 = 不动）
 * @throws {BizError} 3001「「XX」已下架，只能将库存清零，不能增加」
 */
function guardOffShelfNoIncrease(mat, delta) {
  if (!mat || mat.isActive !== false) { return; }
  if (dbh.quantizeStock(delta) > 0) {
    throw new R.BizError(C.CODE.NOT_FOUND,
      '「' + (mat.name || '该食材') + '」已下架，只能将库存清零，不能增加');
  }
}

/** 批量回查食材名：_id 分批（每批 ≤ NAME_CHUNK），批间并发。查不到返回空 map（调用方兜占位） */
function loadNameMap(coll, ids) {
  var uniq = [];
  (ids || []).forEach(function (id) { if (id && uniq.indexOf(id) < 0) { uniq.push(id); } });
  var chunks = [];
  for (var i = 0; i < uniq.length; i += NAME_CHUNK) { chunks.push(uniq.slice(i, i + NAME_CHUNK)); }
  if (chunks.length === 0) { return Promise.resolve({}); }
  return Promise.all(chunks.map(function (c) {
    return coll.where({ _id: db.command.in(c) }).limit(NAME_CHUNK).get();
  })).then(function (ress) {
    var map = {};
    ress.forEach(function (res) {
      (res.data || []).forEach(function (m) { map[m._id] = m.name; });
    });
    return map;
  });
}

exports.main = R.wrap(function (event) {
  /* 手工调整总仓数量（manager）：
   * · 传 target → **覆盖式**：把总仓置为目标值（事务内读现值算 delta），3 位小数精度；
   * · 不传 target → 老口径增量（delta 可正可负，同样 3 位精度）；两者 op_log 均留痕。 */
  if (event.action === 'adjust') {
    return auth.requireUser(db, C.ACTION.PURCHASE_CREATE, null, event).then(function (ctx) {
      var itemId = String(event.itemId || '');
      if (!itemId) { throw new R.BizError(C.CODE.NEGATIVE, '请先选择食材'); }

      var hasTarget = (event.target !== undefined && event.target !== null &&
        String(event.target).trim() !== '');
      var targetQty = null;   // 覆盖式目标值（已量化到 3 位）
      var delta = 0;          // 增量式变化量（老口径）
      if (hasTarget) {
        var tn = Number(event.target);
        if (!isFinite(tn)) { throw new R.BizError(C.CODE.NEGATIVE, '数量必须是数字'); }
        if (tn < 0) { throw new R.BizError(C.CODE.NEGATIVE, '数量不能为负数'); }
        targetQty = dbh.quantizeStock(tn);
      } else {
        // 增量式也必须是 3 位：2 位截断会让「加 0.333」变成「加 0.33」，与覆盖式口径不一致
        delta = dbh.quantizeStock(event.delta);
        if (!delta) { throw new R.BizError(C.CODE.NEGATIVE, '调整数量不能为 0'); }
      }

      return db.collection('material').doc(itemId).get().then(function (mres) {
        var mat = mres.data;
        // ⚠️ 2026-10-09 改：**不再**一刀切拦 isActive === false（那样下架食材的库存永远清不掉，
        //    而「下架 → 处理余货 → 归零 → 自动隐藏」是这个功能的主干）。
        //    改为按**方向**守：只允许往下（清零），不允许往上加 —— 见 guardOffShelfNoIncrease。
        if (!mat) { throw new R.BizError(C.CODE.NOT_FOUND, '食材未找到或已停用'); }

        /* ---------- 覆盖式：事务内读现值 → delta = 目标 − 现值 → changeBalance ---------- */
        if (hasTarget) {
          return dbh.withTx(db, function (t) {
            return dbh.readBalance(t.collection('stock_balance'), C.STORE_WAREHOUSE, itemId)
              .then(function (bal) {
                var qtyBefore = dbh.quantizeStock(Number(bal.qty) || 0);
                var d = dbh.quantizeStock(targetQty - qtyBefore);
                guardOffShelfNoIncrease(mat, d);   // 已下架且 d > 0（要加库存）→ 3001
                if (d === 0) {
                  // 目标 = 现值：不动余额、不留 op_log
                  return { before: qtyBefore, after: qtyBefore, changed: false };
                }
                // ⚠️ changeBalance 收的是「有符号 delta」（正入负出）；dir 只决定记 dayIn/dayOut。
                return dbh.changeBalance(t, C.STORE_WAREHOUSE, itemId, d, d > 0 ? 'in' : 'out')
                  .then(function (b) { return { before: b.before, after: b.after, changed: true }; });
              });
          }).then(function (r) {
            if (!r.changed) {
              return { balanceAfter: { before: r.before, after: r.after }, changed: false };
            }
            return dbh.log(db, ctx.user._id, ctx.user.name, 'inventory.adjust',
              '总仓 / ' + mat.name + ' 覆盖为 ' + targetQty + ' ' + mat.unit,
              '总仓 ' + mat.name + ' ' + r.before + ' ' + mat.unit,
              '总仓 ' + mat.name + ' ' + r.after + ' ' + mat.unit)
              .then(function () {
                return { balanceAfter: { before: r.before, after: r.after }, changed: true };
              });
          });
        }

        /* ---------- 增量式（老口径：有符号 delta，正入负出） ---------- */
        // 已下架且 delta > 0（要加库存）→ 3001；往下减 / 清零一律放行
        guardOffShelfNoIncrease(mat, delta);
        return dbh.withTx(db, function (t) {
          return dbh.changeBalance(t, C.STORE_WAREHOUSE, itemId, delta, delta > 0 ? 'in' : 'out')
            .then(function (bal) { return bal; });
        }).then(function (bal) {
          return dbh.log(db, ctx.user._id, ctx.user.name, 'inventory.adjust',
            '总仓 / ' + mat.name + ' ' + (delta > 0 ? '+' : '') + delta + ' ' + mat.unit,
            '总仓 ' + mat.name + ' ' + bal.before + ' ' + mat.unit,
            '总仓 ' + mat.name + ' ' + bal.after + ' ' + mat.unit)
            .then(function () { return { balanceAfter: bal, changed: true }; });
        });
      });
    });
  }

  /* ---------------- calibrate：库存校准（manager · 2026-10-09 老板拍板） ----------------
   * 入参 { storeId, itemId, qty?, threshold? }
   *   · qty        undefined/空 = 不改库存；数字 ≥0（**0 是合法实点数**）= 覆盖式校准
   *   · threshold  undefined = 不改；null/空 = 清除该食材单独阈值；数字 >0 = 设置
   *   · storeId    普通门店或 'WAREHOUSE'（总仓校准不允许带 threshold）
   * 出参 { storeId, itemId, qty, threshold }
   * ⚠️ 数量校准会写一条 stocktake（source:'calibrate'）留痕，字段结构镜像 stocktake.create；
   *    阈值-only 修改不写 stocktake（没动库存，不该产生差异流水）。
   */
  if (event.action === 'calibrate') {
    return auth.requireUser(db, C.ACTION.INVENTORY_CALIBRATE, null, event).then(function (ctx) {
      var storeId = String(event.storeId || '');
      var itemId = String(event.itemId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      if (!itemId) { throw new R.BizError(C.CODE.NEGATIVE, '请先选择食材'); }
      var isWh = (storeId === C.STORE_WAREHOUSE);

      /* ---- 解析 qty ---- */
      var hasQty = !(event.qty === undefined || event.qty === null || String(event.qty).trim() === '');
      var targetQty = 0;
      if (hasQty) {
        var qn = Number(event.qty);
        if (!isFinite(qn)) { throw new R.BizError(C.CODE.NEGATIVE, '库存数量必须是数字'); }
        if (qn < 0) { throw new R.BizError(C.CODE.NEGATIVE, '库存数量不能为负数'); }   // ⚠️ 0 是合法实点数
        targetQty = dbh.quantizeStock(qn);
      }

      /* ---- 解析 threshold ---- */
      var hasTh = (event.threshold !== undefined);
      var thVal = null;      // 数字（>0）
      var thClear = false;   // true = 删除 itemThresholds[itemId]
      if (hasTh) {
        if (event.threshold === null || String(event.threshold).trim() === '') {
          thClear = true;
        } else {
          var tn = Number(event.threshold);
          if (!isFinite(tn)) { throw new R.BizError(C.CODE.NEGATIVE, '预警阈值必须是数字'); }
          if (!(tn > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '预警阈值必须大于 0'); }
          thVal = dbh.quantizeStock(tn);
        }
      }
      // 总仓没有"门店阈值"概念：食材级阈值归食材档案，本店统一阈值归门店
      if (isWh && hasTh) {
        throw new R.BizError(C.CODE.NEGATIVE, '总仓不支持设置食材单独阈值，请到食材档案里设置');
      }
      if (!hasQty && !hasTh) { throw new R.BizError(C.CODE.NEGATIVE, '没有需要保存的修改'); }

      /* ---- 名称回查（绝不把内部 _id 抛给用户） ---- */
      var mat = null;
      var storeDoc = null;
      var storeName = isWh ? '总仓' : storeId;
      var storeCode = isWh ? 'WAREHOUSE' : 'SHOP';
      return db.collection('material').doc(itemId).get().catch(function () { return { data: null }; })
        .then(function (mres) {
          mat = mres.data;
          // ⚠️ 2026-10-09 改：不再一刀切拦 isActive === false（下架食材要能清零，否则永远藏不掉），
          //    改由 guardOffShelfNoIncrease 按**方向**守：只允许往下（归零），不允许往上加。
          if (!mat) { throw new R.BizError(C.CODE.NOT_FOUND, '食材未找到或已停用'); }
          if (isWh) { return null; }
          return db.collection('store').doc(storeId).get().catch(function () { return { data: null }; })
            .then(function (sres) {
              if (!sres.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
              storeDoc = sres.data;
              storeName = storeDoc.name || storeId;
              storeCode = storeDoc.code || 'SHOP';
              return null;
            });
        }).then(function () {
          /* ---- ① 数量校准：事务内读现值 → 算有符号 delta → changeBalance + 写校准流水 ---- */
          var snap = { before: 0, after: 0, delta: 0 };
          var step1 = hasQty ? dbh.genId(db, 'stk', storeCode, 'stocktake').then(function (stkId) {
            return dbh.withTx(db, function (t) {
              // ⚠️ 事务内禁并发 / 禁 where：读写一律串行，且余额读写必须走 dbh.changeBalance
              //    （内部已做「文档不存在」多形态白名单兜底，不要自己写 get+set）。
              return dbh.serial([
                function () {
                  return dbh.readBalance(t.collection('stock_balance'), storeId, itemId)
                    .then(function (bal) { snap.before = dbh.quantizeStock(Number(bal.qty) || 0); });
                },
                function () {
                  // 有符号 delta（正入负出）—— **绝不 Math.abs**；delta=0 也要走一遍，
                  // 保证 dayOpen/日结字段与「确实盘过」这件事被记录下来。
                  snap.delta = dbh.quantizeStock(targetQty - snap.before);
                  // 已下架且校准目标高于现值（要加库存）→ 3001；等于 / 低于现值（清零方向）放行
                  guardOffShelfNoIncrease(mat, snap.delta);
                  return dbh.changeBalance(t, storeId, itemId, snap.delta, snap.delta >= 0 ? 'in' : 'out')
                    .then(function (r) { snap.after = r.after; });
                },
                function () {
                  var diffType = snap.delta === 0 ? C.DIFF_TYPE.NONE
                    : (snap.delta < 0 ? C.DIFF_TYPE.SHORT : C.DIFF_TYPE.OVER);
                  // 字段结构镜像 stocktake.create（注意：data 里**绝不能带 _id**）
                  var doc = {
                    storeId: storeId, itemId: itemId,
                    actualQty: targetQty, theoryQty: snap.before,
                    diff: snap.delta, diffType: diffType,
                    source: 'calibrate',
                    operatorId: ctx.user._id, operatorName: ctx.user.name || '',
                    bizDate: dbh.bizDate(), createdAt: dbh.nowIso()
                  };
                  return t.collection('stocktake').doc(stkId).set({ data: doc });
                }
              ]);
            });
          }) : Promise.resolve(null);

          return step1.then(function () {
            /* ---- ② 阈值：只改 store 文档（普通 update，不走事务、不碰余额） ---- */
            if (!hasTh) { return storeDoc; }
            var curMap = (storeDoc && storeDoc.itemThresholds && typeof storeDoc.itemThresholds === 'object')
              ? Object.assign({}, storeDoc.itemThresholds) : {};
            if (thClear) { delete curMap[itemId]; } else { curMap[itemId] = thVal; }
            var next = Object.assign({}, storeDoc, { itemThresholds: curMap });
            return db.collection('store').doc(storeId).update({ data: { itemThresholds: curMap } })
              .then(function () { return next; });
          }).then(function (nextStore) {
            /* ---- ③ op_log 留痕 + 返回 ---- */
            var unit = mat && mat.unit ? mat.unit : '';
            var matName = (mat && mat.name) ? mat.name : '该食材';
            var bParts = [], aParts = [];
            if (hasQty) {
              bParts.push('数量 ' + snap.before + ' ' + unit);
              aParts.push('数量 ' + snap.after + ' ' + unit + '（校准为 ' + targetQty + '）');
            }
            if (hasTh) {
              var oldTh = rowThresholdOf(storeDoc, itemId);
              var newTh = rowThresholdOf(nextStore, itemId);
              bParts.push('阈值 ' + oldTh);
              aParts.push('阈值 ' + newTh + (thClear ? '（已清除该食材单独阈值）' : '（该食材单独阈值）'));
            }
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.INVENTORY_CALIBRATE,
              storeName + ' / ' + matName, bParts.join('；'), aParts.join('；'))
              .then(function () {
                var finalQty = hasQty ? snap.after : 0;
                if (!hasQty) {
                  // 阈值-only：没走事务，单独读一次当前数量回填给前端
                  return dbh.readBalance(db.collection('stock_balance'), storeId, itemId)
                    .then(function (bal) { return dbh.quantizeStock(Number(bal.qty) || 0); });
                }
                return finalQty;
              }).then(function (q) {
                return {
                  storeId: storeId, itemId: itemId,
                  qty: q,
                  threshold: isWh ? null : rowThresholdOf(nextStore, itemId)
                };
              });
          });
        });
    });
  }

  /* ---------------- calibrateList：校准记录列表（两角色 · shop 强制本店） ----------------
   * 入参 { storeId?, offset?, limit? }
   *   · shop 忽略 storeId，强制 ctx.user.storeId
   *   · manager 必须传 storeId（不传 → 2002）
   *   · limit 缺省 20，物理上限 200；多读 1 条探针 → hasMore
   * 出参 { list:[{itemId,itemName,qty,delta,diffType,operatorName,createdAt}], hasMore }
   * ⚠️ 分页必须**双排序键**（createdAt desc + _id desc）：同秒记录单键排序会跳条/重条。
   */
  if (event.action === 'calibrateList') {
    return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function (ctx) {
      var storeId;
      if (ctx.user.role === C.ROLE.SHOP) {
        storeId = ctx.user.storeId;                    // shop 强制本店（显式传别店无效）
      } else {
        storeId = String(event.storeId || '');
        if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '请先选择门店'); }
      }
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }

      var offset = Number(event.offset);
      offset = (isFinite(offset) && offset > 0) ? Math.floor(offset) : 0;
      var limit = Number(event.limit);
      limit = (isFinite(limit) && limit > 0) ? Math.floor(limit) : 20;
      limit = Math.min(limit, 200);                    // 物理上限

      return db.collection('stocktake')
        .where({ storeId: storeId, source: 'calibrate' })
        .orderBy('createdAt', 'desc').orderBy('_id', 'desc')
        .skip(offset).limit(limit + 1)                 // 多读 1 条当探针
        .get()
        .then(function (res) {
          var rows = res.data || [];
          var hasMore = rows.length > limit;
          var page = hasMore ? rows.slice(0, limit) : rows;
          return loadNameMap(db.collection('material'), page.map(function (r) { return r.itemId; }))
            .then(function (nameMap) {
              return {
                list: page.map(function (r) {
                  return {
                    itemId: r.itemId,
                    itemName: nameMap[r.itemId] || '该食材',   // 档案缺失也给占位，不外泄 _id
                    qty: dbh.quantizeStock(Number(r.actualQty) || 0),
                    delta: dbh.quantizeStock(Number(r.diff) || 0),   // 有符号：正补 / 负扣
                    diffType: r.diffType || C.DIFF_TYPE.NONE,
                    operatorName: r.operatorName || '',
                    createdAt: r.createdAt || ''
                  };
                }),
                hasMore: hasMore
              };
            });
        });
    });
  }

  return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function (ctx) {
    var storeId;
    if (ctx.user.role === C.ROLE.SHOP) {
      storeId = ctx.user.storeId;                      // shop 仅本店
    } else {
      storeId = String(event.storeId || C.STORE_WAREHOUSE);
    }
    /* ⚠️ 阈值口径**按语境切换**（2026-10-09 老板拍板「门店要有自己的阈值」）：
     *   · 总仓（storeId === C.STORE_WAREHOUSE）→ 用 **material.lowStockThreshold**（食材档案的备货警戒线）
     *     —— 总仓预警页 pages/manager/wh-stock-alert 依赖它，**这个分支绝不能动**。
     *   · 门店（storeId 是真门店）→ 用**该门店自己的 store.lowStockThreshold**（每店一个统一值），
     *     读不到 / 没设 → 回落默认 2（dbh.storeThresholdOf 保证返回 >0 数字）。
     *     门店**绝不**继承总仓阈值：总仓备货线可能 10 包，门店日常只有 2~3 包 → 常年误报、预警失效。
     * store 文档是一路普通查询（不在事务内），只有一次读，与 material 并发即可。
     */
    var isWarehouse = (storeId === C.STORE_WAREHOUSE);
    return Promise.all([
      /* ⚠️ 这里原先是 limit(100) 且无 orderBy（2026-10-09 修静默截断）：
       *   食材破 100 条后，第 101 条起被云开发直接截掉 —— 库存页会**凭空少一行**，
       *   且没有任何报错（老板看不到自己刚建的食材，更看不到它的库存）。
       *   orderBy('createdAt','desc')：新建的排最前，新建即在列表顶部可见。
       *   ⚠️ 本 action 的 rows 是**库存行**（不是食材行，还经过下架+0 隐藏等过滤），
       *      所以**不能**在这里套 truncated = total > rows.length —— 那是假截断信号；
       *      改为命中上限时打一条云开发日志，让「可能被截断」不再无声无息。 */
      db.collection('material').orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(MAX_LIST).get(),
      isWarehouse ? Promise.resolve(null)
        : db.collection('store').doc(storeId).get().catch(function () { return { data: null }; })
    ]).then(function (rs) {
      var mres = rs[0];
      var storeDoc = isWarehouse ? null : (rs[1] && rs[1].data);
      var storeThreshold = isWarehouse ? null : dbh.storeThresholdOf(storeDoc);
      // ⚠️ 2026-10-09 老板拍板「食材下架」口径：这里**不再**一刀切过滤 isActive === false。
      //    下架 ≠ 删除 —— 还有货的下架食材**必须照常显示**（不然账面库存对不上，老板明明有货却看不见），
      //    只有「**已下架 且 库存为 0**」的行才隐藏。
      //    判 0 必须等余额读出来之后做（见下方 reads 内），这里拿不到 qty。
      var mats = mres.data || [];
      if (mats.length >= MAX_LIST) {
        console.error('[TRUNCATED] inventory.list 食材数已达上限 ' + MAX_LIST
          + ' 条，可能还有更多（真被截断：请加分页，不要静默丢行）');
      }
      if (event.keyword) {
        var kw = String(event.keyword);
        mats = mats.filter(function (m) { return m.name.indexOf(kw) >= 0; });
      }
      if (event.itemId) {
        mats = mats.filter(function (m) { return m._id === String(event.itemId); });
      }
      var reads = mats.map(function (m) {
        return dbh.readBalance(db.collection('stock_balance'), storeId, m._id).then(function (bal) {
          /* ⚠️ 下架食材隐藏判定（2026-10-09 老板拍板），门槛是**两个条件同时成立**：
           *   ① 食材已下架（m.isActive === false）
           *   ② 该行库存为 0
           * 只满足其一都要显示：
           *   · 在售（isActive !== false）+ 库存 0 → **照常显示**（在售的不能藏，否则新建的食材一进货就看不见）
           *   · 已下架 + 有货（qty ≠ 0，**含负数**）→ **照常显示**（负库存也是账，藏了账面就对不上）
           * 判 0 用 **snapStock**（与余额写入同口径）：它已把 |qty| ≤ 0.02 的残渣归零，
           *   所以 qty === 0 就是真的没货；反过来 0.995 这类真实中间态不会被吸附成 1。
           * 🚫 别改成 `qty <= 0` —— 那会把负库存一起藏掉（负库存是异常账，必须让老板看见）。
           * 返回 null = 这一行不出行，调用方统一 filter(Boolean)。
           */
          var snapQty = dbh.snapStock(Number(bal.qty) || 0);
          if (m.isActive === false && snapQty === 0) { return null; }

          // 返回的字段名**仍叫 lowStockThreshold**（前端 notice-bar / store-stock 靠它显示，别改），
          // 只是门店语境下语义变成「本店阈值」。
          var th;
          if (isWarehouse) {
            // ⚠️ 总仓行**完全不变**：仍是 material 档案阈值，原三元表达式一字未动
            //   （总仓预警页 wh-stock-alert 依赖它）。
            th = (m.lowStockThreshold !== null && m.lowStockThreshold !== undefined && Number(m.lowStockThreshold) > 0)
              ? Number(m.lowStockThreshold) : null;
          } else {
            // 行级优先级：该食材单独阈值 itemThresholds[itemId] → 本店统一阈值 → 默认 2
            th = rowThresholdOf(storeDoc, m._id);
          }
          return {
            itemId: m._id, name: m.name, unit: m.unit,
            // 精度口径 = 3 位（与全系统库存精度一致，quantizeStock）。
            // ⚠️ 绝不可退回 2 位截断：list 是商品页「编辑」数量框的回填源（goods.js editMaterial
            // 取 m.stock 填 mQty/mQtyOrigin）—— 2 位会把真实 0.333 显示成 0.33，
            // 老板不动直接保存就会把总仓**悄悄缩成 0.33**（每次静默缩水）。
            qty: dbh.quantizeStock(Number(bal.qty) || 0),
            lowStockThreshold: th,
            updatedAt: bal.updatedAt || null
          };
        });
      });
      return Promise.all(reads).then(function (all) {
        // 过滤掉被下架隐藏的行（上面返回 null 的那些）
        var rows = all.filter(function (r) { return !!r; });
        /* ⚠️ 顶层额外返回 storeThreshold（2026-10-09 修 A）：
         *   管理端门店详情页要回填「本店预警阈值」输入框。原先它只能从 rows[0] 上取，
         *   而 rows 是按「活跃食材档案」逐条出行的 —— 该店库存 0 行（新店 / 档案为空 /
         *   云调用失败）时就取不到，界面会显示「未设（默认 2）」，而实际生效的可能是 5，
         *   管理员要么不去设（以为已是 2），要么随手一填把 5 覆盖掉。
         *   这里把已经算好的值直接给出去，**不增加任何云调用**。
         *   · 门店语境 → 该店生效阈值（已归一，没设就是默认 2）
         *   · 总仓语境 → null（总仓没有「门店阈值」这个概念，预警走 rows[].lowStockThreshold）
         *   ⚠️ 命名刻意用 storeThreshold，不叫 lowStockThreshold，避免和 rows 里每行的那个混淆。
         */
        return { storeId: storeId, rows: rows, storeThreshold: storeThreshold };
      });
    });
  });
});
