// ==========================================================================
// cloudfunctions/production — 出品扣减（ARCH v1.5 §4.5；事务 ✅）
// create：扣减量 = 份数 × 每份用量（同单位；换算仍写在菜品里；PRD §6.2 / §6.9）
//   每份用量 = ci.qty / ci.portions（ci.portions = 该行 qty 能做几份，缺省 1）
//   （老板 2026-09-19 拍板：换算口径不上移档案，故不使用 material.portionsPerUnit）
//   精度：扣减量按 0.001 量化（dbh.quantizeStock），余额写入时统一吸附（dbh.snapStock）
//   任一食材不足 → 整体回滚（不半扣）
// reverse：仅当日营业日内的 confirmed 可撤回（跨日 1002）；回补库存
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

function num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 食材展示名（档案缺失给占位；绝不把内部 _id 抛给用户） */
function matNameOf(map, id) {
  var m = map && map[String(id)];
  return (m && m.name) ? m.name : '该食材';
}

/** 「数量 单位」（单位缺失则只给数量），用于库存不足提示 */
function qtyUnitOf(map, id, n) {
  var m = map && map[String(id)];
  return n + (m && m.unit ? ' ' + m.unit : '');
}

/**
 * 每份用量（库存单位）。
 * 注意：这里**不做舍入**（原 round4 已删）——双重舍入正是「1 包做 3 份分次出品
 * 每次扣 0.33、永远剩 0.01」的根因之一；精度统一交给 quantizeStock / snapStock。
 * 换算仍写在菜品里：ci.portions = 该行 qty 能做几份 → 每份用量 = ci.qty / ci.portions；
 * ci.portions 缺省/非法 → ci.qty 即每份用量。
 * @param {object} ci 菜品消耗项 { itemId, qty, unit, portions }
 */
function perPortion(ci) {
  var q = num(ci.qty);
  if (ci.portions && Number(ci.portions) > 0) { return q / Number(ci.portions); }
  return q;
}

/* ==========================================================================
 * list / summary 公共：区间条件 · 分页读取 · 名称批量回查（2026-09-19）
 *   · 老板拍板「数据按时间取，时间范围内**全量**导出」→ 不设业务条数上限；
 *     下列常量只是防单次拉爆 / 聚合节流的**物理**保护值，不是业务上限。
 * ========================================================================== */
var LIST_PAGE_MAX = 1000;   // list 单页物理上限（非业务上限）
var SUMMARY_PAGE = 100;     // summary 每页读取条数
var SUMMARY_CAP = 5000;     // summary 聚合读取上限（超出 → truncated=true）
var IN_CHUNK = 50;          // in 查询分批大小
var DELETED_NAME = '（已删除）';

/**
 * bizDate 区间条件：gte(from).and(lte(to))；单边可空；两边都空 → null（不加条件）。
 * @param {string} from YYYY-MM-DD（可空）
 * @param {string} to   YYYY-MM-DD（可空）
 */
function bizDateCond(from, to) {
  var f = from ? String(from) : '';
  var t = to ? String(to) : '';
  if (f && t) { return db.command.gte(f).and(db.command.lte(t)); }
  if (f) { return db.command.gte(f); }
  if (t) { return db.command.lte(t); }
  return null;
}

/**
 * 分页读取一批记录（已按 orders 排序）。
 * 统一走 skip+limit：真实云开发与本地桩件（tests/smoke/mock-sdk.js，已实现 skip）
 * 语义一致 → 本地测的就是线上跑的，不存在"只在测试里生效"的分支。
 * @param {string} collName
 * @param {object} where
 * @param {Array<Array<string>>} orders [['createdAt','desc'],['_id','desc']]
 * @param {number} offset
 * @param {number} take   本次最多取多少条
 * @returns {Promise<Array>}
 */
function readPage(collName, where, orders, offset, take) {
  var q = db.collection(collName);
  if (where && Object.keys(where).length) { q = q.where(where); }
  (orders || []).forEach(function (o) { q = q.orderBy(o[0], o[1]); });
  return q.skip(offset).limit(take).get().then(function (res) {
    return (res && res.data) || [];
  });
}

/**
 * 循环分页读到 cap（多读 1 条以判定 truncated）。cap 是节流上限而非业务上限。
 * @returns {Promise<{rows:Array, truncated:boolean}>}
 */
function readAllPaged(collName, where, orders, cap, pageSize) {
  var rows = [];
  var LIMIT = cap + 1;
  function step(offset) {
    if (rows.length >= LIMIT) { return Promise.resolve(); }
    var take = Math.min(pageSize, LIMIT - rows.length);
    return readPage(collName, where, orders, offset, take).then(function (batch) {
      rows = rows.concat(batch);
      if (batch.length < take) { return; }        // 真到底
      return step(offset + batch.length);
    });
  }
  return step(0).then(function () {
    var truncated = rows.length > cap;
    return { rows: rows.slice(0, cap), truncated: truncated };
  });
}

/** 分批 in 查询回填 _id → 文档 映射（禁止 N+1） */
function loadNameMap(collName, ids) {
  var map = {};
  if (!ids || ids.length === 0) { return Promise.resolve(map); }
  var chunks = [];
  for (var i = 0; i < ids.length; i += IN_CHUNK) { chunks.push(ids.slice(i, i + IN_CHUNK)); }
  return dbh.serial(chunks.map(function (ch) {
    return function () {
      return db.collection(collName).where({ _id: db.command.in(ch) }).limit(ch.length).get()
        .then(function (res) {
          ((res && res.data) || []).forEach(function (d) { map[String(d._id)] = d; });
          return null;
        });
    };
  })).then(function () { return map; });
}

/** 名称回查（档案已删 → 占位名） */
function nameOf(map, id) {
  var d = map[String(id)];
  return (d && d.name) || DELETED_NAME;
}

/**
 * summary · 按食材维度聚合
 * rows[].{ id, name, unit, qty, count, detail:[{ id, name, qty, portions }] }
 *   · count = 消耗该食材的**菜品数**；detail 按菜品拆分（qty = 该菜品耗量，portions = 该菜品份数）
 *   · 按 qty 降序
 */
function buildMaterialRows(prods, matMap, dishMap) {
  var acc = {};
  var order = [];
  prods.forEach(function (p) {
    var dishId = String(p.dishId || '');
    var dishQty = Number(p.qty) || 0;
    (p.consumeItems || []).forEach(function (ci) {
      var id = String((ci && ci.itemId) || '');
      if (!id) { return; }
      if (!acc[id]) { acc[id] = { qty: 0, dishes: {}, dishOrder: [] }; order.push(id); }
      var a = acc[id];
      a.qty = dbh.quantizeStock(a.qty + (Number(ci.qty) || 0));
      if (!a.dishes[dishId]) { a.dishes[dishId] = { qty: 0, portions: 0 }; a.dishOrder.push(dishId); }
      a.dishes[dishId].qty = dbh.quantizeStock(a.dishes[dishId].qty + (Number(ci.qty) || 0));
      a.dishes[dishId].portions = dbh.quantizeStock(a.dishes[dishId].portions + dishQty);
    });
  });
  return order.map(function (id) {
    var a = acc[id];
    var m = matMap[id] || {};
    return {
      id: id, name: m.name || DELETED_NAME, unit: m.unit || '',
      qty: dbh.quantizeStock(a.qty), count: a.dishOrder.length,
      detail: a.dishOrder.map(function (dishId) {
        var dd = a.dishes[dishId];
        return {
          id: dishId, name: nameOf(dishMap, dishId),
          qty: dbh.quantizeStock(dd.qty), portions: dbh.quantizeStock(dd.portions)
        };
      })
    };
  }).sort(function (x, y) { return y.qty - x.qty; });
}

/**
 * summary · 按菜品维度聚合
 * rows[].{ id, name, portions, itemCount, detail:[{ id, name, unit, qty }] }
 *   · portions = 出品份数合计；itemCount = 涉及食材种类数；detail 按食材拆分
 *   · 按 portions 降序
 */
function buildDishRows(prods, matMap, dishMap) {
  var acc = {};
  var order = [];
  prods.forEach(function (p) {
    var dishId = String(p.dishId || '');
    if (!dishId) { return; }
    if (!acc[dishId]) { acc[dishId] = { portions: 0, items: {}, itemOrder: [] }; order.push(dishId); }
    var a = acc[dishId];
    a.portions = dbh.quantizeStock(a.portions + (Number(p.qty) || 0));
    (p.consumeItems || []).forEach(function (ci) {
      var id = String((ci && ci.itemId) || '');
      if (!id) { return; }
      if (!a.items[id]) { a.items[id] = 0; a.itemOrder.push(id); }
      a.items[id] = dbh.quantizeStock(a.items[id] + (Number(ci.qty) || 0));
    });
  });
  return order.map(function (id) {
    var a = acc[id];
    var d = dishMap[id] || {};
    return {
      id: id, name: d.name || DELETED_NAME,
      portions: dbh.quantizeStock(a.portions), itemCount: a.itemOrder.length,
      detail: a.itemOrder.map(function (itemId) {
        var m = matMap[itemId] || {};
        return {
          id: itemId, name: m.name || DELETED_NAME, unit: m.unit || '',
          qty: dbh.quantizeStock(a.items[itemId])
        };
      })
    };
  }).sort(function (x, y) { return y.portions - x.portions; });
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'create');

  /* ---------------- create：出品扣减（事务） ---------------- */
  if (action === 'create') {
    return auth.requireUser(db, C.ACTION.PRODUCTION_CREATE, event.storeId || null, event).then(function (ctx) {
      var storeId = String(event.storeId || ctx.user.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      if (ctx.user.role === C.ROLE.SHOP && storeId !== ctx.user.storeId) {
        throw new R.BizError(C.CODE.FORBIDDEN, C.CODE_MSG[1003] + '：非本店');
      }
      var qty = num(event.qty);
      if (!(qty > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '出品份数必须大于 0'); }

      var dish = null;
      // 门店名 / 扣减快照 / 食材档案：必须在 create 分支作用域声明（下方兄弟 .then 都要读，
      // 不能在回调内声明）。
      // 【防坑注释 · 勿删】2026-09-11 修的正是这类「兄弟回调作用域」Bug：变量声明在某个 .then 内、
      // 却在另一个平级 .then 里被读 → ReferenceError → 被外层兜底成 5001「系统内部错误」。
      // 说明：负向对照实验（NC-4a）证明单独把 deduct 留在回调内并不会致命（它只在紧邻的下一个
      // .then 被消费），真正致命的是 storeName —— 它在更后面的兄弟 .then 里被读。
      // 但两者都已统一提升到外层，保持写法一致，避免后人再次踩坑。
      var storeName = '门店';
      var deduct = [];
      var matMap = {};
      return db.collection('dish').doc(String(event.dishId || '')).get().then(function (res) {
        dish = res.data;
        if (!dish || dish.isActive === false) { throw new R.BizError(C.CODE.NOT_FOUND, '菜品未找到或已停用'); }
        var cis = Array.isArray(dish.consumeItems) ? dish.consumeItems : [];
        if (cis.length === 0) { throw new R.BizError(C.CODE.NOT_FOUND, '该菜品未配置消耗清单，请先在商品管理维护'); }
        return db.collection('store').doc(storeId).get();
      }).then(function (sres) {
        if (!sres.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
        storeName = sres.data.name;   // 提升到外层（原 sres 在兄弟 .then 内不可见）
        // 预取食材档案（名称 / 单位）：把「库存不足」讲成人话；档案缺失给占位，绝不外泄 itemId
        var mIds = (dish.consumeItems || []).map(function (ci) { return ci.itemId; });
        return db.collection('material').where({ _id: db.command.in(mIds) }).limit(100).get().then(function (mres) {
          matMap = {};   // 赋值给外层提升的 matMap（勿再 var 声明）
          (mres.data || []).forEach(function (m) { matMap[m._id] = m; });
          return dbh.genId(db, 'prod', sres.data.code || 'SHOP', 'production');
        });
      }).then(function (prodId) {
        // 计算扣减快照：{ itemId, qty }（qty = 份数 × 每份用量，按 0.001 精度量化）
        deduct = (dish.consumeItems || []).map(function (ci) {   // 赋值给外层提升的 deduct
          return {
            itemId: ci.itemId,
            qty: dbh.quantizeStock(qty * perPortion(ci))
          };
        });

        return dbh.withTx(db, function (t) {
          var balColl = t.collection('stock_balance');
          // ① 先校验足量（串行读——事务内不支持并发操作；不足整体回滚）
          return dbh.serial(deduct.map(function (d) {
            return function () {
              return dbh.readBalance(balColl, storeId, d.itemId).then(function (bal) {
                // 余额已按 0.001 量化存储；1e-9 仅防浮点尾差（如 0.6669999999 vs 0.667）
                if (dbh.quantizeStock(bal.qty) < d.qty - 1e-9) {
                  throw new R.BizError(C.CODE.NO_STOCK,
                    '本店「' + matNameOf(matMap, d.itemId) + '」库存不足：需 '
                    + qtyUnitOf(matMap, d.itemId, d.qty) + '，现有 '
                    + qtyUnitOf(matMap, d.itemId, bal.qty));
                }
                return null;
              });
            };
          })).then(function () {
            // ② 扣减 + 写出品单（串行写：微信云事务并发写会报 -501001 TransactionActive）
            var now = dbh.nowIso();
            // 注意：doc(prodId).set() 的 data 不允许带 _id
            var doc = {
              storeId: storeId, dishId: dish._id, qty: qty,
              consumeItems: deduct, status: C.PROD_STATUS.CONFIRMED,
              operatorId: ctx.user._id, bizDate: dbh.bizDate(), createdAt: now
            };
            var writes = deduct.map(function (d) {
              return function () { return dbh.changeBalance(t, storeId, d.itemId, -d.qty, 'out'); };
            });
            writes.push(function () { return t.collection('production').doc(prodId).set({ data: doc }); });
            return dbh.serial(writes).then(function (rs) {
              return {
                doc: doc,
                balances: deduct.map(function (d, i) { return { itemId: d.itemId, after: rs[i].after }; })
              };
            });
          });
        }).then(function (out) {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.PRODUCTION_CREATE,
            storeName + ' / ' + dish.name + ' ' + qty + ' 份',
            '', '扣减：' + deduct.map(function (d) { return d.itemId + ' −' + d.qty; }).join('，'))
            .then(function () { return { production: Object.assign({ _id: prodId }, out.doc), balances: out.balances }; });
        });
      });
    });
  }

  /* ---------------- reverse：当日撤回（回补库存） ---------------- */
  if (action === 'reverse') {
    return auth.requireUser(db, C.ACTION.PRODUCTION_REVERSE, null, event).then(function (ctx) {
      var prodId = String(event.productionId || '');
      return db.collection('production').doc(prodId).get().then(function (res) {
        var prod = res.data;
        if (!prod) { throw new R.BizError(C.CODE.NOT_FOUND, '出品记录未找到'); }
        if (ctx.user.role === C.ROLE.SHOP && prod.storeId !== ctx.user.storeId) {
          throw new R.BizError(C.CODE.FORBIDDEN, C.CODE_MSG[1003] + '：非本店');
        }
        if (prod.status !== C.PROD_STATUS.CONFIRMED) {
          throw new R.BizError(C.CODE.NEGATIVE, '该记录已撤回，不能重复操作');
        }
        if (prod.bizDate !== dbh.bizDate()) {
          throw new R.BizError(C.CODE.CROSS_DAY, '跨日禁止撤回（仅当日营业日内的出品可撤回）');
        }
        return dbh.withTx(db, function (t) {
          // 串行写（事务内不支持并发操作）：回补各食材 + 单据置 REVERSED
          var writes = (prod.consumeItems || []).map(function (ci) {
            return function () {
              return dbh.changeBalance(t, prod.storeId, ci.itemId, ci.qty, 'out'); // 冲减当日消耗（回补）
            };
          });
          writes.push(function () {
            return t.collection('production').doc(prod._id).update({
              data: { status: C.PROD_STATUS.REVERSED }
            });
          });
          return dbh.serial(writes);
        }).then(function () {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.PRODUCTION_REVERSE,
            '撤回出品 ' + prod._id, '已扣减',
            '已回补：' + (prod.consumeItems || []).map(function (ci) { return ci.itemId + ' +' + ci.qty; }).join('，'));
        }).then(function () { return { productionId: prod._id, status: C.PROD_STATUS.REVERSED }; });
      });
    });
  }

  /* ---------------- list：出品记录（时间范围内分页；全量导出不设业务上限） ----------------
   * 入参：{ storeId?, from?, to?, offset=0, limit=100(物理上限 1000) }
   *   · 门店端强制本店；管理端 storeId 空 = 全部门店
   *   · from/to → bizDate ∈ [from, to]（单边可空）；无区间且非 all → 仅当日；all=1 → 不限日期
   * 出参：{ list:[...], hasMore:bool }（hasMore 用 limit+1 探针；**无** truncated）
   * 排序：createdAt desc + _id desc（次级键，保证同 createdAt 分页不跳不漏） */
  if (action === 'list') {
    return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function (ctx) {
      var storeId = ctx.user.role === C.ROLE.SHOP ? String(ctx.user.storeId || '') : String(event.storeId || '');
      var offset = Math.max(0, Math.floor(Number(event.offset) || 0));
      var limit = Math.min(Math.max(Math.floor(Number(event.limit) || 100), 1), LIST_PAGE_MAX);

      var where = {};
      if (storeId) { where.storeId = storeId; }
      var cond = bizDateCond(event.from, event.to);
      if (cond) { where.bizDate = cond; }
      else if (!event.all) { where.bizDate = event.bizDate || dbh.bizDate(); }

      return readPage('production', where, [['createdAt', 'desc'], ['_id', 'desc']], offset, limit + 1)
        .then(function (rows) {
          return { list: rows.slice(0, limit), hasMore: rows.length > limit };
        });
    });
  }

  /* ---------------- summary：消耗汇总（只读；material / dish 两维度） ----------------
   * 入参：{ from?, to?, groupBy='material'|'dish', storeId?（管理端；空=全部门店） }
   *   · 门店端强制本店；仅统计 status='confirmed'（已撤回不计入消耗）
   * 出参：{ from, to, groupBy, storeId, rows:[...], truncated:bool }（cap 5000，超 → truncated）
   * 聚合：qty 统一走 dbh.quantizeStock（3 位小数）；名称分批 in 回查，杜绝 N+1；只读不写 op_log */
  if (action === 'summary') {
    return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function (ctx) {
      var groupBy = event.groupBy === 'dish' ? 'dish' : 'material';
      var from = event.from ? String(event.from) : '';
      var to = event.to ? String(event.to) : '';
      var storeId = ctx.user.role === C.ROLE.SHOP ? String(ctx.user.storeId || '') : String(event.storeId || '');

      var where = { status: C.PROD_STATUS.CONFIRMED };
      if (storeId) { where.storeId = storeId; }
      var cond = bizDateCond(from, to);
      if (cond) { where.bizDate = cond; }

      return readAllPaged('production', where, [['createdAt', 'desc'], ['_id', 'desc']], SUMMARY_CAP, SUMMARY_PAGE)
        .then(function (loaded) {
          var prods = loaded.rows;
          var itemIds = [];
          var dishIds = [];
          prods.forEach(function (p) {
            var did = String(p.dishId || '');
            if (did && dishIds.indexOf(did) < 0) { dishIds.push(did); }
            (p.consumeItems || []).forEach(function (ci) {
              var id = String((ci && ci.itemId) || '');
              if (id && itemIds.indexOf(id) < 0) { itemIds.push(id); }
            });
          });
          return Promise.all([loadNameMap('material', itemIds), loadNameMap('dish', dishIds)])
            .then(function (maps) {
              var rows = groupBy === 'dish'
                ? buildDishRows(prods, maps[0], maps[1])
                : buildMaterialRows(prods, maps[0], maps[1]);
              return {
                from: from, to: to, groupBy: groupBy, storeId: storeId,
                rows: rows, truncated: loaded.truncated
              };
            });
        });
    });
  }

  // 原始 action 只写日志，不外泄给用户
  console.error('[UNKNOWN_ACTION]', 'production', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});

function sresStoreName(sres) {
  return sres && sres.data ? (sres.data.name || sres.data._id) : '门店';
}
