// ==========================================================================
// tests/smoke/store-threshold.js — 门店级库存预警阈值（2026-10-09 老板拍板）
//
// 背景（口径演进，两轮）：
//   2026-10-08 老板：「门店端的预警阈值同步的是总仓的，这个是不对的，门店只同步库存，不同步阈值」
//                  → 当时把门店端预警**整体移除**（threshold/low/gap 全删）。
//   2026-10-09 老板（看到"门店怎么知道该申请什么"的风险后）：「门店要有**自己的**阈值」
//                  → 每店一个统一值，存在 store 文档上，管理端在门店详情设置，没设默认 2。
//
// 核心机制（cloudfunctions/inventory/index.js list 分支）：阈值**按语境切换**
//   · storeId === WAREHOUSE（总仓）→ 仍用 material.lowStockThreshold（备货警戒线，不能动）
//   · 门店                        → 用 store.lowStockThreshold（dbh.storeThresholdOf），缺省 2
//   返回字段**都叫 lowStockThreshold**，只是门店语境下语义变成「本店阈值」。
//
// ⚠️ 因此本套的关键不是「有没有阈值」，而是「阈值**来源**对不对」：
//   门店端拿到的必须**不等于** material 档案的值（否则就是把总仓备货线又请回来了）。
//   判据一律按"来源"区分，不按字段名 —— 字段名两边同名，硬禁字段名会误伤合法实现。
//
// 本套验：
//   ① 权限：setThreshold 仅 manager（门店账号 → 1003）
//   ② 入参校验：非数字 / 0 / 负数 → 2002；留空 = 清除 → 回落默认 2
//   ③ inventory 门店语境：没设 → 2（且 ≠ 档案值 10）；设成 3 → 3（≠ 10）
//   ④ inventory 总仓语境：**仍**返回档案值 10（反向保留，别改过头）
//   ⑤ setThreshold 有 op_log 留痕
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-sth-' + process.pid);
var FUNCS = ['store', 'inventory'];

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
rmrf(WORK);
fs.mkdirSync(path.join(WORK, 'node_modules', 'wx-server-sdk'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'mock-sdk.js'), path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
fs.writeFileSync(path.join(WORK, 'node_modules', 'wx-server-sdk', 'package.json'),
  JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
FUNCS.forEach(function (f) {
  var dst = path.join(WORK, f);
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(path.join(CF, f)).filter(function (n) { return /\.js$/.test(n); })
    .forEach(function (n) { fs.copyFileSync(path.join(CF, f, n), path.join(dst, n)); });
});

var sdk = require(path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
var mock = sdk.__mock;
var F = {};
FUNCS.forEach(function (f) { F[f] = require(path.join(WORK, f, 'index.js')); });

var MGR = { _uid: 'u_mgr' };
var SHOP = { _uid: 'u_shop' };
var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/** 种子：管理端 / 门店端账号 + 1 个门店 + 3 种食材（档案阈值故意给 10 / 4 / null） */
function seedBase(storeThreshold) {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '老板', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: '城南店', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  var st = { _id: 'S1', code: 'S1C', name: '城南店', status: 'open', isActive: true };
  if (storeThreshold !== undefined) { st.lowStockThreshold = storeThreshold; }
  mock.seed('store', [st]);
  // ⚠️ 档案阈值**故意**设成 10 / 4 / null —— 若门店端错用档案值，这里立刻能看出来
  mock.seed('material', [
    { _id: 'm1', name: '土豆', unit: '斤', lowStockThreshold: 10, isActive: true },
    { _id: 'm2', name: '牛肉', unit: '盒', lowStockThreshold: 4, isActive: true },
    { _id: 'm3', name: '白菜', unit: '斤', lowStockThreshold: null, isActive: true }
  ]);
  mock.seed('stock_balance', [
    { _id: 'bal_S1_m1', storeId: 'S1', itemId: 'm1', qty: 5, dayOpenQty: 5, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);
}
function call(fn, ev, who) { return F[fn].main(Object.assign({}, who || MGR, ev)); }
function storeDoc() { return mock.dump('store')[0]; }
function invRows() { return mock.dump('op_log'); }

/* ══════════════ ① 权限：仅 manager ══════════════ */
section('① setThreshold 权限：仅 manager（门店账号 → 1003）');
seedBase();
call('store', { action: 'setThreshold', storeId: 'S1', threshold: 3 }, SHOP).then(function (r) {
  check('门店账号设置本店阈值 → 1003 无权限', r.code === 1003, 'code=' + r.code + ' msg=' + r.message);
  check('被拒时 store 文档未被改动',
    storeDoc().lowStockThreshold === undefined, 'lowStockThreshold=' + storeDoc().lowStockThreshold);

  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: 3 }, MGR);
}).then(function (r) {
  check('管理端设置 → 成功（code=0）', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('store 文档已写入 3', storeDoc().lowStockThreshold === 3, String(storeDoc().lowStockThreshold));

  /* ══════════════ ② 入参校验 ══════════════ */
  section('② 入参校验：非数字 / 0 / 负数 → 2002');
  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: 'abc' }, MGR);
}).then(function (r) {
  check('非数字 "abc" → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: 0 }, MGR);
}).then(function (r) {
  check('0 → 2002（必须大于 0）', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: -1 }, MGR);
}).then(function (r) {
  check('负数 -1 → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  check('非法入参未污染已存的值（仍为 3）', storeDoc().lowStockThreshold === 3, String(storeDoc().lowStockThreshold));
  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: '' }, MGR);
}).then(function (r) {
  check('留空 = 清除 → code=0', r.code === 0, 'code=' + r.code);
  check('清除后字段置 null', storeDoc().lowStockThreshold === null, String(storeDoc().lowStockThreshold));
  check('返回 threshold 回落到默认 2', r.data && r.data.threshold === 2, JSON.stringify(r.data));

  /* ══════════════ ③ 门店语境：阈值来源 ══════════════ */
  section('③ inventory 门店语境：用本店阈值，**不**用总仓档案阈值');
  seedBase();                                   // store 没设 lowStockThreshold
  return call('inventory', { action: 'list', storeId: 'S1' }, MGR);
}).then(function (r) {
  check('inventory 调用成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
  var rows = (r.data && r.data.rows) || [];
  var ths = rows.map(function (x) { return x.lowStockThreshold; });
  console.log('     返回 rows = ' + JSON.stringify(rows.map(function (x) { return { id: x.itemId, qty: x.qty, th: x.lowStockThreshold }; })));
  check('各行的阈值都是默认 2（门店没设）',
    ths.length === 3 && ths.every(function (t) { return t === 2; }), JSON.stringify(ths));
  check('★门店阈值 ≠ 档案阈值 10（土豆档案是 10，给成 10 就是又用了总仓备货线）',
    ths.every(function (t) { return t !== 10; }), JSON.stringify(ths));

  seedBase(3);                                  // store.lowStockThreshold = 3
  return call('inventory', { action: 'list', storeId: 'S1' }, MGR);
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var ths = rows.map(function (x) { return x.lowStockThreshold; });
  console.log('     设成 3 后 rows = ' + JSON.stringify(rows.map(function (x) { return { id: x.itemId, th: x.lowStockThreshold }; })));
  check('★设成 3 → 各行阈值都是 3（不是档案的 10 / 4 / null）',
    ths.length === 3 && ths.every(function (t) { return t === 3; }), JSON.stringify(ths));

  /* ══════════════ ④ 总仓语境：反向保留 ══════════════ */
  section('④ inventory 总仓语境：仍用 material 档案阈值（反向保留，别改过头）');
  seedBase(3);
  return call('inventory', { action: 'list', storeId: 'WAREHOUSE' }, MGR);
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var byId = {};
  rows.forEach(function (x) { byId[x.itemId] = x.lowStockThreshold; });
  console.log('     总仓 rows = ' + JSON.stringify(byId));
  check('★总仓 土豆仍返回档案值 10', byId['m1'] === 10, String(byId['m1']));
  check('★总仓 牛肉仍返回档案值 4', byId['m2'] === 4, String(byId['m2']));
  check('★总仓 白菜档案没配 → null（前端自己回落 2）', byId['m3'] === null, String(byId['m3']));

  /* ══════════════ ⑤ op_log 留痕 ══════════════ */
  section('⑤ setThreshold 有 op_log 留痕');
  seedBase();
  return call('store', { action: 'setThreshold', storeId: 'S1', threshold: 4 }, MGR);
}).then(function (r) {
  var logs = mock.dump('op_log') || [];
  console.log('     op_log = ' + JSON.stringify(logs.map(function (l) { return { action: l.action, target: l.target, before: l.before, after: l.after }; })));
  check('写了 1 条 op_log', logs.length === 1, logs.length + ' 条');
  check('action = store.setThreshold', logs[0] && logs[0].action === 'store.setThreshold', logs[0] && logs[0].action);
  check('before/after 都记了阈值', logs[0] && /2/.test(logs[0].before) && /4/.test(logs[0].after),
    (logs[0] ? logs[0].before + ' → ' + logs[0].after : ''));

  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  rmrf(WORK);
  process.exitCode = fail === 0 ? 0 : 1;
}).catch(function (e) {
  console.error('HARNESS ERROR', e);
  rmrf(WORK);
  process.exitCode = 1;
});
