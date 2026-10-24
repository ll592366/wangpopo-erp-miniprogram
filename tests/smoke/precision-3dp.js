// ==========================================================================
// tests/smoke/precision-3dp.js — 「3 位小数体系」只改了一半专项（2026-10-08）
//
// 背景：老板 2026-09-19 拍板全系统库存 3 位小数（0.001 包）。db.js 的 quantizeStock
// 与余额写入早已 3 位，但**入参归一化 / 盘点差异 / 导出 / 报表**这些链路中间环节
// 仍在按 2 位截断（Math.round(x*100)/100），会在链路中途把 3 位值砍成 2 位。
// W3 只修了 inventory.list（回填源）一处，整条链路并没通。
//
// 本套逐处验「0.333 走完整链路后仍是 0.333」，每处至少一条断言：
//   ① 静态守卫：live 云函数代码里不得再出现 2 位截断（归档目录不管）
//   ② material.num / ③ purchase.num / ④ requisition.num  入参归一化
//   ⑤ stocktake num + diff + delta（最严重：盘点算错库存）
//   ⑥ export.r2（CSV 数量列）/ ⑦ report.r2（报表数值）
//   ⑧ inventory.adjust 增量式分支
//   ⑨ requisition.confirm 总仓足量预检（自查发现的第 9 处，会「误拒」合法申请）
//
// 另含**反向自证**（D 段）：把守卫函数喂「注入 2 位截断」的变异体必须报出缺陷，
// 证明本套不是恒真断言。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-prec3-' + process.pid);
var FUNCS = ['material', 'purchase', 'requisition', 'stocktake', 'inventory', 'export', 'report'];

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

function seedBase() {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '王婆婆·管理', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: 'A店员', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  mock.seed('store', [{ _id: 'S1', code: 'S1C', name: 'A店', status: 'open', isActive: true }]);
  mock.seed('material', [{ _id: 'm1', name: '牛肉片', unit: '包', isActive: true, lowStockThreshold: null }]);
  mock.seed('dish', [{ _id: 'd1', name: '金汤牛肉', isActive: true, consumeItems: [{ itemId: 'm1', qty: 0.333, portions: 1 }] }]);
}
function call(fn, ev, who) { return F[fn].main(Object.assign({}, who || MGR, ev)); }
function seedBal(storeId, itemId, qty) {
  mock.seed('stock_balance', [{ _id: 'bal_' + storeId + '_' + itemId, storeId: storeId, itemId: itemId, qty: qty, dayOpenDate: null }]);
}
function balQty(storeId, itemId) {
  var r = mock.dump('stock_balance').filter(function (b) { return b.storeId === storeId && b.itemId === itemId; })[0];
  return r ? r.qty : null;
}

/* ==========================================================================
 * A. 静态守卫：live 云函数代码里不得再有 2 位截断
 * ========================================================================== */
/**
 * 检出 `Math.round(… * 100) / 100` 这类 2 位截断 → 返回 [{line, text}]
 * ⚠️ 反向自证踩过的坑：早先用 /Math\.round\([^)]*\*\s*100\s*\)/ 匹配，
 *   而 `Math.round((actualQty - bal.qty) * 100) / 100` 里 `[^)]*` 跨不过嵌套的 `)`，
 *   于是**真实存在的 2 位截断检不出来**（守卫变假绿）。改用「有界窗口 + 非贪婪」匹配。
 */
function findTruncations(src) {
  var out = [];
  src.split(/\r?\n/).forEach(function (l, i) {
    if (/Math\.round\([\s\S]{0,80}?\*\s*100\s*\)[\s\S]{0,10}?\/\s*100/.test(l)) {
      out.push({ line: i + 1, text: l.trim() });
    }
  });
  return out;
}
section('A. 静态守卫：live 云函数不得再有 2 位截断');
var fnDirs = fs.readdirSync(CF).filter(function (d) {
  if (d.charAt(0) === '_') { return false; }        // _shared / _legacy_… 归档件不管
  try { return fs.statSync(path.join(CF, d)).isDirectory(); } catch (e) { return false; }
});
var allHits = [];
fnDirs.forEach(function (d) {
  var src = fs.readFileSync(path.join(CF, d, 'index.js'), 'utf8');
  findTruncations(src).forEach(function (h) { allHits.push(d + '/index.js:' + h.line + '  ' + h.text); });
});
check('A1 live 云函数 0 处 2 位截断（Math.round(x*100)/100）', allHits.length === 0,
  allHits.length === 0 ? '0 处' : allHits.join(' | '));

/* ==========================================================================
 * B~I 逐处端到端
 * ========================================================================== */
var chain = Promise.resolve();

chain = chain.then(function () {
  section('B. material.num（档案入参归一化）');
  seedBase();
  return call('material', { action: 'save', name: '三味精度', unit: '包', lowStockThreshold: 0.333 }, MGR)
    .then(function (r) {
      check('B1 档案 lowStockThreshold 0.333 原样落库（不是 0.33）',
        r.code === 0 && mock.dump('material').some(function (m) { return m.name === '三味精度' && m.lowStockThreshold === 0.333; }),
        JSON.stringify((mock.dump('material').filter(function (m) { return m.name === '三味精度'; })[0] || {}).lowStockThreshold));
    });
});

chain = chain.then(function () {
  section('C. purchase.num（采购入库数量）');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 0.333 }, MGR).then(function (r) {
    check('C1 采购单 qty = 0.333（不是 0.33）',
      r.code === 0 && r.data && r.data.purchase && r.data.purchase.qty === 0.333,
      r.data && r.data.purchase && String(r.data.purchase.qty));
    check('C2 总仓余额 = 0.333（入库即 3 位）', balQty('WAREHOUSE', 'm1') === 0.333, balQty('WAREHOUSE', 'm1'));
  });
});

chain = chain.then(function () {
  section('D. requisition.num（申请单明细数量）');
  seedBase();
  return call('requisition', { action: 'create', items: [{ itemId: 'm1', qty: 0.333 }] }, SHOP)
    .then(function (r) {
      var it = mock.dump('requisition')[0];
      check('D1 申请明细 qty = 0.333（不是 0.33）',
        r.code === 0 && it && it.items[0].qty === 0.333, it && String(it.items[0].qty));
    });
});

chain = chain.then(function () {
  section('E. stocktake num/diff/delta（最严重：盘点算错库存）');
  seedBase();
  seedBal('S1', 'm1', 0.005);                       // 账面 0.005
  return call('stocktake', { action: 'create', itemId: 'm1', actualQty: 0.333 }, SHOP).then(function (r) {
    var st = r.data && r.data.stocktake;
    check('E1 实盘 actualQty = 0.333（不是 0.33）', st && st.actualQty === 0.333, st && String(st.actualQty));
    check('E2 差异 diff = 0.328（0.333−0.005，不能被截成 0.33）', st && st.diff === 0.328, st && String(st.diff));
    check('E3 diffType = over（盈余）', st && st.diffType === 'over', st && String(st.diffType));
    check('E4 覆盖后余额正好 0.333（不是 0.335）', balQty('S1', 'm1') === 0.333, balQty('S1', 'm1'));
  });
});
chain = chain.then(function () {
  // 反向：真不足时必须拦住（不能因为放宽精度而误放行）
  seedBase();
  seedBal('S1', 'm1', 0.332);
  return call('stocktake', { action: 'create', itemId: 'm1', actualQty: 0.5 }, SHOP).then(function (r) {
    check('E5 反向：账面 0.332 实盘 0.5 → 覆盖后余额正好 0.5（0.168 不被截成 0.17）',
      r.code === 0 && balQty('S1', 'm1') === 0.5, balQty('S1', 'm1'));
  });
});

chain = chain.then(function () {
  section('F. export.r2（CSV「数量」列）');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 0.333 }, MGR).then(function (p) {
    var bd = p.data.purchase.bizDate;
    return call('export', { from: bd, to: bd }, MGR).then(function (r) {
      var rows = r.data && r.data.rows;
      var qtyCell = rows && rows[0] && rows[0][7];   // 第 8 列 = 数量
      check('F1 导出「数量」列 = 0.333（不是 0.33）', qtyCell === 0.333, String(qtyCell));
      check('F2 CSV 文本里找得到 0.333', JSON.stringify(rows).indexOf('0.333') >= 0, String(qtyCell));
    });
  });
});

chain = chain.then(function () {
  section('G. report.r2（报表数值）');
  seedBase();
  var today = '2026-10-08';
  // 两条出品各消耗 0.333 / 0.334 → 3 位口径合计 0.667；2 位口径会算成 0.66
  mock.seed('production', [
    { _id: 'pr1', storeId: 'S1', dishId: 'd1', qty: 1, status: 'confirmed', bizDate: today, createdAt: today + 'T10:00:00+08:00', consumeItems: [{ itemId: 'm1', qty: 0.333 }] },
    { _id: 'pr2', storeId: 'S1', dishId: 'd1', qty: 1, status: 'confirmed', bizDate: today, createdAt: today + 'T10:01:00+08:00', consumeItems: [{ itemId: 'm1', qty: 0.334 }] }
  ]);
  return call('report', { type: 'business', from: today, to: today }, MGR).then(function (r) {
    var row = r.data && r.data.rows && r.data.rows[0];
    check('G1 报表消耗合计 = 0.667（2 位会算成 0.66）',
      row && row.consumeQty && row.consumeQty.m1 === 0.667, row && JSON.stringify(row.consumeQty));
  });
});

chain = chain.then(function () {
  section('H. inventory.adjust 增量式分支（老口径 delta）');
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0);
  return call('inventory', { action: 'adjust', itemId: 'm1', delta: 0.333 }, MGR).then(function (r) {
    check('H1 增量 delta=0.333 → 余额 0.333（不是 0.33）',
      r.code === 0 && balQty('WAREHOUSE', 'm1') === 0.333, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.667);
  return call('inventory', { action: 'adjust', itemId: 'm1', delta: -0.333 }, MGR).then(function (r) {
    check('H2 增量 delta=-0.333 → 余额 0.334（不被截成 0.34）',
      r.code === 0 && balQty('WAREHOUSE', 'm1') === 0.334, balQty('WAREHOUSE', 'm1'));
  });
});

chain = chain.then(function () {
  section('I. requisition.confirm 总仓足量预检（自查发现的第 9 处）');
  // 账面 0.334、申请 0.333：2 位口径下 round2(0.334)=0.33 < 0.333 → 误拒「库存不足」
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.334);
  return call('requisition', { action: 'create', items: [{ itemId: 'm1', qty: 0.333 }] }, SHOP)
    .then(function (c) {
      var id = c.data && c.data.requisition && c.data.requisition._id;
      return call('requisition', { action: 'confirm', requisitionId: id }, MGR);
    }).then(function (r) {
      var st = mock.dump('requisition')[0].status;
      check('I1 账面 0.334 / 申请 0.333 → 确认成功（2 位口径会误拒）', r.code === 0 && st === 'confirmed',
        'code=' + r.code + ' status=' + st);
      check('I2 总仓扣减后 = 0（残渣吸附），门店到账 0.333',
        balQty('WAREHOUSE', 'm1') === 0 && balQty('S1', 'm1') === 0.333,
        'WH=' + balQty('WAREHOUSE', 'm1') + ' S1=' + balQty('S1', 'm1'));
    });
});
chain = chain.then(function () {
  // 反向：真不足仍必须拦（不能因放宽精度而误放行）
  seedBase();
  seedBal('WAREHOUSE', 'm1', 0.2);
  return call('requisition', { action: 'create', items: [{ itemId: 'm1', qty: 0.333 }] }, SHOP)
    .then(function (c) {
      var id = c.data && c.data.requisition && c.data.requisition._id;
      return call('requisition', { action: 'confirm', requisitionId: id }, MGR);
    }).then(function (r) {
      check('I3 反向：账面 0.2 / 申请 0.333 → 仍拦（2001 库存不足）', r.code === 2001, 'code=' + r.code);
      check('I4 真不足时余额不动（0.2）', balQty('WAREHOUSE', 'm1') === 0.2, balQty('WAREHOUSE', 'm1'));
    });
});

/* ==========================================================================
 * J. 反向自证：守卫函数对「注入 2 位截断」必须有判别力
 * ========================================================================== */
chain = chain.then(function () {
  section('J. 反向自证（守卫不是恒真）');
  var clean = 'function num(v){ return dbh.quantizeStock(v); }';
  var dirty = 'function num(v){ var n=Number(v); return isNaN(n)?0:Math.round(n * 100) / 100; }';
  var dirtyNested = 'var delta = Math.round((actualQty - bal.qty) * 100) / 100;';
  check('J1 干净源码 → 0 处截断', findTruncations(clean).length === 0, findTruncations(clean).length + ' 处');
  var hits = findTruncations(dirty);
  check('J2 注入 2 位截断的变异体 → 必须被检出', hits.length === 1, hits.length + ' 处');
  check('J3 检出位置带行号', hits.length === 1 && hits[0].line === 1, hits.length ? '第' + hits[0].line + '行' : '');
  var nh = findTruncations(dirtyNested);
  check('J4 嵌套括号的写法也必须被检出（曾因此漏检 → 守卫假绿）', nh.length === 1, nh.length + ' 处');
});

/* ---------- 收尾 ---------- */
chain = chain.catch(function (e) {
  fail++;
  console.log('  \u2717 [UNCAUGHT] ' + (e && e.stack ? e.stack : e));
}).then(function () {
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'PRECISION-3DP RESULT: ALL GREEN' : 'PRECISION-3DP RESULT: RED');
  try { rmrf(WORK); } catch (e) { /* ignore */ }
  process.exitCode = fail === 0 ? 0 : 1;
});