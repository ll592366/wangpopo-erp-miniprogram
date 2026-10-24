// ==========================================================================
// tests/smoke/off-shelf.js — 食材下架（isActive === false）专项
//
// 为什么补这一套：全仓 tests/ 里 grep「下架 / isActive === false / 已下架」只有 1 处命中
//   （smoke.js，还不是这次新加的），而 #53/#55/#56/#57 四项改动**基本零覆盖**。
//   #56 是**库存方向性**改动，错了就是：要么库存凭空归零，要么余货永远清不掉 / 库存被"复活"。
//
// 老板口径（源码注释 2026-10-09 自述，我按它写断言，不对就报缺陷）：
//   ① 下架 ≠ 删除：还有货的下架食材**必须照常显示**（账面要对得上）；
//      只有「已下架 **且** 库存为 0」才隐藏；负库存**不许**被藏掉（是异常账，得让老板看见）。
//   ② 已下架食材**只允许库存往下**（把余货处理掉 → 归零 → 自动隐藏）；
//      往上加 = 让它「复活」，与「下架」语义冲突 → 必须拒。
//   ③ 在售食材**完全不拦**，可增可减（不能误伤）。
//   ④ 三个入口（inventory.adjust / inventory.calibrate / stocktake.create）口径必须一致。
//
// 本套验（★= 核心红线）：
//   ★① 三入口方向守卫：往下放行（含清零）/ 往上 3001 / 持平放行；在售可增可减
//   ★② list 隐藏判定：下架+0 隐藏、下架+有货 显示、下架+负库存 显示、在售+0 显示
//   ③ 3001 文案：全中文、有食材名、**不含** 裸 _id
//   ④ 拦截必须是**整单拒绝**：余额不动、不留 op_log、不写 stocktake
//   ⑤ material.toggle 下架/上架 + op_log 人话
//   ⑥ 前端静态守卫：下架按钮 + 「显示已下架（N）」开关 + 下架后果弹窗讲清楚
//   ⑦ 副本一致性：inventory 与 stocktake 的孪生守卫**同时存在**（只有一处就是漏改）
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

var PROJECT = path.resolve(__dirname, '..', '..');
var MP = path.join(PROJECT, 'miniprogram');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-off-' + process.pid);
var FUNCS = ['inventory', 'stocktake', 'material', 'purchase', 'dish'];

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

/* ---------------- 种子 ----------------
 * m1 土豆：在售，总仓 100 / 门店 5
 * m2 松露：★已下架，总仓 8 / 门店 3（有余货 —— 正是"要能清掉"的那一行）
 * m3 白菜：★已下架，总仓 0（隐藏面：已下架 + 0 → 不出行为）
 * m4 萝卜：★已下架，总仓 -2（负库存：异常账，不许被藏）
 * m5 青椒：在售，总仓 0（在下架+0 隐藏的对照：在售+0 必须照常显示）
 */
function seed() {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '老板', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: '城南店', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  mock.seed('store', [{ _id: 'S1', code: 'CN', name: '城南店', status: 'open', isActive: true, lowStockThreshold: 8 }]);
  mock.seed('material', [
    { _id: 'm1', name: '土豆', unit: '斤', lowStockThreshold: 10, isActive: true },
    { _id: 'm2', name: '松露', unit: 'g', lowStockThreshold: 1, isActive: false },
    { _id: 'm3', name: '白菜', unit: '斤', lowStockThreshold: 5, isActive: false },
    { _id: 'm4', name: '萝卜', unit: '斤', lowStockThreshold: 5, isActive: false },
    { _id: 'm5', name: '青椒', unit: '斤', lowStockThreshold: 5, isActive: true }
  ]);
  /* ⚠️ 余额行的 _id **必须**是 `bal_<storeId>_<itemId>`：dbh.readBalance / changeBalance
   *    就是按这个拼法直查文档的（我第一版随手写成 b_W_m1，桩件直接报「余额文档不存在，
   *    按新建处理」→ 现值被当成 0，delta 全落在 0 上 → 8−3 变成 −3。是我种子写错，不是源码问题）。
   */
  mock.seed('stock_balance', [
    { _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m2', storeId: 'WAREHOUSE', itemId: 'm2', qty: 8, dayOpenQty: 8, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m3', storeId: 'WAREHOUSE', itemId: 'm3', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m4', storeId: 'WAREHOUSE', itemId: 'm4', qty: -2, dayOpenQty: -2, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m5', storeId: 'WAREHOUSE', itemId: 'm5', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m1', storeId: 'S1', itemId: 'm1', qty: 5, dayOpenQty: 5, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m2', storeId: 'S1', itemId: 'm2', qty: 3, dayOpenQty: 3, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m3', storeId: 'S1', itemId: 'm3', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);
  mock.seed('stocktake', []);
  mock.seed('op_log', []);
  /* d1 = **老菜**：配方里本来就含已下架食材 m2（★核心红线的被测物：
   *   「老菜含下架食材 → 编辑 → 保存 → 那一行必须还在」）
   */
  mock.seed('dish', [{
    _id: 'd1', name: '松露炒蛋（老菜）', isActive: true, createdAt: '2026-10-09T09:00:00.000Z',
    consumeItems: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 1 }]
  }]);
}
function inv(ev, who) { return F.inventory.main(Object.assign({}, who || MGR, ev)); }
function stk(ev, who) { return F.stocktake.main(Object.assign({}, who || MGR, ev)); }
function mat(ev, who) { return F.material.main(Object.assign({}, who || MGR, ev)); }
function pur(ev, who) { return F.purchase.main(Object.assign({}, who || MGR, ev)); }
function dsh(ev, who) { return F.dish.main(Object.assign({}, who || MGR, ev)); }
function bal(storeId, itemId) {
  var hit = null;
  mock.dump('stock_balance').forEach(function (b) { if (b.storeId === storeId && b.itemId === itemId) { hit = b; } });
  return hit ? hit.qty : null;
}
function logs() { return mock.dump('op_log') || []; }
function stkDocs() { return mock.dump('stocktake') || []; }
/** 文案里有没有漏内部 id 出来 */
function leakIn(s) {
  return ['m1', 'm2', 'm3', 'm4', 'm5', 'S1', 'u_mgr', 'u_shop', 'bal_', 'stk_'].filter(function (t) {
    return String(s).indexOf(t) >= 0;
  });
}

/* ========================================================================
 * ★① 三入口方向守卫：已下架食材只能往下，不能往上
 * ====================================================================== */
section('★① 方向守卫 · inventory.adjust（增量式 delta）：已下架 m2 松露 总仓 8');

seed();
inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', delta: 5 }).then(function (r) {
  check('★已下架 + 往上加（delta +5）→ 3001 拒绝', r.code === 3001,
    'code=' + r.code + ' msg=' + (r.message || ''));
  check('★3001 文案有食材名、无裸 id', /松露/.test(r.message || '') && leakIn(r.message).length === 0,
    '「' + r.message + '」泄漏=' + JSON.stringify(leakIn(r.message)));
  check('★整单拒绝：余额仍 8（一点没动）', bal('WAREHOUSE', 'm2') === 8, String(bal('WAREHOUSE', 'm2')));
  check('★整单拒绝：不留 op_log', logs().length === 0, logs().length + ' 条');

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', delta: -3 });
}).then(function (r) {
  check('★已下架 + 往下减（delta −3）→ 放行（余货要能处理掉）', r.code === 0,
    'code=' + r.code + ' msg=' + (r.message || ''));
  check('★减完余额 8 → 5', bal('WAREHOUSE', 'm2') === 5, String(bal('WAREHOUSE', 'm2')));
  check('往下减留 op_log（人话 + 有食材名）',
    logs().length === 1 && /松露/.test(logs()[0].target || ''), JSON.stringify(logs().map(function (l) { return l.target; })));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', delta: -8 });
}).then(function (r) {
  check('★已下架 + 一次清零（delta −8）→ 放行（这是主干：归零后自动隐藏）', r.code === 0,
    'code=' + r.code + ' msg=' + (r.message || ''));
  check('★清零后余额 = 0（不是残留 0.0001）', bal('WAREHOUSE', 'm2') === 0, String(bal('WAREHOUSE', 'm2')));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm1', delta: 20 });
}).then(function (r) {
  check('③ 在售 m1 往上加（+20）→ 不拦（不能误伤）', r.code === 0,
    'code=' + r.code + ' msg=' + (r.message || ''));
  check('③ 在售加完 100 → 120', bal('WAREHOUSE', 'm1') === 120, String(bal('WAREHOUSE', 'm1')));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm1', delta: -40 });
}).then(function (r) {
  check('③ 在售往下减（−40）→ 不拦', r.code === 0 && bal('WAREHOUSE', 'm1') === 60,
    'code=' + r.code + ' 余额=' + bal('WAREHOUSE', 'm1'));

  /* ---- 覆盖式（target）：口径与增量式必须一致 ---- */
  section('★①b 方向守卫 · inventory.adjust（覆盖式 target）：已下架 m2 现值 8');
  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', target: 20 });
}).then(function (r) {
  check('★覆盖式：目标 20 > 现值 8（要加库存）→ 3001', r.code === 3001,
    'code=' + r.code + ' msg=' + (r.message || ''));
  check('★覆盖式被拒：余额仍 8', bal('WAREHOUSE', 'm2') === 8, String(bal('WAREHOUSE', 'm2')));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', target: 2 });
}).then(function (r) {
  check('★覆盖式：目标 2 < 现值 8（往下）→ 放行', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★覆盖式改完余额 = 2（是"覆盖成 2"，不是"减 2"）', bal('WAREHOUSE', 'm2') === 2, String(bal('WAREHOUSE', 'm2')));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', target: 0 });
}).then(function (r) {
  check('★覆盖式：目标 0（清零）→ 放行', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★覆盖式清零后余额 = 0', bal('WAREHOUSE', 'm2') === 0, String(bal('WAREHOUSE', 'm2')));

  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', target: 8 });
}).then(function (r) {
  check('持平（目标 8 = 现值 8）→ 放行且不改余额', r.code === 0 && bal('WAREHOUSE', 'm2') === 8,
    'code=' + r.code + ' 余额=' + String(bal('WAREHOUSE', 'm2')));

  /* ---- calibrate 入口 ---- */
  section('★①c 方向守卫 · inventory.calibrate（门店 S1 校准）：已下架 m2 门店 3');
  seed();
  return inv({ action: 'calibrate', storeId: 'S1', itemId: 'm2', qty: 9 });
}).then(function (r) {
  check('★校准到 9 > 现值 3（要加库存）→ 3001', r.code === 3001, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★校准被拒：门店余额仍 3', bal('S1', 'm2') === 3, String(bal('S1', 'm2')));
  check('★校准被拒：不写 stocktake 记录', stkDocs().length === 0, stkDocs().length + ' 条');

  seed();
  return inv({ action: 'calibrate', storeId: 'S1', itemId: 'm2', qty: 0 });
}).then(function (r) {
  check('★校准到 0（清零方向）→ 放行', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★清零后门店余额 = 0', bal('S1', 'm2') === 0, String(bal('S1', 'm2')));
  check('★qty=0 是合法实点数（不是"没填"）：留了校准记录', stkDocs().length === 1, stkDocs().length + ' 条');

  seed();
  return inv({ action: 'calibrate', storeId: 'S1', itemId: 'm1', qty: 30 });
}).then(function (r) {
  check('③ 在售食材校准往上（5 → 30）→ 不拦', r.code === 0 && bal('S1', 'm1') === 30,
    'code=' + r.code + ' 余额=' + String(bal('S1', 'm1')));

  /* ---- stocktake 入口 ---- */
  section('★①d 方向守卫 · stocktake.create（门店 S1 盘点）：已下架 m2 账面 3');
  seed();
  return stk({ action: 'create', storeId: 'S1', itemId: 'm2', actualQty: 10 }, SHOP);
}).then(function (r) {
  check('★实点 10 > 账面 3（要加库存）→ 3001', r.code === 3001, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★盘点被拒：余额仍 3', bal('S1', 'm2') === 3, String(bal('S1', 'm2')));
  check('★盘点被拒：不写 stocktake 单', stkDocs().length === 0, stkDocs().length + ' 条');

  seed();
  return stk({ action: 'create', storeId: 'S1', itemId: 'm2', actualQty: 0 }, SHOP);
}).then(function (r) {
  check('★实点 0（清零方向）→ 放行', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★盘成 0 后余额 = 0', bal('S1', 'm2') === 0, String(bal('S1', 'm2')));
  check('★盘成 0 写了 stocktake 单（source=stocktake）',
    stkDocs().length === 1 && stkDocs()[0].source === 'stocktake', JSON.stringify(stkDocs().map(function (d) { return d.source; })));

  seed();
  return stk({ action: 'create', storeId: 'S1', itemId: 'm1', actualQty: 50 }, SHOP);
}).then(function (r) {
  check('③ 在售食材盘点往上（5 → 50）→ 不拦', r.code === 0 && bal('S1', 'm1') === 50,
    'code=' + r.code + ' 余额=' + String(bal('S1', 'm1')));

  /* ========================================================================
   * ★② list 隐藏判定
   * ====================================================================== */
  section('★② inventory.list 隐藏判定：只有「已下架 **且** 库存为 0」才隐藏');
  seed();
  return inv({ action: 'list', storeId: 'WAREHOUSE' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var byId = {};
  rows.forEach(function (x) { byId[x.itemId] = x; });
  console.log('     实测 list 出行为：' + rows.map(function (x) { return x.itemId + '(' + x.name + ')=' + x.qty; }).join('  '));
  check('★m3 已下架 + 库存 0 → **隐藏**（不出行为）', !byId.m3, 'm3=' + JSON.stringify(byId.m3 || null));
  check('★m2 已下架 + 有货 8 → **照常显示**（下架 ≠ 删除，账面要对得上）',
    !!byId.m2 && byId.m2.qty === 8, 'm2=' + JSON.stringify(byId.m2 || null));
  check('★m4 已下架 + **负库存** −2 → **照常显示**（负库存是异常账，藏了账面就对不上）',
    !!byId.m4 && byId.m4.qty === -2, 'm4=' + JSON.stringify(byId.m4 || null));
  check('★m5 在售 + 库存 0 → **照常显示**（在售的不能藏）',
    !!byId.m5 && byId.m5.qty === 0, 'm5=' + JSON.stringify(byId.m5 || null));
  check('★m1 在售 + 有货 → 照常显示', !!byId.m1 && byId.m1.qty === 100, 'm1=' + JSON.stringify(byId.m1 || null));

  seed();
  return inv({ action: 'list', storeId: 'S1' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var byId = {};
  rows.forEach(function (x) { byId[x.itemId] = x; });
  check('②b 门店语境同理：m3 已下架+0 隐藏', !byId.m3, 'm3=' + JSON.stringify(byId.m3 || null));
  check('②b 门店语境同理：m2 已下架+有货 3 显示', !!byId.m2 && byId.m2.qty === 3, 'm2=' + JSON.stringify(byId.m2 || null));

  /* ---- 归零后自动隐藏（主干链路闭环）---- */
  seed();
  return inv({ action: 'adjust', storeId: 'WAREHOUSE', itemId: 'm2', delta: -8 }).then(function () {
    return inv({ action: 'list', storeId: 'WAREHOUSE' });
  });
}).then(function (r) {
  var byId = {};
  ((r.data && r.data.rows) || []).forEach(function (x) { byId[x.itemId] = x; });
  check('★主干闭环：把下架食材清到 0 之后，它**自动从 list 消失**（下架→处理余货→归零→隐藏 走得通）',
    !byId.m2, 'm2=' + JSON.stringify(byId.m2 || null));

  /* ========================================================================
   * ⑤ material.toggle 下架 / 上架
   * ====================================================================== */
  section('⑤ material.toggle 下架 / 上架 + op_log 人话');
  seed();
  return mat({ action: 'toggle', _id: 'm1', isActive: false });
}).then(function (r) {
  check('下架在售食材 m1 → 返回 isActive=false', r.code === 0 && r.data && r.data.isActive === false,
    'code=' + r.code + ' isActive=' + (r.data && r.data.isActive));
  var l = logs()[0] || {};
  check('op_log 人话：「停用食材 土豆」，不含裸 id',
    /停用/.test(l.target || '') && /土豆/.test(l.target || '') && leakIn(l.target).length === 0,
    '「' + l.target + '」泄漏=' + JSON.stringify(leakIn(l.target)));
  return mat({ action: 'toggle', _id: 'm1', isActive: true });
}).then(function (r) {
  check('上架回来 → isActive=true', r.code === 0 && r.data && r.data.isActive === true,
    'code=' + r.code + ' isActive=' + (r.data && r.data.isActive));
  return mat({ action: 'toggle', _id: 'm1', isActive: false }, SHOP);
}).then(function (r) {
  check('门店账号下架食材 → 1003（下架是管理端专属）', r.code === 1003, 'code=' + r.code);

  /* ========================================================================
   * ⑤b 另两个「下架后选不到它」的入口：采购 / 菜品配置
   *   下架弹窗对老板的承诺是「采购、门店申请、菜品配置里都选不到它」——
   *   采购 / 门店申请（requisition.create）服务端都拦了，这里逐条实测。
   * ====================================================================== */
  section('⑤b 采购 / 菜品配置：已下架食材到底能不能选（对照下架弹窗对老板的承诺）');
  seed();
  return pur({ action: 'create', itemId: 'm2', qty: 5, unit: 'g' });
}).then(function (r) {
  check('★采购已下架食材 m2 → 2002 拒绝（弹窗承诺「采购选不到它」服务端成立）',
    r.code === 2002, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★采购被拒文案有食材名、无裸 id', /松露/.test(r.message || '') && leakIn(r.message).length === 0,
    '「' + r.message + '」');
  check('★采购被拒：总仓库存没被动（8 不变）', bal('WAREHOUSE', 'm2') === 8, String(bal('WAREHOUSE', 'm2')));

  seed();
  return pur({ action: 'create', itemId: 'm1', qty: 5, unit: '斤' });
}).then(function (r) {
  check('在售食材采购 → 放行（不能误伤）', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));

  /* ========================================================================
   * ★⑤c 菜品配置（dish.save）的下架校验 —— 2026-10-09 拍板口径（改动前必读）
   *   · **新建**菜品：没有原文档 → 每一行都算「新增行」→ 下架食材**拦**（2002）
   *   · **编辑**菜品：拿得到原 consumeItems → itemId **在原配方里** → **放行**；
   *                  **不在原配方里** → **拦**
   * 🔴 核心红线：**老菜含已下架食材 → 编辑 → 保存 → 那一行必须还在**。
   *    拦错了 = 老板一保存配方凭空消失、还**没有任何报错**（前端 _extendOptions
   *    辛苦把下架食材补回下拉，服务端不能把它推翻）。这条是整个改动的存在理由。
   * 校验顺序：itemId 空 → 食材不存在(3001) → **下架(2002)** → 用量>0(2002)
   * ====================================================================== */
  section('★⑤c 菜品配置 dish.save：新建拦新增行 / 编辑放行老配方里的下架食材');

  /* ---- 新建：每一行都是新增行 → 拦 ---- */
  seed();
  return dsh({ action: 'save', name: '松露炒蛋', consumeItems: [{ itemId: 'm2', qty: 1 }] });
}).then(function (r) {
  check('★新建菜品传已下架食材 m2 → 2002 拒绝（新建态每行都算新增行）',
    r.code === 2002, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★拒绝文案**精确等于**「食材「松露」已下架，不能加进菜品配方」（不用正则，防措辞漂移）',
    r.message === '食材「松露」已下架，不能加进菜品配方', '实际：「' + r.message + '」');
  check('★整单拒绝：不新增菜品（库里仍只有种子里的老菜 d1）',
    (mock.dump('dish') || []).length === 1 &&
    (mock.dump('dish') || []).filter(function (x) { return x.name === '松露炒蛋'; }).length === 0,
    JSON.stringify((mock.dump('dish') || []).map(function (x) { return x._id + '/' + x.name; })));
  check('★整单拒绝：不留 op_log', logs().length === 0, logs().length + ' 条');

  seed();
  return dsh({ action: 'save', name: '青椒土豆丝', consumeItems: [{ itemId: 'm1', qty: 2 }, { itemId: 'm5', qty: 1 }] });
}).then(function (r) {
  check('在售食材新建菜品 → 放行（不能误伤）', r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));

  /* ---- 🔴 核心：老菜含已下架食材 → 编辑 → 保存 → 那行必须还在 ---- */
  seed();
  return dsh({
    action: 'save', _id: 'd1', name: '松露炒蛋（老菜）',
    consumeItems: [{ itemId: 'm1', qty: 5 }, { itemId: 'm2', qty: 1 }]   // m1 用量 2→5，m2 原样保留
  });
}).then(function (r) {
  var d = (mock.dump('dish') || []).filter(function (x) { return x._id === 'd1'; })[0];
  var ids = ((d && d.consumeItems) || []).map(function (x) { return x.itemId + ':' + x.qty; }).join(',');
  check('★★老菜含已下架 m2 → 编辑（顺带把 m1 用量 2→5）→ **放行**',
    r.code === 0, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★★保存后 m2 那行**仍在**且用量正确（拦错 = 老板一保存配方凭空消失，且无任何报错）',
    ids === 'm1:5,m2:1', ids);
  check('★★放行也留 op_log（编辑菜品，人话）',
    logs().length === 1 && /编辑菜品/.test(logs()[0].target || ''),
    JSON.stringify(logs().map(function (l) { return l.target; })));

  /* ---- 编辑时**新增**一行下架食材（不在原配方里）→ 拦 ---- */
  seed();
  return dsh({
    action: 'save', _id: 'd1', name: '松露炒蛋（老菜）',
    consumeItems: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 1 }, { itemId: 'm3', qty: 3 }]
  });
}).then(function (r) {
  var d = (mock.dump('dish') || []).filter(function (x) { return x._id === 'd1'; })[0];
  var ids = ((d && d.consumeItems) || []).map(function (x) { return x.itemId + ':' + x.qty; }).join(',');
  check('★编辑时**新增**一行别的已下架食材 m3（不在原配方里）→ 2002',
    r.code === 2002, 'code=' + r.code + ' msg=' + (r.message || ''));
  check('★新增下架行被拒：原配方一个字没动（仍 m1:2,m2:1）', ids === 'm1:2,m2:1', ids);
  check('★新增下架行被拒：不留 op_log', logs().length === 0, logs().length + ' 条');

  /* ---- 校验顺序：下架 优先于 用量 ---- */
  seed();
  return dsh({ action: 'save', name: '顺序验证菜', consumeItems: [{ itemId: 'm2', qty: 0 }] });
}).then(function (r) {
  check('★校验顺序：下架 + 用量 0 同时犯 → 先报**下架**（不是用量文案）',
    r.message === '食材「松露」已下架，不能加进菜品配方', '实际：「' + r.message + '」');

  seed();
  return dsh({ action: 'save', name: '顺序验证菜2', consumeItems: [{ itemId: 'm_no_such', qty: 1 }] });
}).then(function (r) {
  check('★校验顺序：食材不存在（3001）优先于下架判定',
    r.code === 3001, 'code=' + r.code + ' msg=' + (r.message || ''));

  /* ========================================================================
   * ⑦ 副本一致性：孪生守卫必须**两处都在**
   * ====================================================================== */
  section('⑦ inventory 与 stocktake 的「方向守卫」必须孪生存在（只改一处 = 漏改）');
  var invSrc = fs.readFileSync(path.join(CF, 'inventory', 'index.js'), 'utf8');
  var stkSrc = fs.readFileSync(path.join(CF, 'stocktake', 'index.js'), 'utf8');
  function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''); }
  var invC = strip(invSrc), stkC = strip(stkSrc);
  var guardRe = /function guardOffShelfNoIncrease\(mat, delta\)\s*\{\s*if \(!mat \|\| mat\.isActive !== false\) \{ return; \}/;
  check('★inventory 有方向守卫（且是「只拦已下架」的写法）', guardRe.test(invC),
    '命中=' + guardRe.test(invC));
  check('★stocktake 有**同款**方向守卫（孪生，不是各写一套）', guardRe.test(stkC),
    '命中=' + guardRe.test(stkC));
  check('★两处守卫的拒码/文案口径一致（都 3001 + 「只能将库存清零，不能增加」）',
    (invC.match(/只能将库存清零，不能增加/g) || []).length === 1 &&
    (stkC.match(/只能将库存清零，不能增加/g) || []).length === 1,
    'inventory ' + (invC.match(/只能将库存清零，不能增加/g) || []).length + ' 处 / stocktake ' +
    (stkC.match(/只能将库存清零，不能增加/g) || []).length + ' 处');
  check('★三入口都真的调了守卫（adjust 覆盖式 / adjust 增量式 / calibrate / stocktake，共 ≥4 处调用）',
    (invC.match(/guardOffShelfNoIncrease\(/g) || []).length >= 3 &&
    (stkC.match(/guardOffShelfNoIncrease\(/g) || []).length >= 1,
    'inventory 调用 ' + (invC.match(/guardOffShelfNoIncrease\(/g) || []).length + ' 处 / stocktake ' +
    (stkC.match(/guardOffShelfNoIncrease\(/g) || []).length + ' 处');
  check('★list 的隐藏判定是「已下架 **且** 库存为 0」，不是简单 `qty <= 0`（后者会把负库存一起藏掉）',
    /isActive === false && snapQty === 0/.test(invC), '命中=' + /isActive === false && snapQty === 0/.test(invC));

  /* ========================================================================
   * ⑥ 前端静态守卫
   * ====================================================================== */
  section('⑥ 前端静态守卫（pages/manager/goods 的下架按钮与开关）');
  var gJs = fs.readFileSync(path.join(MP, 'pages', 'manager', 'goods', 'goods.js'), 'utf8');
  var gWxml = fs.readFileSync(path.join(MP, 'pages', 'manager', 'goods', 'goods.wxml'), 'utf8');
  var gJsC = strip(gJs), gWC = gWxml.replace(/<!--[\s\S]*?-->/g, ' ');
  check('有「下架 / 上架」按钮（bindtap）', /bindtap="toggleActive"/.test(gWC), '命中=' + /bindtap="toggleActive"/.test(gWC));
  check('有「显示已下架（N）」开关（默认不显示，开了才列出来）',
    /bindtap="toggleShowInactive"/.test(gWC) && /显示已下架（\{\{inactiveCount\}\}）/.test(gWC),
    '开关=' + /bindtap="toggleShowInactive"/.test(gWC) + ' 文案=' + /显示已下架（\{\{inactiveCount\}\}）/.test(gWC));
  check('★下架前先弹窗讲清后果（不是点了就消失）', /下架食材/.test(gJsC) && /wx\.showModal/.test(gJsC),
    '命中=' + (/下架食材/.test(gJsC) && /wx\.showModal/.test(gJsC)));
  check('★下架后果讲清楚：选不到它 + 余货照常用完 + 归零后自动隐藏',
    /采购、门店申请、菜品配置里都选不到它/.test(gJsC) && /库存归零后自动隐藏/.test(gJsC),
    '命中=' + (/采购、门店申请、菜品配置里都选不到它/.test(gJsC) && /库存归零后自动隐藏/.test(gJsC)));
  check('★下架成功后自动展开「显示已下架」（否则界面上和「删除」长得一样，老板会以为东西被删了）',
    /showInactive/.test(gJsC) && /自动展开|setData\(\{[^}]*showInactive: true/.test(gJsC),
    '命中=' + (/showInactive/.test(gJsC) && /自动展开|setData\(\{[^}]*showInactive: true/.test(gJsC)));
  check('已下架行用真名 + 「已下架」标签，绝不露 _id', /已下架/.test(gJsC) && !/\{\{m\._id\}\}/.test(gWC),
    'wxml 露 _id=' + /\{\{m\._id\}\}/.test(gWC));

  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  if (fail > 0) { process.exitCode = 1; }
}).catch(function (e) {
  console.log('\n!!! 套件抛错：' + (e && e.stack || e));
  fail += 1;
  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  process.exitCode = 1;
});
