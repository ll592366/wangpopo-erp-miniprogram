// ==========================================================================
// utils/cloud.js — 云函数调用统一封装（ARCH v1.5 §2 / §4.5）
// 所有云函数返回统一 { code, data, message }；此层只做透传 + 常用辅助。
// 传输层错误（超时 / 网络 / 执行失败）统一翻成用户可读文案（humanizeErr），
// 绝不把 wx.cloud.callFunction 的 SDK 原文抛给用户；原文经 `raw` 字段保留供排查。
// ==========================================================================
var config = require('./config');

/** 初始化云开发（app.js onLaunch 里调用一次） */
function init() {
  if (!wx.cloud) {
    console.error('基础库过低，请升级微信开发者工具 / 微信客户端（需 ≥ 2.2.3）');
    return;
  }
  wx.cloud.init({
    // Q1（ARCH §11）：env 实际环境 ID 部署前由老板填（utils/config.js）
    env: config.CLOUD_ENV,
    traceUser: true
  });
}

/**
 * 传输层错误的原始字符串：优先 errMsg，其次 message；纯字符串原样；其余（含空对象）→ ''。
 * @param {*} err
 * @returns {string}
 */
function rawErrText(err) {
  if (err === undefined || err === null) { return ''; }
  if (typeof err === 'string') { return err; }
  var m = err.errMsg || err.message;
  return typeof m === 'string' ? m : '';
}

/**
 * 传输层错误 → 用户可读文案。判定按固定顺序（超时 → 网络 → 执行失败 → 兜底），
 * 绝不回落成 SDK 原文；原始串由调用方经 `raw` 字段保留。
 * @param {*} err
 * @returns {string}
 */
function humanizeErr(err) {
  var s = rawErrText(err);
  if (!s) { return '网络异常，请稍后重试'; }
  if (/timed out|TIME_LIMIT_EXCEEDED|timeout/i.test(s)) { return '服务器响应超时，请稍后重试'; }
  if (/request:fail|net::ERR|ERR_INTERNET|ECONN|网络/.test(s)) { return '网络异常，请检查网络后重试'; }
  if (/FUNCTIONS_EXECUTE_FAIL|-504002/.test(s)) { return '服务器处理失败，请稍后重试'; }
  // access_token expired：不是超时也不是网络，是**登录态/云环境鉴权**过期（常见于开发者工具
  // 长时间开着或云环境套餐到期）。给可执行的动作，别让人以为是程序崩了。
  if (/access_token|accesstoken|token expired|invalid credential/i.test(s)) {
    return '登录状态已过期，请重新登录后重试';
  }
  return '操作失败，请稍后重试';
}

/**
 * 调用云函数，返回 Promise<{code,data,message}>
 * @param {string} name  云函数名（13 个之一）
 * @param {object} [data] 入参
 * @returns {Promise<{code:number, data:*, message:string, raw?:string}>}
 */
function call(name, data) {
  // 以账号为准：登录后每次调用自动附带 _uid（登录时 login 返回的 user._id），
  // 云函数 requireUser 按 _uid 鉴权（不依赖微信 openid）
  var d = data ? Object.assign({}, data) : {};
  try {
    var app = getApp();
    if (app && app.globalData && app.globalData.user && app.globalData.user._id) {
      d._uid = app.globalData.user._id;
    }
  } catch (e) { /* getApp 未就绪时忽略 */ }
  return wx.cloud.callFunction({
    name: name,
    data: d
  }).then(function (res) {
    var r = res && res.result;
    if (!r || typeof r.code === 'undefined') {
      return { code: 5001, data: null, message: '服务器返回异常，请稍后重试' };
    }
    // 服务端把非业务异常的真相放在响应顶层 diag（用户文案不变，只给开发者看）
    if (r.diag) { console.error('[cloud] 服务端异常诊断：', r.diag); }
    return r;
  }).catch(function (err) {
    console.error('[cloud] call ' + name + ' 失败：', err);
    // 用户只看人话；原始 SDK 错误不抛给用户，留在 raw 字段（console.error 已打印原文）
    return { code: 5001, data: null, message: humanizeErr(err), raw: rawErrText(err) };
  });
}

/**
 * 调用 + 失败自动 toast（成功与否都返回结果，便于页面继续判断）
 * @param {string} name
 * @param {object} [data]
 * @param {string} [successText]
 * @param {object} [opts] { loading: '处理中' } —— **慢操作专用**：调用期间显示遮罩 Loading，
 *        结束后自动关闭。不传则行为与原来完全一致（列表查询等快操作不弹，避免一闪一闪）。
 *        ⚠️ 文案必须 ≤ 7 个字符：wx.showLoading 的 title 超出会被截断成"…"，
 *           所以只写「处理 56 条」这种短句，长说明放调用前的 showModal 里讲。
 */
function callWithToast(name, data, successText, opts) {
  var loadingText = opts && opts.loading ? String(opts.loading) : '';
  // mask:true —— 遮住页面，顺带防止老板在十几秒等待里重复点击（大单确认是重操作）
  if (loadingText) { wx.showLoading({ title: loadingText, mask: true }); }
  function closeLoading() {
    if (loadingText) { wx.hideLoading(); loadingText = ''; }
  }
  return call(name, data).then(function (res) {
    closeLoading();
    if (res.code === 0) {
      if (successText) { wx.showToast({ title: successText, icon: 'success' }); }
    } else {
      // 报错一律只给「人能看懂的话」：不再拼 [code] 前缀（业务码 / 内部传输码对用户都无意义）
      wx.showToast({ title: res.message, icon: 'none', duration: 2600 });
    }
    return res;
  }, function (e) {
    closeLoading();   // 异常路径也必须关，否则遮罩永远卡住页面
    throw e;
  });
}

module.exports = {
  init: init,
  call: call,
  callWithToast: callWithToast
};
