// ==========================================================================
// utils/constants.js — 前端常量（与 cloudfunctions/_shared/constants.js、
// wechat-erp-web/js/constants.js 逐字对齐；唯一权威 PRD v0.9.1 §3.2 / ARCH v1.5 §7.6）
// 注意：无 ACCOUNT_TYPE / OWNER_WRITE_FORBIDDEN / UNIT / UNIT_LABEL / SHIP_STATUS。
// ==========================================================================
var ROLE = { MANAGER: 'manager', SHOP: 'shop' };

var ROLE_LABEL = { manager: '管理端', shop: '门店端' };

/** 22 个业务动作（含 2 个哨兵 user.manage / store.manage，两列均 ❌） */
var ACTION = {
  USER_MANAGE: 'user.manage',
  STORE_MANAGE: 'store.manage',
  STORE_REGISTER: 'store.register',
  STORE_RENAME: 'store.rename',
  USER_RESET_PASSWORD: 'user.resetPassword',
  STORE_TOGGLE: 'store.toggle',
  MATERIAL_UPDATE: 'material.update',
  DISH_UPDATE: 'dish.update',
  PURCHASE_CREATE: 'purchase.create',
  REQUISITION_CREATE: 'requisition.create',
  REQUISITION_CONFIRM: 'requisition.confirm',
  REQUISITION_REJECT: 'requisition.reject',
  REQUISITION_CANCEL: 'requisition.cancel',
  REQUISITION_DELETE: 'requisition.delete',
  PRODUCTION_CREATE: 'production.create',
  PRODUCTION_REVERSE: 'production.reverse',
  STOCKTAKE_CREATE: 'stocktake.create',
  INVENTORY_QUERY: 'inventory.query',
  REQUISITION_QUERY: 'requisition.query',
  ALERT_VIEW: 'alert.view',
  REPORT_BUSINESS: 'report.business',
  OPLOG_QUERY: 'opLog.query',
  DATA_EXPORT: 'data.export'
};

// 动作 → 中文标签（供操作日志展示；键必须与 dbh.log() 里实际写入的 action 串逐字一致）
var ACTION_LABEL = {
  'user.manage': '账号管理（哨兵）',
  'store.manage': '门店管理（哨兵）',
  'store.register': '注册开店',
  'store.rename': '分店改名',
  'store.toggle': '门店启停（闭店/复业）',
  'store.resetAllPassword': '批量重置门店账号密码',
  'user.resetPassword': '分店账号改密',
  'user.delete': '删除门店账号',
  'material.update': '食材档案维护',
  'dish.update': '菜品档案维护',
  'purchase.create': '采购入库',
  'requisition.create': '食材申请发起',
  'requisition.confirm': '食材申请确认',
  'requisition.reject': '食材申请驳回',
  'requisition.cancel': '食材申请撤回',
  'requisition.delete': '删除申请单',
  'production.create': '今日出品上传',
  'production.reverse': '出品撤回',
  'stocktake.create': '剩余实点',
  'store.setThreshold': '门店预警阈值',
  'inventory.query': '库存查询',
  'inventory.adjust': '库存调整',
  'inventory.calibrate': '库存校准',
  'requisition.query': '申请查询',
  'alert.view': '食材预警',
  'report.business': '分店经营',
  'opLog.query': '操作日志',
  'data.export': '数据导出'
};

var REQ_STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', REJECTED: 'rejected', CANCELLED: 'cancelled' };
var REQ_STATUS_LABEL = { pending: '待处理', confirmed: '已确认', rejected: '已驳回', cancelled: '已撤回' };

var PROD_STATUS = { CONFIRMED: 'confirmed', REVERSED: 'reversed' };
var PROD_STATUS_LABEL = { confirmed: '已出品', reversed: '已撤回' };

var DIFF_TYPE = { NONE: 'none', SHORT: 'short', OVER: 'over' };
var DIFF_TYPE_LABEL = { none: '无差异', short: '短缺', over: '盈余' };

var STORE_STATUS = { OPEN: 'open', CLOSED: 'closed' };
var STORE_STATUS_LABEL = { open: '营业中', closed: '已闭店' };

/** 虚拟总仓分区键（非 store 文档） */
var STORE_WAREHOUSE = 'WAREHOUSE';

var CONFIG = {
  /** 食材低库存全局默认阈值（总仓维度） */
  LOW_STOCK_THRESHOLD: 2,
  /** 营业日切分时刻（凌晨 4 点） */
  BUSINESS_DAY_CUTOFF_HOUR: 4
};

var CODE = {
  OK: 0,
  UNAUTHORIZED: 1001,   // 未授权：未注册 / 闭店拦截
  CROSS_DAY: 1002,      // 跨日禁止撤回
  FORBIDDEN: 1003,      // 无权限（角色不匹配 / 越店 / 哨兵）
  NO_STOCK: 2001,       // 库存不足
  NEGATIVE: 2002,       // 业务校验未通过（空值 / 非正数 / 缺驳回原因…）
  NOT_FOUND: 3001,      // 档案 / 单据未找到
  DUPLICATE: 3002,      // 重名（店名 / 账号 / 食材 / 菜品）
  SYSTEM: 5001          // 系统内部错误
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

// 拒绝原因 → 纯中文文案（键不变；与 cloudfunctions/_shared/constants.js 对齐）
var REASON_LABEL = {
  NOT_LOGIN: '未登录或未注册',
  INACTIVE: '账号已停用',
  NO_ROLE: '角色不匹配',
  STORE_OUT_OF_SCOPE: '非本店数据',
  STORE_CLOSED: '所属门店已闭店'
};

module.exports = {
  ROLE: ROLE,
  ROLE_LABEL: ROLE_LABEL,
  ACTION: ACTION,
  ACTION_LABEL: ACTION_LABEL,
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
  REASON_LABEL: REASON_LABEL
};
