// ==========================================================================
// cloudfunctions/purchase — 采购入库（ARCH v1.5 §4.5；事务 ✅）
// 纯数量口径：无单价 / 无供应商 / 无金额；隐含总仓（stock_balance.storeId='WAREHOUSE'）
// 一站式：{name, qty, spec?, unit?, lowStockThreshold?, remark?}
//   · 按名称查食材档案：没有 → 当场建档（名称/规格/单位/预警值）；已停用 → 拦截提示
//   · 事务：purchase 单据 + 总仓余额 +qty + 日结字段；op_log
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 精度口径 = 3 位（与 changeBalance / snapStock / quantizeStock 同口径）。
 *  ⚠️ 绝不可退回 2 位截断：入库数量被截 2 位，总仓余额从第一次入库起就与 3 位体系不符。 */
function num(v) {
  return dbh.quantizeStock(v);
}

exports.main = R.wrap(function (event) {
  return auth.requireUser(db, C.ACTION.PURCHASE_CREATE, null, event).then(function (ctx) {
    var itemId = String(event.itemId || '');
    var name = String(event.name || '').trim();
    var qty = num(event.qty);
    // itemId 走「档案已存在」路径（采购页下拉选择）；name 走老的一站式路径（兼容/兜底）
    if (!itemId && !name) { throw new R.BizError(C.CODE.NEGATIVE, '请填写食材名称'); }
    if (!(qty > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '采购数量必须大于 0'); }
    var unit = String(event.unit || '').trim() || '包';
    var spec = String(event.spec || '').trim();
    var th = (event.lowStockThreshold === undefined || event.lowStockThreshold === null || event.lowStockThreshold === '')
      ? null : num(event.lowStockThreshold);
    if (th !== null && th <= 0) { th = null; }
    var remark = String(event.remark || '').trim();

    // ① 定位食材档案：
    //    · 传 itemId → 直接取（采购页下拉选择，档案必已存在；不存在/已停用 → 报错，不再现场建档）
    //    · 传 name   → 按名称查：没有 → 当场建档；已停用 → 拦截
    return (itemId
      ? db.collection('material').doc(itemId).get().catch(function () {
        // 真实云数据库 doc().get() 不存在会直接抛错 → 转成业务码提示，而不是 5001
        throw new R.BizError(C.CODE.NOT_FOUND, '所选食材不存在，请先到食材档案新建');
      }).then(function (r) {
        var m = r.data;
        if (!m) { throw new R.BizError(C.CODE.NOT_FOUND, '所选食材不存在，请先到食材档案新建'); }
        if (m.isActive === false) {
          throw new R.BizError(C.CODE.NEGATIVE, '食材「' + m.name + '」已停用，请先在档案管理启用后再入库');
        }
        return m;
      })
      : db.collection('material').where({ name: name }).limit(1).get().then(function (res) {
        var mat = res.data && res.data[0];
        if (mat && mat.isActive === false) {
          throw new R.BizError(C.CODE.NEGATIVE, '食材「' + name + '」已停用，请先在档案管理启用后再入库');
        }
        if (mat) { return mat; }
        var doc = {
          name: name, spec: spec, unit: unit, defaultShelfDays: null,
          lowStockThreshold: th, isActive: true, createdAt: dbh.nowIso()
        };
        return db.collection('material').add({ data: doc }).then(function (r) {
          doc._id = r._id;
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
            '建档食材 ' + name, '', 'unit=' + unit + ';spec=' + spec + ';threshold=' + th)
            .then(function () { return doc; });
        });
      })).then(function (mat) {
      // ② 采购入库（事务）
      return dbh.genId(db, 'pur', C.STORE_WAREHOUSE, 'purchase').then(function (purId) {
        var now = dbh.nowIso();
        // 注意：doc(purId).set() 的 data 不允许带 _id
        var doc = {
          itemId: mat._id, qty: qty,
          operatorId: ctx.user._id, bizDate: dbh.bizDate(),
          createdAt: now, remark: remark
        };
        return dbh.withTx(db, function (t) {
          return t.collection('purchase').doc(purId).set({ data: doc })
            .then(function () { return dbh.changeBalance(t, C.STORE_WAREHOUSE, mat._id, qty, 'in'); });
        }).then(function (bal) {
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.PURCHASE_CREATE,
            '总仓 / ' + mat.name + ' ' + qty + ' ' + mat.unit,
            '总仓 ' + mat.name + ' ' + bal.before + ' ' + mat.unit,
            '总仓 ' + mat.name + ' ' + bal.after + ' ' + mat.unit)
            .then(function () {
              return {
                purchase: Object.assign({ _id: purId }, doc),
                balanceAfter: bal,
                material: { _id: mat._id, name: mat.name, spec: mat.spec || '', unit: mat.unit }
              };
            });
        });
      });
    });
  });
});
