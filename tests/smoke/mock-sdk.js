/* wx-server-sdk 模拟层（冒烟测试专用）：内存数据库 + _id 写入守卫 */
var store = {};
var seq = 0;

function clone(o) { return JSON.parse(JSON.stringify(o === undefined ? null : o)); }
function genId() { seq += 1; return 'gen_' + Date.now() + '_' + seq; }

function isRegexp(v) { return !!(v && v.__regexp); }
function isIn(v) { return !!(v && v.__in); }
function isGte(v) { return !!(v && typeof v === 'object' && '__gte' in v); }
function isLte(v) { return !!(v && typeof v === 'object' && '__lte' in v); }

function isAnd(v) { return !!(v && Array.isArray(v.__and)); }

/* 查询操作符工厂：结果对象带 .and()，可链式组合（对齐真实 SDK） */
function op(kind, val) {
  var marker = {};
  marker['__' + kind] = val;
  marker.and = function (other) { return { __and: [marker, other] }; };
  return marker;
}

function has(v, k) { return !!(v && typeof v === 'object' && ('__' + k) in v); }

/* 区间比较：真实云开发对 number 按数值比、对 string 按字典序比。
 * ★ 血泪坑（2026-09-19 修）：此前这里一律走 Number() 转换，而本项目的日期字段是
 *   'YYYY-MM-DD' 字符串 → Number('2026-09-19') = NaN → 任何 gte/lte 条件恒为 false。
 *   后果极隐蔽：本地桩件对「日期区间查询」**静默返回空集**，于是
 *   production.list / summary 的 from-to 区间在本地从来没被真正验证过（假绿）。
 *   'YYYY-MM-DD' 的字典序与时间序一致，故字符串按字典序比即与线上等价。 */
function cmpVal(actual, bound) {
  if (actual === null || actual === undefined) { return NaN; }   // 缺值不参与区间命中
  if (typeof actual === 'number' && typeof bound === 'number') { return actual - bound; }
  var a = String(actual), b = String(bound);
  return a < b ? -1 : (a > b ? 1 : 0);
}

/* 单个「实际值 vs 条件」匹配（条件可为 正则 / in / gte / lte / gt / lt / and / 字面量） */
function matchValue(actual, v) {
  if (isRegexp(v)) {
    var re = new RegExp(v.__regexp, v.__opts || '');
    return re.test(String(actual == null ? '' : actual));
  }
  if (isIn(v)) { return v.__in.indexOf(actual) >= 0; }
  var c;
  if (has(v, 'gte')) { c = cmpVal(actual, v.__gte); return !isNaN(c) && c >= 0; }
  if (has(v, 'lte')) { c = cmpVal(actual, v.__lte); return !isNaN(c) && c <= 0; }
  if (has(v, 'gt')) { c = cmpVal(actual, v.__gt); return !isNaN(c) && c > 0; }
  if (has(v, 'lt')) { c = cmpVal(actual, v.__lt); return !isNaN(c) && c < 0; }
  if (isAnd(v)) { return v.__and.every(function (sub) { return matchValue(actual, sub); }); }
  return actual === v;
}

/* 点号路径解析（WeChat 云数据库语义）：'consumeItems.itemId' 命中数组内**任意**元素。
 * node 为数组 → 逐元素继续解析；为对象 → 取 [parts[0]] 继续；其余（含缺值）→ 空集。
 * 例：{'consumeItems.itemId': id} 命中「consumeItems 数组里有任意一项 itemId===id」。
 * ★ 若把点号当成普通 key 处理（doc['consumeItems.itemId'] === undefined），查询会恒空 → 假绿。 */
function resolvePath(node, parts) {
  var out = [];
  if (parts.length === 0) { out.push(node); return out; }
  if (Array.isArray(node)) {
    node.forEach(function (el) {
      resolvePath(el, parts).forEach(function (x) { out.push(x); });
    });
    return out;
  }
  if (node && typeof node === 'object') {
    return resolvePath(node[parts[0]], parts.slice(1));
  }
  return out;
}

function matchCond(doc, cond) {
  if (!cond) { return true; }
  for (var k in cond) {
    if (!Object.prototype.hasOwnProperty.call(cond, k)) { continue; }
    var v = cond[k];
    // 点号路径（数组内元素匹配）：命中任一解析值即通过
    if (k.indexOf('.') >= 0) {
      var vals = resolvePath(doc, k.split('.'));
      if (!vals.some(function (actual) { return matchValue(actual, v); })) { return false; }
      continue;
    }
    var actual = doc ? doc[k] : undefined;
    if (isRegexp(v) || isIn(v) || isAnd(v) || has(v, 'gte') || has(v, 'lte') || has(v, 'gt') || has(v, 'lt')) {
      if (!matchValue(actual, v)) { return false; }
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // 对象型条件：递归比较（不再静默恒真，避免查询条件写错也测不出来）
      if (typeof actual !== 'object' || actual === null) { return false; }
      if (!matchCond(actual, v)) { return false; }
    } else {
      if (actual !== v) { return false; }
    }
  }
  return true;
}

function guard(name, data) {
  if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
    throw new Error('MOCK GUARD: _id 不允许出现在 ' + name + ' 的写入 data 里（腾讯云会拒）');
  }
}

/* 故障注入：模拟"某一次写入失败"（网络抖动 / 写冲突）。
 * 用途：验证"不半扣"——前一次 changeBalance 已成功、后一次抛错时，事务必须整体回滚。
 * 规则命中即消费（一次性），key 为 null 表示该集合任意 doc。 */
var failRules = [];
/* ==========================================================================
 * 「事务内 get 缺失文档」的报错文案 —— **可切换**（2026-10-08）
 * 起因：线上整单报「系统繁忙」，怀疑 db.changeBalance 里「文档不存在」的判定
 *   只认英文 `not exist` 一种形态、漏了真实云开发的文案 → 原样抛出。
 * 但真实云开发事务内 get 缺失文档的**官方文案至今查不到**（见报告），所以桩件必须能
 *   模拟「各种可能形态」，用来证明生产代码对文案形态不敏感 —— 而不是恰好匹配桩件自己的文案。
 * ⚠️ 默认文案保持原样（含 `not exist`），以免影响既有套件断言。
 * ========================================================================== */
var DEFAULT_MISSING_DOC_TEXT = 'document.get:fail document with _id {ID} does not exist';
var missingDoc = { text: DEFAULT_MISSING_DOC_TEXT, errCode: null };

/**
 * 构造「事务内 get 缺失文档」的错误。
 * @param {string} key  文档 _id
 * @param {{text?:string, errCode?:string|number|null}} [opt] 覆盖文案/错误码
 */
function missingDocError(key, opt) {
  var cfg = Object.assign({}, missingDoc, opt || {});
  var text = String(cfg.text === undefined || cfg.text === null ? DEFAULT_MISSING_DOC_TEXT : cfg.text)
    .replace('{ID}', key);
  var e = new Error(text);
  if (cfg.errCode !== null && cfg.errCode !== undefined && cfg.errCode !== '') {
    e.errCode = cfg.errCode;   // 真实云开发常带错误码；比英文文案更稳定
  }
  return e;
}

function maybeFail(name, key) {
  for (var i = 0; i < failRules.length; i++) {
    var r = failRules[i];
    if (r.coll === name && (r.key === null || r.key === String(key))) {
      failRules.splice(i, 1);
      throw new Error('MOCK INJECTED FAILURE: 写入 ' + name + '/' + key + ' 失败（模拟网络抖动或写冲突）');
    }
  }
}

function rowsOf(name) {
  if (!store[name]) { store[name] = {}; }
  return Object.keys(store[name]).map(function (k) { return store[name][k]; });
}

/**
 * 多键排序（2026-10-08 修）：真实云开发的链式 orderBy 是**累积**的 ——
 *   .orderBy('createdAt','desc').orderBy('_id','desc')
 * 表示「createdAt 降序，createdAt 相同时再按 _id 降序」。
 * ★ 此前桩件把排序键做成单值并**覆盖**，于是链式两个 orderBy 只剩最后一个 ——
 *   分页排序正确性变成假绿（同秒记录翻页会跳条/重条，桩件却看不出来）。
 * 比较规则逐键下钻：第 1 键相等才比第 2 键，与真实云开发一致。
 * ⚠️ 单键行为与旧实现逐字等价（对既有调用完全向后兼容）。
 */
function cmpByKeys(a, b, sortKeys) {
  for (var i = 0; i < sortKeys.length; i++) {
    var k = sortKeys[i];
    var x = a[k.field], y = b[k.field];
    if (x === y) { continue; }                 // 该键相等 → 交给下一个键裁决
    if ((x || '') < (y || '')) { return k.dir === 'desc' ? 1 : -1; }
    return k.dir === 'desc' ? -1 : 1;
  }
  return 0;
}
function sortByKeys(rows, sortKeys) {
  if (!sortKeys || sortKeys.length === 0) { return rows; }
  return rows.sort(function (a, b) { return cmpByKeys(a, b, sortKeys); });
}
function withKey(sortKeys, f, d) {
  return (sortKeys || []).concat([{ field: f, dir: d }]);   // 追加，不覆盖
}

function makeQuery(name, cond, sortKeys, limitN, skipN) {
  return {
    where: function (c) {
      return makeQuery(name, Object.assign({}, cond || {}, c || {}), sortKeys, limitN, skipN);
    },
    /* orderBy 累积：链式调用按调用顺序逐个追加排序键 */
    orderBy: function (f, d) { return makeQuery(name, cond, withKey(sortKeys, f, d), limitN, skipN); },
    /* skip 语义必须与真实云开发一致：先排序 → 再 skip → 最后 limit
     * （顺序写反会得到完全不同的分页结果，线上分页对不上就是这里出的错） */
    skip: function (n) { return makeQuery(name, cond, sortKeys, limitN, n); },
    limit: function (n) { return makeQuery(name, cond, sortKeys, n, skipN); },
    count: function () {
      var n = rowsOf(name).filter(function (d) { return matchCond(d, cond); }).length;
      return Promise.resolve({ total: n });
    },
    get: function () {
      var rows = rowsOf(name).filter(function (d) { return matchCond(d, cond); }).map(clone);
      rows = sortByKeys(rows, sortKeys);
      if (skipN) { rows = rows.slice(skipN); }
      if (limitN) { rows = rows.slice(0, limitN); }
      return Promise.resolve({ data: rows });
    },
    update: function (o) {
      guard(name + '.where.update', o && o.data);
      var n = 0;
      Object.keys(store[name]).forEach(function (k) {
        var d = store[name][k];
        if (matchCond(d, cond)) { store[name][k] = Object.assign({}, d, clone(o.data)); n += 1; }
      });
      return Promise.resolve({ stats: { updated: n } });
    },
    remove: function () {
      var n = 0;
      Object.keys(store[name]).forEach(function (k) {
        if (matchCond(store[name][k], cond)) { delete store[name][k]; n += 1; }
      });
      return Promise.resolve({ stats: { removed: n } });
    }
  };
}

function collection(name) {
  if (!store[name]) { store[name] = {}; }
  return {
    doc: function (id) {
      var key = String(id);
      return {
        get: function () {
          var d = store[name][key];
          return Promise.resolve({ data: d ? clone(d) : null });
        },
        set: function (o) {
          guard(name + '.doc.set', o && o.data);
          var data = clone(o.data);
          data._id = key;
          store[name][key] = data;
          return Promise.resolve({ _id: key });
        },
        update: function (o) {
          guard(name + '.doc.update', o && o.data);
          var cur = store[name][key];
          if (!cur) { return Promise.resolve({ stats: { updated: 0 } }); }
          store[name][key] = Object.assign({}, cur, clone(o.data));
          return Promise.resolve({ stats: { updated: 1 } });
        },
        remove: function () {
          delete store[name][key];
          return Promise.resolve({ stats: { removed: 1 } });
        }
      };
    },
    get: function () { return makeQuery(name, null).get(); },
    where: function (cond) { return makeQuery(name, cond); },
    orderBy: function (f, d) { return makeQuery(name, null, [{ field: f, dir: d }]); },
    skip: function (n) { return makeQuery(name, null, [], null, n); },
    limit: function (n) { return makeQuery(name, null, [], n); },
    count: function () { return Promise.resolve({ total: rowsOf(name).length }); },
    add: function (o) {
      var data = o && o.data;
      if (Array.isArray(data)) {
        var ids = data.map(function (d) {
          var id = d && d._id ? String(d._id) : genId();
          var copy = clone(d);
          copy._id = id;
          store[name][id] = copy;
          return id;
        });
        return Promise.resolve({ _ids: ids });
      }
      var id = data && data._id ? String(data._id) : genId();
      var copy = clone(data);
      copy._id = id;
      store[name][id] = copy;
      return Promise.resolve({ _id: id });
    }
  };
}

function database() {
  return {
    collection: collection,
    createCollection: function (name) {
      if (!store[name]) { store[name] = {}; }
      return Promise.resolve({});
    },
    /**
     * 事务：写入先落 staged 缓冲（读自己写的），commit 才并入 store，rollback 丢弃。
     * staged[name][key] = doc | TOMB（墓碑，表示删除）
     * 与旧实现的差别：查询（where/get/count）也走"store ⊕ staged"合并视图，
     * where().update()/remove() 也进缓冲，不再写穿 —— 否则回滚保证有缺口。
     */
    startTransaction: function () {
      var staged = {};
      var TOMB = { __tomb: true };
      function isTomb(v) { return !!(v && v.__tomb); }
      function stagedHas(name, key) {
        return !!(staged[name] && Object.prototype.hasOwnProperty.call(staged[name], key));
      }
      function stagedGet(name, key) {
        if (stagedHas(name, key)) {
          var v = staged[name][key];
          return isTomb(v) ? null : v;
        }
        return (store[name] && store[name][key]) ? store[name][key] : null;
      }
      /** 合并视图：store 覆盖 staged（墓碑=删除） */
      function mergedRows(name) {
        if (!store[name]) { store[name] = {}; }
        if (!staged[name]) { staged[name] = {}; }
        var out = [];
        Object.keys(store[name]).forEach(function (k) {
          var v = stagedHas(name, k) ? staged[name][k] : store[name][k];
          if (!isTomb(v)) { out.push(v); }
        });
        Object.keys(staged[name]).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(store[name], k)) {
            var v = staged[name][k];
            if (!isTomb(v)) { out.push(v); }
          }
        });
        return out;
      }
      function stage(name, key, doc) {
        maybeFail(name, key);
        if (!staged[name]) { staged[name] = {}; }
        staged[name][String(key)] = doc;
      }
      function sortRows(rows, sortKeys) { return sortByKeys(rows, sortKeys); }
      /** 事务内查询（合并视图） */
      function txQuery(name, cond, sortKeys, limitN, skipN) {
        return {
          where: function (c) { return txQuery(name, Object.assign({}, cond || {}, c || {}), sortKeys, limitN, skipN); },
          orderBy: function (f, d) { return txQuery(name, cond, withKey(sortKeys, f, d), limitN, skipN); },
          skip: function (n) { return txQuery(name, cond, sortKeys, limitN, n); },
          limit: function (n) { return txQuery(name, cond, sortKeys, n, skipN); },
          count: function () {
            return Promise.resolve({ total: mergedRows(name).filter(function (d) { return matchCond(d, cond); }).length });
          },
          get: function () {
            var rows = mergedRows(name).filter(function (d) { return matchCond(d, cond); }).map(clone);
            rows = sortRows(rows, sortKeys);
            if (skipN) { rows = rows.slice(skipN); }
            if (limitN) { rows = rows.slice(0, limitN); }
            return Promise.resolve({ data: rows });
          },
          update: function (o) {
            guard(name + '.tx.where.update', o && o.data);
            var n = 0;
            mergedRows(name).forEach(function (d) {
              if (matchCond(d, cond)) {
                stage(name, d._id, clone(Object.assign({}, d, o.data, { _id: d._id })));
                n += 1;
              }
            });
            return Promise.resolve({ stats: { updated: n } });
          },
          remove: function () {
            var n = 0;
            mergedRows(name).forEach(function (d) {
              if (matchCond(d, cond)) { stage(name, d._id, TOMB); n += 1; }
            });
            return Promise.resolve({ stats: { removed: n } });
          }
        };
      }
      var t = {
        collection: function (name) {
          if (!staged[name]) { staged[name] = {}; }
          return {
            doc: function (id) {
              var key = String(id);
              return {
                get: function () {
                  var d = stagedGet(name, key);
                  // 对齐真实云开发：事务内 get 不存在的文档直接抛错（2026-09-12 入库 5001 根因）
                  if (!d) {
                    return Promise.reject(missingDocError(key));
                  }
                  return Promise.resolve({ data: clone(d) });
                },
                set: function (o) {
                  guard(name + '.tx.doc.set', o && o.data);
                  stage(name, key, clone(Object.assign({}, o.data, { _id: key })));
                  return Promise.resolve({ _id: key });
                },
                update: function (o) {
                  guard(name + '.tx.doc.update', o && o.data);
                  var cur = stagedGet(name, key);
                  // 对齐真实云开发：文档不存在时 update 是 no-op，不凭空造文档
                  if (!cur) { return Promise.resolve({ stats: { updated: 0 } }); }
                  stage(name, key, clone(Object.assign({}, cur, o.data, { _id: key })));
                  return Promise.resolve({ stats: { updated: 1 } });
                },
                remove: function () {
                  var cur = stagedGet(name, key);
                  stage(name, key, TOMB);
                  return Promise.resolve({ stats: { removed: cur ? 1 : 0 } });
                }
              };
            },
            where: function (c) { return txQuery(name, c); },
            orderBy: function (f, d) { return txQuery(name, null, [{ field: f, dir: d }]); },
            limit: function (n) { return txQuery(name, null, [], n); },
            count: function () { return txQuery(name, null).count(); },
            get: function () { return txQuery(name, null).get(); },
            add: function (o) {
              var data = o && o.data;
              var id = data && data._id ? String(data._id) : genId();
              stage(name, id, clone(Object.assign({}, data, { _id: id })));
              return Promise.resolve({ _id: id });
            }
          };
        },
        commit: function () {
          Object.keys(staged).forEach(function (n) {
            if (!store[n]) { store[n] = {}; }
            Object.keys(staged[n]).forEach(function (k) {
              if (isTomb(staged[n][k])) { delete store[n][k]; }
              else { store[n][k] = staged[n][k]; }
            });
          });
          staged = {};
          return Promise.resolve({});
        },
        rollback: function () {
          staged = {};
          return Promise.resolve({});
        }
      };
      return Promise.resolve(t);
    },
    RegExp: function (o) { return { __regexp: o.regexp, __opts: o.options || '' }; },
    command: {
      in: function (arr) { return op('in', arr || []); },
      gte: function (n) { return op('gte', n); },
      lte: function (n) { return op('lte', n); },
      gt: function (n) { return op('gt', n); },
      lt: function (n) { return op('lt', n); },
      and: function (a, b) { return { __and: [a, b] }; }
    }
  };
}

module.exports = {
  init: function () { return {}; },
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  getWXContext: function () {
    return { OPENID: 'mock_openid', APPID: 'mock_appid', UNIONID: 'mock_unionid' };
  },
  database: database,
  __mock: {
    seed: function (name, docs) {
      if (!store[name]) { store[name] = {}; }
      docs.forEach(function (d) { store[name][String(d._id)] = clone(d); });
    },
    dump: function (name) { return rowsOf(name).map(clone); },
    reset: function () { store = {}; failRules = []; },
    /** 让下一次对 coll/key 的"事务内写入"抛错（一次性） */
    failWrite: function (coll, key) { failRules.push({ coll: coll, key: key === undefined ? null : String(key) }); },
    clearFail: function () { failRules = []; },
    failRuleCount: function () { return failRules.length; },
    /**
     * 切换「事务内 get 缺失文档」的报错文案（默认保持含 `not exist` 的原文不变）。
     * 用来证明生产代码对文案形态不敏感 —— 见文件头注释。
     * @param {string|null} text      文案，null = 恢复默认；支持 {ID} 占位符
     * @param {string|number|null} [errCode] 附加错误码（模拟真实云开发）
     */
    setMissingDocMessage: function (text, errCode) {
      missingDoc.text = (text === null || text === undefined) ? DEFAULT_MISSING_DOC_TEXT : String(text);
      missingDoc.errCode = (errCode === undefined) ? null : errCode;
      return missingDoc.text;
    },
    getMissingDocMessage: function () { return missingDoc.text; }
  }
};
