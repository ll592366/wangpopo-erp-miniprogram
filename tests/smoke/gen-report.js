// ==========================================================================
// tests/smoke/gen-report.js — 跑完 4 套冒烟测试，汇总成一份 Markdown 报告
// 用法： node tests/smoke/gen-report.js
// 产出： tests/smoke/冒烟测试报告_<YYYY-MM-DD>.md
// 说明：不依赖 shell（grep/tail/date 在部分环境不可用），全用 Node 完成
// ==========================================================================
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var DIR = __dirname;
var SUITES = [
  { file: 'mgr-migration.js', title: '0. 管理端默认账号 888/888888 · 迁移与僵尸账号清理专项' },
  { file: 'smoke.js', title: '1. 主链路（13 个云函数全流程）' },
  { file: 'smoke-edge.js', title: '2. 边界（闭店 / 跨日 / 库存不足 / 重名 / 日志真写入）' },
  { file: 'smoke-negctl.js', title: '3. 参数化负向对照 + 故障注入（真·半扣断言）' },
  { file: 'mat-spec.js', title: '5. 档案录入（规格字段）+ 采购按 itemId 入库' },
  { file: 'purchase-autopick.js', title: '5b. 采购页「自动关联」运行期（进页即选中 + 规格/单位自动带出）' },
  { file: 'notice-bar.js', title: '5c. 首页滚动通知栏（预警 + 待确认申请）' },
  { file: 'goods-edit.js', title: '5d. 食材档案「编辑」（补规格，种子档案规格为空的根治口）' },
  { file: 'dish-edit.js', title: '5e. 菜品「编辑」（点菜卡改食材/用量/份数）' },
  { file: 'search-picker.js', title: '5f. 食材下拉弹窗（自定义可搜索 · 替代微信 picker 弹层）' },
  { file: 'ui-rules.js', title: '6. 前端交互规则（不强制首登改密 / 密码框眼睛 / 档案录入 vs 采购只选 / _uid 链路）' },
  { file: 'pagination-export.js', title: '7. 分页 / 全量导出命门（时间区间不跳不漏 · 循环拉取 · CSV 展开 · 门店隔离）' },
  { file: 'net-error-text.js', title: '8. 网络/超时错误提示（传输层原文不外泄）' },
  { file: 'material-delete-stock-edit.js', title: '9. 食材删除 / 总仓数量覆盖（引用检查 · 3 位精度）' },
  { file: 'human-error-text.js', title: '10. 报错文案人话化（异常不外泄 · 日志中文标签覆盖）' },
  { file: 'dish-delete.js', title: '11. 菜品删除（出品记录引用检查 · 负对照 · 无级联残留）' },
  { file: 'auth-coverage.js', title: '12. 权限映射覆盖（ACTION 常量 ↔ actionToRequiredRoles 全量对齐 · 副本一致性 · 反向自证）' },
  { file: 'precision-3dp.js', title: '13. 精度体系 3 位小数（入参归一化 · 盘点差异 · 导出 · 报表 · 增量调整 · 静态守卫）' },
  { file: 'system-diag.js', title: '14. 系统繁忙可诊断化（响应顶层 diag · missing-doc 多形态判定 · 放宽不吞错）' },
  { file: 'shared-copy-guard.js', title: '15. 平铺副本一致性常驻守卫（逐字节比对 · require 断链 · 嵌套死目录 · 变异注入自证）' },
  { file: 'store-threshold.js', title: '16. 门店级预警阈值（权限 / 入参校验 / 阈值来源按语境切换 / 总仓反向保留 / op_log 留痕）' },
  { file: 'calibrate.js', title: '17. 库存校准（覆盖式改库存 / 该食材单独阈值 / 权限 / 校准记录双写与分页 / 前端弹窗入口）' },
  { file: 'requisition-adjust.js', title: '18. 要货单「修改数量」requisition.adjust（改后量结清 · 删行不结清 · 整单拒绝 · note 不外泄 id · 前后端口径）' },
  { file: 'off-shelf.js', title: '19. 食材下架 isActive（三入口方向守卫：只许清零不许加 · list 仅「下架且为0」隐藏 · 负库存不许藏 · toggle 留痕 · 前后端口径）' },
  { file: 'list-search.js', title: '20. 列表检索 + 100 条静默截断根治（total/truncated 说出来 · 新建的排最前且在窗口内 · 四接口不丢 · 11 处本地检索不打后端 · onShow 不冲搜索 · 静态守卫）' }
];

function stamp() {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function day() {
  return stamp().slice(0, 10);
}

var out = [];
out.push('王婆婆家常菜 · 微信小程序 ERP —— 本地冒烟测试报告');
out.push('生成时间：' + stamp());
out.push('');

var summary = [];
SUITES.forEach(function (s) {
  var r = cp.spawnSync(process.execPath, [path.join(DIR, s.file)], { encoding: 'utf8' });
  var text = (r.stdout || '') + (r.stderr || '');
  out.push('## ' + s.title + '（' + s.file + '）');
  out.push('');
  out.push('```');
  out.push(text.trim());
  out.push('```');
  out.push('');
  var m = text.match(/合计 (\d+) 条：通过 (\d+)，失败 (\d+)/);
  summary.push({
    name: s.file,
    total: m ? m[1] : '?',
    pass: m ? m[2] : '?',
    fail: m ? m[3] : '?',
    code: r.status,
    // parsed=false 表示套件根本没吐出汇总行（spawn 被拦 / 脚本崩在断言前）。
    // 这种套件一条都没验证过，绝不能被当成 0 失败。
    parsed: !!m
  });
});

out.splice(3, 0, (function () {
  var lines = ['## 汇总', '', '| 套件 | 条数 | 通过 | 失败 | 退出码 |', '|---|---|---|---|---|'];
  var T = 0, P = 0, F = 0;
  var notParsed = [], badExit = [];
  summary.forEach(function (s) {
    lines.push('| ' + s.name + ' | ' + s.total + ' | ' + s.pass + ' | ' + s.fail + ' | ' + s.code + ' |');
    T += Number(s.total) || 0; P += Number(s.pass) || 0; F += Number(s.fail) || 0;
    if (!s.parsed) { notParsed.push(s.name); }
    if (s.code !== 0) { badExit.push(s.name); }
  });
  lines.push('| **合计** | **' + T + '** | **' + P + '** | **' + F + '** | — |');
  lines.push('');

  // 结论必须建立在「每个套件都真的跑完并报了数」之上。
  // 只要有套件没吐汇总行或非零退出，就不许出现 ALL GREEN 字样。
  if (notParsed.length) {
    lines.push('| ⚠️ 未产出汇总行 | ' + notParsed.length + ' 个：' + notParsed.join('、') + ' |');
    lines.push('');
  }
  if (badExit.length) {
    lines.push('| ⚠️ 非零退出 | ' + badExit.length + ' 个：' + badExit.join('、') + ' |');
    lines.push('');
  }

  if (notParsed.length || badExit.length) {
    lines.push('**结论：报告不可信 —— 有套件未跑完，上面合计（' + T + ' 条 / 失败 ' + F +
      '）是残值，禁止当作通过。先修 spawn/套件本身再重跑。**');
  } else {
    lines.push(F === 0 ? '**结论：全部通过（ALL GREEN，共 ' + T + ' 条）**' : '**结论：存在失败用例，需修复**');
  }
  lines.push('');
  return lines.join('\n');
})());

var dest = path.join(DIR, '冒烟测试报告_' + day() + '.md');
fs.writeFileSync(dest, out.join('\n'), 'utf8');
console.log('报告已生成：' + dest);
summary.forEach(function (s) {
  console.log('  ' + s.name + '  ' + s.pass + '/' + s.total + '（失败 ' + s.fail + '）' +
    (s.parsed ? '' : '  [未产出汇总行]') + (s.code === 0 ? '' : '  [退出码 ' + s.code + ']'));
});
// 未解析到汇总行的套件 = 一条都没验证，必须让整体退出码非零，
// 否则 hook / CI 会把「没跑起来」当成「跑过了」。
process.exitCode = summary.some(function (s) { return !s.parsed || s.code !== 0; }) ? 1 : 0;
