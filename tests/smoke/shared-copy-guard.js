// ==========================================================================
// tests/smoke/shared-copy-guard.js — 平铺副本一致性常驻守卫（2026-10-09）
//
// 背景：本项目的云函数依赖是**平铺副本**（每个 <fn>/db.js、<fn>/auth.js …），
// `cloudfunctions/_shared/` 只是源出处。任何一次改完 `_shared` 忘了同步所有副本，
// 对应的那个动作就会**静默失效**（历史上表现为莫名的 1003 / 算错库存），
// 且因为只有一个云函数目录会有症状，极难定位 —— 这是本项目长期最脆的一环。
//
// 本套提供一条**常驻**守卫（不是一次性检查）：
//   G1  cloudfunctions/ 下不得出现嵌套的 <fn>/_shared/ 死目录（曾误导排查）
//   G2  每个平铺副本若与 _shared 同名，必须**逐字节相同**（任一不同即红）
//   G3  每个副本必须导出 changeBalanceWith（新增余额写入函数的同步检查样例）
//   G4  require('./X') 必须能解析到实体文件（防止「该有的副本没同步过来」）
//   G5  变异注入自证：故意改坏一份副本 → 守卫必须转红（证明不是恒绿）
//
// ⚠️ 设计取舍（踩过的坑）：**不要**断言「_shared 里每个文件都必须出现在每个云函数目录」。
//    stockfix.js 只有 login / material 用到且只同步到这两个目录，这是**有意为之**，
//    照那样断言会产生 12 条假红。正确的不变式是双向的：
//      「副本若存在则必须与源逐字节相同」+「require 到的必须存在」。
//
// ⚠️ 扫描必须**显式以 cloudfunctions/ 为根**。仓库根下存在历史归档目录
//    （_legacy_nested_shared_2026-10-08/），里面躺着 13 份**陈旧** db.js
//    （缺 snapStock/quantizeStock）。若用 `**/_shared/db.js` 从仓库根扫，
//    会把这 13 份一起算进来 → 守卫失真。
// ==========================================================================
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var os = require('os');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var SHARED = path.join(CF, '_shared');

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }

function walk(dir, acc) {
  acc = acc || [];
  if (!fs.existsSync(dir)) { return acc; }
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, acc); } else { acc.push(p); }
  });
  return acc;
}
function rel(p) { return path.relative(PROJECT, p).replace(/\\/g, '/'); }

/* ==========================================================================
 * 核心守卫：**纯函数**，便于 G5 用合成目录树做变异注入自证
 * @param {string} root  等价 cloudfunctions/ 的目录
 * @returns {{drift:Array, nested:Array, missingExport:Array, requires:Array, copies:Array}}
 * ========================================================================== */
function scan(root) {
  var sharedDir = path.join(root, '_shared');
  var sharedFiles = {};
  if (fs.existsSync(sharedDir)) {
    walk(sharedDir).filter(function (p) { return /\.js$/.test(p); })
      .forEach(function (p) { sharedFiles[path.basename(p)] = p; });
  }

  var dirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
      .filter(function (e) { return e.isDirectory() && e.name !== '_shared'; })
      .map(function (e) { return e.name; })
    : [];

  var drift = [];       // 副本与源不同
  var nested = [];      // <fn>/_shared/ 死目录
  var missingExport = [];
  var brokenRequire = [];
  var copies = [];

  dirs.forEach(function (d) {
    var fnDir = path.join(root, d);
    var files = walk(fnDir).filter(function (p) { return /\.js$/.test(p); });

    files.forEach(function (p) {
      var r = path.relative(fnDir, p).replace(/\\/g, '/');
      // G1：嵌套 _shared 死目录
      if (r.indexOf('_shared/') === 0) { nested.push(rel(p)); return; }
      // G2：与 _shared 同名的必须逐字节相同
      var base = path.basename(p);
      if (r.indexOf('/') === -1 && sharedFiles[base]) {
        copies.push({ fn: d, name: base, file: p });
        var a = fs.readFileSync(p);
        var b = fs.readFileSync(sharedFiles[base]);
        if (!a.equals(b)) {
          drift.push({ fn: d, name: base, got: sha256(p), want: sha256(sharedFiles[base]) });
        }
      }
      // G4：require('./X') 必须解析到实体文件
      var src = fs.readFileSync(p, 'utf8');
      var re = /require\(\s*['"]\.\/([A-Za-z0-9_\-]+)['"]\s*\)/g;
      var m;
      while ((m = re.exec(src)) !== null) {
        var target = path.join(path.dirname(p), m[1] + '.js');
        if (!fs.existsSync(target)) { brokenRequire.push({ fn: d, file: rel(p), need: './' + m[1] }); }
      }
    });
  });

  // G3：副本必须导出 changeBalanceWith
  // ⚠️ 必须先失效 require 缓存再 require：Node 以解析后的绝对路径为 key 缓存模块，
  //    同一进程内第二次 scan()（G5 变异自证就是同一棵树扫多次）会拿到第一次的旧导出，
  //    导致「文件已改坏但导出检查仍认为正常」的假绿。首次 write 后必删缓存。
  copies.filter(function (c) { return c.name === 'db.js'; }).forEach(function (c) {
    var ok = false, reason = '';
    try {
      var resolved = require.resolve(c.file);
      delete require.cache[resolved];
      var m = require(c.file);
      ok = (typeof m.changeBalanceWith === 'function') && (typeof m.changeBalance === 'function');
      if (!ok) { reason = 'changeBalanceWith=' + typeof m.changeBalanceWith; }
    } catch (e) {
      reason = String((e && e.message) || e).slice(0, 80);
    }
    if (!ok) { missingExport.push({ fn: c.fn, name: c.name, reason: reason }); }
  });

  return { dirs: dirs, drift: drift, nested: nested, missingExport: missingExport, brokenRequire: brokenRequire, copies: copies, sharedCount: Object.keys(sharedFiles).length };
}

/* ======================= G1 ======================= */
section('G1 cloudfunctions 下不得存在嵌套 <fn>/_shared/ 死目录');
var R = scan(CF);
check('G1 嵌套 _shared 死目录数 === 0', R.nested.length === 0, R.nested.length + ' 个' + (R.nested.length ? '：' + R.nested.slice(0, 5).join('、') : ''));
console.log('     扫描根 = cloudfunctions/（显式限定，避免误纳仓库根的 _legacy_* 归档）');
console.log('     云函数目录 ' + R.dirs.length + ' 个：' + R.dirs.join(', '));
console.log('     _shared 源文件 ' + R.sharedCount + ' 个');

/* ======================= G2 ======================= */
section('G2 平铺副本与 _shared 逐字节相同');
console.log('     平铺副本总数 = ' + R.copies.length + '（每个云函数目录内、且 _shared 有同名源的文件）');
R.copies.forEach(function (c) {
  console.log('       ' + c.fn + '/' + c.name);
});
check('G2 逐字节一致的副本数 ' + R.copies.length + ' 条全部通过（不一致数 = 0）',
  R.drift.length === 0,
  '不一致 ' + R.drift.length + ' 条' + (R.drift.length ? '：' + R.drift.map(function (d) { return d.fn + '/' + d.name + ' got=' + d.got + ' want=' + d.want; }).join(' | ') : ''));

/* 汇总 hash（便于人工比对） */
var hashSet = {};
R.copies.concat(walk(SHARED).filter(function (p) { return /\.js$/.test(p); }).map(function (p) { return { fn: '_shared', name: path.basename(p), file: p }; }))
  .forEach(function (c) { hashSet['' + c.name] = (hashSet['' + c.name] || {}); hashSet['' + c.name][sha256(c.file)] = (hashSet['' + c.name][sha256(c.file)] || 0) + 1; });
Object.keys(hashSet).forEach(function (n) {
  var ks = Object.keys(hashSet[n]);
  console.log('     [' + n + '] distinct sha256[0:12] = ' + ks.length + '  → ' + ks.join(', '));
});
var dbDrift = hashSet['db.js'] ? Object.keys(hashSet['db.js']) : [];
check('G2b 所有 db.js（含 _shared）distinct hash 必须 = 1', dbDrift.length === 1,
  'distinct=' + dbDrift.length + ' → ' + dbDrift.join(', '));

/* ======================= G3 ======================= */
section('G3 每个 db.js 副本必须导出 changeBalance / changeBalanceWith');
check('G3 全部副本导出齐全（缺失 = 0）', R.missingExport.length === 0,
  '缺失 ' + R.missingExport.length + ' 条' + (R.missingExport.length ? '：' + JSON.stringify(R.missingExport) : ''));

/* ======================= G4 ======================= */
section('G4 require(./X) 必须解析到实体文件');
check('G4 无断链 require', R.brokenRequire.length === 0,
  '断链 ' + R.brokenRequire.length + ' 条' + (R.brokenRequire.length ? '：' + R.brokenRequire.map(function (b) { return b.fn + ' 需要 ' + b.need; }).join(' | ') : ''));

/* ======================= G5 变异注入自证 ======================= */
section('G5 变异注入自证（守卫必须能判别，不能是恒绿）');
(function () {
  var TMP = path.join(os.tmpdir(), 'guard-mut-' + process.pid);
  fs.rmSync(TMP, { recursive: true, force: true });
  // 合成一棵最小树：_shared/db.js + 两个函数目录各一份副本
  fs.mkdirSync(path.join(TMP, '_shared'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '_shared', 'db.js'),
    'module.exports = { changeBalance: function(){}, changeBalanceWith: function(){} };\n');
  ['fa', 'fb'].forEach(function (d) {
    fs.mkdirSync(path.join(TMP, d), { recursive: true });
    fs.writeFileSync(path.join(TMP, d, 'db.js'),
      'module.exports = { changeBalance: function(){}, changeBalanceWith: function(){} };\n');
    fs.writeFileSync(path.join(TMP, d, 'index.js'), "var db = require('./db');\n");
  });

  var clean = scan(TMP);
  console.log('     [基线] 干净树 drift=' + clean.drift.length + ' brokenRequire=' + clean.brokenRequire.length);
  check('G5-1 干净合成树必须 0 drift', clean.drift.length === 0, 'drift=' + clean.drift.length);

  // 变异 A：改坏 fb/db.js 一个字节
  fs.writeFileSync(path.join(TMP, 'fb', 'db.js'),
    'module.exports = { changeBalance: function(){} };\n');   // 少了 changeBalanceWith
  var mutA = scan(TMP);
  console.log('     [变异A] 改坏 fb/db.js → drift=' + mutA.drift.length + ' missingExport=' + mutA.missingExport.length);
  check('G5-2 改坏一份副本 → G2 必须转红', mutA.drift.length === 1, 'drift=' + mutA.drift.length);
  check('G5-3 且缺失 changeBalanceWith → G3 必须转红', mutA.missingExport.length === 1, 'missingExport=' + mutA.missingExport.length);

  // 变异 B：require('./nope') 断链
  fs.writeFileSync(path.join(TMP, 'fa', 'index.js'), "var nope = require('./nope');\n");
  var mutB = scan(TMP);
  console.log('     [变异B] fa/index.js require 不存在的 ./nope → brokenRequire=' + mutB.brokenRequire.length);
  check('G5-4 require 断链 → G4 必须转红', mutB.brokenRequire.length === 1, 'brokenRequire=' + mutB.brokenRequire.length);

  // 变异 C：偷偷塞一个嵌套 _shared 死目录
  fs.mkdirSync(path.join(TMP, 'fa', '_shared'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'fa', '_shared', 'db.js'), '// stale\n');
  var mutC = scan(TMP);
  console.log('     [变异C] fa/_shared/db.js → nested=' + mutC.nested.length);
  check('G5-5 嵌套死目录 → G1 必须转红', mutC.nested.length === 1, 'nested=' + mutC.nested.length);

  fs.rmSync(TMP, { recursive: true, force: true });
})();

/* ======================= G6 守卫自身的扫描根防御 ======================= */
section('G6 仓库根的 _legacy_* 归档不得干扰本守卫（显式扫描根）');
var legacy = fs.existsSync(PROJECT)
  ? fs.readdirSync(PROJECT, { withFileTypes: true })
    .filter(function (e) { return e.isDirectory() && e.name.indexOf('_legacy') === 0; })
    .map(function (e) { return e.name; })
  : [];
console.log('     仓库根下 _legacy_* 目录：' + (legacy.length ? legacy.join(', ') : '（无）'));
legacy.forEach(function (d) {
  var cnt = walk(path.join(PROJECT, d)).filter(function (p) { return path.basename(p) === 'db.js'; });
  if (!cnt.length) { return; }
  var stale = cnt.filter(function (p) { return sha256(p) !== sha256(path.join(SHARED, 'db.js')); }).length;
  console.log('       ' + d + '：含 db.js ' + cnt.length + ' 份，其中陈旧 ' + stale + ' 份');
  console.log('       → 若守卫用「仓库根 + **/_shared/db.js」扫描，会把它们算进来导致失真；本套以 cloudfunctions/ 为根，已规避');
});
check('G6 本守卫的 copies 集合不来自任何 _legacy 目录',
  R.copies.every(function (c) { return c.file.indexOf(path.join(PROJECT, 'cloudfunctions')) === 0; }),
  'copies=' + R.copies.length + ' 全部位于 cloudfunctions/ 下');

/* ======================= G7 所有冒烟套件必须能被解析 =======================
 * 起因（我自己的事故，2026-10-09 复查时发现）：给 gen-report.js 的 SUITES 数组加第 15 项时
 * 漏了逗号 → 整个文件 SyntaxError。而 gen-report.js 平时没人跑（跑套件都是单独 node 的），
 * 于是这个坏掉的文件一直躺在那儿，直到某天真要出报告才发现。
 * 所以补一条常驻守卫：tests/smoke 下**每个** .js 都必须能被 vm.Script 解析。
 * ⚠️ 不能用 child_process（本机 spawnSync 恒 EBUSY），改用 vm.Script 只**解析不执行**。
 */
section('G7 tests/smoke 下每个套件都必须能被解析（漏逗号 = 整份报告跑不出来）');
var vm = require('vm');
var SMOKE = __dirname;
var suiteFiles = fs.readdirSync(SMOKE).filter(function (n) { return /\.js$/.test(n); });
var broken = [];
suiteFiles.forEach(function (n) {
  var p = path.join(SMOKE, n);
  try {
    new vm.Script(fs.readFileSync(p, 'utf8'), { filename: p });
  } catch (e) {
    broken.push(n + ' → ' + e.message);
  }
});
check('G7 全部 ' + suiteFiles.length + ' 个套件文件语法可解析', broken.length === 0,
  broken.length ? broken.join(' ; ') : '0 个坏文件');
check('G7 新增套件必须登记进 gen-report.js 的 SUITES（否则报告里永远看不到它）', (function () {
  var gr = fs.readFileSync(path.join(SMOKE, 'gen-report.js'), 'utf8');
  var missing = suiteFiles.filter(function (n) {
    // 「套件」的判据：会自己打「合计 N 条」的那份。桩(mock-sdk)/工具(log-capture)/入口(gen-report)都不打。
    if (n === 'gen-report.js') { return false; }          // 入口自己，不必登记自己
    var src = fs.readFileSync(path.join(SMOKE, n), 'utf8');
    if (src.indexOf('合计') < 0) { return false; }
    return gr.indexOf("'" + n + "'") < 0;
  });
  check('   （明细）未登记的套件', missing.length === 0, missing.join(', ') || '（无）');
  return missing.length === 0;
})());

console.log('\n合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
