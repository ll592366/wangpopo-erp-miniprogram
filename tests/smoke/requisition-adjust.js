// ==========================================================================
// tests/smoke/requisition-adjust.js — 要货单「修改数量」（requisition.adjust）专项
//
// 业务需求（老板 2026-10-09）：管理端处理门店要货单时，把「驳回」改成「修改」——
//   管理端直接把数量改成合理的数（每行可改、每行可删），改完后点「确认」才结清库存。
// 2026-10-13 老板拍板凑齐**五件套**（复制 / 修改 / 确认 / 驳回 / 删除）：驳回按钮恢复
//   （待处理卡、必填原因、库存不动），删除按钮新增（**仅终态卡**：已驳回 / 已撤回；
//   pending / confirmed 不给入口）。
//
// 为什么要单独一套：**错了就是多发/少发货**。核心风险是
//   「adjust 改小了数量，confirm 却还按**原申请量**扣总仓 / 加门店」。
//
// 本套重点（★= 核心红线）：
//   ① ★adjust 改小 + 删行 → confirm 后：总仓只减**改后**量、门店只加**改后**量、
//      被删掉那一行**完全不结清**（数字逐个比对，不是「没报错」就算过）
//      并配**反向对照**：同一份种子不 adjust 直接 confirm，数字必须明显更大 ——
//      否则说明差异根本不是 adjust 造成的（桩件/种子做假了自己都发现不了）
//   ② adjust 后库存一点没动、状态仍 pending
//   ③ 权限（门店账号 1003）+ 非 pending 单据（已确认/已驳回/已撤回 → 2002）
//   ④ 入参校验：0 真删 / 负数·非数字·空串 → 2002 / 全删光 → 2002 / 新增 itemId → 2002 /
//      重复 itemId → 2002；且失败必须**整单拒绝**（一行错 = 整单不动，不能悄悄改掉别的行）
//   ⑤ adjustNote 与 op_log：全中文、不含任何 itemId / 门店 _id，删行标「（已删除）」
//   ⑥ list / get 能取到 adjusted / adjustNote
//   ⑦ 15 份平铺副本（auth/constants/db/response）逐字节一致
//   ⑧ 前端静态守卫：五件套（复制/修改/确认/驳回/删除）齐全 + 三把防连点锁都在
//      wx.showModal 之前生效 + wxml 删除按钮 wx:if 限终态；门店端有调整提示
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

/* ERP_ROOT 覆盖项目根：**变异自证专用**（与 list-search.js 同款机制）。
 * 不设该环境变量时 = __dirname 上两级，正常跑法行为与历史完全一致。 */
var PROJECT = process.env.ERP_ROOT
  ? path.resolve(process.env.ERP_ROOT)
  : path.resolve(__dirname, '..', '..');
var MINI = path.join(PROJECT, 'miniprogram');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-radj-' + process.pid);
var FUNCS = ['requisition'];

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
var REQ = require(path.join(WORK, 'requisition', 'index.js'));

var MGR = { _uid: 'u_mgr' };
var SHOP = { _uid: 'u_shop' };
var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ---------------- 种子 ----------------
 * 原单明细：**土豆 5 / 牛肉片 2 / 白菜 3**（故意三种、量各不相同，便于逐数字比对）
 * 总仓库存各 100（足够大，保证不会因为「库存不足」被 2001 拒，掩盖 adjust 的问题）
 * 门店余额：m1/m2 有行（0），m3 **刻意没有行** —— 验证被删的那行连零值行都不会被创建
 */
function seed(status) {
  mock.reset();
  mock.seed('user', [
    { _id: 'u_mgr', name: '王婆婆·管理', username: '888', password: '888888', role: 'manager', storeId: '', isActive: true },
    { _id: 'u_shop', name: '万达店', username: 'wd', password: '123456', role: 'shop', storeId: 'S1', isActive: true }
  ]);
  mock.seed('store', [{ _id: 'S1', code: 'WD', name: '万达店', status: 'open', isActive: true }]);
  mock.seed('material', [
    { _id: 'm1', name: '土豆', unit: '斤', spec: '', lowStockThreshold: 10, isActive: true },
    { _id: 'm2', name: '牛肉片', unit: '盒', spec: '', lowStockThreshold: 4, isActive: true },
    { _id: 'm3', name: '白菜', unit: '斤', spec: '', lowStockThreshold: null, isActive: true },
    { _id: 'm9', name: '松露', unit: 'g', spec: '', lowStockThreshold: 1, isActive: true }
  ]);
  mock.seed('stock_balance', [
    { _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m2', storeId: 'WAREHOUSE', itemId: 'm2', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m3', storeId: 'WAREHOUSE', itemId: 'm3', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_WAREHOUSE_m9', storeId: 'WAREHOUSE', itemId: 'm9', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m1', storeId: 'S1', itemId: 'm1', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
    { _id: 'bal_S1_m2', storeId: 'S1', itemId: 'm2', qty: 0, dayOpenQty: 0, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
    // ★ bal_S1_m3 刻意不存在
  ]);
  mock.seed('requisition', [{
    _id: 'R1', storeId: 'S1', applicantId: 'u_shop',
    items: [{ itemId: 'm1', qty: 5 }, { itemId: 'm2', qty: 2 }, { itemId: 'm3', qty: 3 }],
    status: status || 'pending', createdAt: '2026-10-09T09:00:00.000Z', bizDate: '2026-10-09',
    handledBy: '', handledAt: '', rejectReason: ''
  }]);
  mock.seed('op_log', []);
}

function call(ev, who) { return REQ.main(Object.assign({}, who || MGR, ev)); }
function reqDoc() { return mock.dump('requisition').filter(function (r) { return r._id === 'R1'; })[0]; }
function bal(storeId, itemId) {
  var rows = mock.dump('stock_balance').filter(function (b) { return b.itemId === itemId && b.storeId === storeId; });
  return rows.length ? rows[0].qty : null;    // null = 这一行根本不存在
}
function itemStrs() { return (reqDoc().items || []).map(function (i) { return i.itemId + ':' + i.qty; }).join(','); }
function logs() { return mock.dump('op_log') || []; }
/** 判「有没有内部 _id / itemId 泄漏到给人看的文案里」 */
function leakIn(s) {
  return ['m1', 'm2', 'm3', 'm9', 'S1', 'R1', 'u_mgr', 'u_shop', 'req_', 'bal_'].filter(function (t) {
    return String(s).indexOf(t) >= 0;
  });
}

var ORIG_ITEMS = 'm1:5,m2:2,m3:3';

/* ========================================================================
 * ① 核心：adjust 改小 + 删行 → confirm 按**改后**数量结清
 * ====================================================================== */
section('① ★核心：adjust（土豆 5→2、牛肉片 2→1、删掉白菜）→ confirm 按改后量结清');

seed();
check('（基线）adjust 前：单据 items = ' + ORIG_ITEMS, itemStrs() === ORIG_ITEMS, itemStrs());
check('（基线）adjust 前：门店没有白菜余额行（刻意留的最小面）', bal('S1', 'm3') === null, String(bal('S1', 'm3')));

call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 1 }] }, MGR)
  .then(function (r) {
    check('adjust → code=0', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('adjust 返回的 items 只有 2 行（白菜已删）',
      (r.data && r.data.items || []).length === 2, JSON.stringify(r.data && r.data.items));

    /* ---- ② 库存一点没动 + 状态仍 pending ---- */
    section('② adjust 之后：库存一点没动、状态仍 pending');
    check('总仓 土豆 仍是 100', bal('WAREHOUSE', 'm1') === 100, String(bal('WAREHOUSE', 'm1')));
    check('总仓 牛肉片 仍是 100', bal('WAREHOUSE', 'm2') === 100, String(bal('WAREHOUSE', 'm2')));
    check('总仓 白菜 仍是 100', bal('WAREHOUSE', 'm3') === 100, String(bal('WAREHOUSE', 'm3')));
    check('门店 土豆 仍是 0', bal('S1', 'm1') === 0, String(bal('S1', 'm1')));
    check('门店 牛肉片 仍是 0', bal('S1', 'm2') === 0, String(bal('S1', 'm2')));
    check('门店 白菜 仍**没有**余额行（adjust 不许建行）', bal('S1', 'm3') === null, String(bal('S1', 'm3')));
    check('单据状态仍是 pending', reqDoc().status === 'pending', reqDoc().status);
    check('落库 items = m1:2,m2:1（覆盖生效）', itemStrs() === 'm1:2,m2:1', itemStrs());
    check('adjusted = true / adjustedBy = u_mgr / adjustedAt 有值',
      reqDoc().adjusted === true && reqDoc().adjustedBy === 'u_mgr' && !!reqDoc().adjustedAt,
      JSON.stringify({ adjusted: reqDoc().adjusted, by: reqDoc().adjustedBy, at: reqDoc().adjustedAt }));

    /* ---- ⑤ adjustNote ---- */
    section('⑤ adjustNote + op_log：全中文、按原单顺序、删行标「（已删除）」');
    var note = reqDoc().adjustNote;
    console.log('     adjustNote = ' + JSON.stringify(note));
    check('adjustNote = 土豆 5→2；牛肉片 2→1；白菜 3→0（已删除）',
      note === '土豆 5→2；牛肉片 2→1；白菜 3→0（已删除）', JSON.stringify(note));
    check('★adjustNote 不含任何 itemId / 门店 _id / 单号', leakIn(note).length === 0, leakIn(note).join(',') || '（无泄漏）');
    var alog = logs()[0];
    console.log('     op_log = ' + JSON.stringify(alog && { action: alog.action, target: alog.target, before: alog.before, after: alog.after }));
    check('adjust 写了 1 条 op_log', logs().length === 1, logs().length + ' 条');
    check('op_log.action = requisition.adjust', alog && alog.action === 'requisition.adjust', alog && alog.action);
    check('op_log target/before/after 全中文且不含内部 id',
      alog && leakIn(alog.target).length === 0 && leakIn(alog.before).length === 0 && leakIn(alog.after).length === 0,
      alog ? leakIn(alog.target + '|' + alog.before + '|' + alog.after).join(',') || '（无泄漏）' : '(无 log)');
    check('op_log.after 里带「（已删除）」', alog && alog.after.indexOf('（已删除）') >= 0, alog && alog.after);

    /* ---- ⑥ list / get 透传 ---- */
    return call({ action: 'list' }, MGR);
  }).then(function (r) {
    section('⑥ list / get 透传 adjusted / adjustNote');
    var row = (r.data && r.data.list || []).filter(function (x) { return x._id === 'R1'; })[0];
    check('list 能取到 adjusted = true', row && row.adjusted === true, row && String(row.adjusted));
    check('list 能取到 adjustNote', row && row.adjustNote === '土豆 5→2；牛肉片 2→1；白菜 3→0（已删除）', row && row.adjustNote);
    check('list 返回的 items 是**改后**的（m1:2,m2:1）',
      row && (row.items || []).map(function (i) { return i.itemId + ':' + i.qty; }).join(',') === 'm1:2,m2:1',
      row && (row.items || []).map(function (i) { return i.itemId + ':' + i.qty; }).join(','));
    return call({ action: 'get', requisitionId: 'R1' }, MGR);
  }).then(function (r) {
    var d = r.data && r.data.requisition;
    check('get 能取到 adjusted = true', d && d.adjusted === true, d && String(d.adjusted));
    check('get 能取到 adjustNote', d && d.adjustNote === '土豆 5→2；牛肉片 2→1；白菜 3→0（已删除）', d && d.adjustNote);

    /* ---- ① 续：confirm ---- */
    section('① 续：★confirm —— 总仓只减改后量、门店只加改后量、被删行完全不结清');
    return call({ action: 'confirm', requisitionId: 'R1' }, MGR);
  }).then(function (r) {
    check('confirm → code=0', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('★总仓 土豆：100 − 2（改后）= 98，不是 100 − 5（原量）= 95', bal('WAREHOUSE', 'm1') === 98, String(bal('WAREHOUSE', 'm1')));
    check('★总仓 牛肉片：100 − 1（改后）= 99，不是 100 − 2 = 98', bal('WAREHOUSE', 'm2') === 99, String(bal('WAREHOUSE', 'm2')));
    check('★★总仓 白菜：被删的那行**完全不动**，仍是 100（原量是 3）', bal('WAREHOUSE', 'm3') === 100, String(bal('WAREHOUSE', 'm3')));
    check('★门店 土豆：0 + 2（改后）= 2，不是 0 + 5 = 5', bal('S1', 'm1') === 2, String(bal('S1', 'm1')));
    check('★门店 牛肉片：0 + 1（改后）= 1，不是 0 + 2 = 2', bal('S1', 'm2') === 1, String(bal('S1', 'm2')));
    check('★★门店 白菜：被删的那行**仍然没有余额行**（连零值行都没建）', bal('S1', 'm3') === null, String(bal('S1', 'm3')));
    check('单据状态 confirmed', reqDoc().status === 'confirmed', reqDoc().status);

    /* ---- 反向对照：同一份种子**不 adjust** 直接 confirm ---- */
    section('① 反向对照：同一份种子不 adjust 直接 confirm（数字必须明显更大）');
    seed();
    return call({ action: 'confirm', requisitionId: 'R1' }, MGR);
  }).then(function (r) {
    check('（对照）confirm code=0', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('（对照）总仓 土豆 100 − 5 = 95（与 adjust 后的 98 不同 → 差异确实由 adjust 造成）',
      bal('WAREHOUSE', 'm1') === 95, String(bal('WAREHOUSE', 'm1')));
    check('（对照）总仓 牛肉片 100 − 2 = 98', bal('WAREHOUSE', 'm2') === 98, String(bal('WAREHOUSE', 'm2')));
    check('（对照）总仓 白菜 100 − 3 = 97（adjust 后是 100 → 证明删行真生效）',
      bal('WAREHOUSE', 'm3') === 97, String(bal('WAREHOUSE', 'm3')));
    check('（对照）门店 土豆 0 + 5 = 5', bal('S1', 'm1') === 5, String(bal('S1', 'm1')));
    check('（对照）门店 白菜建了行 → 3（adjust 后是「没有行」）', bal('S1', 'm3') === 3, String(bal('S1', 'm3')));

    /* ========================================================================
     * ③ 权限 + 非 pending
     * ====================================================================== */
    section('③ 权限：门店账号 → 1003；非 pending 单据 → 2002（且整单不动）');
    seed();
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 1 }] }, SHOP);
  }).then(function (r) {
    check('门店账号 adjust → 1003', r.code === 1003, 'code=' + r.code + ' msg=' + r.message);
    check('被拒后单据原样（items 未改、无 adjusted 字段）',
      itemStrs() === ORIG_ITEMS && reqDoc().adjusted === undefined,
      itemStrs() + ' adjusted=' + reqDoc().adjusted);
    check('被拒后没写 op_log', logs().length === 0, logs().length + ' 条');

    var statuses = { confirmed: '已确认', rejected: '已驳回', cancelled: '已撤回' };
    var keys = Object.keys(statuses);
    var i = 0;
    function iterStatus() {
      if (i >= keys.length) { return Promise.resolve(); }
      var st = keys[i]; i += 1;
      seed(st);
      return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 1 }] }, MGR)
        .then(function (r) {
          check(statuses[st] + '（' + st + '）的单据 adjust → 2002',
            r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
          check('  文案含「' + statuses[st] + '」', (r.message || '').indexOf(statuses[st]) >= 0, r.message);
          check('  单据原样未被改动', itemStrs() === ORIG_ITEMS, itemStrs());
          return iterStatus();
        });
    }
    return iterStatus();
  }).then(function () {
    /* ========================================================================
     * ④ 入参校验（每条都要验「整单拒绝」：一行错 = 整单一行都不许改）
     * ====================================================================== */
    section('④ 入参校验：非法输入 → 2002，且必须**整单拒绝**');
    var cases = [
      { name: 'qty = -1（负数）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: -1 }], msgPart: '数量填写不正确' },
      { name: 'qty = -0.5（小数负数）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: -0.5 }], msgPart: '数量填写不正确' },
      { name: 'qty = "abc"（非数字）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 'abc' }], msgPart: '数量填写不正确' },
      { name: 'qty = ""（空串）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: '' }], msgPart: '数量填写不正确' },
      { name: 'qty = null', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: null }], msgPart: '数量填写不正确' },
      { name: '新增原单没有的 itemId（m9 松露）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm9', qty: 1 }], msgPart: '不能新增门店未申请的食材' },
      { name: '同一 itemId 重复（m1 出现两次）', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm1', qty: 1 }], msgPart: '重复出现' },
      { name: '全部填 0（删光）', items: [{ itemId: 'm1', qty: 0 }, { itemId: 'm2', qty: 0 }, { itemId: 'm3', qty: 0 }], msgPart: '至少要留一种食材' },
      { name: 'items = []（空数组）', items: [], msgPart: '至少要留一种食材' }
    ];
    var k = 0;
    function iterCase() {
      if (k >= cases.length) { return Promise.resolve(); }
      var c = cases[k]; k += 1;
      seed();
      return call({ action: 'adjust', requisitionId: 'R1', items: c.items }, MGR).then(function (r) {
        check(c.name + ' → 2002', r.code === 2002, 'code=' + r.code + ' msg=' + r.message);
        check('  文案含「' + c.msgPart + '」', (r.message || '').indexOf(c.msgPart) >= 0, r.message);
        check('  ★整单拒绝：items 仍是 ' + ORIG_ITEMS + '（不是「只跳过错的那行、别的照改」）',
          itemStrs() === ORIG_ITEMS, itemStrs());
        check('  ★整单拒绝：adjusted 字段未被写入', reqDoc().adjusted === undefined, String(reqDoc().adjusted));
        check('  ★整单拒绝：没写 op_log', logs().length === 0, logs().length + ' 条');
        return iterCase();
      });
    }
    return iterCase();
  }).then(function () {
    /* ---- qty = 0 真删 ---- */
    section('④b qty = 0 = 真删：返回与落库都**不含**该行');
    seed();
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 5 }, { itemId: 'm2', qty: 0 }, { itemId: 'm3', qty: 3 }] }, MGR);
  }).then(function (r) {
    check('code=0', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('返回的 items 不含 m2（只剩 m1,m3）',
      (r.data && r.data.items || []).map(function (i) { return i.itemId; }).join(',') === 'm1,m3',
      JSON.stringify(r.data && r.data.items));
    check('落库的 items 不含 m2', itemStrs() === 'm1:5,m3:3', itemStrs());
    check('adjustNote 把删行标成「牛肉片 2→0（已删除）」',
      reqDoc().adjustNote === '牛肉片 2→0（已删除）', JSON.stringify(reqDoc().adjustNote));
    check('★门店端不该看到「牛肉片 0 盒」这种怪行（qty=0 的行确实不在库里）',
      (reqDoc().items || []).every(function (i) { return i.qty > 0; }), itemStrs());

    /* ---- 数量没变 → 明细无变化 ---- */
    section('⑤b 数量一行都没改 → adjustNote = 「明细无变化」');
    seed();
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 5 }, { itemId: 'm2', qty: 2 }, { itemId: 'm3', qty: 3 }] }, MGR);
  }).then(function (r) {
    check('code=0', r.code === 0, 'code=' + r.code);
    check('adjustNote = 明细无变化', reqDoc().adjustNote === '明细无变化', JSON.stringify(reqDoc().adjustNote));
    check('adjusted 仍为 true（点过保存就算调整过）', reqDoc().adjusted === true, String(reqDoc().adjusted));

    /* ---- ⑤c confirm 的 op_log（相邻既有路径，口径第 5 条同样适用） ---- */
    section('⑤c confirm 的 op_log 干不干净（adjus 之后的确认是同一条业务流）');
    seed();
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 1 }] }, MGR);
  }).then(function () {
    return call({ action: 'confirm', requisitionId: 'R1' }, MGR);
  }).then(function () {
    var clog = logs().filter(function (l) { return l.action === 'requisition.confirm'; })[0];
    var leak = clog ? leakIn(clog.target + '|' + clog.before + '|' + clog.after) : [];
    console.log('     confirm op_log = ' + JSON.stringify(clog && { target: clog.target, before: clog.before, after: clog.after }));
    check('confirm 的 op_log target/before/after 也不含内部 id（口径第 5 条）',
      clog && leak.length === 0, clog ? leak.join(',') || '（无泄漏）' : '(无 confirm 日志)');

    /* ---- ⑤d 门店文档缺失/无名时，日志会不会回落成裸 storeId ---- */
    seed();
    mock.reset();   // ⚠️ 会清掉全部集合，下面按需重 seed
    mock.seed('user', [
      { _id: 'u_mgr', name: '王婆婆·管理', username: '888', password: '888888', role: 'manager', storeId: '', isActive: true }
    ]);
    mock.seed('material', [
      { _id: 'm1', name: '土豆', unit: '斤', lowStockThreshold: 10, isActive: true },
      { _id: 'm2', name: '牛肉片', unit: '盒', lowStockThreshold: 4, isActive: true }
    ]);
    mock.seed('stock_balance', [
      { _id: 'bal_WAREHOUSE_m1', storeId: 'WAREHOUSE', itemId: 'm1', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null },
      { _id: 'bal_WAREHOUSE_m2', storeId: 'WAREHOUSE', itemId: 'm2', qty: 100, dayOpenQty: 100, dayInQty: 0, dayOutQty: 0, dayOpenDate: null }
    ]);
    mock.seed('requisition', [{
      _id: 'R1', storeId: 'S1', applicantId: 'u_shop',
      items: [{ itemId: 'm1', qty: 5 }, { itemId: 'm2', qty: 2 }],
      status: 'pending', createdAt: '2026-10-09T09:00:00.000Z', bizDate: '2026-10-09',
      handledBy: '', handledAt: '', rejectReason: ''
    }]);
    mock.seed('op_log', []);
    // ★ store 集合**刻意不 seed** → 门店文档查不到（历史脏数据 / 门店被删）
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 2 }, { itemId: 'm2', qty: 1 }] }, MGR);
  }).then(function (r) {
    var lg = logs()[0];
    check('门店文档查不到时 adjust 仍能成功（不会因为拿不到店名就失败）', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('★门店文档查不到时，op_log 里也没写成裸 storeId（应给占位而不是 S1）',
      lg && leakIn(lg.target).length === 0, lg ? lg.target : '(无 log)');
    return call({ action: 'confirm', requisitionId: 'R1' }, MGR);
  }).then(function (r) {
    var lg = logs().filter(function (l) { return l.action === 'requisition.confirm'; })[0];
    check('（同上）门店文档查不到时 confirm 也能成功', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('★（同上）confirm op_log 也不写裸 storeId',
      lg && leakIn(lg.target).length === 0, lg ? lg.target : '(无 log)');

    return null;
  }).then(function () {
    /* ---- 连续 adjust ---- */
    section('⑥b 连续 adjust：第二次的差异基于**第一次改后**的量算');
    seed();
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 4 }, { itemId: 'm2', qty: 2 }, { itemId: 'm3', qty: 3 }] }, MGR);
  }).then(function (r) {
    return call({ action: 'adjust', requisitionId: 'R1', items: [{ itemId: 'm1', qty: 1 }] }, MGR);
  }).then(function (r) {
    check('第二次 adjust code=0', r.code === 0, 'code=' + r.code + ' ' + (r.message || ''));
    check('落库 items = m1:1（牛肉片/白菜没出现在第二次明细里 = 删除）', itemStrs() === 'm1:1', itemStrs());
    check('第二次 adjustNote = 土豆 4→1；牛肉片 2→0（已删除）；白菜 3→0（已删除）',
      reqDoc().adjustNote === '土豆 4→1；牛肉片 2→0（已删除）；白菜 3→0（已删除）',
      JSON.stringify(reqDoc().adjustNote));
    check('连续两次 adjust 都没动过库存（总仓土豆仍 100）', bal('WAREHOUSE', 'm1') === 100, String(bal('WAREHOUSE', 'm1')));
    return null;
  }).then(function () {
    /* ========================================================================
     * ⑦ 15 份平铺副本一致性
     * ====================================================================== */
    section('⑦ 平铺副本一致性（auth / constants / db / response × 15 个云函数目录）');
    var dirs = fs.readdirSync(CF, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory() && e.name !== '_shared'; })
      .map(function (e) { return e.name; });
    ['auth.js', 'constants.js', 'db.js', 'response.js'].forEach(function (f) {
      var hs = {};
      var n = 0;
      dirs.forEach(function (d) {
        var p = path.join(CF, d, f);
        if (fs.existsSync(p)) {
          var h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
          hs[h] = (hs[h] || 0) + 1;
          n += 1;
        }
      });
      var ks = Object.keys(hs);
      check(f + ' 副本 ' + n + ' 份（14 个云函数目录；_shared 另在下一条单独比对）→ 只有 1 种哈希',
        ks.length === 1, ks.join(',') || '（无）');
    });
    var sharedDb = path.join(CF, '_shared', 'db.js');
    var reqDb = path.join(CF, 'requisition', 'db.js');
    check('requisition/db.js 与 _shared/db.js 逐字节一致',
      crypto.createHash('sha256').update(fs.readFileSync(sharedDb)).digest('hex') ===
      crypto.createHash('sha256').update(fs.readFileSync(reqDb)).digest('hex'));
    check('ADJUST 常量 + auth 映射在**每份**副本里都在', dirs.every(function (d) {
      var c = fs.readFileSync(path.join(CF, d, 'constants.js'), 'utf8');
      var a = fs.readFileSync(path.join(CF, d, 'auth.js'), 'utf8');
      return c.indexOf("REQUISITION_ADJUST: 'requisition.adjust'") >= 0 &&
        /case C\.ACTION\.REQUISITION_ADJUST:\s*return \[C\.ROLE\.MANAGER\];/.test(a);
    }));

    /* ========================================================================
     * ⑧ 前端静态守卫
     * ====================================================================== */
    section('⑧ 前端静态守卫（五件套：复制/修改/确认/驳回/删除 · 防连点锁 · 删除限终态）');
    var rpDir = 'pages/manager/requisition-process/';
    var rpJs = fs.readFileSync(path.join(MINI, rpDir, 'requisition-process.js'), 'utf8');
    var rpWxml = fs.readFileSync(path.join(MINI, rpDir, 'requisition-process.wxml'), 'utf8');
    function strip(s) {
      return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').replace(/<!--[\s\S]*?-->/g, ' ');
    }
    var rpCode = strip(rpJs);
    var rpWX = strip(rpWxml);
    /* ---- ⑧a 五件套静态守卫（老板 2026-10-13：复制 / 修改 / 确认 / 驳回 / 删除）----
     * 旧断言「已没有 rejectReq」是 10-09 驳回改修改那阵立的，驳回已恢复 + 删除已新增 → 全部翻正向。
     * 防连点锁必须落在 wx.showModal **之前**（本页源码注释自述的口径）：modal 弹出期间菜单条
     * 按钮还活着，锁放晚了 = 防不住「连点另一行并发弹两个 modal / 发两笔」。
     * 只查「锁存在」不查位置 = 假绿。 */
    function lockBeforeModal(fnName, lockField) {
      var i = rpCode.indexOf(fnName + ': function');
      if (i < 0) { return { fn: false, lock: false, order: false }; }
      var win = rpCode.slice(i, i + 1800);
      var modalAt = win.indexOf('wx.showModal(');
      var head = modalAt < 0 ? win : win.slice(0, modalAt);
      var lockAt = head.search(new RegExp('if \\(this\\.data\\.' + lockField + '\\)\\s*\\{\\s*return;\\s*\\}'));
      return { fn: true, lock: lockAt >= 0, order: lockAt >= 0 && modalAt > lockAt };
    }
    var confG = lockBeforeModal('confirmReq', '_confirming');
    check('★五件套·确认：confirmReq 函数在 + _confirming 锁在 wx.showModal 之前',
      confG.fn && confG.lock && confG.order,
      '函数=' + confG.fn + ' 锁=' + confG.lock + ' 锁在弹窗前=' + confG.order);
    var rejG = lockBeforeModal('rejectReq', 'rejecting');
    check('★五件套·驳回：rejectReq 函数在 + rejecting 锁在 wx.showModal 之前',
      rejG.fn && rejG.lock && rejG.order,
      '函数=' + rejG.fn + ' 锁=' + rejG.lock + ' 锁在弹窗前=' + rejG.order);
    check('★驳回按钮提交的是 action reject 且带 rejectReason（按钮在、调错动作 = 假驳回）',
      /rejectReq: function[\s\S]{0,2200}?action:\s*'reject'[\s\S]{0,150}?rejectReason:\s*reason/.test(rpCode),
      '（在 rejectReq 函数体内匹配 reject payload）');
    var rmG = lockBeforeModal('removeReq', 'removing');
    check('★五件套·删除：removeReq 函数在 + removing 锁在 wx.showModal 之前',
      rmG.fn && rmG.lock && rmG.order,
      '函数=' + rmG.fn + ' 锁=' + rmG.lock + ' 锁在弹窗前=' + rmG.order);
    check('★删除按钮提交的是 action remove（按钮在、调错动作 = 假删除）',
      /removeReq: function[\s\S]{0,2200}?action:\s*'remove'[\s\S]{0,150}?requisitionId:\s*id/.test(rpCode),
      '（在 removeReq 函数体内匹配 remove payload）');
    check('★删除确认弹窗把后果讲清楚：含「不可恢复」+「不产生任何库存变动」',
      rpCode.indexOf('不可恢复') >= 0 && rpCode.indexOf('不产生任何库存变动') >= 0,
      '不可恢复=' + (rpCode.indexOf('不可恢复') >= 0) + ' 库存不变说明=' + (rpCode.indexOf('不产生任何库存变动') >= 0));
    var pendAt = rpWX.indexOf('wx:for="{{pending}}"');
    var doneAt = rpWX.indexOf('wx:for="{{done}}"');
    var pendingZone = (pendAt >= 0 && doneAt > pendAt) ? rpWX.slice(pendAt, doneAt) : '';
    check('★wxml 驳回按钮在**待处理卡**上（bindtap rejectReq，pending 区）',
      pendingZone.indexOf('bindtap="rejectReq"') >= 0,
      'pending 区驳回按钮=' + (pendingZone.indexOf('bindtap="rejectReq"') >= 0));
    check('★wxml **待处理卡不放删除入口**（removeReq 不得出现在 pending 区）',
      pendingZone.indexOf('removeReq') < 0,
      'pending 区 removeReq 命中=' + (pendingZone.indexOf('removeReq') >= 0));
    var delBtn = rpWX.match(/<text[^>]*bindtap="removeReq"[^>]*>[\s\S]*?<\/text>/);
    var delBtnAt = delBtn ? rpWX.indexOf(delBtn[0]) : -1;
    check('★wxml 删除按钮在**已处理卡**内（元素位置必须在 done 列表区）',
      !!delBtn && doneAt >= 0 && delBtnAt > doneAt,
      '元素位置=' + delBtnAt + ' done 列表起点=' + doneAt);
    check('★wxml 删除按钮 wx:if **精确限定终态**（rejected 或 cancelled），文案必须是「删除」',
      !!delBtn &&
        /wx:if="\{\{item\.status\s*===\s*'rejected'\s*\|\|\s*item\.status\s*===\s*'cancelled'\}\}"/.test(delBtn[0]) &&
        />\s*删除\s*<\/text>/.test(delBtn[0]),
      delBtn ? '元素=' + delBtn[0].replace(/\s+/g, ' ').slice(0, 130) : '（未找到绑定 removeReq 的元素）');
    check('管理端有 openAdjust（修改入口）',
      rpWX.indexOf('bindtap="openAdjust"') >= 0 && rpCode.indexOf('openAdjust: function') >= 0);
    check('弹窗有每行数量输入 + 每行删除',
      rpWX.indexOf('bindinput="onAdjustInput"') >= 0 && rpWX.indexOf('bindtap="onAdjustDel"') >= 0);
    check('底部有「保存」+「保存并确认」两个按钮',
      rpWX.indexOf('bindtap="saveAdjust"') >= 0 &&
      rpWX.indexOf('data-confirm="0"') >= 0 && rpWX.indexOf('data-confirm="1"') >= 0);
    check('保存并确认是 adjust → confirm 两段调用（顺序必须先 adjust）',
      /action: 'adjust'[\s\S]*?action: 'confirm'/.test(rpCode));
    check('前端提交前先本地兜一遍（非数字 / 负数 / 一条不剩）',
      /isNaN\(n\) \|\| !isFinite\(n\) \|\| n < 0/.test(rpCode) && /items\.length === 0/.test(rpCode));
    var shopWxml = strip(fs.readFileSync(path.join(MINI, 'pages/shop/requisition/requisition.wxml'), 'utf8'));
    check('★门店端有「管理端已调整数量」提示，绑 item.adjusted / item.adjustNote',
      shopWxml.indexOf('管理端已调整数量') >= 0 &&
      shopWxml.indexOf('item.adjusted') >= 0 && shopWxml.indexOf('item.adjustNote') >= 0);
    check('管理端卡片上也看得到「已调整：{{adjustNote}}」', rpWX.indexOf('已调整：{{item.adjustNote}}') >= 0);

    /* toast 文案 ≤ 7 个字符（WeChat showToast / showLoading 超长会被截断，本文件注释自述的口径）
     * ⚠️ 上一版是**硬编码文案清单**，源码把「单据已更新，请刷新」改成「请刷新后重试」之后，
     *    清单还停在旧文案 —— 断言红的是"我的常量"，不是"源码"，属于**测试自身的 bug**（假红）。
     *    现在改成**从源码里真扫**：把文件里所有 wx.showToast / wx.showLoading / callWithToast
     *    的字符串字面量 title 抽出来逐条量长度，源码怎么改都跟得上，也堵住"改文案绕过断言"。
     */
    /* 2026-10-09 更新：原先 9 字的「已复制，可粘贴发群」也被改短成「已复制，可粘贴」（7 字），
     * 已经满足 ≤7 的红线 → 不再单列成"历史遗留豁免"，直接并入上面的统一扫描（少一个口子）。
     */
    var LEGACY_TOASTS = [];
    function scanTitles(code) {
      var out = [];
      var re = /wx\.(showToast|showLoading)\(\s*\{[^}]*?title:\s*'([^']*)'/g;
      var m;
      while ((m = re.exec(code)) !== null) { out.push({ api: m[1], t: m[2] }); }
      var re2 = /callWithToast\(\s*'[^']*'\s*,\s*\{[\s\S]*?\}\s*,\s*'([^']*)'/g;
      while ((m = re2.exec(code)) !== null) { out.push({ api: 'callWithToast', t: m[1] }); }
      return out;
    }
    var scanned = scanTitles(rpCode);
    var scannedNew = scanned.filter(function (x) { return LEGACY_TOASTS.indexOf(x.t) < 0; });
    var tooLong = scannedNew.filter(function (x) { return x.t.length > 7; });
    console.log('     源码实扫到 ' + scanned.length + ' 条 toast/loading 文案：' +
      scanned.map(function (x) { return '「' + x.t + '」' + x.t.length + '字'; }).join('  '));
    console.log('     历史遗留（不计入本次）：' + LEGACY_TOASTS.map(function (t) { return '「' + t + '」' + t.length + '字'; }).join('  '));
    // 断言扫描器本身有效：本文件里必须真扫出至少 4 条，否则说明正则失效 → 假绿
    check('★toast 扫描器有效（源码里至少扫出 4 条字面量，扫不到就是正则失效的假绿）',
      scanned.length >= 4, '实扫 ' + scanned.length + ' 条');
    check('★源码里所有 toast / loading 文案 ≤ 7 个字符（超了会被系统截断）', tooLong.length === 0,
      tooLong.length ? '超长：' + tooLong.map(function (x) { return '「' + x.t + '」' + x.t.length + '字'; }).join('、') : '（全部合规）');
    /* 扫描器的**已知盲区**：title 走变量（如 var _t='…超长…'; wx.showToast({title:_t})）时
     * 扫不到字面量 → 上面那条会假绿。补一条反向守卫：禁止 showToast 的 title 用**裸变量**
     * （`title: v.msg` 这种成员表达式不拦，它本身是可控的短文案变量）。
     * 这条是 T4 变异逼出来的 —— 先证明盲区存在，再把盲区堵上。
     */
    var dynTitle = rpCode.match(/showToast\(\s*\{\s*title:\s*[A-Za-z_$][\w$]*\s*[,}]/g);
    check('★不存在「title 走裸变量」的绕过写法（动态 title 是扫描盲区，必须禁掉）',
      !dynTitle, dynTitle ? '命中：' + dynTitle.join(' | ') : '（未命中）');
    check('★上一轮报的超长两条（单据已更新，请刷新 / 操作失败，请重试）已从源码消失',
      rpCode.indexOf('单据已更新，请刷新') < 0 && rpCode.indexOf('操作失败，请重试') < 0,
      '「单据已更新，请刷新」命中=' + (rpCode.indexOf('单据已更新，请刷新') >= 0) +
      '；「操作失败，请重试」命中=' + (rpCode.indexOf('操作失败，请重试') >= 0));

    /* ---- ⑧b 提交精度：云函数是 3 位口径，前端不能再按 2 位截断 ---- */
    section('⑧b ★提交精度：adjust 的数量必须按**3 位**口径下发（云函数 num() = quantizeStock）');
    var fmt = require(path.join(MINI, 'utils', 'format.js'));
    console.log('     实测 fmt.round2(0.334) = ' + fmt.round2(0.334) + ' ；fmt.fmt3(0.334) = ' + fmt.fmt3(0.334));
    check('★前端提交数量不得用 fmt.round2（2 位截断）→ 与云函数 3 位口径不一致',
      rpCode.indexOf('fmt.round2(') < 0,
      rpCode.indexOf('fmt.round2(') >= 0 ? '命中 fmt.round2 → 0.334 会被截成 0.33' : '（未命中）');
    check('★弹窗显示（fmt3，3 位）与提交数量必须是**同一精度**，否则「一个字没改直接保存」也会产生假差异',
      !(rpCode.indexOf('fmt.fmt3(') >= 0 && rpCode.indexOf('fmt.round2(') >= 0),
      '显示 fmt3=' + (rpCode.indexOf('fmt.fmt3(') >= 0) + ' 提交 round2=' + (rpCode.indexOf('fmt.round2(') >= 0) +
      '；fmt3(0.334)=' + fmt.fmt3(0.334) + ' 而 round2(0.334)=' + fmt.round2(0.334));
    // 光断言「没用 round2」不够 —— 有人可能写个 2 位的 qty3。直接验口径是 **1000**（3 位）。
    check('★提交口径必须是 **1000**（3 位），不是 100（2 位）',
      /function qty3\(n\)[\s\S]{0,220}Math\.round\(v \* 1000\) \/ 1000/.test(rpCode) ||
      /qty: Math\.round\(n \* 1000\) \/ 1000/.test(rpCode),
      /Math\.round\([a-z] \* 1000\) \/ 1000/.test(rpCode) ? '（用了 1000）' : '未找到 *1000 的归一化写法');

    console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
    rmrf(WORK);
    process.exitCode = fail === 0 ? 0 : 1;
  }).catch(function (e) {
    console.error('HARNESS ERROR', e && e.stack || e);
    rmrf(WORK);
    process.exitCode = 1;
  });
