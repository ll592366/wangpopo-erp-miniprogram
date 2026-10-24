// ==========================================================================
// pages/manager/wh-stock-alert — 总仓库存 + 食材预警（合并单卡版）
// 老板 2026-09-12 拍板：不再分「食材预警」「总仓库存」两张卡（同一批缺货食材出现两遍）。
// 只留一张总仓库存卡：缺货食材排最前 + 红标 + 缺多少；判断口径 = 库存 < (lowStockThreshold || 2)。
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var search = require('../../../utils/list-search');

Page({
  data: {
    rows: [],
    kw: '',                 // 搜索词（匹配 食材名；本地过滤，不调云函数）
    alertCount: 0
  },

  _rowsFull: [],           // 全量行（过滤底稿；过滤只改渲染用的 rows）

  onShow: function () { this.loadAll(); },

  onPullDownRefresh: function () {
    this.loadAll();
    wx.stopPullDownRefresh();
  },

  loadAll: function () {
    var that = this;
    cloud.call('inventory', { storeId: 'WAREHOUSE' }).then(function (res) {
      var rows = res.code === 0 ? res.data.rows : [];
      var alertCount = 0;
      rows.forEach(function (r) {
        var th = r.lowStockThreshold === null ? 2 : r.lowStockThreshold;
        r.thText = fmt.formatQty(th, '');
        r.qtyText = fmt.formatQty(r.qty, r.unit);
        r.low = r.qty < th;
        r.gap = r.low ? fmt.formatQty(th - r.qty, '') : 0;
        r.timeText = fmt.fmtShort(r.updatedAt);
        if (r.low) { alertCount += 1; }
      });
      // 缺货排最前（缺得多的更靠前），其余保持原序
      rows.sort(function (a, b) {
        if (a.low !== b.low) { return a.low ? -1 : 1; }
        if (a.low && b.low) { return b.gap - a.gap; }
        return 0;
      });
      that._rowsFull = rows;
      that.setData({ rows: rows, alertCount: alertCount });
      that.applySearch();     // 拉完重新套一次搜索词（onShow 回来也不会丢过滤）
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
    this.setData({ kw: k, rows: search.filter(this._rowsFull, k, ['name']) });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  }
});
