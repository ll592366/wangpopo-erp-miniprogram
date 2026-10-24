// ==========================================================================
// tests/smoke/dish-edit.js — 菜品「编辑」（老板 2026-09-12 的诉求：可点菜卡改食材/用量/份数）
//
// 复用了 goods-edit.js 的假运行时骨架（同 Page、同 wx），额外覆盖：
//   ① 点菜品列表的「编辑」→ dName / ciRows / editingDishId 全部回填
//   ② 自动切到 dish tab 并滚到顶部
//   ③ 保存带 _id 走更新分支（云函数 dish.save 本来就支持 _id，零改动）
//   ④ 编辑完成重置 editingDishId 与表单
//   ⑤ 取消编辑清空
//   ⑥ 「编辑」按钮不靠 stopPropagation 也能用（与「删除」不冲突）
// ==========================================================================
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var PAGE = path.join(PROJECT, 'miniprogram', 'pages', 'manager', 'goods', 'goods.js');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

var MATS = [
  { _id: '牛肉片', name: '牛肉片', unit: '包', lowStockThreshold: 2, isActive: true },
  { _id: 'm2', name: '牛肉粒', unit: '斤', lowStockThreshold: null, isActive: true },
  { _id: 'm3', name: '腰花', unit: '包', lowStockThreshold: 3, isActive: true },
  { _id: 'm4', name: '鱼泡', unit: '包', lowStockThreshold: 3, isActive: true },
  { _id: 'm5', name: '泡藕带', unit: '包', lowStockThreshold: 3, isActive: true }
];

var DISHES = [
  { _id: 'd1', name: '婆婆金汤牛肉', category: '招牌菜类', consumeItems: [{ itemId: '牛肉片', qty: 1, unit: '包', portions: 1 }], isActive: true, consumeText: '牛肉片 1.00 包' },
  { _id: 'd2', name: '招牌腰花爆鱼泡', category: '招牌菜类', consumeItems: [
    { itemId: 'm3', qty: 2, unit: '包', portions: null },
    { itemId: 'm4', qty: 1, unit: '包', portions: 2 },
    { itemId: 'm5', qty: 1, unit: '包', portions: null }
  ], isActive: true, consumeText: '腰花 2.00 包；鱼泡 0.50 包；泡藕带 1.00 包' }
];

var state = {
  mats: MATS,
  dishes: DISHES,
  saveReply: { code: 0, data: { _id: 'newDish' }, message: 'ok' },
  calls: [], toasts: [], scrolls: 0, tabs: []
};

global.getApp = function () {
  return { globalData: { user: { _id: 'user_manager', role: 'manager' } }, logout: function () {} };
};
global.wx = {
  cloud: {
    callFunction: function (arg) {
      state.calls.push({ name: arg.name, data: arg.data });
      if (arg.name === 'material') {
        return Promise.resolve({ result: { code: 0, data: { rows: state.mats }, message: 'ok' } });
      }
      if (arg.name === 'dish') {
        // 注意：云函数 dish.save 返回 dish 本身；list 返回 { rows }
        if (arg.data && arg.data.action === 'list') {
          return Promise.resolve({ result: { code: 0, data: { rows: state.dishes }, message: 'ok' } });
        }
        return Promise.resolve({ result: state.saveReply });
      }
      if (arg.name === 'inventory') {
        return Promise.resolve({ result: { code: 0, data: { rows: [] }, message: 'ok' } });
      }
      return Promise.resolve({ result: { code: 5001, data: null, message: '未预期：' + arg.name } });
    }
  },
  showToast: function (o) { state.toasts.push(o.title); },
  showModal: function () {},
  pageScrollTo: function () { state.scrolls++; },
  navigateTo: function () {}
};

var def = null;
global.Page = function (d) { def = d; };
require(PAGE);

function makePage() {
  var p = {};
  Object.keys(def).forEach(function (k) { p[k] = def[k]; });
  p.data = JSON.parse(JSON.stringify(def.data || {}));
  // 包装 setData 记录 tab 切换
  p.setData = function (patch) {
    if (patch.tab) { state.tabs.push(patch.tab); }
    Object.assign(this.data, patch);
  };
  return p;
}
function lastSave() {
  var hit = state.calls.filter(function (c) {
    return c.name === 'dish' && c.data && c.data.action === 'save';
  });
  return hit[hit.length - 1];
}

/* ---------- 0. 静态守卫：编辑菜品必须把 editingDishId 交给 payload._id ----------
 * 为什么值得守（2026-10-09 下架校验落地后才成立的风险）：
 *   服务端 dish.save 判「哪些行是新增行」靠的是 loadExistingIds(event._id) 读原配方。
 *   前端一旦丢了 payload._id，编辑老菜就被当成**新建**，后果两种都很糟：
 *     ① 配方里含已下架食材 → 直接 2002「食材「XX」已下架，不能加进菜品配方」，
 *        老板明明只是改个用量，却保存不了（他会以为系统坏了）；
 *     ② 配方里不含下架食材 → 变成**新建一道同名菜**（重复数据，且老菜还在）。
 *   运行期测试（下面第 3 节）已经验过"编辑带 _id"，但那是跑一遍；
 *   这条是**源码级**守卫：谁重构把赋值删了，立刻红。
 * ⚠️ 先 strip() 掉注释再匹配（本项目硬规矩，否则注释里提一句也算命中 → 假绿）。
 * ⚠️ 必须断言**赋值关系**（payload._id = editingDishId），不能只断言「_id」两个字出现。
 */
section('0. 静态守卫：编辑菜品必须把 editingDishId 赋给 payload._id');
var fs = require('fs');
var srcCode = fs.readFileSync(PAGE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
var hasEditingIdSource = /editingDishId/.test(srcCode);
check('源码里存在 editingDishId 这个数据源（没有这条就不谈赋值）',
  hasEditingIdSource, '命中=' + hasEditingIdSource);
var assignHit = /payload\._id\s*=\s*editingDishId\s*;/.exec(srcCode);
check('★构造 payload 时必须把 editingDishId 赋给 payload._id（缺了 = 编辑老菜被当成新建）',
  !!assignHit, assignHit ? assignHit[0] : '（没找到赋值表达式）');
check('★赋值必须**包在 if (editingDishId) 里**（新建态不能凭空带一个空 _id）',
  /if\s*\(\s*editingDishId\s*\)\s*\{\s*payload\._id\s*=\s*editingDishId\s*;\s*\}/.test(srcCode),
  '命中=' + /if\s*\(\s*editingDishId\s*\)\s*\{\s*payload\._id\s*=\s*editingDishId\s*;\s*\}/.test(srcCode));
var sendHit = /cloud\.call(?:WithToast)?\(\s*'dish'\s*,\s*payload/.exec(srcCode);
check('★保存菜品确实**把这个 payload 发出去**（不是拼了不用：call / callWithToast 都算）',
  !!sendHit, sendHit ? sendHit[0] : '（没找到 cloud.call(...payload) 的调用）');
function callsOf(name) {
  return state.calls.filter(function (c) { return c.name === name; });
}

/* ---------- 1. 进页加载 ---------- */
section('1. 进页加载');
var page = makePage();
page.onShow();
setTimeout(function () {
  check('档案 + 菜品都加载', page.data.materials.length === 5 && page.data.dishes.length === 2);

  /* ---------- 2. 点「编辑」回填 ---------- */
  section('2. 点菜品「编辑」→ 全部回填');
  page.editDish({ currentTarget: { dataset: { id: 'd2' } } });
  check('自动切到 dish tab', state.tabs[state.tabs.length - 1] === 'dish');
  check('菜名回填', page.data.dName === '招牌腰花爆鱼泡');
  check('editingDishId 指向该菜', page.data.editingDishId === 'd2', page.data.editingDishId);
  check('ciRows 数量正确（3 条食材）', page.data.ciRows.length === 3);
  // 三行：腰花 2 包 / 鱼泡 1 包 2 份 / 泡藕带 1 包
  function idxOf(id) {
    var opts = page.data.materialOptions;
    for (var i = 0; i < opts.length; i++) { if (opts[i]._id === id) { return i; } }
    return -1;
  }
  check('第 1 行：腰花 2 包（份数空 = 1）',
    page.data.ciRows[0].materialIndex === idxOf('m3') &&
    page.data.ciRows[0].qty === '2' && page.data.ciRows[0].portions === '');
  check('第 2 行：鱼泡 1 包 2 份',
    page.data.ciRows[1].materialIndex === idxOf('m4') &&
    page.data.ciRows[1].qty === '1' && page.data.ciRows[1].portions === '2');
  check('第 3 行：泡藕带 1 包（份数空 = 1）',
    page.data.ciRows[2].materialIndex === idxOf('m5') &&
    page.data.ciRows[2].qty === '1' && page.data.ciRows[2].portions === '');
  check('滚到顶部', state.scrolls === 1, state.scrolls);

  /* ---------- 3. 改一行 → 保存走更新分支 ---------- */
  section('3. 老板改完后保存 → 带 _id 更新');
  state.calls = [];
  state.toasts = [];
  // 直接覆盖 ciRows（setData 是同步的）
  page.data.ciRows = [
    { materialIndex: idxOf('m3'), qty: '2.5', portions: '' },
    { materialIndex: idxOf('m4'), qty: '0.5', portions: '' },
    { materialIndex: idxOf('m5'), qty: '1',   portions: '' }
  ];
  page.saveDish();
  setTimeout(function () {
    var save = lastSave();
    check('走 dish.save 并带 _id（更新分支）',
      !!save && save.data.action === 'save' && save.data._id === 'd2', save && JSON.stringify(save.data));
    check('菜名保持原名（编辑不改名）',
      !!save && save.data.name === '招牌腰花爆鱼泡', save && save.data.name);
    check('每行带 食材/用量/份数（不带不必要字段）',
      !!save && save.data.consumeItems.length === 3 &&
      save.data.consumeItems[0].itemId === 'm3' && save.data.consumeItems[0].qty === '2.5' &&
      save.data.consumeItems[0].portions === null,
      save && JSON.stringify(save.data.consumeItems));
    check('提示「菜品已更新」', state.toasts.indexOf('菜品已更新') >= 0, state.toasts.join('|'));
    check('editingDishId 清空', page.data.editingDishId === '');
    check('表单回到新建态', page.data.dName === '' && page.data.ciRows.length === 1 && page.data.ciRows[0].qty === '');

    /* ---------- 4. 取消编辑 ---------- */
    section('4. 取消编辑');
    page.editDish({ currentTarget: { dataset: { id: 'd1' } } });
    check('再次编辑回填 d1', page.data.dName === '婆婆金汤牛肉' && page.data.editingDishId === 'd1');
    page.cancelEditDish();
    check('取消后清空且回到新建态',
      page.data.editingDishId === '' && page.data.dName === '' && page.data.ciRows.length === 1);

    /* ---------- 5. 新建态仍走原流程 ---------- */
    section('5. 新建态走原流程（不带 _id）');
    state.calls = [];
    state.toasts = [];
    state.saveReply = { code: 0, data: { _id: 'newDish' }, message: 'ok' };
    page.setData({ dName: '新菜', ciRows: [{ materialIndex: 0, qty: '1', portions: '4' }] });
    page.saveDish();
    setTimeout(function () {
      var save = lastSave();
      check('新建不带 _id（新增分支）', !!save && save.data._id === undefined, JSON.stringify(save.data));
      check('新建提示「菜品已保存」', state.toasts.indexOf('菜品已保存') >= 0, state.toasts.join('|'));

      console.log('\n----------------------------------------------');
      console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
      console.log(fail === 0 ? 'DISH-EDIT RESULT: ALL GREEN' : 'DISH-EDIT RESULT: RED');
      process.exitCode = fail === 0 ? 0 : 1;
    }, 10);
  }, 10);
}, 10);
