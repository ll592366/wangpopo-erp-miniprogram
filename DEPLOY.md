# 王婆婆家常菜 · ERP 小程序部署指南（v1.5）

> 对应文档：`docs/PRD.md` v0.9.1 / `docs/ARCHITECTURE.md` v1.5
> 本项目为标准「微信云开发」工程：`miniprogram/`（客户端）+ `cloudfunctions/`（13 个云函数）。
> 旧版「连锁酒店牛肉 ERP」原型已整体移入 `_legacy_beef_erp/`（只移不删，可随时参考）。

---

## 一、前置准备

1. **微信小程序 AppID**：注册一个小程序（或使用测试号），拿到 AppID。
2. **微信开发者工具**：安装最新稳定版（需支持云开发）。
3. **开通云开发**：在开发者工具里首次打开项目后，点击「云开发」按钮按提示开通，并**创建一个环境**（建议按量付费免费额度即可）。记下**环境 ID**（形如 `cloud1-xxxxxxxx`）。

## 二、导入项目

1. 微信开发者工具 →「导入项目」→ 选择本目录（`wechat-erp-miniprogram/`）。
2. AppID 填你自己的（当前 `project.config.json` 里是占位符 `"touristappid"`，导入时会提示替换）。
3. 确认项目识别为「小程序·云开发」模板（`project.config.json` 已配好 `miniprogramRoot` / `cloudfunctionRoot`）。

## 三、填入云环境 ID（唯一要改的代码点）

打开 `miniprogram/utils/config.js`：

```js
// 部署时改成你的云环境 ID（架构文档 Q1）
var CLOUD_ENV = 'YOUR_ENV_ID';
```

把 `'YOUR_ENV_ID'` 换成第三步记录的环境 ID（形如 `'cloud1-xxxxxxxx'`）。全项目只有这一处需要改。

## 四、部署 13 个云函数

在开发者工具左侧资源管理器中，对 `cloudfunctions/` 下的**每一个**目录右键 →「上传并部署：云端安装依赖」：

```
login        登录 / 自助改密 / 首登强制改密
register     注册开店（一事务建 store + user，未登录可用）
material     食材档案维护 / 列表
dish         菜品档案维护（内嵌 consumeItems）
store        分店改名 / 启停（闭店/复业）/ 详情
purchase     总仓采购入库
requisition  物料申请 5 动作（create/confirm/reject/cancel/query）
production   出品扣减（qty/portions 公式）/ 撤回 / 预览
stocktake    剩余实点
inventory    库存查询
report       分店经营 / 食材预警
opLog        操作日志
export       全量流水导出（CSV）
```

> 每个函数目录都已内置 `package.json`（wx-server-sdk）和自包含的 `_shared/` 副本（constants / response / auth / db），云端安装依赖即可，无需本地 npm install。

## 五、初始化数据库集合

云开发控制台 →「数据库」→ 依次创建以下 **10 个集合**（权限先设为「仅创建者可读写」，实际读写全部走云函数，无副作用）：

```
user  store  material  dish  purchase  requisition  production  stocktake  stock_balance  op_log
```

> 旧版原型用过的 `shipment` / `supplier` / `recipe` 集合**不再需要**（架构 v1.5 已删除对应链路）。

## 六、初始化管理端账号

**默认管理员账号：`888` / 密码 `888888`**（老板指定；首登强制改密）。

`login` 云函数自举（`ensureBootstrap`）会自动处理，通常**无需手动建**：
- 库内无管理端 → 自动创建 `888 / 888888`；
- 存量旧默认账号 `manager`（不管密码改没改过）→ 一次性迁移为 `888 / 888888`（迁完后您再改的密码不会被自举覆盖）；

如需手动兜底（云开发控制台 →「数据库」→ `user` 集合 → 添加记录）：

```json
{
  "username": "888",
  "name": "管理端",
  "password": "888888",
  "role": "manager",
  "storeId": null,
  "passwordChanged": false,
  "isActive": true,
  "createdAt": "2026-01-01T00:00:00+08:00"
}
```

> `passwordChanged: false` ⇒ 首次登录会被强制改密（架构 §4.4）。
> 登录走 `login` 云函数（账号+密码），**不绑定微信**——以账号为准，同一账号可在不同手机登录。

## 七、真机预览验收（建议顺序）

| # | 操作 | 预期 |
|---|---|---|
| 1 | 888 / 888888 登录 | 被强制改密 → 设新密码 → 进入管理端首页 |
| 2 | 管理端：食材 / 菜品录入 | 建食材（单位自由文本如 包/盒/克）→ 建菜品（内嵌清单含 每份用量+单位） |
| 3 | 管理端：采购入库 | 总仓余额增加，op_log 留痕 |
| 4 | 登录页「注册开店」 | 填店名+账号+密码 → 建店建号成功 → 自动登录进入门店端 |
| 5 | 门店端：食材申请 | 提交申请（pending）→ 管理端确认 → 总仓 −、门店 + |
| 6 | 门店端：今日出品 | 按 `份数 × 每份用量` 扣本店库存；不足报 2001 |
| 7 | 门店端：剩余实点 | 实点覆盖库存，差异 = 实际 − 账面 |
| 8 | 管理端：分店启停 → 闭店 | 该店账号登录/操作被拦（1001 STORE_CLOSED）；复业恢复 |
| 9 | 管理端：分店经营 / 食材预警 / 导出 | 按营业日聚合；预警按阈值同单位比；导出返回 CSV |

## 八、常见问题

- **`env check invalid` / 云函数调用报环境错误**：`utils/config.js` 的 `CLOUD_ENV` 没改或环境 ID 抄错。
- **云函数报 1003**：权限不足（角色矩阵见 PRD §6；两列均 ❌ 的哨兵动作 `user.manage` / `store.manage` 一律 1003）。
- **云函数报 1001 且 message 提到闭店**：门店 `status=closed`，去管理端「分店与账号」复业。
- **云函数报 3001**：档案不存在（检查集合名 / 文档 `_id`）。
- **老原型去哪了**：`_legacy_beef_erp/`，与本系统无任何引用关系。

## 九、遗留事项（需用户自行完成）

1. 填真实 **AppID**（`project.config.json`）。
2. 填真实 **云环境 ID**（`miniprogram/utils/config.js`）。
3. 开发者工具里完成 **13 个云函数部署** + **10 个集合创建** + manager 账号初始化。
4. 真机联调：如需在手机上预览，请在开发者工具设置「不校验合法域名」或配置云开发域名白名单。
