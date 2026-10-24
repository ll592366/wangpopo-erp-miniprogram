// ==========================================================================
// tests/smoke/material-delete-stock-edit.js — 食材「总仓数量覆盖编辑 + 删除（引用检查）」专项
//
// 老板口径（2026-10 定案）：
//   A. 总仓数量「覆盖式」调整：inventory.adjust 传 target → 把总仓置为目标值；
//      精度 3 位小数（quantizeStock）；目标 = 现值 → 不动、不留痕；target < 0 拦截；
//      老口径增量 delta 仍可用（回归）。
//   B. 删除食材：先做引用检查（菜品消耗 / 采购 / 领用 / 出品 / 盘点），被引用即拦（人话）；
//      stock_balance（库存余额）不算引用，随档案一并清除。
//
// 本套用真实云函数（material / inventory）+ mock-sdk 内存库跑，验：
//   ① adjust 覆盖：5→3 / →8 / →0；覆盖语义（不叠加）；精度 0.333→1 / →0.5；
//   ② adjust 校验：非数字 / 负数被拦；target=现值 → 不改、不留 op_log；老 delta 回归；
//   ③ remove：5 条引用链逐条拦截（人话 · 不泄 itemId）；嵌套点号匹配不恒真；
//   ④ remove 成功：档案没了 / stock_balance 清了 / op_log +1；有库存无引用仍可删；
//   ⑤ 权限：shop 调 remove / adjust 一律 1003。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-matdel-' + process.pid);
var FUNCS = ['material', 'inventory'];

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
var material = require(path.join(WORK, 'material', 'index.js'));
var inventory = require(path.join(WORK, 'inventory', 'index.js'));

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
function matRows() { return mock.dump('material'); }
function balRows() { return mock.dump('stock_balance'); }
function opCount() { return mock.dump('op_log').length; }
function balQty(storeId, itemId) {
  var r = balRows().filter(function (b) { return b.storeId === storeId && b.itemId === itemId; })[0];
  return r ? r.qty : null;
}
function seedBal(storeId, itemId, qty) {
  mock.seed('stock_balance', [{ _id: 'bal_' + storeId + '_' + itemId, storeId: storeId, itemId: itemId, qty: qty }]);
}
function seedBase(extraMats) {
  mock.reset();
  mock.seed('user', [MGR_USER, SHOP_USER]);
  mock.seed('store', [{ _id: 'S1', name: '门店1', status: 'open' }]);
  mock.seed('material', extraMats || [{ _id: 'm1', name: '牛肉片', unit: '包', isActive: true }]);
}
function findBalStore(storeId, itemId) {
  return balRows().filter(function (b) { return b.storeId === storeId && b.itemId === itemId; }).length;
}

var chain = Promise.resolve();

/* ==========================================================================
 * ① adjust 覆盖式：基本覆盖 + 覆盖语义（不叠加）
 * ========================================================================== */
section('① adjust 覆盖式（target 置为目标值，不叠加）');
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 3 }).then(function (r) {
    check('5 → target 3 成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('覆盖后余额 = 3', balQty('WAREHOUSE', 'm1') === 3, balQty('WAREHOUSE', 'm1'));
    check('返回覆盖前/后精确值', r.data && r.data.balanceAfter &&
      r.data.balanceAfter.before === 5 && r.data.balanceAfter.after === 3,
      JSON.stringify(r.data && r.data.balanceAfter));
    check('op_log +1', opCount() === 1, opCount());
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 8 }).then(function (r) {
    check('5 → target 8 成功', r.code === 0, 'code=' + r.code);
    check('覆盖后余额 = 8（不是 5+8=13）', balQty('WAREHOUSE', 'm1') === 8, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 0 }).then(function (r) {
    check('5 → target 0 成功', r.code === 0, 'code=' + r.code);
    check('覆盖后余额 = 0', balQty('WAREHOUSE', 'm1') === 0, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  // 覆盖语义：无论现值多少，终值恒等于 target（不是 现值±target）
  seedBase();
  seedBal('WAREHOUSE', 'm1', 100);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 2 }).then(function (r) {
    check('现值 100 → target 2 = 2（覆盖，非叠加）', r.code === 0 && balQty('WAREHOUSE', 'm1') === 2,
      balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  // 无余额文档（首次）也能量到 target
  seedBase();
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 4 }).then(function (r) {
    check('无余额（0）→ target 4 = 4（事务内建余额）', r.code === 0 && balQty('WAREHOUSE', 'm1') === 4,
      balQty('WAREHOUSE', 'm1'));
  });
});

/* ==========================================================================
 * ② adjust 精度（3 位小数）
 * ========================================================================== */
section('② adjust 3 位小数精度');
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.333);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 1 }).then(function (r) {
    check('现值 0.333 → target 1 = 1', r.code === 0 && balQty('WAREHOUSE', 'm1') === 1,
      balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.333);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 0.5 }).then(function (r) {
    var q = balQty('WAREHOUSE', 'm1');
    check('现值 0.333 → target 0.5 = 0.5（不是 0.33）', r.code === 0 && q === 0.5, q);
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 1);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 0.667 }).then(function (r) {
    check('target 0.667 保留 3 位小数（不被抹成 0.67）', r.code === 0 && balQty('WAREHOUSE', 'm1') === 0.667,
      balQty('WAREHOUSE', 'm1'));
  });
});

/* ==========================================================================
 * ③ adjust 校验 + target=现值不动 + 老 delta 回归
 * ========================================================================== */
section('③ adjust 校验 · target=现值不动 · 老 delta 回归');
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 'abc' }).then(function (r) {
    check('非数字 target 被拦（业务码）', r.code !== 0 && r.code !== 5001, 'code=' + r.code + ' ' + r.message);
    check('非数字错误文案是人话', /数字/.test(r.message || ''), r.message);
    check('非数字不改余额', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: -1 }).then(function (r) {
    check('负数 target 被拦（2002）', r.code === 2002, 'code=' + r.code + ' ' + r.message);
    check('负数错误文案 = 数量不能为负数', r.message === '数量不能为负数', r.message);
    check('负数不改余额', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  var before = opCount();
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 5 }).then(function (r) {
    check('target = 现值 → 成功且不改余额', r.code === 0 && balQty('WAREHOUSE', 'm1') === 5,
      balQty('WAREHOUSE', 'm1'));
    check('target = 现值 → 不新增 op_log', opCount() === before, opCount() + '/' + before);
    check('target = 现值 → changed=false', r.data && r.data.changed === false, JSON.stringify(r.data));
  });
});
chain = chain.then(function () {
  // 老 delta 增量口径回归
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', delta: 2 }).then(function (r) {
    check('老口径 delta=+2 → 5+2=7', r.code === 0 && balQty('WAREHOUSE', 'm1') === 7, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 7);
  return call(inventory, { action: 'adjust', itemId: 'm1', delta: -1 }).then(function (r) {
    check('老口径 delta=-1 → 7-1=6', r.code === 0 && balQty('WAREHOUSE', 'm1') === 6, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', delta: 0 }).then(function (r) {
    check('老口径 delta=0 仍然报错（回归不变）', r.code === 2002 && /不能为 0/.test(r.message || ''),
      'code=' + r.code + ' ' + r.message);
    check('老口径 delta=0 不改余额', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase([{ _id: 'm_off', name: '停用菜', unit: '包', isActive: false }]);
  return call(inventory, { action: 'adjust', itemId: 'm_off', target: 3 }).then(function (r) {
    check('停用食材不可覆盖调整（3001）', r.code === 3001, 'code=' + r.code + ' ' + r.message);
  });
});

/* ==========================================================================
 * ④ remove 引用检查：5 条链逐条拦截
 * ========================================================================== */
var DEL_MAT = { _id: 'm_del', name: '牛肉片', unit: '包', isActive: true };
function seedDel(fixtures) {
  seedBase([DEL_MAT]);
  Object.keys(fixtures || {}).forEach(function (coll) { mock.seed(coll, fixtures[coll]); });
}
function stillThere() { return matRows().filter(function (m) { return m._id === 'm_del'; }).length === 1; }

section('④ remove 引用检查（菜品 / 采购 / 领用 / 出品 / 盘点）');
chain = chain.then(function () {
  seedDel({ dish: [{ _id: 'd1', name: '宫保鸡丁', consumeItems: [{ itemId: 'm_del', qty: 1 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('被菜品引用 → 拦截', r.code !== 0, 'code=' + r.code + ' ' + r.message);
    check('拦截文案含食材名', /牛肉片/.test(r.message || ''), r.message);
    check('拦截文案不含 itemId', (r.message || '').indexOf('m_del') < 0, r.message);
    check('被拦后档案仍在', stillThere(), stillThere());
  });
});
chain = chain.then(function () {
  seedDel({ purchase: [{ _id: 'p1', itemId: 'm_del', qty: 5 }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('被采购引用 → 拦截', r.code !== 0 && /采购记录/.test(r.message || ''), r.message);
  });
});
chain = chain.then(function () {
  seedDel({ requisition: [{ _id: 'r1', items: [{ itemId: 'm_del', qty: 2 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('被领用引用 → 拦截', r.code !== 0 && /领用记录/.test(r.message || ''), r.message);
  });
});
chain = chain.then(function () {
  seedDel({ production: [{ _id: 'pr1', consumeItems: [{ itemId: 'm_del', qty: 1 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('被出品引用 → 拦截', r.code !== 0 && /出品记录/.test(r.message || ''), r.message);
  });
});
chain = chain.then(function () {
  seedDel({ stocktake: [{ _id: 'st1', itemId: 'm_del', qty: 3 }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('被盘点引用 → 拦截', r.code !== 0 && /盘点记录/.test(r.message || ''), r.message);
  });
});
chain = chain.then(function () {
  // 多链叠加 + 菜品名最多列 3 个 + 「等」
  seedDel({
    dish: [
      { _id: 'd1', name: '菜A', consumeItems: [{ itemId: 'm_del', qty: 1 }] },
      { _id: 'd2', name: '菜B', consumeItems: [{ itemId: 'm_del', qty: 1 }] },
      { _id: 'd3', name: '菜C', consumeItems: [{ itemId: 'm_del', qty: 1 }] },
      { _id: 'd4', name: '菜D', consumeItems: [{ itemId: 'm_del', qty: 1 }] }
    ],
    purchase: [{ _id: 'p1', itemId: 'm_del', qty: 5 }, { _id: 'p2', itemId: 'm_del', qty: 3 }]
  });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    var msg = r.message || '';
    check('菜品 4 个 · 采购 2 条 合并报错', /4 个菜品引用/.test(msg) && /2 条采购记录/.test(msg), msg);
    check('菜品名最多列 3 个（带「等」）', /等/.test(msg), msg);
    check('合并报错仍不含 itemId', msg.indexOf('m_del') < 0, msg);
  });
});

/* ==========================================================================
 * ⑤ remove 点号匹配不恒真 + 成功删除
 * ========================================================================== */
section('⑤ remove 点号匹配不恒真 · 成功删除');
chain = chain.then(function () {
  // 菜品引用了「别的东西」→ 不该拦 m_del
  seedDel({ dish: [{ _id: 'dx', name: '别的菜', consumeItems: [{ itemId: 'OTHER', qty: 1 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('引用别的 itemId 的菜品 → 不拦（嵌套匹配不恒真）', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('删除成功：档案没了', !stillThere(), stillThere());
  });
});
chain = chain.then(function () {
  seedDel({});
  seedBal('WAREHOUSE', 'm_del', 9);
  seedBal('S1', 'm_del', 2);
  var before = opCount();
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('有库存、无引用 → 可删', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('返回 removedBalances = 2', r.data && r.data.removedBalances === 2, JSON.stringify(r.data));
    check('档案已删除', !stillThere(), stillThere());
    check('stock_balance 全部清掉（总仓）', findBalStore('WAREHOUSE', 'm_del') === 0, findBalStore('WAREHOUSE', 'm_del'));
    check('stock_balance 全部清掉（门店）', findBalStore('S1', 'm_del') === 0, findBalStore('S1', 'm_del'));
    check('op_log +1（action=material.update）',
      opCount() === before + 1 && mock.dump('op_log').some(function (l) { return l.action === 'material.update'; }),
      opCount());
  });
});
chain = chain.then(function () {
  // 仅菜品一个引用 → 删除后菜品保留（只删食材，不动业务单据）
  seedDel({ dish: [{ _id: 'd1', name: '宫保鸡丁', consumeItems: [{ itemId: 'OTHER', qty: 1 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }).then(function (r) {
    check('成功删除不动其他集合', r.code === 0 && mock.dump('dish').length === 1, mock.dump('dish').length);
  });
});

/* ==========================================================================
 * ⑥ remove 参数与权限
 * ========================================================================== */
section('⑥ remove 参数校验 · 权限（shop 一律 1003）');
chain = chain.then(function () {
  seedDel({});
  return call(material, { action: 'remove' }).then(function (r) {
    check('缺 _id → 业务码拦截（非 5001）', r.code !== 0 && r.code !== 5001, 'code=' + r.code + ' ' + r.message);
  });
});
chain = chain.then(function () {
  seedDel({});
  return call(material, { action: 'remove', _id: '不存在' }).then(function (r) {
    check('不存在档案 → 3001', r.code === 3001, 'code=' + r.code + ' ' + r.message);
  });
});
chain = chain.then(function () {
  seedDel({ dish: [{ _id: 'd1', name: '宫保鸡丁', consumeItems: [{ itemId: 'm_del', qty: 1 }] }] });
  return call(material, { action: 'remove', _id: 'm_del' }, SHOP).then(function (r) {
    check('shop 删食材被拒（1003）', r.code === 1003, 'code=' + r.code + ' ' + r.message);
    check('shop 被拒后档案仍在', stillThere(), stillThere());
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 5);
  return call(inventory, { action: 'adjust', itemId: 'm1', target: 3 }, SHOP).then(function (r) {
    check('shop 覆盖调整被拒（1003）', r.code === 1003, 'code=' + r.code + ' ' + r.message);
    check('shop 被拒后余额不变', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});

/* ==========================================================================
 * ⑦ inventory.list 展示精度 = 3 位（这是商品页「编辑」数量框的回填源）
 *    2 位截断会把真实 0.333 显示成 0.33 → 老板不动直接保存 → 总仓静默缩成 0.33
 * ========================================================================== */
section('⑦ inventory.list 展示精度 3 位（回填源不许 2 位截断）');
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.333);
  return call(inventory, {}).then(function (r) {
    check('list 成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    var row = (r.data.rows || []).filter(function (x) { return x.itemId === 'm1'; })[0];
    check('余额 0.333 → list 传出 0.333（不是 0.33）', !!row && row.qty === 0.333,
      row && JSON.stringify(row.qty));
    check('显式否定 0.33（锁死 2 位截断不复发）', !!row && row.qty !== 0.33, row && String(row.qty));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 2.5);
  return call(inventory, {}).then(function (r) {
    var row = (r.data.rows || []).filter(function (x) { return x.itemId === 'm1'; })[0];
    check('非残渣余额原样传出（2.5 不被破坏）', !!row && row.qty === 2.5, row && String(row.qty));
  });
});
chain = chain.then(function () {
  seedBase();
  return call(inventory, {}).then(function (r) {
    var row = (r.data.rows || []).filter(function (x) { return x.itemId === 'm1'; })[0];
    check('无余额文档时传出 0（不是 undefined/NaN）', !!row && row.qty === 0, row && String(row.qty));
  });
});

/* ---------- 收尾 ---------- */
chain = chain.catch(function (e) {
  fail++;
  console.log('  \u2717 [UNCAUGHT] ' + (e && e.stack ? e.stack : e));
}).then(function () {
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'MATERIAL-DELETE-STOCK-EDIT RESULT: ALL GREEN' : 'MATERIAL-DELETE-STOCK-EDIT RESULT: RED');
  try { rmrf(WORK); } catch (e) { /* ignore */ }
  process.exitCode = fail === 0 ? 0 : 1;
});
