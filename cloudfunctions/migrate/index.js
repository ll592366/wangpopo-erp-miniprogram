// ==========================================================================
// cloudfunctions/migrate — 食材换算口径一次性迁移（老：换算在菜品 → 新：换算在档案）
//
// ⚠️⚠️ 备而不用（DO NOT DEPLOY）⚠️⚠️
//   老板 2026-09-19 拍板：「换算仍写在菜品里，档案不加换算字段」→ 本函数
//   **备而不用，不要部署**，保留代码仅供日后若重新上移口径时参考。
//   material.save 不写 portionsPerUnit、production.create 不读 portionsPerUnit，
//   故本迁移即使 dry 也是对着「不会被新口径消费的字段」做体检。
//
// action: dry   （只读体检，绝不写任何数据）
//         apply （真正写入：material.portionsPerUnit + dish.consumeItems[i].qty）
// 权限：仅 manager（auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event)）
//
// 老口径：菜品 ci = { itemId, qty, unit, portions }，语义「qty 个单位做 portions 份」
//         → 每份用量 U = qty / (portions || 1)（库存单位）
// 新口径：食材档案 portionsPerUnit = P = 1 个库存单位做几份
//         → 每份用量 = ci.qty / P；故迁移后把 ci.qty 改成 newQty = U * P 即可保持
//           newQty / P === U（扣减结果与迁移前完全等价）
//
// ⚠️ 线上数据有冲突，**不许瞎迁**：
//   · 同一 itemId 下出现不同 U，或菜品 unit 与档案 unit 不一致，或档案不存在 → 记为冲突；
//   · 冲突项在 dry 报告里列全，apply 时**默认跳过**（不自动猜），只有老板用
//     overrides: { "<itemId>": P } 明确裁决后才写入；
//   · apply 写入前先自检：每条菜品 |newQty / P − U| ≤ 0.0001，有一条不过就整批中止
//     （绝不写半截数据）；
//   · apply 前后各写一条 op_log 留痕。
//
// 返回（dry）：
//   { summary: { dishCount, itemCount, conflictCount },
//     conflicts: [{ itemId, name, unit, reasons: [...], rates: [...] }],
//     plan: [{ itemId, name, unit, portionsPerUnit, dishes: [{ dishId, dishName, oldQty, oldPortions, newQty }] }] }
// 返回（apply）：
//   { updatedMaterials, updatedDishes, skipped: [{ itemId, reason }],
//     checks: { checked, passed }, aborted: false, failures: [] }
//   自检不过时：{ aborted: true, reason: 'selfcheck_failed', failures: [...], ... }（未写任何数据）
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var auth = require('./auth');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

var PAGE_SIZE = 100;      // 每页读取条数
var MAX_ROWS = 3000;      // 最多读取条数（超出标 truncated）
var IN_CHUNK = 50;        // in 查询分批大小
var TOL = 0.0001;         // 自检容差（题目指定）

function num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}
function round4(v) { return Math.round(Number(v) * 10000) / 10000; }
function round6(v) { return Math.round(Number(v) * 1000000) / 1000000; }
function rateKey(u) { return round6(u).toFixed(6); }                 // U 归一化键（避免浮点噪声）
function portionsOf(ci) {
  var p = Number(ci.portions);
  return isFinite(p) && p > 0 ? p : 1;                              // 缺省 = 该行 qty 即每份用量
}
/** 老口径每份用量 U（库存单位） */
function unitPerPortion(ci) { return num(ci.qty) / portionsOf(ci); }

/**
 * 分页读取一个集合（真实云开发走 skip 分页；桩件无 skip 时退化单页读取）
 * @param {string} collName
 * @returns {Promise<{rows:Array, truncated:boolean}>}
 */
function loadAll(collName) {
  var rows = [];
  var truncated = false;
  var driver = db.collection(collName);
  var useSkip = typeof driver.skip === 'function';
  var pageSize = useSkip ? PAGE_SIZE : MAX_ROWS;
  if (!useSkip) { console.warn('[migrate] 驱动无 skip()，退化为单页读取 limit=' + pageSize); }

  function next(skip) {
    if (rows.length >= MAX_ROWS) { truncated = true; return Promise.resolve(); }
    var p = useSkip ? driver.skip(skip).limit(pageSize).get() : driver.limit(pageSize).get();
    return p.then(function (res) {
      var batch = (res && res.data) || [];
      if (batch.length === 0) { return null; }
      rows = rows.concat(batch);
      if (rows.length > MAX_ROWS) { rows = rows.slice(0, MAX_ROWS); truncated = true; return null; }
      if (!useSkip) { if (batch.length >= pageSize) { truncated = true; } return null; }
      if (batch.length < pageSize) { return null; }
      return next(skip + pageSize);
    });
  }
  return next(0).then(function () { return { rows: rows, truncated: truncated }; });
}

/** 涉案食材档案（分批 in；禁止 N+1） */
function loadMaterials(itemIds) {
  if (itemIds.length === 0) { return Promise.resolve({}); }
  var chunks = [];
  for (var i = 0; i < itemIds.length; i += IN_CHUNK) { chunks.push(itemIds.slice(i, i + IN_CHUNK)); }
  var map = {};
  return dbh.serial(chunks.map(function (chunk) {
    return function () {
      return db.collection('material').where({ _id: db.command.in(chunk) }).limit(chunk.length).get()
        .then(function (res) {
          ((res && res.data) || []).forEach(function (m) { map[String(m._id)] = m; });
          return null;
        });
    };
  })).then(function () { return map; });
}

/**
 * 体检并生成迁移计划（纯计算，不写库）
 * @param {Array} dishes
 * @param {object} mats  itemId → material 文档
 * @param {object} overrides { itemId: P }
 */
function buildPlan(dishes, mats, overrides) {
  var entries = [];   // 逐条菜品消耗项
  dishes.forEach(function (dish) {
    var cis = Array.isArray(dish.consumeItems) ? dish.consumeItems : [];
    cis.forEach(function (ci, idx) {
      if (!ci || !ci.itemId) { return; }
      var itemId = String(ci.itemId);
      entries.push({
        dishId: String(dish._id), dishName: dish.name || String(dish._id),
        index: idx, itemId: itemId,
        oldQty: num(ci.qty), oldPortions: (ci.portions === undefined ? null : ci.portions),
        oldUnit: ci.unit === undefined ? '' : String(ci.unit),
        U: unitPerPortion(ci)
      });
    });
  });

  // 按 itemId 分组
  var groups = {};
  var order = [];
  entries.forEach(function (e) {
    if (!groups[e.itemId]) { groups[e.itemId] = []; order.push(e.itemId); }
    groups[e.itemId].push(e);
  });

  var plan = [];
  var conflicts = [];
  var skipped = [];

  order.forEach(function (itemId) {
    var g = groups[itemId];
    var mat = mats[itemId] || null;
    var matUnit = mat ? String(mat.unit || '') : '';
    var reasons = [];

    // ① 速率分布：同一 itemId 下不同 U → 冲突
    var rates = {};
    var rateOrder = [];
    g.forEach(function (e) {
      var k = rateKey(e.U);
      if (!rates[k]) {
        // U 展示用 6 位小数归一（避免浮点噪声），但建议值必须用**原始 U** 求倒数
        rates[k] = { U: round6(e.U), raw: e.U, count: 0, dishes: [] };
        rateOrder.push(k);
      }
      rates[k].count += 1;
      rates[k].dishes.push({ dishId: e.dishId, dishName: e.dishName });
    });
    var rateList = rateOrder.map(function (k) { return rates[k]; });
    if (rateList.length > 1) { reasons.push('mixed_rate'); }

    // ② 单位与档案不一致 → 冲突
    var unitMismatch = mat && matUnit && g.some(function (e) { return e.oldUnit && e.oldUnit !== matUnit; });
    if (unitMismatch) { reasons.push('unit_mismatch'); }

    // ③ 档案不存在 → 冲突（无处写 portionsPerUnit，且没有旧单位可校）
    if (!mat) { reasons.push('no_material'); }

    // 建议值：出现次数最多的 U（并列取先出现的）→ P = 1 / U
    // 注意：用原始 U 求倒数（若用 6 位小数归一后的 U，1/0.333333 会算成 3.000003）
    var major = rateList[0];
    rateList.forEach(function (r) { if (r.count > major.count) { major = r; } });
    var suggested = round6(1 / major.raw);

    // overrides 只接受有限正数
    var ov = overrides[itemId];
    var hasOverride = overridesHas(overrides, itemId) && isFinite(Number(ov)) && Number(ov) > 0;
    var P = hasOverride ? round6(Number(ov)) : suggested;

    var item = {
      itemId: itemId,
      name: (mat && mat.name) || itemId,
      unit: matUnit || (g[0] ? g[0].oldUnit : ''),
      portionsPerUnit: P,
      suggested: suggested,
      overridden: hasOverride,
      conflict: reasons.length > 0,
      reasons: reasons,
      rates: rateList,
      dishes: g.map(function (e) {
        return {
          _e: e,                                   // 源条目引用（自检用；dry 报告里会被剥掉）
          dishId: e.dishId, dishName: e.dishName,
          oldQty: e.oldQty, oldPortions: e.oldPortions, oldUnit: e.oldUnit,
          newQty: round4(e.U * P)
        };
      })
    };
    plan.push(item);

    if (reasons.length > 0) {
      conflicts.push({
        itemId: itemId, name: item.name, unit: item.unit, reasons: reasons,
        rates: rateList, suggestedPortionsPerUnit: suggested
      });
    }
    // 冲突项必须由老板裁决（overrides）后才迁移；no_material 连可写的地方都没有 → 一律跳过
    var adjudicated = hasOverride && reasons.indexOf('no_material') < 0;
    if (reasons.length > 0 && !adjudicated) {
      skipped.push({ itemId: itemId, reason: reasons.join('+') });
    }
  });

  return {
    entries: entries, plan: plan, conflicts: conflicts, skipped: skipped,
    dishCount: dishes.length, itemCount: order.length
  };
}

function overridesHas(overrides, key) {
  return !!overrides && Object.prototype.hasOwnProperty.call(overrides, key);
}

/** dry：只读体检报告 */
function asDryReport(built, loaded) {
  return {
    summary: {
      dishCount: built.dishCount,
      itemCount: built.itemCount,
      conflictCount: built.conflicts.length
    },
    conflicts: built.conflicts,
    plan: built.plan.map(function (p) {
      return {
        itemId: p.itemId, name: p.name, unit: p.unit,
        portionsPerUnit: p.portionsPerUnit,
        dishes: p.dishes.map(function (d) {
          return {
            dishId: d.dishId, dishName: d.dishName,
            oldQty: d.oldQty, oldPortions: d.oldPortions, newQty: d.newQty
          };
        })
      };
    }),
    willSkip: built.skipped,
    truncated: !!loaded.dishTruncated,
    note: 'dry 模式：只读体检，未写入任何数据。冲突项需老板用 overrides 裁决后才会迁移。'
  };
}

/** apply：先自检，再写入（先食材档案，后菜品） */
function runApply(built, ctx) {
  var skippedIds = {};
  built.skipped.forEach(function (s) { skippedIds[s.itemId] = s.reason; });

  var todo = built.plan.filter(function (p) { return !skippedIds[p.itemId]; });

  // ---- 写入前自检：|newQty / P − U| ≤ TOL（一条不过 → 整批中止，绝不写半截） ----
  var failures = [];
  var checked = 0;
  var writeMap = {};   // itemId → 计划项
  todo.forEach(function (p) {
    if (!(isFinite(p.portionsPerUnit) && p.portionsPerUnit > 0)) {
      failures.push({ itemId: p.itemId, dishId: '', reason: 'bad_P', portionsPerUnit: p.portionsPerUnit });
      return;
    }
    p.dishes.forEach(function (d) {
      var U = d._e ? d._e.U : (num(d.oldQty) / portionsOf({ portions: d.oldPortions }));
      var back = d.newQty / p.portionsPerUnit;
      checked += 1;
      if (Math.abs(back - U) > TOL) {
        failures.push({
          itemId: p.itemId, dishId: d.dishId,
          oldQty: d.oldQty, oldPortions: d.oldPortions, newQty: d.newQty,
          portionsPerUnit: p.portionsPerUnit, expected: U, actual: back, reason: 'rate_drift'
        });
      }
    });
    writeMap[p.itemId] = p;
  });

  if (failures.length > 0) {
    return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
      '食材换算口径迁移（apply）中止', '', '自检未通过 ' + failures.length + ' 条，未写入任何数据')
      .then(function () {
        return {
          aborted: true, reason: 'selfcheck_failed', failures: failures,
          checks: { checked: checked, passed: 0 },
          updatedMaterials: 0, updatedDishes: 0,
          skipped: built.skipped.map(function (s) { return { itemId: s.itemId, reason: s.reason }; })
        };
      });
  }

  var itemIds = Object.keys(writeMap);
  var updatedMaterials = 0;
  var updatedDishes = 0;

  // ---- 前置留痕 ----
  return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
    '食材换算口径迁移（apply）开始',
    '菜品 ' + built.dishCount + ' 道 / 涉案食材 ' + built.itemCount + ' 个',
    '待写入：食材 ' + itemIds.length + ' 个；跳过（冲突未裁决）' + built.skipped.length + ' 个')
    .then(function () {
      // ---- ① 写食材档案 portionsPerUnit（只写这一个字段） ----
      return dbh.serial(itemIds.map(function (itemId) {
        return function () {
          return db.collection('material').doc(itemId).update({
            data: { portionsPerUnit: writeMap[itemId].portionsPerUnit }
          }).then(function () { updatedMaterials += 1; });
        };
      }));
    }).then(function () {
      // ---- ② 回写菜品：consumeItems[i].qty = newQty、portions 置空 ----
      var byDish = {};
      built.entries.forEach(function (e) {
        if (skippedIds[e.itemId]) { return; }
        if (!byDish[e.dishId]) { byDish[e.dishId] = []; }
        byDish[e.dishId].push(e);
      });
      var dishIds = Object.keys(byDish);
      return dbh.serial(dishIds.map(function (dishId) {
        return function () {
          return db.collection('dish').doc(dishId).get().then(function (res) {
            var dish = res && res.data;
            if (!dish) { return null; }
            var cis = Array.isArray(dish.consumeItems) ? dish.consumeItems.slice() : [];
            byDish[dishId].forEach(function (e) {
              var ci = cis[e.index];
              if (!ci) { return; }
              ci.qty = round4(e.U * writeMap[e.itemId].portionsPerUnit);
              ci.portions = null;   // 老口径字段置空（换算已上移到档案）
              cis[e.index] = ci;
            });
            // 注意：update 的 data 绝不能带 _id（consumeItems 数组元素本身无 _id）
            return db.collection('dish').doc(dishId).update({ data: { consumeItems: cis } })
              .then(function () { updatedDishes += 1; });
          });
        };
      }));
    }).then(function () {
      // ---- 后置留痕 ----
      return dbh.log(db, ctx.user._id, ctx.user.name, C.ACTION.MATERIAL_UPDATE,
        '食材换算口径迁移（apply）完成',
        '菜品 ' + built.dishCount + ' 道',
        '已写：食材 ' + updatedMaterials + ' 个 / 菜品 ' + updatedDishes + ' 道；自检通过 ' + checked + ' 条')
        .then(function () {
          return {
            aborted: false,
            updatedMaterials: updatedMaterials,
            updatedDishes: updatedDishes,
            skipped: built.skipped.map(function (s) { return { itemId: s.itemId, reason: s.reason }; }),
            checks: { checked: checked, passed: checked },
            failures: []
          };
        });
    });
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'dry');
  if (action !== 'dry' && action !== 'apply') {
    throw new R.BizError(C.CODE.NEGATIVE, '未知 action：' + action + '（仅支持 dry / apply）');
  }
  return auth.requireUser(db, C.ACTION.MATERIAL_UPDATE, null, event).then(function (ctx) {
    return loadAll('dish').then(function (loaded) {
      var entries = [];
      (loaded.rows || []).forEach(function (dish) {
        var cis = Array.isArray(dish.consumeItems) ? dish.consumeItems : [];
        cis.forEach(function (ci) { if (ci && ci.itemId) { entries.push(String(ci.itemId)); } });
      });
      var ids = [];
      entries.forEach(function (id) { if (ids.indexOf(id) < 0) { ids.push(id); } });
      return loadMaterials(ids).then(function (mats) {
        var built = buildPlan(loaded.rows || [], mats, event.overrides || {});
        if (action === 'dry') {
          var rep = asDryReport(built, { dishTruncated: loaded.truncated });
          return rep;
        }
        return runApply(built, ctx);
      });
    });
  });
});
