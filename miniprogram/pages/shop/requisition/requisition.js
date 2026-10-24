// ==========================================================================
// pages/shop/requisition — 食材申请（v1.0.3 美团式购物车，老板 2026-09-15 拍板）
// · 双 tab：① 食材申请 / ② 申请记录
// · 食材申请 tab：总仓清单 +/- 加购物车 + 点「购物车」弹已选食材（可改数量/删除）+ 底部单按钮「提交申请」
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var reqView = require('../../../utils/requisition-view');
var search = require('../../../utils/list-search');

Page({
  data: {
    tab: 'req',          // 'req' 食材申请 / 'log' 申请记录
    items: [],          // 全部 active 食材
    cart: {},           // { itemId: qty }
    cartItems: [],      // 弹层用：[{_id, name, unit, qty}]
    cartCount: 0,
    cartOpen: false,    // 已选食材弹层开关（默认关，避免闪出）
    list: [],           // 申请记录（= _listFull 按 kw 过滤后的结果）
    kw: '',             // 搜索词（匹配 单号 + 状态文字；本地过滤，不调云函数）
    submitting: false,  // 提交申请锁（onSubmit 防连点）
    canceling: false    // 撤回申请锁（cancelReq 防连点）
  },

  _listFull: [],       // 申请记录全量（过滤底稿）

  onShow: function () { this.loadAll(); },

  switchTab: function (e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  /** 刷新内嵌申请记录 */
  loadList: function () {
    var that = this;
    cloud.call('requisition', { action: 'list' }).then(function (res) {
      if (res.code !== 0) { return; }
      that._listFull = reqView.decorate(that._matRows || [], res.data.list || []);
      that.applySearch();     // 刷新后重新套一次搜索词（否则 kw 还在、列表却变全量）
    });
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */
  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * 匹配：单号（_id）+ 状态文字（statusLabel）+ **明细里的食材名（itemsText）**
   *   · 老板找单的真实场景是「上周那批**土豆**批下来没有」，单号他根本没记 → itemsText 必须能搜
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值（刷新后重算走这条）
   */
  applySearch: function (kwField, kw) {
    var k = (kwField === 'kw' && kw !== undefined) ? kw : this.data.kw;
    this.setData({
      kw: k,
      list: search.filter(this._listFull, k, ['_id', 'statusLabel', 'itemsText'])
    });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  },

  loadAll: function () {
    var that = this;
    Promise.all([
      cloud.call('material', { action: 'list' }),
      cloud.call('inventory', { storeId: 'WAREHOUSE' }),
      cloud.call('requisition', { action: 'list' })
    ]).then(function (rs) {
      var matRows = rs[0].code === 0 ? rs[0].data.rows : [];
      that._matRows = matRows;

      var warehouseMap = {};
      var whRows = rs[1].code === 0 ? rs[1].data.rows : [];
      whRows.forEach(function (r) { warehouseMap[r.itemId] = r.qty; });

      var items = matRows.filter(function (m) { return m.isActive !== false; })
        .map(function (m) {
          var qty = warehouseMap[m._id];
          return {
            _id: m._id,
            name: m.name,
            unit: m.unit,
            warehouseText: fmt.formatQty(qty === undefined ? 0 : qty, m.unit || ''),
            warehouseQty: qty === undefined ? 0 : qty
          };
        })
        .sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'); });

      var list = reqView.decorate(matRows, rs[2].code === 0 ? rs[2].data.list : []);
      that._listFull = list;
      that.setData({ items: items, list: list });
      that.applySearch();     // 全量刷完重新套一次搜索词
      that._refreshCartView();
      // 兼容旧 storage 'req_copy_items'
      try {
        var copied = wx.getStorageSync('req_copy_items');
        if (copied && copied.length) {
          that.applyCopy(copied);
          wx.removeStorageSync('req_copy_items');
          wx.showToast({ title: '已加入购物车，请确认数量后提交', icon: 'none', duration: 2200 });
        }
      } catch (e) { /* ignore */ }
    });
  },

  // ===== 数量调整 =====
  onInc: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    cart[id] = (Number(cart[id]) || 0) + 1;
    this.setData({ cart: cart });
    this._refreshCartView();
  },
  onDec: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    var n = (Number(cart[id]) || 0) - 1;
    if (n <= 0) { delete cart[id]; } else { cart[id] = n; }
    this.setData({ cart: cart });
    this._refreshCartView();
  },
  onInputQty: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var v = String(e.detail.value || '').replace(/[^\d.]/g, '');
    var n = Number(v) || 0;
    var cart = Object.assign({}, this.data.cart);
    if (n <= 0) { delete cart[id]; } else { cart[id] = n; }
    this.setData({ cart: cart });
    this._refreshCartView();
  },
  onRemoveItem: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    delete cart[id];
    this.setData({ cart: cart });
    this._refreshCartView();
  },

  /** 重算 cartCount + cartItems（弹层用） */
  _refreshCartView: function () {
    var that = this;
    var cart = this.data.cart;
    var itemsById = {};
    this.data.items.forEach(function (it) { itemsById[it._id] = it; });
    var cartItems = [];
    var cartCount = 0;
    Object.keys(cart).forEach(function (id) {
      var qty = Number(cart[id]) || 0;
      if (qty > 0 && itemsById[id]) {
        cartItems.push({ _id: id, name: itemsById[id].name, unit: itemsById[id].unit, qty: qty });
        cartCount += 1;
      }
    });
    this.setData({ cartItems: cartItems, cartCount: cartCount });
  },

  // ===== 弹层 =====
  onOpenCart: function () {
    // v1.0.3 老板拍板：点购物车始终开弹层（包括空 cart，让用户看到"还没有选食材"）
    this.setData({ cartOpen: true });
  },
  onCloseCart: function () {
    this.setData({ cartOpen: false });
  },

  // ===== 提交 =====
  onSubmit: function () {
    // 防连点锁：提交进行中再点直接忽略——文字虽已变「提交中」，但 bindtap 依然会响应，
    // 不拦的话连点两下 = 两笔 requisition.create = 重复申请单（老板报「数据错乱」的根因）
    if (this.data.submitting) { return; }
    var that = this;
    var cart = this.data.cart;
    var items = Object.keys(cart)
      .map(function (id) { var n = Number(cart[id]) || 0; return n > 0 ? { itemId: id, qty: n } : null; })
      .filter(function (x) { return x; });
    if (items.length === 0) { wx.showToast({ title: '还没选食材', icon: 'none' }); return; }
    that.setData({ submitting: true, cartOpen: false });
    cloud.callWithToast('requisition', { action: 'create', items: items }, '申请已提交，等待管理端处理')
      .then(function (res) {
        if (res.code === 0) {
          that.setData({ cart: {}, submitting: false });
          that._refreshCartView();
          that.loadList();
          // 提交成功后自动跳「申请记录」tab
          that.setData({ tab: 'log' });
        } else {
          that.setData({ submitting: false });
        }
      }).catch(function () { that.setData({ submitting: false }); });
  },

  // ===== 申请记录 tab 的撤回 / 复制为新单 =====
  cancelReq: function (e) {
    // 防连点锁（老板总规矩）：撤回链进行中直接忽略；modal 弹出期间也锁住，
    // 连点另一行的「撤回」不并发弹框/发请求
    if (this.data.canceling) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    that.setData({ canceling: true });
    wx.showModal({
      title: '撤回申请',
      content: '撤回后该申请单置为「已撤回」（终态），库存不变。确定继续？',
      success: function (r) {
        if (!r.confirm) { that.setData({ canceling: false }); return; }
        cloud.callWithToast('requisition', { action: 'cancel', requisitionId: id }, '申请已撤回')
          .then(function (res) {
            that.setData({ canceling: false });
            if (res.code === 0) { that.loadList(); }
          })
          .catch(function () { that.setData({ canceling: false }); });
      },
      fail: function () { that.setData({ canceling: false }); }
    });
  },
  copyReq: function (e) {
    var id = e.currentTarget.dataset.id;
    var row = this.data.list.filter(function (r) { return r._id === id; })[0];
    if (!row) { return; }
    this.applyCopy((row.items || []).map(function (it) { return it.itemId; }), row.items);
    this.setData({ tab: 'req' });
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
    wx.showToast({ title: '已加入购物车，确认数量后提交', icon: 'none', duration: 2200 });
  },

  /** 按 itemId 列表回填购物车（兼容旧 storage 与「复制为新单」） */
  applyCopy: function (itemIds, items) {
    var cart = Object.assign({}, this.data.cart);
    var itemsArr = items || [];
    (itemIds || []).forEach(function (itemId, k) {
      var q = itemsArr[k] && itemsArr[k].qty !== undefined ? Number(itemsArr[k].qty) : 1;
      cart[itemId] = q > 0 ? q : 1;
    });
    this.setData({ cart: cart });
    this._refreshCartView();
  }
});