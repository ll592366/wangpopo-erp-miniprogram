// ==========================================================================
// cloudfunctions/store — 门店：list / rename / toggle / resetPassword（ARCH v1.5 §4.5）
// · list           manager（分店与账号页）
// · rename         manager · store.rename · 仅改名
// · toggle         manager · store.toggle · open↔closed（闭店写 closedAt，复业清空）
// · resetPassword  manager · user.resetPassword · 仅门店端账号（重置密码 = 只改密码）
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'list');

  if (action === 'list') {
    // 分店与账号页：门店档 + 门店账号一览（manager）
    return auth.requireUser(db, C.ACTION.STORE_RENAME, null, event).then(function () {
      return Promise.all([
        db.collection('store').limit(100).get(),
        db.collection('user').where({ role: C.ROLE.SHOP }).limit(100).get()
      ]);
    }).then(function (rs) {
      var stores = rs[0].data || [];
      var users = rs[1].data || [];
      var byStore = {};
      users.forEach(function (u) {
        if (!byStore[u.storeId]) { byStore[u.storeId] = []; }
        byStore[u.storeId].push({ _id: u._id, name: u.name, username: u.username, isActive: u.isActive });
      });
      return {
        rows: stores.map(function (s) {
          return {
            _id: s._id, code: s.code, name: s.name,
            status: s.status || C.STORE_STATUS.OPEN, closedAt: s.closedAt || null,
            accounts: byStore[s._id] || []
          };
        })
      };
    });
  }

  if (action === 'rename') {
    return auth.requireUser(db, C.ACTION.STORE_RENAME, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      var name = String(event.name || '').trim();
      if (!name) { throw new R.BizError(C.CODE.NEGATIVE, '请填写门店名称'); }
      return db.collection('store').doc(event._id).get().then(function (res) {
        if (!res.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
        if (res.data.name === name) { return { _id: event._id, name: name }; }
        return db.collection('store').where({ name: name }).limit(1).get().then(function (dup) {
          if (dup.data && dup.data[0]) { throw new R.BizError(C.CODE.DUPLICATE, '门店名称已存在：' + name); }
          return db.collection('store').doc(event._id).update({ data: { name: name } })
            .then(function () {
              return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.STORE_RENAME,
                '分店改名：' + res.data.name + ' → ' + name, '名称：' + res.data.name, '名称：' + name);
            }).then(function () { return { _id: event._id, name: name }; });
        });
      });
    });
  }

  if (action === 'toggle') {
    return auth.requireUser(db, C.ACTION.STORE_TOGGLE, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      return db.collection('store').doc(event._id).get().then(function (res) {
        if (!res.data) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
        var st = res.data;
        var cur = st.status || C.STORE_STATUS.OPEN;
        var to = event.toggleTo || (cur === C.STORE_STATUS.OPEN ? C.STORE_STATUS.CLOSED : C.STORE_STATUS.OPEN);
        var patch = { status: to, closedAt: to === C.STORE_STATUS.CLOSED ? dbh.nowIso() : null };
        return db.collection('store').doc(event._id).update({ data: patch })
          .then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.STORE_TOGGLE,
              (to === C.STORE_STATUS.CLOSED ? '闭店：' : '复业：') + st.name,
              'status=' + cur, 'status=' + to + (patch.closedAt ? '；closedAt=' + patch.closedAt : '；closedAt 清空'));
          }).then(function () { return { _id: event._id, status: to, closedAt: patch.closedAt }; });
      });
    });
  }

  if (action === 'resetPassword') {
    return auth.requireUser(db, C.ACTION.USER_RESET_PASSWORD, null, event).then(function (ctx) {
      if (!event.userId) { throw new R.BizError(C.CODE.NEGATIVE, '账号信息缺失，请重新登录'); }
      var pwd = String(event.newPassword || '');
      if (pwd.length < 6) { throw new R.BizError(C.CODE.NEGATIVE, '新密码至少 6 位'); }
      return db.collection('user').doc(event.userId).get().then(function (res) {
        var u = res.data;
        if (!u) { throw new R.BizError(C.CODE.NOT_FOUND, '账号未找到'); }
        if (u.role !== C.ROLE.SHOP) { throw new R.BizError(C.CODE.FORBIDDEN, '只能重置门店端账号的密码'); }
        return db.collection('user').doc(event.userId).update({
          data: { password: pwd, passwordChanged: true }
        }).then(function () {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.USER_RESET_PASSWORD,
            '重置 ' + u.name + '（' + (u.username || '') + '）的密码', '', '密码已更新');
        }).then(function () { return { _id: event.userId }; });
      });
    });
  }

  if (action === 'resetAllPassword') {
    return auth.requireUser(db, C.ACTION.STORE_RESET_ALL_PASSWORD, null, event).then(function (ctx) {
      var storeId = String(event.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      var pwd = String(event.newPassword || '');
      if (pwd.length < 6) { throw new R.BizError(C.CODE.NEGATIVE, '新密码至少 6 位'); }
      return db.collection('user').where({ storeId: storeId, role: C.ROLE.SHOP }).get()
        .then(function (res) {
          var users = res.data || [];
          if (users.length === 0) { return { affected: 0 }; }
          // 串行更新（参考 memory 教训：微信云事务并发写会报 -501001）
          var p = Promise.resolve();
          var updated = 0;
          users.forEach(function (u) {
            p = p.then(function () {
              return db.collection('user').doc(u._id).update({
                data: { password: pwd, passwordChanged: true }
              }).then(function () { updated += 1; });
            });
          });
          return p.then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.STORE_RESET_ALL_PASSWORD,
              '批量重置门店 ' + storeId + ' 的 ' + users.length + ' 个账号密码', '', '新密码已应用到 ' + updated + ' 个账号');
          }).then(function () { return { affected: updated }; });
        });
    });
  }

  /* ---------------- setThreshold：门店级库存预警阈值（2026-10-09 老板拍板） ----------------
   * 老板口径：门店**只同步库存，不继承总仓阈值**（总仓阈值是备货警戒线，门店库存天然远低于它 →
   *   常年误报）。所以门店要有**自己的**阈值，每店一个统一值，存在 store 文档上。
   *   不传 / 传空 = 清除该店设置 → 回落默认（C.CONFIG.LOW_STOCK_THRESHOLD，=2）。
   * 写法与 rename / toggle 保持一致：普通 update（不进事务）+ dbh.log() 留痕。
   */
  if (action === 'setThreshold') {
    return auth.requireUser(db, C.ACTION.STORE_SET_THRESHOLD, null, event).then(function (ctx) {
      var storeId = String(event.storeId || '');
      if (!storeId) { throw new R.BizError(C.CODE.NEGATIVE, '门店信息缺失，请重新登录'); }
      var raw = event.threshold;
      var cleared = (raw === undefined || raw === null || String(raw).trim() === '');
      var val = null;
      if (!cleared) {
        var n = Number(raw);
        if (!isFinite(n)) { throw new R.BizError(C.CODE.NEGATIVE, '预警阈值必须是数字'); }
        if (!(n > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '预警阈值必须大于 0'); }
        val = dbh.quantizeStock(n);
      }
      return db.collection('store').doc(storeId).get().then(function (res) {
        var st = res.data;
        if (!st) { throw new R.BizError(C.CODE.NOT_FOUND, '门店未找到'); }
        var before = dbh.storeThresholdOf(st);
        var after = cleared ? C.CONFIG.LOW_STOCK_THRESHOLD : val;
        return db.collection('store').doc(storeId).update({
          data: { lowStockThreshold: cleared ? null : val }
        }).then(function () {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.STORE_SET_THRESHOLD,
            (cleared ? '清除 ' : '设置 ') + st.name + ' 的本店库存预警阈值',
            '预警阈值 ' + before, '预警阈值 ' + after + (cleared ? '（已清除，回落默认）' : ''));
        }).then(function () {
          return { _id: storeId, lowStockThreshold: cleared ? null : val, threshold: after };
        });
      });
    });
  }

  // 原始 action 只写日志，不外泄给用户
  console.error('[UNKNOWN_ACTION]', 'store', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
