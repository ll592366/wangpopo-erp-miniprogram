// ==========================================================================
// scripts/parse-std-table.js — 解析老板给的「王婆婆菜品份量标准表」为结构化 JSON
// 仅解析，不写数据。输出对照表，供后续核对。
// ==========================================================================
var fs = require('fs');
var path = require('path');

var raw = fs.readFileSync(path.resolve(__dirname, '..', 'tmp', 'std-table.txt'), 'utf8');

/**
 * 把一道菜的份量文字（例："牛肉片1包" / "肥肠1大包3份" / "基围虾1盒"）
 * 解析为 { itemName, qty:Number, unit:String, portions:Number|null }
 * 例外：克/条/勺 等单位进入"特殊情况"列表，让老板裁决。
 */
var STD = [];     // 标准表条目
var WEIRD = [];   // 没法直接解析的（克 / 条 / 勺 / 没填）
var current = { section: '', idx: 0 };

function parseItem(text) {
  // 例："牛肉片1包" / "鱿鱼耳丝3包2份" / "牛腱子180克一份" / "基围虾1盒" / "1包1份" / "1大包做4份" / "（腊肉100）克" / "（腊肉100克）"
  text = text.trim().replace(/^[(（]/, '').replace(/[)）]$/, '');
  if (!text) { return null; }
  // 1) 兜底：单位=份 但前一个食材没给 → 上一行或上一个 item 的份数（先不处理，仅提示）
  // 2) 「A + 单位 + 份数?」
  var m = text.match(/^(.*?)(\d+(?:\.\d+)?)(克|两|斤|公斤|kg|包|大包|小包|盒|件|只|条|勺)(?:做)?(?:(\d+)份)?(.*)$/);
  if (m) {
    var name = m[1].trim();
    var qty = Number(m[2]);
    var unit = m[3];
    var portions = m[4] ? Number(m[4]) : null;
    if (!name) {
      // 例：「1大包做4份」→ name 空，需要上一行的食材名
      return { raw: text, parsed: false, why: '没有食材名（继承前一行）', orphanQty: qty, orphanUnit: unit, orphanPortions: portions };
    }
    return { raw: text, name: name, qty: qty, unit: unit, portions: portions, parsed: true };
  }
  // 3) 「N + 单位 + 份数」内联（与 2 共享规则，但前置括号清掉后结构统一）
  return { raw: text, parsed: false, why: '未匹配到 单位模式' };
}

raw.split('\n').forEach(function (line) {
  line = line.trim();
  if (!line) { return; }
  var sec = line.match(/^[一二三四五六七八九十]+、(.+)$/);
  if (sec) { current.section = sec[1]; current.idx = 0; return; }
  var dish = line.match(/^\d+、(.+)$/);
  if (dish) {
    var name = dish[1].trim();
    // "：" 后面才是份量段（中文全角冒号 U+FF1A）
    var colon = name.indexOf('：');
    if (colon < 0) {
      STD.push({ section: current.section, name: name, items: [], raw: line });
      return;
    }
    var dishName = name.slice(0, colon).trim();
    var rest = name.slice(colon + 1).trim();
    var items = [];
    var prev = null;
    rest.split(/[，,、]/).forEach(function (seg) {
      var p = parseItem(seg);
      if (p && p.parsed) { items.push(p); prev = p; return; }
      // 兜底 A：「1大包做4份」没有食材名 → 绑定给 prev 的 portions
      if (p && p.why === '没有食材名（继承前一行）' && prev && p.orphanPortions) {
        prev.portions = p.orphanPortions;
        return;
      }
      if (p) { WEIRD.push({ section: current.section, dish: dishName, raw: p.raw, why: p.why }); }
    });
    STD.push({ section: current.section, name: dishName, items: items, raw: line });
    return;
  }
  // 续行（13、14、15 的多行）
  var cont = line.match(/^(\d+)、(.+)$/);
  if (cont) {
    var idx = Number(cont[1]);
    var rest = cont[2].trim();
    var items2 = [];
    var prev2 = null;
    rest.split(/[，,、]/).forEach(function (seg) {
      var p = parseItem(seg);
      if (p && p.parsed) { items2.push(p); prev2 = p; return; }
      if (p && p.why === '没有食材名（继承前一行）' && prev2 && p.orphanPortions) {
        prev2.portions = p.orphanPortions;
        return;
      }
      if (p) { WEIRD.push({ section: current.section, dish: '续行' + idx, raw: p.raw, why: p.why }); }
    });
    // 找最后一条同 section 的、把 items2 加进去（老板原文就把多道菜连着写）
    var last = STD[STD.length - 1];
    if (last) { items2.forEach(function (it) { last.items.push(it); }); }
  }
});

fs.writeFileSync(
  path.resolve(__dirname, '..', 'tmp', 'std-table.parsed.json'),
  JSON.stringify({ sectionCount: new Set(STD.map(function (s) { return s.section; })).size, total: STD.length, weird: WEIRD, dishes: STD }, null, 2),
  'utf8'
);
console.log('已解析 ' + STD.length + ' 道菜；无法解析的片段 ' + WEIRD.length + ' 条（详见 std-table.parsed.json）');
WEIRD.forEach(function (w) { console.log('  - [' + w.section + '] ' + w.raw + '  (' + w.why + ')'); });
