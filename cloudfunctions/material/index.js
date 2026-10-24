// ==========================================================================
// cloudfunctions/material — 食材档案（ARCH v1.5 §4.5；unit 自由文本，不做换算）
// action: list（两角色可读，菜单/选择器用） | save（manager · 新增/编辑） | toggle（manager · 启停）
//         remove（manager · 删除，带引用检查；stock_balance 随档案清除）
//         fixStockPrecision（manager · 库存精度巡检：存量残渣一次性归零）
// 换算口径：**仍写在菜品里**（dish.consumeItems[].qty/portions）；档案不加换算字段
//   （老板 2026-09-19 拍板：不上移、不迁移；本文件曾短暂加过 portionsPerUnit，已回滚）
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
var stockfix = require('./stockfix');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 精度口径 = 3 位（与 changeBalance / snapStock / quantizeStock 同口径）。
 *  ⚠️ 绝不可退回 2 位截断：档案里存的数量会一路带到余额/报表，截 2 位等于把 3 位体系砍掉一半。 */
function num(v) {
  return dbh.quantizeStock(v);
}

/** 列表一次拉取的上限（2026-10-09 修线上静默截断）。
 *  ⚠️ 原先这里是**写死的 limit(100) 且没有 orderBy** —— 老板库里正好 100 条食材时，
 *     新建的第 101 条被云开发直接截掉，toast 说「档案已建立」但列表里永远找不到，
 *     而且**没有任何报错**：典型的静默失效（老板 2026-10-09 报的「找不到商品名称」）。
 *  真正的根治不是把数字调大，而是同时返回 total / truncated，让调用方知道「被截断了」。 */
var MAX_LIST = 500;

/**
 * 档案列表内存排序（云端已 orderBy('createdAt','desc')，这里做**确定性**兜底）。
 * 主序 createdAt 倒序 → 次序 isActive（下架排后面）→ 兜底 _id（稳定，避免刷新时同组顺序乱跳）。
 * ⚠️ 老档案可能**没有** createdAt 字段（早期手工数据）：一律当最旧处理（排最后），
 *    不会被顶到看不见的地方；真被上限截断时 total/truncated 会明确告诉调用方。
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

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'list');

  if (action === 'list') {
    return auth.can(db, null, C.ACTION.INVENTORY_QUERY).then(function () {
      return auth.requireUser(db, C.ACTION.INVENTORY_QUERY, null, event);
    }).then(function () {
      var q = db.collection('material');
      /* keyword 顺手 trim：全空格不该变成「正则匹配一切空格」的怪查询 */
      var kw = String(event.keyword === undefined || event.keyword === null ? '' : event.keyword).trim();
      var base = kw ? q.where({ name: db.RegExp({ regexp: kw, options: 'i' }) }) : q;
      /* ⚠️ 列表 + count **并发**发出（Promise.all），不要串行 —— 串行等于慢一倍。
       *   orderBy('createdAt','desc') + _id 次序：新建的排最前，老板建完不用搜索也能在顶部看见。
       *   truncated = total > rows.length：把「被静默截断」变成调用方看得见的事实。 */
      return Promise.all([
        base.orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(MAX_LIST).get(),
        base.count()
      ]).then(function (rs) {
        var rows = (rs[0].data || []).sort(listCmp);
        var total = rs[1].total || 0;
        return { rows: rows, total: total, truncated: total > rows.length };
      });
    });
  }

  if (action === 'save') {
    return auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event).then(function (ctx) {
      var name = String(event.name || '').trim();
      var unit = String(event.unit || '').trim();
      var spec = String(event.spec || '').trim();   // 规格（自由文本，如 500g/袋、20包/箱）
      if (!name) { throw new R.BizError(C.CODE.NEGATIVE, '请填写食材名称'); }
      if (!unit) { throw new R.BizError(C.CODE.NEGATIVE, '请填写单位（自由文本，如 斤 / 包 / 盒）'); }
      var th = event.lowStockThreshold === undefined || event.lowStockThreshold === null || event.lowStockThreshold === ''
        ? null : num(event.lowStockThreshold);
      if (th !== null && th <= 0) { th = null; }
      var shelf = event.defaultShelfDays === undefined || event.defaultShelfDays === '' ? null : num(event.defaultShelfDays);

      // 重名 → 3002（name 全局唯一）
      return db.collection('material').where({ name: name }).limit(2).get().then(function (res) {
        var dup = (res.data || []).filter(function (d) { return d._id !== event._id; })[0];
        if (dup) { throw new R.BizError(C.CODE.DUPLICATE, '食材已存在：' + name); }

        if (event._id) {
          // 注意：update 的 data 绝不能带 _id（腾讯云直接拒）
          return db.collection('material').doc(event._id).update({
            data: { name: name, spec: spec, unit: unit, defaultShelfDays: shelf,
              lowStockThreshold: th }
          }).then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
              '编辑食材 ' + name, '',
              'spec=' + spec + ';unit=' + unit + ';threshold=' + th);
          }).then(function () { return { _id: event._id }; });
        }
        var doc = {
          name: name, spec: spec, unit: unit, defaultShelfDays: shelf,
          lowStockThreshold: th, isActive: true, createdAt: dbh.nowIso()
        };
        return db.collection('material').add({ data: doc }).then(function (r) {
          doc._id = r._id;
          return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
            '新增食材 ' + name, '',
            'spec=' + spec + ';unit=' + unit + ';threshold=' + th);
        }).then(function () { return doc; });
      });
    });
  }

  if (action === 'toggle') {
    return auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '未指定要操作的食材，请刷新页面后重试'); }
      return db.collection('material').doc(event._id).get().then(function (res) {
        if (!res.data) { throw new R.BizError(C.CODE.NOT_FOUND, '食材未找到'); }
        var to = event.isActive !== false;
        return db.collection('material').doc(event._id).update({ data: { isActive: to } })
          .then(function () {
            return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
              (to ? '启用' : '停用') + '食材 ' + res.data.name, '', 'isActive=' + to);
          }).then(function () { return { _id: event._id, isActive: to }; });
      });
    });
  }

  /* 删除食材档案（manager · 带引用检查）：
   *  · 被「菜品消耗 / 采购 / 领用 / 出品 / 盘点」任一引用 → 拦住（报人话，不暴露 itemId）；
   *  · stock_balance（库存余额）不算业务引用 —— 随档案一并清除，不拦截。 */
  if (action === 'remove') {
    return auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event).then(function (ctx) {
      if (!event._id) { throw new R.BizError(C.CODE.NEGATIVE, '未指定要操作的食材，请刷新页面后重试'); }
      var itemId = String(event._id);
      return db.collection('material').doc(itemId).get()
        .catch(function () { return { data: null }; })
        .then(function (res) {
          var mat = res.data;
          if (!mat) { throw new R.BizError(C.CODE.NOT_FOUND, '食材未找到'); }
          var name = mat.name || '';
          var unit = mat.unit || '';

          // 引用检查：5 处（点号路径命中数组内任意元素，count 判定是否被引用）
          return Promise.all([
            db.collection('dish').where({ 'consumeItems.itemId': itemId }).limit(3).get(),
            db.collection('dish').where({ 'consumeItems.itemId': itemId }).count(),
            db.collection('purchase').where({ itemId: itemId }).count(),
            db.collection('requisition').where({ 'items.itemId': itemId }).count(),
            db.collection('production').where({ 'consumeItems.itemId': itemId }).count(),
            db.collection('stocktake').where({ itemId: itemId }).count()
          ]).then(function (rs) {
            var dishRows = rs[0].data || [];
            var dishCount = rs[1].total || 0;
            var purchCount = rs[2].total || 0;
            var reqCount = rs[3].total || 0;
            var prodCount = rs[4].total || 0;
            var stkCount = rs[5].total || 0;

            var parts = [];
            if (dishCount) {
              var names = dishRows.map(function (d) { return d.name; }).filter(function (n) { return n; });
              var suffix = dishCount > names.length ? ' 等' : '';
              parts.push('被 ' + dishCount + ' 个菜品引用' +
                (names.length ? '（' + names.join('、') + suffix + '）' : ''));
            }
            if (purchCount) { parts.push('有 ' + purchCount + ' 条采购记录'); }
            if (reqCount) { parts.push('有 ' + reqCount + ' 条领用记录'); }
            if (prodCount) { parts.push('有 ' + prodCount + ' 条出品记录'); }
            if (stkCount) { parts.push('有 ' + stkCount + ' 条盘点记录'); }

            if (parts.length) {
              // 人话报错：含食材名，不含 itemId/_id
              // 2026-10-09 加「下架」引导：被引用删不掉是常态（有历史单据就永远有引用），
              // 老板要的是「不用了就别占位置」→ 直接告诉他还有下架这条路，别让他卡在删除上。
              throw new R.BizError(C.CODE.NEGATIVE,
                '「' + name + '」已被使用，不能删除：' + parts.join('、')
                + '。如不再使用，可在列表里点「下架」隐藏。');
            }

            // 无业务引用 → 事务内清掉该食材所有库存余额 + 删除档案（逐条 doc().remove，事务内串行）
            return dbh.withTx(db, function (t) {
              return t.collection('stock_balance').where({ itemId: itemId }).get().then(function (bres) {
                var rows = bres.data || [];
                return dbh.serial(rows.map(function (b) {
                  return function () { return t.collection('stock_balance').doc(b._id).remove(); };
                })).then(function () {
                  return t.collection('material').doc(itemId).remove().then(function () { return rows.length; });
                });
              });
            }).then(function (removedBalances) {
              return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
                '删除食材 ' + name, name + '（' + unit + '）',
                '清理库存余额 ' + removedBalances + ' 条')
                .then(function () { return { _id: itemId, removedBalances: removedBalances }; });
            });
          });
        });
    });
  }

  /* 库存精度巡检（manager 手动触发；存量残渣一次性归零，只改 qty 一个字段） */
  if (action === 'fixStockPrecision') {
    return auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event).then(function (ctx) {
      return stockfix.runFix(db).then(function (out) {
        if (!out.fixed || out.fixed.length === 0) { return out; }
        var detail = out.fixed.slice(0, 5).map(function (f) {
          return f.itemName + '(' + f.storeId + '/' + f.itemId + ') ' + f.before + '→' + f.after;
        }).join('，');
        return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
          '库存精度巡检', '扫描 ' + out.scanned + ' 条',
          '修正 ' + out.fixed.length + ' 条：' + detail)
          .then(function () { return out; });
      });
    });
  }

  // 用户侧只给固定人话；原始 action 值只进云开发日志（不外泄）
  console.error('[material] 未知 action：', action);
  throw new R.BizError(C.CODE.NEGATIVE, '操作不支持，请更新到最新版本');
});
