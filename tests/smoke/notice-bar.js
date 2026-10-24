// ==========================================================================
// tests/smoke/notice-bar.js — 首页滚动通知栏（跑马灯）运行期测试
//
// 老板需求（2026-09-12）：首页来一条滚动通知栏，顶出「仓库预警」+「提交了还没确认的申请」。
//
// 本套用假 Component / wx / getApp 把 components/notice-bar/notice-bar.js 真跑起来，验：
//   ① 管理端：预警条 + 待确认申请条都在，文案是食材名不是 itemId，带店名
//   ② 一条都没有 → 通知栏不显示（items 空）
//   ③ 云函数失败 → 安静不显示，不抛错、不弹窗（首页不能被打断）
//   ④ 超过 5 条要折叠，末尾补「另有 N 条」
//   ⑤ 点通知条 → 跳对应页面（预警→库存预警页，申请→申请处理页）
//   ⑥ 门店端：**不调 report**（ALERT_VIEW 只允许 manager）
//      ⚠️ 口径两次翻转，别写反：
//         2026-10-08「门店只同步库存、不继承总仓阈值」→ 门店端预警**整段删除**。
//         2026-10-09「门店要有**自己的**阈值」（每店一个统一值，管理端门店详情设置）
//                   → 门店端预警**恢复**，但阈值**只能**来自 inventory 返回行（门店语境下
//                     云函数已把它切成 store.lowStockThreshold），**绝不**读 material 档案。
//      ⚠️ 关键判据：**字段名两边都叫 lowStockThreshold**，所以按字段名禁/放行都没用，
//         必须按**来源**验：种子数据故意让**档案值 ≠ 本店值**
//           （土豆档案 5 / 牛肉档案 20 / 白菜档案 null，而本店统一值 = 3）。
//         谁把阈值来源退回 material，§6「预警值必须是 3.00」+「牛肉不得误报」立刻转红。
//   ⑦ 门店端只看本店待确认申请
//   ⑧ 未登录不请求；并发 refresh 去重
// ==========================================================================
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var COMP = path.join(PROJECT, 'miniprogram', 'components', 'notice-bar', 'notice-bar.js');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ---------- 假运行时 ---------- */
var MGR_USER = { _id: 'user_manager', role: 'manager', name: '老板' };
var SHOP_USER = { _id: 'user_shop', role: 'shop', name: '城南店', storeId: 's1' };

var state = {
  user: MGR_USER,
  calls: [],          // 记录云函数调用
  navs: [],           // 记录跳转
  data: {             // 各云函数的返回
    report: { code: 0, data: { rows: [
      { itemId: 'm1', name: '土豆', unit: '斤', qty: 3, threshold: 5 },
      { itemId: 'm2', name: '牛肉', unit: '盒', qty: 0.5, threshold: 2 }
    ] } },
    requisition: { code: 0, data: { list: [
      { _id: 'req1', storeId: 's1', status: 'pending', items: [{ itemId: 'm1', qty: 10 }] },
      { _id: 'req2', storeId: 's2', status: 'pending', items: [{ itemId: 'm2', qty: 4 }] }
    ] } },
    store: { code: 0, data: { rows: [{ _id: 's1', name: '城南店' }, { _id: 's2', name: '襄城店' }] } },
    // ⚠️ 食材档案阈值（总仓备货警戒线）：故意给成 5 / 20 / null
    material: { code: 0, data: { rows: [
      { _id: 'm1', name: '土豆', unit: '斤', lowStockThreshold: 5, isActive: true },
      { _id: 'm2', name: '牛肉', unit: '盒', lowStockThreshold: 20, isActive: true },
      { _id: 'm3', name: '白菜', unit: '斤', lowStockThreshold: null, isActive: true }
    ] } },
    // ⚠️ inventory 门店语境返回行：lowStockThreshold 已是**本店阈值**（统一 3）
    //    与上面档案的 5 / 20 / null 全都不一样 → 来源搞错，文案里的「预警值 X.XX」立刻露馅
    inventory: { code: 0, data: { rows: [
      { itemId: 'm1', name: '土豆', unit: '斤', qty: 1, lowStockThreshold: 3 },
      { itemId: 'm2', name: '牛肉', unit: '盒', qty: 9, lowStockThreshold: 3 },
      { itemId: 'm3', name: '白菜', unit: '斤', qty: 0, lowStockThreshold: 3 }
    ] } }
  }
};

global.getApp = function () { return { globalData: { user: state.user } }; };
global.wx = {
  cloud: {
    callFunction: function (arg) {
      state.calls.push({ name: arg.name, data: arg.data });
      var r = state.data[arg.name];
      return Promise.resolve({ result: r || { code: 5001, data: null, message: '未预期：' + arg.name } });
    }
  },
  showToast: function (o) { state.toasts = (state.toasts || []).concat(o.title); },
  showModal: function () {},
  navigateTo: function (o) { state.navs.push(o.url); return Promise.resolve(); }
};

var def = null;
global.Component = function (d) { def = d; };
require(COMP);

function makeComp() {
  var c = {};
  Object.keys(def).forEach(function (k) {
    if (k === 'methods' || k === 'data' || k === 'lifetimes') { return; }
    c[k] = def[k];
  });
  Object.keys(def.methods || {}).forEach(function (k) { c[k] = def.methods[k]; });
  c.data = JSON.parse(JSON.stringify(def.data || {}));
  c.setData = function (p) { Object.assign(this.data, p); };
  return c;
}
function names() {
  return state.calls.map(function (c) { return c.name; }).join(',');
}
function texts(c) {
  return c.data.items.map(function (i) { return i.text; });
}

/* ---------- 1. 管理端：预警 + 待确认 ---------- */
section('1. 管理端：仓库预警 + 待确认申请');
state.user = MGR_USER;
state.calls = [];
var c1 = makeComp();
c1.refresh();
setTimeout(function () {
  var kinds = c1.data.items.map(function (i) { return i.kind; });
  check('预警条出来了', kinds.filter(function (k) { return k === 'alert'; }).length === 2, kinds.join('/'));
  check('待确认申请条出来了', kinds.filter(function (k) { return k === 'req'; }).length === 2);
  var t = texts(c1).join(' | ');
  check('预警文案是食材名不是 itemId', t.indexOf('土豆 仅剩') >= 0 && t.indexOf('m1') < 0, t.slice(0, 60));
  check('申请条带店名（城南店 / 襄城店）', t.indexOf('城南店') >= 0 && t.indexOf('襄城店') >= 0);
  check('申请明细带单位（土豆 10.00 斤）', t.indexOf('土豆 10.00 斤') >= 0);
  check('没有多余的汇总条', kinds.indexOf('more') < 0);

  /* ---------- 2. 空数据 ---------- */
  section('2. 没有预警也没有待确认 → 通知栏不显示');
  var bak = JSON.parse(JSON.stringify(state.data));
  state.data.report = { code: 0, data: { rows: [] } };
  state.data.requisition = { code: 0, data: { list: [] } };
  var c2 = makeComp();
  c2.refresh();
  setTimeout(function () {
    check('items 为空（整条通知栏隐藏）', c2.data.items.length === 0, c2.data.items.length);

    /* ---------- 3. 云函数失败 ---------- */
    section('3. 云函数失败 → 不打断首页，坏的那一路丢掉、好的照常显示');
    state.data = JSON.parse(JSON.stringify(bak));
    state.data.report = { code: 1001, data: null, message: '请先登录' };
    var c3 = makeComp();
    var threw = false;
    try { c3.refresh(); } catch (e) { threw = true; }
    setTimeout(function () {
      check('不抛异常（首页不能被通知栏打断）', threw === false);
      check('预警那路挂了 → 不出预警条',
        c3.data.items.every(function (i) { return i.kind !== 'alert'; }));
      check('申请那路正常 → 申请条照常显示',
        c3.data.items.filter(function (i) { return i.kind === 'req'; }).length === 2,
        c3.data.items.length);

      state.data = JSON.parse(JSON.stringify(bak));
      ['report', 'requisition', 'store', 'material'].forEach(function (n) {
        state.data[n] = { code: 5001, data: null, message: '网络异常' };
      });
      var c3b = makeComp();
      c3b.refresh();
      setTimeout(function () {
        check('全部挂了 → items 为空（整条隐藏）', c3b.data.items.length === 0);

      /* ---------- 4. 超量折叠 ---------- */
      section('4. 超量折叠（预警最多 5 条 + 末尾汇总）');
      state.data = JSON.parse(JSON.stringify(bak));
      var many = [];
      for (var i = 0; i < 9; i++) {
        many.push({ itemId: 'm' + i, name: '食材' + i, unit: '斤', qty: 0, threshold: 5 });
      }
      state.data.report = { code: 0, data: { rows: many } };
      state.data.requisition = { code: 0, data: { list: [] } };
      var c4 = makeComp();
      c4.refresh();
      setTimeout(function () {
        check('只顶 5 条预警 + 1 条汇总', c4.data.items.length === 6, c4.data.items.length);
        check('汇总条文案正确（另有 4 条）',
          texts(c4).join('').indexOf('另有 4 条') >= 0, texts(c4)[texts(c4).length - 1]);
        check('more 计数正确', c4.data.more === 4, c4.data.more);

        /* ---------- 5. 点击跳转 ---------- */
        section('5. 点通知条跳对应页面');
        state.navs = [];
        var alertItem = c4.data.items[0];
        c4.onTap({ currentTarget: { dataset: { url: alertItem.url, kind: alertItem.kind } } });
        check('预警条 → 库存预警页',
          state.navs[0] === '/pages/manager/wh-stock-alert/wh-stock-alert', state.navs[0]);
        state.navs = [];
        state.data = JSON.parse(JSON.stringify(bak));
        var c5 = makeComp();
        c5.refresh();
        setTimeout(function () {
          var reqItem = c5.data.items.filter(function (i) { return i.kind === 'req'; })[0];
          c5.onTap({ currentTarget: { dataset: { url: reqItem.url, kind: reqItem.kind } } });
          check('申请条 → 申请处理页',
            state.navs[0] === '/pages/manager/requisition-process/requisition-process', state.navs[0]);
          state.navs = [];
          c5.onTap({ currentTarget: { dataset: { url: '' } } });
          check('url 为空不跳（不会崩）', state.navs.length === 0);

          /* ---------- 6. 门店端：本店阈值预警（2026-10-09 口径，覆盖 10-08「不预警」） ----------
           * 2026-10-08 口径是「门店端不得有任何预警条」，2026-10-09 老板拍板「门店有自己的阈值」
           * 后**整体翻转**：门店端**必须**出本店库存预警条。
           * ⚠️ 翻转后的守卫不能只验「有 alert 条」——那只是把旧断言取反，
           *    真正要守的是**阈值来源**：门店语境只能用 inventory 返回行的 lowStockThreshold
           *    （云函数已切成 store.lowStockThreshold），**绝不能**退回 material 档案值。
           *    种子数据据此构造成**档案值(5/20/null) ≠ 本店值(3)** 且**牛肉 9 盒只在本店口径下不报警**：
           *      正确实现 → 预警值一律 3.00，牛肉不报；
           *      退回档案 → 土豆 5.00、牛肉 9<20 也报 → §6 立刻转红。
           * 另：§3 的「预警那路挂了 → 不出预警条」是管理端的，与本段互不覆盖。
           */
          section('6. 门店端：不调 report · 出**本店**阈值预警，且阈值来源必须是本店值（2026-10-09 口径）');
          state.user = SHOP_USER;
          state.calls = [];
          var c6 = makeComp();
          c6.refresh();
          setTimeout(function () {
            check('没调 report（否则会被 1003 拒）', names().indexOf('report') < 0, names());
            check('★门店端必须调 inventory（本店阈值的唯一来源就是它）',
              state.calls.some(function (c) { return c.name === 'inventory'; }), names());
            check('★门店端不得为取阈值去调 material（阈值来源只能是 inventory 行）',
              state.calls.every(function (c) { return c.name !== 'material'; }), names());
            var alerts6 = c6.data.items.filter(function (i) { return i.kind === 'alert'; });
            var t6 = texts(c6).join(' | ');
            check('★门店端**必须**产生库存预警条（10-08 曾整段删除，10-09 恢复）',
              alerts6.length === 2,
              c6.data.items.map(function (i) { return i.kind; }).join('/') || '(空)');
            check('★土豆 1 斤 < 本店阈值 3 → 必须报警', t6.indexOf('土豆 仅剩 1.00') >= 0, t6.slice(0, 70));
            check('★白菜 0 斤 → 必须报警', t6.indexOf('白菜 仅剩 0.00') >= 0, t6.slice(0, 70));
            check('★预警值必须是本店值 3.00，不得是档案的 5.00 / 20.00（来源红线）',
              t6.indexOf('预警值 3.00') >= 0 && t6.indexOf('5.00') < 0 && t6.indexOf('20.00') < 0,
              t6.slice(0, 90));
            check('★牛肉 9 盒不算预警（本店阈值 3；若读总仓档案的 20 就会误报）',
              t6.indexOf('牛肉') < 0, t6.slice(0, 90));
            // ⚠️ 别写成 t6.indexOf('库存预警：') < 0 —— 「本店库存预警：」里就含这 5 个字，必挂。
            //    要验的是**前缀**：每条 alert 都必须以「本店库存预警：」开头（不是总仓的「库存预警：」）。
            check('门店端预警条文案以「本店库存预警：」开头（区别于总仓的「库存预警：」）',
              alerts6.length > 0 && alerts6.every(function (i) { return i.text.indexOf('本店库存预警：') === 0; }),
              alerts6.length ? alerts6[0].text.slice(0, 24) : '(没有预警条)');
            check('本店待确认申请出来了',
              c6.data.items.some(function (i) { return i.kind === 'req'; }));
            // ⚠️ 取 [0] 前必须先判空：变异注入（例如 loadShop 里插一路云调用把 rs 下标顶偏）
            //    可能让申请条为 0 条，此处若直接 [0].url 会抛 TypeError 崩掉整个套件 ——
            //    那就不是「转红」而是「崩溃」，反而掩盖了真正的失败原因。断言要能干净地报红。
            var reqItem6 = c6.data.items.filter(function (i) { return i.kind === 'req'; })[0];
            check('门店申请条 → 食材申请页（v1.0.3 申请历史已删，"我的申请"卡嵌在食材申请页下方）',
              !!reqItem6 && reqItem6.url === '/pages/shop/requisition/requisition',
              reqItem6 ? reqItem6.url : '(没有申请条)');

            /* ---------- 7. 未登录 / 并发 ---------- */
            section('7. 未登录不请求 · 并发 refresh 去重');
            state.user = null;
            state.calls = [];
            var c7 = makeComp();
            c7.refresh();
            setTimeout(function () {
              check('未登录不发起任何云调用', state.calls.length === 0, state.calls.length);
              check('未登录 items 为空', c7.data.items.length === 0);

              state.user = MGR_USER;
              state.data = JSON.parse(JSON.stringify(bak));
              state.calls = [];
              var c8 = makeComp();
              c8.refresh();
              c8.refresh();   // 模拟 attached + 页面 onShow 双触发
              setTimeout(function () {
                check('并发/重复 refresh 只拉一次（4 个云调用）', state.calls.length === 4, state.calls.length);

                console.log('\n----------------------------------------------');
                console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
                console.log(fail === 0 ? 'NOTICE-BAR RESULT: ALL GREEN' : 'NOTICE-BAR RESULT: RED');
                process.exitCode = fail === 0 ? 0 : 1;
              }, 10);
            }, 10);
          }, 10);
        }, 10);
      }, 10);
    }, 10);
  }, 10);
}, 10);
}, 10);
