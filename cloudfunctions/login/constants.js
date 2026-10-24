// ==========================================================================
// cloudfunctions/_shared/constants.js — 共享常量（与 PRD v0.9.1 / ARCH v1.5 §7.6 逐字对齐）
// 角色仅 2 类；无 ACCOUNT_TYPE / OWNER_WRITE_FORBIDDEN / UNIT / UNIT_LABEL / SHIP_STATUS。
// ==========================================================================
var ROLE = { MANAGER: 'manager', SHOP: 'shop' };

var ACTION = {
  USER_MANAGE: 'user.manage',
  STORE_MANAGE: 'store.manage',
  STORE_REGISTER: 'store.register',
  STORE_RENAME: 'store.rename',
  USER_RESET_PASSWORD: 'user.resetPassword',
  USER_DELETE: 'user.delete',          // v1.0.3 老板 2026-09-15 10:21 拍板加：删除门店账号
  STORE_RESET_ALL_PASSWORD: 'store.resetAllPassword',  // v1.0.3 加：批量重置该店所有账号
  STORE_TOGGLE: 'store.toggle',
  STORE_SET_THRESHOLD: 'store.setThreshold',  // 2026-10-09 加：门店级库存预警阈值（每店一个统一值）
  MATERIAL_UPDATE: 'material.update',
  DISH_UPDATE: 'dish.update',
  PURCHASE_CREATE: 'purchase.create',
  REQUISITION_CREATE: 'requisition.create',
  REQUISITION_CONFIRM: 'requisition.confirm',
  REQUISITION_REJECT: 'requisition.reject',
  REQUISITION_CANCEL: 'requisition.cancel',
  REQUISITION_ADJUST: 'requisition.adjust',  // 2026-10-09 加：管理端改要货单明细（改数量 / 删行），替代「驳回」
  REQUISITION_DELETE: 'requisition.delete',  // 2026-10-09 加：管理端删除终态申请单（已驳回/已撤回），凑齐五件套
  PRODUCTION_CREATE: 'production.create',
  PRODUCTION_REVERSE: 'production.reverse',
  STOCKTAKE_CREATE: 'stocktake.create',
  INVENTORY_QUERY: 'inventory.query',
  INVENTORY_CALIBRATE: 'inventory.calibrate',  // 2026-10-09 加：库存校准（覆盖式更正数量 + 食材单独阈值）
  REQUISITION_QUERY: 'requisition.query',
  ALERT_VIEW: 'alert.view',
  REPORT_BUSINESS: 'report.business',
  OPLOG_QUERY: 'opLog.query',
  DATA_EXPORT: 'data.export'
};

var REQ_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', REJECTED: 'rejected', CANCELLED: 'cancelled' };
var REQ_STATUS_LABEL = { pending: '待处理', confirmed: '已确认', rejected: '已驳回', cancelled: '已撤回' };

var PROD_STATUS = { CONFIRMED: 'confirmed', REVERSED: 'reversed' };
var PROD_STATUS_LABEL = { confirmed: '已出品', reversed: '已撤回' };

var DIFF_TYPE = { NONE: 'none', SHORT: 'short', OVER: 'over' };
var DIFF_TYPE_LABEL = { none: '无差异', short: '短缺', over: '盈余' };

var STORE_STATUS = { OPEN: 'open', CLOSED: 'closed' };
var STORE_STATUS_LABEL = { open: '营业中', closed: '已闭店' };

/** 虚拟总仓分区键（非 store 文档，仅作 stock_balance / purchase 维度） */
var STORE_WAREHOUSE = 'WAREHOUSE';

var CONFIG = {
  LOW_STOCK_THRESHOLD: 2,
  BUSINESS_DAY_CUTOFF_HOUR: 4
};

var CODE = {
  OK: 0,
  UNAUTHORIZED: 1001,
  CROSS_DAY: 1002,
  FORBIDDEN: 1003,
  NO_STOCK: 2001,
  NEGATIVE: 2002,
  NOT_FOUND: 3001,
  DUPLICATE: 3002,
  SYSTEM: 5001
};

var CODE_MSG = {
  0: 'ok',
  1001: '未授权：未注册、密码错误或所属门店已闭店',
  1002: '跨日禁止撤回（仅当日营业日内的出品可撤回）',
  1003: '无权限执行该操作',
  2001: '库存不足',
  2002: '业务校验未通过',
  3001: '数据未找到',
  3002: '名称或账号已存在',
  5001: '系统内部错误'
};

// 拒绝原因 → 纯中文文案（键不变，仅用于 auth.js 展示给用户，不外泄英文枚举）
var REASON_LABEL = {
  NOT_LOGIN: '未登录或未注册',
  INACTIVE: '账号已停用',
  NO_ROLE: '角色不匹配',
  STORE_OUT_OF_SCOPE: '非本店数据',
  STORE_CLOSED: '所属门店已闭店'
};

var COLLECTIONS = ['user', 'store', 'material', 'dish', 'purchase', 'requisition', 'production', 'stocktake', 'stock_balance', 'op_log'];

module.exports = {
  ROLE: ROLE,
  ACTION: ACTION,
  REQ_STATUS: REQ_STATUS,
  REQ_STATUS_LABEL: REQ_STATUS_LABEL,
  PROD_STATUS: PROD_STATUS,
  PROD_STATUS_LABEL: PROD_STATUS_LABEL,
  DIFF_TYPE: DIFF_TYPE,
  DIFF_TYPE_LABEL: DIFF_TYPE_LABEL,
  STORE_STATUS: STORE_STATUS,
  STORE_STATUS_LABEL: STORE_STATUS_LABEL,
  STORE_WAREHOUSE: STORE_WAREHOUSE,
  CONFIG: CONFIG,
  CODE: CODE,
  CODE_MSG: CODE_MSG,
  REASON_LABEL: REASON_LABEL,
  COLLECTIONS: COLLECTIONS
};
