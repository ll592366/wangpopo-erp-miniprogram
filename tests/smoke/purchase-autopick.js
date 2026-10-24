// ==========================================================================
// tests/smoke/purchase-autopick.js — 采购页「自动关联」运行期测试
//
// 老板口径（2026-09-12）：进采购入库页，食材应该**直接是选好的**（至少默认第一条），
// 规格 / 单位**自动带出**，不用先点一次下拉；只有数量要手填。
//
// 本套用假的 Page / wx 直接把 miniprogram/pages/manager/purchase/purchase.js 跑起来，
// 验的是运行期行为（不是读源码字符串），覆盖：
//   ① 下拉源只含启用中的档案
//   ② 进页即自动选中第一条（materialIndex=0，picked 非空）
//   ③ 规格 / 单位自动带出（WXML 不会再显示「—」）
//   ④ 手动切换下拉 → 规格 / 单位跟着换
//   ⑤ 重新进页沿用上次选中，不被首条覆盖
//   ⑥ 档案为空时安全降级（-1 / null，不报错）
//   ⑦ 云函数失败要弹提示，不静默留空下拉
//   ⑧ 未选 / 数量为 0 时拦住，不请求云函数
//   ⑨ 正常入库按 itemId 提交
// ==========================================================================
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var PAGE = path.join(PROJECT, 'miniprogram', 'pages', 'manager', 'purchase', 'purchase.js');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------- 假的小程序运行时 ---------- */
var ROWS = [
  { _id: 'm1', name: '土豆', unit: '斤', spec: '50斤/袋', isActive: true, lowStockThreshold: 20 },
  { _id: 'm2', name: '牛肉片', unit: '盒', spec: '200g/盒', isActive: true, lowStockThreshold: 5 },
  { _id: 'm3', name: '停用食材', unit: '袋', spec: '10斤/袋', isActive: false }
];

var state = {
  rows: ROWS,
  listCode: 0,
  listMessage: 'ok',
  calls: [],       // 记录所有云函数调用
  toasts: [],
  modals: []
};

var captured = null;
global.Page = function (def) { captured = def; };
global.getApp = undefined;
global.wx = {
  cloud: {
    callFunction: function (arg) {
      state.calls.push(arg);
      var result;
      if (arg.name === 'material') {
        result = state.listCode === 0
          ? { code: 0, data: { rows: state.rows }, message: 'ok' }
          : { code: state.listCode, data: null, message: state.listMessage };
      } else if (arg.name === 'purchase') {
        result = {
          code: 0,
          data: {
            material: { _id: arg.data.itemId, name: '土豆', unit: '斤', spec: '50斤/袋' },
            purchase: { qty: 50 },
            balanceAfter: { after: 120 }
          },
          message: 'ok'
        };
      } else {
        result = { code: 5001, data: null, message: '未预期的云函数：' + arg.name };
      }
      return Promise.resolve({ result: result });
    }
  },
  showToast: function (o) { state.toasts.push(o.title); return Promise.resolve(); },
  showModal: function (o) { state.modals.push(o); return Promise.resolve(); },
  navigateTo: function () { return Promise.resolve(); }
};

require(PAGE);

function makePage() {
  var p = {};
  Object.keys(captured).forEach(function (k) { p[k] = captured[k]; });
  p.data = JSON.parse(JSON.stringify(captured.data || {}));
  p.setData = function (patch) { Object.assign(this.data, patch); };
  return p;
}

/* ---------- 1. 进页即自动关联 ---------- */
section('1. 进页即自动关联（老板诉求本体）');
var page = makePage();
page.onShow();
setTimeout(function () {
  check('下拉源只含启用中的档案（停用档不进下拉）',
    page.data.options.length === 2 &&
    page.data.options.every(function (o) { return o._id !== 'm3'; }),
    page.data.options.map(function (o) { return o.name; }).join('/'));
  check('进页就自动选中第一条（materialIndex=0）', page.data.materialIndex === 0, page.data.materialIndex);
  check('picked 非空（不会再显示「请选择食材」）', !!page.data.picked, page.data.picked && page.data.picked.name);
  check('规格自动带出', page.data.picked && page.data.picked.spec === '50斤/袋', page.data.picked && page.data.picked.spec);
  check('单位自动带出', page.data.picked && page.data.picked.unit === '斤', page.data.picked && page.data.picked.unit);
  check('下拉 label 带规格·单位（重名不混淆）',
    page.data.options[0].label === '土豆（50斤/袋·斤）', page.data.options[0].label);

  /* ---------- 2. 手动切换仍生效 ---------- */
  section('2. 手动切换下拉');
  page.onPick({ detail: { value: page.data.options[1]._id } });
  check('切到第 2 条后 picked 跟着换', page.data.picked._id === 'm2', page.data.picked.name);
  check('规格跟着换', page.data.picked.spec === '200g/盒', page.data.picked.spec);
  check('单位跟着换', page.data.picked.unit === '盒', page.data.picked.unit);
  page.onPick({ detail: { value: 'nonexistent' } });
  check('不存在的 _id 不崩、保持不变', page.data.picked._id === 'm2');

  /* ---------- 3. 重新进页沿用上次选中 ---------- */
  section('3. 重新进页沿用上次选中');
  page.onShow();
  setTimeout(function () {
    check('沿用上次选中的 m2（不被首条覆盖）',
      page.data.materialIndex === 1 && page.data.picked._id === 'm2',
      page.data.picked && page.data.picked.name);

    /* ---------- 4. 空档案安全降级 ---------- */
    section('4. 档案为空 / 云函数失败');
    state.rows = [];
    var p2 = makePage();
    p2.onShow();
    setTimeout(function () {
      check('无档案时 materialIndex=-1、picked=null（不报错）',
        p2.data.materialIndex === -1 && p2.data.picked === null);
      check('无档案时下拉源为空（页面会显示去建档的提示）', p2.data.options.length === 0);

      state.rows = ROWS;
      state.listCode = 5001;
      state.listMessage = '网络异常，请稍后重试';
      state.toasts = [];
      var p3 = makePage();
      p3.onShow();
      setTimeout(function () {
        check('云函数失败会弹提示（不静默留空下拉，且已去掉 [code] 前缀）',
          state.toasts.length === 1 && state.toasts[0].length > 0 && !/\[\d+\]/.test(state.toasts[0]), state.toasts.join('|'));
        check('失败时 picked 保持 null（不会假装有选中）', p3.data.picked === null);
        state.listCode = 0;

        /* ---------- 5. 提交校验 ---------- */
        section('5. 提交校验与入库');
        state.toasts = [];
        state.calls = [];
        var p4 = makePage();
        p4.onShow();
        setTimeout(function () {
          p4.setData({ qty: '' });
          p4.submit();
          check('数量为 0/空 → 拦住且不请求云函数',
            state.toasts.join('|').indexOf('采购数量必须大于 0') >= 0 && state.calls.length === 1,
            state.toasts.join('|'));

          state.toasts = [];
          state.modals = [];
          state.calls = [];
          p4.setData({ qty: '50', remark: '  周二直采  ' });
          p4.submit();
          setTimeout(function () {
            var pc = state.calls.filter(function (c) { return c.name === 'purchase'; })[0];
            check('按 itemId 提交（不传名称、不现场建档）',
              !!pc && pc.data.itemId === 'm1' && pc.data.name === undefined,
              pc && JSON.stringify(pc.data));
            check('备注去空格', !!pc && pc.data.remark === '周二直采', pc && pc.data.remark);
            check('入库成功弹结果', state.modals.length === 1 && state.modals[0].title === '入库成功',
              state.modals[0] && state.modals[0].content);
            check('入库后清空数量但保留选中（可连续录）',
              p4.data.qty === '' && p4.data.remark === '' && p4.data.picked._id === 'm1');
            check('提交中状态已复位（可再点）', p4.data.submitting === false);

            console.log('\n----------------------------------------------');
            console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
            console.log(fail === 0 ? 'PURCHASE-AUTOPICK RESULT: ALL GREEN' : 'PURCHASE-AUTOPICK RESULT: RED');
            process.exitCode = fail === 0 ? 0 : 1;
          }, 10);
        }, 10);
      }, 10);
    }, 10);
  }, 10);
}, 10);
