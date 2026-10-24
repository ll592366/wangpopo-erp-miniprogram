// ==========================================================================
// cloudfunctions/_shared/db.js — 数据库辅助（ARCH v1.5 §4.1 / §10）
// · 单据 ID 规则（§10）：<prefix>_<YYYYMMDD>_<STORECODE>_<6位序号>
//   例：req_20260730_WANDA_000123；总仓维度单据用 WAREHOUSE。
// · stock_balance 主键：bal_<storeId>_<itemId>（确定性 _id，便于事务内 doc().set）
// · changeBalance：余额变更 + 当日日结字段（dayOpenQty / dayInQty / dayOutQty / dayOpenDate）
// · 库存精度：统一 3 位小数 + 残渣吸附（quantizeStock / snapStock，2026-09-19 起）
// ==========================================================================
var C = require('./constants');

function pad6(n) {
  var s = String(n);
  while (s.length < 6) { s = '0' + s; }
  return s;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 营业日 YYYY-MM-DD（04:00 切分，UTC+8；与前端 utils/format.bizDate 对齐） */
function bizDate(d) {
  var t = d ? new Date(d) : new Date();
  var cn = new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000);
  if (cn.getHours() < C.CONFIG.BUSINESS_DAY_CUTOFF_HOUR) {
    cn = new Date(cn.getTime() - 24 * 3600 * 1000);
  }
  return cn.getFullYear() + '-' + pad2(cn.getMonth() + 1) + '-' + pad2(cn.getDate());
}

function yyyymmdd(d) { return bizDate(d).replace(/-/g, ''); }

/** 当前 UTC+8 ISO 串 */
function nowIso() {
  var t = new Date();
  var cn = new Date(t.getTime() + (8 * 60 + t.getTimezoneOffset()) * 60000);
  return cn.getFullYear() + '-' + pad2(cn.getMonth() + 1) + '-' + pad2(cn.getDate()) +
    'T' + pad2(cn.getHours()) + ':' + pad2(cn.getMinutes()) + ':' + pad2(cn.getSeconds()) + '+08:00';
}

/**
 * 单据号（§10）：<prefix>_<YYYYMMDD>_<STORECODE>_<seq>
 * seq = 当日同前缀同门店已有单据数 + 1（MVP 用计数法；高峰并发场景可升级为计数器集合）
 */
function genId(db, prefix, storeCode, collName) {
  var dateStr = yyyymmdd();
  var head = prefix + '_' + dateStr + '_' + (storeCode || 'WH') + '_';
  return db.collection(collName || 'purchase').where({
    _id: db.RegExp({ regexp: '^' + head, options: 'i' })
  }).count().then(function (res) {
    return head + pad6((res.total || 0) + 1);
  });
}

/** stock_balance 确定性主键 */
function balId(storeId, itemId) {
  return 'bal_' + storeId + '_' + itemId;
}

/** 读一条余额（无则返回零值 doc 形状；不落库） */
function readBalance(coll, storeId, itemId) {
  return coll.doc(balId(storeId, itemId)).get().then(function (res) {
    if (res.data) { return res.data; }
    return {
      _id: balId(storeId, itemId), storeId: storeId, itemId: itemId,
      qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null, updatedAt: null
    };
  }).catch(function () {
    return {
      _id: balId(storeId, itemId), storeId: storeId, itemId: itemId,
      qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null, updatedAt: null
    };
  });
}

/**
 * 门店级库存预警阈值（2026-10-09 老板拍板）
 * 老板口径：门店**只同步库存，不继承总仓阈值**；每店**一个统一值**（不是每店每食材），
 *   没设的店回落 CONFIG.LOW_STOCK_THRESHOLD（=2）。
 * ⚠️ 老板已知「包/斤/个/瓶 单位不同，统一数字含义不同」仍选统一值先落地，别自作主张细化。
 * @param {Object|null} storeDoc store 文档
 * @returns {number} 阈值（一定是 > 0 的数字，不会是 null）
 */
function storeThresholdOf(storeDoc) {
  var n = Number(storeDoc && storeDoc.lowStockThreshold);
  if (isFinite(n) && n > 0) { return quantizeStock(n); }
  return C.CONFIG.LOW_STOCK_THRESHOLD;
}

/**
 * 余额文档零值形状（不落库，仅作「该 (仓库,食材) 从未有余额行」的等价物）
 * ⚠️ 2026-10-09 起对外导出：requisition.confirm 的 prefetchBalances 用它给「查不到的 _id」
 *    补零值，使事务内 get 恒为 0（否则缺失行会让 changeBalanceWith 退回事务内 get，
 *    N=56 时事务内操作数 113 → 169，见 requisition/index.js）。
 */
function zeroBal(id, storeId, itemId) {
  return {
    _id: id, storeId: storeId, itemId: itemId,
    qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null
  };
}

/* ==========================================================================
 * 库存精度（2026-09-19 老板亲报「分次出品漏 0.01 包」根治）
 * 统一 3 位小数（0.001 包）：此前精度只到 0.01，1 包做 3 份每次扣 0.33，
 * 连出 3 次共 0.99 包，余额永远剩 0.01 清不掉。
 * ========================================================================== */

/** 库存精度：统一 3 位小数（0.001 包） */
function quantizeStock(v) {
  var n = Number(v);
  if (!isFinite(n)) { return 0; }
  return Math.round(n * 1000) / 1000;
}

var SNAP_ZERO = 0.02;   // 纯残渣阈值：|qty| ≤ 0.02 视为 0
var SNAP_INT = 0.02;    // 整数邻域阈值（仅对 |qty| ≥ 1 生效）

/**
 * 库存吸附：残渣归零 + 整数邻域取整（2.997 → 3）。
 * ⚠️ 红线：绝不吸附 |qty| < 1 的非零值 —— 例如「1 包做 200 份卖 1 份」的
 *    余额 0.995 是**真实中间态**，吸附成 1 等于偷偷回补库存。
 * 之所以不会累积成大残渣：每次写余额都吸附一次（见 changeBalance），
 *    1 包做 3 份连出 3 次序列为 1 → 0.667 → 0.334 → 0.001 → 0，第 3 次即归零。
 */
function snapStock(v) {
  var r = quantizeStock(v);
  if (Math.abs(r) <= SNAP_ZERO) { return 0; }
  if (Math.abs(r) >= 1) {
    var ni = Math.round(r);
    if (Math.abs(r - ni) <= SNAP_INT) { return ni; }   // 2.997 → 3
  }
  return r;
}

/**
 * 余额变更（须在事务内，用事务对象 t 的 collection）
 * @param {Transaction} t   事务对象（t.collection(...)）
 * @param {string} storeId  门店 _id 或 'WAREHOUSE'
 * @param {string} itemId   食材 _id
 * @param {number} delta    变化量（正 = 入，负 = 出）
 * @param {'in'|'out'} dir  日结流水方向（决定记 dayIn 还是 dayOut）
 *
 * ⚠️ 维护约定（与下方 changeBalanceWith 联动，改动前必读）：
 *    本函数是 changeBalanceWith 的孪生实现，两者逻辑必须**逐行一致**，
 *    任何一边改了逻辑，两边都要同步改。
 *    另外：changeBalanceWith 的 preBal **刻意不拷贝**（直接拿调用方对象原地改），
 *    requisition.confirm 的「同一食材多条明细」累加语义依赖这个原地更新。
 *    详见 changeBalanceWith 上方的红字约定。
 */
function changeBalance(t, storeId, itemId, delta, dir) {
  var today = bizDate();
  var id = balId(storeId, itemId);
  return t.collection('stock_balance').doc(id).get().catch(function (e) {
    // 真实云数据库：事务内 get 不存在的文档会**抛错**（本地桩件也已改成抛错，见 mock-sdk 的
    // mockMissingDocMessage）。首次入库 / 首次扣减就是这种情况 → 按「文档不存在」兜成零值新建。
    // ⚠️ 2026-10-08 加固：线上曾整单报「系统繁忙」，怀疑就是这里漏判了「不存在」的文案形态。
    //   只判英文 `not exist` 一种形态太脆（官方文案未查到、可能是中文或纯错误码），漏一种就整单崩。
    //   故改为**多形态匹配**，同时必须打出可追溯信息（_id + 错误码 + 原文）。
    // ⚠️ 绝不能变成「什么都吞」：权限/网络/超时等错误必须**原样抛出**，
    //   否则会静默新建余额、掩盖真故障。故用白名单式具体形态，不用 catch 全部。
    var msg = String((e && e.message) || e || '');
    var code = String((e && (e.errCode || e.code)) || '');
    // ⚠️ 文案形态来自真实用户上报 + 错误码表，**逐条列明**（不要凭印象删）：
    //   'does not exist' / 'not exist' —— 桩件默认文案、常见英文表述
    //   'cannot find document'          —— 真实用户上报的原文（见下），不含 not exist/found
    //   'ResourceNotFound'              —— 资源不存在（与 -502005 常同时出现）
    //   '不存在'                        —— 中文表述兜底
    //   -502005                         —— ⚠️ 错误码表里它登记为「集合不存在」，语义**有歧义**：
    //                                     文档找不到时也会返回它。故保留兜底，但绝不放宽到
    //                                     「catch 全部」——权限(-502003)/超时(-502011)等仍原样抛出。
    var missing = /not\s*exist|does\s*not\s*exist|cannot\s*find|can\s*not\s*find|not\s*found|resource\s*not\s*found|NOT_FOUND|不存在/i.test(msg)
      || /^-?502005$/.test(code);
    if (!missing) { throw e; }
    console.error('[balance] 余额文档不存在，按新建处理：', id, '| errCode=', code, '| msg=', msg);
    return { data: null };
  }).then(function (res) {
    var bal = res.data || zeroBal(id, storeId, itemId);
    var qtyBefore = Number(bal.qty) || 0;
    // 跨营业日 → 结转开盘
    if (bal.dayOpenDate !== today) {
      bal.dayOpenQty = qtyBefore;
      bal.dayInQty = 0;
      bal.dayOutQty = 0;
      bal.dayOpenDate = today;
    }
    var qtyAfter = snapStock(qtyBefore + delta);
    if (dir === 'in') {
      bal.dayInQty = quantizeStock(Number(bal.dayInQty) + delta);
    } else {
      bal.dayOutQty = quantizeStock(Number(bal.dayOutQty) - delta);
    }
    bal.qty = qtyAfter;
    bal.updatedAt = nowIso();
    // 注意：doc(id).set() 的 data 不允许带 _id（腾讯云会拒）→ 写入前剥离，_id 仅用于内部返回
    var payload = Object.assign({}, bal);
    delete payload._id;
    return t.collection('stock_balance').doc(id).set({ data: payload }).then(function () {
      return { before: qtyBefore, after: qtyAfter };
    });
  });
}

/**
 * 余额变更 · 事务外预读版（2026-10-09 大单事务超时根治专用）
 *
 * ⚠️ 起因：微信云开发事务有 **30 秒生命周期硬限制**（startTransaction() → commit() 必须完成），
 *    这是平台限制，不是云函数超时，改云函数超时配置无效。
 *    确认一张 N 条明细的申请单，原写法事务内要做 5N+1 次串行往返：
 *      N 次 readBalance（每次 1 次事务内 get）
 *      + 2N 次 changeBalance（每次内部 1 次 get + 1 次 set）
 *      + 1 次单据 update
 *    N=56 → 281 次 → 撑破 30 秒 → -501001 ResourceUnavailable.TransactionNotExist
 *    （「系统繁忙，请稍后重试」；N=2 → 11 次 → 正常，这就是小单没事、大单必崩的原因）
 *
 * 本函数与 changeBalance **逐行一致**（dayOpenDate 跨营业日结转 / snapStock 吸附 /
 * dayInQty·dayOutQty 累加 / payload 剥离 _id / doc(id).set({data}) / 返回 {before, after}），
 * 唯一区别在「余额从哪来」：
 *   preBal 非 null/undefined → 跳过事务内 get，直接用它当余额快照（事务内只剩 1 次 set）；
 *   preBal 为 null/undefined → 走原路径（事务内 get），行为与 changeBalance 完全一致
 *                              （含「文档不存在」多形态兜底 → 零值新建）。
 * 于是事务内往返由 2N 次降为 N 次（confirm 总计 5N+1 → 2N+1，N=56 时 281 → 113）。
 *
 * ⚠️ 维护约定（重要）：本函数是 changeBalance 的**镜像副本**。之所以不把两者合并成一个
 *    带可选参数的函数，是因为 changeBalance 是全系统唯一余额写入点，
 *    purchase / production / stocktake / inventory / requisition 其它分支共 5 个调用方都走它，
 *    线上热修阶段不敢动它一行。任何一边改了逻辑，**两边必须同步改**。
 *
 * ⚠️ 红线：绝不用 _.inc() 原子自增代替 set —— 会丢掉 snapStock 残渣吸附，
 *    「1 包做 200 份卖 1 份」的 0.995 是真实中间态，吸附成 1 等于偷偷回补库存。
 *
 * @param {Transaction} t      事务对象（t.collection(...)）
 * @param {string} storeId     门店 _id 或 'WAREHOUSE'
 * @param {string} itemId      食材 _id
 * @param {number} delta       变化量（正 = 入，负 = 出）
 * @param {'in'|'out'} dir     日结流水方向（决定记 dayIn 还是 dayOut）
 * @param {Object|null} [preBal] 事务外预读的余额文档；null/缺省则事务内 get
 * @returns {Promise<{before:number, after:number}>}
 *
 * ⚠️⚠️ 维护约定 · preBal 刻意**不拷贝**（2026-10-09 QA 变异实证，勿"优化"掉）：
 *    `Promise.resolve({ data: preBal })` 直接把调用方的对象交出去，本函数随即
 *    **原地修改它**（qty / dayInQty / dayOutQty / dayOpenDate / updatedAt）。
 *    这不是疏忽，是 requisition.confirm 的**第二道保护**：
 *    同一食材在明细里出现多次时，第 2 次写入读到的已经是第 1 次改后的值，
 *    于是 2+2+2 会正确累加成 6，而不是拿同一份旧快照覆盖成 2（漏扣）。
 *    QA 实证：
 *      · 只删 requisition/index.js 的 used 集合        → 测试不转红（本机制还在兜）
 *      · 只给这里加 Object.assign({}, preBal) 拷贝     → 测试不转红（used 还在兜）
 *      · **两个都做**                                   → 转红（qty=8，应为 7）
 *    即这里有 **两道** 独立保护，坏一道还有一道，静默失效。
 *    🚫 任何人给 preBal 加"看起来更规范"的防御性拷贝，系统就会悄悄退化成只依赖一道保护。
 *    ✅ 若确要加拷贝，必须**同时**确认 requisition/index.js 事务内的 `used` 集合仍在生效，
 *       并重新跑重复 itemId 的累加用例（期望：3 条 × 2 包 → 总仓 −6、门店 +6）。
 */
function changeBalanceWith(t, storeId, itemId, delta, dir, preBal) {
  var today = bizDate();
  var id = balId(storeId, itemId);
  // 余额来源：给了快照就直接用（事务内省掉 1 次 get）；没给就走原路径。
  var read = (preBal === null || preBal === undefined)
    ? t.collection('stock_balance').doc(id).get().catch(function (e) {
        // 与 changeBalance 逐字一致的「文档不存在」兜底：真实云数据库事务内 get 不存在的文档会抛错。
        // ⚠️ 多形态匹配（英文 / 中文 / 错误码），但**绝不 catch 全部** ——
        //    权限(-502003)/超时(-502011)等必须原样抛出，否则会静默新建余额、掩盖真故障。
        var msg = String((e && e.message) || e || '');
        var code = String((e && (e.errCode || e.code)) || '');
        var missing = /not\s*exist|does\s*not\s*exist|cannot\s*find|can\s*not\s*find|not\s*found|resource\s*not\s*found|NOT_FOUND|不存在/i.test(msg)
          || /^-?502005$/.test(code);
        if (!missing) { throw e; }
        console.error('[balance] 余额文档不存在，按新建处理：', id, '| errCode=', code, '| msg=', msg);
        return { data: null };
      })
    : Promise.resolve({ data: preBal });
  return read.then(function (res) {
    var bal = res.data || zeroBal(id, storeId, itemId);
    var qtyBefore = Number(bal.qty) || 0;
    // 跨营业日 → 结转开盘
    if (bal.dayOpenDate !== today) {
      bal.dayOpenQty = qtyBefore;
      bal.dayInQty = 0;
      bal.dayOutQty = 0;
      bal.dayOpenDate = today;
    }
    var qtyAfter = snapStock(qtyBefore + delta);
    if (dir === 'in') {
      bal.dayInQty = quantizeStock(Number(bal.dayInQty) + delta);
    } else {
      bal.dayOutQty = quantizeStock(Number(bal.dayOutQty) - delta);
    }
    bal.qty = qtyAfter;
    bal.updatedAt = nowIso();
    // 注意：doc(id).set() 的 data 不允许带 _id（腾讯云会拒）→ 写入前剥离，_id 仅用于内部返回
    var payload = Object.assign({}, bal);
    delete payload._id;
    return t.collection('stock_balance').doc(id).set({ data: payload }).then(function () {
      return { before: qtyBefore, after: qtyAfter };
    });
  });
}

/** 理论剩余 = 期初 + 当日入 − 当日出（同营业日）；否则 = 当前 qty */
function theoryOf(bal) {
  if (!bal) { return 0; }
  if (bal.dayOpenDate !== bizDate()) { return quantizeStock(Number(bal.qty) || 0); }
  return quantizeStock(Number(bal.dayOpenQty) + Number(bal.dayInQty) - Number(bal.dayOutQty));
}

/** 审计日志（D7：任何写操作同步追加一条） */
function log(db, actorId, actorName, action, target, before, after) {
  return db.collection('op_log').add({
    data: {
      actorId: actorId || 'unknown',
      actorName: actorName || '系统',
      action: action,
      target: target || '',
      before: before === undefined || before === null ? '' : String(before),
      after: after === undefined || after === null ? '' : String(after),
      createdAt: nowIso()
    }
  });
}

/** 事务包装：startTransaction → fn(t) → commit / rollback */
function withTx(db, fn) {
  return db.startTransaction().then(function (t) {
    return Promise.resolve()
      .then(function () { return fn(t); })
      .then(function (result) { return t.commit().then(function () { return result; }); })
      .catch(function (e) {
        return t.rollback().catch(function () { /* ignore */ }).then(function () { throw e; });
      });
  });
}

/**
 * 事务内操作串行执行器：fns = [() => Promise, ...]，按顺序跑，返回结果数组。
 * 微信云数据库事务【不支持并发操作文档】——并发 get/set/update 会报
 * -501001 ResourceUnavailable.TransactionActive / DATABASE_TRANSACTION_FAIL
 * （2026-09-12 确认申请线上事故根因）。事务里的读写一律走这里串行。
 */
function serial(fns) {
  var chain = Promise.resolve();
  var results = [];
  fns.forEach(function (fn) {
    chain = chain.then(function () {
      return Promise.resolve().then(fn).then(function (r) { results.push(r); });
    });
  });
  return chain.then(function () { return results; });
}

/** 门店编码（§7.2）：店名含字母数字取首段大写 ≤6 位；纯中文按 S01/S02 顺序 */
function genCode(db, name) {
  var m = String(name || '').match(/[A-Za-z0-9]+/);
  if (m) { return m[0].toUpperCase().slice(0, 6); }
  return db.collection('store').count().then(function (res) {
    var n = (res.total || 0) + 1;
    return 'S' + (n < 10 ? '0' + n : String(n));
  });
}

module.exports = {
  bizDate: bizDate,
  yyyymmdd: yyyymmdd,
  nowIso: nowIso,
  genId: genId,
  balId: balId,
  readBalance: readBalance,
  storeThresholdOf: storeThresholdOf,
  zeroBal: zeroBal,
  quantizeStock: quantizeStock,
  snapStock: snapStock,
  SNAP_ZERO: SNAP_ZERO,
  SNAP_INT: SNAP_INT,
  changeBalance: changeBalance,
  changeBalanceWith: changeBalanceWith,
  theoryOf: theoryOf,
  log: log,
  withTx: withTx,
  serial: serial,
  genCode: genCode
};
