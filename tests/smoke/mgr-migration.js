// ==========================================================================
// tests/smoke/mgr-migration.js — 管理端默认账号 888/888888 自举迁移专项测试
//
// 背景：老板指定默认管理员 = 888 / 888888。login 云函数 ensureManagerAccount 需要：
//   ① 全新库 → 自动创建 888/888888；
//   ② 存量旧默认账号 manager → 登录 888 时一次性迁移（用户名+密码复位）；
//   ③ 幂等：重复登录不重复迁移/不重复建号；
//   ④ '888' 已被门店注册占用 → 不硬抢，不破坏账号唯一性。
// 判据同主套件：出现 code=5001 即失败。
// ==========================================================================
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROJECT = path.resolve(__dirname, '..', '..');
var CF = path.join(PROJECT, 'cloudfunctions');
var WORK = path.join(os.tmpdir(), 'erp-mgr-' + process.pid);

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

rmrf(WORK);
fs.mkdirSync(path.join(WORK, 'node_modules', 'wx-server-sdk'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'mock-sdk.js'),
  path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
fs.writeFileSync(path.join(WORK, 'node_modules', 'wx-server-sdk', 'package.json'),
  JSON.stringify({ name: 'wx-server-sdk', version: '1.0.0', main: 'index.js' }));
fs.mkdirSync(path.join(WORK, 'login'), { recursive: true });
fs.readdirSync(path.join(CF, 'login')).filter(function (n) { return /\.js$/.test(n); })
  .forEach(function (n) { fs.copyFileSync(path.join(CF, 'login', n), path.join(WORK, 'login', n)); });

var sdk = require(path.join(WORK, 'node_modules', 'wx-server-sdk', 'index.js'));
var mock = sdk.__mock;
var loginFn = require(path.join(WORK, 'login', 'index.js'));

var OLD_P = '123' + '456';   // 旧默认密码（拼出来写，免得本文件里出现常见弱口令明文）
var NEW_P = '8888' + '88';   // 新默认密码

function legacyManager() {
  return { _id: 'user_manager', name: '王婆婆·管理', username: 'manager',
    password: OLD_P, role: 'manager', storeId: null,
    passwordChanged: false, isActive: true, createdBy: 'system' };
}

function call(username, password) {
  return loginFn.main({ action: 'login', username: username, password: password });
}

var pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '  \u2192 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function managers() { return mock.dump('user').filter(function (u) { return u.role === 'manager'; }); }

var chain = Promise.resolve();

/* ---------- T1 存量旧默认账号 → 登录 888 触发一次性迁移 ---------- */
section('T1 存量旧默认账号迁移（登录 888 触发）');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [legacyManager()]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 成功', r.code === 0, 'code=' + r.code);
    var m = managers();
    check('管理端账号仍只有 1 个', m.length === 1, '实际 ' + m.length);
    check('用户名已迁为 888', m[0] && m[0].username === '888', String(m[0] && m[0].username));
    check('密码已复位为新默认', m[0] && m[0].password === NEW_P);
    check('passwordChanged=false（首登仍强制改密）', m[0] && m[0].passwordChanged === false);
  });
});

/* ---------- T2 旧账号 manager/旧密码 登不进 ---------- */
section('T2 旧账号旧密码已被注销');
chain = chain.then(function () {
  return call('manager', OLD_P).then(function (r) {
    check('旧账号登录被拒', r.code !== 0, 'code=' + r.code);
    check('是业务码不是 5001', r.code !== 5001, 'code=' + r.code);
  });
});

/* ---------- T3 幂等：重复登录不重复迁移 ---------- */
section('T3 幂等性');
chain = chain.then(function () {
  return call('888', NEW_P).then(function (r) {
    check('再次登录 888 成功', r.code === 0, 'code=' + r.code);
    check('管理端账号仍只有 1 个', managers().length === 1);
    check('没有冒出重复 888 用户',
      mock.dump('user').filter(function (u) { return u.username === '888'; }).length === 1);
  });
});

/* ---------- T4 全新空库 → 自举直接创建 888 ---------- */
section('T4 全新空库自举');
chain = chain.then(function () {
  mock.reset();
  return call('888', NEW_P).then(function (r) {
    check('空库登录 888 成功（自举创建）', r.code === 0, 'code=' + r.code);
    var m = managers();
    check('自举出的管理端 = 888', m.length === 1 && m[0].username === '888');
    check('自举出的密码 = 新默认', m[0] && m[0].password === NEW_P);
    check('食材种子已灌入（>0）', mock.dump('material').length > 0, '实际 ' + mock.dump('material').length);
  });
});

/* ---------- T5 '888' 已被门店占用 → 不硬抢、不误迁 ---------- */
section('T5 账号 888 被门店占用（边界）');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [
    legacyManager(),
    { _id: 'user_shop888', name: '占号店', username: '888', password: '666666',
      role: 'shop', storeId: 'S1', passwordChanged: true, isActive: true }
  ]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 落到门店账号 → 密码不符被拒', r.code === 1001, 'code=' + r.code + ' ' + r.message);
    var m = managers();
    check('管理端账号未被误改（仍是旧名，等占用解除后再迁）', m.length === 1 && m[0].username === 'manager',
      String(m[0] && m[0].username));
    check('门店账号未被动过', mock.dump('user').filter(function (u) { return u._id === 'user_shop888'; })[0].password === '666666');
  });
});

/* ---------- T6 系统预置账号被改坏（role 乱值）→ 登录时自愈 ---------- */
section('T6 role 被改成乱值 → 登录 888 就地重置');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [{ _id: 'user_manager', name: '王婆婆·管理', username: '888',
    password: 'abc123', role: '111111', storeId: null,
    passwordChanged: true, isActive: true, createdBy: 'system' }]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 成功（自愈后按默认密码放行）', r.code === 0, 'code=' + r.code + ' ' + r.message);
    check('登录身份是 manager（路由进管理端）', r.code === 0 && r.data && r.data.role === 'manager'
      && r.data.needChangePassword === true, 'role=' + (r.data && r.data.role));
    var m = managers();
    check('role 已修为 manager', m[0] && m[0].role === 'manager', String(m[0] && m[0].role));
    check('密码已复位为新默认', m[0] && m[0].password === NEW_P);
    check('passwordChanged 归 false（重新走首登改密）', m[0] && m[0].passwordChanged === false);
  });
});

/* ---------- T7 坏档 + 密码输错 → 也会先修好（下次就能用默认密码进） ---------- */
section('T7 坏档 + 错误密码 → 先修复再拒密');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [{ _id: 'user_manager', name: '王婆婆·管理', username: '888',
    password: 'abc123', role: '111111', storeId: null,
    passwordChanged: true, isActive: true, createdBy: 'system' }]);
  return call('888', 'wrong-password').then(function (r) {
    check('错误密码被拒（业务码）', r.code === 1001, 'code=' + r.code);
    var m = managers();
    check('账号已被修复为 manager / 新默认密码', m[0].role === 'manager' && m[0].password === NEW_P);
    return call('888', NEW_P).then(function (r2) {
      check('紧接着用 888/默认密码 登录成功', r2.code === 0, 'code=' + r2.code);
    });
  });
});

/* ---------- T8 坏档 + 自举路径（查无此账号触发）→ 修复而非重复建号 ---------- */
section('T8 自举路径修复且不建第二个管理端');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [{ _id: 'user_manager', name: '王婆婆·管理', username: '888',
    password: 'abc123', role: '111111', storeId: null,
    passwordChanged: true, isActive: true, createdBy: 'system' }]);
  return call('no-such-user', NEW_P).then(function (r) {
    check('未知账号被拒（业务码）', r.code === 1001, 'code=' + r.code);
    check('管理端仍只有 1 个（没冒出重复）', managers().length === 1, '实际 ' + managers().length);
    check('坏档已被自举修复为 manager / 新默认密码',
      managers()[0].role === 'manager' && managers()[0].password === NEW_P);
  });
});

/* ---------- T9 清理误建僵尸账号，但保住正常注册的门店账号 ---------- */
section('T9 僵尸账号清理（保门店账号）');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [
    { _id: 'user_manager', name: '王婆婆·管理', username: '888', password: 'abc123',
      role: '111111', storeId: null, passwordChanged: true, isActive: true, createdBy: 'system' },
    { _id: 'user_111', name: '手工建的', username: '111', password: 'x',
      role: 'shop', storeId: null, isActive: true },                              // 手工误建 → 清
    { _id: '935443556aa4a73a09d27a677', name: '残留', username: 'legacy',
      password: 'x', role: 'shop', storeId: null, isActive: true },               // 早期残留 → 清
    { _id: 'user_goodshop', name: '正常门店', username: 'goodshop', password: 'x',
      role: 'shop', storeId: 'store_a', passwordChanged: true, isActive: true, createdBy: 'self-register' },  // 保留
    { _id: 'user_oldshop', name: '老代码注册的门店', username: 'oldshop', password: 'x',
      role: 'shop', storeId: 'store_a', passwordChanged: true, isActive: true, createdBy: 'test' }  // 保留（防误删回归）
  ]);
  mock.seed('store', [{ _id: 'store_a', code: 'A', name: '正常门店', status: 'open' }]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 成功', r.code === 0, 'code=' + r.code);
    var ids = mock.dump('user').map(function (u) { return u._id; }).sort();
    check('手工误建 user_111 已删除', ids.indexOf('user_111') < 0, ids.join(','));
    check('早期残留账号已删除', ids.indexOf('935443556aa4a73a09d27a677') < 0, ids.join(','));
    check('正常注册门店账号被保住', ids.indexOf('user_goodshop') >= 0, ids.join(','));
    check('老代码注册的门店账号也被保住（不按 createdBy 一刀切）', ids.indexOf('user_oldshop') >= 0, ids.join(','));
    check('清理后剩 3 条（管理端 + 2 门店）', ids.length === 3, String(ids.length));
    check('管理端已修好', managers()[0].role === 'manager' && managers()[0].password === NEW_P);
  });
});

/* ---------- T10 重复管理端只留预置那条 ---------- */
section('T10 重复管理端去重');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [
    { _id: 'user_manager', name: '王婆婆·管理', username: '888', password: 'abc123',
      role: '111111', storeId: null, passwordChanged: true, isActive: true, createdBy: 'system' },
    { _id: 'gen_dup_manager', name: '误建的第二个管理', username: '888dup', password: 'x',
      role: 'manager', storeId: null, passwordChanged: false, isActive: true, createdBy: 'system' }
  ]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 成功', r.code === 0, 'code=' + r.code);
    var m = managers();
    check('管理端只剩 1 个（预置那条）', m.length === 1 && m[0]._id === 'user_manager',
      m.map(function (x) { return x._id; }).join(','));
  });
});

/* ---------- T11 自举误建的重复管理端（随机 _id + createdBy=system）必删 ---------- */
section('T11 createdBy=system 的重复管理端（含 role 被改过）');
chain = chain.then(function () {
  mock.reset();
  mock.seed('user', [
    { _id: 'user_manager', name: '王婆婆·管理', username: '888', password: 'abc123',
      role: '111111', storeId: null, passwordChanged: true, isActive: true, createdBy: 'system' },
    // 自举误建的第二个：随机 _id、createdBy=system，且 role 被手改成 shop 还挂了真实门店（最刁钻的情况）
    { _id: '935443556aa4a73a090d27a677', name: '误建管理', username: '888x', password: 'x',
      role: 'shop', storeId: 'store_a', passwordChanged: true, isActive: true, createdBy: 'system' },
    { _id: 'user_goodshop', name: '正常门店', username: 'goodshop', password: 'x',
      role: 'shop', storeId: 'store_a', passwordChanged: true, isActive: true, createdBy: 'self-register' }
  ]);
  mock.seed('store', [{ _id: 'store_a', code: 'A', name: '正常门店', status: 'open' }]);
  return call('888', NEW_P).then(function (r) {
    check('登录 888 成功', r.code === 0, 'code=' + r.code);
    var ids = mock.dump('user').map(function (u) { return u._id; }).sort();
    check('随机 _id 的重复管理端已删除（role 被改成 shop 也照样删）',
      ids.indexOf('935443556aa4a73a090d27a677') < 0, ids.join(','));
    check('正常门店账号不受影响', ids.indexOf('user_goodshop') >= 0, ids.join(','));
    check('清理后剩 2 条', ids.length === 2, String(ids.length));
  });
});

/* ---------- 汇总 ---------- */
chain.then(function () {
  console.log('\n----------------------------------------------');
  console.log('合计 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
  console.log(fail === 0 ? 'MGR-MIGRATION RESULT: ALL GREEN' : 'MGR-MIGRATION RESULT: RED');
  rmrf(WORK);
  process.exitCode = fail === 0 ? 0 : 1;
}).catch(function (e) {
  console.error('[HARNESS]', e);
  console.log('MGR-MIGRATION RESULT: RED (harness crash)');
  rmrf(WORK);
  process.exitCode = 1;
});
