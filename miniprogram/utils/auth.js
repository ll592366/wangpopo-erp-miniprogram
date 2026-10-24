// ==========================================================================
// utils/auth.js — 前端 UI 侧权限镜像（仅用于隐藏入口，非安全；与
// cloudfunctions/_shared/auth.js 逐条对齐，安全底线在云函数 can()）
// ==========================================================================
var C = require('./constants');

/**
 * 动作 → 允许角色（22 动作 × 2 角色，逐字对齐 ARCH v1.5 §4.4）
 * 哨兵 user.manage / store.manage 返回 []；未知动作默认 []。
 */
function actionToRequiredRoles(action) {
  switch (action) {
    case C.ACTION.USER_MANAGE:
    case C.ACTION.STORE_MANAGE:          return [];

    case C.ACTION.STORE_REGISTER:        return [C.ROLE.SHOP];
    case C.ACTION.STORE_RENAME:          return [C.ROLE.MANAGER];
    case C.ACTION.USER_RESET_PASSWORD:   return [C.ROLE.MANAGER];
    case C.ACTION.STORE_TOGGLE:          return [C.ROLE.MANAGER];

    case C.ACTION.MATERIAL_UPDATE:
    case C.ACTION.DISH_UPDATE:           return [C.ROLE.MANAGER];
    case C.ACTION.PURCHASE_CREATE:       return [C.ROLE.MANAGER];
    case C.ACTION.REQUISITION_CONFIRM:
    case C.ACTION.REQUISITION_REJECT:    return [C.ROLE.MANAGER];

    case C.ACTION.REQUISITION_CREATE:
    case C.ACTION.REQUISITION_CANCEL:
    case C.ACTION.PRODUCTION_CREATE:
    case C.ACTION.PRODUCTION_REVERSE:
    case C.ACTION.STOCKTAKE_CREATE:      return [C.ROLE.SHOP];

    case C.ACTION.INVENTORY_QUERY:
    case C.ACTION.REQUISITION_QUERY:
    case C.ACTION.OPLOG_QUERY:           return [C.ROLE.MANAGER, C.ROLE.SHOP];

    case C.ACTION.ALERT_VIEW:            return [C.ROLE.MANAGER];
    case C.ACTION.REPORT_BUSINESS:       return [C.ROLE.MANAGER];
    case C.ACTION.DATA_EXPORT:           return [C.ROLE.MANAGER];

    default:                             return [];
  }
}

/**
 * UI 侧判定（无 storeStatusOf 查库能力，闭店兜底由云函数负责）
 * @param {{role:string, storeId:string|null}} user
 * @param {string} action
 * @param {string|null} [storeId]
 * @returns {boolean}
 */
function can(user, action, storeId) {
  if (!user || !user.role) { return false; }
  var required = actionToRequiredRoles(action);
  if (required.indexOf(user.role) < 0) { return false; }
  if (storeId && user.role === C.ROLE.SHOP && user.storeId !== storeId) { return false; }
  return true;
}

/** 角色 UI 文案 */
function roleLabel(role) {
  return C.ROLE_LABEL[role] || role || '—';
}

module.exports = {
  actionToRequiredRoles: actionToRequiredRoles,
  can: can,
  roleLabel: roleLabel
};
