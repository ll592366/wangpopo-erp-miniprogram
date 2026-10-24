// ==========================================================================
// app.js — 小程序入口
// onLaunch：初始化云开发；登录态解析在 pages/login/login.js（拉 login 云函数）。
// globalData：{ user: {role, storeId, name, username} | null }
// 注：v1.0.3 起门店端无「我的」页（改密由管理端「账号管理」统一重置）；
//     「今日出品」也已下放给管理端统一录入（生产只走 manager 端）。
// ==========================================================================
var cloud = require('./utils/cloud');
var C = require('./utils/constants');

App({
  globalData: {
    /** 登录成功后的用户文档（login 云函数返回），未登录 = null */
    user: null
  },

  onLaunch: function () {
    cloud.init();
    console.log('[ERP] 小程序启动 · 角色 2 类（manager / shop）· 全库只记数量不记金额');
  },

  /**
   * 按角色跳默认首页：manager → 管理端首页（仅宫格导航）；shop → 门店首页（v1.0.3 老板 2026-09-15 拍板：商品管理等内容不在首页直接显示）
   */
  goHome: function () {
    var user = this.globalData.user;
    if (!user) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    if (user.role === C.ROLE.MANAGER) {
      wx.reLaunch({ url: '/pages/manager/home/home' });
    } else {
      wx.reLaunch({ url: '/pages/shop/production/production' });
    }
  },

  /** 退出登录（清登录态回登录页；登录页为账号密码表单，不会自动登录） */
  logout: function () {
    this.globalData.user = null;
    wx.reLaunch({ url: '/pages/login/login' });
  }
});
