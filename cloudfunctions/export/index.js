// ==========================================================================
// cloudfunctions/export — 数据导出（ARCH v1.5 §4.5 / §4.5 export 说明；只读）
// 入口 can('data.export') → 仅 manager。12 列宽表、按发生时间升序、一明细一行。
// 12 列：流水类型/单据号/营业日/发生时间/发出方/接收方/标的/数量/单位/状态/经办人/备注
// 覆盖：采购入库 / 食材申请 / 今日出品 / 剩余实点。不写 op_log、不改余额。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

var HEADER = ['流水类型', '单据号', '营业日', '发生时间', '发出方', '接收方', '标的', '数量', '单位', '状态', '经办人', '备注'];

/** 精度口径 = 3 位（与余额写入同口径）。老板要求「时间范围内全量导出」，
 *  导出数量必须与库存真值逐位一致 —— 2 位截断会让 CSV 里的 0.333 变成 0.33（对不上账）。 */
function r2(n) { return dbh.quantizeStock(n); }

exports.main = R.wrap(function (event) {
  return auth.requireUser(db, C.ACTION.DATA_EXPORT, null, event).then(function (ctx) {
    var today = dbh.bizDate();
    var from = event.from || '2000-01-01';
    var to = event.to || today;

    return Promise.all([
      db.collection('purchase').where({ bizDate: db.command.gte(from).and(db.command.lte(to)) }).limit(1000).get(),
      db.collection('requisition').where({ bizDate: db.command.gte(from).and(db.command.lte(to)) }).limit(1000).get(),
      db.collection('production').where({ bizDate: db.command.gte(from).and(db.command.lte(to)) }).limit(1000).get(),
      db.collection('stocktake').where({ source: 'stocktake', bizDate: db.command.gte(from).and(db.command.lte(to)) }).limit(1000).get()
    ]);
  }).then(function (rs) {
    var purchases = rs[0].data || [];
    var requisitions = rs[1].data || [];
    var productions = rs[2].data || [];
    var stocktakes = rs[3].data || [];

    // 物料 name/unit 缓存
    var matCache = {};
    var userCache = {};
    var storeCache = {};
    var dishCache = {};

    function matOf(id) { return matCache[id] || { name: id, unit: '' }; }
    function userOf(id) { return (userCache[id] || {}).name || id || ''; }
    function storeOf(id) { return id === C.STORE_WAREHOUSE ? '总仓' : ((storeCache[id] || {}).name || id); }
    function dishOf(id) { return (dishCache[id] || {}).name || id; }

    var loadMeta = Promise.all([
      db.collection('material').limit(1000).get(),
      db.collection('user').limit(1000).get(),
      db.collection('store').limit(1000).get(),
      db.collection('dish').limit(1000).get()
    ]).then(function (ms) {
      (ms[0].data || []).forEach(function (d) { matCache[d._id] = d; });
      (ms[1].data || []).forEach(function (d) { userCache[d._id] = d; });
      (ms[2].data || []).forEach(function (d) { storeCache[d._id] = d; });
      (ms[3].data || []).forEach(function (d) { dishCache[d._id] = d; });
      return null;
    });

    return loadMeta.then(function () {
      var rows = [];

      // ① 采购入库：每条 1 行（发出方 = 总仓）
      purchases.forEach(function (p) {
        var m = matOf(p.itemId);
        rows.push({ t: p.createdAt, r: ['采购入库', p._id, p.bizDate, p.createdAt, '总仓', '',
          m.name, r2(p.qty), m.unit, '已入库', userOf(p.operatorId), p.remark || ''] });
      });

      // ② 食材申请：一明细一行（同单多食材共用单据号）
      requisitions.forEach(function (rq) {
        (rq.items || []).forEach(function (it) {
          var m = matOf(it.itemId);
          rows.push({ t: rq.createdAt, r: ['食材申请', rq._id, rq.bizDate, rq.createdAt, '总仓', storeOf(rq.storeId),
            m.name, r2(it.qty), m.unit,
            C.REQ_STATUS_LABEL[rq.status] || rq.status,
            userOf(rq.handledBy || rq.applicantId), rq.rejectReason || ''] });
        });
      });

      // ③ 今日出品：每条 1 行（备注 = 消耗明细）
      productions.forEach(function (p) {
        var consume = (p.consumeItems || []).map(function (ci) {
          var m = matOf(ci.itemId);
          return m.name + ' ' + r2(ci.qty) + (m.unit ? ' ' + m.unit : '');
        }).join('，');
        rows.push({ t: p.createdAt, r: ['今日出品', p._id, p.bizDate, p.createdAt, storeOf(p.storeId), '',
          dishOf(p.dishId), r2(p.qty), '份',
          C.PROD_STATUS_LABEL[p.status] || p.status, userOf(p.operatorId), consume ? '消耗：' + consume : ''] });
      });

      // ④ 剩余实点：每条 1 行
      stocktakes.forEach(function (s) {
        var m = matOf(s.itemId);
        rows.push({ t: s.createdAt, r: ['剩余实点', s._id, s.bizDate, s.createdAt, storeOf(s.storeId), '',
          m.name, r2(s.actualQty), m.unit,
          C.DIFF_TYPE_LABEL[s.diffType] || s.diffType, userOf(s.operatorId),
          '账面 ' + r2(s.theoryQty) + ' ' + m.unit + '，差异 ' + r2(s.diff) + ' ' + m.unit] });
      });

      // 按发生时间升序
      rows.sort(function (a, b) {
        var ta = a.t || '', tb = b.t || '';
        if (ta === tb) { return 0; }
        if (!ta) { return 1; }
        if (!tb) { return -1; }
        return ta < tb ? -1 : 1;
      });

      return { header: HEADER, rows: rows.map(function (x) { return x.r; }), total: rows.length };
    });
  });
});
