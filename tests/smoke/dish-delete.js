// ==========================================================================
// tests/smoke/dish-delete.js — 菜品「删除（引用检查）」专项
//
// 老板口径（2026-10 定案）：菜品管理页原「停用/启用」改为「删除」，
//   规则与食材删除一致 —— 先做引用检查，被业务数据引用即拦（人话），否则真删。
//   菜品仅以「出品记录」(production.dishId) 为引用源；菜品不持有库存余额
//   （stock_balance 以食材 itemId 为键），故无级联清理。
//
// 本套用真实云函数（dish）+ mock-sdk 内存库跑，验：
//   ① 有出品记录 → 拦住（人话 · 含菜品名 + N 条出品记录 · 不泄 dishId/内部 _id）；
//   ② 无引用 → 删除成功（档案消失 · op_log +1 · action=dish.update）；
//   ③ 出品指向「另一个」dishId → 不拦（负对照 · 点号/相等匹配不恒真）；
//   ④ _id 缺失 → 人话「未指定要操作的菜品，请刷新页面后重试」（非 5001 · 不含内部标识）；
//   ⑤ 菜品不存在 → 3001「菜品未找到」；
//   ⑥ 权限：shop 调 remove 一律 1003（且不动数据）；
//   ⑦ 删除后档案彻底消失（内嵌 consumeItems 随档案一并清除，无残留）。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-dishdel-' + process.pid);
var FUNCS = ['dish'];

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

rmrf(WORK);
fs.mkdirSync(path.join(WORK, 'node_modules', 'wx-server-sdk'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'mock-sdk.js'),
  path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
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
var dish = require(path.join(WORK, 'dish', 'index.js'));

var MGR_USER = { _id: 'user_manager', name: '王婆婆·管理', role: 'manager', storeId: null, isActive: true };
var SHOP_USER = { _id: 'user_shop', name: '门店员', role: 'shop', storeId: 'S1', isActive: true };
var MGR = { _uid: 'user_manager' };
var SHOP = { _uid: 'user_shop' };

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function call(fn, ev, who) { return fn.main(Object.assign({}, who || MGR, ev)); }
function dishRows() { return mock.dump('dish'); }
function opRows() { return mock.dump('op_log'); }
function opCount() { return opRows().length; }
function dishStill(id) { return dishRows().filter(function (d) { return d._id === id; }).length === 1; }

var DEL_DISH = { _id: 'd_del', name: '宫保鸡丁', isActive: true, consumeItems: [{ itemId: 'm1', qty: 0.5 }] };

function seedBase(extraDishes) {
  mock.reset();
  mock.seed('user', [MGR_USER, SHOP_USER]);
  mock.seed('store', [{ _id: 'S1', name: '门店1', status: 'open' }]);
  mock.seed('material', [{ _id: 'm1', name: '牛肉片', isActive: true }]);
  mock.seed('dish', extraDishes || [DEL_DISH]);
}

var chain = Promise.resolve();

/* ==========================================================================
 * ① 有出品记录 → 拦住（人话 · 不泄 id）
 * ========================================================================== */
section('① 有出品记录 → 拦住（人话 · 含菜品名 + N 条出品记录 · 不泄 id）');
chain = chain.then(function () {
  seedBase();
  mock.seed('production', [
    { _id: 'pr1', dishId: 'd_del', qty: 1 },
    { _id: 'pr2', dishId: 'd_del', qty: 2 },
    { _id: 'pr3', dishId: 'd_del', qty: 3 }
  ]);
  return call(dish, { action: 'remove', _id: 'd_del' }).then(function (r) {
    var msg = r.message || '';
    check('被出品记录引用 → 拦住', r.code !== 0, 'code=' + r.code + ' ' + msg);
    check('拦截文案含菜品名', /宫保鸡丁/.test(msg), msg);
    check('拦截文案含「有 3 条出品记录」', /有 3 条出品记录/.test(msg), msg);
    check('拦截文案不含 dishId 字样', msg.indexOf('dishId') < 0, msg);
    check('拦截文案不含内部 _id', msg.indexOf('d_del') < 0, msg);
    check('被拦后菜品仍在', dishStill('d_del'), dishStill('d_del'));
    check('被拦后不写 op_log', opCount() === 0, opCount());
  });
});
chain = chain.then(function () {
  // 仅 1 条出品记录 → 计数精确（不恒报「多条」）
  seedBase();
  mock.seed('production', [{ _id: 'pr1', dishId: 'd_del', qty: 1 }]);
  return call(dish, { action: 'remove', _id: 'd_del' }).then(function (r) {
    check('仅 1 条出品 → 文案「有 1 条出品记录」', /有 1 条出品记录/.test(r.message || ''), r.message);
  });
});

/* ==========================================================================
 * ② 无引用 → 删除成功（档案消失 · op_log +1）
 * ========================================================================== */
section('② 无引用 → 删除成功（档案消失 · op_log +1 · action=dish.update）');
chain = chain.then(function () {
  seedBase();
  mock.seed('production', []);
  var before = opCount();
  return call(dish, { action: 'remove', _id: 'd_del' }).then(function (r) {
    check('无引用 → 删除成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('返回被删 _id', r.data && r.data._id === 'd_del', JSON.stringify(r.data));
    check('菜品已从库中消失', !dishStill('d_del'), dishStill('d_del'));
    check('op_log +1 且 action=dish.update',
      opCount() === before + 1 && opRows().some(function (l) { return l.action === 'dish.update'; }),
      opCount());
  });
});

/* ==========================================================================
 * ③ 出品指向「另一个」dishId → 不拦（负对照）
 * ========================================================================== */
section('③ 出品指向「另一个」dishId → 不拦（负对照 · 相等匹配不恒真）');
chain = chain.then(function () {
  seedBase([
    { _id: 'd_del', name: '宫保鸡丁', isActive: true, consumeItems: [] },
    { _id: 'd_other', name: '鱼香肉丝', isActive: true, consumeItems: [] }
  ]);
  mock.seed('production', [{ _id: 'pr1', dishId: 'd_other', qty: 1 }]);
  return call(dish, { action: 'remove', _id: 'd_del' }).then(function (r) {
    check('出品指向别的菜品 → 不拦（负对照）', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('目标菜品被删', !dishStill('d_del'), dishStill('d_del'));
    check('另一个菜品不受影响', dishStill('d_other'), dishStill('d_other'));
  });
});

/* ==========================================================================
 * ④ _id 缺失 → 人话（非 5001 · 不含内部标识）
 * ========================================================================== */
section('④ _id 缺失 → 人话「未指定要操作的菜品，请刷新页面后重试」');
chain = chain.then(function () {
  seedBase();
  mock.seed('production', []);
  return call(dish, { action: 'remove' }).then(function (r) {
    check('缺 _id → 业务码拦截（非 5001）', r.code !== 0 && r.code !== 5001, 'code=' + r.code + ' ' + r.message);
    check('缺 _id 文案 = 未指定要操作的菜品，请刷新页面后重试',
      r.message === '未指定要操作的菜品，请刷新页面后重试', r.message);
    check('缺 _id 文案不含内部标识（_id）', (r.message || '').indexOf('_id') < 0, r.message);
    check('缺 _id 不动数据', dishStill('d_del') && opCount() === 0, dishStill('d_del') + '/' + opCount());
  });
});

/* ==========================================================================
 * ⑤ 菜品不存在 → 3001「菜品未找到」
 * ========================================================================== */
section('⑤ 菜品不存在 → 3001「菜品未找到」');
chain = chain.then(function () {
  seedBase();
  mock.seed('production', []);
  return call(dish, { action: 'remove', _id: '不存在的菜' }).then(function (r) {
    check('菜品不存在 → 3001', r.code === 3001, 'code=' + r.code + ' ' + r.message);
    check('不存在文案 = 菜品未找到', r.message === '菜品未找到', r.message);
  });
});

/* ==========================================================================
 * ⑥ 权限：shop 调 remove 一律 1003
 * ========================================================================== */
section('⑥ 权限：shop 调 remove 一律 1003（且不动数据）');
chain = chain.then(function () {
  seedBase();
  mock.seed('production', []);
  return call(dish, { action: 'remove', _id: 'd_del' }, SHOP).then(function (r) {
    check('shop 删菜品被拒（1003）', r.code === 1003, 'code=' + r.code + ' ' + r.message);
    check('shop 被拒后菜品仍在', dishStill('d_del'), dishStill('d_del'));
    check('shop 被拒后不写 op_log', opCount() === 0, opCount());
  });
});

/* ==========================================================================
 * ⑦ 删除后档案彻底消失（内嵌 consumeItems 无残留）
 * ========================================================================== */
section('⑦ 删除后档案彻底消失（内嵌 consumeItems 无残留）');
chain = chain.then(function () {
  seedBase([
    { _id: 'd_del', name: '宫保鸡丁', isActive: true, consumeItems: [{ itemId: 'm1', qty: 0.5 }, { itemId: 'm2', qty: 1 }] }
  ]);
  mock.seed('production', []);
  return call(dish, { action: 'remove', _id: 'd_del' }).then(function (r) {
    check('删除成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    var leftover = dishRows().filter(function (d) {
      return d._id === 'd_del' || (d.consumeItems || []).some(function (it) { return it.itemId === 'm1'; });
    });
    check('库中无该菜品任何残留（含内嵌配方）', leftover.length === 0 && dishRows().length === 0,
      'leftover=' + leftover.length + ' dish=' + dishRows().length);
  });
});

/* ---------- 收尾 ---------- */
chain = chain.catch(function (e) {
  fail++;
  console.log('  \u2717 [UNCAUGHT] ' + (e && e.stack ? e.stack : e));
}).then(function () {
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'DISH-DELETE RESULT: ALL GREEN' : 'DISH-DELETE RESULT: RED');
  try { rmrf(WORK); } catch (e) { /* ignore */ }
  process.exitCode = fail === 0 ? 0 : 1;
});
