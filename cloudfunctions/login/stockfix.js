// ==========================================================================
// cloudfunctions/_shared/stockfix.js — 库存精度巡检（存量残渣一次性归零）
// 背景（2026-09-19 老板亲报）：此前余额精度只到 0.01 包，1 包做 3 份「分次出品」
//   每次扣 0.33，连出 3 次共 0.99 包 → 余额永远剩 0.01，清不掉、日积月累。
//   现口径：精度统一 0.001（dbh.quantizeStock），每次写余额自动吸附（dbh.snapStock）。
//   本模块负责把**线上存量**残渣扫出来归零（老板已同意，保守 + 可追溯）。
//
// 保守红线（勿放宽）：
//   · 只改 qty 一个字段，绝不碰 dayOpenQty / dayInQty / dayOutQty / 其他任何字段；
//   · 分页扫描（每页 100，最多 3000 条），禁用裸 .get()（云函数单次返回有上限）；
//   · 单次修改上限 500 条，fixed 回传上限 200 条，超出即截断并标 truncated；
//   · |qty| < 1 的非零中间态（如 0.995）**不吸附**，只在 0.02 内视为残渣归零；
//   · itemName 批量回查（去重 + 分批 in），禁止逐条 N+1。
// 用法：runFix(db, opts?) → { scanned, fixed, suspect, truncated }
//   fixed   = [{ storeId, itemId, before, after, itemName }]（已改）
//   suspect = [{ storeId, itemId, qty, itemName }]（**未改**，供老板复核）
// 日志：本模块不写 op_log，由调用方（material / login）统一写，避免重复留痕。
// ==========================================================================
var dbh = require('./db');

var PAGE_SIZE = 100;      // 每页扫描条数
var MAX_SCAN = 3000;      // 最多扫描条数（超出停 + truncated）
var MAX_FIX = 500;        // 单次最多修改条数（超出停 + truncated）
var MAX_REPORT = 200;     // fixed 回传上限
var IN_CHUNK = 50;        // in 查询分批大小
var SUSPECT_MIN = 0.02;   // 复核窗口下界（= SNAP_INT，超过它才“可疑”）
var SUSPECT_MAX = 0.1;    // 复核窗口上界

/**
 * 巡检并归零存量残渣
 * @param {object} db     云数据库实例
 * @param {object} [opts] { maxScan, maxFix } 可选覆盖上限（自测用）
 * @returns {Promise<{scanned:number, fixed:Array, suspect:Array, truncated:boolean}>}
 */
function runFix(db, opts) {
  opts = opts || {};
  var maxScan = Number(opts.maxScan) > 0 ? Number(opts.maxScan) : MAX_SCAN;
  var maxFix = Number(opts.maxFix) > 0 ? Number(opts.maxFix) : MAX_FIX;
  var _ = db.command;

  // 真实云开发支持 skip() 分页；测试桩件没有 skip() → 退化为一次性读满上限（只读，不递归）
  var driver = db.collection('stock_balance');
  var useSkip = typeof driver.skip === 'function';
  var pageSize = useSkip ? PAGE_SIZE : maxScan;
  if (!useSkip) { console.warn('[stockfix] 驱动无 skip()，退化为单页读取 limit=' + pageSize); }

  var scanned = 0;
  var fixed = [];        // 已改条目（回传前截断到 MAX_REPORT）
  var suspect = [];      // 未改、供复核
  var truncated = false;

  function scanPage(skip) {
    if (scanned >= maxScan || fixed.length >= maxFix) {
      truncated = true;
      return Promise.resolve();
    }
    var p = useSkip
      ? driver.skip(skip).limit(pageSize).get()
      : driver.limit(pageSize).get();
    return p.then(function (res) {
      var rows = (res && res.data) || [];
      if (rows.length === 0) { return null; }
      if (scanned + rows.length > maxScan) { rows = rows.slice(0, maxScan - scanned); }
      scanned += rows.length;

      var tasks = [];
      rows.forEach(function (bal) {
        var before = Number(bal.qty) || 0;
        var after = dbh.snapStock(before);
        if (after !== before) {
          if (fixed.length >= maxFix) { truncated = true; return; }
          var key = String(bal.storeId) + '/' + String(bal.itemId);
          fixed.push({
            storeId: bal.storeId, itemId: bal.itemId, key: key,
            before: before, after: after, itemName: String(bal.itemId)
          });
          tasks.push(function () {
            // 只改 qty 一个字段（保守红线）；data 里绝不含 _id
            return db.collection('stock_balance').doc(String(bal._id)).update({
              data: { qty: after, updatedAt: dbh.nowIso() }
            }).catch(function (e) {
              console.warn('[stockfix] 写入失败 ' + String(bal._id) + '：' + String((e && (e.errMsg || e.message)) || e));
              // 写失败的条目摘掉，避免虚报“已修正”
              fixed = fixed.filter(function (f) { return f.key !== key; });
              return null;
            });
          });
          return;
        }
        // 未改动：落在「非整数邻域、但又不算残渣」的窗口内 → 可疑，供老板复核（不自动改）
        if (Math.abs(before) >= 1) {
          var near = Math.abs(before - Math.round(before));
          if (near > SUSPECT_MIN && near <= SUSPECT_MAX) {
            suspect.push({ storeId: bal.storeId, itemId: bal.itemId, qty: before, itemName: String(bal.itemId) });
          }
        }
      });

      return dbh.serial(tasks).then(function () {
        if (!useSkip) {                              // 掉队驱动：只读一页，不递归
          if (rows.length >= pageSize) { truncated = true; }   // 万一被驱动截断，如实标记
          return null;
        }
        if (rows.length < pageSize) { return null; }
        return scanPage(skip + pageSize);
      });
    });
  }

  return scanPage(0).then(function () {
    return fillItemNames(db, fixed.concat(suspect));
  }).then(function () {
    var out = fixed.slice(0, MAX_REPORT).map(function (f) {
      return { storeId: f.storeId, itemId: f.itemId, before: f.before, after: f.after, itemName: f.itemName };
    });
    return {
      scanned: scanned,
      fixed: out,
      suspect: suspect,
      truncated: truncated || fixed.length > MAX_REPORT
    };
  });
}

/**
 * 批量回查食材名（去重 + 分批 in；禁止 N+1）
 * @param {object} db
 * @param {Array} rows [{ itemId, itemName }]
 */
function fillItemNames(db, rows) {
  var ids = [];
  rows.forEach(function (r) {
    var id = String(r.itemId || '');
    if (id && ids.indexOf(id) < 0) { ids.push(id); }
  });
  if (ids.length === 0) { return Promise.resolve(); }

  var chunks = [];
  for (var i = 0; i < ids.length; i += IN_CHUNK) { chunks.push(ids.slice(i, i + IN_CHUNK)); }

  return dbh.serial(chunks.map(function (chunk) {
    return function () {
      return db.collection('material').where({ _id: db.command.in(chunk) }).limit(chunk.length).get()
        .then(function (res) {
          var map = {};
          ((res && res.data) || []).forEach(function (m) { map[String(m._id)] = m.name; });
          rows.forEach(function (r) {
            var id = String(r.itemId || '');
            if (map[id]) { r.itemName = map[id]; }
          });
          return null;
        })
        .catch(function () { return null; });   // 回查失败只影响展示名，不影响修正结果
    };
  }));
}

module.exports = {
  runFix: runFix
};
