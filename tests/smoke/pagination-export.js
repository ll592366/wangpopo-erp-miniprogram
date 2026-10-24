/* ==========================================================================
 * tests/smoke/pagination-export.js
 * 「时间范围内全量导出，不设业务上限」的命门验证。
 *
 * 老板口径（2026-09-19）：「数据既然按时间来，肯定不设计上限啊，时间范围内全量导出啊」。
 * 这句承诺全部押在两件事上，而此前两者**都没有任何行为级覆盖**：
 *   ① 后端 production.list 的 offset 分页不跳不漏 —— 尤其是**同一秒**内产生的多条记录
 *      （同 createdAt 时若没有稳定的次级排序键，分页会跳条 / 重复）
 *   ② 前端 consume-records.fetchAll 按 hasMore 循环拉到"真到底"才停，且各种异常下
 *      要么明确中断、要么保留已拉部分，绝不静默吞掉后半段
 *
 * 本套另覆盖：营业日区间计算（date-range）、CSV 行展开（buildExportRows）、
 * 门店端数据隔离（门店账号不能导出别店）。
 *
 * 注（2026-10-08 已修）：此前本地桩件的 orderBy 只保留最后一次调用（单键覆盖），
 * 而 production 依次 orderBy createdAt desc / _id desc —— 桩件里第二个键被覆盖掉，
 * 于是「次级键是否真的生效」在本地是**假绿**。现桩件已改为累积排序键
 * （sortKeys 数组 + 逐键比较），E 段专门锁死这一点：静态守卫 + 行为断言 + 反向对照。
 * 本套把区间内记录的 createdAt 全部设为同一秒 —— 此时「按 _id desc」正是真机上应有的结果。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CF = path.join(ROOT, 'cloudfunctions');
const MOCK = path.join(__dirname, 'mock-sdk.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-page-'));

/* ---------- 装载后端 production（依赖全在本目录内，扁平拷贝） ---------- */
(function install() {
  const dst = path.join(TMP, 'production');
  fs.cpSync(path.join(CF, 'production'), dst, { recursive: true });
  const nm = path.join(dst, 'node_modules', 'wx-server-sdk');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(nm, 'index.js'),
    'module.exports = require(' + JSON.stringify(MOCK) + ');\n');
})();

const mock = require(MOCK);
const M = mock.__mock;
const main = require(path.join(TMP, 'production', 'index.js')).main;

/* ---------- 计数 ---------- */
let pass = 0, fail = 0;
const fails = [];
function ck(label, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + label + (extra ? '  ->  ' + extra : '')); }
  else { fail++; fails.push(label + ' :: ' + extra); console.log('FAIL  ' + label + '  ->  ' + extra); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function uniqIds(arr) { const s = new Set(); arr.forEach(x => s.add(String(x._id))); return s.size; }

/* ========================= 种子 ========================= */
const SAME_TS = '2026-09-19T10:00:00+08:00';      // 区间内 29 条共享同一秒（最狠的情况）
const BIZ_IN = '2026-09-19';
const FROM = '2026-09-19', TO = '2026-09-19';

function seedAll() {
  M.reset();
  M.seed('store', [
    { _id: 'S1', code: 'S1C', name: 'A店', status: 'open', isActive: true },
    { _id: 'S2', code: 'S2C', name: 'B店', status: 'open', isActive: true },
    { _id: 'WAREHOUSE', code: 'WH', name: '总仓', status: 'open', isActive: true }
  ]);
  M.seed('user', [
    { _id: 'u_mgr', role: 'manager', storeId: '', name: '管理端', isActive: true },
    { _id: 'u_shop', role: 'shop', storeId: 'S1', name: 'A店员', isActive: true }
  ]);
  M.seed('material', [{ _id: 'mat_beef', name: '牛肉', unit: '斤', isActive: true, lowStockThreshold: 2 }]);
  M.seed('dish', [{ _id: 'd_cai', name: '金汤牛肉', isActive: true, consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }] }]);

  const prods = [];
  // S1 区间内 25 条（同一秒）
  for (let i = 1; i <= 25; i++) {
    prods.push({
      _id: 'p_' + pad2(i), storeId: 'S1', dishId: 'd_cai', qty: 1,
      consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }], status: 'confirmed',
      operatorId: 'u_mgr', bizDate: BIZ_IN, createdAt: SAME_TS
    });
  }
  // S2 区间内 4 条（门店隔离用）
  for (let j = 1; j <= 4; j++) {
    prods.push({
      _id: 'q_' + pad2(j), storeId: 'S2', dishId: 'd_cai', qty: 1,
      consumeItems: [{ itemId: 'mat_beef', qty: 0.5 }], status: 'confirmed',
      operatorId: 'u_mgr', bizDate: BIZ_IN, createdAt: SAME_TS
    });
  }
  // S1 区间外：3 条更早
  for (let k = 1; k <= 3; k++) {
    prods.push({
      _id: 'old_' + pad2(k), storeId: 'S1', dishId: 'd_cai', qty: 1,
      consumeItems: [{ itemId: 'mat_beef', qty: 1 }], status: 'confirmed',
      operatorId: 'u_mgr', bizDate: '2026-08-01', createdAt: '2026-08-01T10:00:00+08:00'
    });
  }
  // S1 区间外：2 条更晚
  for (let m = 1; m <= 2; m++) {
    prods.push({
      _id: 'new_' + pad2(m), storeId: 'S1', dishId: 'd_cai', qty: 1,
      consumeItems: [{ itemId: 'mat_beef', qty: 1 }], status: 'confirmed',
      operatorId: 'u_mgr', bizDate: '2026-09-25', createdAt: '2026-09-25T10:00:00+08:00'
    });
  }
  // 打乱插入顺序：证明结果顺序来自排序，而不是插入顺序（否则分页测试是假绿）
  prods.sort(function () { return Math.random() - 0.5; });
  M.seed('production', prods);
}

async function listPage(ev) {
  return main(Object.assign({ action: 'list', _uid: 'u_mgr' }, ev));
}
/** 一路翻页到 hasMore=false，返回收集结果与轨迹 */
async function pageAll(ev, limit) {
  const acc = [], offsets = [], hasMoreSeq = [];
  let offset = 0, hasMore = true, guard = 0;
  while (hasMore) {
    guard += 1;
    if (guard > 50) { throw new Error('分页疑似死循环（已翻 50 页）'); }
    const r = await listPage(Object.assign({}, ev, { offset: offset, limit: limit }));
    if (!r || r.code !== 0) { throw new Error('list 调用失败：' + JSON.stringify(r)); }
    const list = (r.data && r.data.list) || [];
    list.forEach(x => acc.push(x));
    offsets.push(offset);
    hasMoreSeq.push(!!(r.data && r.data.hasMore));
    hasMore = !!(r.data && r.data.hasMore);
    offset += limit;
  }
  return { acc: acc, offsets: offsets, hasMoreSeq: hasMoreSeq };
}

/* ========================= 前端桩件（consume-records） ========================= */
const feState = {
  dataset: [], pageSize: 10, calls: [],
  failAt: null, emptyAt: null, forceHasMore: false
};
global.wx = {
  cloud: {
    callFunction: function (arg) {
      feState.calls.push({ name: arg.name, data: JSON.parse(JSON.stringify(arg.data || {})) });
      const d = arg.data || {};
      const off = Number(d.offset) || 0;
      const lim = Number(d.limit) || 10;
      if (feState.failAt !== null && off === feState.failAt) {
        return Promise.resolve({ result: { code: 5001, data: null, message: 'MOCK 拉取失败' } });
      }
      if (feState.emptyAt !== null && off === feState.emptyAt) {
        return Promise.resolve({ result: { code: 0, data: { list: [], hasMore: true }, message: 'ok' } });
      }
      const slice = feState.dataset.slice(off, off + lim);
      let hasMore = off + lim < feState.dataset.length;
      if (feState.forceHasMore) { hasMore = true; }
      return Promise.resolve({ result: { code: 0, data: { list: slice, hasMore: hasMore }, message: 'ok' } });
    }
  },
  showToast: function () {}, showLoading: function () {}, hideLoading: function () {}
};
global.getApp = function () { return { globalData: { user: { _id: 'u_mgr' } } }; };

const rec = require(path.join(ROOT, 'miniprogram', 'utils', 'consume-records.js'));
const dr = require(path.join(ROOT, 'miniprogram', 'utils', 'date-range.js'));

function resetFe() {
  feState.dataset = []; feState.calls = [];
  feState.failAt = null; feState.emptyAt = null; feState.forceHasMore = false;
}
function mkVideos(n) {
  const a = [];
  for (let i = 1; i <= n; i++) {
    a.push({ _id: 'x_' + pad2(i), dishId: 'd1', qty: 1, bizDate: BIZ_IN, createdAt: SAME_TS, status: 'confirmed', consumeItems: [] });
  }
  return a;
}

/* ========================= 主流程 ========================= */
(async function () {
  console.log('================ 分页 / 全量导出 命门验证 ================');

  /* ---------------- A. 后端 production.list 分页 ---------------- */
  section('A. 后端分页：时间区间过滤 + 同秒记录不跳不漏');
  seedAll();

  const a1 = await listPage({ storeId: 'S1', from: FROM, to: TO, offset: 0, limit: 10 });
  ck('A1 区间过滤生效：区间内 S1 25 条（区间外 5 条被排除）',
    a1.code === 0 && (a1.data.list || []).length === 10,
    '首页 ' + ((a1.data && a1.data.list) || []).length + ' 条');
  ck('A1b 区间外记录不得混入（8 月 / 9-25 的记录不在首页）',
    (a1.data.list || []).every(x => x.bizDate === BIZ_IN),
    'bizDate = ' + Array.from(new Set((a1.data.list || []).map(x => x.bizDate))).join(','));

  const page = await pageAll({ storeId: 'S1', from: FROM, to: TO }, 10);
  ck('A2 翻页拿全 25 条（不跳条）', page.acc.length === 25, '实收 ' + page.acc.length);
  ck('A2b 翻页无重复条（不重条）', uniqIds(page.acc) === 25, '去重后 ' + uniqIds(page.acc));
  ck('A3 hasMore 序列正确 [true,true,false]', page.hasMoreSeq.join(',') === 'true,true,false',
    page.hasMoreSeq.join(','));
  ck('A3b 请求 offset 轨迹 0/10/20', page.offsets.join(',') === '0,10,20', page.offsets.join(','));

  // 同秒记录必须靠稳定的次级键定序：断言 _id 严格降序（真机为 createdAt desc + _id desc）
  const ids = page.acc.map(x => String(x._id));
  let descOk = true;
  for (let i = 1; i < ids.length; i++) { if (ids[i - 1] <= ids[i]) { descOk = false; break; } }
  ck('A4 同秒记录定序稳定（_id 严格降序 · 次级键生效）', descOk, ids[0] + ' … ' + ids[ids.length - 1]);

  const rep1 = await listPage({ storeId: 'S1', from: FROM, to: TO, offset: 0, limit: 10 });
  const rep2 = await listPage({ storeId: 'S1', from: FROM, to: TO, offset: 0, limit: 10 });
  ck('A5 同一 offset 两次结果完全一致（可重复，不是随机序）',
    rep1.data.list.map(x => x._id).join(',') === rep2.data.list.map(x => x._id).join(','));

  const a6 = await listPage({ storeId: 'S1', from: FROM, to: TO, offset: 999, limit: 10 });
  ck('A6 offset 越界：空列表 + hasMore=false（不报错）',
    a6.code === 0 && (a6.data.list || []).length === 0 && a6.data.hasMore === false,
    '[' + a6.code + '] len=' + ((a6.data && a6.data.list) || []).length + ' hasMore=' + (a6.data && a6.data.hasMore));

  const a7 = await listPage({ storeId: 'S2', from: FROM, to: TO, offset: 0, limit: 100 });
  ck('A7 管理端可指定门店：S2 只拿到自己的 4 条',
    a7.code === 0 && (a7.data.list || []).length === 4, '实收 ' + ((a7.data && a7.data.list) || []).length);

  const a8 = await listPage({ from: FROM, to: TO, offset: 0, limit: 100 });
  ck('A8 管理端不传 storeId = 全部门店（29 条）',
    a8.code === 0 && (a8.data.list || []).length === 29, '实收 ' + ((a8.data && a8.data.list) || []).length);

  const a9 = await main({ action: 'list', from: FROM, to: TO, offset: 0, limit: 100, _uid: 'u_shop' });
  const a9rows = (a9.data && a9.data.list) || [];
  ck('A9 门店端强制本店：不传 storeId 也只拿到 S1 的 25 条',
    a9.code === 0 && a9rows.length === 25 && a9rows.every(x => x.storeId === 'S1'),
    '实收 ' + a9rows.length);
  const a10 = await main({ action: 'list', from: FROM, to: TO, storeId: 'S2', offset: 0, limit: 100, _uid: 'u_shop' });
  const a10rows = (a10.data && a10.data.list) || [];
  ck('A9b 门店端不能越店导出：显式传 storeId=S2 仍只返回本店 S1',
    a10.code === 0 && a10rows.length === 25 && a10rows.every(x => x.storeId === 'S1'),
    '实收 ' + a10rows.length);

  /* ---------------- B. 前端 fetchAll 循环拉全量 ---------------- */
  section('B. 前端 fetchAll：按 hasMore 循环拉到真到底');
  resetFe();
  feState.dataset = mkVideos(30);          // 30 条 / 每页 10 → 末页正好满页，靠 hasMore=false 停
  const b1 = await rec.fetchAll({ from: FROM, to: TO, pageSize: 10 });
  ck('B1 拿全 30 条（末页正好满页仍靠 hasMore 停）',
    b1.code === 0 && b1.list.length === 30 && b1.interrupted === false,
    'code=' + b1.code + ' len=' + b1.list.length + ' interrupted=' + b1.interrupted);
  ck('B1b 无重复条', new Set(b1.list.map(x => x._id)).size === 30,
    '去重后 ' + new Set(b1.list.map(x => x._id)).size);
  ck('B2 顺序与后端一致（offset 0/10/20，共 3 次请求）',
    feState.calls.map(c => Number(c.data.offset) || 0).join(',') === '0,10,20',
    feState.calls.map(c => Number(c.data.offset) || 0).join(','));
  ck('B2b 请求真的是 production.list（不是自造接口）',
    feState.calls.every(c => c.name === 'production' && c.data.action === 'list'),
    feState.calls[0].name + '.' + feState.calls[0].data.action);
  ck('B2c 已自动附带 _uid（cloud.js 从 globalData 补）',
    feState.calls.every(c => c.data._uid === 'u_mgr'), feState.calls[0].data._uid);

  resetFe();
  feState.dataset = mkVideos(25);
  feState.emptyAt = 20;                    // 防呆：应到底却仍说 hasMore
  const b3 = await rec.fetchAll({ from: FROM, to: TO, pageSize: 10 });
  ck('B3 空页仍报 hasMore → 明确中断（不死循环），保留已拉 20 条',
    b3.interrupted === true && b3.list.length === 20 && /加载中断/.test(String(b3.reason)),
    'len=' + b3.list.length + ' interrupted=' + b3.interrupted + ' reason=' + b3.reason);

  resetFe();
  feState.dataset = mkVideos(30);
  feState.failAt = 10;                     // 第 2 页失败
  const b4 = await rec.fetchAll({ from: FROM, to: TO, pageSize: 10 });
  ck('B4 中途请求失败 → code 透出 + 保留已拉部分（供"用部分继续导出"）',
    b4.code === 5001 && b4.interrupted === true && b4.list.length === 10,
    'code=' + b4.code + ' len=' + b4.list.length);

  resetFe();
  feState.dataset = mkVideos(25);
  feState.forceHasMore = true;             // 末页 5 条却仍报 hasMore → 靠"不足一页"兜底
  const b5 = await rec.fetchAll({ from: FROM, to: TO, pageSize: 10 });
  ck('B5 不足一页视为到底：25 条 / 3 次请求 / 不误报中断',
    b5.list.length === 25 && b5.interrupted === false && feState.calls.length === 3,
    'len=' + b5.list.length + ' calls=' + feState.calls.length);

  resetFe();
  feState.dataset = mkVideos(5);
  const b6 = await rec.fetchAll({ from: FROM, to: TO, pageSize: 10 });
  ck('B6 门店端：不传 storeId 时请求体不含 storeId（后端按登录账号收敛）',
    feState.calls.length === 1 && !('storeId' in feState.calls[0].data),
    JSON.stringify(feState.calls[0].data));
  resetFe();
  feState.dataset = mkVideos(5);
  const b7 = await rec.fetchAll({ storeId: 'S1', from: FROM, to: TO, pageSize: 10 });
  ck('B7 管理端：传了 storeId 就下发 storeId',
    feState.calls.length === 1 && feState.calls[0].data.storeId === 'S1',
    JSON.stringify(feState.calls[0].data));
  ck('B7b from/to 必须下发（否则后端会退化成"仅当日"）',
    feState.calls[0].data.from === FROM && feState.calls[0].data.to === TO,
    feState.calls[0].data.from + '~' + feState.calls[0].data.to);
  void b6; void b7;

  /* ---------------- C. CSV 行展开 ---------------- */
  section('C. 导出行展开（buildExportRows）：一菜多食材拆多行');
  const built = rec.buildExportRows([
    {
      _id: 'p1', dishId: 'd1', qty: 2, bizDate: BIZ_IN, createdAt: '2026-09-19T10:07:00+08:00', status: 'confirmed',
      consumeItems: [{ itemId: 'm1', qty: 0.6666666 }, { itemId: 'm2', qty: 1 }]
    },
    {
      _id: 'p2', dishId: 'd9', qty: 1, bizDate: BIZ_IN, createdAt: '2026-09-19T11:30:00+08:00', status: 'reversed',
      consumeItems: []
    },
    {
      _id: 'p3', dishId: 'd_gone', qty: 3, bizDate: BIZ_IN, createdAt: '2026-09-19T12:00:00+08:00', status: 'confirmed',
      consumeItems: [{ itemId: 'm_gone', qty: 2 }]
    }
  ], { m1: { name: '牛肉片', unit: '包' }, m2: { name: '土豆', unit: '斤' } },
    { d1: { name: '金汤牛肉' }, d9: { name: '无配方菜' } });

  ck('C1 表头顺序固定（日期,时间,菜品,份数,状态,食材,单位,消耗量）',
    built.headers.join(',') === '日期,时间,菜品,份数,状态,食材,单位,消耗量', built.headers.join(','));
  ck('C2 一条 2 食材拆 2 行 + 无食材 1 行 + 缺档 1 行 = 4 行', built.rows.length === 4,
    '实得 ' + built.rows.length);
  ck('C3 同单据多行前 5 列重复（便于做数据透视）',
    built.rows[0].slice(0, 5).join('|') === built.rows[1].slice(0, 5).join('|'),
    built.rows[0].slice(0, 5).join('|'));
  ck('C4 消耗量按 0.001 精度（0.6666666 → 0.667）', built.rows[0][7] === '0.667', built.rows[0][7]);
  ck('C5 时间取 HH:MM', built.rows[0][1] === '10:07', built.rows[0][1]);
  ck('C6 食材名/单位回查档案', built.rows[0][5] === '牛肉片' && built.rows[0][6] === '包',
    built.rows[0][5] + '/' + built.rows[0][6]);
  ck('C7 已撤回记录状态列写「已撤回」', built.rows[2][4] === '已撤回', built.rows[2][4]);
  ck('C8 无消耗清单：食材/单位/消耗量留空但仍占 1 行',
    built.rows[2][5] === '' && built.rows[2][6] === '' && built.rows[2][7] === '',
    JSON.stringify(built.rows[2]));
  ck('C9 档案已删兜底：菜名/食材回退 id 不崩',
    /d_gone/.test(built.rows[3][2]) && /m_gone/.test(built.rows[3][5]),
    built.rows[3][2] + ' / ' + built.rows[3][5]);

  /* ---------------- D. 营业日区间计算 ---------------- */
  section('D. date-range：四档区间计算（后端靠它做营业日过滤）');
  ck('D1 四档顺序：本周/本月/自定义/全部',
    dr.PRESETS.map(x => x.key).join(',') === 'week,month,custom,all',
    dr.PRESETS.map(x => x.label).join('/'));
  // 关键：任何一档都必须给出**非空显式区间**，否则 production.list 会落到
  // `else if (!event.all) where.bizDate = today` 分支 ——「全部」会被悄悄降级成「今日」
  const allKinds = ['today', 'week', 'month', 'custom', 'all'];
  const allExplicit = allKinds.every(function (k) {
    const r = dr.rangeOf(k, { from: '2026-09-01', to: '2026-09-19' });
    return /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to);
  });
  ck('D2 每档都产出显式 from/to（防「全部」被降级成「仅当日」）', allExplicit);
  const rAll = dr.rangeOf('all');
  ck('D3 全部档：from 取极早 + to 取今日（区间非空）',
    rAll.from === '1970-01-01' && rAll.to === dr.today(), rAll.from + '~' + rAll.to);
  const rWeek = dr.rangeOf('week');
  ck('D4 本周档：from = 本周一（中国习惯周一为一周起点）',
    rWeek.from === dr.weekStart(dr.today()) && new Date(rWeek.from).getDay() === 1,
    rWeek.from + '~' + rWeek.to);
  const rMonth = dr.rangeOf('month');
  ck('D5 本月档：from = 本月 1 号 + to = 今日',
    rMonth.from.slice(0, 7) === dr.today().slice(0, 7) && rMonth.from.slice(-2) === '01' && rMonth.to === dr.today(),
    rMonth.from + '~' + rMonth.to);
  const rev = dr.normCustom({ from: '2026-09-19', to: '2026-09-01' });
  ck('D6 自定义区间 from>to 自动纠正', rev.from === '2026-09-19' && rev.to === '2026-09-19',
    rev.from + '~' + rev.to);
  const bad = dr.normCustom({ from: 'x', to: '' });
  ck('D7 自定义区间非法值兜底成本月（不产生非法查询）',
    /^\d{4}-\d{2}-\d{2}$/.test(bad.from) && /^\d{4}-\d{2}-\d{2}$/.test(bad.to),
    bad.from + '~' + bad.to);
  ck('D8 导出文件名标签：全部档 → 全部（其余为日期串，防重名）',
    dr.rangeTag('all') === '全部' && /^\d{8}(-\d{8})?$/.test(dr.rangeTag('custom', { from: '2026-09-01', to: '2026-09-19' })),
    dr.rangeTag('all') + ' / ' + dr.rangeTag('custom', { from: '2026-09-01', to: '2026-09-19' }));
  ck('D9 空态文案随档位变化（不是永远一句"暂无数据"）',
    dr.emptyText('all') === '暂无消耗记录' && /本月暂无消耗记录/.test(dr.emptyText('month')),
    dr.emptyText('all') + ' | ' + dr.emptyText('month'));

  /* ======================================================================
   * E. 分页排序「双排序键」守卫（2026-10-08）
   *    铁律：分页查询必须 orderBy('createdAt','desc') 且紧跟 orderBy('_id','desc')。
   *    缺次级键 → 同秒记录翻页会跳条/重条。此前既无守卫，桩件又是单键覆盖 → 双重假绿。
   * ====================================================================== */
  section('E. 分页排序双键守卫（静态扫描 + 次级键行为断言 + 反向对照）');

  /* ---- E1 静态守卫：逐处检查所有分页查询（出现 .skip( 即视为分页） ---- */
  const fnDirs = fs.readdirSync(CF).filter(function (d) {
    if (d.charAt(0) === '_') { return false; }              // 跳过 _shared / _legacy_*
    // migrate 是归档件（备而不用 / DO NOT DEPLOY，见其文件头注释）：它的 loadAll()
    // 连单键 orderBy 都没有，属于已知且不被使用的历史路径，不纳入本守卫。
    // （已单独上报；若将来要复活 migrate，必须先给它补双排序键。）
    if (d === 'migrate') { return false; }
    try { return fs.statSync(path.join(CF, d)).isDirectory(); } catch (e) { return false; }
  });
  const DUAL_RE = /\[\s*'createdAt'\s*,\s*'desc'\s*\]\s*,\s*\[\s*'_id'\s*,\s*'desc'\s*\]/;
  const CHAIN_RE = /orderBy\(\s*'createdAt'\s*,\s*'desc'\s*\)[\s\S]{0,80}?orderBy\(\s*'_id'\s*,\s*'desc'\s*\)/;
  let skipSites = 0;
  const badSort = [];
  fnDirs.forEach(function (d) {
    const f = path.join(CF, d, 'index.js');
    if (!fs.existsSync(f)) { return; }
    const src = fs.readFileSync(f, 'utf8');
    let i = -1;
    while ((i = src.indexOf('.skip(', i + 1)) >= 0) {
      skipSites++;
      const win = src.slice(Math.max(0, i - 600), i + 300);   // 分页表达式所在上下文窗口
      if (!DUAL_RE.test(win) && !CHAIN_RE.test(win)) {
        badSort.push(d + '/index.js 第 ' + src.slice(0, i).split('\n').length + ' 行附近 .skip() 缺次级排序键 _id');
      }
    }
  });
  ck('E1a 扫描到分页查询点（>0，证明扫描器本身有效）', skipSites > 0, skipSites + ' 处 .skip()');
  ck('E1b 每处分页查询都带 createdAt desc + _id desc 双排序键', badSort.length === 0,
    badSort.length ? badSort.join(' | ') : '全部合规');

  /* ---- E2 production 分页读取器：orders 必须双键且逐个应用 ---- */
  const prodSrc = fs.readFileSync(path.join(CF, 'production', 'index.js'), 'utf8');
  ck('E2a readPage 逐个应用 orders（forEach 累积，不是只取最后一个）',
    /\(orders\s*\|\|\s*\[\]\)\.forEach/.test(prodSrc), '(orders||[]).forEach');
  const callSites = prodSrc.match(/read(?:All)?Page[a-z]*\((?:[^()]|\([^()]*\))*\)/g) || [];
  // 只看「传了字面量 orders 数组」的真实调用点；函数声明与内部递归传的是 orders 变量，不算
  const literalCalls = callSites.filter(function (s) { return s.indexOf('[') >= 0; });
  const badCall = literalCalls.filter(function (s) { return !DUAL_RE.test(s); });
  ck('E2b production 分页调用点全部传双键 orders（且确有分页调用点）',
    literalCalls.length >= 2 && badCall.length === 0,
    literalCalls.length + ' 处字面量调用，缺键 ' + badCall.length + ' 处');

  /* ---- E3 行为断言：次级键真的参与了排序（桩件判别力） ---- */
  const dbSort = mock.database();
  function idsOf(res) { return (res.data || []).map(function (x) { return x._id; }); }
  function qIds(coll) { return function () { return dbSort.collection(coll); }; }
  const dualKey = function (coll) {
    return dbSort.collection(coll).orderBy('createdAt', 'desc').orderBy('_id', 'desc').get().then(idsOf);
  };
  const primaryOnly = function (coll) {
    return dbSort.collection(coll).orderBy('createdAt', 'desc').get().then(idsOf);
  };
  const secondOnly = function (coll) {
    return dbSort.collection(coll).orderBy('_id', 'desc').get().then(idsOf);
  };

  // E3a 全同一秒：双键结果 == 只按 _id desc；E3b != 只按 createdAt；E3c 反向对照
  M.reset();
  const sameTs = [];
  for (let i = 1; i <= 6; i++) {
    sameTs.push({ _id: 'k_' + (10 + i), createdAt: '2026-10-08T10:00:00+08:00', seq: i });
  }
  M.seed('tsort', sameTs);
  return dualKey('tsort').then(function (dual) {
    return secondOnly('tsort').then(function (onlySecond) {
      return primaryOnly('tsort').then(function (onlyPrimary) {
        ck('E3a 双键排序 == 只按次级键 _id desc（createdAt 全同）',
          JSON.stringify(dual) === JSON.stringify(onlySecond), dual.join(','));
        ck('E3b 双键排序 != 只按 createdAt（证明次级键真的参与裁决）',
          JSON.stringify(dual) !== JSON.stringify(onlyPrimary),
          '双键=' + dual.join(',') + ' / 单键=' + onlyPrimary.join(','));
        ck('E3c 反向对照：去掉次级键后顺序发生变化（断言有判别力）',
          JSON.stringify(dual) !== JSON.stringify(onlyPrimary),
          '去键后=' + onlyPrimary.join(','));
        // E3d 混合：主键优先 + 同层内次键裁决
        M.reset();
        M.seed('tsort', [
          { _id: 'a', createdAt: '2026-10-08T10:00:00+08:00' },
          { _id: 'c', createdAt: '2026-10-08T09:00:00+08:00' },
          { _id: 'b', createdAt: '2026-10-08T10:00:00+08:00' },
          { _id: 'd', createdAt: '2026-10-08T11:00:00+08:00' }
        ]);
        return dualKey('tsort');
      });
    });
  }).then(function (mixed) {
    ck('E3d 主键优先 + 同层内次键裁决（d → b,a → c）',
      JSON.stringify(mixed) === JSON.stringify(['d', 'b', 'a', 'c']), mixed.join(','));

    // E3h 与「独立参考实现」对拍：桩件双键结果必须等于手写的 (createdAt desc, _id desc) 排序。
    // 这条在「orderBy 退化成单键覆盖」时会立刻变红 → 比 E3a~E3c 更强的判别力。
    M.reset();
    const mix2 = [];
    const stamps = ['2026-10-08T10:00:00+08:00', '2026-10-08T10:00:00+08:00',
      '2026-10-08T12:00:00+08:00', '2026-10-08T09:00:00+08:00', '2026-10-08T12:00:00+08:00'];
    ['m3', 'm1', 'm5', 'm2', 'm4'].forEach(function (id, i) { mix2.push({ _id: id, createdAt: stamps[i] }); });
    M.seed('tsort', mix2);
    var ref = mix2.slice().sort(function (x, y) {
      if (x.createdAt !== y.createdAt) { return x.createdAt < y.createdAt ? 1 : -1; }
      if (x._id === y._id) { return 0; }
      return x._id < y._id ? 1 : -1;
    }).map(function (x) { return x._id; });
    return dualKey('tsort').then(function (got) {
      ck('E3h 桩件双键排序 == 独立参考实现（createdAt desc → _id desc）',
        JSON.stringify(got) === JSON.stringify(ref), '桩件=' + got.join(',') + ' 参考=' + ref.join(','));
      return true;
    });
  }).then(function () {

    // E3e/f/g 同秒 25 条双键翻页：不跳条、不重条、严格降序
    M.reset();
    const many = [];
    for (let i = 1; i <= 25; i++) {
      many.push({ _id: 'p_' + (i < 10 ? '0' + i : '' + i), createdAt: '2026-10-08T10:00:00+08:00', i: i });
    }
    M.seed('tsort', many);
    function loopPage(offset, acc) {
      acc = acc || [];
      return dbSort.collection('tsort')
        .orderBy('createdAt', 'desc').orderBy('_id', 'desc')
        .skip(offset).limit(10).get()
        .then(function (r) {
          const batch = idsOf(r);
          acc = acc.concat(batch);
          if (batch.length < 10) { return acc; }
          return loopPage(offset + batch.length, acc);
        });
    }
    return loopPage(0, []);
  }).then(function (allIds) {
    ck('E3e 同秒 25 条双键翻页：拿全 25 条', allIds.length === 25, allIds.length + ' 条');
    ck('E3f 同秒 25 条双键翻页：无重复条', new Set(allIds).size === 25, '去重后 ' + new Set(allIds).size);
    ck('E3g 同秒 25 条双键翻页：严格 _id 降序', allIds[0] === 'p_25' && allIds[24] === 'p_01',
      allIds[0] + ' … ' + allIds[allIds.length - 1]);
  });
})().then(function () {
  /* ---------------- 汇总 ---------------- */
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  if (fail) {
    fails.forEach(function (f) { console.log('  ✗ ' + f); });
    console.log('PAGINATION-EXPORT RESULT: HAS FAILURE');
    process.exitCode = 1;
  } else {
    console.log('PAGINATION-EXPORT RESULT: ALL GREEN');
  }
}).catch(function (e) {
  console.log('FATAL ' + (e && e.stack || e));
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + (fail + 1));
  process.exitCode = 1;
});
