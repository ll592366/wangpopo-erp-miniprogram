// ==========================================================================
// pages/login/login — 账号密码登录（以账号为准，不绑微信）
// 状态：login（账号密码表单）| register（注册开店）
// 管理端默认账号 888 / 888888。**不做首登强制改密**（老板口径：想改自己去「我的」页改）；
// 注册开店成功直接进门店端。
// ==========================================================================
var cloud = require('../../utils/cloud');
var app = getApp();

Page({
  data: {
    loading: false,
    state: 'login',      // login | register
    // 登录表单
    username: '',
    password: '',
    showPwd: false,      // 密码明文开关（眼睛）
    // 注册开店
    shopName: '',
    regUsername: '',
    regPassword: '',
    showRegPwd: false
  },

  onLoad: function () {
    // 以账号为准：进页一律停在登录表单，不做任何微信身份识别
    this.setData({ state: 'login', loading: false });
  },

  /* ---------------- 登录 ---------------- */
  onUsername: function (e) { this.setData({ username: e.detail.value }); },
  onPassword: function (e) { this.setData({ password: e.detail.value }); },
  togglePwd: function () { this.setData({ showPwd: !this.data.showPwd }); },

  doLogin: function () {
    var that = this;
    var d = that.data;
    if (!d.username.trim() || !d.password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' }); return;
    }
    that.setData({ loading: true });
    cloud.call('login', { username: d.username.trim(), password: d.password }).then(function (res) {
      if (res.code !== 0) {
        that.setData({ loading: false });
        wx.showModal({
          title: '登录失败',
          content: res.message || '登录失败，请稍后重试',
          showCancel: false
        });
        return;
      }
      // 直接进对应角色的首页（改密请到「我的」页自助修改）
      that.enter(res.data);
    });
  },

  /** 写 globalData 并按角色进默认首页（manager→商品管理 / shop→今日出品） */
  enter: function (u) {
    app.globalData.user = u;
    app.goHome();
  },

  /* ---------------- 注册开店 ---------------- */
  goRegister: function () { this.setData({ state: 'register' }); },
  backToLogin: function () { this.setData({ state: 'login' }); },

  onShopName: function (e) { this.setData({ shopName: e.detail.value }); },
  onRegUsername: function (e) { this.setData({ regUsername: e.detail.value }); },
  onRegPassword: function (e) { this.setData({ regPassword: e.detail.value }); },
  toggleRegPwd: function () { this.setData({ showRegPwd: !this.data.showRegPwd }); },

  doRegister: function () {
    var that = this;
    var d = that.data;
    if (!d.shopName.trim()) { wx.showToast({ title: '请填写门店名称', icon: 'none' }); return; }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(d.regUsername.trim())) {
      wx.showToast({ title: '账号需 3–20 位字母/数字/下划线', icon: 'none' }); return;
    }
    if (d.regPassword.length < 6) { wx.showToast({ title: '密码至少 6 位', icon: 'none' }); return; }
    that.setData({ loading: true });
    cloud.call('register', {
      shopName: d.shopName, username: d.regUsername.trim(), password: d.regPassword
    }).then(function (res) {
      if (res.code !== 0) {
        that.setData({ loading: false });
        wx.showModal({ title: '注册失败', content: res.message || '注册失败，请稍后重试', showCancel: false });
        return;
      }
      // 注册返回即登录身份 → 直接进门店端
      wx.showToast({ title: '开店成功，欢迎 ' + res.data.name, icon: 'success' });
      that.enter(res.data);
    });
  }
});
