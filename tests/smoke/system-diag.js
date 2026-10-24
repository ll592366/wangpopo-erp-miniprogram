// ==========================================================================
// tests/smoke/system-diag.js — 线上「系统繁忙」可诊断化 + missing-doc 判定加固（2026-10-08）
//
// 线上故障：req_20261007_S02_000004（26 条明细）点确认 → toast「系统繁忙，请稍后重试」。
//   该文案全项目只有一个出处 = response.js wrap() 的非业务异常兜底
//   → 说明函数跑进去了、抛了一个它不认识的异常，而真相只在云函数日志里（前端读不到）。
//
// 两项修复：
//   A. wrap() 把紧凑诊断串挂到**响应顶层 diag**（name + 错误码 + 原文前 200 字），
//      前端 console.error 打印。**用户文案一个字不改**，diag 绝不进 data（保持 data===null）。
//   B. changeBalance「文档不存在」判定从「只认英文 not exist」放宽为多形态匹配
//      （+ 错误码 -502005 + 中文「不存在」），且命中必打可追溯日志；
//      但权限/网络/超时等仍必须原样抛出，不许变成「什么都吞」。
//
// 本套验：
//   ① 桩件文案无关性：桩件抛不含 not exist / NOT_FOUND 的文案时仍走新建
//   ② 反向：该原样抛出的（权限错、其它错误码）绝不被当「不存在」→ 一路冒到 5001
//   ③ diag 链路：message 严格 === '系统繁忙，请稍后重试'、code=5001、data=null、
//      diag 含错误码、message 不含 diag 内容
//   ④ 平铺副本一致性（15 份 response.js / db.js 都必须带上新逻辑，杜绝漏同步）
//   ⑤ 现场复现：requisition confirm「门店侧余额首次创建」这条最可能的真凶路径
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-diag-' + process.pid);
var FUNCS = ['inventory', 'purchase', 'requisition'];

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
  mock.seed('store', [{ _id: 'S1', code: 'S1C', name: '民族店', status: 'open', isActive: true }]);
  mock.seed('material', [{ _id: 'm1', name: '牛肉片', unit: '包', isActive: true, lowStockThreshold: null }]);
}
function call(fn, ev, who) { return F[fn].main(Object.assign({}, who || MGR, ev)); }
function setMsg(text, errCode) { return mock.setMissingDocMessage(text, errCode); }
function balQty(storeId, itemId) {
  var r = mock.dump('stock_balance').filter(function (b) { return b.storeId === storeId && b.itemId === itemId; })[0];
  return r ? r.qty : null;
}

var chain = Promise.resolve();

/* ==========================================================================
 * 0. 桩件默认文案必须保持原样（避免影响既有套件）
 * ========================================================================== */
chain = chain.then(function () {
  section('0. 桩件默认文案保持不变（含 not exist，既有套件不受影响）');
  var d = mock.getMissingDocMessage();
  check('默认文案仍含 not exist', /not\s*exist/i.test(d), d);
});

/* ==========================================================================
 * 1. 桩件文案无关性：不含 not exist / NOT_FOUND 也必须走新建
 * ========================================================================== */
chain = chain.then(function () {
  section('1. 文案无关性：只有错误码可依据时仍走新建');
  setMsg('document.get:fail errCode=-502005', '-502005');   // 英文关键词一个都没有
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('1a 纯错误码 -502005 → 仍按新建处理（不是崩）', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('1b 余额真的建出来了 = 5', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  section('1b. 文案无关性：纯中文「不存在」也走新建');
  setMsg('文档不存在');                                       // 无任何英文关键词、无错误码
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 3 }).then(function (r) {
    check('1c 中文文案 → 仍按新建处理', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('1d 余额 = 3', balQty('WAREHOUSE', 'm1') === 3, balQty('WAREHOUSE', 'm1'));
  });
});

chain = chain.then(function () {
  section('1c. 真实用户上报的文案形态（最关键：不含 not exist/found）');
  // 真实上报原文：document.get:fail cannot find document with _id XXX, please make sure that
  // the document exists and you have the corresponding access permission.
  setMsg('document.get:fail cannot find document with _id {ID}, please make sure that the document exists and you have the corresponding access permission.');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('1e 真实文案「cannot find document」→ 仍按新建处理', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('1f 余额建出来了 = 5', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
  });
});
chain = chain.then(function () {
  section('1d. ResourceNotFound 形态');
  setMsg('doc.get:fail -502005 [ResourceNotFound]', '-502005');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 2 }).then(function (r) {
    check('1g ResourceNotFound → 仍按新建处理', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('1h 余额 = 2', balQty('WAREHOUSE', 'm1') === 2, balQty('WAREHOUSE', 'm1'));
  });
});

/* ==========================================================================
 * 2. 反向：该原样抛出的绝不能被当成「不存在」（不能什么都吞）
 * ========================================================================== */
chain = chain.then(function () {
  section('2. 反向：权限错误必须原样抛出（放宽没变成什么都吞）');
  setMsg('document.get:fail permission denied');              // 无缺失关键词、无错误码
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('2a 权限错 → 不是 0，是 5001', r.code === 5001, 'code=' + r.code);
    check('2b 余额**没有**被静默新建（吞掉就会造出假余额）',
      mock.dump('stock_balance').length === 0, mock.dump('stock_balance').length + ' 条');
  });
});

chain = chain.then(function () {
  section('2b. 权限错误码 -502003 必须原样抛出（官方码表：云资源数据库错误-无权限操作数据库）');
  setMsg('database permission denied, errCode=-502003', '-502003');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('2c -502003 权限错 → 5001（绝不被当缺失）', r.code === 5001, 'code=' + r.code);
    check('2d 余额没有被静默新建', mock.dump('stock_balance').length === 0, mock.dump('stock_balance').length + ' 条');
    check('2e diag 带错误码 -502003（可定位到是权限而非缺文档）',
      String(r.diag).indexOf('-502003') >= 0, String(r.diag));
  });
});
chain = chain.then(function () {
  section('2c. 超时错误码 -502011 必须原样抛出');
  setMsg('database operation timeout, errCode=-502011', '-502011');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('2f -502011 超时 → 5001（绝不被当缺失）', r.code === 5001, 'code=' + r.code);
    check('2g 余额没有被静默新建', mock.dump('stock_balance').length === 0, mock.dump('stock_balance').length + ' 条');
  });
});

/* ==========================================================================
 * 3. diag 链路：真相回到前端控制台，但用户文案一个字不变
 * ========================================================================== */
chain = chain.then(function () {
  section('3. diag 链路（消息严格相等，禁止正则模糊匹配）');
  setMsg('document.get:fail permission denied');
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('3a message 严格 === 「系统繁忙，请稍后重试」',
      r.message === '系统繁忙，请稍后重试', JSON.stringify(r.message));
    check('3b code === 5001', r.code === 5001, String(r.code));
    check('3c data 仍为 null（diag 不得污染 data）', r.data === null, JSON.stringify(r.data));
    check('3d diag 是非空字符串', typeof r.diag === 'string' && r.diag.length > 0, String(r.diag));
    check('3e diag 带「[系统异常]」前缀', String(r.diag).indexOf('[系统异常]') === 0, String(r.diag));
    check('3f diag 含异常原文（可定位）', String(r.diag).indexOf('permission denied') >= 0, String(r.diag));
    check('3g message **不含** diag 内容（不外泄给用户）',
      r.message.indexOf('permission denied') < 0 && r.message.indexOf('diag') < 0, r.message);
  });
});
chain = chain.then(function () {
  section('3b. diag 必须带错误码（比英文文案更稳定的线索）');
  setMsg('document.get:fail errCode=-503003', '-503003');     // 非缺失类错误码 → 应原样抛出
  seedBase();
  return call('purchase', { itemId: 'm1', qty: 5 }).then(function (r) {
    check('3h 其它错误码不被当缺失 → 5001', r.code === 5001, 'code=' + r.code);
    check('3i diag 含错误码 -503003', String(r.diag).indexOf('-503003') >= 0, String(r.diag));
    check('3j diag 含 name=Error', String(r.diag).indexOf('name=Error') >= 0, String(r.diag));
    check('3k message 仍是那句人话', r.message === '系统繁忙，请稍后重试', r.message);
  });
});

/* ==========================================================================
 * 4. 平铺副本一致性（漏同步 = 那个函数照样崩/照样瞎）
 * ========================================================================== */
chain = chain.then(function () {
  section('4. 15 份平铺副本必须都带上新逻辑');
  var dirs = fs.readdirSync(CF).filter(function (d) {
    if (d.charAt(0) === '_') { return d === '_shared'; }
    try { return fs.statSync(path.join(CF, d)).isDirectory(); } catch (e) { return false; }
  });
  // ⚠️ 必须剥掉注释再查：反向自证会把那几行**注释掉**，而朴素 substring 匹配
  //    在注释里照样能搜到 → 守卫变假绿（W2 已踩过同一个坑，这里提前规避）。
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  }
  var respBad = [], dbBad = [];
  dirs.forEach(function (d) {
    var rp = path.join(CF, d, 'response.js');
    var dp = path.join(CF, d, 'db.js');
    if (fs.existsSync(rp) && stripComments(fs.readFileSync(rp, 'utf8')).indexOf('res.diag') < 0) { respBad.push(d); }
    if (fs.existsSync(dp)) {
      var dcode = stripComments(fs.readFileSync(dp, 'utf8'));
      // 用代码里真实存在的标记（注释里也写了 502005，故必须去注释再查，否则形同虚设）
      if (dcode.indexOf('var missing') < 0 || dcode.indexOf('502005') < 0) { dbBad.push(d); }
    }
  });
  check('4a 15 份 response.js 都含 diag 逻辑（0 漏同步 · 已排除注释）', respBad.length === 0,
    respBad.length ? respBad.join(',') : dirs.length + ' 份全覆盖');
  check('4b 15 份 db.js 都含多形态 missing 判定（0 漏同步 · 已排除注释）', dbBad.length === 0,
    dbBad.length ? dbBad.join(',') : dirs.length + ' 份全覆盖');
  check('4c 副本总数 = 15', dirs.length === 15, dirs.length + ' 份');
});

/* ==========================================================================
 * 5. 现场复现：requisition confirm「门店侧余额首次创建」= 26 条明细最可能的真凶
 * ========================================================================== */
chain = chain.then(function () {
  section('5. 现场复现：门店侧余额文档首次创建时不能整单崩');
  setMsg('document.get:fail errCode=-502005', '-502005');
  seedBase();
  // 总仓有余额（之前入过货），但**门店侧这条食材从没入过 → 门店余额文档不存在**
  mock.seed('stock_balance', [{ _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 10, dayOpenDate: null }]);
  return call('requisition', { action: 'create', items: [{ itemId: 'm1', qty: 5 }] }, SHOP)
    .then(function (c) {
      var id = c.data && c.data.requisition && c.data.requisition._id;
      return call('requisition', { action: 'confirm', requisitionId: id });
    }).then(function (r) {
      check('5a confirm 成功（不是「系统繁忙」）', r.code === 0, 'code=' + r.code + ' ' + r.message);
      check('5b 门店余额首次创建 = 5', balQty('S1', 'm1') === 5, balQty('S1', 'm1'));
      check('5c 总仓扣减后 = 5', balQty('WAREHOUSE', 'm1') === 5, balQty('WAREHOUSE', 'm1'));
    });
});

/* ---------- 收尾 ---------- */
chain = chain.catch(function (e) {
  fail++;
  console.log('  \u2717 [UNCAUGHT] ' + (e && e.stack ? e.stack : e));
}).then(function () {
  setMsg(null);                       // 桩件恢复默认文案，别影响别的套件
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'SYSTEM-DIAG RESULT: ALL GREEN' : 'SYSTEM-DIAG RESULT: RED');
  try { rmrf(WORK); } catch (e) { /* ignore */ }
  process.exitCode = fail === 0 ? 0 : 1;
});