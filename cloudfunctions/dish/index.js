// ==========================================================================
// cloudfunctions/dish — 菜品档案（ARCH v1.5 §4.5；内嵌 consumeItems，无 price / storeId）
// action: list | save（manager） | toggle（manager） | remove（manager）
// consumeItems: [{ itemId, qty }]，qty = 每份用量（兼容老板表「A单位=B份」：
//   存 qty=A/B；可选 portions=B 则运行时 qty/portions，两法等价 · PRD v0.9 附录 B）
//
// 下架校验口径（2026-10-09 拍板，改动前先读）：
//   save 只拦「**新增**」的下架食材 —— 已在原配方里的行一律放行。
//   原因：老板编辑老菜时，配方里可能仍留着已下架食材（前端下拉会把它追加进选项，
//   见 goods.js _extendOptions）；若服务端无差别拦，老板一点保存整条配方就没了。
//   🔴 红线圈定：只允许「不在原配方 itemId 集合里 && isActive === false」才报 2002。
//      把它改成「只要 isActive === false 就报」= 线上事故（老菜保存即丢配方）。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

function num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : Math.round(n * 10000) / 10000;
}

/** 列表一次拉取的上限（2026-10-09 修线上静默截断）。
 *  ⚠️ 原先这里是**写死的 limit(100) 且没有 orderBy** —— 菜品数破 100 后，
 *     新建的菜排在第 101 位被云开发直接截掉，toast 说「菜品已保存」但列表里永远找不到，
 *     且**没有任何报错**（与 material.list 同款静默失效）。
 *  真正的根治不是把数字调大，而是同时返回 total / truncated，让调用方知道「被截断了」。 */
var MAX_LIST = 500;

/**
 * 菜品列表内存排序（云端已 orderBy('createdAt','desc')，这里做**确定性**兜底）。
 * 主序 createdAt 倒序 → 次序 isActive（停用排后面，保留原行为）→ 兜底 _id（稳定）。
 * ⚠️ 老菜品可能**没有** createdAt 字段：一律当最旧处理（排最后），不会被顶到看不见的地方；
 *    真被上限截断时 total/truncated 会明确告诉调用方。
 */
function listCmp(a, b) {
  var ca = String(a.createdAt || '');
  var cb = String(b.createdAt || '');
  if (ca !== cb) { return ca < cb ? 1 : -1; }
  var ia = a.isActive === false ? 1 : 0;
  var ib = b.isActive === false ? 1 : 0;
  if (ia !== ib) { return ia - ib; }
  var ida = String(a._id || '');
  var idb = String(b._id || '');
  return ida < idb ? -1 : (ida > idb ? 1 : 0);
}

/**
 * 读取「原配方」的 itemId 集合（仅编辑态需要）。
 * 事务外的一次 get，与 material 查询并发（见 normalizeConsume 的 Promise.all），
 * **不增加串行往返**；save 全程不在事务里，不碰 30 秒红线。
 * @param {string|undefined} dishId 菜品 _id；新建态为 falsy
 * @return {Promise<Object>} { [itemId]: true }，读不到时为空集（按「全是新增行」从严判定）
 */
function loadExistingIds(dishId) {
  if (!dishId) { return Promise.resolve({}); }
  return db.collection('dish').doc(String(dishId)).get()
    .catch(function () { return { data: null }; })
    .then(function (res) {
      var out = {};
      var cis = (res.data && res.data.consumeItems) || [];
      cis.forEach(function (ci) {
        if (ci && ci.itemId) { out[String(ci.itemId)] = true; }
      });
      return out;
    });
}

/**
 * 校验内嵌清单：每行 itemId 存在、qty>0，且**新增行**不能是已下架食材。
 * @param {Array} items 前端传来的 consumeItems
 * @param {Promise<Object>|Object} existingIdsP 原配方 itemId 集合（同 Promise 或对象）
 * @return {Promise<Array>} [{ itemId, qty, portions }]
 */
function normalizeConsume(items, existingIdsP) {
  var arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) { return Promise.resolve([]); }
  var ids = arr.map(function (it) { return String(it.itemId || ''); });
  return Promise.all([
    db.collection('material').where({ _id: db.command.in(ids) }).limit(100).get(),
    Promise.resolve(existingIdsP || {})
  ]).then(function (rs) {
    var res = rs[0] || { data: [] };
    var existingIds = rs[1] || {};
    var found = {};
    (res.data || []).forEach(function (m) { found[m._id] = m; });
    var norm = [];
    arr.forEach(function (it) {
      it = it || {};
      var id = String(it.itemId || '');
      if (!id) { throw new R.BizError(C.CODE.NEGATIVE, '消耗清单存在未选择食材的行'); }
      var m = found[id];
      if (!m) { throw new R.BizError(C.CODE.NOT_FOUND, '部分食材不存在，请刷新后重试'); }
      /* 🔴 只拦「新增」：原配方里已有的行（existingIds[id]）即使已下架也放行，
       * 否则老板编辑老菜一保存，配方里的下架食材就被整条抹掉。 */
      if (m.isActive === false && !existingIds[id]) {
        throw new R.BizError(C.CODE.NEGATIVE,
          '食材「' + (m.name || '该食材') + '」已下架，不能加进菜品配方');
      }
      var qty = num(it.qty);
      if (!(qty > 0)) { throw new R.BizError(C.CODE.NEGATIVE, '每份用量必须大于 0（食材：' + m.name + '）'); }
      norm.push({ itemId: id, qty: qty, portions: it.portions ? num(it.portions) : null });
    });
    return norm;
  });
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'list');

  if (action === 'list') {
    return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event).then(function () {
      /* ⚠️ 列表 + count **并发**发出（Promise.all），不要串行 —— 串行等于慢一倍。
       *   orderBy('createdAt','desc') + _id 次序：新建的排最前，老板建完不用搜索也能在顶部看见。
       *   truncated = total > rows.length：把「被静默截断」变成调用方看得见的事实。 */
      return Promise.all([
        db.collection('dish').orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(MAX_LIST).get(),
        db.collection('dish').count()
      ]).then(function (rs) {
        var rows = (rs[0].data || []).sort(listCmp);
        var total = rs[1].total || 0;
        return { rows: rows, total: total, truncated: total > rows.length };
      });
    });
  }

  if (action === 'save') {
    return auth.requireUser(db, C.ACTION.DISH_UPDATE, null, event).then(function (ctx) {
      var name = String(event.name || '').trim();
      if (!name) { throw new R.BizError(C.CODE.NEGATIVE, '请填写菜品名称'); }
      // 原配方 itemId 集合与 material 查询并发预取，不额外增加串行往返
      return normalizeConsume(event.consumeItems, loadExistingIds(event._id)).then(function (items) {
        return db.collection('dish').where({ name: name }).limit(2).get().then(function (res) {
          var dup = (res.data || []).filter(function (d) { return d._id !== event._id; })[0];
          if (dup) { throw new R.BizError(C.CODE.DUPLICATE, '菜品已存在：' + name); }

          if (event._id) {
            return db.collection('dish').doc(event._id).update({
              data: { name: name, consumeItems: items }
            }).then(function () {
              return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.DISH_UPDATE,
                '编辑菜品 ' + name, '', JSON.stringify(items));
            }).then(function () { return { _id: event._id }; });
          }
          var doc = { name: name, consumeItems: items, isActive: true, createdAt: dbh.nowIso() };
          return db.collection('dish').add({ data: doc }).then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.DISH_UPDATE,
              '新增菜品 ' + name, '', JSON.stringify(items));
          }).then(function () { return doc; });
        });
      });
    });
  }

  if (action === 'toggle') {
    return auth.requireUser(db, C.ACTION.DISH_UPDATE, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '菜品信息缺失，请刷新后重试'); }
      return db.collection('dish').doc(event._id).get().then(function (res) {
        if (!res.data) { throw new R.BizError(C.CODE.NOT_FOUND, '菜品未找到'); }
        var to = event.isActive !== false;
        return db.collection('dish').doc(event._id).update({ data: { isActive: to } })
          .then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.DISH_UPDATE,
              (to ? '启用' : '停用') + '菜品 ' + res.data.name, '', 'isActive=' + to);
          }).then(function () { return { _id: event._id, isActive: to }; });
      });
    });
  }
  /* 删除菜品档案（manager · 带引用检查）：
   *  · 被「出品记录」引用 → 拦住（报人话，不暴露 dishId）；
   *  · 菜品不持有库存余额（stock_balance 以食材 itemId 为键），无级联清理。 */
  if (action === 'remove') {
    return auth.requireUser(db, C.ACTION.DISH_UPDATE, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '未指定要操作的菜品，请刷新页面后重试'); }
      var dishId = String(event._id);
      return db.collection('dish').doc(dishId).get()
        .catch(function () { return { data: null }; })
        .then(function (res) {
          var d = res.data;
          if (!d) { throw new R.BizError(C.CODE.NOT_FOUND, '菜品未找到'); }
          var name = d.name || '';
          return db.collection('production').where({ dishId: dishId }).count().then(function (cres) {
            var prodCount = cres.total || 0;
            if (prodCount) {
              throw new R.BizError(C.CODE.NEGATIVE,
                '「' + name + '」已被使用，不能删除：有 ' + prodCount + ' 条出品记录');
            }
            return db.collection('dish').doc(dishId).remove().then(function () {
              return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.DISH_UPDATE,
                '删除菜品 ' + name, name, '配方 ' + ((d.consumeItems || []).length) + ' 条')
                .then(function () { return { _id: dishId }; });
            });
          });
        });
    });
  }

  // 原始 action 只写日志，不外泄给用户
  console.error('[UNKNOWN_ACTION]', 'dish', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
