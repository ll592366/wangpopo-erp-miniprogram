// ==========================================================================
// pages/manager/store-detail — 门店详情（v1.0.3 老板 2026-09-15 拍板三 tab）
// · Tab ① 库存：该店食材库存（缺货红标）
// · Tab ② 录入消耗：菜品列表 + [-] [数字] [+] 购物车 + 底部「录入消耗」单按钮
// · Tab ③ 历史消耗：该店出品/消耗记录，按日期分组，点记录弹明细
//       老板 2026-09-19 拍板：① 时间范围筛选（本周/本月/自定义/全部，默认本月）
//         ② 列表「加载更多」（触底追加，首次 100 条，不把全量塞进页面）
//         ③ 导出 = 时间范围内「全量」（循环分页拉，无业务条数上限）
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var dr = require('../../../utils/date-range');
var rec = require('../../../utils/consume-records');
var search = require('../../../utils/list-search');

var LIST_PAGE = 100;    // 列表每页条数（触底追加）
var CALIB_PAGE = 30;    // 校准记录每页条数（触底追加）

/** 校准差异类型 → 中文（与云函数 C.DIFF_TYPE 对齐） */
var DIFF_LABEL = { none: '无差异', short: '短缺', over: '盈余' };

/** 本店未设阈值时的默认值（与云函数 C.CONFIG.LOW_STOCK_THRESHOLD 对齐，=2） */
var DEFAULT_THRESHOLD = 2;

/**
 * 阈值归一：非法 / 没设 → 回落默认 2。
 * ⚠️ 这里的入参**只能**是 inventory 返回的 lowStockThreshold —— 门店语境下它已经是
 *    **本店阈值**（云函数 inventory 按语境切换过），绝不是 material 的总仓阈值。
 */
function thresholdOf(v) {
  var n = Number(v);
  return (isFinite(n) && n > 0) ? n : DEFAULT_THRESHOLD;
}

/** '2026-09-15' → '9.15' */
function dateLabel(bizDate) {
  var parts = String(bizDate || '').split('-');
  if (parts.length === 3) { return Number(parts[1]) + '.' + Number(parts[2]); }
  return bizDate || '';
}

Page({
  data: {
    storeId: '',
    storeName: '',
    tab: 'stock',         // 'stock' 库存 | 'consume' 录入消耗 | 'history' 历史消耗
    // ① 库存 tab
    inventory: [],
    alertCount: 0,          // 本店低库存食材数（按各食材生效阈值算）
    // ⚠️ 「本店统一阈值」卡已于 2026-10-08 老板拍板删除：阈值改成**每食材单独设**
    //    （校准弹窗里设），没单独设的就是默认 2。store.setThreshold 云函数保留未删
    //    （历史门店可能已设过全店值，仍作为回落层生效）。
    // ① 库存校准弹层（2026-10-08 老板拍板：点库存行 → 覆盖式改库存 / 给该食材单独设阈值）
    calibOpen: false,
    calib: null,            // { itemId, name, unit, qtyText, thText }
    calibQty: '',           // 实点数量输入框（留空 = 不改库存）
    calibTh: '',            // 该食材单独阈值（留空 = 跟随本店统一值）
    savingCalib: false,
    // ④ 校准记录
    calibList: [],
    calibCount: 0,
    calibHasMore: false,
    calibLoading: false,
    // ② 录入消耗 tab
    dishes: [],              // 可用菜品**全量**（购物车 byId 反查要用，不能被搜索过滤掉）
    dishesView: [],          // 页面渲染用（= dishes 按 kwDish 过滤后的结果）
    kwInv: '',               // 库存搜索词（匹配 食材名）
    kwDish: '',              // 可用菜品搜索词（匹配 菜名）
    cart: {},
    cartItems: [],
    cartCount: 0,
    cartOpen: false,
    submitting: false,
    // ③ 历史消耗 tab：时间范围筛选（老板 2026-09-19）+ 分页加载
    histPresets: dr.PRESETS,       // 本周 / 本月 / 自定义 / 全部
    histRange: 'month',            // 默认本月
    customFrom: dr.monthStart(dr.today()),
    customTo: dr.today(),
    histEmptyText: '本月暂无消耗记录',
    historyGroups: [],             // [{ dateLabel, items:[...] }]
    histCount: 0,                  // 已加载条数
    listHasMore: false,            // 是否还有下一页
    listLoadingMore: false,        // 触底加载中
    // 消耗明细弹层
    detailOpen: false,
    detail: null
  },

  // 非渲染缓存
  _matMap: {},        // { itemId: material }
  _dishMap: {},       // { dishId: dish }
  _raw: [],           // 已加载的 production 原始记录（含装饰字段），分页累加
  _storeTh: 2,        // 门店历史统一阈值（loadAll 刷新；判断某食材是否「单独设了阈值」用）
  _calibOffset: 0,    // 校准记录已加载条数（触底追加的 offset）
  _inventoryFull: [], // 库存全量（过滤底稿）
  _dishesFull: [],    // 可用菜品全量（过滤底稿）

  onLoad: function (query) {
    this.setData({ storeId: query.storeId || '', storeName: decodeURIComponent(query.name || '') });
    wx.setNavigationBarTitle({ title: decodeURIComponent(query.name || '门店详情') });
  },

  onShow: function () { this.loadAll(); },

  /* 触底：仅历史消耗 tab 追加下一页（老板 2026-09-19） */
  onReachBottom: function () {
    if (this.data.tab === 'history') { this.loadMoreHistory(); }
    if (this.data.tab === 'calib') { this.loadMoreCalib(); }
  },

  switchTab: function (e) {
    var t = e.currentTarget.dataset.tab;
    this.setData({ tab: t });
    // 校准记录：切进来才拉（列表页不该在首屏就多打一次云调用）
    if (t === 'calib') { this.reloadCalib(); }
  },

  /* ===== ③ 历史消耗：时间范围筛选（老板 2026-09-19） ===== */
  switchHistRange: function (e) {
    var k = e.currentTarget.dataset.key;
    if (k === this.data.histRange) { return; }
    var patch = { histRange: k };
    if (k === 'custom') {
      patch.customFrom = this.data.customFrom || dr.monthStart(dr.today());
      patch.customTo = this.data.customTo || dr.today();
    }
    this.setData(patch);
    this.reloadHistory();      // 换档 → 重置 offset 重新拉第一页
  },
  onHistFromChange: function (e) {
    var v = e.detail.value;
    var to = this.data.customTo;
    if (v > to) { to = v; }     // from > to 自动纠正
    this.setData({ customFrom: v, customTo: to });
    this.reloadHistory();
  },
  onHistToChange: function (e) {
    var v = e.detail.value;
    var from = this.data.customFrom;
    if (v < from) { from = v; }
    this.setData({ customFrom: from, customTo: v });
    this.reloadHistory();
  },

  /* 静态数据（库存/菜品/档案映射）+ 历史第一页 */
  loadAll: function () {
    var that = this;
    var sid = this.data.storeId;
    if (!sid) { return; }
    Promise.all([
      cloud.call('inventory', { storeId: sid }),
      cloud.call('material', { action: 'list' }),
      cloud.call('dish', { action: 'list' })
    ]).then(function (rs) {
      var matMap = {};
      (rs[1].code === 0 ? rs[1].data.rows : []).forEach(function (m) { matMap[m._id] = m; });
      var dishMap = {};
      (rs[2].code === 0 ? rs[2].data.rows : []).forEach(function (d) { dishMap[d._id] = d; });
      that._matMap = matMap;
      that._dishMap = dishMap;

      // ① 库存
      // 2026-10-09 老板拍板：**门店有自己的预警阈值**（每店一个统一值，存在 store 文档上）。
      //   本页看的是**门店**库存，阈值**只**用 inventory 返回的 lowStockThreshold ——
      //   门店语境下云函数已把它切换成**本店阈值**，不是 material 的总仓备货警戒线
      //   （总仓备货线可能 10 包，门店日常只有 2~3 包 → 拿它比门店库存会常年误报）。
      // ⚠️ 本页**绝不能**去读 material 的阈值字段，那是总仓口径。
      // ⚠️ 总仓自己的预警页在 manager/wh-stock-alert，那里仍用总仓阈值，**不要改**。
      /* 本店统一阈值：行级 ownThreshold 判断要用，必须在 forEach **之前**算出来。
       * ⚠️ 取 inventory **顶层**的 storeThreshold，不能寄生在 rows[0] 上 ——
       *    rows 是按活跃食材档案逐条出行的，该店库存 0 行（新店 / 档案为空 / 云调用失败）
       *    时 rows[0] 根本不存在 → 会误判。兜底：云函数还没部署（旧版无该字段）时退回 rows[0]。 */
      var curTh = (rs[0].data || {}).storeThreshold;
      if (curTh === undefined && rs[0].code === 0 && (rs[0].data.rows || []).length) {
        curTh = rs[0].data.rows[0].lowStockThreshold;
      }
      var hasTh = curTh !== null && curTh !== undefined && Number(curTh) > 0;
      var storeTh = hasTh ? Number(curTh) : DEFAULT_THRESHOLD;
      that._storeTh = storeTh;

      var inventory = rs[0].code === 0 ? rs[0].data.rows : [];
      var alertCount = 0;
      inventory.forEach(function (r) {
        var m = matMap[r.itemId] || {};
        r.name = m.name || ('#' + r.itemId);
        r.unit = r.unit || (m.unit || '');
        r.spec = m.spec || '';
        r.qtyText = fmt.formatQty(r.qty, r.unit);
        r.timeText = fmt.fmtShort(r.updatedAt);
        // 本店阈值（inventory 已按语境给成门店值；缺省回落 2）
        r.threshold = thresholdOf(r.lowStockThreshold);
        r.thText = fmt.formatQty(r.threshold, r.unit);
        r.low = r.qty < r.threshold;
        r.gap = r.low ? fmt.formatQty(r.threshold - r.qty, r.unit) : '';
        // 该食材是否自己单独设过阈值（≠ 本店统一值 → 是单独设的，列表里要标出来）
        r.ownThreshold = Number(r.lowStockThreshold) > 0 && Number(r.lowStockThreshold) !== storeTh;
        if (r.low) { alertCount += 1; }
      });
      // ② 录入消耗 tab：可用菜品（仅启用），带每份消耗 chip 文本
      var dishes = (rs[2].code === 0 ? rs[2].data.rows : []).filter(function (d) { return d.isActive !== false; });
      dishes.forEach(function (d) {
        d.bomText = (d.consumeItems || []).map(function (ci) {
          var m = matMap[ci.itemId];
          var per = ci.portions && Number(ci.portions) > 0 ? ci.qty / Number(ci.portions) : ci.qty;
          return (m ? m.name : ci.itemId) + ' ' + fmt.formatQty(per, m ? m.unit : '') + '/份';
        }).join('；') || '未配置消耗清单';
      });
      dishes.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'); });

      that._inventoryFull = inventory;
      that._dishesFull = dishes;
      that.setData({ inventory: inventory, dishes: dishes, alertCount: alertCount });
      // 库存 / 菜品都刷完了，必须重新套一次搜索词（否则 kw 还在、列表却变全量）
      that.applySearch();
      that._refreshCartCount();
      that.reloadHistory();
    });
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */
  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * ⚠️ 可用菜品只把过滤结果写进 dishesView，`dishes` 保持全量 ——
   *    购物车的 byId 反查（_refreshCartCount）依赖全量，搜掉就会让已加购的菜凭空消失。
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 两个都重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值
   */
  applySearch: function (kwField, kw) {
    var kInv = this.data.kwInv;
    var kDish = this.data.kwDish;
    if (kwField === 'kwInv') { kInv = (kw === undefined) ? '' : kw; }
    if (kwField === 'kwDish') { kDish = (kw === undefined) ? '' : kw; }
    this.setData({
      kwInv: kInv,
      kwDish: kDish,
      inventory: search.filter(this._inventoryFull, kInv, ['name']),
      dishesView: search.filter(this._dishesFull, kDish, ['name'])
    });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  /** 清除：只清自己那一个搜索框（点哪个「✕」清哪个） */
  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  },

  /* ===== ① 库存校准（2026-10-08 老板拍板：点库存行弹出，覆盖式改库存 + 该食材单独阈值） ===== */
  openCalib: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    var r = this.data.inventory[idx];
    if (!r) { return; }
    this.setData({
      calibOpen: true,
      calib: {
        itemId: r.itemId, name: r.name, unit: r.unit || '',
        unitPart: r.unit ? '（' + r.unit + '）' : '',   // 标签里的单位（没有单位就不显示空括号）
        qtyText: r.qtyText,
        thText: r.thText   // ⚠️ thText = formatQty 已含单位，绝不再拼一次（曾出现「2.00 包包」）
      },
      calibQty: '',                                        // 数量不预填：留空 = 不改库存
      calibTh: r.ownThreshold ? String(r.threshold) : ''   // 单独设过才预填；没设过留空 = 跟随本店统一值
    });
  },
  onCalibQtyInput: function (e) {
    this.setData({ calibQty: String(e.detail.value || '').replace(/[^\d.]/g, '') });
  },
  onCalibThInput: function (e) {
    this.setData({ calibTh: String(e.detail.value || '').replace(/[^\d.]/g, '') });
  },
  closeCalib: function () { this.setData({ calibOpen: false }); },

  /** 该食材是否单独设过阈值（决定"阈值留空"要不要发清除指令） */
  _hasOwnTh: function (itemId) {
    var found = null;
    (this.data.inventory || []).forEach(function (r) { if (r.itemId === itemId) { found = r; } });
    return !!(found && found.ownThreshold);
  },

  onSaveCalib: function () {
    // 防连点锁（老板 2026-10-13 总规矩）：校准保存进行中直接忽略。
    // callWithToast 带 loading 遮罩（mask:true）能挡大部分，但 setData 异步渲染的
    // 空档期（遮罩未起时）连点两下依然会发出两笔 calibrate——入口锁兜底。
    if (this.data.savingCalib) { return; }
    var that = this;
    var calib = this.data.calib || {};
    var rawQty = String(this.data.calibQty || '').trim();
    var rawTh = String(this.data.calibTh || '').trim();
    var payload = { action: 'calibrate', storeId: this.data.storeId, itemId: calib.itemId };

    // 数量：留空 = 不改库存；填了就按实点数覆盖（**0 是合法值**）
    if (rawQty !== '') {
      var q = Number(rawQty);
      if (!isFinite(q) || q < 0) {
        wx.showToast({ title: '数量要填 0 或正数', icon: 'none', duration: 2600 });
        return;
      }
      payload.qty = q;
    }
    // 阈值：留空 = 清除单独设置（回到本店统一值）；填了必须是 >0 的数字
    if (rawTh !== '') {
      var t = Number(rawTh);
      if (!isFinite(t) || !(t > 0)) {
        wx.showToast({ title: '阈值要填大于 0 的数', icon: 'none', duration: 2600 });
        return;
      }
      payload.threshold = t;
    } else if (this._hasOwnTh(calib.itemId)) {
      payload.threshold = null;   // 原本单独设过、现在清空 → 发清除指令
    }
    if (payload.qty === undefined && payload.threshold === undefined) {
      wx.showToast({ title: '没有要保存的改动', icon: 'none', duration: 2200 });
      return;
    }

    this.setData({ savingCalib: true });
    cloud.callWithToast('inventory', payload, '已校准', { loading: '保存中' }).then(function (res) {
      that.setData({ savingCalib: false });
      if (!res || res.code !== 0) { return; }
      that.setData({ calibOpen: false });
      that.loadAll();                                     // 库存/阈值都变了，整页刷新
      if (that.data.tab === 'calib') { that.reloadCalib(); }
    }).catch(function () {
      // 兜底复位（then 回调同步抛错时；cloud.call 自身永不 reject）
      that.setData({ savingCalib: false });
    });
  },

  /* ===== ④ 校准记录（切到该 tab 才拉；触底追加） ===== */
  reloadCalib: function () {
    this._calibOffset = 0;
    this.setData({ calibList: [], calibCount: 0, calibHasMore: false, calibLoading: true });
    this._fetchCalib(0);
  },
  loadMoreCalib: function () {
    if (!this.data.calibHasMore || this.data.calibLoading) { return; }
    this.setData({ calibLoading: true });
    this._fetchCalib(this._calibOffset);
  },
  _fetchCalib: function (offset) {
    var that = this;
    var sid = this.data.storeId;
    if (!sid) { this.setData({ calibLoading: false }); return; }
    return cloud.call('inventory', { action: 'calibrateList', storeId: sid, offset: offset, limit: CALIB_PAGE })
      .then(function (res) {
        if (!res || res.code !== 0) {
          that.setData({ calibLoading: false });
          wx.showToast({ title: (res && res.message) || '加载失败，请重试', icon: 'none', duration: 2600 });
          return;
        }
        var list = (res.data && res.data.list) || [];
        list.forEach(function (r, i) {
          r._key = (offset + i) + '_' + r.itemId;   // 记录接口不返回 _id，自己造一个稳定的 key
          r.timeText = fmt.fmtShort(r.createdAt);
          r.qtyText = fmt.formatQty(r.qty, '');
          r.deltaText = (r.delta > 0 ? '+' : '') + fmt.formatQty(r.delta, '');
          r.diffText = DIFF_LABEL[r.diffType] || '无差异';
        });
        var all = offset === 0 ? list : that.data.calibList.concat(list);
        that._calibOffset = all.length;
        that.setData({
          calibList: all, calibCount: all.length,
          calibHasMore: !!(res.data && res.data.hasMore), calibLoading: false
        });
      });
  },

  /* 历史消耗：重置并拉第一页 */
  reloadHistory: function () {
    var that = this;
    var sid = this.data.storeId;
    if (!sid) { return; }
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.histRange, custom);
    this._raw = [];
    this.setData({ historyGroups: [], histCount: 0, listHasMore: false, listLoadingMore: true,
      histEmptyText: dr.emptyText(this.data.histRange, custom) });

    rec.fetchPage({ storeId: sid, from: range.from, to: range.to, offset: 0, limit: LIST_PAGE })
      .then(function (res) {
        if (!res || res.code !== 0) {
          that.setData({ listLoadingMore: false });
          wx.showToast({ title: (res && res.message) || '加载失败，请重试', icon: 'none', duration: 2600 });
          return;
        }
        var list = (res.data && res.data.list) || [];
        that._raw = list.map(function (p) { return that._decorate(p); });
        that.setData({ listLoadingMore: false, listHasMore: !!(res.data && res.data.hasMore) });
        that._renderHistory();
      });
  },

  /* 历史消耗：触底追加下一页 */
  loadMoreHistory: function () {
    var that = this;
    var sid = this.data.storeId;
    if (!sid || !this.data.listHasMore || this.data.listLoadingMore) { return; }
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.histRange, custom);
    var offset = (this._raw || []).length;
    this.setData({ listLoadingMore: true });
    rec.fetchPage({ storeId: sid, from: range.from, to: range.to, offset: offset, limit: LIST_PAGE })
      .then(function (res) {
        if (!res || res.code !== 0) {
          that.setData({ listLoadingMore: false });
          wx.showToast({ title: '加载更多失败', icon: 'none' });
          return;
        }
        var list = (res.data && res.data.list) || [];
        list.forEach(function (p) { that._raw.push(that._decorate(p)); });
        that.setData({ listLoadingMore: false, listHasMore: !!(res.data && res.data.hasMore) });
        that._renderHistory();
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
    return p;
  },

  /* 分组渲染（按 bizDate） */
  _renderHistory: function () {
    var byDate = {};
    var groups = [];
    (this._raw || []).forEach(function (p) {
      var key = p.bizDate || '';
      if (!byDate[key]) { byDate[key] = { dateLabel: dateLabel(key), items: [] }; groups.push(byDate[key]); }
      byDate[key].items.push(p);
    });
    this.setData({ historyGroups: groups, histCount: (this._raw || []).length });
  },

  // ===== 历史消耗：点记录 → 明细弹层 =====
  openDetail: function (e) {
    var ds = e.currentTarget.dataset;
    var group = this.data.historyGroups[Number(ds.gi)] || {};
    var p = (group.items || [])[Number(ds.ii)];
    if (!p) { return; }
    this.setData({
      detailOpen: true,
      detail: {
        dishName: p.dishName, qty: p.qty, timeText: p.timeText,
        statusLabel: p.statusLabel, dateLabel: group.dateLabel || '', items: p.detailItems || []
      }
    });
  },
  closeDetail: function () { this.setData({ detailOpen: false }); },

  // ===== 录入消耗：购物车增减 =====
  onInc: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    cart[id] = (Number(cart[id]) || 0) + 1;
    this.setData({ cart: cart });
    this._refreshCartCount();
  },
  onDec: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    var n = (Number(cart[id]) || 0) - 1;
    if (n <= 0) { delete cart[id]; } else { cart[id] = n; }
    this.setData({ cart: cart });
    this._refreshCartCount();
  },
  onInputQty: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var v = String(e.detail.value || '').replace(/[^\d.]/g, '');
    var n = Number(v) || 0;
    var cart = Object.assign({}, this.data.cart);
    if (n <= 0) { delete cart[id]; } else { cart[id] = n; }
    this.setData({ cart: cart });
    this._refreshCartCount();
  },
  _refreshCartCount: function () {
    var cart = this.data.cart;
    var byId = {};
    (this.data.dishes || []).forEach(function (d) { byId[d._id] = d; });
    var cartItems = [];
    var cartCount = 0;
    Object.keys(cart).forEach(function (id) {
      var qty = Number(cart[id]) || 0;
      if (qty > 0 && byId[id]) {
        cartItems.push({ _id: id, name: byId[id].name, bomText: byId[id].bomText, qty: qty });
        cartCount += 1;
      }
    });
    this.setData({ cartItems: cartItems, cartCount: cartCount });
  },

  // ===== 弹层 =====
  onOpenCart: function () {
    // 老板 2026-09-15 拍板：点购物车始终弹层（含空 cart，让用户看到"还没有选菜品"）
    this.setData({ cartOpen: true });
  },
  onCloseCart: function () {
    this.setData({ cartOpen: false });
  },
  onRemoveItem: function (e) {
    var id = String(e.currentTarget.dataset.id);
    var cart = Object.assign({}, this.data.cart);
    delete cart[id];
    this.setData({ cart: cart });
    this._refreshCartCount();
  },
  noop: function () {},

  // ===== 提交：每个菜品串行调 production.create（事务并发会 -501001，参考 memory 教训） =====
  onSubmit: function () {
    // 防连点锁：串行录入进行中再点直接忽略——文字虽已变「提交中」，但 bindtap 依然会响应，
    // 不拦的话连点两下 = 整批 production.create 重发一遍 = 重复消耗单（老板报「数据错乱」的根因）
    if (this.data.submitting) { return; }
    var that = this;
    var cart = this.data.cart;
    var items = Object.keys(cart)
      .map(function (id) { return { dishId: id, qty: Number(cart[id]) || 0 }; })
      .filter(function (x) { return x.qty > 0; });
    if (items.length === 0) { wx.showToast({ title: '还没选菜品', icon: 'none' }); return; }
    that.setData({ submitting: true });
    var okCount = 0, errCount = 0, errMsg = '';
    var p = Promise.resolve();
    items.forEach(function (it) {
      p = p.then(function () {
        // 必须带 storeId：manager 的 user.storeId 为 null，不传会让云函数落到"缺少门店"
        return cloud.call('production', { action: 'create', dishId: it.dishId, qty: it.qty, storeId: that.data.storeId });
      }).then(function (res) {
        if (res.code === 0) { okCount += 1; } else { errCount += 1; errMsg = res.message || '操作失败'; }
      });
    });
    p.then(function () {
      that.setData({ submitting: false, cart: {}, cartOpen: false });
      that._refreshCartCount();
      that.loadAll();  // 重新拉库存 + 历史消耗
      if (errCount === 0) {
        wx.showToast({ title: '已录入 ' + okCount + ' 单', icon: 'success' });
        that.setData({ tab: 'stock' });  // 提交完跳回库存 tab 看效果
      } else {
        wx.showModal({ title: '部分失败', content: '成功 ' + okCount + ' 单，失败 ' + errCount + ' 单\n' + errMsg, showCancel: false });
      }
    });
  },

  /* ===== ③ 历史消耗：导出「当前时间范围的全量」（老板 2026-09-19） =====
   * 循环分页拉全量（不设业务条数上限）→ 本地生成 CSV → utils/export 三级降级打开。
   * 不新增云函数、不新增 ACTION。列：日期,时间,菜品,份数,状态,食材,单位,消耗量。 */
  onExport: function () {
    var that = this;
    var sid = this.data.storeId;
    if (!sid) { wx.showToast({ title: '门店信息缺失', icon: 'none' }); return; }
    var custom = { from: this.data.customFrom, to: this.data.customTo };
    var range = dr.rangeOf(this.data.histRange, custom);
    var tag = dr.rangeTag(this.data.histRange, custom);

    wx.showLoading({ title: '正在导出…', mask: true });
    rec.fetchAll({
      storeId: sid, from: range.from, to: range.to, pageSize: 500,
      onProgress: function (n) { wx.showLoading({ title: '正在导出… ' + n + ' 条', mask: true }); }
    }).then(function (r) {
      wx.hideLoading();
      if (r.code !== 0) {
        // 请求失败：中断 + 明确 toast；有部分数据则询问是否用已拉到的部分继续导出
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
        // 防呆兜底中断（正常碰不到）：提示后仍导出已拉到部分
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
    exp.exportTable({
      filename: '消耗记录_' + (this.data.storeName || '门店') + '_' + tag + '_' + exp.stamp(),
      headers: built.headers,
      rows: built.rows,
      total: showCount ? built.rows.length : undefined
    });
  }
});
