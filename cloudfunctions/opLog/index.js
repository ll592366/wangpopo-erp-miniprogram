// ==========================================================================
// cloudfunctions/opLog — 审计查询（ARCH v1.5 §4.5；只读）
// manager：全部；shop：仅本人。orderBy createdAt desc。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

exports.main = R.wrap(function (event) {
  return auth.requireUser(db, C.ACTION.OPLOG_QUERY, null, event).then(function (ctx) {
    var where = {};
    if (ctx.user.role === C.ROLE.SHOP) {
      where.actorId = ctx.user._id;                    // shop 仅本人
    } else if (event.actorId) {
      where.actorId = String(event.actorId);
    }
    if (event.action) { where.action = String(event.action); }
    var limit = Math.min(Math.max(Number(event.limit) || 20, 1), 100);
    return db.collection('op_log').where(where).orderBy('createdAt', 'desc').limit(limit).get()
      .then(function (res) { return { logs: res.data || [] }; });
  });
});
