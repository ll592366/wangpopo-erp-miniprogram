// ==========================================================================
// cloudfunctions/register — 注册开店（以账号为准：店名 + 账号 + 密码，一事务建店建号）
// 流程：非空校验(2002) → 店名/账号唯一(3002) → 事务内 store.insert(status=open)
// + user.insert(role=shop, passwordChanged=true) + op_log('store.register')
// → 返回登录身份（前端直接进入门店端，无需再输密码）
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

exports.main = R.wrap(function (event) {
  var shopName = String(event.shopName || '').trim();
  var username = String(event.username || '').trim();
  var password = String(event.password || '');
  if (!shopName) { throw new R.BizError(C.CODE.NEGATIVE, '请填写门店名称'); }
  if (!username) { throw new R.BizError(C.CODE.NEGATIVE, '请填写登录账号'); }
  if (!password) { throw new R.BizError(C.CODE.NEGATIVE, '请填写登录密码'); }
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    throw new R.BizError(C.CODE.NEGATIVE, '登录账号只能由 3–20 位英文字母 / 数字 / 下划线组成');
  }
  if (password.length < 6) { throw new R.BizError(C.CODE.NEGATIVE, '密码至少 6 位'); }

  // 店名 / 账号全局唯一（3002）
  return Promise.all([
    db.collection('store').where({ name: shopName }).limit(1).get(),
    db.collection('user').where({ username: username }).limit(1).get()
  ]).then(function (rs) {
    if (rs[0].data && rs[0].data[0]) { throw new R.BizError(C.CODE.DUPLICATE, '门店名称已存在：' + shopName); }
    if (rs[1].data && rs[1].data[0]) { throw new R.BizError(C.CODE.DUPLICATE, '登录账号已存在：' + username); }
    // 编码（§7.2）：含字母数字取首段大写 ≤6 位；纯中文按 S01/S02 顺序；重复则追加序号
    return dbh.genCode(db, shopName).then(function (base) {
      return db.collection('store').where({ code: base }).get().then(function (exists) {
        var code = base;
        var n = (exists.data || []).length;
        while (n > 0) {
          n -= 1;
          code = base + (n + 2);
        }
        return code;
      });
    });
  }).then(function (code) {
    var storeId = 'store_' + code.toLowerCase() + '_' + dbh.yyyymmdd();
    var userId = 'user_' + username; // username 已查重，全局唯一
    var now = dbh.nowIso();
    // 注意：doc(id).set() 的 data 里不允许带 _id（腾讯云会拒），_id 由 doc(id) 指定
    var storeDoc = {
      code: code, name: shopName,
      status: C.STORE_STATUS.OPEN, closedAt: null,
      createdAt: now
    };
    var userDoc = {
      name: shopName, username: username, password: password,
      role: C.ROLE.SHOP, storeId: storeId,
      passwordChanged: true, isActive: true,
      createdBy: 'self-register', createdAt: now
    };
    // 一事务：建店 + 建号（§4.5 步骤 3-5）
    return dbh.withTx(db, function (t) {
      return t.collection('store').doc(storeId).set({ data: storeDoc })
        .then(function () { return t.collection('user').doc(userId).set({ data: userDoc }); });
    }).then(function () {
      return dbh.log(db, userId, shopName, C.ACTION.STORE_REGISTER,
        '注册开店：' + shopName + '（' + code + '）/ 账号：' + username,
        '', '门店编号：' + storeId + '；账号已建');
    }).then(function () {
      // 直接返回登录身份（与 login.buildIdentity 同构），前端可立即进入门店端
      return {
        _id: userId, role: C.ROLE.SHOP, storeId: storeId,
        name: shopName, username: username, needChangePassword: false,
        store: { _id: storeId, code: code, name: shopName, status: C.STORE_STATUS.OPEN, closedAt: null }
      };
    });
  });
});
