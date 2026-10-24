// ==========================================================================
// scripts/audit-dishes.js — 把老板的「菜品份量标准表」与代码种子 SEED_DISHES 做对照体检
// 输出三类清单：一致 / 菜品差异 / 标准表独有（或种子独有）。不写数据。
// ==========================================================================
var fs = require('fs');
var path = require('path');
var PROJECT = path.resolve(__dirname, '..');

var STD = JSON.parse(fs.readFileSync(path.join(PROJECT, 'tmp', 'std-table.parsed.json'), 'utf8'));
var SEED_SRC = fs.readFileSync(path.join(PROJECT, 'cloudfunctions', 'login', 'index.js'), 'utf8');

// 从源码里抽出 SEED_DISHES 数组（只取文本，不真的求值）
function extractSeeds(src) {
  var m = src.match(/var\s+SEED_DISHES\s*=\s*\[([\s\S]*?)\n\];/);
  if (!m) { return []; }
  var block = m[1];
  // 拆每道：D('名字', '类', [[itemId,qty,unit,portions], ...])
  var dishes = [];
  var re = /D\('([^']+)'\s*,\s*'([^']+)'\s*,\s*\[([\s\S]*?)\]\)/g;
  var dm;
  while ((dm = re.exec(block))) {
    var name = dm[1], cat = dm[2], items = dm[3];
    var rows = [];
    var ir = /\[\s*'([^']+)'\s*,\s*([\d.]+)\s*,\s*'([^']+)'\s*(?:,\s*([\d.]+))?\s*\]/g;
    var im;
    while ((im = ir.exec(items))) {
      rows.push({ itemId: im[1], qty: Number(im[2]), unit: im[3], portions: im[4] ? Number(im[4]) : null });
    }
    dishes.push({ name: name, category: cat, items: rows });
  }
  return dishes;
}

function normalize(name) {
  return name.replace(/[（()]/g, '').replace(/[（]/g, '').trim();
}

function normItemsByName(it) {
  return it.map(function (x) {
    // 老板拍板："1份" 就是默认 1，seed 里 portions=null 等价于 portions=1（云函数公式 `qty/(portions||1)`）
    var p = (x.portions == null || x.portions === '' || x.portions === 'null') ? 1 : Number(x.portions);
    return {
      name: normalize(x.name || x.itemId),
      qty: Number(x.qty),
      unit: x.unit,
      portions: p
    };
  }).sort(function (a, b) {
    return (a.name + a.unit + a.qty + (a.portions || '')).localeCompare(b.name + b.unit + b.qty + (b.portions || ''));
  });
}

var SEEDS = extractSeeds(SEED_SRC);
console.log('种子菜品 ' + SEEDS.length + ' 道；标准表 ' + STD.dishes.length + ' 道');

// 按菜名归一映射
var seedByKey = {};
SEEDS.forEach(function (d) { seedByKey[normalize(d.name)] = d; });
var stdByKey = {};
STD.dishes.forEach(function (d) { stdByKey[normalize(d.name)] = d; });

var matched = [], onlySeed = [], onlyStd = [], diffItems = [];

Object.keys(seedByKey).forEach(function (k) {
  if (!stdByKey[k]) { onlySeed.push(seedByKey[k].name); return; }
  var a = normItemsByName(seedByKey[k].items);
  var b = normItemsByName(stdByKey[k].items);
  var same = a.length === b.length && a.every(function (x, i) {
    return x.name === b[i].name && x.qty === b[i].qty && x.unit === b[i].unit && x.portions === b[i].portions;
  });
  if (same) { matched.push(seedByKey[k].name); }
  else {
    diffItems.push({
      name: seedByKey[k].name,
      seed: seedByKey[k].items,
      std:  stdByKey[k].items
    });
  }
});
Object.keys(stdByKey).forEach(function (k) {
  if (!seedByKey[k]) { onlyStd.push(stdByKey[k].name); }
});

console.log('--- 一致 ' + matched.length + ' 道：');
matched.forEach(function (n) { console.log('  ✓ ' + n); });
console.log('\n--- 份量不一致 ' + diffItems.length + ' 道：');
diffItems.forEach(function (d) {
  console.log('  ⚠ ' + d.name);
  console.log('    种子: ' + JSON.stringify(d.seed));
  console.log('    标准: ' + JSON.stringify(d.std));
});
console.log('\n--- 标准表有、代码里没有 ' + onlyStd.length + ' 道：');
onlyStd.forEach(function (n) { console.log('  + ' + n); });
console.log('\n--- 种子有、标准表没列 ' + onlySeed.length + ' 道：');
onlySeed.forEach(function (n) { console.log('  - ' + n); });

// 写报告
fs.writeFileSync(path.join(PROJECT, 'tmp', 'dish-audit.json'), JSON.stringify({
  matched: matched, diffItems: diffItems, onlyStd: onlyStd, onlySeed: onlySeed,
  weirdFromStd: STD.weird
}, null, 2), 'utf8');
