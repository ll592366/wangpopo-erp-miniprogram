// ==========================================================================
// utils/export.js — 通用表格导出（纯本地生成，不新增云函数、不新增 ACTION）
//
// 用法（本项目禁 ES Module，统一 CommonJS）：
//   var exp = require('../../utils/export');
//   exp.exportTable({
//     filename: '消耗记录_天润店_20260901-20260919_202609191326',  // 不带扩展名，工具补 .xls
//     headers: ['日期','时间','菜品','份数','状态','食材','单位','消耗量'],
//     rows: [ ['2026-09-17','17:20','醋泡五彩花生','1','已出品','花生米','包','0.25'] ],
//     total: 1284   // 可选：导出完成后 toast「已导出 1284 条」
//   });
//
// 导出链路（逐级降级，每级都有明确 toast，绝不静默）：
//   ① CSV 文本（UTF-8 + BOM，Excel/WPS 中文不乱码）→ 写成 .xls → wx.openDocument(showMenu)
//   ② wx.openDocument 失败 → wx.shareFileMessage（转发到微信聊天）
//   ③ 上面都失败 / 能力缺失 → wx.setClipboardData（纯文本粘贴进表格）
//
// ⚠️ wx.openDocument 能否打开「CSV 内容 + .xls 后缀」需真机 / 模拟器验证，本地跑不了。
// ==========================================================================
var fmt = require('./format');

/** CSV 单元格转义（含逗号 / 双引号 / 换行 → 双引号包裹 + 引号翻倍，RFC 4180） */
function csvCell(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** 组装 CSV 文本：UTF-8 BOM 开头 + CRLF 行尾（Excel / WPS 双击直接打开不乱码） */
function buildCsv(headers, rows) {
  var lines = [];
  lines.push((headers || []).map(csvCell).join(','));
  (rows || []).forEach(function (r) {
    lines.push((r || []).map(csvCell).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

/** 剪贴板降级文本（制表符分隔，可直接粘进表格） */
function clipboardText(headers, rows) {
  var lines = [];
  lines.push((headers || []).join('\t'));
  (rows || []).forEach(function (r) {
    lines.push((r || []).join('\t'));
  });
  return lines.join('\n');
}

/** 时间戳 YYYYMMDDHHmm（文件名防多次导出重名覆盖） */
function stamp() {
  var d = new Date();
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes());
}

/** 文件名清理：剔除路径分隔符等非法字符 */
function safeName(name) {
  return String(name || '导出数据').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || '导出数据';
}

/** 降级 2：复制到剪贴板 */
function fallbackClipboard(headers, rows) {
  wx.setClipboardData({
    data: clipboardText(headers, rows),
    success: function () {
      wx.showToast({ title: '已复制，可粘贴到表格', icon: 'none', duration: 2600 });
    },
    fail: function () {
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  });
}

/** 降级 1：转发文件到微信聊天 */
function fallbackShare(xlsPath, fileName, headers, rows) {
  if (typeof wx.shareFileMessage !== 'function') {
    fallbackClipboard(headers, rows);
    return;
  }
  wx.showLoading({ title: '正在转发…', mask: true });
  wx.shareFileMessage({
    filePath: xlsPath,
    fileName: fileName,
    success: function () { wx.hideLoading(); },
    fail: function () {
      wx.hideLoading();
      fallbackClipboard(headers, rows);
    }
  });
}

/** 主路径：用系统文档查看器打开（showMenu:true → 右上角可「转发到电脑 / 用其他应用打开」） */
function openFile(xlsPath, fileName, headers, rows) {
  if (typeof wx.openDocument !== 'function') {
    fallbackShare(xlsPath, fileName, headers, rows);
    return;
  }
  wx.openDocument({
    filePath: xlsPath,
    fileType: 'xls',      // CSV 内容 + .xls 后缀：Excel / WPS 按内容识别
    showMenu: true,       // 必须 true，否则没有右上角菜单可供转发
    success: function () { /* 系统查看器打开即接管界面 */ },
    fail: function () {
      fallbackShare(xlsPath, fileName, headers, rows);
    }
  });
}

/**
 * 导出表格
 * @param {{filename:string, headers:Array<string>, rows:Array<Array>, total?:number}} opt
 * @returns {boolean} 是否成功进入导出流程（未进入 = 无可导出记录）
 */
function exportTable(opt) {
  opt = opt || {};
  var headers = opt.headers || [];
  var rows = opt.rows || [];
  if (!rows.length) {
    wx.showToast({ title: '暂无可导出的记录', icon: 'none' });
    return false;
  }

  var fileName = safeName(opt.filename || ('导出数据_' + stamp())) + '.xls';
  var csv = buildCsv(headers, rows);

  var fs = wx.getFileSystemManager();
  var xlsPath = wx.env.USER_DATA_PATH + '/' + fileName;

  wx.showLoading({ title: '正在生成…', mask: true });
  try {
    fs.writeFileSync(xlsPath, csv, 'utf8');
  } catch (e) {
    wx.hideLoading();
    wx.showToast({ title: '生成文件失败', icon: 'none' });
    return false;
  }
  wx.hideLoading();

  // 导出完成提示（带总条数）：老板 2026-09-19 要求导出后能看到条数
  if (opt.total !== undefined && opt.total !== null) {
    wx.showToast({ title: '已导出 ' + opt.total + ' 条', icon: 'none', duration: 2200 });
  }
  openFile(xlsPath, fileName, headers, rows);
  return true;
}

module.exports = {
  exportTable: exportTable,
  buildCsv: buildCsv,
  csvCell: csvCell,
  clipboardText: clipboardText,
  safeName: safeName,
  stamp: stamp,
  fmt3: fmt.fmt3
};
