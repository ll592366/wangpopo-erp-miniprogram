// ==========================================================================
// pages/shop/consume-summary — 消耗汇总（门店端 · 仅本店，无门店选择行）
// 逻辑全部在 utils/consume-summary.js（与管理端共用），本页只声明 role=shop。
// ==========================================================================
var summary = require('../../../utils/consume-summary');

Page(summary.buildPage({ role: 'shop' }));
