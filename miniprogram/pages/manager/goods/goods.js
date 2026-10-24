// ==========================================================================
// pages/manager/goods — 商品管理（食材 / 菜品 两页签）· 独立功能页
// 老板 2026-09-15 拍板：从首页（home）拆分出来，点首页"商品管理"卡进此页
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var search = require('../../../utils/list-search');

/**
 * 列表标题里的计数文案（老板 2026-10：搜一下变成 3 条，老板会怀疑「另外 60 条去哪了」→ 显示 3/总数）
 * · 无搜索词 → 「64」（就是当前显示条数，不啰嗦）
 * · 有搜索词 → 「3/64」，分母只用云函数 material/dish list 返回的**真 total**
 * · total 拿不到 / 小于当前显示条数（老云函数、异常数据）→ 回落成「64」，
 *   **绝不编一个假总数出来**（编了比不显示更糟：老板会以为另 60 条被系统吞了）
 * @param {number} shown 当前列表显示条数
 * @param {string} kw    当前搜索词（空 = 没搜）
 * @param {number} total 云函数返回的总数
 * @returns {string}
 */
function countText(shown, kw, total) {
  var t = Number(total);
  if (!kw) { return String(shown); }
  if (!isFinite(t) || t <= 0 || t < shown) { return String(shown); }
  return shown + '/' + t;
}

Page({
  data: {
    tab: 'material',
    materials: [],
    dishes: [],
    // 新建/编辑食材档案（名称 / 规格 / 单位 / 预警值 + 数量）
    //   · 新建：mQty = 建档初始数量（走采购入库，留流水）
    //   · 编辑：mQty = 总仓数量（可就地覆盖调整）；mQtyOrigin 记预填值，用来判「有没有改」
    mName: '', mSpec: '', mUnit: '', mTh: '', mQty: '', mQtyOrigin: '',
    editingId: '',      // 非空 = 正在编辑这条档案（种子档案规格为空时用来补规格）
    // 新增菜品（内嵌消耗清单）
    dName: '',
    ciRows: [{ materialIndex: 0, qty: '', portions: '' }],
    materialOptions: [],
    editingDishId: '',     // 非空 = 正在编辑这条菜品（点列表里的「编辑」触发）
    // 食材下架（老板 2026-10 拍板）：列表默认只显示在售的，开开关才把已下架的也列出来
    showInactive: false,   // 开关状态：true = 连已下架的一起显示
    inactiveCount: 0,      // 已下架条数（开关文案「显示已下架（N）」用）
    viewMaterials: [],     // 实际渲染的列表（先按 showInactive 过滤，再按 kwMat 过滤）
    // 检索（老板 2026-10：每个列表都能快速定位；本地过滤，不调云函数）
    //   两个列表各一个搜索词，且**跨页签保留**（食材↔菜品来回切不清空）
    kwMat: '',             // 食材列表搜索词（匹配 名称 + 规格）
    kwDish: '',             // 菜品列表搜索词（匹配 菜名）
    // 列表计数文案（老板 2026-10：搜一下变成 3 条，老板会怀疑「另外 60 条去哪了」→ 显示 3/总数）
    //   · 无搜索词 → 「64」（就是当前显示条数，不啰嗦）
    //   · 有搜索词 → 「3/64」（分母 = 云函数 material/dish list 返回的 total）
    matTotal: 0,          // material.list 的 total；云函数没给就保持 0（此时不显示 x/y）
    dishTotal: 0,         // dish.list 的 total
    matCountText: '',     // 标题里那段文字，如「64」或「3/64」
    dishCountText: '',
    // 防连点锁（老板 2026-10-13 总规矩：所有可能重复提交的入口都要拦）：函数入口 return +
    // 链尾复位，锁覆盖整条写链。删除/上下架按钮都有确认弹窗挡第一层，锁是第二层。
    matSaving: false,     // saveMaterial 保存中（绑到按钮 disabled，双保险）
    dishSaving: false,    // saveDish 保存中（同上）
    matRemoving: false,   // removeMaterial 删除中（删除走确认弹窗，锁防弹窗期间的并发）
    matToggling: false,   // toggleActive 上/下架中（上架无弹窗，锁是唯一防线）
    dishRemoving: false   // removeDish 删除中（同 removeMaterial）
  },

  // 非渲染缓存（过滤底稿：过滤只改渲染用的字段，底稿永远是全量）
  _viewMaterialsFull: [],   // 已过 showInactive 开关、尚未过搜索词的食材
  _dishesFull: [],          // 菜品全量

  onShow: function () { this.loadAll(); },

  loadAll: function () {
    var that = this;
    cloud.call('material', { action: 'list' }).then(function (res) {
      var mats = res.code === 0 ? res.data.rows : [];
      // ⚠️ 字段名就是 total（不是 count）：material.list 返回 { rows, total, truncated }
      //   拿不到（云函数还没升级）时**留 0**，不拿 rows.length 冒充总数 ——
      //   那样会显示成「1/4」，老板以为另外 60 条被吞了；留 0 时 countText 回落成单值「1」
      var matTotal = (res.code === 0 && res.data && typeof res.data.total === 'number') ? res.data.total : 0;
      var options = mats.filter(function (m) { return m.isActive !== false; })
        .map(function (m, i) { return { index: i, _id: m._id, name: m.name + '（' + m.unit + '）', label: m.name + '（' + m.unit + '）' }; });
      that.setData({ materials: mats, materialOptions: options, matTotal: matTotal });
      that._baseOptions = options;   // 未加工的「在售」下拉源（编辑菜品补选项后用它还原）
      that._applyFilter();
      // 总仓库存并入列表（改数量 / 展示用）
      cloud.call('inventory', {}).then(function (sres) {
        if (sres.code !== 0) { return null; }
        var stockMap = {};
        (sres.data.rows || []).forEach(function (r) { stockMap[r.itemId] = r.qty; });
        var merged = that.data.materials.map(function (m) {
          return Object.assign({}, m, { stock: stockMap[m._id] || 0 });
        });
        that.setData({ materials: merged });
        that._applyFilter();
        return null;
      });
      return cloud.call('dish', { action: 'list' });
    }).then(function (res) {
      var dishes = res.code === 0 ? res.data.rows : [];
      // dish.list 同样返回 { rows, total, truncated }；拿不到就留 0（不拿 rows.length 冒充）
      var dishTotal = (res.code === 0 && res.data && typeof res.data.total === 'number') ? res.data.total : 0;
      // 菜品消耗清单渲染：itemId → 食材名（unit 取食材档案）
      // 2026-09-15 老板"优化消耗显示"：改成 chip 列表 [{name, perText}]，不再一长串堆一行
      var matMap = {};
      that.data.materials.forEach(function (m) { matMap[m._id] = m; });
      dishes.forEach(function (d) {
        d.consumeChips = (d.consumeItems || []).map(function (ci) {
          var m = matMap[ci.itemId];
          var per = ci.portions && Number(ci.portions) > 0 ? ci.qty / Number(ci.portions) : ci.qty;
          return {
            // 食材被删除（档案里查不到）时兜底「已下架食材」，绝不把内部 id 显示给老板
            name: m ? m.name : '已下架食材',
            perText: fmt.formatQty(per, m ? m.unit : '') + '/份',
            unit: m ? m.unit : ''
          };
        });
        d.consumeText = d.consumeChips.length === 0
          ? '未配置消耗清单'
          : d.consumeChips.map(function (c) { return c.name + ' ' + c.perText; }).join('；');
      });
      that._dishesFull = dishes;
      that.setData({ dishes: dishes, dishTotal: dishTotal });
      // 菜品列表刷新后必须重新套一次搜索词（否则 kwDish 还在、列表却变全量）
      that.applySearch();
    });
  },

  switchTab: function (e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  /* ---------------- 食材档案：新建（录入区）+ 显示 + 下架/上架 ---------------- */
  onMName: function (e) { this.setData({ mName: e.detail.value }); },
  onMSpec: function (e) { this.setData({ mSpec: e.detail.value }); },
  onMUnit: function (e) { this.setData({ mUnit: e.detail.value }); },
  onMTh: function (e) { this.setData({ mTh: e.detail.value }); },
  onMQty: function (e) { this.setData({ mQty: e.detail.value }); },

  /** 点「编辑」把这条档案回填到上方表单（含总仓数量，可就地覆盖调整） */
  editMaterial: function (e) {
    var id = e.currentTarget.dataset.id;
    var m = this.data.materials.filter(function (x) { return x._id === id; })[0];
    if (!m) { return; }
    var th = (m.lowStockThreshold === null || m.lowStockThreshold === undefined) ? '' : String(m.lowStockThreshold);
    var qty = (m.stock === null || m.stock === undefined) ? '' : String(m.stock);
    this.setData({
      editingId: m._id,
      mName: m.name || '', mSpec: m.spec || '', mUnit: m.unit || '', mTh: th,
      mQty: qty, mQtyOrigin: qty
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /** 放弃编辑，回到新建态 */
  cancelEdit: function () {
    this.setData({ editingId: '', mName: '', mSpec: '', mUnit: '', mTh: '', mQty: '', mQtyOrigin: '' });
  },

  /** 新建 / 编辑食材档案（名称/规格/单位/预警值 + 数量）
   *  · 新建：填了初始数量 → 顺手记一笔采购入库流水
   *  · 编辑：档案先存；若改了总仓数量 → 调 inventory.adjust 覆盖调整（同值/留空不动） */
  saveMaterial: function () {
    // 防连点锁：保存链进行中直接忽略（连点两下 = 两条 material.save + 可能两笔
    // inventory.adjust / purchase，等于重复录库存——老板报「数据错乱」的根因）
    if (this.data.matSaving) { return; }
    var that = this;
    var name = String(that.data.mName || '').trim();
    var unit = String(that.data.mUnit || '').trim();
    var spec = String(that.data.mSpec || '').trim();
    var th = that.data.mTh === '' ? null : that.data.mTh;
    var qtyRaw = String(that.data.mQty === undefined || that.data.mQty === null ? '' : that.data.mQty).trim();
    var origin = String(that.data.mQtyOrigin === undefined || that.data.mQtyOrigin === null ? '' : that.data.mQtyOrigin).trim();
    var editingId = String(that.data.editingId || '');
    if (!name) { wx.showToast({ title: '请填食材名称', icon: 'none' }); return; }
    if (!unit) { wx.showToast({ title: '请填单位（如 包/盒/斤）', icon: 'none' }); return; }

    // 编辑态且数量有改动 → 先校验（覆盖式调整总仓）；同值 / 留空 → 不动库存
    var wantAdjust = false;
    var targetQty = null;
    if (editingId && qtyRaw !== '' && qtyRaw !== origin) {
      targetQty = Number(qtyRaw);
      if (!isFinite(targetQty)) { wx.showToast({ title: '数量必须是数字', icon: 'none' }); return; }
      if (targetQty < 0) { wx.showToast({ title: '数量不能为负数', icon: 'none' }); return; }
      wantAdjust = true;
    }

    var payload = { action: 'save', name: name, spec: spec, unit: unit, lowStockThreshold: th };
    if (editingId) { payload._id = editingId; }
    // 设锁放在**所有校验之后**：校验不过的提前 return 都在锁外（失败后老板改两个字再点，
    // 绝不能被旧锁挡住）；此处起网络链才真正开始，锁覆盖 callWithToast + adjust/purchase 子链
    that.setData({ matSaving: true });
    cloud.callWithToast('material', payload, editingId ? '档案已更新' : '档案已建立').then(function (res) {
      if (res.code !== 0) { return null; }
      that.setData({ mName: '', mSpec: '', mUnit: '', mTh: '', mQty: '', mQtyOrigin: '', editingId: '' });

      // 编辑已有档案：资料已存；若改了总仓数量 → 覆盖调整
      if (editingId) {
        if (!wantAdjust) { return that.loadAll(); }
        return cloud.call('inventory', { action: 'adjust', itemId: editingId, target: targetQty })
          .then(function (ares) {
            if (ares.code === 0) {
              wx.showToast({ title: '总仓已调整为 ' + targetQty + unit, icon: 'success' });
            } else {
              // 档案已存、库存没调成：如实告知 + 仍刷新列表
              wx.showModal({ title: '总仓调整失败', content: ares.message || '调整失败', showCancel: false });
            }
            return that.loadAll();
          });
      }

      var newId = res.data && res.data._id;
      var initQty = Number(qtyRaw);
      // 新建 + 有初始数量 → 按 itemId 走采购入库，留流水（对账可追溯）
      if (newId && initQty > 0) {
        return cloud.call('purchase', {
          itemId: newId, qty: initQty, remark: '建档初始库存'
        }).then(function (p) {
          if (p.code === 0) { wx.showToast({ title: '已入初始库存 ' + initQty + unit, icon: 'success' }); }
          return that.loadAll();
        });
      }
      return that.loadAll();
    }).then(function () {
      // 链尾统一复位：material.save →（可能的 inventory.adjust / purchase 子链）→ loadAll 的
      // material+dish 主链全 resolve 后才执行。loadAll 里 inventory 合并分支是悬浮分支（未 return），
      // 但它只做本地展示合并、无任何写操作——锁覆盖到主链尾已封死「重复写」的窗口
      that.setData({ matSaving: false });
    }).catch(function () {
      // 传输层异常兜底复位：cloud.call 自带终端 catch 永不 reject，这里兜的是
      // then 回调里同步抛错（如 loadAll 内部异常）——不接住的话锁永远 true，按钮再点不动
      that.setData({ matSaving: false });
    });
  },

  /** 删除食材（带引用检查）：确认 → material.remove；被引用 → 弹窗显示后端人话，不静默 */
  removeMaterial: function (e) {
    // 防连点锁：确认弹窗弹出期间锁住（连点另一行的「删除」不会并发弹两个框）
    if (this.data.matRemoving) { return; }
    var that = this;
    var m = that.data.materials.filter(function (x) { return x._id === e.currentTarget.dataset.id; })[0];
    if (!m) { return; }
    var stock = Number(m.stock) || 0;
    var stockTip = stock !== 0
      ? ('\n注意：该食材总仓还有 ' + stock + ' ' + (m.unit || '') + '，删除后库存余额一并清除。')
      : '';
    var name = m.name || '该食材';   // 名称脏数据兜底：确认框里不能是空白、更不能是内部 id
    that.setData({ matRemoving: true });
    wx.showModal({
      title: '删除食材',
      content: '确定删除「' + name + '」？' + stockTip,
      success: function (r) {
        if (!r.confirm) { that.setData({ matRemoving: false }); return; }
        // 用 cloud.call（不是 callWithToast）：失败要拿到完整 message 自己弹
        cloud.call('material', { action: 'remove', _id: m._id }).then(function (res) {
          that.setData({ matRemoving: false });
          if (res.code === 0) {
            wx.showToast({ title: '已删除', icon: 'success' });
            that.loadAll();
          } else {
            wx.showModal({ title: '无法删除', content: res.message || '删除失败', showCancel: false });
          }
        }).catch(function () { that.setData({ matRemoving: false }); });
      },
      fail: function () { that.setData({ matRemoving: false }); }
    });
  },

  /* ---------------- 食材下架 / 上架（老板 2026-10 拍板） ---------------- */

  /**
   * 按开关重算展示列表：默认只显示在售的（isActive !== false），
   * 开关打开后已下架的也列出来（页面灰显 + 「已下架」灰色标签）。
   * `materials` 始终保持全量（菜品配方要用它反查食材名），只过滤渲染用的 viewMaterials。
   */
  _applyFilter: function () {
    var mats = this.data.materials || [];
    var show = !!this.data.showInactive;
    // ⚠️ 顺序：先按「显示已下架」开关过滤得到底稿，**再**由 applySearch 按搜索词过滤。
    //    开关优先 —— 开关关着时，被搜到已下架食材也**不显示**（别让老板搜到看不见的货）。
    this._viewMaterialsFull = show ? mats.slice() : mats.filter(function (m) { return m.isActive !== false; });
    this.setData({
      inactiveCount: mats.filter(function (m) { return m.isActive === false; }).length
    });
    this.applySearch();     // 一次 setData 出最终渲染列表（开关 + 搜索的结果合并输出）
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */

  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 两个都重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值
   *   · loadAll / 开关变化后调用 `applySearch()` → 两个搜索词都保留，只是用新数据重算一遍
   */
  applySearch: function (kwField, kw) {
    var kMat = this.data.kwMat;
    var kDish = this.data.kwDish;
    if (kwField === 'kwMat') { kMat = (kw === undefined) ? '' : kw; }
    if (kwField === 'kwDish') { kDish = (kw === undefined) ? '' : kw; }
    var viewMaterials = search.filter(this._viewMaterialsFull, kMat, ['name', 'spec']);
    var dishes = search.filter(this._dishesFull, kDish, ['name']);
    this.setData({
      kwMat: kMat,
      kwDish: kDish,
      viewMaterials: viewMaterials,
      dishes: dishes,
      matCountText: countText(viewMaterials.length, kMat, this.data.matTotal),
      dishCountText: countText(dishes.length, kDish, this.data.dishTotal)
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

  /** 顶部开关：「显示已下架（N）」 */
  toggleShowInactive: function () {
    this.setData({ showInactive: !this.data.showInactive });
    this._applyFilter();
  },

  /**
   * 行内「下架 / 上架」按钮
   * @param {object} e data-id / data-active（'1' = 这一行当前是已下架 → 点的是「上架」）
   */
  toggleActive: function (e) {
    // 防连点锁：上/下架请求进行中直接忽略（上架无确认弹窗，锁是唯一防线）
    if (this.data.matToggling) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    var toActive = String(e.currentTarget.dataset.active) === '1';
    var m = this.data.materials.filter(function (x) { return x._id === id; })[0];
    if (!m) { return; }
    var name = m.name || '该食材';
    function doToggle() {
      that.setData({ matToggling: true });
      cloud.callWithToast('material', { action: 'toggle', _id: id, isActive: toActive },
        toActive ? '已上架' : '已下架')
        .then(function (res) {
          that.setData({ matToggling: false });
          if (res.code !== 0) { return null; }
          // 下架成功后自动展开「显示已下架」：这一行必须立刻以灰显 + 「已下架」标签出现在老板眼前。
          // 否则「下架」和「删除」在界面上长得一模一样（都是这行没了），老板会以为东西被删掉了 ——
          // 而他要的恰恰是「删不掉，所以才下架，东西还在」。上架不动开关（可能要连着上架好几条）。
          if (!toActive) { that.setData({ showInactive: true }); that._applyFilter(); }
          that.loadAll();
          return null;
        })
        .catch(function () { that.setData({ matToggling: false }); });
    }
    // 上架：无副作用，直接生效；下架：先把后果讲清楚（老板口径，大白话）
    if (toActive) { doToggle(); return; }
    // 下架有确认弹窗：弹窗期间也要锁（连点另一行「下架」不并发弹框）
    that.setData({ matToggling: true });
    wx.showModal({
      title: '下架食材',
      content: '下架「' + name + '」后：采购、门店申请、菜品配置里都选不到它；' +
        '店里和总仓剩下的货照常用完，库存归零后自动隐藏。确定下架？',
      success: function (r) {
        if (r.confirm) { doToggle(); return; }
        that.setData({ matToggling: false });   // 取消：放锁
      },
      fail: function () { that.setData({ matToggling: false }); }
    });
  },

  /* ---------------- 菜品 ---------------- */
  onDName: function (e) { this.setData({ dName: e.detail.value }); },

  onCiMaterial: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var pickedId = String(e.detail.value || '');
    var opts = this.data.materialOptions;
    var idx = -1;
    for (var k = 0; k < opts.length; k++) { if (opts[k]._id === pickedId) { idx = k; break; } }
    var key = 'ciRows[' + i + '].materialIndex';
    var patch = {};
    patch[key] = idx;
    this.setData(patch);
  },
  onCiQty: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var patch = {};
    patch['ciRows[' + i + '].qty'] = e.detail.value;
    this.setData(patch);
  },
  onCiPortions: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var patch = {};
    patch['ciRows[' + i + '].portions'] = e.detail.value;
    this.setData(patch);
  },
  addCiRow: function () {
    var rows = this.data.ciRows.concat([{ materialIndex: 0, qty: '', portions: '' }]);
    this.setData({ ciRows: rows });
  },
  removeCiRow: function (e) {
    var i = Number(e.currentTarget.dataset.i);
    var rows = this.data.ciRows.slice();
    rows.splice(i, 1);
    this.setData({ ciRows: rows.length ? rows : [{ materialIndex: 0, qty: '', portions: '' }] });
  },

  saveDish: function () {
    // 防连点锁：同 saveMaterial（连点两下 = 两条 dish.save，配方重复落库）
    if (this.data.dishSaving) { return; }
    var that = this;
    var opts = that.data.materialOptions;
    var items = that.data.ciRows.map(function (r) {
      var opt = opts[r.materialIndex];
      return {
        itemId: opt ? opt._id : '',
        qty: r.qty,
        portions: r.portions === '' ? null : r.portions
      };
    }).filter(function (r) { return r.itemId; });
    var editingDishId = String(that.data.editingDishId || '');
    var payload = { action: 'save', name: that.data.dName, consumeItems: items };
    if (editingDishId) { payload._id = editingDishId; }
    // 设锁在构建 payload 之后、发请求之前（saveDish 校验不过会直接被云函数打回，
    // toast 由 callWithToast 显示，此前的本地构建不涉及网络）
    that.setData({ dishSaving: true });
    cloud.callWithToast('dish', payload, editingDishId ? '菜品已更新' : '菜品已保存').then(function (res) {
      if (res.code === 0) {
        that.setData({
          dName: '', ciRows: [{ materialIndex: 0, qty: '', portions: '' }], editingDishId: ''
        });
        that.loadAll();
      }
    }).then(function () {
      // 链尾统一复位（dish.save → loadAll → 其内部 dish list 子链全 resolve 后）
      that.setData({ dishSaving: false });
    }).catch(function () {
      // 传输层异常兜底复位（同 saveMaterial 的理由）
      that.setData({ dishSaving: false });
    });
  },

  /** 点菜品列表的「编辑」→ 把这道菜的消耗清单填进上方表单（菜名+每行 食材/用量/份数） */
  editDish: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    var d = that.data.dishes.filter(function (x) { return x._id === id; })[0];
    if (!d) { return; }
    // 切到菜品 tab，方便老板直接看到上方表单
    that.setData({ tab: 'dish' });
    // 这道菜若引用了已下架（甚至已删除）的食材，在售下拉里本来没有它 → 先补进选项末尾，
    // 保证这一行能显示名字、保存时配方不丢（老板口径：不能空白、不能显示内部 id、不能丢行）
    var opts = that._extendOptions(d.consumeItems || []);
    var rows = (d.consumeItems || []).map(function (it) {
      // 找该 itemId 在选项里的下标（找不到就保留 -1，让老板重选）
      var idx = -1;
      for (var k = 0; k < opts.length; k++) { if (opts[k]._id === it.itemId) { idx = k; break; } }
      return {
        materialIndex: idx,
        qty: it.qty === null || it.qty === undefined ? '' : String(it.qty),
        portions: it.portions === null || it.portions === undefined ? '' : String(it.portions)
      };
    });
    if (rows.length === 0) { rows = [{ materialIndex: 0, qty: '', portions: '' }]; }
    that.setData({ dName: d.name || '', ciRows: rows, editingDishId: d._id });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /**
   * 把「被这道菜引用、但不在在售下拉里」的食材追加到选项**末尾**
   * （只追加、不重排，所以在售项的下标不变；保存时按同一份选项取 itemId，配方不会丢）
   * @param {Array} consumeItems 菜品配方行 [{itemId, qty, portions}]
   * @returns {Array} 供下拉与保存共用的选项数组
   */
  _extendOptions: function (consumeItems) {
    var base = this.data.materialOptions || [];
    var have = {};
    base.forEach(function (o) { have[o._id] = true; });
    var matMap = {};
    (this.data.materials || []).forEach(function (m) { matMap[m._id] = m; });
    var extra = [];
    (consumeItems || []).forEach(function (it) {
      if (!it.itemId || have[it.itemId]) { return; }
      have[it.itemId] = true;
      var m = matMap[it.itemId];
      // 档案还在（只是下架）→ 真名 + 「已下架」；档案里查不到 → 统一兜底「已下架食材」，绝不露 _id
      var label = m ? (m.name + '（' + (m.unit || '') + '） · 已下架') : '已下架食材';
      extra.push({ index: base.length + extra.length, _id: it.itemId, name: label, label: label });
    });
    if (extra.length === 0) { return base; }
    var opts = base.concat(extra);
    this.setData({ materialOptions: opts });
    return opts;
  },

  /** 放弃菜品编辑 */
  cancelEditDish: function () {
    this.setData({
      dName: '', ciRows: [{ materialIndex: 0, qty: '', portions: '' }], editingDishId: '',
      // 还原成纯「在售」下拉，别把编辑时补进去的已下架食材留在新建态里
      materialOptions: this._baseOptions || this.data.materialOptions
    });
  },

  /** 删除菜品（带引用检查）：确认 → dish.remove；被出品记录引用 → 弹窗显示后端人话，不静默 */
  removeDish: function (e) {
    // 防连点锁：确认弹窗弹出期间锁住（连点另一行的「删除」不会并发弹两个框）
    if (this.data.dishRemoving) { return; }
    var that = this;
    var d = that.data.dishes.filter(function (x) { return x._id === e.currentTarget.dataset.id; })[0];
    if (!d) { return; }
    that.setData({ dishRemoving: true });
    wx.showModal({
      title: '删除菜品',
      content: '确定删除「' + d.name + '」？删除后该菜品的配方一并清除。',
      success: function (r) {
        if (!r.confirm) { that.setData({ dishRemoving: false }); return; }
        cloud.call('dish', { action: 'remove', _id: d._id }).then(function (res) {
          that.setData({ dishRemoving: false });
          if (res.code === 0) {
            wx.showToast({ title: '已删除', icon: 'success' });
            that.loadAll();
          } else {
            wx.showModal({ title: '无法删除', content: res.message || '删除失败', showCancel: false });
          }
        }).catch(function () { that.setData({ dishRemoving: false }); });
      },
      fail: function () { that.setData({ dishRemoving: false }); }
    });
  }
});
