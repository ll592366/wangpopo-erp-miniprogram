// ==========================================================================
// tests/smoke/smoke.js — 云函数冒烟测试（本地纯 Node，不联网、不碰线上数据）
//
// 用法：
//   "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe" tests/smoke/smoke.js
//
// 原理：把 cloudfunctions/<函数> 拷到系统临时目录，注入 mock-sdk.js 冒充
// wx-server-sdk（内存数据库），然后逐个调云函数 main()。
//
// 判据：任何 [5001] 系统内部错误 = 失败（5001 说明云函数内部抛了非业务异常，
// 专治 ReferenceError 这类被兜底藏起来的 bug）。业务码（1001/2002/3002…）按用例预期判定。
//
// 内含「反向对照」：把 requisition 还原成旧的坏写法，必须复现 5001，
// 证明这套测试真能抓到 bug，不是走过场。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');
var withLogP = require('./log-capture').withLog;   // 抓取兜底日志原文（用户文案已被固定为固定人话）

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-smoke-' + process.pid);
var FUNCS = ['dish', 'export', 'inventory', 'login', 'material', 'opLog', 'production',
  'purchase', 'register', 'report', 'requisition', 'stocktake', 'store'];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function setup() {
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
}

setup();
var sdk = require(path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
var mock = sdk.__mock;

var TODAY = new Date().toISOString().slice(0, 10);
var MANAGER = { _uid: 'user_manager' };
var SHOP = { _uid: 'user_shop' };
var ctx = {};
var results = [];

mock.seed('user', [
  { _id: 'user_manager', name: '王婆婆·管理', username: '888', password: '888888', role: 'manager',
    storeId: null, passwordChanged: false, isActive: true, createdBy: 'system', createdAt: TODAY },
  { _id: 'user_shop', name: '万达店', username: 'shop1', password: '123456', role: 'shop',
    storeId: 'store_smoke', passwordChanged: true, isActive: true, createdBy: 'test', createdAt: TODAY }
]);
mock.seed('store', [{ _id: 'store_smoke', code: 'SMOKE', name: '冒烟店', status: 'open', closedAt: null, createdAt: TODAY }]);
mock.seed('material', [
  { _id: 'mat_beef', name: '牛肉片', unit: '包', spec: '2.5kg', lowStockThreshold: 2, isActive: true, createdAt: TODAY },
  { _id: 'mat_shrimp', name: '基围虾', unit: '包', spec: '1kg', lowStockThreshold: 2, isActive: true, createdAt: TODAY }
]);
mock.seed('dish', [{ _id: 'dish_a', name: '婆婆金汤牛肉', category: '招牌菜类',
  consumeItems: [{ itemId: 'mat_beef', qty: 1, unit: '包', portions: null }], isActive: true, createdAt: TODAY }]);
mock.seed('stock_balance', [
  { _id: 'bal_WAREHOUSE_mat_beef', storeId: 'WAREHOUSE', itemId: 'mat_beef', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: TODAY },
  { _id: 'bal_store_smoke_mat_beef', storeId: 'store_smoke', itemId: 'mat_beef', qty: 20, dayOpenQty: 20, dayInQty: 0, dayOutQty: 0, dayOpenDate: TODAY }
]);
['purchase', 'requisition', 'production', 'stocktake', 'op_log'].forEach(function (n) { mock.seed(n, []); });

function ev(base, who) { return Object.assign({}, base, who || {}); }

var tests = [
  { label: 'login · 管理端账号密码登录', fn: 'login', event: { username: '888', password: '888888' }, zero: true,
    extra: function (r) { return r.data ? ('role=' + r.data.role + ' 首登改密=' + r.data.needChangePassword) : '无 data'; } },
  { label: 'login · 门店账号登录', fn: 'login', event: { username: 'shop1', password: '123456' }, zero: true },
  { label: 'login · 错误密码（业务码，非 5001）', fn: 'login', event: { username: '888', password: 'bad' }, zero: false },
  { label: 'login · 账号不存在（业务码，非 5001）', fn: 'login', event: { username: 'nobody', password: 'x' }, zero: false },
  { label: 'login · 首登改密 setPassword', fn: 'login', event: ev({ action: 'setPassword', newPassword: 'abc123' }, MANAGER), zero: true },
  { label: 'login · 自助改密 changePassword', fn: 'login', event: ev({ action: 'changePassword', oldPassword: 'abc123', newPassword: 'def456' }, MANAGER), zero: true },
  { label: 'login · 用新密码再登录', fn: 'login', event: { username: '888', password: 'def456' }, zero: true },

  { label: 'register · 注册开店（一事务建店建号）', fn: 'register', event: { shopName: '冒烟分店', username: 'smoke_b', password: '123456' }, zero: true,
    extra: function (r) { return r.data ? ('store=' + r.data.storeId + ' user=' + r.data._id) : '无 data'; } },
  { label: 'register · 重复账号（业务码）', fn: 'register', event: { shopName: '冒烟二店', username: 'smoke_b', password: '123456' }, zero: false },

  { label: 'material · list', fn: 'material', event: ev({ action: 'list' }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('rows=' + r.data.rows.length) : '无 data'; } },
  { label: 'material · save 新增', fn: 'material', event: ev({ action: 'save', name: '冒烟食材', unit: '盒', lowStockThreshold: 3 }, MANAGER), zero: true },
  { label: 'material · toggle 停用', fn: 'material', event: ev({ action: 'toggle', _id: 'mat_shrimp', isActive: false }, MANAGER), zero: true,
    assert: function () { var m = mock.dump('material').filter(function (x) { return x._id === 'mat_shrimp'; })[0]; return m && m.isActive === false; } },
  { label: 'purchase · 已停用食材入库被拦', fn: 'purchase', event: ev({ name: '基围虾', qty: 1 }, MANAGER), zero: false,
    assert: function (r) { return /已停用/.test(r.message || ''); } },
  { label: 'dish · list', fn: 'dish', event: ev({ action: 'list' }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('rows=' + r.data.rows.length) : '无 data'; } },
  { label: 'dish · save 新增', fn: 'dish', event: ev({ action: 'save', name: '冒烟菜品', consumeItems: [{ itemId: 'mat_beef', qty: 2 }] }, MANAGER), zero: true },

  { label: 'purchase · 新食材一键建档入库', fn: 'purchase', event: ev({ name: '冒烟新食材', qty: 5, unit: '包', spec: '2.5kg', lowStockThreshold: 3 }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('总仓余额=' + r.data.balanceAfter.after + ' 食材=' + r.data.material._id) : '无 data'; } },
  { label: 'purchase · 已有食材重复入库', fn: 'purchase', event: ev({ name: '牛肉片', qty: 3 }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('总仓余额=' + r.data.balanceAfter.after) : '无 data'; } },
  { label: 'purchase · 数量为 0（业务码）', fn: 'purchase', event: ev({ name: '牛肉片', qty: 0 }, MANAGER), zero: false },

  { label: 'inventory · 查询总仓库存', fn: 'inventory', event: ev({}, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('rows=' + (r.data.rows || []).length) : '无 data'; } },
  { label: 'inventory · adjust 手工调整', fn: 'inventory', event: ev({ action: 'adjust', itemId: 'mat_beef', delta: 2 }, MANAGER), zero: true },

  { label: 'requisition · 门店提交申请【原报错点】', fn: 'requisition', event: ev({ action: 'create', items: [{ itemId: 'mat_beef', qty: 2 }] }, SHOP), zero: true,
    extra: function (r) { if (r.data && r.data.requisition) { ctx.reqId = r.data.requisition._id; } return r.data ? ('单号=' + r.data.requisition._id + ' status=' + r.data.requisition.status) : '无 data'; } },
  { label: 'requisition · list', fn: 'requisition', event: ev({ action: 'list' }, SHOP), zero: true,
    extra: function (r) { return r.data ? ('list=' + r.data.list.length) : '无 data'; } },
  { label: 'requisition · 管理端确认', fn: 'requisition', event: function () { return ev({ action: 'confirm', requisitionId: ctx.reqId }, MANAGER); }, zero: true,
    extra: function (r) { return r.data ? ('status=' + r.data.status) : '无 data'; } },

  { label: 'production · 门店出品被拦（已转管理端专属，期望 1003 NO_ROLE）', fn: 'production', event: ev({ action: 'create', dishId: 'dish_a', qty: 1 }, SHOP), zero: false,
    assert: function (r) { return r.code === 1003 && /NO_ROLE|角色/.test(r.message || ''); } },
  { label: 'production · 管理端出品扣减（带 storeId）', fn: 'production', event: ev({ action: 'create', dishId: 'dish_a', qty: 1, storeId: 'store_smoke' }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('单号=' + r.data.production._id) : '无 data'; } },
  { label: 'production · list', fn: 'production', event: ev({ action: 'list' }, SHOP), zero: true,
    extra: function (r) { return r.data ? ('list=' + r.data.list.length) : '无 data'; } },

  { label: 'stocktake · 门店实点', fn: 'stocktake', event: ev({ action: 'create', itemId: 'mat_beef', actualQty: 18 }, SHOP), zero: true,
    extra: function (r) { return r.data ? ('实际=' + r.data.stocktake.actualQty + ' 理论=' + r.data.stocktake.theoryQty) : '无 data'; } },

  { label: 'store · list', fn: 'store', event: ev({ action: 'list' }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('rows=' + r.data.rows.length) : '无 data'; } },
  { label: 'store · rename 改名', fn: 'store', event: ev({ action: 'rename', _id: 'store_smoke', name: '冒烟店改名' }, MANAGER), zero: true },
  { label: 'report · business 经营情况', fn: 'report', event: ev({ type: 'business', from: TODAY, to: TODAY }, MANAGER), zero: true },
  { label: 'report · lowStock 总仓预警', fn: 'report', event: ev({ type: 'lowStock' }, MANAGER), zero: true,
    extra: function (r) { return r.data ? ('rows=' + ((r.data.rows || r.data.list || []).length)) : '无 data'; } },
  { label: 'opLog · 审计日志（必须真有记录）', fn: 'opLog', event: ev({ limit: 50 }, MANAGER), zero: true,
    extra: function (r) { return '条数=' + (((r.data && r.data.logs) || []).length); },
    assert: function (r) { return ((r.data && r.data.logs) || []).length > 0; } },
  { label: 'export · 数据导出', fn: 'export', event: ev({ from: '2000-01-01', to: TODAY }, MANAGER), zero: true }
];

function one(t) {
  var evt = typeof t.event === 'function' ? t.event() : t.event;
  var main;
  try {
    main = require(path.join(WORK, t.fn, 'index.js')).main;
  } catch (e) {
    results.push({ label: t.label, pass: false, info: 'LOAD FAIL: ' + e.message });
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(function () { return main(evt); })
    .then(function (r) {
      var code = r && r.code;
      var ok = (t.zero ? code === 0 : true) && code !== 5001;
      if (ok && t.assert) { ok = !!t.assert(r); }   // 副作用断言：只验 code 会放过"假成功"
      var info = '[' + code + '] ' + (r && r.message ? r.message : '');
      if (t.extra && r && r.code === 0) { info += ' | ' + t.extra(r); }
      results.push({ label: t.label, pass: !!ok, info: info });
    })
    .catch(function (e) {
      results.push({ label: t.label, pass: false, info: 'THROW: ' + (e && e.message) });
    });
}

/** 反向对照：把 requisition 还原成旧的坏写法，必须复现 5001 */
function negativeControl() {
  var badDir = path.join(WORK, 'requisition_bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.readdirSync(path.join(WORK, 'requisition')).forEach(function (f) {
    fs.copyFileSync(path.join(WORK, 'requisition', f), path.join(badDir, f));
  });
  var p = path.join(badDir, 'index.js');
  var src = fs.readFileSync(p, 'utf8');
  src = src.replace(/^ {6}var found = \{\};\r?\n/m, '');   // 去掉外层提升
  src = src.replace('found = {};', 'var found = {};');      // 内层恢复 var
  fs.writeFileSync(p, src);
  return Promise.resolve()
    .then(function () {
      return withLogP(function () {
        return require(p).main(ev({ action: 'create', items: [{ itemId: 'mat_beef', qty: 1 }] }, SHOP));
      });
    })
    .then(function (cap) {
      var r = cap.r;
      var needle = 'found is not defined';
      var m = String((r && r.message) || '');
      console.log('INFO  反向对照兜底日志原文 → ' + (cap.log.split('\n')[0] || '(空)'));
      results.push({ label: '反向对照-a 旧写法必须复现 5001', pass: r.code === 5001, info: '[' + r.code + ']' });
      results.push({ label: '反向对照-b 用户文案为固定人话', pass: m === '系统繁忙，请稍后重试', info: m });
      results.push({ label: '反向对照-c 日志含 "found is not defined" 且文案不含',
        pass: cap.log.indexOf(needle) >= 0 && m.indexOf(needle) < 0,
        info: '日志命中=' + (cap.log.indexOf(needle) >= 0) });
    })
    .catch(function (e) {
      results.push({ label: '反向对照-a 旧写法必须复现 5001', pass: false, info: 'THROW: ' + (e && e.message) });
    });
}

tests.reduce(function (p, t) {
  return p.then(function () { return one(t); });
}, Promise.resolve())
  .then(negativeControl)
  .then(function () {
    var pass = 0, fail = 0;
    console.log('\n================ 云函数冒烟测试 ================');
    results.forEach(function (r) {
      if (r.pass) { pass += 1; } else { fail += 1; }
      console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.label + '  ->  ' + r.info);
    });
    console.log('----------------------------------------------');
    console.log('合计 ' + results.length + ' 条：通过 ' + pass + '，失败 ' + fail);
    console.log(fail === 0 ? 'SMOKE RESULT: ALL GREEN' : 'SMOKE RESULT: HAS FAILURE');
    rmrf(WORK);
    process.exitCode = fail === 0 ? 0 : 1;
  })
  .catch(function (e) {
    console.error('SMOKE CRASHED:', e && e.message);
    rmrf(WORK);
    process.exitCode = 1;
  });
