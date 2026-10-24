// ==========================================================================
// tests/smoke/calibrate.js — 库存校准（2026-10-08 老板拍板）
//
// 老板原话：「门店端申请食材、管理端也确认了，这时候才发现门店端库存有问题，想修正」
//          → 管理端在「门店详情」点食材行弹出校准窗：**覆盖式**更正库存数量 +
//            给该食材设**单独**预警阈值；每次校准留记录。
//
// 本套验（不采信工程师的自测，全部自己跑）：
//   ① 权限：calibrate 仅 manager；门店账号 → 1003 且余额不动
//   ② 覆盖式：账面 5 → 校准为 2（不是"加减 2"）；stocktake 记一条 source=calibrate
//   ③ qty=0 是合法实点数（不是"没填"）
//   ④ 非法 qty（-1 / "abc"）→ 2002，余额**不动**；两个参数都不传 → 2002
//   ⑤ 单独阈值：设 3 → 只有 m1 是 3，m2 仍是本店统一值 8；**总仓行仍用档案值 10**
//   ⑥ 阈值留空（null）→ 清除单独设置，回落本店值
//   ⑦ 总仓带 threshold → 2002（总仓没有"门店阈值"概念）
//   ⑧ op_log 留痕：action=inventory.calibrate，target 是人话（不含裸 _id）
//   ⑨ calibrateList：双排序键分页不跳不漏 · shop 强制本店 · manager 不传 → 2002
//   ⑩ 前端静态守卫：弹窗入口 + ④ 校准记录 tab + 日志页中文标签
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var MP = path.join(PROJECT, 'miniprogram');
var WORK = path.join(os.tmpdir(), 'erp-calib-' + process.pid);
var FUNCS = ['inventory'];

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

/**
 * 种子：本店统一阈值 8，档案阈值故意给 10 / 4（总仓口径，与门店无关）。
 * 门店 m1 账面 5、m2 账面 1；总仓 m1 账面 100。
 */
function seed() {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '老板', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: '城南店', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  mock.seed('store', [{ _id: 'S1', code: 'S1C', name: '城南店', status: 'open', isActive: true, lowStockThreshold: 8 }]);
  mock.seed('material', [
    { _id: 'm1', name: '土豆', unit: '斤', lowStockThreshold: 10, isActive: true },
    { _id: 'm2', name: '牛肉', unit: '盒', lowStockThreshold: 4, isActive: true }
  ]);
  mock.seed('stock_balance', [
    { _id: 'bal_S1_m1', storeId: 'S1', itemId: 'm1', qty: 5, dayOpenQty: 5, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m2', storeId: 'S1', itemId: 'm2', qty: 1, dayOpenQty: 1, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);
}
function call(ev, who) { return F.inventory.main(Object.assign({}, who || MGR, ev)); }
function bal(storeId, itemId) {
  var hit = null;
  mock.dump('stock_balance').forEach(function (b) {
    if (b.storeId === storeId && b.itemId === itemId) { hit = b; }
  });
  return hit;
}
function stkRows() {
  return mock.dump('stocktake').filter(function (r) { return r.source === 'calibrate'; });
}
function logs() { return mock.dump('op_log'); }

/* ══════════ ① 权限 ══════════ */
section('① calibrate 权限：仅 manager');
seed();
call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 2 }, SHOP).then(function (r) {
  check('门店账号校准 → 1003 无权限', r.code === 1003, 'code=' + r.code + ' msg=' + r.message);
  check('★被拒时余额未被改动（仍是 5）', bal('S1', 'm1').qty === 5, String(bal('S1', 'm1').qty));
  check('被拒时不产生校准流水', stkRows().length === 0, 'stocktake(calibrate)=' + stkRows().length);

  /* ══════════ ② 覆盖式校准 ══════════ */
  section('② 覆盖式：账面 5 → 校准为 2（不是"再扣 2"）');
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 2 }, MGR);
}).then(function (r) {
  check('管理端校准 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('★余额被覆盖成 2（5-2=3 就是做成了"加减"而非覆盖）', bal('S1', 'm1').qty === 2, String(bal('S1', 'm1').qty));
  check('返回 qty = 2', r.data && r.data.qty === 2, JSON.stringify(r.data));
  var rows = stkRows();
  check('★写了 1 条校准流水（source=calibrate）', rows.length === 1, '条数=' + rows.length);
  check('流水 diff 有符号 = -3（非 Math.abs）', rows[0] && rows[0].diff === -3, rows[0] && String(rows[0].diff));
  check('流水 diffType = short（短缺）', rows[0] && rows[0].diffType === 'short', rows[0] && rows[0].diffType);
  check('流水记了操作人与营业日', !!(rows[0] && rows[0].operatorName && rows[0].bizDate),
    rows[0] && (rows[0].operatorName + ' / ' + rows[0].bizDate));

  /* ══════════ ③ qty=0 合法 ══════════ */
  section('③ qty=0 是合法实点数（卖完了 / 确实没有）');
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm2', qty: 0 }, MGR);
}).then(function (r) {
  check('校准为 0 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('★余额归 0（不是被当成"没填"跳过）', bal('S1', 'm2').qty === 0, String(bal('S1', 'm2').qty));

  /* ══════════ ④ 非法入参 ══════════ */
  section('④ 非法入参：负数 / 非数字 / 空操作 → 2002，且余额不动');
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: -1 }, MGR);
}).then(function (r) {
  check('qty=-1 → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  check('★非法入参后余额仍是 2', bal('S1', 'm1').qty === 2, String(bal('S1', 'm1').qty));
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 'abc' }, MGR);
}).then(function (r) {
  check('qty="abc" → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1' }, MGR);
}).then(function (r) {
  check('★啥都不传 → 2002「没有需要保存的修改」', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  check('空操作不新增流水', stkRows().length === 2, '流水条数=' + stkRows().length);

  /* ══════════ ⑤ 单独阈值 ══════════ */
  section('⑤ 该食材单独阈值：只影响这一个食材');
  seed();
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', threshold: 3 }, MGR);
}).then(function (r) {
  check('设单独阈值 3 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('返回生效阈值 = 3', r.data && r.data.threshold === 3, JSON.stringify(r.data));
  check('★阈值-only 不写库存流水（没动库存不该有差异）', stkRows().length === 0, '流水=' + stkRows().length);
  check('★没动余额（仍是 5）', bal('S1', 'm1').qty === 5, String(bal('S1', 'm1').qty));
  return call({ action: 'list', storeId: 'S1' }, MGR);
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var m1 = rows.filter(function (x) { return x.itemId === 'm1'; })[0];
  var m2 = rows.filter(function (x) { return x.itemId === 'm2'; })[0];
  console.log('     门店行 = ' + JSON.stringify(rows.map(function (x) { return { id: x.itemId, th: x.lowStockThreshold }; })));
  check('★m1 行级阈值 = 3（单独设的）', m1 && m1.lowStockThreshold === 3, m1 && String(m1.lowStockThreshold));
  check('★m2 行级阈值 = 8（回落本店统一值，没被连坐）', m2 && m2.lowStockThreshold === 8, m2 && String(m2.lowStockThreshold));
  check('★都不是档案值 10 / 4', m1 && m1.lowStockThreshold !== 10 && m2 && m2.lowStockThreshold !== 4,
    m1 && (m1.lowStockThreshold + ' / ' + m2.lowStockThreshold));
  check('顶层 storeThreshold 仍是本店统一值 8', r.data && r.data.storeThreshold === 8, String(r.data && r.data.storeThreshold));
  return call({ action: 'list', storeId: 'WAREHOUSE' }, MGR);
}).then(function (r) {
  var m1 = ((r.data && r.data.rows) || []).filter(function (x) { return x.itemId === 'm1'; })[0];
  check('★反向保留：总仓行阈值仍是档案值 10', m1 && m1.lowStockThreshold === 10, m1 && String(m1.lowStockThreshold));

  /* ══════════ ⑥ 清除阈值 ══════════ */
  section('⑥ 阈值留空（null）= 清除单独设置，回落本店值');
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', threshold: null }, MGR);
}).then(function (r) {
  check('清除 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('★生效阈值回落到 8', r.data && r.data.threshold === 8, JSON.stringify(r.data));
  var st = mock.dump('store')[0];
  check('itemThresholds 里该键已删除', !(st.itemThresholds && st.itemThresholds.m1 !== undefined), JSON.stringify(st.itemThresholds));
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', threshold: 0 }, MGR);
}).then(function (r) {
  check('threshold=0 → 2002（必须大于 0）', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);

  /* ══════════ ⑦ 总仓 ══════════ */
  section('⑦ 总仓：可以校准数量，但不给设"门店阈值"');
  return call({ action: 'calibrate', storeId: 'WAREHOUSE', itemId: 'm1', threshold: 5 }, MGR);
}).then(function (r) {
  check('★总仓带 threshold → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  return call({ action: 'calibrate', storeId: 'WAREHOUSE', itemId: 'm1', qty: 90 }, MGR);
}).then(function (r) {
  check('总仓校准数量 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('★总仓余额 100 → 90', bal('WAREHOUSE', 'm1').qty === 90, String(bal('WAREHOUSE', 'm1').qty));
  check('总仓返回 threshold = null', r.data && r.data.threshold === null, JSON.stringify(r.data));

  /* ══════════ ⑧ op_log ══════════ */
  section('⑧ op_log 留痕：人话 + 不外泄 _id');
  seed();
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 2, threshold: 3 }, MGR);
}).then(function () {
  var ls = logs().filter(function (l) { return l.action === 'inventory.calibrate'; });
  console.log('     日志 = ' + JSON.stringify(ls.map(function (l) { return { t: l.target, b: l.before, a: l.after }; })));
  check('写了 1 条 inventory.calibrate 日志', ls.length === 1, '条数=' + ls.length);
  check('★target 是人话（门店名 / 食材名）', ls[0] && /城南店/.test(ls[0].target) && /土豆/.test(ls[0].target), ls[0] && ls[0].target);
  check('★target 不含裸 _id', ls[0] && ls[0].target.indexOf('m1') < 0 && ls[0].target.indexOf('S1') < 0, ls[0] && ls[0].target);
  check('before / after 都记了（数量 5 → 2）',
    ls[0] && String(ls[0].before).indexOf('5') >= 0 && String(ls[0].after).indexOf('2') >= 0,
    ls[0] && (ls[0].before + ' → ' + ls[0].after));

  /* ══════════ ⑨ calibrateList ══════════ */
  section('⑨ 校准记录列表：分页不跳不漏 · 权限收敛');
  seed();
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 4 }, MGR);
}).then(function () {
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm2', qty: 7 }, MGR);
}).then(function () {
  return call({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 1 }, MGR);
}).then(function () {
  return call({ action: 'calibrateList', storeId: 'S1', offset: 0, limit: 2 }, MGR);
}).then(function (r) {
  check('列表 → code=0', r.code === 0, 'code=' + r.code + ' msg=' + r.message);
  check('第一页 2 条', r.data && r.data.list.length === 2, r.data && String(r.data.list.length));
  check('hasMore = true', r.data && r.data.hasMore === true, String(r.data && r.data.hasMore));
  check('有食材名（不是裸 _id）', r.data && r.data.list.every(function (x) { return x.itemName && x.itemName !== x.itemId; }),
    JSON.stringify(r.data && r.data.list.map(function (x) { return x.itemName; })));
  var p1 = r.data.list.map(function (x) { return x.itemId + ':' + x.qty; });
  return call({ action: 'calibrateList', storeId: 'S1', offset: 2, limit: 2 }, MGR).then(function (r2) {
    var p2 = r2.data.list.map(function (x) { return x.itemId + ':' + x.qty; });
    var all = p1.concat(p2);
    console.log('     两页合并 = ' + JSON.stringify(all));
    check('★第二页 1 条、hasMore=false', r2.data.list.length === 1 && r2.data.hasMore === false,
      r2.data.list.length + '/' + r2.data.hasMore);
    check('★两页合计 3 条且不重不漏', all.length === 3 && all.indexOf('m1:4') >= 0 && all.indexOf('m2:7') >= 0 && all.indexOf('m1:1') >= 0,
      JSON.stringify(all));
  });
}).then(function () {
  return call({ action: 'calibrateList', storeId: 'S2', offset: 0, limit: 10 }, SHOP);
}).then(function (r) {
  check('★门店账号传别店 S2 → 仍收敛本店（记录数 = 本店 3 条）',
    r.code === 0 && r.data && r.data.list.length === 3, 'code=' + r.code + ' 条数=' + (r.data ? r.data.list.length : '-'));
  return call({ action: 'calibrateList', offset: 0, limit: 10 }, MGR);
}).then(function (r) {
  check('管理端不传 storeId → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
  return call({ action: 'calibrateList', storeId: 'S1', offset: 0, limit: 9999 }, MGR);
}).then(function (r) {
  // limit 被压到物理上限 200：这里只验"没被放大到 9999 导致异常"，条数仍受实际数据限制
  check('limit 超大 → 正常返回（被压到物理上限）', r.code === 0 && r.data.list.length === 3,
    'code=' + r.code + ' 条数=' + (r.data ? r.data.list.length : '-'));

  /* ══════════ ⑩ 前端静态守卫 ══════════ */
  section('⑩ 前端：弹窗入口 + 校准记录 tab + 日志页中文标签');
  var sdWxml = fs.readFileSync(path.join(MP, 'pages/manager/store-detail/store-detail.wxml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  var sdJs = fs.readFileSync(path.join(MP, 'pages/manager/store-detail/store-detail.js'), 'utf8');
  check('★库存行可点（openCalib）', sdWxml.indexOf('bindtap="openCalib"') >= 0);
  check('★有校准弹窗（数量 + 阈值两个输入框）',
    sdWxml.indexOf('bindinput="onCalibQtyInput"') >= 0 && sdWxml.indexOf('bindinput="onCalibThInput"') >= 0 &&
    sdWxml.indexOf('bindtap="onSaveCalib"') >= 0);
  check('★有「④ 校准记录」tab', sdWxml.indexOf('④ 校准记录') >= 0 && sdWxml.indexOf("data-tab=\"calib\"") >= 0);
  check('★校准保存走 inventory/calibrate', /action: 'calibrate'/.test(sdJs));
  check('★阈值留空发清除指令（null，不是不发）', /payload\.threshold = null/.test(sdJs));
  check('★记录列表走 calibrateList', /action: 'calibrateList'/.test(sdJs));
  var cons = fs.readFileSync(path.join(MP, 'utils/constants.js'), 'utf8');
  check('★日志页有 inventory.calibrate 中文标签', cons.indexOf("'inventory.calibrate': '库存校准'") >= 0);

  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}).catch(function (e) {
  console.error('\n[FATAL] 套件崩了：', e && e.stack ? e.stack : e);
  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + (fail + 1));
  process.exit(1);
});
