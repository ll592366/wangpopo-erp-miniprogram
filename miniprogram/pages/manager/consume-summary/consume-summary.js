// ==========================================================================
// pages/manager/consume-summary — 消耗汇总（管理端 · 多门店可选）
// 逻辑全部在 utils/consume-summary.js（与门店端共用），本页只声明 role=manager。
// ==========================================================================
var summary = require('../../../utils/consume-summary');

Page(summary.buildPage({ role: 'manager' }));
