// ==========================================================================
// pages/manager/requisition-process — ③ 申请处理（修改 / 确认）
// 老板 2026-10-09 拍板：把「驳回」按钮改成「修改」——管理端直接把申请数量改成合理值，
// 每条可改数量、每条可删除，**全部改完后**再点「确认 / 保存并确认」才结清库存。
// · 修改 adjust：{ requisitionId, items }，items = 改完后的**完整明细**，没传的行 = 删除；
//   单据保持 pending，不结清库存；云函数回中文差异说明 adjustNote（门店端可见）。
// · 确认 confirm：按**最新 items** 结清（总仓 −申请量 / 门店 +申请量，同一事务，§4.2 D9）。
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');
var search = require('../../../utils/list-search');

/**
 * 提交用的数量：统一 3 位小数，与云函数 quantizeStock（Math.round(n*1000)/1000）同口径。
 * ⚠️ 不能用 2 位截断：弹窗按 fmt3（3 位）显示、却按 2 位提交时，
 *    老板「一个字没改直接保存」也会产生假差异（0.334 显示 0.334、提交 0.33）。
 */
function qty3(n) {
  var v = Number(n);
  if (!isFinite(v)) { return 0; }
  return Math.round(v * 1000) / 1000;
}

Page({
  data: {
    pending: [],
    done: [],

    // ===== 修改数量弹窗（老板 2026-10-09）=====
    adjustOpen: false,      // 弹窗开关
    adjustTitle: '',        // 弹窗标题：`<门店名> 要货单 · 修改数量`
    adjustItems: [],        // 行数据：[{itemId, name, spec, unit, qty, qtyText}]
    adjustSaving: false,    // 保存 / 保存并确认 进行中（遮罩 loading + 防重复点）
    // 检索（老板 2026-10：每个列表都能快速定位；本地过滤，不调云函数）
    //   两个列表各一个搜索词，匹配 **单号 + 门店名**
    kwPending: '',
    kwDone: '',
    // 防连点锁（老板 2026-10-13 总规矩：所有可能重复提交的入口都要拦，网络慢时连点=重复单）
    //   confirm 走 modal → callWithToast(带 loading 遮罩)，loading 期间物理上点不了；
    //   但 modal **弹出期间**按钮还活着——连点另一行会并发弹两个 modal/发两笔。
    //   入口锁把 modal 窗口也盖住。
    _confirming: false,   // 确认弹窗已弹（modal 弹出 → 请求落地之间）
    rejecting: false,     // 驳回弹窗已弹（同上；reject 无 loading 遮罩，锁是唯一防线）
    removing: false       // 删除弹窗已弹（同上；只删终态单：已驳回/已撤回）
  },

  // 非渲染缓存（过滤底稿：过滤只改渲染用的 pending/done，底稿永远是全量）
  _pendingFull: [],   // 待处理全量
  _doneFull: [],      // 已处理全量

  onShow: function () { this.loadAll(); },

  onPullDownRefresh: function () {
    this.loadAll();
    wx.stopPullDownRefresh();
  },

  loadAll: function () {
    var that = this;
    Promise.all([
      cloud.call('material', { action: 'list' }),
      cloud.call('requisition', { action: 'list' }),
      cloud.call('store', { action: 'list' })
    ]).then(function (rs) {
      var matMap = {};
      (rs[0].code === 0 ? rs[0].data.rows : []).forEach(function (m) { matMap[m._id] = m; });
      that._matMap = matMap;   // 供 copyReq / openAdjust 组装带名称/单位的明细
      var storeMap = {};
      (rs[2].code === 0 ? rs[2].data.rows : []).forEach(function (s) { storeMap[s._id] = s.name; });
      var all = rs[1].code === 0 ? rs[1].data.list : [];
      all.forEach(function (r) {
        r.itemsText = (r.items || []).map(function (it) {
          var m = matMap[it.itemId];
          return (m ? m.name : it.itemId) + ' ' + fmt.formatQty(it.qty, m ? m.unit : '');
        }).join('；');
        r.timeText = fmt.fmtShort(r.createdAt);
        r.storeName = storeMap[r.storeId] || r.storeId || '未知门店';   // 老板：要能看出是哪个店申请的
        r.statusLabel = { pending: '待处理', confirmed: '已确认', rejected: '已驳回', cancelled: '已撤回' }[r.status] || r.status;
        // 修改弹窗用：食材名/规格/单位预先挂到明细行上，弹窗打开即出中文名；
        // 食材已下架（查不到档案）时兜底「已下架食材」，绝不把内部 _id 露给老板看。
        (r.items || []).forEach(function (it) {
          var m = matMap[it.itemId];
          var known = !!m;
          it._name = known ? m.name : '已下架食材';
          it._spec = known ? (m.spec || '') : '';
          it._unit = known ? (m.unit || '') : '';
        });
      });
      that._pendingFull = all.filter(function (r) { return r.status === 'pending'; });
      that._doneFull = all.filter(function (r) { return r.status !== 'pending'; });
      that.setData({ pending: that._pendingFull, done: that._doneFull });
      // 拉完重新套一次搜索词（onShow / 保存刷新后都不丢过滤）
      that.applySearch();
    });
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */
  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 两个都重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值（loadAll 刷新后重算走这条）
   */
  applySearch: function (kwField, kw) {
    var kp = this.data.kwPending;
    var kd = this.data.kwDone;
    if (kwField === 'kwPending') { kp = (kw === undefined) ? '' : kw; }
    if (kwField === 'kwDone') { kd = (kw === undefined) ? '' : kw; }
    this.setData({
      kwPending: kp,
      kwDone: kd,
      pending: search.filter(this._pendingFull, kp, ['_id', 'storeName']),
      done: search.filter(this._doneFull, kd, ['_id', 'storeName'])
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

  /** 按 _id 取当前列表里的单据（pending 区优先，其次已处理区） */
  rowOf: function (id) {
    var all = this.data.pending.concat(this.data.done);
    return all.filter(function (r) { return r._id === id; })[0] || null;
  },

  confirmReq: function (e) {
    // 防连点锁（老板总规矩）：锁在 showModal **之前**设——modal 弹出期间菜单条按钮
    //   全活着，连点另一行会并发弹两个确认框 → 两笔 confirm 落库。取消/失败立即放锁。
    if (this.data._confirming) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    var row = this.rowOf(id);
    var n = (row && row.items) ? row.items.length : 0;
    // 大单（微信事务内每条明细 2 次写）实测要十几秒：点之前先把话说清楚，
    // 否则界面十几秒没反应，老板会以为卡死了（2026-10-08 老板反馈）。
    var tip = n > 20
      ? '\n\n本单共 ' + n + ' 条明细，校验与库存结清需要十几秒，请耐心等待不要重复点击。'
      : (n > 0 ? '\n\n本单共 ' + n + ' 条明细。' : '');
    that.setData({ _confirming: true });
    wx.showModal({
      title: '确认申请',
      content: '确认后：总仓 −申请量、门店 +申请量（同一事务，库存不足整体拒绝）。' + tip,
      success: function (r) {
        if (!r.confirm) { that.setData({ _confirming: false }); return; }
        // loading 文案必须 ≤7 字符（wx.showLoading 超出会截断），故只给条数
        cloud.callWithToast('requisition', { action: 'confirm', requisitionId: id }, '已确认，已结清',
          { loading: n > 20 ? ('处理 ' + n + ' 条') : '确认中' })
          .then(function (res) {
            that.setData({ _confirming: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ _confirming: false }); });
      },
      fail: function () { that.setData({ _confirming: false }); }
    });
  },

  /* ---------------- 驳回（老板 2026-10-13：恢复驳回能力，pending→rejected，库存不动） ----------------
   * 云函数 requisition.reject：{ requisitionId, rejectReason }，原因必填（trim 后非空），
   * 门店端已处理列表能看到 rejectReason。弹窗用 showModal 的 editable 输入框收原因。 */
  rejectReq: function (e) {
    // 防连点锁（老板总规矩）：modal 弹出期间锁住，连点另一行不并发弹窗/发请求
    if (this.data.rejecting) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    var row = this.rowOf(id);
    var storeName = row ? (row.storeName || '该门店') : '该门店';
    that.setData({ rejecting: true });
    wx.showModal({
      title: '驳回申请',
      content: '驳回「' + storeName + '」的这张申请单？驳回后门店端可见驳回原因，单据不可再处理，库存不变。',
      editable: true,
      placeholderText: '填写驳回原因（必填）',
      success: function (r) {
        if (!r.confirm) { that.setData({ rejecting: false }); return; }
        var reason = String(r.content || '').trim();
        if (!reason) {
          // 原因空 = 不发请求；锁立即放掉让老板能重新点（填完原因再确认）
          wx.showToast({ title: '请填驳回原因', icon: 'none' });
          that.setData({ rejecting: false });
          return;
        }
        cloud.callWithToast('requisition',
          { action: 'reject', requisitionId: id, rejectReason: reason }, '已驳回')
          .then(function (res) {
            that.setData({ rejecting: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ rejecting: false }); });
      },
      fail: function () { that.setData({ rejecting: false }); }
    });
  },

  /* ---------------- 删除（老板 2026-10-13：只删终态单，已驳回/已撤回） ----------------
   * 云函数 requisition.remove：只删 rejected / cancelled 终态单；pending（先驳回或确认）、
   * confirmed（有库存流水）会被云函数拒绝并回人话（callWithToast 自动 toast）。
   * 前端只把按钮放在终态卡上（待处理 tab 不放，别给老板一个点了必报错的按钮）。
   * 删除不产生任何库存变动——文案里必须讲清楚，避免老板以为删除会退库存。 */
  removeReq: function (e) {
    // 防连点锁（老板总规矩）：modal 弹出期间锁住，连点另一行不并发弹窗/发请求
    if (this.data.removing) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    that.setData({ removing: true });
    wx.showModal({
      title: '删除申请单',
      content: '删除后不可恢复，且不产生任何库存变动。确定删除？',
      success: function (r) {
        if (!r.confirm) { that.setData({ removing: false }); return; }
        cloud.callWithToast('requisition', { action: 'remove', requisitionId: id }, '已删除')
          .then(function (res) {
            that.setData({ removing: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ removing: false }); });
      },
      fail: function () { that.setData({ removing: false }); }
    });
  },

  // ========================================================================
  // 修改数量（老板 2026-10-09：有很多食材，全部改完后才能确认）
  // ========================================================================

  /** 打开修改弹窗：按当前明细逐行铺开，数量预填申请量 */
  openAdjust: function (e) {
    var id = e.currentTarget.dataset.id;
    var row = this.rowOf(id);
    if (!row) { wx.showToast({ title: '请刷新后重试', icon: 'none' }); return; }
    var matMap = this._matMap || {};
    var items = (row.items || []).map(function (it) {
      var m = matMap[it.itemId];
      var known = !!m;
      var qty = Number(it.qty);
      if (isNaN(qty)) { qty = 0; }
      return {
        itemId: it.itemId,
        // 名称兜底：档案查不到 / 名称为空（历史脏数据）一律显示「已下架食材」，
        // 任何情况下都不把 itemId 原样渲染出来（itemId 只做 wx:key 和提交 payload）
        name: it._name || (known && m.name ? m.name : '已下架食材'),
        spec: it._spec || (known ? (m.spec || '') : ''),
        unit: it._unit || (known ? (m.unit || '') : ''),
        qty: qty,
        // 预填去掉多余小数点（3 → '3'，不是 '3.00'），改动一个字就能提交
        qtyText: fmt.fmt3(qty)
      };
    });
    this._adjustId = id;
    this.setData({
      adjustOpen: true,
      adjustTitle: (row.storeName || '该门店') + ' 要货单 · 修改数量',
      adjustItems: items,
      adjustSaving: false
    });
  },

  /** 数量输入：按 data-idx 定位到行（只更新该行，避免整表重绘导致光标跳动） */
  onAdjustInput: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    var raw = e.detail && e.detail.value !== undefined && e.detail.value !== null ? e.detail.value : '';
    var v = String(raw);
    var n = v.trim() === '' ? NaN : Number(v);
    var patch = {};
    patch['adjustItems[' + idx + '].qtyText'] = v;
    patch['adjustItems[' + idx + '].qty'] = isNaN(n) ? 0 : n;
    this.setData(patch);
  },

  /** 删除单行（没传的行 = 云函数那边视为不要了） */
  onAdjustDel: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    var items = this.data.adjustItems.slice();
    if (isNaN(idx) || idx < 0 || idx >= items.length) { return; }
    items.splice(idx, 1);
    this.setData({ adjustItems: items });
  },

  /** 关闭弹窗（保存中不许关，免得以为没保存成功） */
  closeAdjust: function () {
    if (this.data.adjustSaving) { return; }
    this.setData({ adjustOpen: false });
  },

  /** 弹层内部点击：吃掉冒泡，避免误关 */
  noop: function () { },

  /**
   * 底部按钮：保存 / 保存并确认
   * @param {object} e data-confirm='1' → 保存后接着确认（结清库存）
   */
  saveAdjust: function (e) {
    var needConfirm = String(e.currentTarget.dataset.confirm) === '1';
    this._doSave(needConfirm);
  },

  /** 前端先把一遍关（云函数还会再校验一次）：非数字 / 负数 / 一条不剩 */
  _validateAdjust: function () {
    var rows = this.data.adjustItems || [];
    var items = [];
    var i;
    for (i = 0; i < rows.length; i++) {
      var t = String(rows[i].qtyText === undefined || rows[i].qtyText === null ? '' : rows[i].qtyText).trim();
      var n = Number(t);
      if (t === '' || isNaN(n) || !isFinite(n) || n < 0) {
        return { ok: false, msg: '数量填0或正数' };   // ≤7 字（showToast 超出会被截断）
      }
      if (n <= 0) { continue; }   // 填 0 等同删除这一行
      items.push({ itemId: rows[i].itemId, qty: qty3(n) });
    }
    if (items.length === 0) { return { ok: false, msg: '至少留一种食材' }; }
    return { ok: true, items: items };
  },

  /** 失败提示：云函数给的业务文案可能偏长，用弹窗讲清楚，不塞进会被截断的 toast */
  _failAlert: function (title, msg) {
    wx.showModal({
      title: title,
      content: msg || '操作失败，请稍后再试',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  /**
   * 提交修改（可选顺带确认）
   * @param {boolean} needConfirm true = 保存并确认（先 adjust 再 confirm，共用一条 loading）
   */
  _doSave: function (needConfirm) {
    var that = this;
    if (this.data.adjustSaving) { return; }
    var v = this._validateAdjust();
    if (!v.ok) { wx.showToast({ title: v.msg, icon: 'none' }); return; }
    var id = this._adjustId;
    if (!id) { this.setData({ adjustOpen: false }); return; }

    var n = v.items.length;
    this.setData({ adjustSaving: true });
    // 「保存并确认」是两次云函数调用，共用一条 loading，中间不闪一下
    var loadingText = needConfirm ? (n > 20 ? ('处理 ' + n + ' 条') : '提交中') : '保存中';
    wx.showLoading({ title: loadingText, mask: true });

    cloud.call('requisition', { action: 'adjust', requisitionId: id, items: v.items })
      .then(function (res) {
        if (res.code !== 0) {
          wx.hideLoading();
          // res.message 已是云函数的人话（如「数量不能为负」），内部码不抛给用户
          that._failAlert('没能保存', res.message || '保存失败，请稍后再试');
          that.setData({ adjustSaving: false });
          return null;
        }
        if (!needConfirm) {
          wx.hideLoading();
          wx.showToast({ title: '已修改', icon: 'success' });
          that.setData({ adjustOpen: false, adjustSaving: false });
          that.loadAll();       // 拉回最新 items + adjustNote，卡片上就能看到改了啥
          return null;
        }
        return cloud.call('requisition', { action: 'confirm', requisitionId: id }).then(function (r2) {
          wx.hideLoading();
          if (r2.code === 0) {
            wx.showToast({ title: '已确认，已结清', icon: 'success' });
          } else {
            // 数量已经存下了，只是结清没过（多为总仓库存不足）：说清现状和下一步，别只弹个失败
            that._failAlert('已保存，未结清',
              (r2.message || '总仓库存不足') + '\n数量修改已保存，单据仍是「待处理」；等总仓补货后再点「确认」。');
          }
          that.setData({ adjustOpen: false, adjustSaving: false });
          that.loadAll();
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: '操作失败，重试', icon: 'none' });
        that.setData({ adjustSaving: false });
        console.error('[requisition-process] 修改/确认异常：', err);
      });
  },

  /** 一键复制申请单文本（老板 2026-09-12：方便管理员粘贴到微信群） */
  copyReq: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    var row = this.data.pending.concat(this.data.done).filter(function (r) { return r._id === id; })[0];
    if (!row) { return; }
    var matMap = this._matMap || {};
    var lines = (row.items || []).map(function (it, i) {
      var m = matMap[it.itemId];
      return (i + 1) + '、' + (m ? m.name : it.itemId) + ' ' + fmt.formatQty(it.qty, m ? m.unit : '');
    }).join('\n');
    var text = '【王婆婆家常菜 · 食材申请单】\n' +
      '门店：' + (row.storeName || '未知门店') + '\n' +
      '状态：' + row.statusLabel + '\n' +
      '单号：' + row._id + '\n' +
      '时间：' + row.timeText + '\n' +
      '—— 申请明细 ——\n' + lines;
    wx.setClipboardData({
      data: text,
      success: function () { wx.showToast({ title: '已复制，可粘贴', icon: 'none' }); }
    });
  }
});
