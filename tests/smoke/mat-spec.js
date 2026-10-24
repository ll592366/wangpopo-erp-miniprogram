// ==========================================================================
// tests/smoke/mat-spec.js — 「档案录入 / 采购只选」专项测试
//
// 老板口径：
//   · 食材档案（商品管理）是唯一录入入口：名称 / 规格 / 单位 / 预警值
//   · 采购入库一律下拉选择，只填数量；不再现场建档
// 本套验证：
//   ① material.save 支持并持久化 spec；list 能带回 spec
//   ② purchase 传 itemId 直接入库（不新建档案、余额正确）
//   ③ itemId 指向停用档案 → 业务码拦截（2001/2002，不是 5001）
//   ④ itemId 指向不存在的档案 → 3001/业务码，且不凭空建档
//   ⑤ 兼容老调用：传 name 仍能一站式建档入库
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-matspec-' + process.pid);
var FUNCS = ['material', 'purchase', 'inventory', 'login'];

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
var purchase = require(path.join(WORK, 'purchase', 'index.js'));
var inventory = require(path.join(WORK, 'inventory', 'index.js'));

var MGR = { _uid: 'user_manager' };
var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function seedBase() {
  mock.reset();
  mock.seed('user', [{ _id: 'user_manager', name: '王婆婆·管理', username: '888',
    password: 'x', role: 'manager', storeId: null, passwordChanged: true, isActive: true, createdBy: 'system' }]);
}
function call(fn, ev) { return fn.main(Object.assign({}, MGR, ev)); }
function mats() { return mock.dump('material'); }

var chain = Promise.resolve();

/* ---------- ① 规格字段往返 ---------- */
section('① 档案规格 spec 往返');
chain = chain.then(function () {
  seedBase();
  return call(material, { action: 'save', name: '牛肉片', spec: '2.5kg/包', unit: '包', lowStockThreshold: 3 })
    .then(function (r) {
      check('新建档案成功（带规格）', r.code === 0, 'code=' + r.code + ' ' + r.message);
      var m = mats()[0];
      check('spec 已落库', m && m.spec === '2.5kg/包', String(m && m.spec));
      check('单位/预警值也在', m && m.unit === '包' && m.lowStockThreshold === 3);
      return call(material, { action: 'list' });
    }).then(function (r2) {
      var row = (r2.code === 0 ? r2.data.rows : []).filter(function (x) { return x.name === '牛肉片'; })[0];
      check('list 能带回 spec（前端下拉才显示得出来）', row && row.spec === '2.5kg/包', String(row && row.spec));
      // 改规格也要能生效
      return call(material, { action: 'save', _id: row._id, name: '牛肉片', spec: '5kg/箱', unit: '包', lowStockThreshold: 3 });
    }).then(function (r3) {
      check('改规格成功', r3.code === 0, 'code=' + r3.code);
      check('规格已更新', mats()[0].spec === '5kg/箱', mats()[0].spec);
    });
});

/* ---------- ② 按 itemId 入库 ---------- */
section('② 采购按 itemId 入库（不新建档案）');
chain = chain.then(function () {
  seedBase();
  mock.seed('material', [{ _id: 'mat_beef', name: '牛肉片', spec: '2.5kg/包', unit: '包',
    lowStockThreshold: 3, isActive: true, createdAt: '2026-09-12T09:00:00+08:00' }]);
  return call(purchase, { itemId: 'mat_beef', qty: 20, remark: '下拉选择入库' }).then(function (r) {
    check('入库成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('没有新建档案（仍是 1 条）', mats().length === 1, '实际 ' + mats().length);
    check('余额 = 20', r.code === 0 && r.data.balanceAfter.after === 20,
      r.code === 0 ? String(r.data.balanceAfter.after) : '-');
    check('返回里带规格（供前端展示）', r.code === 0 && r.data.material.spec === '2.5kg/包');
    return call(inventory, {});
  }).then(function (inv) {
    var row = (inv.code === 0 ? inv.data.rows : []).filter(function (x) { return x.itemId === 'mat_beef'; })[0];
    check('总仓库存可查到 20', row && row.qty === 20, row ? String(row.qty) : '未查到');
  });
});

/* ---------- ③ 停用档案拦截 ---------- */
section('③ 停用档案不能入库');
chain = chain.then(function () {
  seedBase();
  mock.seed('material', [{ _id: 'mat_off', name: '虾仁', unit: '盒', spec: '500g/盒', isActive: false }]);
  return call(purchase, { itemId: 'mat_off', qty: 5 }).then(function (r) {
    check('被拦且是业务码（非 5001）', r.code !== 0 && r.code !== 5001, 'code=' + r.code + ' ' + r.message);
    check('提示引导去档案启用', /停用|启用/.test(r.message || ''), r.message);
  });
});

/* ---------- ④ itemId 不存在 ---------- */
section('④ 档案不存在：报错且不凭空建档');
chain = chain.then(function () {
  seedBase();
  return call(purchase, { itemId: 'mat_not_exist', qty: 5 }).then(function (r) {
    check('被拦且是业务码（非 5001）', r.code !== 0 && r.code !== 5001, 'code=' + r.code + ' ' + r.message);
    check('提示先去新建档案', /档案|新建/.test(r.message || ''), r.message);
    check('没有凭空建档', mats().length === 0, '实际 ' + mats().length);
  });
});

/* ---------- ⑤ 老调用兼容（name 一站式） ---------- */
section('⑤ 兼容老调用：传 name 仍可一站式建档入库');
chain = chain.then(function () {
  seedBase();
  return call(purchase, { name: '土豆', qty: 30, unit: '斤', spec: '散装' }).then(function (r) {
    check('入库成功', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('当场建档了 1 条', mats().length === 1, '实际 ' + mats().length);
    check('新档案带规格', mats()[0] && mats()[0].spec === '散装', String(mats()[0] && mats()[0].spec));
  });
});

chain.then(function () {
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'MAT-SPEC RESULT: ALL GREEN' : 'MAT-SPEC RESULT: RED');
  rmrf(WORK);
  process.exitCode = fail === 0 ? 0 : 1;
}).catch(function (e) {
  console.error('[HARNESS]', e);
  console.log('MAT-SPEC RESULT: RED (harness crash)');
  rmrf(WORK);
  process.exitCode = 1;
});
