// ==========================================================================
// cloudfunctions/_shared/auth.js — 权限判定（ARCH v1.5 §4.4，与 WEB js/auth.js 逐条对齐）
// 所有云函数入口必须先 can() 校验，否则 1003。
// 身份解析（以账号为准，不绑微信）：客户端每次调用附带 _uid（登录时 login 返回的
// user._id），云函数按 _id 直查 user 文档并校验 isActive。
// ==========================================================================
var C = require('./constants');
var BizError = require('./response').BizError;

/** _uid → user 文档（不存在 / 已停用 / 未传 → null） */
function getUserById(db, uid) {
  if (!uid) { return Promise.resolve(null); }
  return db.collection('user').doc(String(uid)).get().then(function (res) {
    var u = res.data;
    if (!u || u.isActive === false) { return null; }
    return u;
  }).catch(function () { return null; });
}

/**
 * 动作 → 允许角色（23 动作 × 2 角色；哨兵 / 未实现动作一律 []）
 * 哨兵 USER_MANAGE / STORE_MANAGE 故意返回 []；未实现的 USER_DELETE 故意不列（见下方注释）。
 */
function actionToRequiredRoles(action) {
  switch (action) {
    case C.ACTION.USER_MANAGE:
    case C.ACTION.STORE_MANAGE:          return [];

    case C.ACTION.STORE_REGISTER:        return [C.ROLE.SHOP];
    case C.ACTION.STORE_RENAME:          return [C.ROLE.MANAGER];
    case C.ACTION.USER_RESET_PASSWORD:   return [C.ROLE.MANAGER];
    // v1.0.3 漏映射补齐（2026-10-08）：STORE_RESET_ALL_PASSWORD 加了常量、加了调用方、加了
    // 前端文案，却没进这个 switch → 落 default:[] → judge 里 effectiveRoles 恒空 → 恒 1003，
    // 「分店管理 → 改密」按钮线上 100% 无权限。性质与同组 STORE_RENAME/USER_RESET_PASSWORD 一致（管理端专属）。
    // ⚠️ USER_DELETE 故意不加：零调用方 + 老板 2026-09-15 拍板「不要了」，补映射等于伪装成已实现。
    case C.ACTION.STORE_RESET_ALL_PASSWORD: return [C.ROLE.MANAGER];
    case C.ACTION.STORE_TOGGLE:          return [C.ROLE.MANAGER];
    // 2026-10-09 老板拍板「门店有自己的预警阈值」：设置阈值是管理端专属（门店端只能看，不能改）
    case C.ACTION.STORE_SET_THRESHOLD:   return [C.ROLE.MANAGER];

    case C.ACTION.MATERIAL_UPDATE:
    case C.ACTION.DISH_UPDATE:           return [C.ROLE.MANAGER];
    case C.ACTION.PURCHASE_CREATE:       return [C.ROLE.MANAGER];
    case C.ACTION.REQUISITION_CONFIRM:
    case C.ACTION.REQUISITION_REJECT:
    // 2026-10-09 老板拍板：要货单处理把「驳回」改成「修改」——
    // 改数量 / 删行和确认、驳回一样是**管理端专属**（门店端只能撤回自己发起的单）。
    case C.ACTION.REQUISITION_ADJUST:    return [C.ROLE.MANAGER];
    // 2026-10-09 加：删除终态申请单（已驳回/已撤回）——终态单删除不碰库存，
    // 但删除记录本身是管理端专属，与确认/驳回/修改同一组。
    case C.ACTION.REQUISITION_DELETE:    return [C.ROLE.MANAGER];

    case C.ACTION.REQUISITION_CREATE:
    case C.ACTION.REQUISITION_CANCEL:
    case C.ACTION.STOCKTAKE_CREATE:      return [C.ROLE.SHOP];

    // v1.0.3 老板 2026-09-15 拍板：出品录入权限改管理端（门店详情→录入消耗 tab）
    // 现归管理端专属：门店端不再出品，改由管理端「门店详情→录入消耗」录入
    case C.ACTION.PRODUCTION_CREATE:
    case C.ACTION.PRODUCTION_REVERSE:     return [C.ROLE.MANAGER];

    case C.ACTION.INVENTORY_QUERY:
    case C.ACTION.REQUISITION_QUERY:
    case C.ACTION.OPLOG_QUERY:           return [C.ROLE.MANAGER, C.ROLE.SHOP];
    // 2026-10-09 加：库存校准是**管理端专属**（门店端只能看，不能改库存/阈值）。
    // 查校准记录走 INVENTORY_QUERY（两角色），列表本身不在此。
    case C.ACTION.INVENTORY_CALIBRATE:   return [C.ROLE.MANAGER];

    case C.ACTION.ALERT_VIEW:            return [C.ROLE.MANAGER];
    case C.ACTION.REPORT_BUSINESS:       return [C.ROLE.MANAGER];
    case C.ACTION.DATA_EXPORT:           return [C.ROLE.MANAGER];

    default:                             return [];
  }
}

/** 查门店营业状态（闭店拦截用） */
function storeStatusOf(db, storeId) {
  if (!storeId) { return Promise.resolve(null); }
  return db.collection('store').doc(storeId).get()
    .then(function (res) { return res.data ? (res.data.status || C.STORE_STATUS.OPEN) : null; })
    .catch(function () { return null; });
}

/**
 * 权限判定（双重拦截的安全底线）
 * @param {object} db          云数据库实例
 * @param {object|null} user   user 文档（role 单值 + storeId 单值）
 * @param {string} action      业务动词
 * @param {string|null} [storeId]
 * @returns {Promise<{allow, reason?, effectiveRoles, storeScope, requiredRoles}>}
 */
function can(db, user, action, storeId) {
  var required = actionToRequiredRoles(action);
  var base = { allow: false, reason: null, effectiveRoles: [], storeScope: null, requiredRoles: required };

  if (!user) { return Promise.resolve(Object.assign({}, base, { reason: 'NOT_LOGIN' })); }
  if (user.isActive === false) { return Promise.resolve(Object.assign({}, base, { reason: 'INACTIVE' })); }

  // ③ 闭店拦截：shop 且所属门店 closed → 一律拒（login 已拦入口，此处兜住存量会话）
  if (user.role === C.ROLE.SHOP && user.storeId) {
    return storeStatusOf(db, user.storeId).then(function (status) {
      if (status === C.STORE_STATUS.CLOSED) {
        return Object.assign({}, base, { reason: 'STORE_CLOSED' });
      }
      return judge(db, user, action, storeId, base);
    });
  }
  return Promise.resolve(judge(db, user, action, storeId, base));
}

function judge(db, user, action, storeId, base) {
  var roleArr = user.role ? [user.role] : [];
  var effectiveRoles = roleArr.filter(function (r) { return base.requiredRoles.indexOf(r) >= 0; });
  base.effectiveRoles = effectiveRoles;
  if (effectiveRoles.length === 0) {
    base.reason = 'NO_ROLE';
    return base;
  }
  if (!storeId) {
    base.allow = true;
    return base;
  }
  if (user.role === C.ROLE.SHOP) {
    if (user.storeId !== storeId) {
      base.reason = 'STORE_OUT_OF_SCOPE';
      return base;
    }
    base.allow = true;
    base.storeScope = storeId;
    return base;
  }
  // manager：总仓（WAREHOUSE）或全部
  base.allow = true;
  base.storeScope = storeId;
  return base;
}

/**
 * 入口守卫：按 event._uid 取当前用户 + can() 校验；失败抛 BizError（1001 / 1003）
 * @param {object} event   云函数入参（必须含 _uid，由前端 utils/cloud.js 自动附加）
 * @returns {Promise<{user, uid}>}
 */
function requireUser(db, action, storeId, event) {
  var uid = String((event && event._uid) || '');
  return getUserById(db, uid).then(function (user) {
    if (!user) {
      throw new BizError(C.CODE.UNAUTHORIZED, '未登录或登录已过期，请重新登录');
    }
    return can(db, user, action, storeId || null).then(function (r) {
      if (!r.allow) {
        if (r.reason === 'STORE_CLOSED') {
          throw new BizError(C.CODE.UNAUTHORIZED, '该门店已闭店，如需恢复请联系管理端');
        }
        // 只拼中文原因；查不到标签时不回退英文枚举，避免外泄
        var whyLabel = C.REASON_LABEL[r.reason] || '';
        throw new BizError(C.CODE.FORBIDDEN,
          C.CODE_MSG[1003] + (whyLabel ? '：' + whyLabel : ''));
      }
      return { user: user, uid: uid };
    });
  });
}

module.exports = {
  getUserById: getUserById,
  actionToRequiredRoles: actionToRequiredRoles,
  can: can,
  requireUser: requireUser
};
