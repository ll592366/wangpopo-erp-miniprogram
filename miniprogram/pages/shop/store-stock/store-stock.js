// ==========================================================================
// pages/shop/store-stock — 库存与消耗（v1.0.3 老板 2026-09-15 拍板：合并"店内库存+消耗"两 tab）
// · ① 库存：inventory(本店) + material 拿规格/单位 + 阈值比较（本 tab 不动）
// · ② 消耗：production.list 云函数按 ctx.user.storeId + 时间范围过滤
//          菜品名回查 dish.list（production 单只存 dishId，不存名 → 之前直接显示原始 ID）
//          点记录 → 弹层显示消耗明细（老板 2026-09-15 拍板"点击后弹出消耗详情"）
//          老板 2026-09-19 拍板：加「时间范围筛选 + 导出跟随筛选」——
//            顶部一行 左【本周|本月|自定义|全部】+ 右【导出】，默认本月（与管理端历史消耗一致）；
//            自定义展开起止日期；不传 storeId（后端强制本店）；文件名带范围。
//            列表「加载更多」（触底追加，首次 100 条，不把全量塞进页面）；
//            导出 = 时间范围内「全量」（循环分页拉，无业务条数上限）。
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var dr = require('../../../utils/date-range');
var rec = require('../../../utils/consume-records');
var search = require('../../../utils/list-search');

var LIST_PAGE = 100;   // 列表每页条数（触底追加）

/** 本店未设阈值时的默认值（与云函数 C.CONFIG.LOW_STOCK_THRESHOLD 对齐，=2） */
var DEFAULT_THRESHOLD = 2;

/**
 * 阈值归一：非法 / 没设 → 回落默认 2。
 * ⚠️ 入参**只能**是 inventory 返回的 lowStockThreshold —— 门店语境下它已经是**本店阈值**
 *    （云函数 inventory 按语境切换过）。**绝不**去读 material 的阈值，那是总仓备货警戒线：
 *    总仓备货线可能 10 包，门店日常只有 2~3 包 → 拿它比门店库存会几乎全部常年飘红、预警失效。
 */
function thresholdOf(v) {
  var n = Number(v);
  return (isFinite(n) && n > 0) ? n : DEFAULT_THRESHOLD;
}

Page({
  data: {
    tab: 'inv',           // 'inv' 库存 / 'cons' 消耗
    invRows: [],
    kw: '',                  // 库存搜索词（匹配 食材名；本地过滤，不调云函数）
    alertCount: 0,        // 本店低库存食材数（按本店阈值算）
    // ② 消耗 tab + 时间范围筛选（老板 2026-09-19）
    consPresets: dr.PRESETS,           // 本周 / 本月 / 自定义 / 全部
    consRange: 'month',                // 默认本月
    customFrom: dr.monthStart(dr.today()),
    customTo: dr.today(),
    consEmptyText: '本月暂无消耗记录',
    consRows: [],
    consCount: 0,                      // 已加载条数
    listHasMore: false,                // 是否还有下一页
    listLoadingMore: false,            // 触底加载中
    // 消耗明细弹层
    detailOpen: false,
    detail: null          // { dishName, qty, timeText, statusLabel, items:[{name, qtyText}] }
  },

  // 非渲染缓存
  _matMap: {},     // { itemId: material }
  _dishMap: {},    // { dishId: dish }
  _raw: [],        // 已加载的 production 原始记录（含装饰字段），分页累加
  _invRowsFull: [], // 库存全量（过滤底稿；过滤只改渲染用的 invRows）

  onShow: function () { this.loadAll(); },

  onPullDownRefresh: function () {
    this.loadAll();
    wx.stopPullDownRefresh();
  },

  /* 触底：仅消耗 tab 追加下一页（老板 2026-09-19） */
  onReachBottom: function () {
    if (this.data.tab === 'cons') { this.loadMoreCons(); }
  },

  switchTab: function (e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  /* ===== ② 消耗：时间范围筛选（老板 2026-09-19） ===== */
  switchConsRange: function (e) {
    var k = e.currentTarget.dataset.key;
    if (k === this.data.consRange) { return; }
    var patch = { consRange: k };
    if (k === 'custom') {
      patch.customFrom = this.data.customFrom || dr.monthStart(dr.today());
      patch.customTo = this.data.customTo || dr.today();
    }
    this.setData(patch);
    this.reloadCons();      // 换档 → 重置 offset 重新拉第一页
  },
  /* from > to 自动把 to 拉到 from（不发非法区间） */
  onConsFromChange: function (e) {
    var v = e.detail.value;
    var to = this.data.customTo;
    if (v > to) { to = v; }
    this.setData({ customFrom: v, customTo: to });
    this.reloadCons();
  },
  onConsToChange: function (e) {
    var v = e.detail.value;
    var from = this.data.customFrom;
    if (v < from) { from = v; }
    this.setData({ customFrom: from, customTo: v });
    this.reloadCons();
  },

  /* 静态数据（库存 + 档案映射）+ 消耗第一页 */
  loadAll: function () {
    var that = this;
    // 三路并发：inventory(本店) + material 拿规格 + dish 拿菜名
    Promise.all([
      cloud.call('inventory', {}),
      cloud.call('material', { action: 'list' }),
      cloud.call('dish', { action: 'list' })
    ]).then(function (rs) {
      var matMap = {};
      (rs[1].code === 0 ? rs[1].data.rows : []).forEach(function (m) { matMap[m._id] = m; });
      var dishMap = {};
      (rs[2].code === 0 ? rs[2].data.rows : []).forEach(function (d) { dishMap[d._id] = d; });
      that._matMap = matMap;
      that._dishMap = dishMap;

      // === ① 库存 ===
      // 2026-10-09 老板拍板：**门店有自己的预警阈值**（每店一个统一值，管理端在门店详情设置）。
      //   所以门店端**恢复**预警，但阈值**只**认 inventory 返回的 lowStockThreshold ——
      //   门店语境下云函数已把它切换成**本店阈值**。
      // ⚠️ 绝不回退到读 material 的阈值：那是**总仓备货**警戒线（可能 10 包），
      //   门店日常库存天然只有 2~3 包 → 拿它比门店库存会几乎全部常年飘红、预警失效。
      var invRows = rs[0].code === 0 ? rs[0].data.rows : [];
      var alertCount = 0;
      invRows.forEach(function (r) {
        var m = matMap[r.itemId] || {};
        r.unit = r.unit || (m.unit || '');
        r.spec = m.spec || '';
        r.qtyText = fmt.formatQty(r.qty, r.unit);
        r.timeText = fmt.fmtShort(r.updatedAt);
        // 本店阈值（inventory 已按语境给成门店值；缺省回落 2）
        r.threshold = thresholdOf(r.lowStockThreshold);
        r.thText = fmt.formatQty(r.threshold, r.unit);
        r.low = r.qty < r.threshold;
        r.gap = r.low ? fmt.formatQty(r.threshold - r.qty, r.unit) : '';
        if (r.low) { alertCount += 1; }
      });

      that._invRowsFull = invRows;
      that.setData({ invRows: invRows, alertCount: alertCount });
      that.applySearch();     // 库存刷完重新套一次搜索词（onShow 回来也不会丢过滤）
      that.reloadCons();      // === ② 消耗第一页 ===
    });
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */
  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值（loadAll 刷新后重算走这条）
   */
  applySearch: function (kwField, kw) {
    var k = (kwField === 'kw' && kw !== undefined) ? kw : this.data.kw;
    this.setData({ kw: k, invRows: search.filter(this._invRowsFull, k, ['name']) });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  },

  /* 消耗记录：重置并拉第一页 */
  reloadCons: function () {
    var that = this;
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.consRange, custom);
    this._raw = [];
    this.setData({ consRows: [], consCount: 0, listHasMore: false, listLoadingMore: true,
      consEmptyText: dr.emptyText(this.data.consRange, custom) });

    // 门店端不传 storeId（后端强制本店）
    rec.fetchPage({ from: range.from, to: range.to, offset: 0, limit: LIST_PAGE })
      .then(function (res) {
        if (!res || res.code !== 0) {
          that.setData({ listLoadingMore: false });
          wx.showToast({ title: (res && res.message) || '加载失败，请重试', icon: 'none', duration: 2600 });
          return;
        }
        var list = (res.data && res.data.list) || [];
        that._raw = list.map(function (p) { return that._decorate(p); });
        that.setData({ listLoadingMore: false, listHasMore: !!(res.data && res.data.hasMore) });
        that._renderCons();
      });
  },

  /* 消耗记录：触底追加下一页 */
  loadMoreCons: function () {
    var that = this;
    if (!this.data.listHasMore || this.data.listLoadingMore) { return; }
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.consRange, custom);
    var offset = (this._raw || []).length;
    this.setData({ listLoadingMore: true });
    rec.fetchPage({ from: range.from, to: range.to, offset: offset, limit: LIST_PAGE })
      .then(function (res) {
        if (!res || res.code !== 0) {
          that.setData({ listLoadingMore: false });
          wx.showToast({ title: '加载更多失败', icon: 'none' });
          return;
        }
        var list = (res.data && res.data.list) || [];
        list.forEach(function (p) { that._raw.push(that._decorate(p)); });
        that.setData({ listLoadingMore: false, listHasMore: !!(res.data && res.data.hasMore) });
        that._renderCons();
      });
  },

  /* 单条 production 记录补展示字段（菜名 / 时间 / 状态 / 逐项明细） */
  _decorate: function (p) {
    var matMap = this._matMap || {};
    var d = (this._dishMap || {})[p.dishId];
    p.dishName = (d && d.name) || p.dishName || ('#' + p.dishId);
    p.timeText = fmt.fmtShort(p.createdAt);
    p.timeHm = (String(p.createdAt || '').match(/T(\d{2}:\d{2})/) || [])[1] || '';
    p.statusLabel = p.status === 'confirmed' ? '已出品' : '已撤回';
    p.detailItems = (p.consumeItems || []).map(function (ci) {
      var m = matMap[ci.itemId];
      return {
        name: m ? m.name : ci.itemId,
        unit: m ? m.unit : '',
        qty: Number(ci.qty) || 0,
        qtyText: fmt.formatQty(ci.qty, m ? m.unit : '')
      };
    });
    p.consumeText = p.detailItems.map(function (x) { return x.name + ' −' + x.qtyText; }).join('；') || '未配置消耗清单';
    return p;
  },

  _renderCons: function () {
    this.setData({ consRows: (this._raw || []).slice(), consCount: (this._raw || []).length });
  },

  /* ---------------- 消耗明细弹层（点记录弹出） ---------------- */
  openDetail: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    var p = this.data.consRows[idx];
    if (!p) { return; }
    this.setData({
      detailOpen: true,
      detail: {
        dishName: p.dishName, qty: p.qty, timeText: p.timeText,
        statusLabel: p.statusLabel, items: p.detailItems || []
      }
    });
  },
  closeDetail: function () { this.setData({ detailOpen: false }); },
  noop: function () { /* 阻止弹层内点击冒泡关闭 */ },

  // ===== ② 消耗：导出「当前时间范围的全量」（老板 2026-09-19） =====
  // 循环分页拉全量（不设业务条数上限）→ 本地生成 CSV → utils/export 三级降级打开。
  // 不新增云函数、不新增 ACTION。列：日期,时间,菜品,份数,状态,食材,单位,消耗量。
  onExport: function () {
    var that = this;
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.consRange, custom);
    var tag = dr.rangeTag(this.data.consRange, custom);

    wx.showLoading({ title: '正在导出…', mask: true });
    rec.fetchAll({
      from: range.from, to: range.to, pageSize: 500,
      onProgress: function (n) { wx.showLoading({ title: '正在导出… ' + n + ' 条', mask: true }); }
    }).then(function (r) {
      wx.hideLoading();
      if (r.code !== 0) {
        var partial = r.list || [];
        if (!partial.length) {
          wx.showToast({ title: '导出失败：' + (r.reason || '加载失败，请重试'), icon: 'none', duration: 2600 });
          return;
        }
        wx.showModal({
          title: '导出中断',
          content: (r.reason || '加载失败，请重试') + '\n已拉取 ' + partial.length + ' 条，是否用这些继续导出？',
          confirmText: '继续导出', cancelText: '取消',
          success: function (m) { if (m.confirm) { that._writeRows(partial, tag, false); } }
        });
        return;
      }
      if (r.interrupted) {
        wx.showToast({ title: '加载中断，已导出前 ' + (r.list || []).length + ' 条', icon: 'none', duration: 2600 });
        that._writeRows(r.list || [], tag, false);
        return;
      }
      that._writeRows(r.list || [], tag, true);
    });
  },

  /* 生成并打开文件；showCount=true 时 exportTable 会 toast「已导出 N 条」 */
  _writeRows: function (list, tag, showCount) {
    var exp = require('../../../utils/export');
    var built = rec.buildExportRows(list, this._matMap, this._dishMap);
    if (!built.rows.length) { wx.showToast({ title: '暂无可导出的记录', icon: 'none' }); return; }
    var user = (getApp().globalData && getApp().globalData.user) || {};
    var storeName = (user.store && user.store.name) || user.name || '本店';
    exp.exportTable({
      filename: '消耗记录_' + storeName + '_' + tag + '_' + exp.stamp(),
      headers: built.headers,
      rows: built.rows,
      total: showCount ? built.rows.length : undefined
    });
  }
});
