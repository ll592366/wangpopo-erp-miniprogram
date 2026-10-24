// ==========================================================================
// tests/smoke/list-search.js — 列表检索 + 「100 条静默截断」根治（第 20 套）
//
// 老板 2026-10-09 两条需求：
//   ① 「在每个列表页面都要增加一个检索功能 快速定位商品！」
//   ② 「检查管理端 食材编辑后 提示也创建 但是找不到商品名称」← 静默截断 bug
//      根因：material.list 写死 .limit(100) 且无 orderBy；库里正好 100 条食材，
//      新建的排第 101 位 → 云端直接截断 → toast 说建好了、列表却没有。
//
// ── 与工程师的接口约定（前端统一口径，本套按此断言；名字不同请改代码，别改断言）──
//   · 输入框：<input bindinput="onSearchInput">
//   · 清除：  bindtap="onSearchClear"（一次清掉本页所有搜索词）
//   · 重新过滤：page.applySearch(kw?) —— 不传 = 沿用当前搜索词（loadAll 刷新后重调用）
//   · 空提示文案含「没有匹配「关键字」」
//   · 过滤一律走 utils/list-search.js 的 filter()（全站同一口径，不区分大小写）
//   ⚠️ 本套**不依赖各页搜索词字段名**（kwMat / kwDish / kwInv / kw…）：
//      断言只看**渲染出来的列表**（viewMaterials / inventory / invRows / rows / pending…）
//      和「有没有调云函数」，这样工程师改字段名不会误红，但少过滤一处一定会红。
//
// ── A 组要防的是「静默」 ──
//   静默截断的可怕之处在于**没有任何报错**：老板以为建好了，云端说"成功"，列表就是没有。
//   所以断言不只看条数，还看 total / truncated 有没有把这件事**说出来**。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

/* ⚠️ ERP_ROOT 覆盖项目根：**变异自证专用**。
 *    纪律：变异一律改临时副本（Temp/mut_xxx/），源码一个字节不许写。
 *    本套在临时副本里跑（PROJECT=临时目录 时，云函数拷贝与前端页面都从副本加载）。 */
var PROJECT = process.env.ERP_ROOT
  ? path.resolve(process.env.ERP_ROOT)
  : path.resolve(__dirname, '..', '..');
var MP = path.join(PROJECT, 'miniprogram');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-ls-' + process.pid);
var FUNCS = ['material', 'dish', 'inventory', 'report'];

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
var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ---------------- 种子助手 ----------------
 * 食材：名字里带关键词，便于 keyword 检索断言：
 *   前 15 条叫「土豆-NNN」，其余叫「牛肉-NNN」→ keyword='土豆' 恰好命中 15 条。
 * createdAt 递增（ISO 字符串）→ orderBy('createdAt','desc') 后「最后创建的排第一」。
 * 下架（isActive=false）默认给**最老**的几条 → 「在售在前、已下架在后」两种口径都成立。
 */
function pad(n, w) { var s = String(n); while (s.length < (w || 3)) { s = '0' + s; } return s; }
function mkMat(i, offIdx) {
  var off = offIdx === undefined ? i : offIdx;
  return {
    _id: 'M' + pad(off, 4),
    name: (i <= 15 ? '土豆-' : '牛肉-') + pad(i),
    unit: '斤', spec: '', lowStockThreshold: 10,
    createdAt: '2026-10-09T00:00:00.000Z',
    isActive: true
  };
}
function seedMaterials(n, inactiveTail) {
  var rows = [];
  for (var i = 1; i <= n; i++) {
    var m = mkMat(i, i);
    m.createdAt = '2026-01-01T00:00:' + pad(i % 60, 2) + '.' + pad(i, 3) + 'Z';
    rows.push(m);
  }
  // 让 createdAt 单调递增（i 越大越新），最后创建的 = 第 n 条
  rows.forEach(function (m, k) { m.createdAt = '2026-01-01T00:00:00.' + pad(k + 1, 3) + 'Z'; });
  if (inactiveTail) {
    // 下架的给**最老**的 createdAt（第 1..inactiveTail 条）
    for (var j = 0; j < inactiveTail; j++) { rows[j].isActive = false; }
  }
  return rows;
}
function baseSeed() {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '老板', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: '城南店', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  mock.seed('store', [{ _id: 'S1', code: 'CN', name: '城南店', status: 'open', isActive: true, lowStockThreshold: 8 }]);
  mock.seed('stocktake', []);
  mock.seed('op_log', []);
  mock.seed('material', []);
  mock.seed('dish', []);
  mock.seed('stock_balance', []);
}
function callMat(ev) { return F.material.main(Object.assign({}, MGR, ev)); }
function callDish(ev) { return F.dish.main(Object.assign({}, MGR, ev)); }
function callInv(ev) { return F.inventory.main(Object.assign({}, MGR, ev)); }
function callRep(ev) { return F.report.main(Object.assign({}, MGR, ev)); }

/* ========================================================================
 * ★A 组：云函数「不再静默截断」
 * ====================================================================== */
section('★A1 material.list：150 条食材，最后创建的那条必须能查到且排第一');

baseSeed();
mock.seed('material', seedMaterials(150, 0));
callMat({ action: 'list' }).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var newest = '牛肉-' + pad(150);
  console.log('     实测：返回 ' + rows.length + ' 条，total=' + (r.data && r.data.total) +
    '，truncated=' + (r.data && r.data.truncated) + '，rows[0]=' + (rows[0] && rows[0].name));
  check('★150 条食材 → 返回条数 = 150（旧写法 limit(100) 会只给 100 条）',
    rows.length === 150, 'rows.length=' + rows.length);
  check('★能查到**最后创建**的那条（' + newest + '）—— 这正是老板「提示创建了却找不到」的那一条',
    rows.some(function (x) { return x.name === newest; }), '命中=' +
    rows.some(function (x) { return x.name === newest; }));
  check('★它排在**第一位**（orderBy createdAt desc 的直接证据）',
    rows.length > 0 && rows[0].name === newest, 'rows[0]=' + (rows[0] && rows[0].name));
  check('★total === 150（真实总数，不是"返回了几条就是几"）',
    r.data && r.data.total === 150, 'total=' + (r.data && r.data.total));
  check('★truncated === false（没被截断就要说 false，不能永远 true）',
    r.data && r.data.truncated === false, 'truncated=' + (r.data && r.data.truncated));

  /* ---- 反向对照：条数少的时候 truncated 必须 false ---- */
  section('★A2 反向对照：20 条食材 → truncated 必须 false（防「永远 true」）');
  baseSeed();
  mock.seed('material', seedMaterials(20, 0));
  return callMat({ action: 'list' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  check('★20 条 → rows=20 / total=20 / truncated=false',
    rows.length === 20 && r.data.total === 20 && r.data.truncated === false,
    'rows=' + rows.length + ' total=' + r.data.total + ' truncated=' + r.data.truncated);

  /* ---- 真被截断时 truncated 必须 true（把静默变成可见） ---- */
  section('★A3 真被截断（520 条 > 上限 500）→ truncated 必须 true，且返回条数 > 100');
  baseSeed();
  mock.seed('material', seedMaterials(520, 0));
  return callMat({ action: 'list' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  console.log('     实测：返回 ' + rows.length + ' 条，total=' + r.data.total + '，truncated=' + r.data.truncated);
  check('★520 条 → 返回条数**大于 100**（不是又被截回 100）', rows.length > 100, 'rows.length=' + rows.length);
  check('★520 条 → total === 520', r.data.total === 520, 'total=' + r.data.total);
  check('★total > rows.length 时 truncated === true（截断必须被说出来）',
    r.data.truncated === true, 'truncated=' + r.data.truncated);
  check('★truncated 时 rows.length < total（两个数不自相矛盾）',
    rows.length < r.data.total, rows.length + ' vs ' + r.data.total);
  /* 这条是 **orderBy 的真正价值**所在：内存里再排一次序（listCmp）也救不了被截断的窗口 ——
   * 没有云端 orderBy('createdAt','desc')，limit 窗口取到的是"任意 500 条"，
   * 老板刚建的那条照样落在窗口外、永远查不到（这才是真截断的杀伤力）。 */
  var newest520 = '牛肉-' + pad(520);
  check('★★真被截断时，**最后创建的那条仍在返回窗口内**（云端 orderBy 的不可替代之处）',
    rows.some(function (x) { return x.name === newest520; }),
    '返回窗口里含 ' + newest520 + '：' + rows.some(function (x) { return x.name === newest520; }) +
    '（窗口 ' + rows.length + ' 条，总数 ' + r.data.total + '）');

  /* ---- keyword 通路：检索也不能只给 100 条 ---- */
  section('★A4 material.list keyword 通路：150 条里筛「土豆」→ 15 条，total 也是 15');
  baseSeed();
  mock.seed('material', seedMaterials(150, 0));
  return callMat({ action: 'list', keyword: '土豆' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  check('★keyword=土豆 → 恰好 15 条（前 15 条命名带土豆）', rows.length === 15, 'rows=' + rows.length);
  check('★keyword 通路 total 也是筛选后的数（15，不是全库 150）',
    r.data && r.data.total === 15, 'total=' + (r.data && r.data.total));
  check('★keyword 通路 truncated === false', r.data && r.data.truncated === false,
    'truncated=' + (r.data && r.data.truncated));
  check('★keyword 结果里没有牛肉-*（过滤真的生效）',
    rows.every(function (x) { return x.name.indexOf('土豆') >= 0; }), rows.map(function (x) { return x.name; }).join(','));

  /* ---- A5 dish.list ---- */
  section('★A5 dish.list：150 道菜，同样不能被静默截断');
  baseSeed();
  var dishes = [];
  for (var i = 1; i <= 150; i++) {
    dishes.push({
      _id: 'D' + pad(i), name: '菜-' + pad(i), isActive: true,
      createdAt: '2026-01-01T00:00:00.' + pad(i, 3) + 'Z',
      consumeItems: [{ itemId: 'M0001', qty: 1 }]
    });
  }
  mock.seed('dish', dishes);
  return callDish({ action: 'list' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  console.log('     实测：dish.list 返回 ' + rows.length + ' 条，total=' + r.data.total + '，truncated=' + r.data.truncated);
  check('★dish.list 150 道菜 → 返回 150 条（不是 100）', rows.length === 150, 'rows=' + rows.length);
  check('★dish.list total === 150', r.data.total === 150, 'total=' + r.data.total);
  check('★dish.list truncated === false', r.data.truncated === false, 'truncated=' + r.data.truncated);
  check('★dish.list 能查到最后创建的那道菜（菜-150）',
    rows.some(function (x) { return x.name === '菜-150'; }), '命中=' +
    rows.some(function (x) { return x.name === '菜-150'; }));

  /* ---- A6 inventory 拉食材 ---- */
  section('★A6 inventory.list：150 种食材 → 库存行 150 条（库存页不能凭空少一行）');
  baseSeed();
  mock.seed('material', seedMaterials(150, 0));
  var bal = [];
  for (var j = 1; j <= 150; j++) {
    bal.push({
      _id: 'bal_WAREHOUSE_M' + pad(j, 4), storeId: 'WAREHOUSE', itemId: 'M' + pad(j, 4),
      qty: 5, dayOpenQty: 5, dayInQty: 0, dayOutQty: 0, dayOpenDate: null
    });
  }
  mock.seed('stock_balance', bal);
  return callInv({ action: 'list', storeId: 'WAREHOUSE' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  console.log('     实测：inventory.list 返回 ' + rows.length + ' 行');
  check('★inventory.list 150 种食材 → 150 行（旧 limit(100) 会凭空少 50 行）',
    rows.length === 150, 'rows=' + rows.length);
  check('★最后创建的那种食材（M0150）在库存行里',
    rows.some(function (x) { return x.itemId === 'M0150'; }), '命中=' +
    rows.some(function (x) { return x.itemId === 'M0150'; }));

  /* ---- A7 report.lowStock 拉食材 ---- */
  section('★A7 report.lowStock：150 种食材全部低于阈值 → 150 条预警（漏报预警＝老板看不到）');
  baseSeed();
  mock.seed('material', seedMaterials(150, 0));
  var bal2 = [];
  for (var k = 1; k <= 150; k++) {
    bal2.push({
      _id: 'bal_WAREHOUSE_M' + pad(k, 4), storeId: 'WAREHOUSE', itemId: 'M' + pad(k, 4),
      qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null
    });
  }
  mock.seed('stock_balance', bal2);
  return callRep({ type: 'lowStock' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  console.log('     实测：report.lowStock 返回 ' + rows.length + ' 条预警');
  check('★report.lowStock 150 种食材全部破线 → 150 条预警（不是 100 条）',
    rows.length === 150, 'rows=' + rows.length);
  check('★最后创建的食材（M0150）也在预警里（新建的破线食材不能被截掉）',
    rows.some(function (x) { return x.itemId === 'M0150'; }), '命中=' +
    rows.some(function (x) { return x.itemId === 'M0150'; }));

  /* ---- A8 排序：旧行为没被破坏 ---- */
  section('★A8 排序：在售在前 / 已下架在后，且在售内部按 createdAt desc');
  baseSeed();
  var mats = seedMaterials(6, 2);           // 第 1、2 条设为已下架（它们 createdAt 最老）
  mock.seed('material', mats);
  return callMat({ action: 'list' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  var names = rows.map(function (x) { return x.name; });
  console.log('     实测顺序：' + names.join(' → '));
  var firstInactive = -1, lastActive = -1;
  rows.forEach(function (x, idx) {
    if (x.isActive === false) { if (firstInactive < 0) { firstInactive = idx; } }
    else { lastActive = idx; }
  });
  check('★已下架排在在售**之后**（老板旧口径没被破坏）', firstInactive > lastActive,
    '最后一行在售 idx=' + lastActive + '，第一个下架 idx=' + firstInactive);
  var activeNames = rows.filter(function (x) { return x.isActive !== false; })
    .map(function (x) { return x.name; });
  check('★在售内部按 createdAt 倒序（新建的在前）',
    activeNames[0] === '土豆-006', '在售顺序=' + activeNames.join(' → '));

  /* ---- A9 口径变化的显式记录（characterization，不是"随实现而动"的软断言） ---- */
  section('★A9 口径已变的显式记录：createdAt 是**主序**，下架排后面只是次级 tie-break');
  baseSeed();
  var mixed = [];
  for (var n = 1; n <= 4; n++) {
    mixed.push({
      _id: 'MX' + n, name: ' newest-下架-' + n, unit: '斤', lowStockThreshold: 10,
      createdAt: '2026-02-01T00:00:00.00' + n + 'Z', isActive: n === 4 ? false : true
    });
  }
  mock.seed('material', mixed);
  return callMat({ action: 'list' });
}).then(function (r) {
  var rows = (r.data && r.data.rows) || [];
  console.log('     实测顺序：' + rows.map(function (x) { return x.name + (x.isActive === false ? '(下架)' : ''); }).join(' → '));
  check('【口径记录】新建的**下架**食材排在最前（createdAt 主序 > isActive 次序）',
    rows.length === 4 && rows[0].isActive === false,
    'rows[0]=' + (rows[0] && rows[0].name) + ' isActive=' + (rows[0] && rows[0].isActive));
  console.log('     ⚠️ 口径提示（报给 lead，不是断言失败）：老板旧口径是「在售整体在前」，');
  console.log('        现在实现是「createdAt 主序 + isActive 次级 tie-break」—— 新建的下架食材会顶到最前。');
  console.log('        两种口径不能同时成立（与 A1「新建的排第一」直接冲突），需要老板拍板一个。');

  /* ========================================================================
   * ★B 组：11 处列表的本地检索（前端运行期）
   * ====================================================================== */
  section('★B 组：11 处列表本地检索（输入即过滤 · 不打后端）');

  /* ---- 假运行时：所有云调用都返回"胖 payload"（各页读哪个别名都能拿到同一批行） ---- */
  var ROWS = [
    { _id: 'r1', itemId: 'r1', name: '土豆-001', spec: '2kg/袋', storeName: '土豆店', itemsText: '土豆 5', statusLabel: '待处理', status: 'pending', username: 'tudou', code: 'TD', qty: 3, unit: '斤', isActive: true, storeId: 'S1', applicantId: 'u_shop', createdAt: '2026-10-09T09:00:00.000Z', lowStockThreshold: 10, threshold: 10, gap: 7, updatedAt: '2026-10-09T09:00:00.000Z' },
    { _id: 'r2', itemId: 'r2', name: '牛肉-002', spec: '500g/盒', storeName: '牛肉店', itemsText: '牛肉 2', statusLabel: '待处理', status: 'pending', username: 'niurou', code: 'NR', qty: 5, unit: '盒', isActive: true, storeId: 'S1', applicantId: 'u_shop', createdAt: '2026-10-09T09:05:00.000Z', lowStockThreshold: 10, threshold: 10, gap: 5, updatedAt: '2026-10-09T09:05:00.000Z' },
    { _id: 'r3', itemId: 'r3', name: '香菇-003', spec: '', storeName: '香菇店', itemsText: '香菇 1', statusLabel: '已确认', status: 'confirmed', username: 'xianggu', code: 'XG', qty: 1, unit: '斤', isActive: true, storeId: 'S1', applicantId: 'u_shop', createdAt: '2026-10-09T09:10:00.000Z', lowStockThreshold: 10, threshold: 10, gap: 9, updatedAt: '2026-10-09T09:10:00.000Z' }
  ];
  var ROWS_OVERRIDE = null;   // 附加用例临时换一批行（走同一条灌数据路径）
  function fatPayload() {
    var rows = ROWS_OVERRIDE || ROWS;
    var o = {
      storeId: 'S1', storeName: '城南店', defaultThreshold: 2, alertCount: 0,
      total: rows.length, truncated: false, storeThreshold: 8
    };
    ['rows', 'list', 'stores', 'inventory', 'dishes', 'dishesView', 'invRows',
      'viewMaterials', 'materials', 'items', 'pending', 'done'].forEach(function (k) {
      o[k] = rows.map(function (r) { return Object.assign({}, r); });
    });
    return o;
  }
  var state = { calls: [] };
  function installRuntime() {
    state.calls = [];
    global.getApp = function () {
      return { globalData: { user: { _id: 'u_mgr', role: 'manager' } }, logout: function () {} };
    };
    var noop = function () {};
    global.wx = {
      cloud: {
        init: noop,
        callFunction: function (arg) {
          state.calls.push({ name: arg.name, data: arg.data });
          return Promise.resolve({ result: { code: 0, data: fatPayload(), message: 'ok' } });
        }
      },
      showToast: noop, showLoading: noop, hideLoading: noop, showModal: noop,
      stopPullDownRefresh: noop, setNavigationBarTitle: noop, navigateTo: noop, pageScrollTo: noop, setClipboardData: noop,
      getSystemInfoSync: function () { return { windowWidth: 375, windowHeight: 667 }; }
    };
  }
  function loadPage(rel) {
    installRuntime();
    var file = path.join(MP, 'pages', rel + '.js');
    var def = null;
    global.Page = function (d) { def = d; };
    delete require.cache[require.resolve(file)];
    require(file);
    if (!def) { throw new Error('页面没注册 Page()：' + rel); }
    var p = {};
    Object.keys(def).forEach(function (k) { p[k] = def[k]; });
    p.data = JSON.parse(JSON.stringify(def.data || {}));
    p.setData = function (patch) {
      Object.keys(patch).forEach(function (k) { p.data[k] = patch[k]; });
    };
    return p;
  }
  /** 渲染列表里每一行都该命中关键字（没命中的不该显示） */
  function allMatch(rows, kw) {
    return (rows || []).every(function (r) {
      return JSON.stringify(r).toLowerCase().indexOf(String(kw).toLowerCase()) >= 0;
    });
  }
  /** 页面是否记住了「当前有搜索词」—— wxml 的空提示/清除按钮就是靠它 wx:if 出来的 */
  function kwRemembered(p, kw) {
    var hitKey = '';
    Object.keys(p.data).forEach(function (k) {
      if (String(p.data[k]) === String(kw)) { hitKey = k; }
    });
    return hitKey;
  }
  /* 输入 / 清除：把 wxml 上的 data-kw 一并传进去（多搜索框页面靠它区分清哪个）
   ⚠️ 必须传合法 event：源码里 onSearchClear 会读 e.currentTarget.dataset
      （2026-10-09 实测：goods.js 少写 function (e) 参数 → 真机上点「✕」直接抛错）。 */
  function typeSearch(p, kw, kwField) {
    if (typeof p.onSearchInput !== 'function') { return false; }
    p.onSearchInput({
      detail: { value: kw },
      currentTarget: { dataset: kwField ? { kw: kwField } : {} }
    });
    return true;
  }
  function clearSearch(p, kwField) {
    if (typeof p.onSearchClear === 'function') {
      p.onSearchClear({ currentTarget: { dataset: kwField ? { kw: kwField } : {} } });
    } else {
      typeSearch(p, '', kwField);
    }
  }

  /* 11 处：页面 + 渲染列表字段 + 该列表对应的搜索框字段（kw） */
  var CASES = [
    { rel: 'manager/goods/goods', label: '管理端·食材档案',
      entries: [{ key: 'viewMaterials', kw: 'kwMat' }, { key: 'dishes', kw: 'kwDish' }] },
    { rel: 'manager/store-detail/store-detail', label: '管理端·门店详情库存',
      entries: [{ key: 'inventory', kw: 'kwInv' }, { key: 'dishesView', kw: 'kwDish' }] },
    { rel: 'shop/store-stock/store-stock', label: '门店端·本店库存',
      entries: [{ key: 'invRows', kw: 'kw' }] },
    { rel: 'manager/wh-stock-alert/wh-stock-alert', label: '管理端·总仓预警',
      entries: [{ key: 'rows', kw: 'kw' }] },
    { rel: 'manager/requisition-process/requisition-process', label: '管理端·要货单处理',
      entries: [{ key: 'pending', kw: 'kwPending' }, { key: 'done', kw: 'kwDone' }] },
    { rel: 'shop/requisition/requisition', label: '门店端·我的申请',
      entries: [{ key: 'list', kw: 'kw' }] },
    { rel: 'manager/stores-business/stores-business', label: '管理端·分店经营',
      entries: [{ key: 'stores', kw: 'kw' }] },
    { rel: 'manager/shops-accounts/shops-accounts', label: '管理端·门店账号',
      entries: [{ key: 'rows', kw: 'kw' }] }
  ];

  var KW = '土豆';
  var NOMATCH = '不存在的关键字ZZZ';

  function runCase(c, done) {
    var p;
    try { p = loadPage(c.rel); } catch (e) {
      check('【' + c.label + '】页面加载失败', false, (e && e.message) || String(e));
      return done();
    }
    var allKeys = c.entries.map(function (e) { return e.key; });
    var tag = '【' + c.label + '】';

    /* ⚠️ 走**页面自己的加载路径**把数据灌进来（onLoad → onShow/loadAll），
     *    不用 setData 硬塞、不碰页面私有字段（_xxxFull 那种底稿）：
     *    底稿是页面自己建的，测试替它建就等于替它实现了功能，测不出真问题。 */
    if (typeof p.onLoad === 'function') {
      try {
        p.onLoad({ storeId: 'S1', id: 'S1', name: encodeURIComponent('城南店') });
      } catch (e) { /* 有的页 onLoad 只读别的 query，忽略 */ }
    }
    var loader = (typeof p.onShow === 'function') ? p.onShow : (typeof p.loadAll === 'function' ? p.loadAll : null);
    if (!loader) {
      check(tag + '页面有 onShow / loadAll 可用于灌数据', false, '本页没有加载入口，无法验证');
      return done();
    }
    loader.call(p);

    return wait(40).then(function () {
      var base = {};
      allKeys.forEach(function (k) { base[k] = (p.data[k] || []).length; });
      console.log('     [' + c.rel + '] 灌数据后各列表长度：' +
        allKeys.map(function (k) { return k + '=' + base[k]; }).join(' '));
      check(tag + '（前置）页面加载后列表有数据（否则后面的过滤断言没意义）',
        allKeys.some(function (k) { return base[k] > 0; }), JSON.stringify(base));

      // ① 输入存在的关键字 → 只剩匹配项，且**一次云函数都不调**
      state.calls = [];
      if (!typeSearch(p, KW, c.entries[0].kw)) {
        check(tag + '★页面有 onSearchInput（检索入口）', false, '未实现 —— 本页还没有检索功能');
        check(tag + '★输入「土豆」→ 各列表只剩匹配项', false, '无法调用 onSearchInput');
        check(tag + '★输入「土豆」→ 不打后端（callFunction 0 次）', false, '无法调用 onSearchInput');
        check(tag + '★输入不存在的关键字 → 空提示状态生效（页面记住搜索词 + 列表清空）', false, '未实现');
        check(tag + '★点清除 → 恢复全量', false, '未实现');
        check(tag + '★onShow 重新 loadAll 之后过滤仍生效', false, '未实现');
        return done();
      }
      /* 每个搜索框各输一次自己的关键字（页面上是**两个独立搜索框**：
         食材框只管食材、菜品框只管菜品 —— 往食材框打字不该动菜品列表，反之亦然） */
      c.entries.forEach(function (e) { typeSearch(p, KW, e.kw); });
      c.entries.forEach(function (e) {
        var rows = p.data[e.key] || [];
        check(tag + '★输入「土豆」→ ' + e.key + ' 只剩匹配项（' + rows.length + '/' + base[e.key] + '）',
          rows.length < base[e.key] && allMatch(rows, KW),
          rows.map(function (r) { return r.name || r.storeName || r._id; }).join(','));
      });
      check(tag + '★★输入时**一次云函数都不调**（本地过滤的唯一证据）',
        state.calls.length === 0, 'callFunction ' + state.calls.length + ' 次：' +
        state.calls.map(function (c2) { return c2.name; }).join(','));

      // ② 输入不存在的关键字 → 记住搜索词（wxml 的 wx:if 靠它）+ 该列表清空
      typeSearch(p, NOMATCH, c.entries[0].kw);
      var kwKey = kwRemembered(p, NOMATCH);
      check(tag + '★输入不存在的关键字 → 页面记住搜索词（data.' + (kwKey || '（没记住）') + '）',
        !!kwKey, kwKey || '（页面 data 里没有任何字段等于输入的搜索词）');
      check(tag + '★搜不到时列表清空（不是留着全量）',
        (p.data[c.entries[0].key] || []).length === 0,
        c.entries[0].key + '=' + (p.data[c.entries[0].key] || []).length);

      // ③ 点清除 → 恢复全量
      var clearErr = '';
      c.entries.forEach(function (e) {
        try { clearSearch(p, e.kw); } catch (err) { clearErr = (err && err.message) || String(err); }
      });
      check(tag + '★点清除 → 恢复全量', !clearErr &&
        c.entries.every(function (e) { return (p.data[e.key] || []).length === base[e.key]; }),
        clearErr ? 'onSearchClear 抛错：' + clearErr :
          c.entries.map(function (e) { return e.key + '=' + (p.data[e.key] || []).length + '（期望 ' + base[e.key] + '）'; }).join(' '));
      check(tag + '★点清除 → 空提示状态消失（搜索词被清空）',
        !kwRemembered(p, NOMATCH), '');

      // ④ onShow 重新 loadAll 之后过滤仍生效（最容易踩：loadAll 覆盖 data 把搜索冲掉）
      c.entries.forEach(function (e) { typeSearch(p, KW, e.kw); });
      loader.call(p);
      return wait(40).then(function () {
        var kept = c.entries.every(function (e) {
          var rows = p.data[e.key] || [];
          return rows.length < base[e.key] && allMatch(rows, KW);
        });
        check(tag + '★onShow 重新 loadAll 之后过滤**仍生效**（搜索词没被冲掉）', kept,
          c.entries.map(function (e) {
            return e.key + '=' + (p.data[e.key] || []).length + '[' +
              (p.data[e.key] || []).map(function (r) { return r.name || r.storeName || r._id; }).join('/') + ']';
          }).join(' '));
        done();
      });
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var chain = Promise.resolve();
  CASES.forEach(function (c) {
    chain = chain.then(function () { return runCase(c, function () { }); });
  });

  /* ---- goods 页：showInactive 开关与搜索叠加，开关优先 ---- */
  chain = chain.then(function () {
    section('★B 组附加：goods 页「显示已下架」开关与搜索叠加，且**开关优先**');
    // 造两条都叫「土豆」的食材：一条在售、一条已下架（开关关着时不该显示）
    ROWS_OVERRIDE = [
      { _id: 'a1', name: '土豆-001', spec: '', unit: '斤', isActive: true, createdAt: '2026-10-09T09:00:00.000Z' },
      { _id: 'a2', name: '土豆-002', spec: '', unit: '斤', isActive: false, createdAt: '2026-10-09T09:01:00.000Z' },
      { _id: 'a3', name: '香菇-003', spec: '', unit: '斤', isActive: true, createdAt: '2026-10-09T09:02:00.000Z' }
    ];
    var p = loadPage('manager/goods/goods');
    p.onShow();
    return wait(40).then(function () {
      p.setData({ showInactive: false });
      if (typeof p.toggleShowInactive === 'function' && p.data.showInactive !== false) { p.toggleShowInactive(); }
      if (typeof p._applyFilter === 'function') { p._applyFilter(); }
      typeSearch(p, '土豆', 'kwMat');
      var off = (p.data.viewMaterials || []).map(function (r) { return r._id + (r.isActive === false ? '(下架)' : ''); });
      check('★开关关着 → 搜到的那条已下架食材**不显示**（开关优先，别让老板搜到看不见的货）',
        off.length === 1 && off[0] === 'a1', 'viewMaterials=' + JSON.stringify(off));
      if (typeof p.toggleShowInactive === 'function') { p.toggleShowInactive(); }
      var on = (p.data.viewMaterials || []).map(function (r) { return r._id + (r.isActive === false ? '(下架)' : ''); });
      check('★开关打开 → 搜到的下架食材也显示（叠加生效）', on.length === 2, 'viewMaterials=' + JSON.stringify(on));
      check('★「显示已下架（N）」计数按全量算（3 条里 1 条下架）',
        p.data.inactiveCount === 1, 'inactiveCount=' + p.data.inactiveCount);

      /* ---- 大小写不敏感（英文场景） ---- */
      section('★B 组附加：大小写不敏感（英文 / 拼音场景）');
      ROWS_OVERRIDE = [
        { _id: 'e1', name: 'Beef', unit: '斤', qty: 1, threshold: 9, isActive: true },
        { _id: 'e2', name: 'beef-strip', unit: '斤', qty: 2, threshold: 9, isActive: true },
        { _id: 'e3', name: 'Pork', unit: '斤', qty: 3, threshold: 9, isActive: true }
      ];
      var p2 = loadPage('manager/wh-stock-alert/wh-stock-alert');
      p2.onShow();
      return wait(40).then(function () {
        typeSearch(p2, 'BEEF', 'kw');
        check('★输入「BEEF」→ 命中 Beef 与 beef-strip 两条（大小写不敏感）',
          (p2.data.rows || []).length === 2,
          'rows=' + (p2.data.rows || []).map(function (r) { return r.name; }).join(','));
        typeSearch(p2, '  ', 'kw');
        check('★只输入空格 → 视为不过滤（还是 3 条，不做怪正则匹配）',
          (p2.data.rows || []).length === 3, 'rows=' + (p2.data.rows || []).length);
      });
    });
  }).then(function () {
    ROWS_OVERRIDE = null;
  });

  /* ========================================================================
   * ★C 组：静态守卫（防"把 500 改回 100"这类静默回归）
   * ====================================================================== */
  chain = chain.then(function () {
    section('★C 组：静态守卫（按**分支切片**匹配，不整文件搜）');
    function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''); }
    /** 取 `if (action === 'list') {` 到下一个顶层 `  }` 之间的分支切片 */
    function branchOf(src, actionName, kind) {
      var c = strip(src);
      var start = c.indexOf("'" + actionName + "'");
      if (start < 0) { return ''; }
      // 从 start 往回找最近的 "if (" / "if (" 之后即分支起点
      var head = c.lastIndexOf('if (', start);
      if (head < 0) { return ''; }
      // 找到该 if 对应的开括号后的第一个 "  }"（两空格缩进的闭合）
      var tail = c.indexOf('\n  }', start);
      return tail < 0 ? c.slice(head) : c.slice(head, tail);
    }
    var matSrc = fs.readFileSync(path.join(CF, 'material', 'index.js'), 'utf8');
    var matList = branchOf(matSrc, 'list', 'action');
    check('C 组守卫本身有效（能切出 material.list 分支 > 100 字符）', matList.length > 100,
      '切片长度=' + matList.length);
    check('★material.list 分支**不得再出现 .limit(100)**（静默截断就是它造成的）',
      matList.indexOf('limit(100)') < 0, matList.indexOf('limit(100)') >= 0 ? '又写回 limit(100) 了' : '（未命中）');
    check('★material.list 分支**必须有 orderBy**（新建的排最前，一定落在拉取窗口内）',
      /orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(matList),
      '命中=' + /orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(matList));
    check('★material.list 必须把截断**说出来**（返回 total / truncated）',
      /total\s*:/.test(matList) && /truncated\s*:/.test(matList),
      'total=' + /total\s*:/.test(matList) + ' truncated=' + /truncated\s*:/.test(matList));

    var dishSrc = fs.readFileSync(path.join(CF, 'dish', 'index.js'), 'utf8');
    var dishList = branchOf(dishSrc, 'list', 'action');
    check('★dish.list 分支不得出现 .limit(100)，且必须有 orderBy',
      dishList.indexOf('limit(100)') < 0 && /orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(dishList),
      'limit100=' + (dishList.indexOf('limit(100)') >= 0) + ' orderBy=' +
      /orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(dishList));
    var invSrc = fs.readFileSync(path.join(CF, 'inventory', 'index.js'), 'utf8');
    check('★inventory 拉食材那处不得出现 .limit(100)，且必须有 orderBy',
      invSrc.indexOf("collection('material').limit(100)") < 0 &&
      /collection\('material'\)\s*\.orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(strip(invSrc)),
      "limit100=" + (invSrc.indexOf("collection('material').limit(100)") >= 0));
    var repSrc = fs.readFileSync(path.join(CF, 'report', 'index.js'), 'utf8');
    check('★report 拉食材那处不得出现 .limit(100)，且必须有 orderBy',
      repSrc.indexOf("collection('material').limit(100)") < 0 &&
      /collection\('material'\)\s*\.orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)/.test(strip(repSrc)),
      "limit100=" + (repSrc.indexOf("collection('material').limit(100)") >= 0));

    /* ---- 11 处检索框的静态守卫：bindinput / 清除 / 空提示 ---- */
    section('★C 组附加：11 处检索框的 wxml 接线（bindinput / 清除 / 空提示）');
    CASES.forEach(function (c) {
      var wxmlPath = path.join(MP, 'pages', c.rel + '.wxml');
      var w = strip(fs.readFileSync(wxmlPath, 'utf8')).replace(/<!--[\s\S]*?-->/g, ' ');
      var hasInput = /bindinput="onSearchInput"/.test(w);
      var hasClear = /bindtap="onSearchClear"/.test(w);
      var hasHint = /没有匹配/.test(w);
      check('【' + c.label + '】wxml 有检索输入框 + 清除按钮 + 空提示文案',
        hasInput && hasClear && hasHint,
        '输入框=' + hasInput + ' 清除=' + hasClear + ' 空提示=' + hasHint);
    });
    check('★全站检索口径统一走 utils/list-search.js（不各页各写一份正则）',
      fs.existsSync(path.join(MP, 'utils', 'list-search.js')),
      '文件=' + fs.existsSync(path.join(MP, 'utils', 'list-search.js')));

    console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
    if (fail > 0) { process.exitCode = 1; }
  });
}).catch(function (e) {
  console.log('\n!!! 套件抛错：' + (e && e.stack || e));
  fail += 1;
  console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  process.exitCode = 1;
});