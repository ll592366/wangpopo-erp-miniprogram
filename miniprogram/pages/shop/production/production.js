// ==========================================================================
// pages/shop/production — 门店端默认首页（v1.0.3 起只做"看+发"两件事）
// · 顶栏：店名 + 退出登录
// · 通知栏：库存预警 / 待确认申请（复用 components/notice-bar）
// · 宫格：食材申请 / 店内库存（今日出品 v1.0.3 已下放给管理端统一录入）
// ==========================================================================
var cloud = require('../../../utils/cloud');

Page({
  onShow: function () { this.refreshNotice(); },

  /** 每次进首页都重拉通知栏（预警 / 待确认申请，处理完就自动消失） */
  refreshNotice: function () {
    var nb = this.selectComponent && this.selectComponent('#noticeBar');
    if (nb && nb.refresh) { nb.refresh(); }
  },

  /** 首页（栈底）返回 = 退出登录，二次确认防误触 */
  onExit: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: function (r) { if (r.confirm) { getApp().logout(); } }
    });
  }
});