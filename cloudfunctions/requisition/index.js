// ==========================================================================
// cloudfunctions/requisition — 食材申请（ARCH v1.5 §4.5 签名表 · §4.2 状态机）
// create ✅ / confirm ✅（一步到位：总仓 −qty / 门店 +qty 同事务）
// adjust ✅（管理端改数量 / 删行，库存不变，状态仍 pending）/ reject ✅ / cancel ✅
// remove ✅（管理端删除终态申请单：rejected / cancelled 可删，pending/confirmed 拒）
// list ❌ / get ❌
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 精度口径 = 3 位（与 changeBalance / snapStock / quantizeStock 同口径）。
 *  ⚠️ 绝不可退回 2 位截断：申请单明细数量被截 2 位，确认时总仓扣减与门店回补都会带上这个误差。 */
function num(v) {
  return dbh.quantizeStock(v);
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

/** 单张申请单可确认的明细条数上限（见 confirm 分支「兜底上限」注释） */
var MAX_CONFIRM_ITEMS = 80;

/** 事务外单次 where 的 _id 批量上限（微信云开发单次 get 上限 100） */
var BAL_CHUNK = 100;

/**
 * 事务外批量预读 stock_balance：按 _id 分批（每批 ≤ BAL_CHUNK），批间 Promise.all 并发。
 * @param {Db} coll  db.collection('stock_balance')（**必须**是事务外的 db，不是 t.collection）
 * @param {Array<{id:string, storeId:string, itemId:string}>} keys 余额主键（id 由 dbh.balId 生成）
 * @returns {Promise<Object>} _id → 余额文档。**查不到的 _id 会补零值文档**（dbh.zeroBal），
 *          即返回的 map 一定覆盖全部 keys —— 见下方「补零值」注释，别改成留空。
 */
function prefetchBalances(coll, keys) {
  var uniq = [];
  var meta = {};   // _id → {storeId, itemId}（补零值时要用）
  keys.forEach(function (k) {
    if (uniq.indexOf(k.id) < 0) { uniq.push(k.id); meta[k.id] = k; }
  });
  var chunks = [];
  for (var i = 0; i < uniq.length; i += BAL_CHUNK) { chunks.push(uniq.slice(i, i + BAL_CHUNK)); }
  if (chunks.length === 0) { return Promise.resolve({}); }
  // ⚠️ 事务外才允许并发 + where；事务内并发操作文档会报 -501001 TransactionActive。
  return Promise.all(chunks.map(function (chunk) {
    return coll.where({ _id: db.command.in(chunk) }).limit(BAL_CHUNK).get();
  })).then(function (ress) {
    var map = {};
    ress.forEach(function (res) {
      (res.data || []).forEach(function (d) { map[d._id] = d; });
    });
    // ⚠️ 补零值（2026-10-09 必做）：发出去但没查回来的 _id = 库里没有这一行，
    //    「门店在某食材上从未收货 / 从未盘点」是**常态**，不是边缘场景。
    //    不补的话调用方 `balMap[id] || null` 会让 changeBalanceWith 退回**事务内 get**
    //    → 再撞一次 missing-doc → 零值新建。QA 实测 N=56：事务内 113 → 169（多出 56 次 get）。
    //    补零值后事务内 get **恒为 0**，操作数恒定 2N+1，与「2N 行全存在」同水位。
    uniq.forEach(function (id) {
      if (!map[id]) {
        var m = meta[id];
        map[id] = dbh.zeroBal(id, m.storeId, m.itemId);
      }
    });
    return map;
  });
}

/** 单次 where 的 _id 批量上限（微信云开发单次 get 上限 100，这里按 50 分批留余量） */
var NAME_CHUNK = 50;

/**
 * 批量取食材档案（只为了把摘要讲成人话；档案缺失给占位，绝不外泄 itemId）
 * @param {Array<string>} ids 食材 _id
 * @returns {Promise<Object>} _id → material 文档
 */
function loadMatNames(ids) {
  var map = {};
  var uniq = [];
  ids.forEach(function (id) { if (id && uniq.indexOf(id) < 0) { uniq.push(id); } });
  var chunks = [];
  for (var i = 0; i < uniq.length; i += NAME_CHUNK) { chunks.push(uniq.slice(i, i + NAME_CHUNK)); }
  if (chunks.length === 0) { return Promise.resolve(map); }
  // 事务外，允许 where + 并发
  return Promise.all(chunks.map(function (chunk) {
    return db.collection('material').where({ _id: db.command.in(chunk) }).limit(NAME_CHUNK).get();
  })).then(function (ress) {
    ress.forEach(function (res) {
      (res.data || []).forEach(function (m) { map[m._id] = m; });
    });
    return map;
  });
}

/**
 * 生成「改了什么」的人话摘要（写进 adjustNote 与 op_log）
 * 形如：「牛肉片 5→3；土豆 2→0（已删除）」
 *
 * 规则（按**原明细**顺序遍历，保证摘要顺序与门店看到的单据一致）：
 *   · 新明细里没出现的 itemId      → 视为删行 → 「名 改前→0（已删除）」
 *   · 新明细里数量改小 / 改大      → 「名 改前→改后」
 *   · 新明细里数量 = 0            → 等价删行，显示成 0 并标「（已删除）」
 *   · 数量没变的行                 → 不出现在摘要里（减少噪音）
 * 🚫 摘要里只出现食材名，**绝不出现 itemId**（老板看 op_log 只认名字）
 *
 * @param {Array<string>} orderIds  原明细 itemId（按出现顺序去重）
 * @param {Object} oldQtyOf         itemId → 改前数量（同一 itemId 多行已聚合）
 * @param {Object} newQtyOf         itemId → 改后数量（只含新明细里出现的）
 * @param {Object} matMap           itemId → material 文档
 * @returns {string} 摘要；无变化时返回「明细无变化」
 */
function buildAdjustNote(orderIds, oldQtyOf, newQtyOf, matMap) {
  var parts = [];
  orderIds.forEach(function (id) {
    var oq = dbh.quantizeStock(oldQtyOf[id] || 0);
    var got = Object.prototype.hasOwnProperty.call(newQtyOf, id) ? dbh.quantizeStock(newQtyOf[id]) : 0;
    // ⚠️ 删行有两种写法，摘要里统一成「→0（已删除）」：不传该行 / 填 0。
    //    若这里直接用原始值，填 0 之外的小数值会漏标「（已删除）」。
    //    `> 0 ?` 同时是兜底：负数已在 adjust 校验层被拦，万一将来有人放宽校验，
    //    摘要也不会写出「土豆 2→-1」这种老板看不懂的东西。
    var nq = got > 0 ? got : 0;
    if (oq === nq) { return; }
    var nm = matNameOf(matMap, id);
    parts.push(nm + ' ' + oq + '→' + nq + (nq === 0 ? '（已删除）' : ''));
  });
  return parts.length ? parts.join('；') : '明细无变化';
}

function mustPending(req, verb) {
  if (!req) { throw new R.BizError(C.CODE.NOT_FOUND, '申请单未找到'); }
  if (req.status !== C.REQ_STATUS.PENDING) {
    throw new R.BizError(C.CODE.NEGATIVE,
      '该申请单已处理（' + (C.REQ_STATUS_LABEL[req.status] || req.status) + '），不能' + verb);
  }
  return req;
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'list');

  /* ---------------- create：门店端发起（库存不变） ---------------- */
  if (action === 'create') {
    return auth.requireUser(db, C.ACTION.REQUISITION_CREATE, event.storeId || null, event).then(function (ctx) {
      var storeId = String(event.storeId || ctx.user.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      if (storeId !== ctx.user.storeId) { throw new R.BizError(C.CODE.FORBIDDEN, C.CODE_MSG[1003] + '：非本店'); }

      var items = Array.isArray(event.items) ? event.items : [];
      if (items.length === 0) { throw new R.BizError(C.CODE.NEGATIVE, '请至少添加一条食材明细'); }
      var ids = [];
      // 食材缓存：在 create 分支作用域声明（下方两个 .then 兄弟回调都要读，不能在回调内声明）
      var found = {};
      var norm = items.map(function (it) {
        it = it || {};
        var id = String(it.itemId || '');
        if (!id || ids.indexOf(id) >= 0) { throw new R.BizError(C.CODE.NEGATIVE, '食材明细重复或为空'); }
        ids.push(id);
        var qty = num(it.qty);
        if (!(qty > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '申请数量必须大于 0'); }
        return { itemId: id, qty: qty };
      });

      return db.collection('store').doc(storeId).get().then(function (sres) {
        if (!sres.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
        return db.collection('material').where({ _id: db.command.in(ids) }).limit(100).get().then(function (mres) {
          found = {};   // 赋值给外层提升的 found（勿再 var 声明，否则兄弟 .then 读不到）
          (mres.data || []).forEach(function (m) { found[m._id] = m; });
          norm.forEach(function (it) {
            var m = found[it.itemId];
            if (!m) { throw new R.BizError(C.CODE.NOT_FOUND, '部分食材不存在，请刷新后重试'); }
            /* 🚫 已下架食材不能申请（2026-10-09 补服务端兜底）：
             *    老板口径「下架食材不能申请」此前**只靠前端下拉过滤**
             *    （pages/shop/requisition/requisition.js:51 的 matRows.filter(isActive !== false)），
             *    而云函数是**公开入口** —— 绕过小程序直调就能把下架食材塞进申请单，
             *    前端过滤只是省事，不是防线。这条必须在服务端成立。
             *    档案已在事务外取到（`found` 里就是完整文档，含 isActive）→ **不新增任何查询、
             *    不进事务**，事务内操作数维持 1 次 set 不变（30 秒事务生命周期红线）。
             *    码与文案口径对齐 purchase（2002 / 「食材「XX」…」），只用食材名，绝不露 _id。
             */
            if (m.isActive === false) {
              throw new R.BizError(C.CODE.NEGATIVE,
                '食材「' + (m.name || '该食材') + '」已下架，不能申请');
            }
          });
          return dbh.genId(db, 'req', sres.data.code || 'SHOP', 'requisition');
        }).then(function (reqId) {
          // 注意：doc(reqId).set() 的 data 不允许带 _id
          var doc = {
            storeId: storeId, applicantId: ctx.user._id,
            items: norm, status: C.REQ_STATUS.PENDING,
            createdAt: dbh.nowIso(), bizDate: dbh.bizDate(),
            handledBy: '', handledAt: '', rejectReason: ''
          };
          return dbh.withTx(db, function (t) {
            return t.collection('requisition').doc(reqId).set({ data: doc });
          }).then(function () {
            var summary = norm.map(function (it) { return (found[it.itemId] ? found[it.itemId].name : it.itemId) + ' ' + it.qty; }).join('；');
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_CREATE,
              sres.data.name + ' / 食材申请：' + summary, '', '申请单 ' + reqId + '（pending，库存不变）');
          }).then(function () { return { requisition: Object.assign({ _id: reqId }, doc) }; });
        });
      });
    });
  }

  /* ---------------- confirm：管理端一步到位（D9 · 同一事务结清库存） ---------------- */
  if (action === 'confirm') {
    return auth.requireUser(db, C.ACTION.REQUISITION_CONFIRM, null, event).then(function (ctx) {
      var reqId = String(event.requisitionId || '');
      // 食材档案（名称 / 单位）：confirm 分支内多处读取（库存不足时给食材名），提升到本分支作用域
      var matMap = {};
      // 门店展示名（op_log 讲人话用）：查不到就回落 storeId，绝不把裸 id 当常态
      var storeName = '';
      return db.collection('requisition').doc(reqId).get().then(function (res) {
        var req = mustPending(res.data, '确认');
        // 预取食材档案：把「库存不足」讲成人话；档案缺失给占位，绝不外泄 itemId
        var mIds = req.items.map(function (it) { return it.itemId; });
        /* 门店名与食材档案**并发**预取（2026-10-09）：
         *   op_log 的 target 原来是「确认 S1 食材申请：m1 3；m2 5」—— 一串裸 id，老板看不懂。
         *   ⚠️ 这两次读都在**事务外**（事务还没开），而且是 Promise.all 并发，
         *      所以**事务内操作数一个都没增加**（仍是 2N+1），不碰 30 秒事务生命周期红线。
         */
        return Promise.all([
          db.collection('material').where({ _id: db.command.in(mIds) }).limit(100).get(),
          db.collection('store').doc(req.storeId).get().catch(function () { return { data: null }; })
        ]).then(function (rs) {
          (rs[0].data || []).forEach(function (m) { matMap[m._id] = m; });
          // 查不到门店文档 → **绝不回落成裸 storeId**（老板看不懂），给中文占位「该门店」，
          // 与食材名缺失时 matNameOf 兜「该食材」同一口径。
          storeName = (rs[1] && rs[1].data && rs[1].data.name) ? rs[1].data.name : '该门店';
          return req;
        });
      }).then(function (req) {
        // 余额结果：提升作用域（下方兄弟 .then 返回时也要读，不能在回调内声明）
        var balances = [];
        var items = Array.isArray(req.items) ? req.items : [];

        /* ───────────────────────── 事务外阶段 ─────────────────────────
         * ⚠️ 微信云开发事务有 **30 秒生命周期硬限制**（startTransaction() → commit()），
         *    这是平台限制，不是云函数超时，改超时配置无效。
         *    原写法把「N 次 readBalance（每次 1 次事务内 get）」也放在事务里，
         *    事务内往返 = N(读) + 2N×2(changeBalance 内 1 get + 1 set) + 1(单据 update)
         *              = 5N + 1  → N=56 时 281 次 → 撑破 30 秒 →
         *                -501001 ResourceUnavailable.TransactionNotExist（「系统繁忙，请稍后重试」）。
         *    故把「读」整体提到事务外：事务外允许 where + 并发批量拉，事务内只剩 set，
         *    往返降到 2N + 1（N=56 → 113），砍掉 60%。
         * ──────────────────────────────────────────────────────────── */

        // 兜底上限：再大的单也别去撞 30 秒。与其让用户看到毫无意义的「系统繁忙」，
        // 不如直接给人话让他拆单（80 条 → 事务内 161 次往返，实测水位内）。
        if (items.length > MAX_CONFIRM_ITEMS) {
          throw new R.BizError(C.CODE.NO_STOCK,
            '该申请单明细过多（' + items.length + ' 条），请拆分成多张单后再确认');
        }

        // ① 构造余额主键集合：每条明细对应两个（总仓、门店）
        var balKeys = [];
        items.forEach(function (it) {
          balKeys.push({ id: dbh.balId(C.STORE_WAREHOUSE, it.itemId), storeId: C.STORE_WAREHOUSE, itemId: it.itemId });
          balKeys.push({ id: dbh.balId(req.storeId, it.itemId), storeId: req.storeId, itemId: it.itemId });
        });

        return prefetchBalances(db.collection('stock_balance'), balKeys).then(function (balMap) {
          // ② 预校验总仓足量（事务外 · 任一不足 → 抛 2001 整体拒绝）。
          //    此刻一行数据都还没写、事务都还没开 → 天然满足「库存不足整体拒绝、不半扣」红线。
          //
          //    ⚠️ 必须**先按 itemId 聚合需求**再比对（2026-10-09 修，QA 证出的真缺陷）：
          //       逐条比对时，总仓账面 5、明细 [3, 3] 会「5 >= 3 成立、5 >= 3 又成立」→ 放行，
          //       而写侧会正确扣掉合计 6 → **余额 −1，无报错、单据 confirmed**（静默数据错误）。
          //       聚合后按「需 6、现有 5」比对 → 正确拦截。
          //       触发面很窄：create 已禁止重复明细，只有**历史脏数据**能命中，
          //       但它是静默错账（比崩掉更难发现），必须堵。
          var need = {};
          items.forEach(function (it) {
            need[it.itemId] = dbh.quantizeStock((need[it.itemId] || 0) + dbh.quantizeStock(it.qty));
          });
          Object.keys(need).forEach(function (iid) {
            var bal = balMap[dbh.balId(C.STORE_WAREHOUSE, iid)] || { qty: 0 };
            // 3 位口径（2026-10-08 修）：原来按 2 位比较会**误拒**合法申请 ——
            // 账面 0.334、申请 0.333 时 0.33 < 0.333 成立 → 报「库存不足」，
            // 而 0.334 ≥ 0.333 本来是够的。比较必须用与余额写入同口径的 3 位值。
            if (dbh.quantizeStock(bal.qty) < need[iid]) {
              throw new R.BizError(C.CODE.NO_STOCK,
                '总仓「' + matNameOf(matMap, iid) + '」库存不足：需 '
                + qtyUnitOf(matMap, iid, need[iid]) + '，现有 '
                + qtyUnitOf(matMap, iid, bal.qty));
            }
          });
          return balMap;
        }).then(function (balMap) {
          return dbh.withTx(db, function (t) {
            // ③ 串行写：总仓 −qty / 门店 +qty（同事务）+ 日结流水 + 单据置终态 confirmed
            //   （微信云事务并发写会报 -501001 TransactionActive，必须链式串行）
            //   余额快照来自事务外预读 → changeBalanceWith 内部**不再 get**，只剩 1 次 set。
            var writes = [];
            // 同一 (仓库,食材) 在本单内出现多次时，第 2 次起**放弃快照、改走事务内 get** ——
            // 否则第 2 次会拿同一份旧快照算出同样的 qtyAfter，把第 1 次的扣减覆盖掉（漏扣）。
            // 事务内 get 读到的是本事务已 staged 的值，与旧 changeBalance 行为逐字一致。
            // （create 已禁止重复明细，这是给历史脏数据兜底，避免静默改行为。）
            //
            // ⚠️ 维护约定 · 这里是重复明细累加的**第一道**保护，第二道在
            //    _shared/db.js 的 changeBalanceWith：`preBal` **刻意不拷贝**，
            //    原地改坏了调用方的 balMap 对象，第 2 次读到的已是第 1 次改后的值。
            //    两道互相独立，坏一道还有一道 → **静默失效**（QA 变异实证：
            //    只删 used 不转红、只加拷贝不转红、两个都做才转红）。
            //    🚫 别在 db.js 那边"顺手"加防御性拷贝。改任一处都要重跑 3 条 × 2 包的累加用例。
            var used = {};
            items.forEach(function (it) {
              var whId = dbh.balId(C.STORE_WAREHOUSE, it.itemId);
              var stId = dbh.balId(req.storeId, it.itemId);
              var whSnap = used[whId] ? null : (balMap[whId] || null);
              var stSnap = used[stId] ? null : (balMap[stId] || null);
              used[whId] = true;
              used[stId] = true;
              writes.push(function () {
                return dbh.changeBalanceWith(t, C.STORE_WAREHOUSE, it.itemId, -it.qty, 'out', whSnap);
              });
              writes.push(function () {
                return dbh.changeBalanceWith(t, req.storeId, it.itemId, it.qty, 'in', stSnap);
              });
            });
            writes.push(function () {
              return t.collection('requisition').doc(req._id).update({
                data: {
                  status: C.REQ_STATUS.CONFIRMED,
                  handledBy: ctx.user._id, handledAt: dbh.nowIso()
                }
              });
            });
            return dbh.serial(writes).then(function (rs) {
              balances = [];   // 赋值给外层提升的 balances（勿再 var 声明）
              for (var i = 0; i < items.length; i++) {
                balances.push({ itemId: items[i].itemId, warehouse: rs[i * 2], store: rs[i * 2 + 1] });
              }
              return balances;
            });
          });
        }).then(function () {
          /* ⚠️ 2026-10-09 改：op_log 讲人话 —— 原来是「确认 S1 食材申请：m1 3；m2 5」，
           *    老板在审计页看到的是一串裸 id。改成食材名 + 门店名，与同业务流的
           *    adjust 那条日志（用食材名）口径一致。
           *    档案缺失时 matNameOf 兜「该食材」占位 —— **绝不回退成 itemId**。
           *    门店名在事务外已并发取好（storeName），这里不新增加查询。
           */
          var summary = items.map(function (it) {
            return matNameOf(matMap, it.itemId) + ' ' + it.qty;
          }).join('；');
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_CONFIRM,
            '确认 ' + (storeName || '该门店') + ' 食材申请：' + summary,
            'pending', 'confirmed；总仓 −[' + summary + ']；门店 +[' + summary + ']');
        }).then(function () {
          return { requisitionId: req._id, status: C.REQ_STATUS.CONFIRMED, balances: balances };
        });
      });
    });
  }

  /* ---------------- adjust：管理端修改明细（改数量 / 删行 · 库存不变 · 状态仍 pending） ---------------- */
  if (action === 'adjust') {
    return auth.requireUser(db, C.ACTION.REQUISITION_ADJUST, null, event).then(function (ctx) {
      var reqId = String(event.requisitionId || '');
      var raw = Array.isArray(event.items) ? event.items : [];

      // ⚠️ 口径（2026-10-09 老板拍板，勿改）：items 是「**改完之后**的完整明细」——
      //    · 出现在 items 里   → 用新 qty
      //    · 没出现在 items 里的原明细行 = 被管理端**删掉了**
      //    · qty === 0 的行 = 删行 → **真删**：不写进单据，门店端不该看到「牛肉片 0 包」这种怪行
      //      （老板前端每行本来就有独立「删除」按钮，填 0 只是同一种表达的另一种写法）
      //    🚫 但 **qty < 0 必须报错拦截**，不能跟着按删行吞掉 —— 负数是异常输入
      //      （前端 bug 或手滑多敲负号），按删行处理 = 静默丢一行、没有任何提示，
      //      与「库存被静默改掉」是同一类事故。0 才是明确的「这行不要了」。
      //    所以「空数组」和「全被删光」都不是「不改」，而是「整单删空」→ 直接拒绝。
      if (raw.length === 0) { throw new R.BizError(C.CODE.NEGATIVE, '至少要留一种食材'); }

      return db.collection('requisition').doc(reqId).get().then(function (res) {
        var req = mustPending(res.data, '修改');

        // ① 原明细 → 改前数量（**按 itemId 聚合**：历史脏数据里同一食材可能占多行）
        var orderIds = [];
        var oldQtyOf = {};
        (Array.isArray(req.items) ? req.items : []).forEach(function (it) {
          var id = String((it && it.itemId) || '');
          if (!id) { return; }
          if (!Object.prototype.hasOwnProperty.call(oldQtyOf, id)) {
            orderIds.push(id);
            oldQtyOf[id] = 0;
          }
          oldQtyOf[id] = dbh.quantizeStock(oldQtyOf[id] + num(it.qty));
        });
        if (orderIds.length === 0) { throw new R.BizError(C.CODE.NEGATIVE, '该申请单没有明细，无法修改'); }

        return loadMatNames(orderIds).then(function (matMap) {
          // ② 校验 + 归一化新明细
          var newQtyOf = {};
          var norm = [];
          raw.forEach(function (it) {
            it = it || {};
            var id = String(it.itemId || '');
            if (!id) { throw new R.BizError(C.CODE.NEGATIVE, '食材明细为空，请刷新后重试'); }
            if (Object.prototype.hasOwnProperty.call(newQtyOf, id)) {
              throw new R.BizError(C.CODE.NEGATIVE, '「' + matNameOf(matMap, id) + '」重复出现，请合并后再提交');
            }
            // 🚫 不允许新增原单没有的 itemId：管理端只能**减**，不能替门店点菜。
            //    真要加东西，让门店撤回重提——否则门店看到的单和自己提的对不上，会扯皮。
            if (!Object.prototype.hasOwnProperty.call(oldQtyOf, id)) {
              throw new R.BizError(C.CODE.NEGATIVE, '不能新增门店未申请的食材');
            }
            // 🚫 负数**必须报错拦截**（2026-10-09 老板二次拍板）：
            //    负数是异常输入（前端 bug / 手滑多敲负号），若跟着 0 一起按删行吞掉，
            //    就等于**静默丢一行、没有任何提示** —— 与「库存被静默改掉」同一类事故。
            //    0 才是明确的「这行不要了」。非数字 / 空串同码同口径，一并在这一条里拦。
            var n = Number(it.qty);
            if (it.qty === null || it.qty === undefined || String(it.qty).trim() === '' || !isFinite(n) || n < 0) {
              throw new R.BizError(C.CODE.NEGATIVE, '「' + matNameOf(matMap, id) + '」的数量填写不正确');
            }
            var qty = num(n);          // 3 位口径，与 confirm 扣减同精度
            // 进 newQtyOf：摘要要靠它判断「这行是 0 还是原样」，0 要标「（已删除）」
            newQtyOf[id] = qty;
            // 真删（2026-10-09 老板拍板）：qty === 0 的行**不写进单据** ——
            // 门店端不该看到「牛肉片 0 包」这种怪行。摘要里仍照原样标「（已删除）」。
            // （负数走不到这里，已在上面被拦。）
            if (qty > 0) { norm.push({ itemId: id, qty: qty }); }
          });

          // 全被删光 = 整单删空 → 与「items 为空数组」同处理（2002 至少要留一种食材）。
          // ⚠️ 必须放在摘要之后、写库之前：此时 note 已算好但一行都没落库，不会留下脏数据。
          if (norm.length === 0) { throw new R.BizError(C.CODE.NEGATIVE, '至少要留一种食材'); }

          // ③ 人话摘要（只有食材名，没有 _id）
          var note = buildAdjustNote(orderIds, oldQtyOf, newQtyOf, matMap);
          var before = orderIds.map(function (id) {
            return matNameOf(matMap, id) + ' ' + oldQtyOf[id];
          }).join('；');
          var after = norm.map(function (it) {
            return matNameOf(matMap, it.itemId) + ' ' + it.qty;
          }).join('；');

          // ④ **只 update 单据 → 不需要事务**（不碰 stock_balance，此刻库存完全不变）
          //    🚫 data 里绝不能带 _id（腾讯云 -502001）
          //    🚫 status 不动：仍是 pending —— 库存要等管理端点「确认」时才按**新明细**结清
          //       （confirm 分支每次都重新 `doc(reqId).get()` 现读单据、再用
          //        `var items = Array.isArray(req.items) ? req.items : []` 取明细，
          //        不存在「原始申请量」副本 → 改完即刻生效。行号会随改动漂移，
          //        按这两处代码特征找，别信注释里的具体行号。）
          return db.collection('requisition').doc(req._id).update({
            data: {
              items: norm,
              adjusted: true,
              adjustedBy: ctx.user._id,
              adjustedAt: dbh.nowIso(),
              adjustNote: note
            }
          }).then(function () {
            return db.collection('store').doc(req.storeId).get()
              .catch(function () { return { data: null }; })
              .then(function (sres) {
                // 查不到门店文档 → 给中文占位「该门店」，**绝不回落成裸 storeId**
                var storeName = (sres.data && sres.data.name) ? sres.data.name : '该门店';
                return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_ADJUST,
                  storeName + ' 要货单', before, after + '（' + note + '）');
              });
          }).then(function () {
            return { requisitionId: req._id, items: norm, adjusted: true, adjustNote: note };
          });
        });
      });
    });
  }

  /* ---------------- reject：管理端驳回（必填原因 · 库存不变） ---------------- */
  if (action === 'reject') {
    return auth.requireUser(db, C.ACTION.REQUISITION_REJECT, null, event).then(function (ctx) {
      var reason = String(event.rejectReason || '').trim();
      if (!reason) { throw new R.BizError(C.CODE.NEGATIVE, '驳回原因不能为空'); }
      var reqId = String(event.requisitionId || '');
      return db.collection('requisition').doc(reqId).get().then(function (res) {
        var req = mustPending(res.data, '驳回');
        return dbh.withTx(db, function (t) {
          return t.collection('requisition').doc(req._id).update({
            data: {
              status: C.REQ_STATUS.REJECTED,
              rejectReason: reason,
              handledBy: ctx.user._id, handledAt: dbh.nowIso()
            }
          });
        }).then(function () {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_REJECT,
            '驳回 ' + req.storeId + ' 食材申请：' + req._id, 'pending', 'rejected（原因：' + reason + '）');
        }).then(function () { return { requisitionId: req._id, status: C.REQ_STATUS.REJECTED }; });
      });
    });
  }

  /* ---------------- cancel：门店撤回（仅本人本店 pending · 库存不变） ---------------- */
  if (action === 'cancel') {
    return auth.requireUser(db, C.ACTION.REQUISITION_CANCEL, null, event).then(function (ctx) {
      var reqId = String(event.requisitionId || '');
      return db.collection('requisition').doc(reqId).get().then(function (res) {
        var req = mustPending(res.data, '撤回');
        if (req.applicantId !== ctx.user._id || req.storeId !== ctx.user.storeId) {
          throw new R.BizError(C.CODE.FORBIDDEN, '只能撤回本店本人发起的申请');
        }
        return dbh.withTx(db, function (t) {
          return t.collection('requisition').doc(req._id).update({
            data: {
              status: C.REQ_STATUS.CANCELLED,
              handledBy: ctx.user._id, handledAt: dbh.nowIso()
            }
          });
        }).then(function () {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_CANCEL,
            '撤回食材申请：' + req._id, 'pending', 'cancelled（库存不变）');
        }).then(function () { return { requisitionId: req._id, status: C.REQ_STATUS.CANCELLED }; });
      });
    });
  }

  /* ---------------- remove：管理端删除申请单（仅终态 rejected / cancelled · 库存不变） ----------------
   * 2026-10-09 老板拍板「管理端申请单凑齐五件套：复制/修改/确认/驳回/删除」—— 本动作是删除。
   * ⚠️ 只许删**终态**单（已驳回 / 已撤回）：
   *    · pending 单 → 拒：要走确认/驳回/修改流程，不许一删了之（2002 人话）；
   *    · confirmed 单 → 拒：动过库存（总仓已扣、门店已加），删记录账就对不上 —— 🚫 绝不能删；
   *    · rejected / cancelled → 删：库存从头到尾没动过（reject/cancel 均不碰 stock_balance），
   *      删掉的只是记录本身。
   * 口径对照：material.remove 也允许物理删除，但那是「无业务引用才放行」；
   *    这里反过来 —— requisition 有 rejectReason / handledBy 等历史痕迹也没关系，
   *    终态单在门店端列表里只是「已驳回/已撤回」的死行，老板要的是清掉不想要的。
   */
  if (action === 'remove') {
    return auth.requireUser(db, C.ACTION.REQUISITION_DELETE, null, event).then(function (ctx) {
      var reqId = String(event.requisitionId || '');
      if (!reqId) { throw new R.BizError(C.CODE.NEGATIVE, '申请单信息缺失，请刷新后重试'); }
      return db.collection('requisition').doc(reqId).get()
        .catch(function () { return { data: null }; })
        .then(function (res) {
          var req = res.data;
          if (!req) { throw new R.BizError(C.CODE.NOT_FOUND, '申请单未找到'); }
          // 缺 status 的脏数据 → '未知'（绝不把英文 undefined 拼进用户文案）
          var statusLabel = C.REQ_STATUS_LABEL[req.status] || (req.status || '未知');
          if (req.status === C.REQ_STATUS.PENDING) {
            throw new R.BizError(C.CODE.NEGATIVE,
              '该申请单是' + statusLabel + '状态，请先驳回或确认后再操作，不能直接删除');
          }
          if (req.status !== C.REQ_STATUS.REJECTED && req.status !== C.REQ_STATUS.CANCELLED) {
            // confirmed 单到这分支（未来若有新终态也一并拦住，按「不能删」从严）
            throw new R.BizError(C.CODE.NEGATIVE,
              '该申请单是' + statusLabel + '状态，有库存流水，不能删除');
          }
          return dbh.withTx(db, function (t) {
            // 事务内单文档 remove 是允许的；删除前的终态判定已完成（get 在事务外）
            return t.collection('requisition').doc(req._id).remove();
          }).then(function () {
            /* 日志口径：终态名 + 门店占位（storeName 走「该门店」兜底，不外泄裸 storeId）。
             * 单号是业务键不是内部 _id？—— 不，requisitionId 就是文档 _id，与 reject/cancel 的
             * 既有日志同款带法（'驳回 ' + req.storeId + ' 食材申请：' + req._id），
             * 审计页 target 列本来就展示它，保持一致。 */
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.REQUISITION_DELETE,
              '删除申请单：' + req._id + '（' + statusLabel + '）',
              statusLabel, 'removed（库存不变，' + statusLabel + '）');
          }).then(function () {
            return { requisitionId: req._id, removed: true };
          });
        });
    });
  }

  /* ---------------- list：查询（shop 仅本店 / manager 全部 · createdAt 降序） ---------------- */
  if (action === 'list') {
    return auth.requireUser(db, C.ACTION.REQUISITION_QUERY, null, event).then(function (ctx) {
      var where = {};
      if (ctx.user.role === C.ROLE.SHOP) {
        where.storeId = ctx.user.storeId;           // storeScope 收敛：仅本店
      } else if (event.storeId) {
        where.storeId = String(event.storeId);
      }
      if (event.status) { where.status = String(event.status); }
      return db.collection('requisition').where(where).orderBy('createdAt', 'desc').limit(100).get()
        .then(function (res) { return { list: res.data || [] }; });
    });
  }

  /* ---------------- get：单据详情（含 rejectReason） ---------------- */
  if (action === 'get') {
    return auth.requireUser(db, C.ACTION.REQUISITION_QUERY, null, event).then(function (ctx) {
      return db.collection('requisition').doc(String(event.requisitionId || '')).get().then(function (res) {
        var req = res.data;
        if (!req) { throw new R.BizError(C.CODE.NOT_FOUND, '申请单未找到'); }
        if (ctx.user.role === C.ROLE.SHOP && req.storeId !== ctx.user.storeId) {
          throw new R.BizError(C.CODE.FORBIDDEN, C.CODE_MSG[1003] + '：非本店');
        }
        return { requisition: req };
      });
    });
  }

  // 原始 action 只写日志，不外泄给用户
  console.error('[UNKNOWN_ACTION]', 'requisition', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
