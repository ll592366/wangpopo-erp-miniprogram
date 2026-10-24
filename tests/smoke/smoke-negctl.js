/* ==========================================================================
 * tests/smoke/smoke-negctl.js — 参数化反向对照 + 真·半扣断言（QA 追加）
 *
 * PART B：把「反向对照」从 smoke.js 里写死的 1 处，参数化成 3 个修复点：
 *   NC-1 requisition.create  · found     （L43 提升 / L57 赋值 / L74 读取）
 *   NC-2 requisition.confirm · balances  （L92 提升 / L119 赋值 / L132 读取）
 *   NC-3 production.create   · storeName + deduct（L47-48 / L57,L61 / L97-98）
 *   每个点都跑两个方向：还原旧写法必须变红（5001 + 固定人话；异常原文只进日志，不再外泄），
 *   复原后必须变绿（code 0）。补丁命中数也纳入断言，防止"补丁没打上却显示通过"。
 *
 * PART C：真·半扣 —— 用桩件故障注入让「第 N 次 changeBalance」抛错，
 *   断言抛错后相关余额一个都没动（而不是"第一次根本没写"的伪证明）。
 *
 * 约束：只读 cloudfunctions/，不修改；所有改动落在 tests/smoke/ 下。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withLog } = require('./log-capture');

const ROOT = path.join(__dirname, '..', '..');
const CF = path.join(ROOT, 'cloudfunctions');
const MOCK = path.join(__dirname, 'mock-sdk.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-negctl-'));

const mock = require(MOCK);
const M = mock.__mock;

/* ---------- 目录与加载 ---------- */
function buildDir(fnName, tag) {
  const src = path.join(CF, fnName);
  const dst = path.join(TMP, fnName + '__' + tag);
  if (!fs.existsSync(dst)) { fs.cpSync(src, dst, { recursive: true }); }
  const nm = path.join(dst, 'node_modules', 'wx-server-sdk');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'),
    'module.exports = require(' + JSON.stringify(MOCK) + ');\n');
  return dst;
}
function load(dir) { return require(path.join(dir, 'index.js')).main; }

/**
 * 把「提升声明 + 回调内赋值」还原成「回调内 var 声明」。
 * ① 删掉第一条 `var <name> = ...`（提升声明）
 * ② 把紧接着的第一条 `<name> = ...` 改回 `var <name> = ...`
 * 返回命中计数，供断言使用（补丁没命中 = 用例本身失效）。
 */
function revertHoist(src, varName) {
  const lines = src.split(/\r?\n/);
  const reDecl = new RegExp('^\\s*var\\s+' + varName + '\\s*=');
  const reAssign = new RegExp('^(\\s*)' + varName + '\\s*=');
  const out = [];
  let removed = 0, reVarred = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!removed && reDecl.test(ln)) { removed = 1; continue; }
    if (removed && !reVarred && reAssign.test(ln)) {
      out.push(ln.replace(reAssign, '$1var ' + varName + ' ='));
      reVarred = 1;
      continue;
    }
    out.push(ln);
  }
  return { src: out.join('\n'), removed: removed, reVarred: reVarred };
}

function applyReverts(fnName, tag, vars) {
  const dir = buildDir(fnName, tag);
  const p = path.join(dir, 'index.js');
  let s = fs.readFileSync(p, 'utf8');
  const hits = [];
  for (let i = 0; i < vars.length; i++) {
    const r = revertHoist(s, vars[i]);
    hits.push({ v: vars[i], removed: r.removed, reVarred: r.reVarred });
    s = r.src;
  }
  fs.writeFileSync(p, s);
  return { dir: dir, hits: hits };
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const fails = [];
function ck(label, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '  ->  ' + extra : '')); }
  else { fail++; fails.push(label + ' :: ' + extra); console.log('FAIL  ' + label + '  ->  ' + extra); }
}

/* ---------- 种子 ---------- */
function seedBase() {
  M.reset();
  M.seed('store', [
    { _id: 'S1', code: 'S1C', name: 'A店', status: 'open', isActive: true },
    { _id: 'WAREHOUSE', code: 'WH', name: '总仓', status: 'open', isActive: true }
  ]);
  M.seed('user', [
    { _id: 'u_mgr', role: 'manager', storeId: '', name: '管理端', isActive: true, passwordChanged: true },
    { _id: 'u_shop', role: 'shop', storeId: 'S1', name: 'A店员', isActive: true, passwordChanged: true }
  ]);
  M.seed('material', [
    { _id: 'mat_beef', name: '牛肉', unit: 'jin', isActive: true, lowStockThreshold: 5 },
    { _id: 'mat_potato', name: '土豆', unit: 'jin', isActive: true, lowStockThreshold: 5 }
  ]);
  M.seed('dish', [
    { _id: 'dish_a', name: '牛肉火锅', isActive: true, consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }] }
  ]);
  M.seed('stock_balance', [
    { _id: 'bal_WAREHOUSE_mat_beef', storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_mat_beef', storeId: 'S1', itemId: 'mat_beef', qty: 10, dayOpenQty: 10, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_mat_potato', storeId: 'WAREHOUSE', itemId: 'mat_potato', qty: 50, dayOpenQty: 50, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_mat_potato', storeId: 'S1', itemId: 'mat_potato', qty: 5, dayOpenQty: 5, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
  ]);
}
function bal(storeId, itemId) {
  const r = M.dump('stock_balance').filter(b => b.storeId === storeId && b.itemId === itemId)[0];
  return r ? Number(r.qty) : null;
}
function snap(items) {
  const o = {};
  items.forEach(function (it) {
    o['WH/' + it] = bal('WAREHOUSE', it);
    o['S1/' + it] = bal('S1', it);
  });
  return o;
}
function snapStr(a, b) {
  return Object.keys(a).map(k => k + ' ' + a[k] + '→' + b[k]).join('；');
}
function sameSnap(a, b) {
  return Object.keys(a).every(k => a[k] === b[k]);
}
const GOOD_REQ = buildDir('requisition', 'ref_good');
async function createReq(items) {
  const r = await load(GOOD_REQ)({ action: 'create', storeId: 'S1', items: items, _uid: 'u_shop' });
  if (!r || r.code !== 0) { throw new Error('前置建单失败：' + JSON.stringify(r)); }
  return r.data.requisition._id;
}
function reqStatus(id) {
  const r = M.dump('requisition').filter(x => x._id === id)[0];
  return r ? r.status : '(不存在)';
}

(async function () {
  console.log('================ 参数化反向对照 + 半扣断言 ================');

  /* ================= PART B ================= */
  const SITES = [
    {
      id: 'NC-1', fn: 'requisition', vars: ['found'], expectVar: 'found',
      label: 'requisition.create · found（L43 提升 / L57 赋值 / L74 读取）',
      prep: async function () { return null; },
      event: function () { return { action: 'create', storeId: 'S1', items: [{ itemId: 'mat_beef', qty: 2 }], _uid: 'u_shop' }; }
    },
    {
      id: 'NC-2', fn: 'requisition', vars: ['balances'], expectVar: 'balances',
      label: 'requisition.confirm · balances（L92 提升 / L119 赋值 / L132 读取）',
      prep: async function () { return await createReq([{ itemId: 'mat_beef', qty: 2 }]); },
      event: function (reqId) { return { action: 'confirm', requisitionId: reqId, _uid: 'u_mgr' }; }
    },
    {
      id: 'NC-3', fn: 'production', vars: ['storeName', 'deduct'], expectVar: 'storeName',
      label: 'production.create · storeName+deduct（L47-48 提升 / L57,L61 赋值 / L97-98 读取）',
      prep: async function () { return null; },
      // u_mgr：PRODUCTION_CREATE 为管理端专属（auth.js），用 shop 身份会被 1003 提前拦掉，
      // 导致 NC-3 的正反两向都拿不到 5001/0，探针失效（假红）。
      event: function () { return { action: 'create', storeId: 'S1', dishId: 'dish_a', qty: 1, _uid: 'u_mgr' }; }
    }
  ];

  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    console.log('---- ' + site.id + '  ' + site.label);

    /* --- 方向 1：还原旧写法 → 必须变红 --- */
    seedBase();
    const prepBad = await site.prep();
    const bad = applyReverts(site.fn, site.id + '_bad', site.vars);
    const hitOk = bad.hits.every(h => h.removed === 1 && h.reVarred === 1);
    ck(site.id + '-P 还原补丁命中（每个变量 removed=1 且 reVarred=1）', hitOk,
      bad.hits.map(h => h.v + '(removed=' + h.removed + ',reVarred=' + h.reVarred + ')').join(' '));
    const capBad = await withLog(() => load(bad.dir)(site.event(prepBad)));
    const rBad = capBad.r;
    const needle = site.expectVar + ' is not defined';
    const msgBad = String((rBad && rBad.message) || '');
    console.log('INFO  ' + site.id + ' 兜底日志原文 → ' + (capBad.log.split('\n')[0] || '(空)'));
    ck(site.id + '-RED-a 还原旧写法必须落 5001 桶',
      !!rBad && rBad.code === 5001, '[' + (rBad && rBad.code) + ']');
    ck(site.id + '-RED-b 用户文案为固定人话「系统繁忙，请稍后重试」',
      msgBad === '系统繁忙，请稍后重试', msgBad);
    ck(site.id + '-RED-c 判别力在日志：日志含 "' + needle + '" 且用户文案绝不含',
      capBad.log.indexOf(needle) >= 0 && msgBad.indexOf(needle) < 0,
      '日志命中=' + (capBad.log.indexOf(needle) >= 0) + ' 文案命中=' + (msgBad.indexOf(needle) >= 0));

    /* --- 方向 2：复原 → 必须变绿 --- */
    seedBase();
    const prepGood = await site.prep();
    const goodDir = buildDir(site.fn, site.id + '_good');
    const rGood = await load(goodDir)(site.event(prepGood));
    ck(site.id + '-GREEN 复原后必须变绿（code 0）', !!rGood && rGood.code === 0,
      '[' + (rGood && rGood.code) + '] ' + (rGood && rGood.message));
  }

  /* --- NC-4 归因探针：production 到底哪个变量是致命的 --- */
  console.log('---- NC-4  归因探针：production 两个变量分别回滚');
  seedBase();
  const onlyDeduct = applyReverts('production', 'nc4_only_deduct', ['deduct']);
  const r4a = await load(onlyDeduct.dir)({ action: 'create', storeId: 'S1', dishId: 'dish_a', qty: 1, _uid: 'u_mgr' });
  console.log('INFO  只还原 deduct（不还原 storeName）→ [' + r4a.code + '] ' + r4a.message +
    '（若仍为 0，说明 deduct 与读取点在同一词法作用域内，本就不是致命变量）');
  ck('NC-4a 只还原 deduct → 仍为 code 0（deduct 非致命）', r4a.code === 0, '[' + r4a.code + ']');

  seedBase();
  const onlyStoreName = applyReverts('production', 'nc4_only_storeName', ['storeName']);
  const cap4b = await withLog(() => load(onlyStoreName.dir)({ action: 'create', storeId: 'S1', dishId: 'dish_a', qty: 1, _uid: 'u_mgr' }));
  const r4b = cap4b.r;
  const m4b = String((r4b && r4b.message) || '');
  console.log('INFO  NC-4b 兜底日志原文 → ' + (cap4b.log.split('\n')[0] || '(空)'));
  ck('NC-4b-a 只还原 storeName → 5001 桶', r4b.code === 5001, '[' + r4b.code + ']');
  ck('NC-4b-b 用户文案为固定人话', m4b === '系统繁忙，请稍后重试', m4b);
  ck('NC-4b-c 日志含 "storeName is not defined" 且文案不含',
    cap4b.log.indexOf('storeName is not defined') >= 0 && m4b.indexOf('storeName is not defined') < 0,
    '日志命中=' + (cap4b.log.indexOf('storeName is not defined') >= 0));

  /* ================= PART C：真·半扣 ================= */
  console.log('---- C  真·半扣：注入"第 N 次写入失败"，断言余额全未变动');

  /* C-0 基线：不注入故障，双品确认必须真的改动 4 个余额（证明写入是真的发生过的） */
  seedBase();
  const req0 = await createReq([{ itemId: 'mat_beef', qty: 2 }, { itemId: 'mat_potato', qty: 1 }]);
  const s0 = snap(['mat_beef', 'mat_potato']);
  const rC0 = await load(buildDir('requisition', 'c_good'))({ action: 'confirm', requisitionId: req0, _uid: 'u_mgr' });
  const s0b = snap(['mat_beef', 'mat_potato']);
  ck('C-0 基线：双品确认成功', rC0.code === 0, '[' + rC0.code + '] ' + rC0.message);
  ck('C-0b 基线：4 个余额确实被改动（WH −2/−1，S1 +2/+1）',
    s0b['WH/mat_beef'] === s0['WH/mat_beef'] - 2 && s0b['S1/mat_beef'] === s0['S1/mat_beef'] + 2 &&
    s0b['WH/mat_potato'] === s0['WH/mat_potato'] - 1 && s0b['S1/mat_potato'] === s0['S1/mat_potato'] + 1,
    snapStr(s0, s0b));

  /* C-1 单品：第 1 次（总仓 −）成功 → 第 2 次（门店 +）注入失败 */
  seedBase();
  const req1 = await createReq([{ itemId: 'mat_beef', qty: 2 }]);
  const s1 = snap(['mat_beef']);
  M.failWrite('stock_balance', 'bal_S1_mat_beef');
  const capC1 = await withLog(() => load(buildDir('requisition', 'c_good'))({ action: 'confirm', requisitionId: req1, _uid: 'u_mgr' }));
  const rC1 = capC1.r;
  const s1b = snap(['mat_beef']);
  const msgC1 = String((rC1 && rC1.message) || '');
  const needleC1 = 'MOCK INJECTED FAILURE: 写入 stock_balance/bal_S1_mat_beef';
  console.log('INFO  C-1a 兜底日志原文 → ' + (capC1.log.split('\n')[0] || '(空)'));
  ck('C-1a-a 第 2 次 changeBalance 抛错 → 5001 桶', rC1.code === 5001, '[' + rC1.code + ']');
  ck('C-1a-b 用户文案为固定人话「系统繁忙，请稍后重试」', msgC1 === '系统繁忙，请稍后重试', msgC1);
  ck('C-1a-c 判别力在日志：日志含 needle 且用户文案绝不含',
    capC1.log.indexOf(needleC1) >= 0 && msgC1.indexOf(needleC1) < 0,
    '日志命中=' + (capC1.log.indexOf(needleC1) >= 0) + ' 文案命中=' + (msgC1.indexOf(needleC1) >= 0));
  ck('C-1b 故障注入确实被消费（failRuleCount=0，排除"没注入成功"的假绿）', M.failRuleCount() === 0,
    '剩余规则 ' + M.failRuleCount());
  ck('C-1c 半扣断言：总仓与门店余额均未变动', sameSnap(s1, s1b), snapStr(s1, s1b));
  ck('C-1d 单据仍 pending', reqStatus(req1) === 'pending', reqStatus(req1));

  /* C-2 双品：前两次成功 → 第 3 次注入失败 */
  seedBase();
  const req2 = await createReq([{ itemId: 'mat_beef', qty: 2 }, { itemId: 'mat_potato', qty: 1 }]);
  const s2 = snap(['mat_beef', 'mat_potato']);
  M.failWrite('stock_balance', 'bal_WAREHOUSE_mat_potato');
  const capC2 = await withLog(() => load(buildDir('requisition', 'c_good'))({ action: 'confirm', requisitionId: req2, _uid: 'u_mgr' }));
  const rC2 = capC2.r;
  const s2b = snap(['mat_beef', 'mat_potato']);
  const msgC2 = String((rC2 && rC2.message) || '');
  const needleC2 = 'MOCK INJECTED FAILURE: 写入 stock_balance/bal_WAREHOUSE_mat_potato';
  console.log('INFO  C-2a 兜底日志原文 → ' + (capC2.log.split('\n')[0] || '(空)'));
  ck('C-2a-a 第 3 次 changeBalance 抛错 → 5001 桶', rC2.code === 5001, '[' + rC2.code + ']');
  ck('C-2a-b 用户文案为固定人话「系统繁忙，请稍后重试」', msgC2 === '系统繁忙，请稍后重试', msgC2);
  ck('C-2a-c 判别力在日志：日志含 needle 且用户文案绝不含',
    capC2.log.indexOf(needleC2) >= 0 && msgC2.indexOf(needleC2) < 0,
    '日志命中=' + (capC2.log.indexOf(needleC2) >= 0) + ' 文案命中=' + (msgC2.indexOf(needleC2) >= 0));
  ck('C-2b 故障注入确实被消费', M.failRuleCount() === 0, '剩余规则 ' + M.failRuleCount());
  ck('C-2c 半扣断言：4 个余额全部未变动（前两次已写入也要回滚）', sameSnap(s2, s2b), snapStr(s2, s2b));
  ck('C-2d 单据仍 pending', reqStatus(req2) === 'pending', reqStatus(req2));

  /* C-3 对照组：同样的注入若发生在事务外，不做回滚 —— 证明上面的"未变动"来自事务而非巧合 */
  seedBase();
  const t = await mock.database().startTransaction();
  await t.collection('stock_balance').doc('bal_WAREHOUSE_mat_beef').set({ data: { qty: 999 } });
  const outsideRead = bal('WAREHOUSE', 'mat_beef');
  await t.rollback();
  ck('C-3 事务外读不到未提交数据（staged 不写穿，回滚后恢复）',
    outsideRead === 100 && bal('WAREHOUSE', 'mat_beef') === 100,
    '事务外读=' + outsideRead + '；回滚后=' + bal('WAREHOUSE', 'mat_beef'));
  /* 注意：doc().set() 是整文档覆盖，必须带全字段，否则 bal() 按 storeId/itemId 查不到 */
  const t2 = await mock.database().startTransaction();
  await t2.collection('stock_balance').doc('bal_WAREHOUSE_mat_beef')
    .set({ data: { storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 777, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null } });
  const insideRead = await t2.collection('stock_balance').doc('bal_WAREHOUSE_mat_beef').get();
  /* commit 后跨集合读：换个集合（store）验证 commit 不是只落了一部分 */
  await t2.collection('store').doc('S1').update({ data: { name: 'A店(改)' } });
  await t2.commit();
  const crossStore = M.dump('store').filter(s => s._id === 'S1')[0];
  ck('C-4 同一事务内可读到自己刚写的 + commit 后跨集合可见',
    insideRead.data && insideRead.data.qty === 777 && bal('WAREHOUSE', 'mat_beef') === 777 &&
    crossStore && crossStore.name === 'A店(改)',
    '事务内读=' + (insideRead.data && insideRead.data.qty) + '；commit 后 stock_balance=' +
    bal('WAREHOUSE', 'mat_beef') + '；commit 后 store=' + (crossStore && crossStore.name));

  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  if (fails.length) { fails.forEach(f => console.log('  ✗ ' + f)); }
  console.log('NEGCTL RESULT: ' + (fail === 0 ? 'ALL GREEN' : 'HAS FAILURE'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('HARNESS ERROR', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) { /* ignore */ }
  process.exit(2);
});
