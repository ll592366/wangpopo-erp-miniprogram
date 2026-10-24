// ==========================================================================
// cloudfunctions/_shared/db.js — 数据库辅助（ARCH v1.5 §4.1 / §10）
// · 单据 ID 规则（§10）：<prefix>_<YYYYMMDD>_<STORECODE>_<6位序号>
//   例：req_20260730_WANDA_000123；总仓维度单据用 WAREHOUSE。
// · stock_balance 主键：bal_<storeId>_<itemId>（确定性 _id，便于事务内 doc().set）
// · changeBalance：余额变更 + 当日日结字段（dayOpenQty / dayInQty / dayOutQty / dayOpenDate）
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

/** 余额文档零值形状 */
function zeroBal(id, storeId, itemId) {
  return {
    _id: id, storeId: storeId, itemId: itemId,
    qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null
  };
}

/**
 * 余额变更（须在事务内，用事务对象 t 的 collection）
 * @param {Transaction} t   事务对象（t.collection(...)）
 * @param {string} storeId  门店 _id 或 'WAREHOUSE'
 * @param {string} itemId   食材 _id
 * @param {number} delta    变化量（正 = 入，负 = 出）
 * @param {'in'|'out'} dir  日结流水方向（决定记 dayIn 还是 dayOut）
 */
function changeBalance(t, storeId, itemId, delta, dir) {
  var today = bizDate();
  var id = balId(storeId, itemId);
  return t.collection('stock_balance').doc(id).get().catch(function (e) {
    // 真实云数据库：事务内 get 不存在的文档会直接抛错
    //（document.get:fail document with _id ... does not exist）；本地 mock 是宽松返回 null。
    // 首次入库/首次扣减就是这种情况 → 按「文档不存在」兜成零值新建；其余错误原样抛出。
    var msg = String((e && e.message) || e || '');
    if (msg.indexOf('not exist') < 0 && msg.indexOf('NOT_FOUND') < 0) { throw e; }
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
    var qtyAfter = Math.round((qtyBefore + delta) * 100) / 100;
    if (dir === 'in') {
      bal.dayInQty = Math.round((Number(bal.dayInQty) + delta) * 100) / 100;
    } else {
      bal.dayOutQty = Math.round((Number(bal.dayOutQty) - delta) * 100) / 100;
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
  if (bal.dayOpenDate !== bizDate()) { return Math.round((Number(bal.qty) || 0) * 100) / 100; }
  return Math.round((Number(bal.dayOpenQty) + Number(bal.dayInQty) - Number(bal.dayOutQty)) * 100) / 100;
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
  changeBalance: changeBalance,
  theoryOf: theoryOf,
  log: log,
  withTx: withTx,
  serial: serial,
  genCode: genCode
};
