// ==========================================================================
// pages/manager/shops-accounts — 账号管理（原「门店账号」+「我的」合并）
// 上半：我的账号（管理端自己的信息 + 自助改密 + 退出登录）
// 下半：分店管理（改店名 + 重置门店账号密码 + 闭店/复业）
// 管理端无「新建分店 / 删除分店」入口：分店只能由门店端注册产生（D13）
// ==========================================================================
var cloud = require('../../../utils/cloud');
var auth = require('../../../utils/auth');
var C = require('../../../utils/constants');
var search = require('../../../utils/list-search');

Page({
  data: {
    rows: [],
    kw: '',                 // 搜索词（匹配 门店名 + 账号；本地过滤，不调云函数）
    // —— 我的账号（自助改密，逻辑与 mine/profile 一致）——
    user: null,
    roleLabel: '',
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    showOld: false,
    showNew: false,
    showConfirm: false,
    submitting: false,
    pwdOpen: false,          // 改密弹层开关（收进弹层，账号行只留「改密」按钮）
    // 防连点锁（老板 2026-10-13 总规矩）：store 三个写操作（改店名/闭店复业/批量重置密码）
    // 共用一把 storing 锁——同一时刻最多只可能弹一个 modal，共锁即够；
    // modal 弹出期间锁住，连点别的行不并发弹框/发请求。
    storing: false,
    // 操作日记
    logOpen: false,
    logs: []                // [{ _id, actorName, action, target, after, createdAt, timeText, actionLabel }]
  },

  _rowsFull: [],           // 分店全量（过滤底稿）

  onShow: function () {
    this.loadUser();
    this.loadAll();
  },

  /** 我的账号：取当前登录用户（不依赖门店） */
  loadUser: function () {
    var user = getApp().globalData.user;
    if (!user) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.setData({ user: user, roleLabel: auth.roleLabel(user.role) });
  },

  onPullDownRefresh: function () {
    this.loadAll();
    wx.stopPullDownRefresh();
  },

  loadAll: function () {
    var that = this;
    cloud.call('store', { action: 'list' }).then(function (res) {
      var rows = res.code === 0 ? res.data.rows : [];
      rows.forEach(function (r) {
        r.closed = r.status === 'closed';
        // 一行式：账号以「账号 用户名」展示（老板 2026-09-15 拍板与「我的账号」同款）
        var accs = r.accounts || [];
        r.accText = accs.length
          ? '账号 ' + accs.map(function (u) { return u.username; }).join('、')
          : '该店暂无账号';
      });
      that._rowsFull = rows;
      that.setData({ rows: rows });
      that.applySearch();     // 拉完重新套一次搜索词（onShow 回来也不会丢过滤）
    });
  },

  /* ---------------- 检索（本地过滤，不调云函数） ---------------- */
  /**
   * 重新套一次搜索过滤（**一次 setData**）
   * 匹配：门店名（name）+ 账号行文本（accText，形如「账号 zhangsan、lisi」）
   * @param {string} [kwField] 只重算这个搜索框（wxml 上 data-kw 传进来）；省略 = 重算
   * @param {string} [kw]      新搜索词；省略 = 沿用当前值（loadAll 刷新后重算走这条）
   */
  applySearch: function (kwField, kw) {
    var k = (kwField === 'kw' && kw !== undefined) ? kw : this.data.kw;
    this.setData({ kw: k, rows: search.filter(this._rowsFull, k, ['name', 'accText']) });
  },

  onSearchInput: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, String((e.detail && e.detail.value) || ''));
  },

  onSearchClear: function (e) {
    var ds = (e.currentTarget && e.currentTarget.dataset) || {};
    this.applySearch(ds.kw, '');
  },

  renameStore: function (e) {
    // 防连点锁：三个 store 写操作共用（modal 弹出期间连点其它行不并发弹框）
    if (this.data.storing) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    var row = that.data.rows.filter(function (r) { return r._id === id; })[0];
    if (!row) { return; }
    that.setData({ storing: true });
    wx.showModal({
      title: '改店名',
      editable: true,
      placeholderText: '当前：' + row.name,
      success: function (r) {
        if (!r.confirm) { that.setData({ storing: false }); return; }
        var name = (r.content || '').trim();
        if (!name || name === row.name) { that.setData({ storing: false }); return; }
        cloud.callWithToast('store', { action: 'rename', _id: id, name: name }, '店名已更新')
          .then(function (res) {
            that.setData({ storing: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ storing: false }); });
      },
      fail: function () { that.setData({ storing: false }); }
    });
  },

  toggleStore: function (e) {
    if (this.data.storing) { return; }
    var that = this;
    var id = e.currentTarget.dataset.id;
    var row = that.data.rows.filter(function (r) { return r._id === id; })[0];
    if (!row) { return; }
    var toClosed = !row.closed;
    that.setData({ storing: true });
    wx.showModal({
      title: toClosed ? '确认闭店' : '确认复业',
      content: toClosed
        ? '闭店后「' + row.name + '」门店账号无法登录（登录提示“门店已闭店”），已登录会话的写动作也被拒。'
        : '复业后「' + row.name + '」门店账号恢复登录。',
      success: function (r) {
        if (!r.confirm) { that.setData({ storing: false }); return; }
        cloud.callWithToast('store', { action: 'toggle', _id: id, toggleTo: toClosed ? 'closed' : 'open' },
          toClosed ? '已闭店' : '已复业')
          .then(function (res) {
            that.setData({ storing: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ storing: false }); });
      },
      fail: function () { that.setData({ storing: false }); }
    });
  },

  resetAllPwd: function (e) {
    if (this.data.storing) { return; }
    var that = this;
    var storeId = e.currentTarget.dataset.id;
    var storeName = e.currentTarget.dataset.name;
    that.setData({ storing: true });
    wx.showModal({
      title: '批量重置密码',
      content: '为「' + storeName + '」所有门店账号设置同一个新密码（至少 6 位）：',
      editable: true,
      placeholderText: '请输入新密码',
      success: function (r) {
        if (!r.confirm) { that.setData({ storing: false }); return; }
        var pwd = (r.content || '');
        if (pwd.length < 6) { wx.showToast({ title: '密码至少 6 位', icon: 'none' }); that.setData({ storing: false }); return; }
        cloud.callWithToast('store', { action: 'resetAllPassword', storeId: storeId, newPassword: pwd }, '批量重置完成')
          .then(function (res) {
            that.setData({ storing: false });
            if (res.code === 0) { that.loadAll(); }
          })
          .catch(function () { that.setData({ storing: false }); });
      },
      fail: function () { that.setData({ storing: false }); }
    });
  },

  /* ---------------- 我的账号：改密弹层 + 自助改密 + 退出登录 ---------------- */
  openPwd: function () { this.setData({ pwdOpen: true }); },
  closePwd: function () { this.setData({ pwdOpen: false }); },
  noop: function () { /* 阻止弹层内点击冒泡到遮罩关闭 */ },

  /* ---------------- 操作日记 ---------------- */
  onViewLog: function () {
    var that = this;
    this.setData({ logOpen: true, logs: [] });
    cloud.call('opLog', { limit: 100 }).then(function (res) {
      var logs = (res.code === 0 ? (res.data.logs || []) : []).map(function (item) {
        item.timeText = item.createdAt ? item.createdAt.slice(5, 16).replace('T', ' ') : '';
        // action（小写点分，如 production.create）→ 中文标签；用公共常量表，避免与写入端再对不上
        item.actionLabel = C.ACTION_LABEL[item.action] || item.action;
        return item;
      });
      that.setData({ logs: logs });
    });
  },
  closeLog: function () { this.setData({ logOpen: false }); },
  onOldPassword: function (e) { this.setData({ oldPassword: e.detail.value }); },
  onNewPassword: function (e) { this.setData({ newPassword: e.detail.value }); },
  onConfirmPassword: function (e) { this.setData({ confirmPassword: e.detail.value }); },
  toggleOld: function () { this.setData({ showOld: !this.data.showOld }); },
  toggleNew: function () { this.setData({ showNew: !this.data.showNew }); },
  toggleConfirm: function () { this.setData({ showConfirm: !this.data.showConfirm }); },

  /** 自助改密：login 云函数 action=changePassword（旧密码校验后更新） */
  onChangePassword: function () {
    // 防连点锁：按钮绑了 loading，但 view 层 loading 不拦 bindtap——js 侧再拦一道
    if (this.data.submitting) { return; }
    var that = this;
    var oldPwd = this.data.oldPassword;
    var newPwd = this.data.newPassword;
    var confirmPwd = this.data.confirmPassword;
    if (!oldPwd || !newPwd) { return this.toast('请填写完整'); }
    if (newPwd.length < 6) { return this.toast('新密码至少 6 位'); }
    if (newPwd !== confirmPwd) { return this.toast('两次输入的新密码不一致'); }

    this.setData({ submitting: true });
    cloud.call('login', {
      action: 'changePassword',
      oldPassword: oldPwd,
      newPassword: newPwd
    }).then(function (res) {
      that.setData({ submitting: false });
      if (res.code !== 0) { return that.toast(res.message || '修改失败'); }
      that.setData({ oldPassword: '', newPassword: '', confirmPassword: '', pwdOpen: false });
      wx.showToast({ title: '密码已更新', icon: 'success' });
    }).catch(function () {
      that.setData({ submitting: false });
      that.toast('网络异常，请重试');
    });
  },

  /** 退出登录：清登录态 → 回登录页 */
  onLogout: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: function (r) {
        if (!r.confirm) { return; }
        getApp().logout();
      }
    });
  },

  toast: function (msg) {
    wx.showToast({ title: msg, icon: 'none' });
  }
});
