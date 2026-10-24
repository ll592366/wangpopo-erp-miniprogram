// ==========================================================================
// pages/manager/purchase — ② 采购入库（**只选不填**：食材下拉 → 规格/单位自动带出）
// 老板口径：档案才是录入的地方（名称/规格/单位/预警值在「商品管理 → 食材档案」新建）；
// 采购这里一律**下拉选择**，唯一要动手填的就是**数量**（备注可选）。
// ==========================================================================
var cloud = require('../../../utils/cloud');
var fmt = require('../../../utils/format');

Page({
  data: {
    options: [],        // 下拉项（只含启用中的档案）
    materialIndex: -1,  // 当前选中的下拉下标
    picked: null,       // 选中档案快照：{_id,name,spec,unit,lowStockThreshold,stock}
    qty: '',
    remark: '',
    submitting: false
  },

  onShow: function () { this.loadOptions(); },

  /** 拉启用中的食材档案做下拉源；并**自动选中**（首条 / 上次选中项），保证规格·单位进页即带出 */
  loadOptions: function () {
    var that = this;
    cloud.call('material', { action: 'list' }).then(function (res) {
      if (res.code !== 0) {
        // 拉不到就明说，不要静默留个空下拉让老板以为"没自动关联"
        wx.showToast({ title: res.message || '加载食材失败，请重试', icon: 'none', duration: 2600 });
        return;
      }
      var rows = res.data && res.data.rows ? res.data.rows : [];
      var options = rows.filter(function (m) { return m.isActive !== false; })
        .map(function (m, i) {
          return {
            index: i,
            _id: m._id,
            name: m.name,
            unit: m.unit,
            spec: m.spec || '',
            lowStockThreshold: m.lowStockThreshold,
            // 下拉里就把规格·单位显示出来，避免重名混淆
            label: m.name + (m.spec ? '（' + m.spec + '·' + m.unit + '）' : '（' + m.unit + '）')
          };
        });
      // 自动关联：优先沿用上次选中的档案；没有则默认选第 1 条（进页就有规格/单位，不用先点一次）
      var keepId = that.data.picked && that.data.picked._id;
      var hit = -1;
      options.forEach(function (o, i) { if (o._id === keepId) { hit = i; } });
      var idx = hit >= 0 ? hit : (options.length ? 0 : -1);
      that.setData({
        options: options,
        materialIndex: idx,
        picked: idx >= 0 ? options[idx] : null
      });
    });
  },

  /** 下拉选择食材 → 规格/单位自动带出（只读展示） */
  onPick: function (e) {
    var pickedId = String(e.detail.value || '');
    var opts = this.data.options;
    var idx = -1;
    for (var k = 0; k < opts.length; k++) { if (opts[k]._id === pickedId) { idx = k; break; } }
    if (idx < 0) { return; }
    this.setData({ materialIndex: idx, picked: opts[idx] });
  },

  onQty: function (e) { this.setData({ qty: e.detail.value }); },
  onRemark: function (e) { this.setData({ remark: e.detail.value }); },

  /** 去「商品管理」建新档案（采购页不再现场建档） */
  goArchive: function () {
    wx.navigateTo({ url: '/pages/manager/goods/goods' });
  },

  submit: function () {
    var that = this;
    var d = that.data;
    if (that.data.submitting) { return; }
    if (!d.picked) {
      wx.showToast({ title: '请先选择食材', icon: 'none' }); return;
    }
    if (!(Number(d.qty) > 0)) {
      wx.showToast({ title: '采购数量必须大于 0', icon: 'none' }); return;
    }
    that.setData({ submitting: true });
    cloud.call('purchase', {
      itemId: d.picked._id,
      qty: d.qty,
      remark: d.remark.trim()
    }).then(function (res) {
      that.setData({ submitting: false });
      if (res.code !== 0) {
        wx.showModal({ title: '入库失败', content: res.message || '入库失败，请稍后重试', showCancel: false });
        return;
      }
      var m = res.data.material;
      var bal = res.data.balanceAfter;
      wx.showModal({
        title: '入库成功',
        content: m.name + ' ' + fmt.formatQty(res.data.purchase.qty, m.unit) +
          '；总仓余额 ' + fmt.formatQty(bal.after, m.unit),
        showCancel: false
      });
      that.setData({ qty: '', remark: '' });
    }).catch(function () {
      that.setData({ submitting: false });
    });
  }
});
