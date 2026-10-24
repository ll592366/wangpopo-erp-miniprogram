# 增量 PRD · v1.0.3 发布前瘦身 + 今日出品改造

> **写于 2026-09-12 21:01** · 老板口述 · 暂不执行，等"改"信号
> **二次澄清 2026-09-12 21:07** · 老板明示"门店端越简单越好 + 改密直接删 + requisition-history 因为重复删"
> 项目根：`C:\Users\Administrator\WorkBuddy\2026-07-30-09-42-20\wechat-erp-miniprogram`
> 适用版本：**v1.0.3**（已写在 `docs/发布审核_2026-09-12_v1.0.3_主人照粘版.md`）

---

## 〇、设计原则（老板 2026-09-12 21:07 拍板）

> **"门店端越简单越好"**

具体落地：
- 门店端**只做"打勾 + 看库存 + 退出"**三件事，不做"管理 / 编辑 / 历史追溯"
- **能合并就合并**（如"我的申请"卡进食材申请页，不再单列历史页）
- **能下放给管理端就下放**（如改密 → 走管理端"账号管理"）
- **看不到的不提供**（如库存预警阈值修改，门店端不能调）

---

## 一、瘦身删除清单（老板 2026-09-12 拍板）

| # | 删除项 | 文件 | 影响 | 备注 |
|---|--------|------|------|------|
| 1 | **删整个「我的」页**（profile 整页） | `pages/mine/profile/` 整个目录 | 整页删，**不**保留改密 / 退出登录 / 账号信息 | 改密由管理端"账号管理 → 重置密码"统一管；退出登录在门店端首页顶栏仍有 |
| 2 | **门店端实点盘点** | `pages/shop/stocktake/`（整个目录 4 文件） | app.json 去掉注册 + 删目录 + 测试断言减 | 门店不自己盘点，由管理端统一处理 |
| 3 | **门店端申请历史** | `pages/shop/requisition-history/`（整个目录） | 同上 | **理由（21:07 老板澄清）**：食材申请页 `requisition.wxml:27-28` 已经有"我的申请"卡，提交自动刷新，重复了 |

### 删除后，门店端宫格只剩 3 项（v1.0.3 终态，老板 2026-09-13 13:33 拍板"先删掉"）
| 位置 | 入口 | 说明 |
|------|------|------|
| 1 | 今日出品 | 留在 shop/production（暂时不动，详见第四部分） |
| 2 | 食材申请 | 申请单只读历史已嵌在该页下方"我的申请"卡（v1.0.3 美团式改造） |
| 3 | 店内库存 | 只看本店的库存余额 + 预警 |

> **退出登录**：在门店端首页顶栏右侧"退出登录 ›"按钮（保留）。

### 删除后，**门店端 app.json** 减 3 个 page 注册
```diff
- "pages/shop/stocktake/stocktake",
- "pages/shop/requisition-history/requisition-history",
- "pages/mine/profile/profile",
```
**全部整页删除**（v1.0.3 老板 2026-09-13 13:33 拍板：连「我的」整页一起删，不只是去掉改密）。

---

## 二、改名清单

| # | 改前 | 改后 | 范围 |
|---|------|------|------|
| 1 | `物料申请`（页内文字） | `食材申请` | `pages/shop/production/production.wxml` 宫格 label |
| 2 | 任何残留的 `物料` 字段、变量名、注释 | 全项目 grep 替换为 `食材` | 所有 .wxml/.js/.json/.md |

**注**：之前的菜品消耗字段曾用 `consumeItems`，文档/PRD 也用过"物料"一词——**这次只改 UI 文字**（用户可见部分），不动数据字段名 / 集合名 / 变量名（避免破坏兼容性，PRD §6.4 约定"原料/食材"同义）。

---

## 三、食材申请美团式改造（v1.0.3 重点，老板 2026-09-12 21:12 拍板，21:21 细化弹窗）

### 3.0 现状
- 位置：`pages/shop/requisition/requisition.{js,wxml,wxss}`
- 现状 UI：每行一个 search-picker（选食材）+ 数量输入 + 删除行 + 提交按钮
- 问题（老板原话 21:12）："去掉更换 直接像美团那样 显示全部商品列表后面点击+增加减少填入数量 填到购物车 发起申请"
- 细化（老板原话 21:21）："总仓食材库存清单卡（顶部）...购物车浮条（底部 fixed）点击弹出选择的 N 件食材 列表· 发起申请"

### 3.1 目标
- **顶部卡改名为"总仓食材库存清单"**（让门店看的是总仓有什么，方便判断能申请啥）
- **去掉 picker**（不再用 search-picker 选食材）
- **列出全部食材**（active 的所有食材，每行一个）
- 每行 **[-] [数字] [+]** 三件套调整数量（中间数字也可点击直输）
- 数量 > 0 的进入**购物车**（页面底部固定浮条，显示 "共 N 件食材"）
- **点击浮条 → 弹窗**列出已选 N 件食材明细 + **"发起申请"按钮**（弹窗内提交）

### 3.2 新页面结构
```
pages/shop/requisition/requisition  （同位置，内容大改）
├── .wxml
│   ├── 总仓食材库存清单卡（顶部 · renamed）
│   │   卡片标题：总仓食材库存清单（{{materials.length}} 种）
│   │   行 1: 牛肉片（包）    总仓 0.5 包   [-] [0] [+]
│   │   行 2: 土豆（斤）       总仓 12 斤    [-] [3] [+]
│   │   ...（所有 isActive 食材，按分类/字母序排列）
│   ├── 我的申请卡（下半，**保留原样**，不动）
│   ├── 购物车浮条（底部 fixed · 始终可见）
│   │   [🛒 共 N 件食材]      ← 整条可点
│   └── 购物车弹层（wx:if="{{cartOpen}}"，点击浮条打开）
│       ├── 遮罩（点遮罩关）
│       └── 弹层内容（70% 宽、55vh 上限，居中）
│           ├── 标题：已选 N 件食材
│           ├── 列表：每行 [食材名（单位）] [-] [数量] [+] · 单价删除按钮
│           └── 底部：[取消]  [发起申请]
└── .js
    onShow: loadAll
      ├─ 拉 material.list → materials（active 食材）
      ├─ 拉 store.list 找到自己 storeId
      ├─ 拉 inventory(WAREHOUSE) → warehouseMap[itemId]=qty
      └─ 拉 requisition.list → list（已申请记录）
    onInc / onDec(itemId): 增减数量，clamp ≥0
    onOpenCart / onCloseCart: 浮条点开/关弹层
    onSubmit: 校验 cart 非空 → 弹窗内"发起申请"按钮触发 → requisition 云函数批量 create
```

### 3.3 数据模型
```js
data: {
  materials: [],          // 全部食材档案（含 name / unit / spec / category）
  warehouseMap: {},       // { itemId: qty }  ← 总仓库存（老板 21:21 明示）
  cart: {},               // { itemId: qty }，qty=0 不显示在弹窗里
  cartOpen: false,        // 弹层开关
  cartCount: 0,           // cart 里 qty>0 的条目数（底部浮条显示）
  list: []                // 已提交的申请单（保留不变）
}
```

### 3.4 行为细节
| 场景 | 期望行为 |
|------|----------|
| 减到 0 | 数量显示 0，再点 [-] 不变负；cart 里自动移除 |
| 数字输入框 | 可点击直输数字（不是必须 [-] [+]） |
| 总仓为 0 的食材 | "总仓 0 包"灰显，但**不阻止加入购物车**（门店想申请补货） |
| 食材单位非已（停用） | 不显示在列表里（filter isActive !== false） |
| 排序 | 按分类/字母序（**2026-09-12 21:21 老板明示**：~~只列~~按分类/字母序） |
| 行高度 | 沿用 72rpx（与全项目输入框统一） |
| 长按 [-] / [+] | **不**做长按连按（保持简单，点一下动一下） |
| 浮条 cartCount=0 | 浮条仍显示但**置灰不可点** |
| 点击浮条 | 打开弹层，弹层里能看到已选明细，可调整 / 删除单件 |
| 弹层"取消"按钮 | 关弹层、保留 cart |
| 弹层"发起申请"按钮 | loading → 提交 → toast"已发起申请" → 清 cart → 关弹层 → loadList 刷新下方申请记录 |
| 提交中 | 弹层内按钮 disabled + loading |
| 提交失败 | toast 错误，保持 cart 不变，可再次点提交 |
| 空 cart 点发起 | 按钮置灰 + 提示"还没选食材" |

### 3.5 与 search-picker 关系
- 食材申请页**不再用 search-picker**，所以**没有"更换"按钮**（老板明示"去掉更换"）
- search-picker 组件**不删**（采购入库 / 申请处理详情仍要用），只在本页面不引用

### 3.6 提交入参（云函数）
- 现状：每行 picker 选一项 + qty → 多个 item 加入 cart
- 新版：cart `{itemId: qty}` 一次提交
- 入参 `{action:'create', items:[{itemId, qty}, ...]}` —— **复用现有 requisition.create 云函数**（按 memory 该云函数支持 items 数组，事务保证）

### 3.7 弹层样式（复用既有约定）
- 跟 search-picker 弹层同一套：居中显示（70% 宽 + 55vh 上限）
- 遮罩 rgba(0,0,0,0.45)
- 弹层顶 [× 关闭] / 标题 / 列表 / 底双按钮
- 复用 `app.wxss .ip-mask / .ip-panel` 已有样式（避免重复样式）

---

## 四、今日出品重构（v1.0.3 重点，老板核心要求）

### 3.1 现状
- 位置：`pages/shop/production/production.js`（门店端）
- 数据流：shop 角色登录 → 拿自己 storeId → 提交 `production.create` → 扣自己门店库存
- 宫格入口：`生产端首页 → 今日出品`（位于 `pages/shop/production/production.wxml:14`）

### 3.2 目标（老板原话）
> "仓库端去下门店菜品 自动扣减库存"  
> "点击门店    添加今日卖出的菜品  点击后扣对应门店食材库存"  
> "管理端可以同步看到该店库存"

**3 句话翻译：**
1. 入口搬到**管理端**首页宫格（`pages/manager/`），不再在门店端
2. 进页先**选门店**（search-picker，从 `store.list` 拉），选完才进入录入界面
3. 录入点击 = 给**该门店**扣库存（不是总仓）；管理端 `store-stock` 页**自动同步**该门店余额（已存在，零改动）

### 3.3 新页面结构（待实现，不动代码）
```
pages/manager/production/production
├── .js          onShow: loadStoreList；shopChange(id) 切换门店；submitProduction(dishId, qty)
├── .wxml        顶部门店 search-picker（卡片两态） + 现有菜品列表 + 数量输入 + 提交
└── .wxss        沿用现有 .ci-row / .input / .grid-item 样式（不引入新类）
```

### 3.4 行为细节（待老板确认或实施时讨论）
| 场景 | 期望行为 |
|------|----------|
| 门店下拉为空（无门店档案） | 提示"请先去「账号管理」建门店"，拦截提交 |
| 切换门店后表单已填数据 | **保留**（不重置，方便切换前比着录入） |
| 某食材门店库存不足 | **整单回滚**（已有逻辑，production.create 事务保证） |
| 今日已录过同一菜品 | 弹 toast 提示"已录入 X 份，继续累加 Y 份"，不阻断 |
| 误录想撤回 | 走 `production.reverse`（已有，仅当日 + confirmed 才允许） |
| 管理端改门店清单 | 重拉 `store.list`（onShow 自动重拉，无需手动刷新） |
| 看不到自己刚录的 | **不要**：现有 store-stock 是另一页；如果想"录完即时刷新库存"需在详情卡显示已扣明细（**v1.0.3 不做**，记入 v1.0.4 待办） |

### 3.5 权限与云函数调整
| 项 | 现状 | 调整 |
|----|------|------|
| `ACTION.PRODUCTION_CREATE` | 仅 `shop`（按 memory 权限速查） | **新增 `ACTION.PRODUCTION_FOR_SHOP`**（manager only），production 云函数支持 storeId 显式传入；shop 仍用现有 ctx.user.storeId |
| `production.create` 入参 | `{action, dishId, qty, storeId?}` | 已有 storeId 参数（按 cloudfunctions/production/index.js 第 50 行"event.storeId || ctx.user.storeId"），**零改动** |
| 管理端 `store-stock` 查门店库存 | `inventory(storeId)` 已支持任意门店 | **零改动**，管理端调 `store-stock` 时把 production 里选的门店 ID 传过去即可 |
| `onShow` 默认门店 | 无默认（必须手动选） | 第一次进不默认；之后进页面**沿用上次选的 storeId**（page data 缓存，PRD §5 一致性） |

### 3.6 移动旧文件
```
pages/shop/production/     ──X 整目录删除（或保留为归档，等老板决定）
pages/manager/production/  ──O 新建（v1.0.3 上线状态）
```
**建议保留** `pages/shop/production/` 作为备份（git 历史即可，不进 app.json），万一要回退有据可查。

---

## 五、测试断言同步（待实施时一起跑）

| 套件 | 影响 |
|------|------|
| `tests/smoke/ui-rules.js` | 第 9 节"账号管理合并"里关于门店"我的"页改密的断言要删/改；宫格断言要同步去掉 stocktake/requisition-history 两条 |
| `tests/smoke/smoke.js` | 旧 stocktake 路径若有断言要清 |
| `tests/smoke/smoke-edge.js` | 同上 |
| `tests/smoke/search-picker.js` | search-picker 在 stocktake 用过，可能有"label || name"兜底相关断言——查一下对应要不要删 |
| **新增断言** | ui-rules.js 加一节"v1.0.3 瘦身 + 今日出品搬到管理端"：① stocktake/requisition-history 不在 app.json ② 宫格只剩 4 项 + 物料→食材 ③ 门店端 profile 无 changePassword ④ 管理端有 production 入口 + storePicker |

---

## 六、不在本次范围（v1.0.3 不做，记入后续）

| 想法 | 推迟到 |
|------|--------|
| 录入后立刻在详情卡显示"已扣 X 包" | v1.0.4 |
| 误录撤销按钮（仅当日 + confirmed） | **production 云函数已支持 reverse**，只是 UI 没接；v1.0.4 加按钮 |
| 批量录入（多门店同菜品） | v1.1.0 |
| 菜品消耗缺食材时弹购物清单 | v1.1.0 |
| 备菜/退菜（与出品区分） | v1.2.0 |

---

## 七、回头审视这份 PRD 的检查清单（实施前主人过一遍）

- [x] 第 1 部分"删除 3 项"是否同意？—— **2026-09-12 21:07 老板明示同意"改密直接删 + 门店端越简单越好"**
- [x] 第 2 部分"物料申请 → 食材申请"—— **2026-09-12 21:12 老板明示同意（已写进 §3）**
- [x] 第 3 部分"食材申请美团式购物车"—— **2026-09-12 21:12 老板拍板**
- [ ] 第 4 部分"今日出品搬到管理端"是否符合想象？
- [ ] 第 4.4 节"切换门店保留表单"是否同意？
- [ ] 第 4.5 节"新增 PRODUCTION_FOR_SHOP action"是否同意？还是改成"PRODUCTION_CREATE 也允许 manager"？
- [ ] 第 4.6 节"保留旧文件作备份"是否同意？还是直接删？

**主人回 OK 我就动手，回具体要改的项我先调整 PRD 再动手。**