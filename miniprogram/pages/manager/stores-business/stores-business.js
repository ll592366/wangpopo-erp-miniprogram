// ==========================================================================
// pages/manager/stores-business — 分店经营（v1.0.3 老板 2026-09-15 拍板）
// · 列出所有门店卡片：出品明细 / 食材消耗 / 实点差异合计（今日数据）
// · 点门店卡 → 进门店详情（库存/预警/今日出品/食材消耗/实点）
// · v1.0.3 砍掉 3 tab（7天/本月要云函数升级，等接入再加）
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var search = require('../../../utils/list-search');

Page({
  data: {
    stores: [],  // [{_id, name, status, isActive, productionCount, consumeQty, variance}]
    kw: ''           // 搜索词（匹配 门店名；本地过滤，不调云函数）
  },

  _storesFull: [],    // 门店全量（过滤底稿）

  onShow: function () { this.loadAll(); },

  onPullDownRefresh: function () {
    this.loadAll();
    wx.stopPullDownRefresh();
  },

  loadAll: function () {
    var that = this;
    // v1.0.3 老板 2026-09-15 拍板"门店没同步进来"：bug — 云函数返回 sr.data.rows，前端误读 sr.data.list → 永远空数组
    cloud.call('store', { action: 'list' }).then(function (sr) {
      if (sr.code !== 0) { return; }
      var stores = (sr.data && (sr.data.rows || sr.data.list)) || [];  // 兼容两种字段名
      var proms = stores.map(function (s) {
        return cloud.call('production', { action: 'list', storeId: s._id }).then(function (pr) {
          return { store: s, prods: pr.code === 0 ? (pr.data.list || []) : [] };
        });
      });
      Promise.all(proms).then(function (rows) {
        var assembled = rows.map(function (r) {
          var s = r.store;
          var prods = r.prods;
          var productionCount = prods.length;
          var consumeByItem = {};
          prods.forEach(function (p) {
            (p.consumeItems || []).forEach(function (ci) {
              consumeByItem[ci.itemId] = (consumeByItem[ci.itemId] || 0) + Number(ci.qty || 0);
            });
          });
          var consumeItemCount = Object.keys(consumeByItem).length;
          var operating = s.isActive !== false && s.status !== 'closed';
          return {
            _id: s._id,
            name: s.name,
            status: s.status || 'open',
            operating: operating,
            productionCount: productionCount,
            consumeItemCount: consumeItemCount,
            consumeText: consumeItemCount === 0 ? '无消耗' : (consumeItemCount + ' 种食材')
          };
        });
        assembled.sort(function (a, b) {
          if (a.operating !== b.operating) { return a.operating ? -1 : 1; }
          return a._id < b._id ? -1 : 1;
        });
        that._storesFull = assembled;
        that.setData({ stores: assembled });
        that.applySearch();     // 拉完重新套一次搜索词（onShow 回来也不会丢过滤）
      });
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
    this.setData({ kw: k, stores: search.filter(this._storesFull, k, ['name']) });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  },

  /** 点门店卡 → 进门店详情 */
  goStore: function (e) {
    var id = e.currentTarget.dataset.id;
    var s = this.data.stores.filter(function (x) { return x._id === id; })[0];
    if (!s) { return; }
    wx.navigateTo({ url: '/pages/manager/store-detail/store-detail?storeId=' + id + '&name=' + encodeURIComponent(s.name) });
  }
});