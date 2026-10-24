// ==========================================================================
// cloudfunctions/login — 账号密码登录（以账号为准，不绑定微信）
// · action=login（默认）：{username, password} → 校验 → buildIdentity
// · action=setPassword：按 _uid 设密（保留为兼容接口；登录页已不再强制首登改密，
//   改密统一走 action=changePassword ——「我的」页自助修改，需校验原密码）
// · action=changePassword：登录态自助改密（按 _uid，校验原密码）
// · 自举：集合缺失自动补建 10 集合；食材库为空灌 64 食材 + 48 菜品；
//   管理端默认账号 888 / 888888（无 manager 自动创建；存量 manager 首次登录 888
//   时一次性迁移并复位密码；专项测试见 tests/smoke/mgr-migration.js）
// · 2026-09-19 新增：管理端登录成功后**一次性**后台跑「库存精度巡检」
//   （存量 0.01 残渣归零，见 _shared/stockfix.js）。全链路吞错 + 不 await，
//   绝不改变登录结果语义、也不让老板感觉登录变慢。
// ==========================================================================
var cloud = require('wx-server-sdk');
var R = require('./response');
var C = require('./constants');
var dbh = require('./db');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

var db = cloud.database();

/** 集合自举：集合不存在时自动补建（免控制台手工建集合） */
var ALL_COLLECTIONS = ['user', 'store', 'material', 'dish', 'purchase',
  'requisition', 'production', 'stocktake', 'stock_balance', 'op_log'];

function isCollectionMissing(err) {
  var s = String((err && (err.errMsg || err.message)) || '') + String(err && err.errCode !== undefined ? err.errCode : '');
  return /-502005|COLLECTION_NOT_EXIST|not exist/i.test(s);
}

function ensureCollections() {
  return ALL_COLLECTIONS.reduce(function (p, name) {
    return p.then(function () {
      return db.createCollection(name).catch(function () { /* 已存在或不可建：忽略 */ });
    });
  }, Promise.resolve());
}

/* ======================= 默认种子（PRD v0.9.1 §6.10 业务权威表） ======================= */
function M(id, name, unit) {
  return { _id: id, name: name || id, unit: unit, lowStockThreshold: 2, isSeed: true, createdAt: dbh.nowIso() };
}
function D(name, category, items) {
  return {
    name: name, category: category,
    consumeItems: items.map(function (it) {
      return { itemId: it[0], qty: it[1], unit: it[2], portions: it[3] || null };
    }),
    isActive: true, createdAt: dbh.nowIso()
  };
}
var SEED_MATERIALS = [
  M('牛肉片', null, '包'), M('鱿鱼耳丝', null, '包'), M('基围虾', null, '包'), M('腰花', null, '包'),
  M('鱼泡', null, '包'), M('泡藕带', null, '包'), M('肥肠', null, '大包'), M('财鱼片', null, '包'),
  M('大白刁', null, '包'), M('扣肉', null, '盒'), M('扇贝', null, '件'), M('桂鱼', null, '包'),
  M('粉蒸肉', null, '盒'), M('珍珠丸子', null, '包'), M('牛腱子', null, '克'), M('盐焗鸡', null, '只'),
  M('mat_wucai_huasheng', '五彩花生', '包'), M('mat_yingtao_luobo', '樱桃萝卜', '包'), M('mat_qinggua', '青瓜', '包'),
  M('甲鱼', null, '包'), M('牛蛙', null, '包'), M('鸡腰子', null, '克'), M('榴莲', null, '包'),
  M('鱼糕鱼丸', null, '包'), M('羊排', null, '包'), M('凤爪', null, '斤'), M('黄油鸡', null, '只'),
  M('猪肚', null, '包'), M('小土豆', null, '包'), M('猪尾巴', null, '斤'), M('鳝鱼片', null, '包'),
  M('藕带', null, '包'), M('牛杂', null, '大包'), M('洪湖藕', null, '包'), M('排骨', null, '大包'),
  M('羊杂大包', null, '包'), M('熏肉', null, '克'), M('香肠', null, '克'), M('鸡块', null, '包'),
  M('五花肉', null, '盒'), M('脆骨', null, '包'), M('扇子骨', null, '包'),
  M('卤猪八戒', null, '包'), M('龙须笋', null, '包'), M('腊肉', null, '包'), M('鹌鹑', null, '包'),
  M('土豆', null, '包'), M('牛奶豆腐', null, '包'), M('扁豆', null, '克'), M('梅菜扣肉末', null, '勺'),
  M('山野菌', null, '包'), M('腊肠', null, '克'), M('武昌鱼', null, '条'), M('mat_zhuliji', '猪里脊', '大包'),
  M('牛肚', null, '小包'), M('猪肝', null, '包'), M('小炒肉', null, '大包'), M('肉丝', null, '大包'),
  M('牛皮干', null, '包'), M('肉丝大', null, '包'), M('芝麻藕条', null, '大包'), M('虾饼', null, '包'),
  M('藕夹', null, '大包'), M('小酥肉', null, '大包')
];
var SEED_DISHES = [
  D('婆婆金汤牛肉', '招牌菜类', [['牛肉片', 1, '包']]),
  D('香锅鱿鱼基围虾', '招牌菜类', [['鱿鱼耳丝', 3, '包', 2], ['基围虾', 1, '包']]),
  D('招牌腰花爆鱼泡', '招牌菜类', [['腰花', 2, '包'], ['鱼泡', 1, '包', 2], ['泡藕带', 1, '包']]),
  D('招牌肥肠鱼', '招牌菜类', [['肥肠', 1, '大包', 3], ['财鱼片', 2, '包']]),
  D('清蒸大白刁', '农家蒸菜类', [['大白刁', 1, '包']]),
  D('白灼基围虾', '农家蒸菜类', [['基围虾', 1, '盒']]),
  D('大碗席夹馍扣肉', '农家蒸菜类', [['扣肉', 1, '盒']]),
  D('银丝扇贝', '农家蒸菜类', [['扇贝', 1, '件', 6]]),
  D('豉汁大桂鱼', '农家蒸菜类', [['桂鱼', 1, '包']]),
  D('农家米粉蒸肉', '农家蒸菜类', [['粉蒸肉', 1, '盒']]),
  D('双沟珍珠藕圆', '农家蒸菜类', [['珍珠丸子', 1, '包']]),
  D('凉拌牛腱子', '凉菜类', [['牛腱子', 180, '克']]),
  D('古法盐焗鸡', '凉菜类', [['盐焗鸡', 1, '只', 2]]),
  D('醋泡五彩花生', '凉菜类', [['mat_wucai_huasheng', 1, '包']]),
  D('口味樱桃萝卜', '凉菜类', [['mat_yingtao_luobo', 1, '包']]),
  D('开胃小青瓜', '凉菜类', [['mat_qinggua', 1, '包']]),
  D('甲鱼牛蛙烧鸡腰子', '热菜类', [['甲鱼', 1, '包'], ['牛蛙', 1, '包'], ['鸡腰子', 180, '克']]),
  D('榴莲煨荆州鱼糕鱼丸汤', '热菜类', [['榴莲', 1, '包'], ['鱼糕鱼丸', 2, '包', 1]]),
  D('招牌秘制羊排', '热菜类', [['羊排', 1, '包']]),
  D('黄豆焖凤爪', '热菜类', [['凤爪', 1.7, '斤']]),
  D('广式猪肚鸡煨山药', '热菜类', [['黄油鸡', 1, '只'], ['猪肚', 1, '包', 1]]),
  D('高山小土豆烧猪尾巴', '热菜类', [['小土豆', 2, '包'], ['猪尾巴', 1.2, '斤']]),
  D('砂锅鳝鱼片爆魔芋', '热菜类', [['鳝鱼片', 2, '包'], ['藕带', 1, '包']]),
  D('老樊城古法烧牛杂', '热菜类', [['牛杂', 1, '大包', 5]]),
  D('洪湖藕炖排骨汤', '热菜类', [['洪湖藕', 1, '包'], ['排骨', 1, '大包', 5]]),
  D('教门街羊杂汤配手工面', '热菜类', [['羊杂大包', 1, '包', 5]]),
  D('香锅恩施熏肉爆香肠', '热菜类', [['熏肉', 300, '克'], ['香肠', 200, '克']]),
  D('香锅肥肠鸡', '热菜类', [['肥肠', 1, '大包', 3], ['鸡块', 2, '包', 3]]),
  D('干锅焦香五花肉爆脆骨', '热菜类', [['五花肉', 1, '盒'], ['脆骨', 1, '包']]),
  D('香锅手抓扇子骨', '热菜类', [['扇子骨', 1, '包']]),
  D('香锅猪三宝', '热菜类2', [['卤猪八戒', 1.5, '包', 1]]),
  D('香锅龙须笋爆腊肉', '热菜类2', [['龙须笋', 3, '包', 4], ['腊肉', 1, '包', 1]]),
  D('招牌焗鹌鹑', '热菜类2', [['鹌鹑', 1, '包']]),
  D('干锅焦香土豆', '热菜类2', [['土豆', 2, '包', 3]]),
  D('干锅牛奶豆腐', '热菜类2', [['牛奶豆腐', 1, '包']]),
  D('砂锅梅菜扁豆', '热菜类2', [['扁豆', 400, '克'], ['梅菜扣肉末', 4, '勺']]),
  D('山野菌炒腊肉（腊肠）', '热菜类2', [['山野菌', 1, '包'], ['腊肠', 100, '克'], ['腊肉', 0.2, '包']]),
  D('阳干武昌鱼', '热菜类2', [['武昌鱼', 1, '条']]),
  D('猪肉糖醋里脊', '热菜类2', [['mat_zhuliji', 1, '大包', 4]]),
  D('芹菜炒牛肚', '热菜类2', [['牛肚', 1, '小包', 1]]),
  D('葱爆猪肝', '热菜类2', [['猪肝', 3, '包', 2]]),
  D('辣椒炒肉', '热菜类2', [['小炒肉', 1, '大包', 5]]),
  D('酸菜粉皮炒肉丝', '热菜类2', [['肉丝', 1, '大包', 10]]),
  D('特级牛皮干炒肉丝', '热菜类2', [['牛皮干', 1, '包', 3], ['肉丝大', 1, '包', 10]]),
  D('芝麻藕条蘸番茄酱', '热菜类2', [['芝麻藕条', 1, '大包', 5]]),
  D('醉香虾饼', '热菜类2', [['虾饼', 1, '包', 1]]),
  D('芥菜藕夹', '热菜类2', [['藕夹', 1, '大包', 5]]),
  D('椒盐小酥肉', '热菜类2', [['小酥肉', 1, '大包', 3]])
];

/** 种子自举：食材为空 → 灌默认 64 食材 + 48 菜品（只补空库，绝不覆盖已有数据） */
function ensureSeed() {
  return db.collection('material').count().then(function (r) {
    if ((r.total || 0) > 0) { return { seeded: false }; }
    return db.collection('material').add({ data: SEED_MATERIALS }).then(function () {
      return db.collection('dish').add({ data: SEED_DISHES });
    }).then(function () {
      console.log('[login] seed done: ' + SEED_MATERIALS.length + ' materials, ' + SEED_DISHES.length + ' dishes');
      return { seeded: true };
    });
  }).catch(function (err) {
    console.log('[login] seed skip: ' + String(err && (err.errMsg || err.message) || err));
    return { seeded: false };
  });
}

/**
 * 预置管理端自举（老板指定默认账号：888 / 888888，首登强制改密；不绑微信）。
 * 兼容存量库：
 *   ① 库内无任何 manager → 直接创建 888/888888（固定 _id='user_manager'，保证预置身份稳定）；
 *   ② 系统预置账号被改坏（role 不是 manager/shop 的乱值，如被手滑改成 '111111'）→
 *      就地重置为全新默认 888/888888（等同"删掉重建"，passwordChanged 归 false）；
 *   ③ 存量 manager 用户名还是旧默认 'manager' → 一次性迁移：username='888' +
 *      password 复位 '888888' + passwordChanged=false（幂等：迁过后 username 已是
 *      '888' 不再触发，之后用户自己改的密码不会被自举覆盖）；
 *   ④ username='888' 已被门店注册占用 → 跳过迁移并留日志（概率极低，避免破坏账号唯一性）。
 */
function ensureManagerAccount() {
  // 先按预置 _id 找（role 被改坏时 where({role:'manager'}) 查不到，防止误建第二个管理端）
  return db.collection('user').doc('user_manager').get().then(function (res) {
    return res.data || db.collection('user').where({ role: C.ROLE.MANAGER }).limit(1).get()
      .then(function (r) { return r.data && r.data[0]; });
  }).then(function (u) {
    if (!u) {
      var fresh = {
        name: '王婆婆·管理', username: '888', password: '888888',
        role: C.ROLE.MANAGER, storeId: null,
        passwordChanged: false, isActive: true, createdBy: 'system', createdAt: dbh.nowIso()
      };
      return db.collection('user').doc('user_manager').set({ data: fresh }).then(function () {
        console.log('[login] manager bootstrap: 888/888888 (_id=user_manager)');
        return null;
      });
    }
    // 系统预置账号被改坏（role 乱值）→ 就地重置为默认（老板口径：删掉重建）
    if (u.role !== C.ROLE.MANAGER && u.role !== C.ROLE.SHOP) {
      var fix = { role: C.ROLE.MANAGER, username: '888', password: '888888',
        passwordChanged: false, isActive: true, updatedAt: dbh.nowIso() };
      return db.collection('user').doc(u._id).update({ data: fix }).then(function () {
        console.log('[login] manager repair: role=' + String(u.role) + ' 已重置为 manager / 888 / 888888');
        return null;
      });
    }
    // 迁移检查：username 已是 888 → 无事可做
    if (u.username === '888') { return null; }
    // username='888' 可能被门店注册占了 → 为保证账号唯一性，只提示不硬抢（概率极低）
    return db.collection('user').where({ username: '888' }).limit(1).get().then(function (r2) {
      if (r2.data && r2.data[0]) {
        console.log('[login] manager migrate skip: username 888 已被占用');
        return null;
      }
      var patch = { username: '888', password: '888888', passwordChanged: false, updatedAt: dbh.nowIso() };   // 一次性迁移：连密码一起复位为默认
      return db.collection('user').doc(u._id).update({ data: patch }).then(function () {
        console.log('[login] manager migrate: ' + String(u.username) + ' → 888 / 888888（密码已复位，首登将再次强制改密）');
        return null;
      });
    });
  }).catch(function () { return null; });
}

/**
 * 清理「误建 / 失效」的僵尸账号（老板口径：多建的都删掉）。
 * ⚠️ 判定必须保守：只删**确定不可用**的档，绝不按 createdBy 指纹一刀切
 *   （老版本 register 写的 createdBy 与现在不同，一刀切会误删真实门店账号 = 数据丢失）。
 * 判定表（只要命中一条即删）：
 *   a) 预置管理端 _id='user_manager'                → 保留（最高优先）
 *   b) role='manager' 但其 _id 不是 user_manager    → 删（架构 D14：管理端恒为 1，多出来的是误建）
 *   b2) createdBy='system' 且 _id 不是 user_manager  → 删（全项目只有自举写这个指纹，
 *       即"自举误建的重复管理端"，随机 _id；哪怕它的 role 被改成别的值也照样删）
 *   c) role 不是 manager/shop（乱值 / 空，如 '111111'）→ 删（这种账号登录必被路由错乱，无法使用）
 *   d) role='shop' 但没有 storeId                   → 删（门店账号必须绑本店，否则无任何数据域）
 *   e) role='shop' 且 storeId 指向不存在的门店       → 删（孤儿档）
 *      ⚠️ e 只在"门店集合读取成功且非空"时生效，避免读失败/空库时误删
 *   f) 其余（正常门店账号，无论 createdBy 是什么）    → 保留
 * 每次删除打完整字段快照到云函数日志；幂等：清干净后为空操作。
 */
function purgeJunkUsers() {
  return Promise.all([
    db.collection('user').limit(200).get(),
    db.collection('store').limit(200).get().catch(function () { return { data: null }; })
  ]).then(function (rs) {
    var users = rs[0].data || [];
    var stores = rs[1].data;                     // null = 读失败 → e 规则不启用
    var storeIds = {};
    (stores || []).forEach(function (s) { storeIds[String(s._id)] = true; });
    var canCheckStore = !!stores && stores.length > 0;

    var junk = users.filter(function (u) {
      var id = String(u._id);
      var role = u.role;
      if (id === 'user_manager') { return false; }                                  // a
      if (role === C.ROLE.MANAGER) { return true; }                                 // b
      if (u.createdBy === 'system') { return true; }                                // b2（自举误建的重复管理端）
      if (role !== C.ROLE.SHOP) { return true; }                                    // c
      if (!u.storeId) { return true; }                                              // d
      if (canCheckStore && !storeIds[String(u.storeId)]) { return true; }            // e
      return false;                                                                 // f
    });
    if (junk.length === 0) { return null; }
    return junk.reduce(function (p, u) {
      return p.then(function () {
        return db.collection('user').doc(String(u._id)).remove().then(function () {
          console.log('[login] purge junk user: ' + String(u._id)
            + ' | role=' + String(u.role) + ' | username=' + String(u.username)
            + ' | storeId=' + String(u.storeId) + ' | createdBy=' + String(u.createdBy));
        }).catch(function (e) {
          console.log('[login] purge skip ' + String(u._id) + ': ' + String(e && (e.errMsg || e.message)));
        });
      });
    }, Promise.resolve()).then(function () { return { purged: junk.length }; });
  }).catch(function () { return null; });
}

/** 全套自举（建集合 → 灌种子 → 保证有管理端账号 → 清理僵尸账号），幂等可重入 */
function ensureBootstrap() {
  return ensureCollections().then(ensureSeed).then(ensureManagerAccount).then(purgeJunkUsers)
    .catch(function () { return null; });
}

/** 按 _uid 取有效用户（changePassword / setPassword 用），失败统一 1001 */
function mustUser(uid) {
  if (!uid) { return Promise.reject(new R.BizError(C.CODE.UNAUTHORIZED, '请先登录')); }
  return db.collection('user').doc(String(uid)).get().then(function (res) {
    var u = res.data;
    if (!u || u.isActive === false) { throw new R.BizError(C.CODE.UNAUTHORIZED, '请先登录'); }
    return u;
  }).catch(function (err) {
    if (err instanceof R.BizError) { throw err; }
    throw new R.BizError(C.CODE.UNAUTHORIZED, '请先登录');
  });
}

/**
 * 库存精度巡检（管理端登录成功后触发，**终身只跑一次**）：
 *   · op_log 里已有 target='库存精度巡检' 的记录 → 直接跳过（不再每次登录扫全表）
 *   · 没跑过 → 扫 stock_balance 存量残渣并归零（只改 qty 一个字段；保守上限见 stockfix.js）
 *   · 全链路吞错 + 调用方不 await：登录成功/失败的语义一个字都不变，也不阻塞登录返回
 *   · stockfix 用「链内 require」而非文件顶部 require —— 万一巡检模块没部署上，
 *     也只让这条后台链路失败，绝不让 login 本身崩掉。
 */
function fireStockFixOnce() {
  Promise.resolve()
    .then(function () {
      return db.collection('op_log').where({ target: '库存精度巡检' }).limit(1).get();
    })
    .then(function (res) {
      if (res && res.data && res.data.length > 0) { return null; }   // 巡检过 → 跳过
      return require('./stockfix').runFix(db).then(function (out) {
        var n = (out.fixed || []).length;
        return dbh.log(db, 'system', '系统', C.ACTION.MATERIAL_UPDATE,
          '库存精度巡检', '扫描 ' + out.scanned + ' 条（管理端登录触发）', '修正 ' + n + ' 条');
      });
    })
    .catch(function (e) {
      console.log('[login] stockfix skip: ' + String((e && (e.errMsg || e.message)) || e));
    });
}

/** 统一身份返回结构（含闭店拦截：shop 且门店 closed → 1001） */
function buildIdentity(u) {
  var storePromise = u.role === C.ROLE.SHOP && u.storeId
    ? db.collection('store').doc(u.storeId).get().catch(function () { return { data: null }; })
    : Promise.resolve({ data: null });
  return storePromise.then(function (sres) {
    var st = sres && sres.data;
    if (st && st.status === C.STORE_STATUS.CLOSED) {
      throw new R.BizError(C.CODE.UNAUTHORIZED, '该门店已闭店，如需恢复请联系管理端');
    }
    return {
      _id: u._id,
      role: u.role,
      storeId: u.storeId || null,
      name: u.name,
      username: u.username || '',
      needChangePassword: u.role === C.ROLE.MANAGER && u.passwordChanged !== true,
      store: st ? { _id: st._id, code: st.code, name: st.name, status: st.status, closedAt: st.closedAt || null } : null
    };
  });
}

exports.main = R.wrap(function (event) {
  var action = String(event.action || 'login');

  /* ---------------- 附加动作：管理端首登改密（按 _uid） ---------------- */
  if (action === 'setPassword') {
    return mustUser(event._uid).then(function (u) {
      if (u.passwordChanged === true) {
        throw new R.BizError(C.CODE.NEGATIVE, '已完成首登改密，无需重复设置');
      }
      var pwd = String(event.newPassword || '');
      if (pwd.length < 6) { throw new R.BizError(C.CODE.NEGATIVE, '密码至少 6 位'); }
      return db.collection('user').doc(u._id).update({
        data: { password: pwd, passwordChanged: true }
      }).then(function () {
        return dbh.log(db, u._id, u.name, 'user.resetPassword', '管理端首登设置密码', '', 'passwordChanged=true');
      }).then(function () {
        return { passwordChanged: true };
      });
    });
  }

  /* ---------------- 附加动作：登录态自助改密（按 _uid，校验原密码） ---------------- */
  if (action === 'changePassword') {
    return mustUser(event._uid).then(function (u) {
      if (String(event.oldPassword || '') !== u.password) {
        throw new R.BizError(C.CODE.NEGATIVE, '原密码不正确');
      }
      var pwd = String(event.newPassword || '');
      if (pwd.length < 6) { throw new R.BizError(C.CODE.NEGATIVE, '新密码至少 6 位'); }
      return db.collection('user').doc(u._id).update({ data: { password: pwd } })
        .then(function () {
          return dbh.log(db, u._id, u.name, 'user.resetPassword', '自助修改密码', '', 'ok');
        }).then(function () { return { passwordChanged: true }; });
    });
  }

  /* ---------------- 默认：账号密码登录 ---------------- */
  var username = String(event.username || '').trim();
  var password = String(event.password || '');
  if (!username || !password) { throw new R.BizError(C.CODE.NEGATIVE, '请输入账号和密码'); }

  var findByUsername = function () {
    return db.collection('user').where({ username: username }).limit(1).get();
  };

  return findByUsername().catch(function (err) {
    // 集合缺失 → 自举建齐后重试一次
    if (!isCollectionMissing(err)) { throw err; }
    return ensureBootstrap().then(findByUsername);
  }).then(function (res) {
    var u = res.data && res.data[0];
    if (u && u.isActive !== false) { return u; }
    // 账号不存在 → 可能是全新库还没自举 → 补跑一次自举再查（覆盖 manager 首登）
    return ensureBootstrap().then(findByUsername).then(function (res2) {
      var u2 = res2.data && res2.data[0];
      if (!u2 || u2.isActive === false) {
        throw new R.BizError(C.CODE.UNAUTHORIZED, '账号不存在，请先注册开店或使用管理端预置账号');
      }
      return u2;
    });
  }).then(function (u) {
    // 系统预置账号被改坏（role 乱值，如被手滑改成 '111111'）→ 就地重置为全新默认 888/888888
    //（必须在密码校验前修：修完按默认密码比对，本次登录即可成功并正确路由到管理端）
    if (u && u._id === 'user_manager' && u.role !== C.ROLE.MANAGER) {
      var fix = { role: C.ROLE.MANAGER, username: '888', password: '888888',
        passwordChanged: false, isActive: true, updatedAt: dbh.nowIso() };
      return db.collection('user').doc(u._id).update({ data: fix }).then(function () {
        console.log('[login] manager repair-on-login: role=' + String(u.role) + ' → manager / 888 / 888888');
        // 顺手清理误建/失效僵尸账号（含被误建的重复管理端）；失败不影响登录
        return purgeJunkUsers().then(function () { return Object.assign({}, u, fix); });
      });
    }
    return u;
  }).then(function (u) {
    if (u.password !== password) {
      throw new R.BizError(C.CODE.UNAUTHORIZED, '密码不正确');
    }
    return buildIdentity(u).then(function (identity) {
      // 管理端登录成功 → 后台顺带一次性巡检库存精度（不 await：不阻塞登录返回）
      if (identity.role === C.ROLE.MANAGER) { fireStockFixOnce(); }
      return identity;
    });
  });
});
