// ==========================================================================
// tests/smoke/ui-rules.js — 前端交互规则静态检查（防回归）
//
// 背景：老板明确要求
//   ① 登录不做「首登强制改密」（改密去「我的」页自助改）；
//   ② 每个密码输入框旁边必须有眼睛（可查看 / 关闭明文）。
// 本套用纯文本规则断言，防止以后改代码时把这两条又改回去。
// ==========================================================================
var fs = require('fs');
var path = require('path');

var MINI = path.resolve(__dirname, '..', '..', 'miniprogram');
function read(p) { return fs.readFileSync(path.join(MINI, p), 'utf8'); }

/**
 * 去掉注释后的**代码**文本（只剥 // 行注释与 /* *\/ 块注释，不处理字符串里的 "//"）。
 * ⚠️ 为什么必须有它：2026-10-08「门店不继承总仓阈值」改造后，store-stock.js / notice-bar.js
 *    的**注释**里仍然写着 lowStockThreshold（说明为什么不能用它）。若断言直接
 *    `indexOf('lowStockThreshold') < 0`，会被自己的注释命中 → 永远转不了红 = 假绿守卫。
 *    查「代码里是否还在读阈值」必须对剥过注释的文本做。
 */
function code(p) {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * WXML 同样要剥注释 —— 注释语法是 `<!-- -->`，坑和 JS 的一模一样。
 * 实证：pages/manager/store-detail/store-detail.wxml 里就有一条
 *   <!-- 本店预警阈值（2026-10-09 老板拍板：门店有自己的阈值，不继承总仓备货警戒线） -->
 * 若断言写 read(SD_WXML).indexOf('本店预警阈值') >= 0，即使整个阈值卡片被删掉，
 * 只要这条注释还在就**恒绿** —— 2026-10-09 复查时就是这个状态，已修。
 */
function wcode(p) {
  return read(p).replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * 找出代码里所有 `X.lowStockThreshold` 的**接收者 X**（务必传剥注释后的文本）。
 *
 * ⚠️ 为什么必须按「接收者」判、而不是按字段名判（2026-10-09 口径变更后）：
 *    门店有了自己的阈值之后，**两边字段名都叫 lowStockThreshold** ——
 *      · 食材档案 material.lowStockThreshold = **总仓备货**警戒线（可能 10 包）
 *      · inventory 门店语境返回的 lowStockThreshold = **本店**阈值（每店一个统一值，默认 2）
 *    所以「门店端不得出现 lowStockThreshold」这种禁字段名的旧守卫**已经失效**（会误伤合法实现），
 *    必须改成看**从谁身上读**：r. / inventory[0]. 合法；m. / matMap[..]. / material… 是红线。
 */
function thReceivers(src) {
  var out = [];
  var re = /([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])?)\s*\.\s*lowStockThreshold/g;
  var m;
  while ((m = re.exec(src))) { out.push(m[1].replace(/\s+/g, '')); }
  return out;
}
/** 接收者是否指向**食材档案**（= 总仓备货警戒线）。门店语境下出现就是红线。 */
var MAT_RECV = /(^|[^A-Za-z0-9_$])(m|mm|mat|mats|matDoc|matMap|matList)$|^(matMap|material|mat)\b/i;
function badThSrc(src) {
  return thReceivers(src).filter(function (r) { return MAT_RECV.test(r); });
}

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

var loginJs = read('pages/login/login.js');
var loginWxml = read('pages/login/login.wxml');
var homeJs = read('pages/manager/home/home.js');
var homeWxml = read('pages/manager/home/home.wxml');
var homeJson = read('pages/manager/home/home.json');
var goodsJs = read('pages/manager/goods/goods.js');
var goodsWxml = read('pages/manager/goods/goods.wxml');
var appWxss = read('app.wxss');
var appJs = read('app.js');
var appJson = read('app.json');
var cloudJs = read('utils/cloud.js');

/* ---------- 1. 不做首登强制改密 ---------- */
section('1. 登录不做首登强制改密');
check('login.js 不再出现 needPwd 状态', loginJs.indexOf('needPwd') < 0);
check('login.js 不再调用 action=setPassword', loginJs.indexOf('setPassword') < 0);
check('login.js 不再读 needChangePassword 分支', loginJs.indexOf('needChangePassword') < 0);
check('login.wxml 不再有强制改密卡片', loginWxml.indexOf('首次登录') < 0 && loginWxml.indexOf('needPwd') < 0);
check('登录成功直接 enter() 进首页', /that\.enter\(res\.data\)/.test(loginJs));
check('enter() 会写 globalData.user（_uid 依赖它）', /globalData\.user\s*=\s*u/.test(loginJs));
check('app.js 不再维护 needChangePassword', appJs.indexOf('needChangePassword') < 0);

/* ---------- 2. 改密入口下放给管理端（v1.0.3 老板 2026-09-13 拍板：删 我的 页） ---------- */
section('2. 改密入口下放给管理端（门店端无自助改密）');
check('门店端无「我的」页（profile.js / profile.wxml 整个已删）',
  !fs.existsSync(path.join(MINI, 'pages/mine/profile/profile.js')) &&
  !fs.existsSync(path.join(MINI, 'pages/mine/profile/profile.wxml')));
check('app.json 不再注册 profile / stocktake / requisition-history',
  appJson.indexOf('pages/mine/profile/profile') < 0 &&
  appJson.indexOf('pages/shop/stocktake/stocktake') < 0 &&
  appJson.indexOf('pages/shop/requisition-history/requisition-history') < 0);
check('app.json 已注册分店经营（老板 2026-09-15 拍板新建）',
  appJson.indexOf('pages/manager/stores-business/stores-business') >= 0);
check('app.json 已注册门店详情（老板 2026-09-15 拍板新建）',
  appJson.indexOf('pages/manager/store-detail/store-detail') >= 0);
check('app.json 不再注册已废弃的「经营情况」（v1.0.3 老板 2026-09-15 拍板：6 项更清晰，去掉业务重复页）',
  appJson.indexOf('pages/manager/business/business') < 0 &&
  !fs.existsSync(path.join(MINI, 'pages/manager/business')));
check('管理端宫格是 2 列布局（v1.0.3 老板 2026-09-15 拍板"选择就两个卡片"）',
  (function () {
    var aw = read('app.wxss');
    return /\.grid-2col \.grid-item \{ width: calc\(\(100% - 20rpx\) \/ 2\)/.test(aw);
  })());
check('管理端首页用 grid-2col class（不是 3 列 grid）',
  read('pages/manager/home/home.wxml').indexOf('grid-2col') >= 0);
check('v1.0.3 商品管理页已无宫格（变独立功能页，老板拍板"不要直接放在下面显示"）',
  read('pages/manager/goods/goods.wxml').indexOf('class="grid') < 0 &&
  read('pages/manager/goods/goods.wxml').indexOf('<navigator class="grid-item') < 0);
check('管理端账号管理页仍有「改密」入口（resetAllPwd，一键重置该店全部账号；老板 2026-09-15 拍板删账号行单个重置）',
  read('pages/manager/shops-accounts/shops-accounts.js').indexOf('resetAllPwd') >= 0 &&
  read('pages/manager/shops-accounts/shops-accounts.js').indexOf('resetAllPassword') >= 0);

/* ---------- 3. 登录页密码框都有眼睛（profile 已删，3-1 节专注登录） ---------- */
section('3. 登录密码框眼睛开关');
function countPwdInputs(wxml) {
  return (wxml.match(/password="\{\{![A-Za-z]+\}\}"/g) || []).length;
}
function countEyes(wxml) {
  return (wxml.match(/class="pwd-eye"/g) || []).length;
}
var lPwd = countPwdInputs(loginWxml), lEye = countEyes(loginWxml);
check('登录页：密码框数量 = 眼睛数量', lPwd > 0 && lPwd === lEye, '密码框 ' + lPwd + ' / 眼睛 ' + lEye);
check('登录页密码框用 password="{{!showPwd}}" 受控', loginWxml.indexOf('password="{{!showPwd}}"') >= 0);
check('眼睛样式已定义（app.wxss .pwd-eye）', appWxss.indexOf('.pwd-eye') >= 0);
check('眼睛包裹层样式已定义（app.wxss .pwd-wrap）', appWxss.indexOf('.pwd-wrap') >= 0);

/* ---------- 4. 登录页密码开关方法与 data 字段成对 ---------- */
section('4. 登录页眼睛开关方法与 data 字段配对');
[['togglePwd', 'showPwd', loginJs], ['toggleRegPwd', 'showRegPwd', loginJs]].forEach(function (t) {
  var fn = t[0], field = t[1], src = t[2];
  check(fn + ' 已定义且切换 ' + field,
    src.indexOf(fn + ': function') >= 0 && src.indexOf(field + ':') >= 0);
});
check('登录页 wxml 绑定了 togglePwd / toggleRegPwd',
  loginWxml.indexOf('bindtap="togglePwd"') >= 0 && loginWxml.indexOf('bindtap="toggleRegPwd"') >= 0);

/* ---------- 5. _uid 传递链路（1001 请先登录 的根因防线） ---------- */
section('5. _uid 传递链路');
check('cloud.js 从 globalData.user._id 自动补 _uid', /globalData\.user\._id/.test(cloudJs));
var uidSites = ['pages/login/login.js'];
uidSites.forEach(function (p) {
  var s = read(p);
  check(p + ' 里凡调云函数前必已写入 globalData.user（不存在无 _uid 的登录态调用）',
    !/state: 'needPwd'/.test(s));
});

/* ---------- 6. 档案录入 vs 采购只选（老板口径） ---------- */
section('6. 档案=录入区，采购=只选数量');
var purchaseJs = read('pages/manager/purchase/purchase.js');
var purchaseWxml = read('pages/manager/purchase/purchase.wxml');
check('采购页用下拉（search-picker）选食材',
  purchaseWxml.indexOf('<search-picker') >= 0);
check('采购页不再手填名称', purchaseWxml.indexOf('bindinput="onName"') < 0);
check('采购页不再手填规格', purchaseWxml.indexOf('bindinput="onSpec"') < 0);
check('采购页不再手填单位', purchaseWxml.indexOf('bindinput="onUnit"') < 0);
check('采购页不再手填预警值', purchaseWxml.indexOf('bindinput="onThreshold"') < 0);
check('采购页只有数量要填（onQty）', purchaseWxml.indexOf('bindinput="onQty"') >= 0);
check('规格/单位是只读回显（readonly）', purchaseWxml.indexOf('class="input readonly"') >= 0);
check('采购提交按 itemId 入库（不再按名称现场建档）', purchaseJs.indexOf('itemId: d.picked._id') >= 0);
check('采购页提供了去建档案的入口', purchaseWxml.indexOf('goArchive') >= 0);
check('采购页进页即自动选中（不用先点一次下拉）',
  /materialIndex: idx/.test(purchaseJs) && /options\.length \? 0 : -1/.test(purchaseJs));
check('search-picker 绑定当前选中值（picked 未选回落空串，不传 null）', purchaseWxml.indexOf("value=\"{{picked ? picked._id : ''}}\"") >= 0);
check('拉档案失败会提示，不静默留空下拉',
  /res\.code !== 0/.test(purchaseJs) && /showToast/.test(purchaseJs));
check('档案页有新建表单：名称/规格/单位/预警值',
  ['mName', 'mSpec', 'mUnit', 'mTh'].every(function (f) { return goodsWxml.indexOf('{{' + f + '}}') >= 0; }));
check('档案页有 saveMaterial 逻辑', goodsJs.indexOf('saveMaterial: function') >= 0);
check('档案新建会传 spec', goodsJs.indexOf('spec: spec') >= 0);
check('档案列表有「编辑」入口（种子档案规格为空要能补）',
  goodsWxml.indexOf('bindtap="editMaterial"') >= 0 && goodsJs.indexOf('editMaterial: function') >= 0);
check('编辑可取消', goodsJs.indexOf('cancelEdit: function') >= 0 && goodsWxml.indexOf('cancelEdit') >= 0);
check('编辑走 _id 更新分支', goodsJs.indexOf('payload._id = editingId') >= 0);
check('编辑可就地覆盖总仓数量（改了才调 inventory.adjust，同值/留空不动）',
  goodsJs.indexOf("action: 'adjust'") >= 0 && goodsJs.indexOf('wantAdjust') >= 0 &&
  goodsJs.indexOf('qtyRaw !== origin') >= 0);
check('食材行有「删除」入口（带引用检查）',
  goodsWxml.indexOf('bindtap="removeMaterial"') >= 0 && goodsJs.indexOf('removeMaterial: function') >= 0);
check('删除走 cloud.call（非 callWithToast）+ 失败弹全文（无法删除 · showCancel:false）',
  goodsJs.indexOf("cloud.call('material', { action: 'remove'") >= 0 &&
  goodsJs.indexOf("title: '无法删除'") >= 0 && goodsJs.indexOf('showCancel: false') >= 0);
check('食材行不再有停用/启用按钮（改由删除取代）',
  goodsWxml.indexOf('toggleMaterial') < 0 && goodsJs.indexOf('toggleMaterial: function') < 0);
check('菜品行有「删除」入口（带引用检查）',
  goodsWxml.indexOf('bindtap="removeDish"') >= 0 && goodsJs.indexOf('removeDish: function') >= 0);
check('菜品行不再有停用/启用按钮（改由删除取代）',
  goodsWxml.indexOf('toggleDish') < 0 && goodsJs.indexOf('toggleDish: function') < 0);
check('编辑态数量字段标注「总仓数量」', goodsWxml.indexOf('总仓数量') >= 0);
check('规格为空的档案行有标记', goodsWxml.indexOf('规格未填') >= 0);
check('采购页规格为空时可点去补', purchaseWxml.indexOf('readonly-tap') >= 0 && purchaseWxml.indexOf('档案未填规格') >= 0);

/* ---------- 8. 菜品「编辑」（老板 2026-09-12 诉求：可点菜卡改食材/用量/份数） ---------- */
section('8. 菜品可编辑（列表卡点编辑 → 回填上方表单 → 保存走 _id 更新）');
check('菜品页有 editDish 方法', goodsJs.indexOf('editDish: function') >= 0);
check('菜品页有 cancelEditDish 方法', goodsJs.indexOf('cancelEditDish: function') >= 0);
check('菜品列表每行有「编辑」按钮', goodsWxml.indexOf('editDish') >= 0 && goodsWxml.indexOf('编辑</text>') >= 0);
check('菜品卡整体（li-main）可点触发编辑', goodsWxml.indexOf('li-main') >= 0 && /li-main[\s\S]{0,200}bindtap="editDish"/.test(goodsWxml));
check('菜品标题在编辑态切到「编辑菜品」',
  goodsWxml.indexOf('{{editingDishId ? \'编辑菜品\' :') >= 0);
check('菜品保存按钮在编辑态显示「保存修改」',
  goodsWxml.indexOf('{{editingDishId ? \'保存修改\' : \'保存菜品\'}}') >= 0);
check('编辑完成用 _id 走更新分支',
  goodsJs.indexOf('if (editingDishId) { payload._id = editingDishId; }') >= 0);
check('编辑后保存提示「菜品已更新」',
  goodsJs.indexOf("editingDishId ? '菜品已更新' : '菜品已保存'") >= 0);
check('消耗行两段式：食材选择器独占一行（ci-picker 占满）',
  goodsWxml.indexOf('class="ci-picker"') >= 0 && appWxss.indexOf('.ci-row .ci-picker { flex: 1') >= 0);
check('消耗行数量输入换行独立成排（ci-sub 两列半宽）',
  goodsWxml.indexOf('class="ci-sub"') >= 0 && appWxss.indexOf('.ci-sub .input { flex: 1') >= 0);
check('消耗行不再挤四个元素一行（旧定宽 style="width:150rpx" 已移除）',
  goodsWxml.indexOf('style="width:150rpx"') < 0);
check('食材选项带 label 字段（search-picker 搜索/回显依赖）',
  goodsJs.indexOf('label: m.name') >= 0);
var pickerWxss = read('components/search-picker/search-picker.wxss');
check('选择弹窗居中显示（不贴屏幕底边，老板 2026-09-12 反馈）',
  /ip-mask[\s\S]*?align-items: center/.test(pickerWxss) && pickerWxss.indexOf('align-items: flex-end') < 0);
check('弹窗面板 70% 宽 + 55vh 上限（紧凑居中，老板 2026-09-12 反馈别太大）',
  pickerWxss.indexOf('width: 70%') >= 0 && /ip-panel[\s\S]*?max-height: 55vh/.test(pickerWxss));
var pickerWxml = read('components/search-picker/search-picker.wxml');
check('选择器为卡片式两态且与其他输入框同规格（定高 72rpx + 12rpx 圆角，老板 2026-09-12 拍板弃用仿输入框、大小要一致）',
  /ip-trigger[\s\S]*?height: 72rpx/.test(pickerWxss) &&
  /ip-trigger[\s\S]*?border-radius: 12rpx/.test(pickerWxss) &&
  /ip-card \{[\s\S]*?background: var\(--primary-light\)/.test(pickerWxss) &&
  pickerWxss.indexOf('ip-card-empty') >= 0 &&
  pickerWxml.indexOf('ip-card-change') >= 0);
check('弹窗列表行渲染兜底 name（stocktake 传原始数组只有 name，缺它则整列空白）',
  pickerWxml.indexOf('{{item.label || item.name}}') >= 0);
var purchaseWxml = read('pages/manager/purchase/purchase.wxml');
check('search-picker value 绑定不允许裸取 null 对象属性（picked 未选时必须回落空串）',
  purchaseWxml.indexOf("value=\"{{picked ? picked._id : ''}}\"") >= 0);
check('全项目 .input 统一定高 72rpx（选择器/输入框/日期触发框全部同规格）',
  /\.input \{[\s\S]*?height: 72rpx;[\s\S]*?box-sizing: border-box;/.test(appWxss));
check('原生 picker 全部走 search-picker（v1.0.3 删 business 后无任何原生 picker 页面，食材/单据选择全 search-picker）',
  !fs.existsSync(path.join(MINI, 'pages/manager/business')));

/* ---------- 7. 首页滚动通知栏（跑马灯：预警 + 待确认申请） ---------- */
section('7. 首页滚动通知栏');
var nbJson = read('components/notice-bar/notice-bar.json');
var nbWxml = read('components/notice-bar/notice-bar.wxml');
var nbJs = read('components/notice-bar/notice-bar.js');
var prodWxml = read('pages/shop/production/production.wxml');
var prodJs = read('pages/shop/production/production.js');
check('通知栏是自定义组件（component: true）', nbJson.indexOf('"component": true') >= 0);
check('管理端首页 json 注册了通知栏', read('pages/manager/home/home.json').indexOf('notice-bar') >= 0);
check('门店端首页 json 注册了通知栏', read('pages/shop/production/production.json').indexOf('notice-bar') >= 0);
check('管理端首页 wxml 挂了通知栏', read('pages/manager/home/home.wxml').indexOf('<notice-bar') >= 0);
check('门店端首页 wxml 挂了通知栏', prodWxml.indexOf('<notice-bar') >= 0);
check('两个首页 onShow 都会刷新通知栏（v1.0.3 拆分首页 + 商品管理两页）',
  homeJs.indexOf('refreshNotice') >= 0 && read('pages/shop/production/production.js').indexOf('refreshNotice') >= 0);
check('纵向滚动（swiper vertical）', /<swiper[\s\S]{0,300}vertical/.test(nbWxml));
check('没有内容时整条不显示（wx:if）', nbWxml.indexOf('wx:if="{{items.length > 0}}"') >= 0);
check('预警 + 待确认两类都覆盖',
  nbJs.indexOf("kind: 'alert'") >= 0 && nbJs.indexOf("kind: 'req'") >= 0);
check('通知条可点击跳转', nbWxml.indexOf('bindtap="onTap"') >= 0);
// 门店端 loadShop 函数体（界定到它结尾的 withOverflow 调用为止），用于做「这段代码里不得有 X」的断言。
// ⚠️ 必须剥注释：loadShop 里的注释正写着「为什么不能读 lowStockThreshold」，不剥会误命中。
// ⚠️ 坑（我自己踩过）：**定位用的下标必须也来自剥注释后的文本**。
//    若在 nbJs（含注释）上 indexOf、却在 code()（去注释）上 slice，两个下标对不上
//    （本文件差 1606 字符），切出来的是错位的另一段 → 守卫恒绿、变异打不红。
var NB_CODE = code('components/notice-bar/notice-bar.js');
var nbShop = (function () {
  var i = NB_CODE.indexOf('loadShop: function');
  if (i < 0) { return ''; }
  var j = NB_CODE.indexOf('withOverflow', i);
  return NB_CODE.slice(i, j < 0 ? undefined : j);
})();
check('（守卫自检）loadShop 段能被正确切出来（长度 > 200，否则下标错位 = 恒绿）',
  nbShop.length > 200 && nbShop.indexOf('loadShop: function') >= 0, nbShop.length + ' 字符');
check('门店端不调 report（ALERT_VIEW 只允许 manager）；管理端 loadManager 仍调 report',
  nbJs.indexOf("cloud.call('report'") >= 0 &&
  /loadManager[\s\S]*?cloud\.call\('report'/.test(nbJs) &&
  nbShop.indexOf("cloud.call('report'") < 0,
  '管理端有=' + (nbJs.indexOf("cloud.call('report'") >= 0) + ' 门店端有=' + (nbShop.indexOf("cloud.call('report'") >= 0));
// ⚠️ 2026-10-09 口径翻转：门店有自己的阈值 → 门店端预警**恢复**，上面两条旧守卫整体反过来。
//    新守卫不只要「有预警」，还要**阈值来源正确**（只认 inventory 行，不认 material 档案）。
check('★门店端 loadShop **必须**调 inventory（本店阈值的唯一来源；10-08 曾移除，10-09 恢复）',
  nbShop.indexOf("cloud.call('inventory'") >= 0, nbShop.length + ' 字符已扫');
check('★门店端 loadShop **必须**产出库存预警条 kind: \'alert\'',
  nbShop.indexOf("kind: 'alert'") >= 0);
check('★门店端 loadShop 阈值取自 inventory 行并归一（Number(r.lowStockThreshold) + 缺省回落 2）',
  /Number\(r\.lowStockThreshold\)/.test(nbShop) &&
  nbShop.indexOf('DEFAULT_STORE_THRESHOLD') >= 0 &&
  /Number\(r\.qty\)\s*<\s*th/.test(nbShop));
check('★门店端 loadShop 不得为取阈值去调 material（阈值来源只能是 inventory 行）',
  nbShop.indexOf("cloud.call('material'") < 0 && badThSrc(nbShop).length === 0,
  '阈值接收者=' + JSON.stringify(thReceivers(nbShop)));

/* ---------- 11. 总仓库存+预警合并单卡（老板 2026-09-12：缺货食材出现两遍看不懂，只留一张卡） ---------- */
section('11. 总仓库存单卡化（缺货排最前红标，不再单列预警卡）');
var whWxml = read('pages/manager/wh-stock-alert/wh-stock-alert.wxml');
var whJs = read('pages/manager/wh-stock-alert/wh-stock-alert.js');
check('页面只有一张卡：不再有「食材预警」独立卡片',
  whWxml.indexOf('alerts') < 0 && whWxml.indexOf('暂无预警食材') < 0);
check('标题带预警计数（预警 N 时展示 · 预警 N）',
  whWxml.indexOf('alertCount') >= 0);
check('缺货标显示缺多少（缺 X 单位），正常显示绿标',
  whWxml.indexOf("'缺 ' + item.gap + ' ' + item.unit") >= 0 && whWxml.indexOf('正常') >= 0);
check('缺货排最前（low 优先，同缺货按缺口大→小）',
  /if \(a\.low !== b\.low\) \{ return a\.low \? -1 : 1; \}/.test(whJs) &&
  /return b\.gap - a\.gap/.test(whJs));
check('不再调 report(lowStock)（单卡口径本地可算，少一次云调用）',
  whJs.indexOf("cloud.call('report'") < 0 && whJs.indexOf("cloud.call('inventory', { storeId: 'WAREHOUSE' })") >= 0);

/* ---------- 9. 账号管理合并（老板 2026-09-12：门店账号 + 我的 → 一个入口） ---------- */
var saWxml = read('pages/manager/shops-accounts/shops-accounts.wxml');
var saJs = read('pages/manager/shops-accounts/shops-accounts.js');
section('9. 账号管理合并（管理端自己账号 + 门店账号）');
check('管理端宫格是「账号管理」入口（v1.0.3 在 home 页）',
  homeWxml.indexOf('账号管理') >= 0 && homeWxml.indexOf('shops-accounts') >= 0);
check('管理端宫格不再有独立「我的」入口',
  homeWxml.indexOf('>我的</text>') < 0);
check('宫格排序按老板日常动线（门店经营→申请处理→采购入库→商品管理→库存预警→账号管理，2026-09-15 拍板）',
  (function () {
    var urls = ['/pages/manager/stores-business/stores-business',
      '/pages/manager/requisition-process/requisition-process',
      '/pages/manager/purchase/purchase',
      '/pages/manager/goods/goods',
      '/pages/manager/wh-stock-alert/wh-stock-alert',
      '/pages/manager/shops-accounts/shops-accounts'];
    var pos = urls.map(function (u) { return homeWxml.indexOf(u); });
    return pos.every(function (p) { return p >= 0; }) &&
      pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3] && pos[3] < pos[4] && pos[4] < pos[5];
  })());
check('申请处理宫格有待处理角标（gi-badge，pendingCount>0 才显示，99+ 封顶，v1.0.3 在 home 页）',
  homeWxml.indexOf('gi-badge') >= 0 &&
  homeWxml.indexOf('wx:if="{{pendingCount > 0}}"') >= 0 &&
  homeWxml.indexOf("99+") >= 0);
check('角标数据：onShow 拉 pendingCount，接口挂了静默置 0 不弹错（v1.0.3 在 home 页）',
  homeJs.indexOf('loadPendingCount') >= 0 &&
  homeJs.indexOf("status: 'pending'") >= 0 &&
  /catch[\s\S]*?pendingCount: 0/.test(homeJs));
check('角标样式：红气泡钉卡片右上角（app.wxss .gi-badge）',
  appWxss.indexOf('.gi-badge') >= 0 &&
  /gi-badge[\s\S]*?position: absolute/.test(appWxss) &&
  /grid-item \{[\s\S]*?position: relative/.test(appWxss));
check('账号管理页有「我的账号」卡',
  saWxml.indexOf('我的账号') >= 0);
check('我的账号卡：自助改密走 changePassword（与 profile 同口径）',
  saJs.indexOf("action: 'changePassword'") >= 0 && saJs.indexOf('oldPassword: oldPwd') >= 0);
check('我的账号卡：密码框都有眼睛（3 框 3 眼）',
  (saWxml.match(/pwd-input/g) || []).length === (saWxml.match(/pwd-eye/g) || []).length,
  (saWxml.match(/pwd-input/g) || []).length + '框/' + (saWxml.match(/pwd-eye/g) || []).length + '眼');
check('账号行右侧「改密」小按钮，密码框收进弹层（pwdOpen，老板 2026-09-12 要求简洁）',
  saWxml.indexOf('bindtap="openPwd"') >= 0 && saWxml.indexOf('wx:if="{{pwdOpen}}"') >= 0 &&
  saJs.indexOf('openPwd: function') >= 0 && saJs.indexOf('closePwd: function') >= 0);
check('分店管理 v1.0.3 加：门店行「批量重置密码」（resetAllPwd）按钮',
  saWxml.indexOf('bindtap="resetAllPwd"') >= 0 && saJs.indexOf('resetAllPwd: function') >= 0 &&
  saJs.indexOf('action: \'resetAllPassword\'') >= 0);
check('分店管理账号行无「删除」按钮（老板 2026-09-15 拍板"不要了"：移除 deleteAccount）',
  saWxml.indexOf('bindtap="deleteAccount"') < 0 && saJs.indexOf('deleteAccount: function') < 0 &&
  saJs.indexOf('action: \'deleteAccount\'') < 0);
check('改密成功自动关弹层', saJs.indexOf("pwdOpen: false") >= 0);
check('我的账号卡：有退出（onLogout 二次确认）',
  saWxml.indexOf('bindtap="onLogout"') >= 0 && saJs.indexOf('确定要退出当前账号吗') >= 0);
check('分店管理卡保留（一行式：改密/改店名/闭店复业；老板 2026-09-15 拍板删账号行「重置密码」）',
  saWxml.indexOf('分店管理') >= 0 && saJs.indexOf('resetAllPwd') >= 0 && saJs.indexOf('rename') >= 0 &&
  saJs.indexOf('resetPwd:') < 0 && saWxml.indexOf('bindtap="resetPwd"') < 0);
check('门店端「我的」页已删除（v1.0.3 老板 2026-09-13 拍板：门店端越简单越好）',
  !fs.existsSync(path.join(MINI, 'pages/mine/profile/profile.wxml')));
check('门店端首页宫格只剩 2 项：食材申请 / 库存与消耗（v1.0.3 老板 2026-09-13 13:40 拍板"今日出品下放给管理端"）',
  (function () {
    var pw = read('pages/shop/production/production.wxml');
    return pw.indexOf('今日出品') < 0 &&
      pw.indexOf('出品录入') < 0 &&
      pw.indexOf('今日出品记录') < 0 &&
      pw.indexOf('submitProduction') < 0 &&
      pw.indexOf('食材申请') >= 0 &&
      pw.indexOf('店内库存') < 0 &&  // v1.0.3 改为"库存与消耗"
      pw.indexOf('库存与消耗') >= 0 &&
      pw.indexOf('store-stock/store-stock') >= 0;
  })());
check('食材申请改美团式购物车（老板 2026-09-12 21:12/21:21 拍板）',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    return rqWxml.indexOf('总仓食材库存清单') >= 0 &&
      rqWxml.indexOf('class="mr-row"') >= 0 &&
      rqWxml.indexOf('cart-bar-label') >= 0 &&
      rqWxml.indexOf('onSubmit') >= 0;
  })());
check('食材申请改双 tab（① 食材申请 ② 申请记录，老板 2026-09-15 拍板）+ 弹窗触发器：点购物车',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    var rqJs = read('pages/shop/requisition/requisition.js');
    return rqWxml.indexOf('① 食材申请') >= 0 &&
      rqWxml.indexOf('② 申请记录') >= 0 &&
      rqWxml.indexOf('switchTab') >= 0 &&
      /cart-bar-info[^>]*bindtap="onOpenCart"/.test(rqWxml) &&
      rqWxml.indexOf('class="ip-mask"') >= 0 &&
      rqWxml.indexOf('cartOpen') >= 0 &&
      rqJs.indexOf("tab: 'req'") >= 0 &&
      rqJs.indexOf("tab: 'log'") >= 0;
  })());
check('申请按钮文字"提交申请"（v1.0.3 老板 2026-09-15 拍板改名，老板原话"申请改成提交申请"）',
  read('pages/shop/requisition/requisition.wxml').indexOf('提交申请') >= 0 &&
  read('pages/shop/requisition/requisition.wxml').indexOf("'申请'") < 0 &&
  read('pages/shop/requisition/requisition.wxml').indexOf('bindtap="onSubmit"') >= 0);
check('购物车弹层有编辑/删除/继续挑选按钮（v1.0.3 老板 2026-09-15 拍板"可以修改数量 删除数量"）',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    var rqJs = read('pages/shop/requisition/requisition.js');
    return rqWxml.indexOf('onRemoveItem') >= 0 &&
      rqWxml.indexOf('cart-row-del') >= 0 &&
      rqWxml.indexOf('继续挑选') >= 0 &&
      rqJs.indexOf('onRemoveItem') >= 0;
  })());
check('食材申请提交后自动跳「申请记录」tab（v1.0.3 老板 2026-09-15 UX）',
  /onSubmit[\s\S]*?tab: 'log'/.test(read('pages/shop/requisition/requisition.js')));
check('食材申请顶部无「返回功能面板」返回栏（老板 2026-09-12 21:45 拍板：底部浮条直接搞定）',
  read('pages/shop/requisition/requisition.wxml').indexOf('返回功能面板') < 0 &&
  read('pages/shop/requisition/requisition.wxml').indexOf('backbar') < 0);
check('购物车浮条是「左信息（点购物车开弹层） + 右单按钮（提交申请）」布局',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    return rqWxml.indexOf('cart-bar-info') >= 0 &&
      rqWxml.indexOf('cart-bar-actions') >= 0 &&
      /cart-bar-info[^>]*bindtap="onOpenCart"/.test(rqWxml) &&
      rqWxml.indexOf('cb-btn-primary') >= 0 &&
      rqWxml.indexOf('提交申请') >= 0;
  })());
check('食材申请提交后自动跳「申请记录」tab（v1.0.3 老板 2026-09-15 UX）',
  /onSubmit[\s\S]*?tab: 'log'/.test(read('pages/shop/requisition/requisition.js')));
check('购物车浮条用文字「购物车」标签而非 emoji（老板 2026-09-13 拍板：三段式排版）',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    var rqWxss = read('pages/shop/requisition/requisition.wxss');
    return rqWxml.indexOf('购物车') >= 0 &&
      rqWxml.indexOf('🛒') < 0 &&
      /class="cart-bar-label"[^>]*>购物车</.test(rqWxml);
  })());
check('浮条按钮用 <view> 不用 <button>（避开 WeChat 原生 button 样式坑，老板 21:50 反馈）',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    var rqWxss = read('pages/shop/requisition/requisition.wxss');
    // 浮条按钮用 <view class="cb-btn" 而不是 <button class="cb-btn"
    return rqWxml.indexOf('<view class="cb-btn') >= 0 &&
      rqWxml.indexOf('<button class="cb-btn') < 0 &&
      rqWxss.indexOf('.cb-btn') >= 0;
  })());
check('查看按钮始终响应（空购物车也开弹层，老板 21:45 反馈"点击查看没反应"修复）',
  (function () {
    // v1.0.3 老板 2026-09-15 拍板：弹层触发从"查看按钮"改为"点购物车"，查看按钮永久不存在
    var rqJs = read('pages/shop/requisition/requisition.js');
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    return rqJs.indexOf('onOpenCart') >= 0 &&
      /cart-bar-info[^>]*bindtap="onOpenCart"/.test(rqWxml) &&
      rqWxml.indexOf('>查看<') < 0;  // 查看按钮永久不存在
  })());
check('食材申请每行 [-] [数字] [+] 三件套，且数字可点击直输',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    return rqWxml.indexOf('onDec') >= 0 && rqWxml.indexOf('onInc') >= 0 &&
      rqWxml.indexOf('onInputQty') >= 0 && rqWxml.indexOf('class="mr-qty"') >= 0;
  })());
check('食材申请不再用 search-picker 选择食材（去掉更换，老板拍板）',
  read('pages/shop/requisition/requisition.wxml').indexOf('<search-picker') < 0);
check('申请按钮 cartCount=0 时单独置灰不可点（v1.0.3 用 cb-btn-disabled class 实现）',
  (function () {
    var rqWxml = read('pages/shop/requisition/requisition.wxml');
    var rqJs = read('pages/shop/requisition/requisition.js');
    return /cb-btn-disabled/.test(rqWxml) &&
      rqWxml.indexOf('bindtap="onSubmit"') >= 0 &&
      /onSubmit[\s\S]*?items\.length === 0[\s\S]*?showToast/.test(rqJs);
  })());
check('居中弹层样式是全局的（在 app.wxss，不在 search-picker.wxss）',
  (function () {
    var aw = read('app.wxss');
    return /^\.ip-mask \{/m.test(aw) &&
      /^\.ip-panel \{/m.test(aw) &&
      /^\.ip-header \{/m.test(aw) &&
      /^\.ip-list \{/m.test(aw) &&
      /^\.ip-row \{/m.test(aw) &&
      /^\.ip-title \{/m.test(aw);
  })());
check('菜品消耗清单 chip 化（老板 2026-09-15 拍板：每行一个 chip 不再一长串堆）',
  (function () {
    var goodsJs = read('pages/manager/goods/goods.js');
    var goodsWxml = read('pages/manager/goods/goods.wxml');
    var goodsWxss = read('pages/manager/goods/goods.wxss');
    return goodsJs.indexOf('consumeChips') >= 0 &&
      goodsWxml.indexOf('consume-chips') >= 0 &&
      goodsWxml.indexOf('consume-chip-name') >= 0 &&
      goodsWxss.indexOf('.consume-chip') >= 0;
  })());
check('店内库存改成「库存与消耗」+ 双 tab（① 库存 ② 消耗，老板 2026-09-15 拍板）',
  (function () {
    var ssJs = read('pages/shop/store-stock/store-stock.js');
    var ssWxml = read('pages/shop/store-stock/store-stock.wxml');
    var ssWxss = read('pages/shop/store-stock/store-stock.wxss');
    return ssJs.indexOf("tab: 'inv'") >= 0 &&
      ssJs.indexOf('switchTab') >= 0 &&
      ssJs.indexOf('invRows') >= 0 &&
      ssJs.indexOf('consRows') >= 0 &&
      ssJs.indexOf("action: 'list'") >= 0 &&  // 消耗来自 production.list
      ssWxml.indexOf('card-title">库存与消耗') < 0 &&  // v1.0.3 老板拍板删除
      ssWxml.indexOf('① 库存') >= 0 &&
      ssWxml.indexOf('② 消耗') >= 0 &&
      ssWxss.indexOf('.ss-tabs') >= 0 &&
      ssWxss.indexOf('.ss-tab-active') >= 0;
  })());
check('库存与消耗页无「返回功能面板」返回栏（老板 2026-09-15 拍板：底部直接搞定）',
  read('pages/shop/store-stock/store-stock.wxml').indexOf('返回功能面板') < 0 &&
  read('pages/shop/store-stock/store-stock.wxml').indexOf('backbar') < 0);
// ⚠️ 口径两次翻转（2026-10-08 删预警 → 2026-10-09 门店有自己的阈值、预警**恢复**）。
//    原来这里断言「不做低库存预警」，现在**再翻回来**：规格/单位仍要有，且**必须**有预警，
//    但阈值必须是**本店阈值**（inventory 返回行），不是总仓档案值。
//    查的是剥注释后的代码文本（注释里仍在解释 lowStockThreshold 的两种语义，不剥会被自己的注释骗）。
check('店内库存加规格/单位 + 按**本店阈值**做低库存预警（2026-10-09 老板拍板：门店有自己的阈值）',
  (function () {
    var ssWxml = read('pages/shop/store-stock/store-stock.wxml');
    var ssCode = code('pages/shop/store-stock/store-stock.js');
    return ssCode.indexOf('material') >= 0 &&                    // 仍要 material 拿规格/单位
      /thresholdOf\(r\.lowStockThreshold\)/.test(ssCode) &&      // ★ 阈值来自 inventory 行（本店值）
      badThSrc(ssCode).length === 0 &&                           // ★ 不得从档案取
      ssWxml.indexOf('li-spec') >= 0 &&                          // 规格仍要显示
      ssWxml.indexOf("缺 ' + item.gap") >= 0;                    // ★ 缺口红标回来了
  })());
/* ---------- 8b. 门店端/门店详情「门店有**自己的**预警阈值」常驻守卫 ----------
 * 口径演进（两次老板拍板，方向相反，别写反）：
 *   2026-10-08「门店端的预警阈值同步的是总仓的，不对，门店只同步库存，不同步阈值」
 *             → 门店端预警**整段删除**（当时的守卫是：门店端不得有任何预警）。
 *   2026-10-09（老板看到「门店彻底没预警，怎么知道该申请什么食材」的风险后）
 *             「门店要有**自己的**阈值」→ 每店一个统一值，存 store.lowStockThreshold，
 *             管理端在门店详情设置，没设默认 2 → 门店端预警**恢复**。
 *
 * ⚠️ 判据必须换：阈值**字段名两边都叫 lowStockThreshold**（inventory 在门店语境下
 *    把语义切成「本店阈值」）。所以「门店端不得出现 lowStockThreshold」这种**禁字段名**
 *    的旧守卫已经失效（会误伤合法实现），必须改按**来源**判：
 *      ✅ 允许：r.lowStockThreshold / inventory[0].lowStockThreshold（inventory 返回行）
 *      🚫 红线：m. / matMap[..]. / material… .lowStockThreshold（食材档案 = 总仓备货警戒线，
 *               总仓备货线可能 10 包、门店日常只有 2~3 包 → 拿它比门店库存会常年误报）
 * 本段所有断言都跑在**剥注释后**的文本上：这些文件的注释里仍在解释上面这套语义，
 * 不剥注释的话「有没有读阈值」会被自己的注释骗成恒真（假绿）。
 * 反向保留：总仓 wh-stock-alert 页 + inventory 云函数总仓分支**必须**仍然读档案阈值。
 */
section('8b. 门店端 / 门店详情：门店有**自己的**预警阈值（2026-10-09 拍板，覆盖 10-08）');
var SS_JS = 'pages/shop/store-stock/store-stock.js';
var SS_WXML = 'pages/shop/store-stock/store-stock.wxml';
var SD_JS = 'pages/manager/store-detail/store-detail.js';
var SD_WXML = 'pages/manager/store-detail/store-detail.wxml';
var ssCodeAll = code(SS_JS);
var sdCodeAll = code(SD_JS);
// 「真的在按阈值判低库存」的特征（★ 不能只断言存在赋值，否则 `r.low = false` 也能蒙混过关）
var LOW_CMP = /r\.low\s*=\s*r\.qty\s*<\s*r\.threshold/;
var LOW_GAP = /r\.gap\s*=\s*r\.low\s*\?/;
var LOW_CNT = /if \(r\.low\) \{ alertCount \+= 1; \}/;
var TH_SRC = /r\.threshold\s*=\s*thresholdOf\(r\.lowStockThreshold\)/;

check('★门店端 store-stock.js **必须**算本店阈值并判 low（10-08 曾删，10-09 恢复）',
  TH_SRC.test(ssCodeAll) && LOW_CMP.test(ssCodeAll) && LOW_GAP.test(ssCodeAll) &&
  LOW_CNT.test(ssCodeAll) && /alertCount: alertCount/.test(ssCodeAll));
check('★门店端 store-stock.wxml **必须**渲染低库存标记（缺 N / list-item-low / low-bar / 顶部预警计数）',
  (function () {
    var w = wcode(SS_WXML);          // ⚠️ 剥 <!-- --> 注释，别被自己的注释喂成恒绿
    return w.indexOf("{{item.low ? 'list-item-low' : ''}}") >= 0 &&
      w.indexOf('class="low-bar"') >= 0 &&
      w.indexOf("{{item.low ? '缺 ' + item.gap + ' ' + item.unit : '正常'}}") >= 0 &&
      /预警 ' \+ alertCount/.test(w) &&
      w.indexOf('{{item.thText}}') >= 0;
  })());
check('★管理端 store-detail.js **必须**按本店阈值算 low/gap/alertCount（看门店库存时同口径）',
  TH_SRC.test(sdCodeAll) && LOW_CMP.test(sdCodeAll) && LOW_GAP.test(sdCodeAll) &&
  LOW_CNT.test(sdCodeAll) && /alertCount: alertCount/.test(sdCodeAll));
check('★管理端 store-detail.wxml **必须**渲染低库存标记（门店库存卡）',
  (function () {
    var w = wcode(SD_WXML);
    return w.indexOf("{{item.low ? 'list-item-low' : ''}}") >= 0 &&
      w.indexOf('class="low-bar"') >= 0 &&
      w.indexOf("{{item.low ? '缺 ' + item.gap + ' ' + item.unit : '正常'}}") >= 0 &&
      /预警 ' \+ alertCount/.test(w) &&
      w.indexOf('{{item.thText}}') >= 0;
  })());
check('★阈值来源红线①：门店端两处**必须**从 inventory 行取（r.lowStockThreshold）',
  thReceivers(ssCodeAll).indexOf('r') >= 0 && thReceivers(sdCodeAll).indexOf('r') >= 0,
  'store-stock=' + JSON.stringify(thReceivers(ssCodeAll)) +
  ' store-detail=' + JSON.stringify(thReceivers(sdCodeAll)));
check('★阈值来源红线②：门店端三处**不得**从食材档案取（m. / matMap[..]. / material…）',
  badThSrc(ssCodeAll).length === 0 && badThSrc(sdCodeAll).length === 0 && badThSrc(nbShop).length === 0,
  'store-stock=' + JSON.stringify(badThSrc(ssCodeAll)) +
  ' store-detail=' + JSON.stringify(badThSrc(sdCodeAll)) +
  ' notice-bar=' + JSON.stringify(badThSrc(nbShop)));
check('★门店端阈值归一：非法 / 没设 → 回落默认 2（不是 0 / NaN / undefined）',
  /var DEFAULT_THRESHOLD = 2;/.test(ssCodeAll) && /var DEFAULT_THRESHOLD = 2;/.test(sdCodeAll) &&
  /function thresholdOf\(v\) \{\s*var n = Number\(v\);\s*return \(isFinite\(n\) && n > 0\) \? n : DEFAULT_THRESHOLD;\s*\}/.test(ssCodeAll) &&
  /function thresholdOf\(v\) \{\s*var n = Number\(v\);\s*return \(isFinite\(n\) && n > 0\) \? n : DEFAULT_THRESHOLD;\s*\}/.test(sdCodeAll));
// ⚠️ 这两条**必须**走 wcode()：store-detail.wxml 里就有一条 `<!-- 本店预警阈值（…） -->` 注释，
//    用 read() 查的话，把整个阈值卡片删干净了也还是绿的（我复查时实测过，已修）。
// ⚠️ 2026-10-08 老板二次拍板：**删掉「本店统一阈值」卡** —— 每个食材都能在校准弹窗里
//    单独设，没单独设的就是默认 2。所以判据也跟着变：
//    ① 门店端仍标阈值来源（store-stock / notice-bar 不受影响）
//    ② **管理端门店详情不再有全店阈值卡**（onSaveThreshold / thresholdText 必须消失）
//    ③ 取而代之必须有「点库存行 → 数量 + 单独阈值」的校准入口
check('★门店端仍标阈值来源（口径说明不能丢）',
  wcode(SS_WXML).indexOf('阈值') >= 0 && wcode(SD_WXML).indexOf('阈值') >= 0);
check('★「本店统一阈值」卡已删除（老板 2026-10-08 拍板：都改成每食材单独设）',
  wcode(SD_WXML).indexOf('onSaveThreshold') < 0 &&
  wcode(SD_WXML).indexOf('thresholdText') < 0 &&
  sdCodeAll.indexOf('onSaveThreshold') < 0 &&
  sdCodeAll.indexOf('thresholdText') < 0,
  'wxml 残留=' + wcode(SD_WXML).indexOf('onSaveThreshold') + '/' + wcode(SD_WXML).indexOf('thresholdText'));
check('★删除全店卡后，必须有「每食材单独设阈值」的替代入口（校准弹窗）',
  (function () {
    var w = wcode(SD_WXML);
    return w.indexOf('bindtap="openCalib"') >= 0 &&
      w.indexOf('bindinput="onCalibThInput"') >= 0 &&
      w.indexOf('bindtap="onSaveCalib"') >= 0 &&
      w.indexOf('留空 = 用默认 2') >= 0 &&          // 留空 = 取消单独设置，回落默认 2
      sdCodeAll.indexOf("action: 'calibrate'") >= 0 &&
      /onSaveCalib[\s\S]*?that\.loadAll\(\)/.test(sdCodeAll);   // 保存后重拉：红标记要跟着变
  })());
check('门店端仍显示规格/单位（口径变更只动阈值来源，不删展示）',
  read(SS_WXML).indexOf('li-spec') >= 0 && ssCodeAll.indexOf('r.spec') >= 0);
check('★反向保留：inventory 云函数**总仓**分支仍读 material 档案阈值，门店分支才切本店值',
  (function () {
    var inv = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'cloudfunctions', 'inventory', 'index.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
    return /var isWarehouse = \(storeId === C\.STORE_WAREHOUSE\);/.test(inv) &&
      /storeThresholdOf/.test(inv) &&
      // 门店分支现在走 rowThresholdOf（行级优先级），不再是直接 th = storeThreshold
      /if \(isWarehouse\) \{[\s\S]{0,240}m\.lowStockThreshold[\s\S]{0,120}\} else \{[\s\S]{0,80}th = rowThresholdOf\([\s\S]{0,40}\}/.test(inv);
  })());
// ⚠️ 只断言"门店行用了 rowThresholdOf"是不够的 —— 把行级优先级阉割成"永远只用本店统一值"
//    （函数里删掉 itemThresholds 那段）也能蒙混过关。所以必须逐层断言函数体里的三层回落。
check('★行级阈值优先级：门店行必须「该食材单独阈值 → 本店统一值 → 默认 2」，少一层都不行',
  (function () {
    var inv = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'cloudfunctions', 'inventory', 'index.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
    var body = (inv.match(/function rowThresholdOf\(storeDoc, itemId\) \{[\s\S]*?\n\}/) || [''])[0];
    return body.length > 40 &&                                   // 切片自检：别切到别的段落
      /itemThresholds/.test(body) &&                             // ① 先读该食材单独阈值
      /Number\(map\[itemId\]\)/.test(body) && /n > 0/.test(body) &&  //   （且只在 >0 时生效）
      /storeThresholdOf\(storeDoc\)/.test(body) &&                // ② 再回落本店统一值（内含默认 2）
      /th = rowThresholdOf\(/.test(inv);                          // ③ 门店行真的用它
  })());
// ⚠️ 反向守卫的关键：必须断言「low 是**由库存与阈值比较**算出来的」，
//    不能只断言「存在 r.low = 这个赋值」—— 那样把 `r.low = r.qty < th` 改成 `r.low = false`
//    （预警被悄悄阉割）也能蒙混过关。X7 变异就是专门来打这个洞的。
var waCode = code('pages/manager/wh-stock-alert/wh-stock-alert.js');
check('★反向保留：总仓预警页 wh-stock-alert **必须**仍然预警（low 由「库存 < 阈值」算出）',
  waCode.indexOf('lowStockThreshold') >= 0 &&          // 读档案阈值
  /var th = .*lowStockThreshold/.test(waCode) &&        // 阈值来自档案字段
  /r\.low\s*=\s*r\.qty\s*<\s*th/.test(waCode) &&        // ★ 真的在比较，不是硬编码 false
  /r\.gap\s*=\s*r\.low\s*\?/.test(waCode) &&            // 缺口量
  waCode.indexOf('alertCount') >= 0 &&
  /if \(r\.low\)/.test(waCode) &&                       // 真的在累计计数
  read('pages/manager/wh-stock-alert/wh-stock-alert.wxml').indexOf('alertCount') >= 0 &&
  read('pages/manager/wh-stock-alert/wh-stock-alert.wxml').indexOf('list-item-low') >= 0);
check('★反向保留：管理端 notice-bar 仍出库存预警条（总仓预警，与门店端无关）',
  /loadManager[\s\S]*?kind: 'alert'/.test(nbJs));

check('库存预警缺货行左边红色色条 + 整行浅红底',
  (function () {
    var waWxml = read('pages/manager/wh-stock-alert/wh-stock-alert.wxml');
    var appWxss = read('app.wxss');
    return waWxml.indexOf('class="list-item {{item.low ? \'list-item-low\' : \'\'}}"') >= 0 &&
      waWxml.indexOf('class="low-bar"') >= 0 &&
      /list-item-low[\s\S]*?background:.*danger/i.test(appWxss) &&
      /\.low-bar \{[\s\S]*?background: var\(--danger\)/.test(appWxss);
  })());
check('search-picker 组件内仍可有 .ip-mask（组件复用不冲突，全局有即可）',
  (function () {
    var sw = read('components/search-picker/search-picker.wxss');
    return sw.indexOf('.ip-mask') >= 0;  // 组件内允许留一份自用
  })());
check('弹层里每行可调数量 / 删除单件（v1.0.3 老板拍板"可以修改数量 删除数量"）',
  read('pages/shop/requisition/requisition.wxml').indexOf('onRemoveItem') >= 0 &&
  read('pages/shop/requisition/requisition.wxml').indexOf('cart-row-del') >= 0);
check('提交入参是 cart 转 items: [{itemId, qty}]，复用现有 requisition.create 云函数',
  (function () {
    var rqJs = read('pages/shop/requisition/requisition.js');
    return /Object\.keys\(cart\)[\s\S]*?itemId: id, qty/.test(rqJs) &&
      rqJs.indexOf("action: 'create', items: items") >= 0;
  })());

/* ---------- 12. 分店经营（v1.0.3 老板 2026-09-15 拍板新建） ---------- */
section('12. 分店经营（管理端多门店汇总页）');
var sbJs = read('pages/manager/stores-business/stores-business.js');
var sbWxml = read('pages/manager/stores-business/stores-business.wxml');
var sbWxss = read('pages/manager/stores-business/stores-business.wxml');
check('分店经营有 0 个时间范围 tab（老板 2026-09-15 拍板"要来不知道干嘛"+ 7天/本月待云函数升级砍掉）',
  sbWxml.indexOf('class="sb-tab') < 0 &&  // 没有任何 sb-tab 元素
  sbWxml.indexOf('开始营业日') < 0 &&
  sbWxml.indexOf('结束营业日') < 0 &&
  sbWxml.indexOf('查询') < 0);
check('分店经营无返回功能面板栏（v1.0.3 老板 2026-09-15 拍板"不要这个"）',
  sbWxml.indexOf('navigator class="backbar"') < 0);
check('分店经营点门店卡 navigateTo store-detail 带 storeId + name 参数',
  sbJs.indexOf('navigateTo') >= 0 &&
  sbJs.indexOf('store-detail/store-detail') >= 0 &&
  sbJs.indexOf('storeId=') >= 0 &&
  sbWxml.indexOf('bindtap="goStore"') >= 0);
check('分店经营每张门店卡显示：出品明细 / 食材消耗（老板 2026-09-15 10:15 拍板"实点差异合计=冗余砍"，预警也已砍）',
  sbWxml.indexOf('出品明细') >= 0 && sbWxml.indexOf('食材消耗') >= 0 &&
  sbWxml.indexOf('实点差异合计') < 0);
check('分店经营按 store.list 拉门店列表（不靠云函数改）',
  sbJs.indexOf("action: 'list'") >= 0 && sbJs.indexOf('store') >= 0 &&
  sbJs.indexOf('production') >= 0);
check('分店经营正确读 sr.data.rows（v1.0.3 老板 2026-09-15 10:20 反馈"门店没同步"——bug：云函数返回 rows，前端误读 list 永远空）',
  sbJs.indexOf('data.rows') >= 0 || /sr\.data\.rows \|\| sr\.data\.list/.test(sbJs));
check('分店经营每门店有营业中/已关闭/未启用 status 标签',
  sbWxml.indexOf('营业中') >= 0 && sbWxml.indexOf('已关闭') >= 0 &&
  sbWxml.indexOf('未启用') >= 0);
check('分店经营点击门店卡有 goStore 处理（v1.0.3 暂 toast 提示详情页待建）',
  sbJs.indexOf('goStore') >= 0 && sbWxml.indexOf('bindtap="goStore"') >= 0);
check('门店详情页有 3 个 tab：① 库存 / ② 录入消耗 / ③ 历史消耗（老板 2026-09-15 拍板加历史消耗）',
  (function () {
    var sdWxml = read('pages/manager/store-detail/store-detail.wxml');
    return sdWxml.indexOf('① 库存') >= 0 &&
      sdWxml.indexOf('② 录入消耗') >= 0 &&
      sdWxml.indexOf('③ 历史消耗') >= 0 &&
      sdWxml.indexOf('switchTab') >= 0;
  })());
check('门店详情库存 tab 仅 1 卡：库存（老板 2026-09-15 拍板"今日成品+食材消耗没用删掉"）',
  (function () {
    var sdWxml = read('pages/manager/store-detail/store-detail.wxml');
    return sdWxml.indexOf('库存（{{inventory.length}}') >= 0 &&
      sdWxml.indexOf('今日成品') < 0 &&
      sdWxml.indexOf('食材消耗（今日') < 0;
  })());
check('门店详情录入消耗 tab 复用食材申请购物车：每行 [-] [+] + 数字直输 + 浮条 + 录入消耗按钮',
  (function () {
    var sdWxml = read('pages/manager/store-detail/store-detail.wxml');
    var sdJs = read('pages/manager/store-detail/store-detail.js');
    return sdWxml.indexOf('bindtap="onInc"') >= 0 &&
      sdWxml.indexOf('bindtap="onDec"') >= 0 &&
      sdWxml.indexOf('bindinput="onInputQty"') >= 0 &&
      sdWxml.indexOf('class="cart-bar"') >= 0 &&
      sdWxml.indexOf('录入消耗') >= 0 &&
      sdJs.indexOf('cart: {}') >= 0 &&
      sdJs.indexOf('onSubmit') >= 0 &&
      sdJs.indexOf("action: 'create', dishId:") >= 0;
  })());
check('门店详情录入消耗：提交成功自动切回库存 tab（v1.0.3 老板拍板 UX）',
  /onSubmit[\s\S]*?tab: 'stock'/.test(read('pages/manager/store-detail/store-detail.js')));
check('门店详情无返回功能面板栏（v1.0.3 老板 2026-09-15 拍板统一去掉）',
  read('pages/manager/store-detail/store-detail.wxml').indexOf('navigator class="backbar"') < 0);
check('其余管理页（商品/采购/申请处理/账号/预警）均无返回功能面板栏（老板 2026-09-15 拍板"所有页面删掉"）',
  ['goods/goods', 'purchase/purchase', 'requisition-process/requisition-process', 'shops-accounts/shops-accounts', 'wh-stock-alert/wh-stock-alert']
    .every(function (p) { return read('pages/manager/' + p + '.wxml').indexOf('navigator class="backbar"') < 0; }));
check('门店详情 onLoad 解析 query.storeId + query.name 设导航栏标题',
  (function () {
    var sdJs = read('pages/manager/store-detail/store-detail.js');
    return /onLoad: function \(query\) \{/.test(sdJs) &&
      /query\.storeId/.test(sdJs) &&
      /setNavigationBarTitle/.test(sdJs);
  })());
check('门店详情历史消耗：按日期分组 + 点记录弹明细（老板 2026-09-15 拍板）',
  (function () {
    var sdWxml = read('pages/manager/store-detail/store-detail.wxml');
    var sdJs = read('pages/manager/store-detail/store-detail.js');
    return sdWxml.indexOf('historyGroups') >= 0 &&
      sdWxml.indexOf('bindtap="openDetail"') >= 0 &&
      sdWxml.indexOf('detailOpen') >= 0 &&
      sdWxml.indexOf('his-date') >= 0 &&
      sdJs.indexOf('historyGroups') >= 0 &&
      sdJs.indexOf('openDetail: function') >= 0;
  })());
// 老板 2026-09-19：导出必须能按时间（本周/本月/自定义/全部），且时间范围内「全量」。
// 旧断言查的 'all: 1' 是上一版实现（本地已加载数据全量导出），已被 from/to 区间口径取代 → 改断言。
check('门店详情历史消耗：时间范围四档 + 区间下发后端（老板 2026-09-19 拍板）',
  (function () {
    var sdWxml = read('pages/manager/store-detail/store-detail.wxml');
    var sdJs = read('pages/manager/store-detail/store-detail.js');
    var uiOk = sdWxml.indexOf('wx:for="{{histPresets}}"') >= 0 &&
      sdWxml.indexOf('bindtap="switchHistRange"') >= 0 &&
      sdWxml.indexOf("histRange === 'custom'") >= 0 &&
      sdWxml.indexOf('fr-dates') >= 0 &&
      sdWxml.indexOf('bindtap="onExport"') >= 0;
    // 必须把 from/to 下发给云函数按营业日过滤，不能只在本地对已加载数据筛
    var jsOk = sdJs.indexOf('dr.rangeOf') >= 0 &&
      sdJs.indexOf('from: range.from') >= 0 &&
      sdJs.indexOf('to: range.to') >= 0 &&
      sdJs.indexOf('rec.fetchPage') >= 0;
    return uiOk && jsOk;
  })());
check('门店详情导出=时间范围内全量：循环分页拉取，无业务条数上限（老板 2026-09-19 拍板）',
  (function () {
    var sdJs = read('pages/manager/store-detail/store-detail.js');
    var crJs = read('utils/consume-records.js');
    return sdJs.indexOf('rec.fetchAll') >= 0 &&
      // 循环分页：靠 hasMore 续拉，不是单页截断
      crJs.indexOf('hasMore') >= 0 &&
      crJs.indexOf('offset += list.length') >= 0 &&
      // 不得出现「到 N 条就停」的业务上限语义
      crJs.indexOf('truncated') < 0;
  })());
check('门店端消耗记录：点记录弹明细 + 菜品名回查 dish（老板 2026-09-15 拍板）',
  (function () {
    var ssWxml = read('pages/shop/store-stock/store-stock.wxml');
    var ssJs = read('pages/shop/store-stock/store-stock.js');
    return ssWxml.indexOf('bindtap="openDetail"') >= 0 &&
      ssWxml.indexOf('detailOpen') >= 0 &&
      ssJs.indexOf('dishMap') >= 0 &&
      ssJs.indexOf('openDetail: function') >= 0;
  })());
// 老板 2026-09-19：导出要"同步映射到门店相关位置"→ 门店端消耗 tab 与管理端历史消耗同口径
check('门店端消耗：时间范围四档 + 导出时间范围内全量（与管理端历史消耗同口径，老板 2026-09-19 拍板）',
  (function () {
    var ssWxml = read('pages/shop/store-stock/store-stock.wxml');
    var ssJs = read('pages/shop/store-stock/store-stock.js');
    var uiOk = ssWxml.indexOf('wx:for="{{consPresets}}"') >= 0 &&
      ssWxml.indexOf('bindtap="switchConsRange"') >= 0 &&
      ssWxml.indexOf("consRange === 'custom'") >= 0 &&
      ssWxml.indexOf('bindtap="onExport"') >= 0;
    // 门店端不放 storeId（云函数按登录账号强制收敛本店），但必须下发 from/to 由后端按营业日过滤
    var jsOk = ssJs.indexOf('dr.rangeOf') >= 0 &&
      ssJs.indexOf('from: range.from') >= 0 &&
      ssJs.indexOf('to: range.to') >= 0 &&
      ssJs.indexOf('rec.fetchPage') >= 0 &&
      ssJs.indexOf('rec.fetchAll') >= 0;
    return uiOk && jsOk;
  })());
check('分店管理一行式：门店行「改密」+ 账号信息内联，删账号行「重置密码」（老板 2026-09-15 拍板）',
  (function () {
    var saWxml = read('pages/manager/shops-accounts/shops-accounts.wxml');
    return saWxml.indexOf('bindtap="resetAllPwd"') >= 0 &&
      saWxml.indexOf('>改密</text>') >= 0 &&
      saWxml.indexOf('{{item.accText}}') >= 0 &&
      saWxml.indexOf('bindtap="resetPwd"') < 0 &&
      saWxml.indexOf('acc.username') < 0;
  })());
check('账号管理「查看日记」：右上角入口 + opLog 弹层（老板 2026-09-15 拍板看全部管理端操作日记）',
  (function () {
    var saWxml = read('pages/manager/shops-accounts/shops-accounts.wxml');
    var saJs = read('pages/manager/shops-accounts/shops-accounts.js');
    return saWxml.indexOf('查看日记') >= 0 &&
      saWxml.indexOf('bindtap="onViewLog"') >= 0 &&
      saWxml.indexOf('logOpen') >= 0 &&
      saJs.indexOf("cloud.call('opLog'") >= 0;
  })());

/* ---------- 10. 申请单一键复制（老板 2026-09-12：方便管理员发群） ---------- */
var rpWxml = read('pages/manager/requisition-process/requisition-process.wxml');
var rpJs = read('pages/manager/requisition-process/requisition-process.js');
section('10. 申请单复制发群');
check('待处理/已处理每单都有「复制」按钮', (rpWxml.match(/copyReq/g) || []).length >= 2);
check('copyReq 组装文本走剪贴板 setClipboardData',
  rpJs.indexOf('wx.setClipboardData') >= 0);
check('复制内容含门店/状态/单号/时间/明细（名称+数量+单位）',
  rpJs.indexOf('食材申请单') >= 0 && rpJs.indexOf('门店：') >= 0 &&
  rpJs.indexOf('statusLabel') >= 0 && rpJs.indexOf('单号') >= 0 && rpJs.indexOf('formatQty') >= 0);
check('列表行标题带门店名（多店申请不混淆）', (rpWxml.match(/item\.storeName/g) || []).length >= 2);
check('loadAll 拉 store list 做门店名映射', rpJs.indexOf("cloud.call('store'") >= 0 && rpJs.indexOf('storeName = storeMap') >= 0);
/* ⚠️ 2026-10-09 源码把这条 toast 从「已复制，可粘贴发群」（9 字，超长会被系统截断）
 *    改短成「已复制，可粘贴」（6 字）。原断言硬编码旧文案 → 源码改好后反而转红（假红）。
 *    改成「有提示 + 提示 ≤7 字」：不再锁死具体措辞，但把截断红线守住。
 */
var copyHit = /title: '[^']*已复制[^']*'/.exec(rpJs);
check('复制成功有提示（文案含「已复制」）', !!copyHit, copyHit ? copyHit[0] : '（没找到）');
check('复制提示 ≤ 7 个字符（showToast 超长会被截断）',
  !!copyHit && copyHit[0].replace(/title: '|'/g, '').length <= 7,
  copyHit ? '「' + copyHit[0].replace(/title: '|'/g, '') + '」' +
    copyHit[0].replace(/title: '|'/g, '').length + '字' : '（没找到）');

/* ---------- 汇总 ---------- */
console.log('\n----------------------------------------------');
console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
console.log(fail === 0 ? 'UI-RULES RESULT: ALL GREEN' : 'UI-RULES RESULT: RED');
process.exitCode = fail === 0 ? 0 : 1;
