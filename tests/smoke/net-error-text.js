// ==========================================================================
// tests/smoke/net-error-text.js — 网络/超时错误提示（传输层原文不外泄）
//
// 老板截图里用户看到的是 SDK 原文：
//   [5001] cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out ...
// 本套用假 wx / 假 getApp 直接 require miniprogram/utils/cloud.js，断言：
//   · 传输层错误被翻成人话（不含 errCode / -504003 / cloud.callFunction）
//   · 原始串不丢（raw 字段仍含 -504003，供排查）
//   · 报错一律不加 [code] 前缀（用户只看人话）；格式异常文案为「服务器返回异常，请稍后重试」
//   · 成功路径行为不变
// ==========================================================================
var path = require('path');

var MINI = path.resolve(__dirname, '..', '..', 'miniprogram');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ---------------- 假 wx / 假 getApp + 可编程的 callFunction ---------------- */
var lastCall = null;
var toasts = [];
var behavior = null;                       // () => Promise（由各用例设置）

global.getApp = function () { return { globalData: { user: { _id: 'u_test' } } }; };
global.wx = {
  cloud: { callFunction: function (opt) { lastCall = opt; return behavior(opt); } },
  showToast: function (o) { toasts.push(o); }
};

var cloud = require(path.join(MINI, 'utils', 'cloud.js'));

function rejectWith(errMsg) { var e = new Error(errMsg); e.errMsg = errMsg; return Promise.reject(e); }
function rejectObj(obj) { return Promise.reject(obj); }
function resolveWith(result) { return Promise.resolve({ result: result }); }

var TIMEOUT_MSG = 'cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds';

var chain = Promise.resolve();
function step(fn) { chain = chain.then(fn); }

/* ---------------- 1. 超时（老板截图原文） ---------------- */
step(function () {
  section('1. 超时错误 → 翻人话 + 原文不外泄 + 原文保留');
  behavior = function () { return rejectWith(TIMEOUT_MSG); };
  return cloud.call('requisition', { action: 'confirm' }).then(function (res) {
    check('code===5001', res.code === 5001, 'code=' + res.code);
    check('message=「服务器响应超时，请稍后重试」', res.message === '服务器响应超时，请稍后重试', res.message);
    check('message 不含 errCode', res.message.indexOf('errCode') < 0);
    check('message 不含 -504003', res.message.indexOf('-504003') < 0);
    check('message 不含 cloud.callFunction', res.message.indexOf('cloud.callFunction') < 0);
    check('raw 含 -504003（原文没丢）', String(res.raw).indexOf('-504003') >= 0, 'raw=' + res.raw);
    check('_uid 注入未被破坏', lastCall && lastCall.data && lastCall.data._uid === 'u_test', lastCall && lastCall.data._uid);
  });
});

/* ---------------- 2. 网络类错误 ---------------- */
step(function () {
  section('2. 网络类错误 → 网络异常文案');
  behavior = function () { return rejectWith('request:fail ERR_INTERNET_DISCONNECTED'); };
  return cloud.call('material', { action: 'list' }).then(function (res) {
    check('message=「网络异常，请检查网络后重试」', res.message === '网络异常，请检查网络后重试', res.message);
  });
});

/* ---------------- 3. 执行失败 ---------------- */
step(function () {
  section('3. 执行失败 → 服务器处理失败');
  behavior = function () { return rejectWith('errCode: -504002 | errMsg: FUNCTIONS_EXECUTE_FAIL'); };
  return cloud.call('production', { action: 'list' }).then(function (res) {
    check('message=「服务器处理失败，请稍后重试」', res.message === '服务器处理失败，请稍后重试', res.message);
  });
});

/* ---------------- 4. 未知错误串 → 兜底，不回落实原文 ---------------- */
step(function () {
  section('4. 未知错误串 → 兜底文案（不含原始串）');
  behavior = function () { return rejectWith('something weird happened'); };
  return cloud.call('report', {}).then(function (res) {
    check('message=「操作失败，请稍后重试」', res.message === '操作失败，请稍后重试', res.message);
    check('message 不含原始串', res.message.indexOf('something weird happened') < 0);
  });
});

/* ---------------- 5. err 为空 / 空对象 → 保持原网络文案 ---------------- */
step(function () {
  section('5. 空错误 → 网络异常文案（不变）');
  behavior = function () { return rejectWith(undefined); };
  return cloud.call('store', {}).then(function (res) {
    check('err=undefined → 「网络异常，请稍后重试」', res.message === '网络异常，请稍后重试', res.message);
    check('err=undefined → raw===\'\'', res.raw === '', 'raw=' + JSON.stringify(res.raw));
  });
});
step(function () {
  behavior = function () { return rejectObj({}); };
  return cloud.call('store', {}).then(function (res) {
    check('err={} 空对象 → 「网络异常，请稍后重试」', res.message === '网络异常，请稍后重试', res.message);
  });
});

/* ---------------- 6. callWithToast：5001 不加 [code] ---------------- */
step(function () {
  section('6. callWithToast · 5001 不加 [code] 前缀');
  toasts = [];
  behavior = function () { return rejectWith(TIMEOUT_MSG); };
  return cloud.callWithToast('requisition', { action: 'confirm' }).then(function (res) {
    var t = toasts[0] || {};
    check('toast title === message', t.title === res.message, t.title);
    check('toast title 不含 [5001]', String(t.title).indexOf('[5001]') < 0);
  });
});

/* ---------------- 7. callWithToast：业务码也不再带 [code] ---------------- */
step(function () {
  section('7. callWithToast · 业务码也不再拼 [code] 前缀（用户只看人话）');
  toasts = [];
  behavior = function () { return resolveWith({ code: 2001, data: null, message: '库存不足：xxx' }); };
  return cloud.callWithToast('requisition', { action: 'confirm' }).then(function () {
    var t = toasts[0] || {};
    check('toast title === "库存不足：xxx"', t.title === '库存不足：xxx', t.title);
    check('toast title 不含 [2001]', String(t.title).indexOf('[2001]') < 0);
  });
});

/* ---------------- 8. 成功路径原样透传 ---------------- */
step(function () {
  section('8. 成功路径原样返回（message 不变）');
  behavior = function () { return resolveWith({ code: 0, data: { ok: 1 }, message: '' }); };
  return cloud.call('material', { action: 'list' }).then(function (res) {
    check('code=0 / data.ok=1 / message 不变', res.code === 0 && res.data && res.data.ok === 1 && res.message === '');
    check('成功结果不含 raw 字段（未被污染）', Object.prototype.hasOwnProperty.call(res, 'raw') === false);
  });
});

/* ---------------- 9. 返回格式异常 → 人话（语义不变，只改文案） ---------------- */
step(function () {
  section('9. result 缺 code → 「服务器返回异常，请稍后重试」');
  behavior = function () { return resolveWith({ data: { x: 1 } }); };
  return cloud.call('material', { action: 'list' }).then(function (res) {
    check('code=5001 且 message=「服务器返回异常，请稍后重试」', res.code === 5001 && res.message === '服务器返回异常，请稍后重试', res.code + '/' + res.message);
  });
});

/* ---------------- 收尾 ---------------- */
chain.then(function () {
  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'NET-ERROR RESULT: ALL GREEN' : 'NET-ERROR RESULT: HAS FAILURE');
  process.exitCode = fail === 0 ? 0 : 1;
}, function (e) {
  console.log('  EXCEPTION ' + (e && e.stack || e));
  console.log('----------------------------------------------');
  console.log('合计 ' + (pass + fail + 1) + ' 条：通过 ' + pass + '，失败 ' + (fail + 1));
  console.log('NET-ERROR RESULT: HAS FAILURE');
  process.exitCode = 1;
});
