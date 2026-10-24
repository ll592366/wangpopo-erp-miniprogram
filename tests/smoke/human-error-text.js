/* ==========================================================================
 * tests/smoke/human-error-text.js
 * 「所有面向用户的报错文案 = 人能看懂的话」的命门验证。
 *
 * 老板口径（本轮）：「所有的提示，包括超时的提示都要改成人能看得懂的报错……
 *                   不能报出来，不能报那种烂码儿」。
 *
 * 本套用真·云函数（production/requisition/dish/store/stocktake，跑在 mock-sdk 上）
 * 直接打 exports.main，断言用户最终看到的 message：
 *   A4  未预期异常 → 固定人话「系统繁忙，请稍后重试」，原始异常串**绝不外泄**（只进日志）
 *   A1  库存不足 → 「总仓/本店「食材名」库存不足：需 X 单位，现有 Y 单位」，不含内部 itemId
 *   A2  缺内部 _id → 用户向中文（不含 "_id" 字样）
 *   A3  未知 action → 「操作不支持，请更新到最新版本」，原始 action 串不外泄
 *   A6  缺食材 → 「请先选择食材」
 *   A5  REASON_LABEL 全中文（无英文枚举泄漏）
 *   C   ACTION_LABEL 覆盖全部 16 个日志 action，且键为小写点分（无 ALL-CAPS 遗留）
 *   B1  cloud.js 返回格式异常 → 「服务器返回异常，请稍后重试」
 *   B2  全前端无 [code] 前缀残留
 *   B3  consume-records 中断文案为人话（无「拉取中断 / 拉取失败」）
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CF = path.join(ROOT, 'cloudfunctions');
const MOCK = path.join(__dirname, 'mock-sdk.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-human-'));

/* ---------- 计数 ---------- */
let pass = 0, fail = 0;
function ck(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ---------- 装载一个云函数（扁平拷贝 + mock node_modules） ---------- */
function installFn(name) {
  const dst = path.join(TMP, name);
  fs.cpSync(path.join(CF, name), dst, { recursive: true });
  const nm = path.join(dst, 'node_modules', 'wx-server-sdk');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'),
    'module.exports = require(' + JSON.stringify(MOCK) + ');\n');
  return require(path.join(dst, 'index.js')).main;
}

const mock = require(MOCK);
const M = mock.__mock;

const production = installFn('production');
const requisition = installFn('requisition');
const dish = installFn('dish');
const store = installFn('store');
const stocktake = installFn('stocktake');

/* 规范源：_shared（与 14 个扁平副本逐字节一致，已由 sha256 矩阵证明） */
const response = require(path.join(CF, '_shared', 'response.js'));
const sharedC = require(path.join(CF, '_shared', 'constants.js'));
const miniC = require(path.join(ROOT, 'miniprogram', 'utils', 'constants.js'));

/* ---------- 假 wx / getApp（给 cloud.js 用；不影响云函数） ---------- */
global.getApp = function () { return { globalData: { user: { _id: 'u_test' } } }; };
global.wx = {
  cloud: { callFunction: function () { return Promise.resolve({ result: { data: { x: 1 } } }); } },
  showToast: function () {}
};
const cloudUtil = require(path.join(ROOT, 'miniprogram', 'utils', 'cloud.js'));

/* ---------- 公共种子 ---------- */
function seedBase() {
  M.reset();
  M.seed('store', [{ _id: 'S1', code: 'S1C', name: 'A店', status: 'open', isActive: true }]);
  M.seed('user', [
    { _id: 'u_mgr', role: 'manager', storeId: '', name: '管理端', isActive: true },
    { _id: 'u_shop', role: 'shop', storeId: 'S1', name: 'A店员', isActive: true }
  ]);
  M.seed('material', [{ _id: 'mat_beef', name: '牛肉', unit: '斤', isActive: true }]);
  M.seed('dish', [{ _id: 'd_cai', name: '金汤牛肉', isActive: true, consumeItems: [{ itemId: 'mat_beef', qty: 1 }] }]);
}

/* ---------- 串行执行器 ---------- */
let chain = Promise.resolve();
function step(fn) { chain = chain.then(fn); }

/* ======================= A4 · 未预期异常兜底 ======================= */
step(function () {
  section('A4. 未预期异常 → 固定人话，原始异常不外泄');
  const w = response.wrap(function () { throw new Error('boom_XYZ_internal_42'); });
  return w({}).then(function (res) {
    ck('code===5001', res.code === 5001, 'code=' + res.code);
    ck('message===「系统繁忙，请稍后重试」', res.message === '系统繁忙，请稍后重试', res.message);
    ck('message 不含异常原文（boom_XYZ）', String(res.message).indexOf('boom_XYZ') < 0);
  });
});

step(function () {
  section('A4b. BizError 分支未被动过（业务码/自定义文案原样透出）');
  const w = response.wrap(function () { throw new response.BizError(2001, '库存不足：手写文案'); });
  return w({}).then(function (res) {
    ck('code===2001 且文案原样', res.code === 2001 && res.message === '库存不足：手写文案', res.code + '/' + res.message);
  });
});

/* ======================= A1 · 库存不足（带食材名） ======================= */
step(function () {
  section('A1. 申请确认 · 总仓库存不足 → 带食材名，不含 itemId');
  seedBase();
  M.seed('requisition', [{
    _id: 'R1', storeId: 'S1', applicantId: 'u_shop',
    items: [{ itemId: 'mat_beef', qty: 5 }], status: 'pending',
    createdAt: '2026-09-19T10:00:00+08:00', bizDate: '2026-09-19',
    handledBy: '', handledAt: '', rejectReason: ''
  }]);
  M.seed('stock_balance', [{ _id: 'bal_WAREHOUSE_mat_beef', storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 1, dayOpenDate: null }]);
  return requisition({ action: 'confirm', requisitionId: 'R1', _uid: 'u_mgr' }).then(function (res) {
    ck('code===2001', res.code === 2001, 'code=' + res.code);
    ck('含「总仓「牛肉」库存不足」', String(res.message).indexOf('总仓「牛肉」库存不足') >= 0, res.message);
    ck('含「需 5 斤，现有 1 斤」', String(res.message).indexOf('需 5 斤，现有 1 斤') >= 0, res.message);
    ck('不含内部 itemId（mat_beef）', String(res.message).indexOf('mat_beef') < 0);
  });
});

step(function () {
  section('A1. 出品扣减 · 本店库存不足 → 带食材名，不含 itemId');
  seedBase();
  M.seed('stock_balance', [{ _id: 'bal_S1_mat_beef', storeId: 'S1', itemId: 'mat_beef', qty: 0, dayOpenDate: null }]);
  return production({ action: 'create', storeId: 'S1', dishId: 'd_cai', qty: 1, _uid: 'u_mgr' }).then(function (res) {
    ck('code===2001', res.code === 2001, 'code=' + res.code);
    ck('含「本店「牛肉」库存不足」', String(res.message).indexOf('本店「牛肉」库存不足') >= 0, res.message);
    ck('不含内部 itemId（mat_beef）', String(res.message).indexOf('mat_beef') < 0);
  });
});

/* ======================= A2 · 缺内部 _id → 用户向中文 ======================= */
step(function () {
  section('A2. 缺菜品 _id → 用户向中文（不含 "_id"）');
  seedBase();
  return dish({ action: 'toggle', _uid: 'u_mgr' }).then(function (res) {
    ck('message===「菜品信息缺失，请刷新后重试」', res.message === '菜品信息缺失，请刷新后重试', res.message);
    ck('message 不含 "_id"', String(res.message).indexOf('_id') < 0);
  });
});

step(function () {
  section('A2. 缺门店 _id → 用户向中文（不含 "_id"）');
  seedBase();
  return store({ action: 'rename', _uid: 'u_mgr' }).then(function (res) {
    ck('message===「门店信息缺失，请重新登录」', res.message === '门店信息缺失，请重新登录', res.message);
    ck('message 不含 "_id"', String(res.message).indexOf('_id') < 0);
  });
});

/* ======================= A3 · 未知 action ======================= */
step(function () {
  section('A3. 未知 action → 人话，原始 action 串不外泄');
  seedBase();
  return dish({ action: 'frobnicate_999', _uid: 'u_mgr' }).then(function (res) {
    ck('message===「操作不支持，请更新到最新版本」', res.message === '操作不支持，请更新到最新版本', res.message);
    ck('message 不含原始 action 串', String(res.message).indexOf('frobnicate_999') < 0);
  });
});

/* ======================= A6 · 缺食材 ======================= */
step(function () {
  section('A6. 实点理论 · 缺食材 → 「请先选择食材」');
  seedBase();
  return stocktake({ action: 'theory', storeId: 'S1', itemId: '', _uid: 'u_shop' }).then(function (res) {
    ck('message===「请先选择食材」', res.message === '请先选择食材', res.message);
  });
});

/* ======================= A5 · REASON_LABEL 全中文 ======================= */
step(function () {
  section('A5. REASON_LABEL 值全中文（无英文枚举泄漏），键不变');
  const keys = Object.keys(sharedC.REASON_LABEL);
  const vals = keys.map(function (k) { return sharedC.REASON_LABEL[k]; });
  ck('每个值都不含 ASCII 字母', vals.every(function (v) { return !/[A-Za-z]/.test(v); }), vals.join(' | '));
  ck('键集合不变（5 个）', keys.sort().join(',') === 'INACTIVE,NOT_LOGIN,NO_ROLE,STORE_CLOSED,STORE_OUT_OF_SCOPE', keys.join(','));
  const miniVals = Object.keys(miniC.REASON_LABEL).map(function (k) { return miniC.REASON_LABEL[k]; });
  ck('前端副本 REASON_LABEL 同样全中文', miniVals.every(function (v) { return !/[A-Za-z]/.test(v); }), miniVals.join(' | '));
});

/* ======================= C · ACTION_LABEL 覆盖 ======================= */
step(function () {
  section('C. 日志中文标签 ACTION_LABEL 全覆盖 + 键名规范');
  const logged = [
    'material.update', 'store.register', 'store.rename', 'store.toggle',
    'store.resetAllPassword', 'user.resetPassword', 'production.create', 'production.reverse',
    'purchase.create', 'stocktake.create', 'dish.update', 'inventory.adjust',
    'requisition.create', 'requisition.confirm', 'requisition.reject', 'requisition.cancel'
  ];
  const missing = logged.filter(function (a) { return !miniC.ACTION_LABEL[a]; });
  ck('16 个日志 action 全部有中文标签', missing.length === 0, '缺失=' + JSON.stringify(missing));
  // 旧 bug 是 ALL_CAPS 蛇形键（如 MATERIAL_UPDATE）；合法的点分驼峰键（user.resetPassword）不算
  const upper = Object.keys(miniC.ACTION_LABEL).filter(function (k) { return /^[A-Z_]+$/.test(k); });
  ck('标签表键无 ALL-CAPS 遗留（与写入端一致）', upper.length === 0, 'ALL-CAPS 键=' + JSON.stringify(upper));
});

/* ======================= B1 · cloud.js 格式异常 ======================= */
step(function () {
  section('B1. cloud.js 返回格式异常 → 「服务器返回异常，请稍后重试」');
  return cloudUtil.call('material', { action: 'list' }).then(function (res) {
    ck('code===5001 且 message 为人话', res.code === 5001 && res.message === '服务器返回异常，请稍后重试', res.code + '/' + res.message);
  });
});

/* ======================= B2 · 全前端无 [code] 前缀 ======================= */
step(function () {
  section('B2. 全前端无 [code] 前缀残留');
  const banned = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); return; }
      if (!/\.js$/.test(e.name)) { return; }
      const t = fs.readFileSync(p, 'utf8');
      if (t.indexOf("'[' + res.code") >= 0 ||
        t.indexOf("'[' + ((res && res.code)") >= 0 ||
        t.indexOf("('[' + res.code + ']')") >= 0) {
        banned.push(path.relative(ROOT, p));
      }
    });
  })(path.join(ROOT, 'miniprogram'));
  ck('无任何 "' + '[' + '" + code 拼接', banned.length === 0, banned.join(', '));
});

/* ======================= B3 · consume-records 中断文案 ======================= */
step(function () {
  section('B3. consume-records 中断/失败文案为人话');
  const src = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'consume-records.js'), 'utf8');
  ck('已无「拉取中断」字样', src.indexOf('拉取中断') < 0);
  ck('已无「拉取失败」字样', src.indexOf('拉取失败') < 0);
  ck('中断文案为「数据加载中断，请重试」', src.indexOf('数据加载中断，请重试') >= 0);
});

/* ======================= 收尾 ======================= */
chain.then(function () {
  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'HUMAN-ERROR RESULT: ALL GREEN' : 'HUMAN-ERROR RESULT: HAS FAILURE');
  process.exitCode = fail === 0 ? 0 : 1;
}, function (e) {
  console.log('  EXCEPTION ' + (e && e.stack || e));
  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail + 1) + ' 条：通过 ' + pass + '，失败 ' + (fail + 1));
  console.log('HUMAN-ERROR RESULT: HAS FAILURE');
  process.exitCode = 1;
});
