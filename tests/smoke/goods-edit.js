// ==========================================================================
// tests/smoke/goods-edit.js — 食材档案「编辑」运行期测试
//
// 背景（2026-09-12 老板截图）：采购页选中"牛肉片"后规格显示"未填"。
// 查因：种子 64 个食材是用 M(id,name,unit) 生成的，**本来就没 spec**；
//       而档案页原来只有"新建 + 停用/启用"，没有编辑入口 → 老板补不了规格。
//
// 本套用假 Page / wx / getApp 把 pages/manager/goods/goods.js 真跑起来，验：
//   ① 编辑回填：点「编辑」把该条档案（含空规格）填进表单
//   ② 保存带 _id 走更新分支，规格真的提交上去
//   ③ 编辑模式**不触发采购入库**（不重复扣/加库存）
//   ④ 新建模式仍会按初始数量记一笔入库流水
//   ⑤ 取消编辑清空回新建态
//   ⑥ 名称/单位必填拦截；后端重名(3002)不炸
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
  { _id: '牛肉片', name: '牛肉片', unit: '包', lowStockThreshold: 2, isActive: true },   // 种子档案：无 spec
  { _id: 'm2', name: '牛肉粒', unit: '斤', spec: '2.5kg/包', lowStockThreshold: null, isActive: true },
  { _id: 'm3', name: '停用菜', unit: '斤', lowStockThreshold: 3, isActive: false }
];

var state = {
  mats: MATS,
  saveReply: { code: 0, data: { _id: 'newX' }, message: 'ok' },
  calls: [], toasts: [], scrolls: 0
};

global.getApp = function () {
  return { globalData: { user: { _id: 'user_manager', role: 'manager' } }, logout: function () {} };
};
global.wx = {
  cloud: {
    callFunction: function (arg) {
      state.calls.push({ name: arg.name, data: arg.data });
      if (arg.name === 'material' && arg.data.action === 'save') {
        return Promise.resolve({ result: state.saveReply });
      }
      if (arg.name === 'material') {
        return Promise.resolve({ result: { code: 0, data: { rows: state.mats }, message: 'ok' } });
      }
      if (arg.name === 'inventory') {
        return Promise.resolve({ result: { code: 0, data: { rows: [{ itemId: '牛肉片', qty: 7 }] }, message: 'ok' } });
      }
      if (arg.name === 'dish') {
        return Promise.resolve({ result: { code: 0, data: { rows: [] }, message: 'ok' } });
      }
      if (arg.name === 'purchase') {
        return Promise.resolve({ result: { code: 0, data: { purchase: { qty: arg.data.qty } }, message: 'ok' } });
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
  p.setData = function (patch) { Object.assign(this.data, patch); };
  return p;
}
function lastCall(name) {
  var hit = state.calls.filter(function (c) { return c.name === name; });
  return hit[hit.length - 1];
}
/** 只看 material.save（保存成功后会再发一次 list 刷新，别被它盖掉） */
function lastSave() {
  var hit = state.calls.filter(function (c) {
    return c.name === 'material' && c.data && c.data.action === 'save';
  });
  return hit[hit.length - 1];
}
function callsOf(name) {
  return state.calls.filter(function (c) { return c.name === name; });
}

/* ---------- 1. 进页加载 ---------- */
section('1. 进页加载档案 + 库存');
var page = makePage();
page.onShow();
setTimeout(function () {
  check('档案列表已加载', page.data.materials.length === 3, page.data.materials.length);
  check('库存已并入列表（牛肉片 7）',
    page.data.materials[0].stock === 7, page.data.materials[0].stock);

  /* ---------- 2. 编辑回填（补规格的入口） ---------- */
  section('2. 点「编辑」回填表单');
  page.editMaterial({ currentTarget: { dataset: { id: '牛肉片' } } });
  check('editingId 指向该档案', page.data.editingId === '牛肉片', page.data.editingId);
  check('名称回填', page.data.mName === '牛肉片');
  check('规格回填为空串（档案本来就没规格）', page.data.mSpec === '');
  check('单位回填', page.data.mUnit === '包');
  check('预警值回填为字符串', page.data.mTh === '2', page.data.mTh);
  check('数量回填为总仓现值（牛肉片 7 · 可就地覆盖）', page.data.mQty === '7', page.data.mQty);
  check('预填值同步记到 mQtyOrigin（用于判有没有改）', page.data.mQtyOrigin === '7', page.data.mQtyOrigin);
  check('滚动到表单位置', state.scrolls === 1, state.scrolls);

  page.editMaterial({ currentTarget: { dataset: { id: 'm2' } } });
  check('阈值缺省的档案回填为空串（不显示 null）', page.data.mTh === '', JSON.stringify(page.data.mTh));
  check('有规格的档案规格回填正确', page.data.mSpec === '2.5kg/包');
  page.editMaterial({ currentTarget: { dataset: { id: 'm2' } } });

  /* ---------- 3. 保存修改 ---------- */
  section('3. 保存修改 → 带 _id 更新 + 不动库存');
  state.calls = [];
  state.toasts = [];
  page.setData({ mSpec: '2.5kg/包', mTh: '3' });
  page.saveMaterial();
  setTimeout(function () {
    var save = lastSave();
    check('走 material.save 并带 _id（更新分支）',
      !!save && save.data.action === 'save' && save.data._id === 'm2', save && JSON.stringify(save.data));
    check('规格真的提交上去', save.data.spec === '2.5kg/包');
    check('预警值提交为 3', String(save.data.lowStockThreshold) === '3');
    check('没有触发采购入库（不重复动库存）', callsOf('purchase').length === 0);
    check('提示「档案已更新」', state.toasts.indexOf('档案已更新') >= 0, state.toasts.join('|'));
    check('表单回到新建态', page.data.editingId === '' && page.data.mName === '' && page.data.mSpec === '');

    /* ---------- 4. 取消编辑 ---------- */
    section('4. 取消编辑');
    page.editMaterial({ currentTarget: { dataset: { id: 'm2' } } });
    page.cancelEdit();
    check('取消后清空且回到新建态',
      page.data.editingId === '' && page.data.mName === '' && page.data.mUnit === '' && page.data.mTh === '');

    /* ---------- 5. 新建仍按初始数量入库 ---------- */
    section('5. 新建档案 + 初始数量 → 记一笔入库流水');
    state.calls = [];
    state.toasts = [];
    state.saveReply = { code: 0, data: { _id: 'newX' }, message: 'ok' };
    page.setData({ mName: '新食材', mSpec: '10kg/袋', mUnit: '袋', mTh: '4', mQty: '50' });
    page.saveMaterial();
    setTimeout(function () {
      var save = lastSave();
      check('新建不带 _id（新增分支）', !!save && save.data._id === undefined, JSON.stringify(save.data));
      var pur = lastCall('purchase');
      check('按 itemId 记入库', !!pur && pur.data.itemId === 'newX' && String(pur.data.qty) === '50',
        pur && JSON.stringify(pur.data));
      check('新建提示「档案已建立」', state.toasts.indexOf('档案已建立') >= 0, state.toasts.join('|'));

      /* ---------- 6. 校验与后端拒绝 ---------- */
      section('6. 必填校验 · 后端重名不炸');
      state.calls = [];
      state.toasts = [];
      page.setData({ mName: '', mUnit: '袋' });
      page.saveMaterial();
      check('名称为空拦住且不发请求', state.calls.length === 0 && state.toasts.join('|').indexOf('请填食材名称') >= 0);

      state.calls = [];
      state.toasts = [];
      page.setData({ mName: '牛肉片', mUnit: '' });
      page.saveMaterial();
      check('单位为空拦住', state.calls.length === 0 && state.toasts.join('|').indexOf('请填单位') >= 0);

      state.calls = [];
      state.toasts = [];
      state.saveReply = { code: 3002, data: null, message: '食材已存在：牛肉片' };
      page.setData({ mName: '牛肉片', mUnit: '包', mQty: '' });
      var threw = false;
      try { page.saveMaterial(); } catch (e) { threw = true; }
      setTimeout(function () {
        check('后端 3002 不抛异常', threw === false);
        check('后端 3002 会提示给老板（人话，无 [code] 前缀）',
          state.toasts.join('|').indexOf('已存在') >= 0 && !/\[\d+\]/.test(state.toasts.join('|')), state.toasts.join('|'));
        check('重名失败不清空表单（老板要能改）', page.data.mName === '牛肉片', page.data.mName);

        /* ---------- 7. 编辑改总仓数量 → 覆盖式调整（同值/留空不动） ---------- */
        section('7. 编辑改总仓数量 → inventory.adjust 覆盖（同值/留空不动）');
        state.calls = [];
        state.toasts = [];
        state.saveReply = { code: 0, data: { _id: 'm2' }, message: 'ok' };
        page.editMaterial({ currentTarget: { dataset: { id: 'm2' } } });
        check('编辑预填总仓现值（m2 无库存 → 0）', page.data.mQty === '0', page.data.mQty);
        page.saveMaterial();   // mQty 保持 '0' = 预填值 → 不应触发 adjust
        setTimeout(function () {
          var adjSame = state.calls.filter(function (c) {
            return c.name === 'inventory' && c.data && c.data.action === 'adjust';
          });
          check('同值保存不触发 adjust（不瞎写库存）', adjSame.length === 0, String(adjSame.length));

          // 改数量 → 覆盖调整
          state.calls = [];
          state.toasts = [];
          page.editMaterial({ currentTarget: { dataset: { id: 'm2' } } });
          page.setData({ mQty: '5' });
          page.saveMaterial();
          setTimeout(function () {
            var adj = state.calls.filter(function (c) {
              return c.name === 'inventory' && c.data && c.data.action === 'adjust';
            });
            var adjCall = adj[adj.length - 1];
            check('改了数量 → 调 inventory.adjust', !!adjCall, adjCall && JSON.stringify(adjCall.data));
            check('adjust 带 itemId + 覆盖目标值 5',
              !!adjCall && adjCall.data.itemId === 'm2' && Number(adjCall.data.target) === 5,
              adjCall && JSON.stringify(adjCall.data));
            check('提示「总仓已调整为 5斤」',
              state.toasts.join('|').indexOf('总仓已调整为 5斤') >= 0, state.toasts.join('|'));

            console.log('\n----------------------------------------------');
            console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
            console.log(fail === 0 ? 'GOODS-EDIT RESULT: ALL GREEN' : 'GOODS-EDIT RESULT: RED');
            process.exitCode = fail === 0 ? 0 : 1;
          }, 10);
        }, 10);
      }, 10);
    }, 10);
  }, 10);
}, 10);
