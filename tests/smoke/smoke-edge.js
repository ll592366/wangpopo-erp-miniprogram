/* ==========================================================================
 * tests/smoke/smoke-edge.js — QA 追加的边界用例（不修改 smoke.js / mock-sdk.js）
 * 覆盖：闭店拦截 / 跨日撤回 / 库存不足回滚 / 停用食材 / 重名 3002 / 无配方出品 / 审计日志
 * 另含一项"桩件失真探针"：证明 mock 的 rollback 是空操作（效力边界用）
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CF = path.join(ROOT, 'cloudfunctions');
const MOCK = path.join(__dirname, 'mock-sdk.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-edge-'));

const FNS = ['login', 'register', 'material', 'dish', 'purchase', 'requisition',
  'production', 'stocktake', 'inventory', 'opLog', 'store', 'report', 'export'];

FNS.forEach(function (fn) {
  const src = path.join(CF, fn);
  const dst = path.join(TMP, fn);
  fs.cpSync(src, dst, { recursive: true });
  const nm = path.join(dst, 'node_modules', 'wx-server-sdk');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'),
    'module.exports = require(' + JSON.stringify(MOCK) + ');\n');
});

const mock = require(MOCK);
const dbm = mock.database();
const M = mock.__mock;
function fn(name) { return require(path.join(TMP, name, 'index.js')).main; }
function dump(c) { return M.dump(c); }
function bal(storeId, itemId) {
  const r = dump('stock_balance').filter(b => b.storeId === storeId && b.itemId === itemId)[0];
  return r ? Number(r.qty) : null;
}

let pass = 0, fail = 0;
const fails = [];
function ck(label, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '  ->  ' + extra : '')); }
  else { fail++; fails.push(label + ' :: ' + extra); console.log('FAIL  ' + label + '  ->  ' + extra); }
}
/** 不是 5001 即视为"走的是业务分支而不是崩了" */
function biz(r) { return r && r.code !== 0 && r.code !== 5001; }

(async function () {
  console.log('================ QA 边界补充用例 ================');

  /* ---------- 种子 ---------- */
  M.reset();
  M.seed('store', [
    { _id: 'S1', code: 'S1C', name: 'A店', status: 'open', isActive: true },
    { _id: 'S2', code: 'S2C', name: 'B店(已闭店)', status: 'closed', isActive: true },
    { _id: 'WAREHOUSE', code: 'WH', name: '总仓', status: 'open', isActive: true }
  ]);
  M.seed('user', [
    { _id: 'u_mgr', role: 'manager', storeId: '', name: '管理端', isActive: true, passwordChanged: true },
    { _id: 'u_shop', role: 'shop', storeId: 'S1', name: 'A店员', isActive: true, passwordChanged: true },
    { _id: 'u_closed', role: 'shop', storeId: 'S2', name: 'B店员', isActive: true, passwordChanged: true }
  ]);
  M.seed('material', [
    { _id: 'mat_beef', name: '牛肉', unit: 'jin', isActive: true, lowStockThreshold: 5 },
    { _id: 'mat_shrimp', name: '虾仁', unit: 'jin', isActive: false }
  ]);
  M.seed('dish', [
    { _id: 'dish_a', name: '牛肉火锅', isActive: true, consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }] },
    { _id: 'dish_nobom', name: '无配方菜', isActive: true, consumeItems: [] }
  ]);
  M.seed('stock_balance', [
    { _id: 'bal_WAREHOUSE_mat_beef', storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_mat_beef', storeId: 'S1', itemId: 'mat_beef', qty: 10, dayOpenQty: 10, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);

  /* ---------- 1. 闭店拦截 ---------- */
  const r1a = await fn('requisition')({ action: 'create', storeId: 'S2', items: [{ itemId: 'mat_beef', qty: 1 }], _uid: 'u_closed' });
  ck('1a 闭店门店提交申请被拦', biz(r1a) && r1a.code === 1001, '[' + r1a.code + '] ' + r1a.message);
  const r1b = await fn('production')({ action: 'create', storeId: 'S2', dishId: 'dish_a', qty: 1, _uid: 'u_closed' });
  ck('1b 闭店门店出品被拦', biz(r1b) && r1b.code === 1001, '[' + r1b.code + '] ' + r1b.message);
  const r1c = await fn('stocktake')({ action: 'create', storeId: 'S2', itemId: 'mat_beef', actualQty: 1, _uid: 'u_closed' });
  ck('1c 闭店门店实点被拦', biz(r1c) && r1c.code === 1001, '[' + r1c.code + '] ' + r1c.message);

  /* ---------- 2. 跨日撤回出品 ---------- */
  M.seed('production', [{
    _id: 'prod_yesterday', storeId: 'S1', dishId: 'dish_a', qty: 1,
    consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }], status: 'confirmed',
    operatorId: 'u_shop', bizDate: '2020-01-01', createdAt: '2020-01-01T12:00:00+08:00'
  }]);
  // 身份用 u_mgr：production 自 v1.0.3（老板 2026-09-15 拍板）起为管理端专属，
  // auth.js actionToRequiredRoles 对 PRODUCTION_* 只放 MANAGER；用 shop 身份会先被
  // 1003 NO_ROLE 拦掉，根本走不到"跨日"判定（那是假红，不是业务缺陷）。
  const r2 = await fn('production')({ action: 'reverse', productionId: 'prod_yesterday', _uid: 'u_mgr' });
  ck('2 跨日撤回被拦（1002）', biz(r2) && r2.code === 1002, '[' + r2.code + '] ' + r2.message);

  /* ---------- 3. 库存不足 → 整体回滚（含效力说明） ---------- */
  const reqRes = await fn('requisition')({ action: 'create', storeId: 'S1', items: [{ itemId: 'mat_beef', qty: 2 }], _uid: 'u_shop' });
  ck('3-0 门店提交申请成功（前置）', reqRes.code === 0, '[' + reqRes.code + '] ' + reqRes.message);
  const reqId = reqRes.data && reqRes.data.requisition && reqRes.data.requisition._id;
  const wh0 = bal('WAREHOUSE', 'mat_beef'), st0 = bal('S1', 'mat_beef');
  const r3 = await fn('requisition')({ action: 'confirm', requisitionId: reqId, _uid: 'u_mgr' });
  ck('3a 总仓足量确认成功', r3.code === 0, '[' + r3.code + '] ' + r3.message);
  ck('3b 确认后总仓 −2 / 门店 +2', bal('WAREHOUSE', 'mat_beef') === wh0 - 2 && bal('S1', 'mat_beef') === st0 + 2,
    '总仓 ' + wh0 + '→' + bal('WAREHOUSE', 'mat_beef') + '；门店 ' + st0 + '→' + bal('S1', 'mat_beef'));

  // 构造不足：把总仓余额压到 0（seed 按 _id 覆盖）
  M.seed('stock_balance', [
    { _id: 'bal_WAREHOUSE_mat_beef', storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);
  const reqRes2 = await fn('requisition')({ action: 'create', storeId: 'S1', items: [{ itemId: 'mat_beef', qty: 5 }], _uid: 'u_shop' });
  const reqId2 = reqRes2.data.requisition._id;
  const wh1 = bal('WAREHOUSE', 'mat_beef'), st1 = bal('S1', 'mat_beef');
  const r3c = await fn('requisition')({ action: 'confirm', requisitionId: reqId2, _uid: 'u_mgr' });
  ck('3c 总仓不足确认被拦（2001）', biz(r3c) && r3c.code === 2001, '[' + r3c.code + '] ' + r3c.message);
  ck('3d 不足时总仓/门店余额均未变动（不半扣）',
    bal('WAREHOUSE', 'mat_beef') === wh1 && bal('S1', 'mat_beef') === st1,
    '总仓 ' + wh1 + '→' + bal('WAREHOUSE', 'mat_beef') + '；门店 ' + st1 + '→' + bal('S1', 'mat_beef'));
  ck('3e 单据仍 pending', (dump('requisition').filter(r => r._id === reqId2)[0] || {}).status === 'pending',
    (dump('requisition').filter(r => r._id === reqId2)[0] || {}).status);

  /* ---------- 4. 停用食材拦截 ----------
   * 坑记录：purchase 读的是 event.name（不是 itemName）；传错字段名会命中
   * "请填写食材名称"（L26），把用例变成假绿。这里必须断言"已停用"字样。 */
  const r4 = await fn('purchase')({ action: 'create', name: '虾仁', qty: 1, _uid: 'u_mgr' });
  ck('4 停用食材入库被拦（2002 · 必须命中"已停用"分支）',
    biz(r4) && r4.code === 2002 && /已停用/.test(r4.message || ''),
    '[' + r4.code + '] ' + r4.message);

  /* ---------- 5. 重名 3002 / 无配方出品 ---------- */
  const r5a = await fn('material')({ action: 'save', _id: '', name: '牛肉', unit: 'jin', _uid: 'u_mgr' });
  ck('5a 食材重名新增 → 3002', biz(r5a) && r5a.code === 3002, '[' + r5a.code + '] ' + r5a.message);
  const r5b = await fn('production')({ action: 'create', storeId: 'S1', dishId: 'dish_nobom', qty: 1, _uid: 'u_mgr' });
  ck('5b 未配消耗清单出品被拦（3001）', biz(r5b) && r5b.code === 3001 && /未配置消耗清单/.test(r5b.message || ''),
    '[' + r5b.code + '] ' + r5b.message);

  /* ---------- 6. 审计日志真的写了 ---------- */
  // 注意：opLog 把 event.action 当作"日志动作过滤条件"，不能传 action:'list'，否则恒为 0
  const r6 = await fn('opLog')({ limit: 100, _uid: 'u_mgr' });
  const logs = (r6.data && r6.data.logs) || [];
  console.log('INFO  op_log 实际条数 = ' + dump('op_log').length + '（不受过滤影响）');
  ck('6a opLog 查询成功', r6.code === 0, '[' + r6.code + '] ' + r6.message);
  ck('6b op_log 确有记录（log() 未静默失败）', logs.length > 0, 'list=' + logs.length);
  const acts = Array.from(new Set(logs.map(l => l.action)));
  ck('6c 日志含 requisition.create / confirm',
    acts.indexOf('requisition.create') >= 0 && acts.indexOf('requisition.confirm') >= 0, acts.join(','));

  /* ---------- 7. 桩件失真探针：rollback 是否真回滚 ---------- */
  const t = await dbm.startTransaction();
  await t.collection('probe').doc('p1').set({ data: { v: 1 } });
  await t.rollback();
  const afterRb = await dbm.collection('probe').doc('p1').get();
  const rollbackIsNoop = !!(afterRb.data);
  console.log('INFO  桩件探针：事务 rollback 后数据仍在 = ' + rollbackIsNoop +
    '（true 表示 mock 的 rollback 是空操作，真实云开发会真回滚）');

  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  if (fails.length) { fails.forEach(f => console.log('  ✗ ' + f)); }
  console.log('EDGE RESULT: ' + (fail === 0 ? 'ALL GREEN' : 'HAS FAILURE'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('HARNESS ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) { /* ignore */ }
  process.exit(2);
});
