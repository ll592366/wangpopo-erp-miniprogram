// ==========================================================================
// pages/manager/home — 管理端首页（v1.0.3 老板 2026-09-15 拍板新建）
// 只显示：顶栏 + 通知栏 + 2 列宫格导航。商品管理等内容不放在下面（点击卡片才进）。
// ==========================================================================
var cloud = require('../../../utils/cloud');

Page({
  data: {
    pendingCount: 0  // 申请处理角标：待处理申请单数
  },

  onShow: function () {
    this.refreshNotice();
    this.loadPendingCount();
  },

  /** 申请处理角标 */
  loadPendingCount: function () {
    var that = this;
    cloud.call('requisition', { action: 'list', status: 'pending' }).then(function (res) {
      var list = (res && res.code === 0 && res.data) ? (res.data.list || []) : [];
      that.setData({ pendingCount: list.length });
    }).catch(function () {
      that.setData({ pendingCount: 0 });
    });
  },

  refreshNotice: function () {
    var nb = this.selectComponent && this.selectComponent('#noticeBar');
    if (nb && nb.refresh) { nb.refresh(); }
  },

  onExit: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: function (r) { if (r.confirm) { getApp().logout(); } }
    });
  }
});