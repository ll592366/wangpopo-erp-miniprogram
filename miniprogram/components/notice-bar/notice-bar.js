// ==========================================================================
// components/notice-bar — 首页滚动通知栏（跑马灯）
// 老板口径（2026-09-12）：首页要有一条滚动通知，把「仓库预警」和「提交了还没确认的申请」顶出来。
//
// 数据来源（不新增云函数，复用现成接口，零部署）：
//   · 管理端 manager：report(lowStock) 总仓预警 + requisition(list, pending) 待确认申请（带店名）
//   · 门店端 shop   ：inventory(本店) **本店阈值**预警 + requisition(list, pending) 本店待确认申请
// 权限差异：ALERT_VIEW 仅 manager，所以门店端**不能**调 report，只能走 inventory。
//
// ⚠️ 阈值口径演进（两次老板拍板，别混淆）：
//   · 2026-10-08「门店不继承总仓阈值」→ 门店端预警整段删除。
//     原因：拉 inventory(本店) + material 档案的 lowStockThreshold 自算低库存，
//     而那阈值是**总仓备货**警戒线（可能 10 包），门店日常只有 2~3 包 →
//     几乎全部食材常年飘红、预警彻底失效。
//   · 2026-10-09「门店有自己的阈值」→ 门店端预警**恢复**，但改用**本店阈值**
//     （每店一个统一值，管理端在门店详情设置，存 store.lowStockThreshold）。
//     🚫 恢复时阈值**只能**来自 inventory 返回的 lowStockThreshold（门店语境下已是本店值），
//        绝不回退到 material 的总仓阈值。
//
// 用法（页面）：
//   json:  "usingComponents": { "notice-bar": "/components/notice-bar/notice-bar" }
//   wxml:  <notice-bar id="noticeBar" />
//   js:    onShow → var nb = this.selectComponent('#noticeBar'); if (nb) { nb.refresh(); }
// ==========================================================================
var cloud = require('../../utils/cloud');
var fmt = require('../../utils/format');

var MAX_ALERT = 5;   // 预警最多顶 5 条（再多就汇总成一条，避免刷屏）——管理端总仓预警 & 门店端本店预警**共用**
var MAX_REQ = 5;     // 待确认申请最多顶 5 单

/** 门店未设本店阈值时的默认值（与云函数 C.CONFIG.LOW_STOCK_THRESHOLD 对齐，=2） */
var DEFAULT_STORE_THRESHOLD = 2;

// ⚠️ 门店端阈值口径（2026-10-09）：
//    · 2026-10-08 曾把门店端库存预警整体删除，原因是拿「总仓备货阈值」比「门店库存」常年误报。
//    · 2026-10-09 老板拍板「门店有自己的阈值」后**恢复**，但阈值**只**认 inventory 返回的
//      lowStockThreshold —— 门店语境下云函数已把它切换成**本店阈值**（每店一个统一值）。
//    🚫 绝不回退到读 material 的阈值：那是总仓备货警戒线，读它等于把旧 bug 原样请回来。
//    · 总仓预警仍走 report(lowStock)，由服务端返回 threshold 字段（见 loadManager），
//      前端不自己解析档案阈值。

Component({
  data: {
    items: [],     // [{key, kind:'alert'|'req', text, url}]
    more: 0        // 被折叠掉的条数（>0 时在末尾补一条"另有 N 条"）
  },

  lifetimes: {
    attached: function () { this.refresh(); }
  },

  methods: {
    /** 拉数据并重排通知条；正在拉就直接跳过（页面 onShow 会重复触发） */
    refresh: function () {
      var that = this;
      if (that._loading) { return; }
      var user = null;
      try {
        var app = getApp();
        user = app && app.globalData ? app.globalData.user : null;
      } catch (e) { user = null; }
      if (!user || !user._id) { that.setData({ items: [], more: 0 }); return; }

      that._loading = true;
      (user.role === 'manager' ? that.loadManager() : that.loadShop(user))
        .then(function (items) {
          that._loading = false;
          that.setData({ items: items });
        })
        .catch(function () {
          // 通知栏是锦上添花：拉不到就安静地不显示，绝不弹错打断首页
          that._loading = false;
          that.setData({ items: [], more: 0 });
        });
    },

    /* ---------- 管理端：总仓预警 + 全部待确认申请（带店名） ---------- */
    loadManager: function () {
      var that = this;
      return Promise.all([
        cloud.call('report', { type: 'lowStock' }),
        cloud.call('requisition', { action: 'list', status: 'pending' }),
        cloud.call('store', { action: 'list' }),
        cloud.call('material', { action: 'list' })   // 申请明细只存 itemId，要换成食材名+单位
      ]).then(function (rs) {
        var items = [];
        var overflow = 0;

        // ① 库存预警（总仓）
        var alerts = (rs[0].code === 0 && rs[0].data) ? (rs[0].data.rows || []) : [];
        alerts.forEach(function (a, i) {
          if (i >= MAX_ALERT) { overflow++; return; }
          items.push({
            key: 'a' + i,
            kind: 'alert',
            text: '库存预警：' + a.name + ' 仅剩 ' + fmt.formatQty(a.qty, a.unit) +
              '（预警值 ' + fmt.formatQty(a.threshold, a.unit) + '）',
            url: '/pages/manager/wh-stock-alert/wh-stock-alert'
          });
        });

        // ② 待确认申请（店名 + 明细摘要）
        var storeName = {};
        if (rs[2].code === 0 && rs[2].data) {
          (rs[2].data.rows || []).forEach(function (s) { storeName[s._id] = s.name; });
        }
        // 申请明细只存 itemId / qty，名称·单位要回查食材档案
        var matMap = {};
        if (rs[3].code === 0 && rs[3].data) {
          (rs[3].data.rows || []).forEach(function (m) {
            matMap[m._id] = { name: m.name, unit: m.unit };
          });
        }
        var reqs = (rs[1].code === 0 && rs[1].data) ? (rs[1].data.list || []) : [];
        reqs.forEach(function (r, i) {
          if (i >= MAX_REQ) { overflow++; return; }
          var summary = (r.items || []).map(function (it) {
            var m = matMap[it.itemId];
            return (m ? m.name : '食材') + ' ' + fmt.formatQty(it.qty, m ? m.unit : '');
          }).join('、');
          items.push({
            key: 'r' + i,
            kind: 'req',
            text: '待确认申请：' + (storeName[r.storeId] || '门店') + ' · ' + (summary || '明细见处理页'),
            url: '/pages/manager/requisition-process/requisition-process'
          });
        });

        return that.withOverflow(items, overflow);
      });
    },

    /* ---------- 门店端：本店库存预警（2026-10-09 恢复）+ 本店待确认申请 ---------- */
    loadShop: function (user) {
      var that = this;
      // ① 店内库存预警：2026-10-08 曾整体移除，2026-10-09 **恢复**。
      //   移除的原因：原先拿「总仓备货阈值」比「门店库存」，门店库存天然远低于总仓备货量
      //   → 几乎全部食材常年飘红，预警完全失效、还刷屏首页。
      //   恢复的前提：老板拍板「门店有自己的预警阈值」（每店一个统一值，管理端在门店详情设置），
      //   云函数 inventory 在门店语境下已把 lowStockThreshold 切换成**本店阈值**。
      // 🚫 红线：本组件**只**认 inventory 返回的那个字段，**绝不能**再去读 material 的阈值
      //    —— 那是总仓备货警戒线，读它就是把 2026-10-08 的 bug 原样请回来。
      return Promise.all([
        cloud.call('inventory', {}),                                  // 本店库存（含本店阈值）
        cloud.call('requisition', { action: 'list', status: 'pending' })
      ]).then(function (rs) {
        var items = [];
        var overflow = 0;
        var rows = (rs[0].code === 0 && rs[0].data) ? (rs[0].data.rows || []) : [];
        // 先归一阈值再比较：显示文案也用归以后的值，避免「没设阈值」显示成「预警值 0」。
        var low = [];
        rows.forEach(function (r) {
          var th = Number(r.lowStockThreshold);                         // 本店阈值（门店语境）
          th = (isFinite(th) && th > 0) ? th : DEFAULT_STORE_THRESHOLD; // 没设 → 默认 2
          if (Number(r.qty) < th) { low.push({ row: r, th: th }); }
        });
        low.forEach(function (x, i) {
          if (i >= MAX_ALERT) { overflow += 1; return; }
          var r = x.row;
          items.push({
            key: 'a' + i,
            kind: 'alert',
            text: '本店库存预警：' + (r.name || '食材') + ' 仅剩 ' + fmt.formatQty(r.qty, r.unit) +
              '（预警值 ' + fmt.formatQty(x.th, r.unit) + '）',
            url: '/pages/shop/store-stock/store-stock'
          });
        });

        // ② 本店待确认申请（云函数已按 storeId 收敛，只可能看到本店的）
        //    2026-10-08 修 bug：原写法 reqs.forEach **每单**都 push 一条，文案里却固定写
        //    `reqs.length` 总数 → 2 单待确认时通知栏出现**两条一模一样**的
        //    「你有 2 单申请等待管理端处理」。汇总提醒只需一条，故去掉 forEach。
        var reqs = (rs[1].code === 0 && rs[1].data) ? (rs[1].data.list || []) : [];
        if (reqs.length > 0) {
          items.push({
            key: 'req',
            kind: 'req',
            text: '你有 ' + reqs.length + ' 单申请等待管理端处理',
            url: '/pages/shop/requisition/requisition'   // 申请页下方已嵌"我的申请"卡，老板 2026-09-13 拍板删独立历史页
          });
        }
        return that.withOverflow(items, overflow);
      });
    },

    /** 折叠掉的条数补一条汇总，并记到 data.more */
    withOverflow: function (items, overflow) {
      var that = this;
      if (overflow > 0) {
        items.push({
          key: 'more',
          kind: 'more',
          text: '另有 ' + overflow + ' 条待处理提醒，点开查看全部',
          url: items.length ? items[0].url : ''
        });
      }
      that.setData({ more: overflow });
      return items;
    },

    /** 点通知条 → 跳对应页面 */
    onTap: function (e) {
      var url = e.currentTarget.dataset.url;
      if (!url) { return; }
      wx.navigateTo({
        url: url,
        fail: function () { /* 已在目标页等极端情况，忽略 */ }
      });
    }
  }
});
