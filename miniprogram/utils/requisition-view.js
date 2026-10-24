// ==========================================================================
// utils/requisition-view.js — 申请单列表的展示装饰（共享）
// 把 requisition list 的裸数据补上展示字段：itemsText / timeText / statusLabel /
// canCancel / canCopy。食材申请页（内嵌记录）与申请记录页共用，避免两处重复逻辑。
// ==========================================================================
var fmt = require('./format');

var STATUS_LABEL = { pending: '待处理', confirmed: '已确认', rejected: '已驳回', cancelled: '已撤回' };

/**
 * @param {Array} matRows material list 裸行（含 _id/name/unit）
 * @param {Array} list     requisition list 裸行（含 _id/items/createdAt/status/rejectReason）
 * @returns {Array} 补齐展示字段的列表（原对象就地补齐）
 */
function decorate(matRows, list) {
  var matMap = {};
  (matRows || []).forEach(function (m) { matMap[m._id] = m; });
  (list || []).forEach(function (r) {
    r.itemsText = (r.items || []).map(function (it) {
      var m = matMap[it.itemId];
      return (m ? m.name : it.itemId) + ' ' + fmt.formatQty(it.qty, m ? m.unit : '');
    }).join('；');
    r.timeText = fmt.fmtShort(r.createdAt);
    r.statusLabel = STATUS_LABEL[r.status] || r.status;
    r.canCancel = r.status === 'pending';
    r.canCopy = r.status === 'rejected' || r.status === 'cancelled';
  });
  return list || [];
}

module.exports = { decorate: decorate };
