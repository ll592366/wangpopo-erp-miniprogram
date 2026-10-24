// ==========================================================================
// tests/smoke/auth-coverage.js — 权限映射「防复发」机械闸门
//
// 背景（2026-10-08 线上 P1）：store.resetAllPassword 恒 1003。
//   根因链条：constants 加了 STORE_RESET_ALL_PASSWORD → store/index.js 加了
//   requireUser 调用 → 前端加了按钮与文案 → **唯独 auth.js 的
//   actionToRequiredRoles() 忘了加 case** → 落 default:return [] →
//   judge() 里 effectiveRoles 恒空 → reason='NO_ROLE' → requireUser 抛 1003。
//   静默失败（不报错、只是「什么都没发生」），人眼根本看不出来。
//
// 本套把这件事变成机械断言（纯读文件，不 require 云函数、不依赖 mock）：
//   A. ACTION 常量表 ↔ actionToRequiredRoles() 全量对齐（白名单只 3 个例外，各有注释）
//   B. 调用方扫描：每一处 auth.requireUser/auth.can 的 ACTION 键必须有定义 + 有映射
//   C. 15 份 auth.js（_shared + 14 个函数目录）内容必须逐字节一致（distinct sha256 = 1）
//   D. 反向自证：把映射表在**内存里**删掉那个 case，检查函数必须报出缺陷
//      → 证明本套件有判别力，不是恒真断言
//
// ⚠️ 白名单里的 USER_DELETE 是**故意不映射**的：
//    'user.delete' 全仓零调用方，且 ui-rules 断言前端 deleteAccount 入口必须不存在
//    （老板 2026-09-15 拍板「不要了」）。给它补映射等于把「功能没实现」伪装成「已就绪」。
// ==========================================================================
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var SHARED_AUTH = path.join(CF, '_shared', 'auth.js');
var SHARED_CONST = path.join(CF, '_shared', 'constants.js');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* --------------------------------------------------------------------------
 * 白名单：允许「有常量但故意不给出可用映射」的 ACTION 键。每条都必须写明理由。
 * mapped = 该键在 switch 里**是否应当**出现 case：
 *   · 哨兵 USER_MANAGE / STORE_MANAGE：有 case，但返回 []（故 mapped=true）
 *   · USER_DELETE：连 case 都不能有（故 mapped=false）
 * -------------------------------------------------------------------------- */
var WHITELIST = {
  USER_MANAGE: {
    mapped: true,
    why: '哨兵：保留给「用户管理」分组入口，故意返回 []（无任何动作挂在它下面）'
  },
  STORE_MANAGE: {
    mapped: true,
    why: '哨兵：保留给「门店管理」分组入口，故意返回 []（无任何动作挂在它下面）'
  },
  USER_DELETE: {
    mapped: false,
    why: '功能未实现：全仓零调用方，且 ui-rules 断言前端 deleteAccount 入口必须不存在（老板 2026-09-15 拍板「不要了」）。补映射等于把「没实现」伪装成「已就绪」'
  }
};

/* ------------------------------ 解析工具 ------------------------------ */

/** 解析 `var ACTION = { KEY: 'value', ... };` → { KEY: 'value' } */
function parseActionMap(src) {
  var m = src.match(/var\s+ACTION\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) { return null; }
  var map = {};
  m[1].split('\n').forEach(function (line) {
    var mm = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([^']*)'/);
    if (mm) { map[mm[1]] = mm[2]; }
  });
  return map;
}

/**
 * 先剥掉注释再解析结构。
 * ★ 2026-10-08 补：反向自证时把 case **注释掉**（// case C.ACTION.X: ...），
 *   而朴素正则会把注释里的那行照样当成「有映射」→ 闸门假绿。
 *   故所有结构解析都必须基于去注释后的代码。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                 // 块注释
    .replace(/^[ \t]*\/\/.*$/gm, ' ')                // 行注释（整行）
    .replace(/\/\/.*$/gm, ' ');                      // 行尾注释（保守：可能误伤字符串里的 //）
}

/** 解析 auth.js 里出现过的 `case C.ACTION.<KEY>:` → [KEY, ...] */
function parseMappedKeys(src) {
  var out = [];
  var re = /case\s+C\.ACTION\.([A-Z][A-Z0-9_]*)\s*:/g;
  var m;
  var code = stripComments(src);
  while ((m = re.exec(code)) !== null) {
    if (out.indexOf(m[1]) < 0) { out.push(m[1]); }
  }
  return out;
}

/**
 * 取某个 case 之后**遇到的第一个 return 数组字面量**。
 * 必须这样取，不能按行归属 —— 因为 case 是靠 fallthrough 分组的：
 *   case C.ACTION.USER_MANAGE:
 *   case C.ACTION.STORE_MANAGE:   return [];
 * @returns {string|null} 如 '[]' / '[C.ROLE.MANAGER]'；未映射则 null
 */
function returnOf(src, key) {
  var code = stripComments(src);
  var idx = code.indexOf('case C.ACTION.' + key + ':');
  if (idx < 0) { return null; }
  var m = code.slice(idx).match(/return\s*(\[[^\]]*\])/);
  return m ? m[1] : null;
}

/* --------------------------------------------------------------------------
 * 核心检查函数（纯函数，输入文本 → 缺陷清单）。
 * 抽成纯函数是为了 D 段能在内存里喂变异体做反向自证，不去真改磁盘文件。
 * -------------------------------------------------------------------------- */
function collectDefects(authSrc, actionMap) {
  var defects = [];
  var mapped = parseMappedKeys(authSrc);

  Object.keys(actionMap).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(WHITELIST, key)) { return; }
    if (mapped.indexOf(key) < 0) {
      defects.push('ACTION.' + key + "('" + actionMap[key] + "') 在 actionToRequiredRoles() 里没有 case " +
        '→ 落 default:[] → 恒 1003（静默失败）');
    }
  });

  // 已映射的键（哨兵除外）不允许返回 [] —— 空数组 = 恒 1003，是缺陷形态
  Object.keys(actionMap).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(WHITELIST, key)) { return; }
    if (parseMappedKeys(authSrc).indexOf(key) < 0) { return; }
    var r = returnOf(authSrc, key);
    if (r === '[]') {
      defects.push('ACTION.' + key + "('" + actionMap[key] + "') 映射为 [] → effectiveRoles 恒空 → 恒 1003");
    }
  });

  return defects;
}

/* =========================== A. 常量 ↔ 映射 对齐 =========================== */
section('A. ACTION 常量表 ↔ actionToRequiredRoles() 全量对齐');
var constSrc = fs.readFileSync(SHARED_CONST, 'utf8');
var authSrc = fs.readFileSync(SHARED_AUTH, 'utf8');
var actionMap = parseActionMap(constSrc);
var mappedKeys = parseMappedKeys(authSrc);

check('成功解析 constants.js 的 ACTION 表', !!actionMap && Object.keys(actionMap).length > 0,
  actionMap ? Object.keys(actionMap).length + ' 个动作' : '解析失败');

var defects = collectDefects(authSrc, actionMap || {});
check('每个 ACTION 常量都有非空映射（无「加了常量忘了加 case」）', defects.length === 0,
  defects.length === 0 ? '0 缺陷' : defects.join(' | '));

// 白名单自身也要被看住：不能随便加例外，也不能悄悄把例外补上映射
check('白名单恰好 3 个例外', Object.keys(WHITELIST).length === 3, Object.keys(WHITELIST).join('、'));
var wlBad = Object.keys(WHITELIST).filter(function (k) { return !actionMap || !actionMap[k]; });
check('白名单里的键都真实存在于 ACTION 表（防写成废键）', wlBad.length === 0, wlBad.join('、') || '无');
var wlLeak = Object.keys(WHITELIST).filter(function (k) {
  var shouldHaveCase = WHITELIST[k].mapped;
  var hasCase = mappedKeys.indexOf(k) >= 0;
  return shouldHaveCase !== hasCase;
});
check('白名单键的「有无 case」符合各自声明（哨兵有 case，USER_DELETE 无）', wlLeak.length === 0,
  wlLeak.join('、') || '无');
Object.keys(WHITELIST).forEach(function (k) {
  check('  · ' + k + ' 例外理由已写明', String(WHITELIST[k].why || '').length >= 10, WHITELIST[k].why);
});

// 哨兵必须真的是 []（这是「故意的」，不是漏的）
check('哨兵 USER_MANAGE 映射为 []（故意）', returnOf(authSrc, 'USER_MANAGE') === '[]',
  String(returnOf(authSrc, 'USER_MANAGE')));
check('哨兵 STORE_MANAGE 映射为 []（故意）', returnOf(authSrc, 'STORE_MANAGE') === '[]',
  String(returnOf(authSrc, 'STORE_MANAGE')));

// 本次 P1 的具体回归锁
var p1 = 'STORE_RESET_ALL_PASSWORD';
check('P1 回归锁：' + p1 + ' 已有 case', mappedKeys.indexOf(p1) >= 0);
check('P1 回归锁：' + p1 + ' 映射为 [C.ROLE.MANAGER]',
  /ROLE\.MANAGER/.test(String(returnOf(authSrc, p1))), String(returnOf(authSrc, p1)));
check('P1 回归锁：USER_DELETE 仍然**不**映射（不得补）',
  mappedKeys.indexOf('USER_DELETE') < 0 && returnOf(authSrc, 'USER_DELETE') === null);

/* =========================== B. 调用方扫描 =========================== */
section('B. 调用方扫描：requireUser / can 的 ACTION 键必须有定义 + 有映射');
var fnDirs = fs.readdirSync(CF).filter(function (d) {
  if (d.charAt(0) === '_') { return false; }          // 跳过 _shared / _legacy_*
  try { return fs.statSync(path.join(CF, d)).isDirectory(); } catch (e) { return false; }
});
var callSites = [];   // { dir, line, key, literal }
var badLiteral = [];  // 用了 ACTION 表里没有的键
var noMapping = [];   // 用了没映射的键
fnDirs.forEach(function (d) {
  var f = path.join(CF, d, 'index.js');
  if (!fs.existsSync(f)) { return; }
  var lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach(function (line, i) {
    if (line.indexOf('auth.requireUser(') < 0 && line.indexOf('auth.can(') < 0) { return; }
    var re = /C\.ACTION\.([A-Z][A-Z0-9_]*)/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      var key = m[1];
      var literal = actionMap && actionMap[key] ? actionMap[key] : '(未在 ACTION 表定义 → undefined)';
      callSites.push({ dir: d, line: i + 1, key: key, literal: literal });
      if (!actionMap || !actionMap[key]) {
        badLiteral.push(d + '/index.js:' + (i + 1) + ' C.ACTION.' + key + ' → ' + literal);
      }
      if (mappedKeys.indexOf(key) < 0) {
        noMapping.push(d + '/index.js:' + (i + 1) + ' C.ACTION.' + key + "('" + literal + "')");
      }
    }
  });
});
check('扫描到 requireUser/can 调用点（>0，证明扫描器本身有效）', callSites.length > 0, callSites.length + ' 处');
check('所有调用点的 ACTION 键都在 constants 里定义过', badLiteral.length === 0,
  badLiteral.length === 0 ? '无未定义键' : badLiteral.join(' | '));
check('所有调用点的 ACTION 键都有非空映射', noMapping.length === 0,
  noMapping.length === 0 ? '无未映射键' : noMapping.join(' | '));

/* =========================== C. 副本一致性 =========================== */
section('C. 15 份 auth.js 副本一致性（漏同步 = 那个函数静默 1003）');
function authCopies() {
  var out = [];
  fs.readdirSync(CF).forEach(function (d) {
    if (d.charAt(0) === '_') { return; }
    try { if (!fs.statSync(path.join(CF, d)).isDirectory()) { return; } } catch (e) { return; }
    var p = path.join(CF, d, 'auth.js');
    if (fs.existsSync(p)) { out.push(p); }
  });
  out.push(SHARED_AUTH);   // _shared 那份也参与一致性
  return out;
}
function hashesOf(files, readFn) {
  var m = {};
  files.forEach(function (p) {
    var buf = readFn ? readFn(p) : fs.readFileSync(p);
    m[p] = crypto.createHash('sha256').update(buf).digest('hex');
  });
  return m;
}
var copies = authCopies();
var hashes = hashesOf(copies);
var distinct = Object.keys(hashes).reduce(function (acc, p) {
  if (acc.indexOf(hashes[p]) < 0) { acc.push(hashes[p]); }
  return acc;
}, []);
check('副本数量 = 15（_shared 1 + 14 个函数目录，含 migrate）', copies.length === 15, copies.length + ' 份');
check('15 份 auth.js 的 distinct sha256 = 1（逐字节一致）', distinct.length === 1,
  distinct.length + ' 个不同哈希' + (distinct.length === 1 ? '：' + distinct[0].slice(0, 12) : ''));

/* =========================== D. 反向自证（判别力） =========================== */
section('D. 反向自证：内存里删掉那个 case，检查函数必须报出缺陷（证明不是恒真）');
var d1 = collectDefects(authSrc, actionMap);
check('D1 喂「当前映射表」→ 0 缺陷（闸门对现状放行）', d1.length === 0, d1.length + ' 缺陷');

var mutated = authSrc.replace(/^[ \t]*case\s+C\.ACTION\.STORE_RESET_ALL_PASSWORD:.*\r?\n/m, '');
check('D2 变异体确实把那个 case 删掉了（前提校验）',
  mutated.indexOf('case C.ACTION.STORE_RESET_ALL_PASSWORD') < 0 &&
  authSrc.indexOf('case C.ACTION.STORE_RESET_ALL_PASSWORD') >= 0);
var d2 = collectDefects(mutated, actionMap);
check('D2 喂「删掉映射」的变异体 → 必须报出缺陷', d2.length > 0, d2.length + ' 缺陷');
check('D2 报出的缺陷点名了 STORE_RESET_ALL_PASSWORD',
  d2.some(function (x) { return x.indexOf('STORE_RESET_ALL_PASSWORD') >= 0; }),
  d2[0] || '(无)');

var mutated2 = authSrc.replace(/case\s+C\.ACTION\.STORE_RESET_ALL_PASSWORD:\s*return\s*\[C\.ROLE\.MANAGER\];/,
  'case C.ACTION.STORE_RESET_ALL_PASSWORD: return [];');
var d3 = collectDefects(mutated2, actionMap);
check('D3 把映射改成 [] → 必须报出「恒 1003」缺陷',
  d3.some(function (x) { return x.indexOf('STORE_RESET_ALL_PASSWORD') >= 0 && x.indexOf('[]') >= 0; }),
  d3[0] || '(无)');

var fakeHashes = Object.assign({}, hashes);
fakeHashes[copies[0]] = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
var fakeDistinct = Object.keys(fakeHashes).reduce(function (acc, p) {
  if (acc.indexOf(fakeHashes[p]) < 0) { acc.push(fakeHashes[p]); }
  return acc;
}, []);
check('D4 副本一致性检查对「漏同步」有判别力（伪造 1 份不一致 → distinct=2）',
  fakeDistinct.length === 2, 'distinct=' + fakeDistinct.length);

/* ------------------------------ 收尾 ------------------------------ */
console.log('\n----------------------------------------------');
console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
console.log(fail === 0 ? 'AUTH-COVERAGE RESULT: ALL GREEN' : 'AUTH-COVERAGE RESULT: RED');
process.exitCode = fail === 0 ? 0 : 1;