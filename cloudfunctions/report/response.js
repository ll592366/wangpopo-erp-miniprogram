// ==========================================================================
// cloudfunctions/_shared/response.js — 统一响应封装 + 业务错误（ARCH v1.5 §4.5）
// 所有云函数返回 { code, data, message }；code !== 0 时 data = null。
// ==========================================================================
var C = require('./constants');

/** 业务错误：throw new BizError(CODE.XXX, '可选自定义文案') */
function BizError(code, message) {
  this.name = 'BizError';
  this.code = code;
  this.message = message || C.CODE_MSG[code] || '业务校验未通过';
}
BizError.prototype = Object.create(Error.prototype);
BizError.prototype.constructor = BizError;

/** 成功响应 */
function ok(data) {
  return { code: C.CODE.OK, data: data === undefined ? null : data, message: 'ok' };
}

/** 失败响应（快捷） */
function fail(code, message) {
  return { code: code, data: null, message: message || C.CODE_MSG[code] || '业务校验未通过' };
}

/**
 * 云函数主入口统一包裹：捕获 BizError → 失败响应；其它异常 → 5001
 * @param {Function} handler async (event, ctx) => data
 */
function wrap(handler) {
  return function (event) {
    return Promise.resolve()
      .then(function () { return handler(event); })
      .then(function (data) { return ok(data); })
      .catch(function (e) {
        if (e instanceof BizError) {
          console.warn('[BizError]', e.code, e.message);
          return fail(e.code, e.message);
        }
        // 用户侧只给固定人话；异常真相分两路送医（2026-10-08 线上「系统繁忙」不可诊断后加）：
        //   ① 云函数日志：console.error（腾讯云侧控制台可查）
        //   ② 响应顶层 diag：前端 console.error 打印（开发者在微信开发者工具里直接看到）
        // 为什么要 ②：腾讯云侧账号看不到微信侧环境的云函数日志，前端只拿到一句「系统繁忙」，
        //   等于完全瞎了。错误码(errCode/code)比英文文案更稳定，是最有价值的线索，故必须带上。
        // ⚠️ diag 挂在**响应顶层**、绝不进 data —— 保持「code !== 0 时 data === null」这个不变量。
        // ⚠️ diag 只给开发者看，绝不弹给用户；message 一个字都不能改（老板红线：不许烂码）。
        console.error('[SYSTEM]', e);
        var res = fail(C.CODE.SYSTEM, '系统繁忙，请稍后重试');
        res.diag = '[系统异常] name=' + ((e && e.name) || 'Error')
          + ' code=' + ((e && (e.errCode || e.code)) || '')
          + ' msg=' + String((e && e.message) || e || '').slice(0, 200);
        return res;
      });
  };
}

module.exports = {
  BizError: BizError,
  ok: ok,
  fail: fail,
  wrap: wrap
};
