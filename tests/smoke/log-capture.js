/* tests/smoke/log-capture.js — 抓取云函数 console.error/console.warn 原文。
 * 用途：未预期异常的用户文案已被固定为人话，判别力只能落在日志上。 */
'use strict';

function fmtLogArg(a) {
  if (a instanceof Error) { return (a.name || 'Error') + ': ' + (a.message || ''); }
  if (typeof a === 'string') { return a; }
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

/** 在 fn 执行期间把 console.error/warn 收集到内存，返回 { r, log }（无论成功失败都恢复原函数） */
async function withLog(fn) {
  const buf = [];
  const oErr = console.error, oWarn = console.warn;
  function sink() { buf.push(Array.prototype.slice.call(arguments).map(fmtLogArg).join(' ')); }
  console.error = sink;
  console.warn = sink;
  try { return { r: await fn(), log: buf.join('\n') }; }
  finally { console.error = oErr; console.warn = oWarn; }
}

module.exports = { fmtLogArg: fmtLogArg, withLog: withLog };
