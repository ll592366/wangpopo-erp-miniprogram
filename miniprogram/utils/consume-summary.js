// ==========================================================================
// utils/consume-summary.js — 消耗汇总页公共实现（管理端 / 门店端共用）
//   · 两页逻辑近乎相同 → 抽成 buildPage(cfg) 工厂：
//       页面 js 只写 Page(buildPage({ role: 'manager' | 'shop' }))，不复制两份长 js。
//   · 数据来源：production 云函数 action='summary'（后端一次性聚合，非分页）
//       请求：{ action:'summary', from:'YYYY-MM-DD', to:'YYYY-MM-DD',
//               groupBy:'material'|'dish', storeId:''（管理端；空=全部门店） }
//       返回 data：{ from, to, groupBy, storeId, rows:[...], truncated }
//         · groupBy='material'：rows[].{ id, name, unit, qty, count,
//                                       detail:[{ id, name, qty, portions }] }
//         · groupBy='dish'    ：rows[].{ id, name, portions, itemCount,
//                                       detail:[{ id, name, unit, qty }] }
//         · truncated=true → 后端聚合触及上限，结果为「不完整聚合」（不静默少算，页面给轻提示）
//   · 两种维度统一落到同一渲染模型，减少分支：
//       { id, title, value, sub, open, details:[{ title, value, sub }] }
//   · 时间范围（老板 2026-09-19 加「自定义」）：统一由 utils/date-range.js 提供，
//       本文件只转发，不再留第二套 rangeOf / weekStart / monthStart / labelOf / emptyText。
// ==========================================================================
var cloud = require('./cloud');
var fmt = require('./format');
var dr = require('./date-range');

/** 汇总页档位：在消耗记录四档基础上多一档「今日」（保留原能力，老板 2026-09-19 加「自定义」） */
var RANGES = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'custom', label: '自定义' },
  { key: 'all', label: '全部' }
];

/* ---- 范围逻辑统一转发到 utils/date-range.js（保持对外导出签名不变，两页零改动） ---- */
var rangeOf = dr.rangeOf;
var labelOf = dr.labelOf;
var emptyText = dr.emptyText;
var weekStart = dr.weekStart;
var monthStart = dr.monthStart;

/** 云函数 rows → 统一渲染模型（两维度共用） */
function normalize(raw, groupBy) {
  return (raw || []).map(function (it) {
    it = it || {};
    var unit = it.unit || '';
    var out = {
      id: it.id || it._id || '',
      title: it.name || it.id || '',
      value: '',
      sub: '',
      open: false,
      details: []
    };
    if (groupBy === 'dish') {
      out.value = '出品 ' + fmt.fmt3(it.portions || 0) + ' 份';
      out.sub = '共 ' + Number(it.itemCount || 0) + ' 种食材';
      out.details = (it.detail || []).map(function (dt) {
        dt = dt || {};
        var du = dt.unit || '';
        return {
          title: dt.name || dt.id || '',
          value: fmt.fmt3(dt.qty || 0) + (du ? ' ' + du : ''),
          sub: ''
        };
      });
    } else {
      out.value = fmt.fmt3(it.qty || 0) + (unit ? ' ' + unit : '');
      out.sub = '共 ' + Number(it.count || 0) + ' 道菜';
      out.details = (it.detail || []).map(function (dt) {
        dt = dt || {};
        return {
          title: dt.name || dt.id || '',
          value: fmt.fmt3(dt.qty || 0) + (unit ? ' ' + unit : ''),
          sub: dt.portions ? (fmt.fmt3(dt.portions) + ' 份') : ''
        };
      });
    }
    return out;
  });
}

/**
 * 构造页面配置（可直接传给 Page()）
 * @param {{role:'manager'|'shop'}} cfg
 */
function buildPage(cfg) {
  cfg = cfg || {};
  var isManager = cfg.role === 'manager';
  var today = dr.today();

  return {
    data: {
      isManager: isManager,
      ranges: RANGES,
      range: 'month',
      rangeLabel: '本月',
      groupBy: 'material',
      storeId: '',
      storeIndex: 0,
      storeName: '全部门店',
      storeOptions: [],
      customFrom: dr.monthStart(today),   // 自定义默认：本月 1 号
      customTo: today,                    // 自定义默认：今天
      rows: [],
      loading: false,
      summaryTruncated: false,            // 后端聚合触及上限 → 给轻提示，不静默少算
      emptyText: '本月暂无消耗记录'
    },

    onLoad: function () {
      wx.setNavigationBarTitle({ title: isManager ? '消耗汇总 · 管理端' : '消耗汇总 · 门店端' });
      if (isManager) { this.loadStores(); }
    },

    onShow: function () { this.loadAll(); },

    onPullDownRefresh: function () {
      this.loadAll();
      wx.stopPullDownRefresh();
    },

    /* 管理端：门店下拉（全部门店 + 各分店）；门店端不显示该行也不拉门店档 */
    loadStores: function () {
      var that = this;
      cloud.call('store', { action: 'list' }).then(function (res) {
        if (res.code !== 0) {
          wx.showToast({ title: res.message || '加载门店失败，请重试', icon: 'none', duration: 2600 });
          return;
        }
        var rows = (res.data && (res.data.rows || res.data.list)) || [];
        var options = [{ _id: '', name: '全部门店' }].concat(rows.map(function (s) {
          return { _id: s._id, name: s.name };
        }));
        that.setData({ storeOptions: options, storeIndex: 0, storeId: '', storeName: '全部门店' });
      });
    },

    switchRange: function (e) {
      var k = e.currentTarget.dataset.key;
      if (k === this.data.range) { return; }
      var patch = { range: k, rangeLabel: labelOf(k, { from: this.data.customFrom, to: this.data.customTo }) };
      if (k === 'custom') {
        // 进入自定义：确保有合法默认值（缺值兜底成本月）
        patch.customFrom = this.data.customFrom || dr.monthStart(dr.today());
        patch.customTo = this.data.customTo || dr.today();
      }
      this.setData(patch);
      this.loadAll();
    },

    /* 自定义：改起始日期；from > to 时自动把 to 拉到 from（不发非法区间） */
    onFromChange: function (e) {
      var v = e.detail.value;
      var to = this.data.customTo;
      if (v > to) { to = v; }
      this.setData({ customFrom: v, customTo: to });
      this.loadAll();
    },

    /* 自定义：改结束日期；to < from 时自动把 from 拉到 to */
    onToChange: function (e) {
      var v = e.detail.value;
      var from = this.data.customFrom;
      if (v < from) { from = v; }
      this.setData({ customFrom: from, customTo: v });
      this.loadAll();
    },

    switchGroup: function (e) {
      var g = e.currentTarget.dataset.key;
      if (g === this.data.groupBy) { return; }
      this.setData({ groupBy: g });
      this.loadAll();
    },

    onStoreChange: function (e) {
      var idx = Number(e.detail.value) || 0;
      var opt = this.data.storeOptions[idx] || { _id: '', name: '全部门店' };
      this.setData({ storeIndex: idx, storeId: opt._id || '', storeName: opt.name });
      this.loadAll();
    },

    /* 就地展开 / 收起明细（不跳页） */
    toggleRow: function (e) {
      var idx = Number(e.currentTarget.dataset.index);
      if (isNaN(idx) || !this.data.rows[idx]) { return; }
      var patch = {};
      patch['rows[' + idx + '].open'] = !this.data.rows[idx].open;
      this.setData(patch);
    },

    loadAll: function () {
      var that = this;
      var d = this.data;
      var custom = { from: d.customFrom, to: d.customTo };
      var r = rangeOf(d.range, custom);
      var req = { action: 'summary', from: r.from, to: r.to, groupBy: d.groupBy };
      if (isManager) { req.storeId = d.storeId || ''; }

      that.setData({ loading: true });
      cloud.call('production', req).then(function (res) {
        if (res.code !== 0) {
          // 失败弹 toast，不静默留空（老板口径：静默留空当 bug）
          that.setData({ loading: false, rows: [], summaryTruncated: false, emptyText: emptyText(that.data.range, custom) });
          wx.showToast({ title: res.message || '加载失败，请重试', icon: 'none', duration: 2600 });
          return;
        }
        var data = res.data || {};
        that.setData({
          loading: false,
          rows: normalize(data.rows || [], that.data.groupBy),
          summaryTruncated: !!data.truncated,     // 聚合触及上限 → 页面显示轻提示
          emptyText: emptyText(that.data.range, custom)
        });
      });
    }
  };
}

module.exports = {
  buildPage: buildPage,
  rangeOf: rangeOf,
  normalize: normalize,
  emptyText: emptyText,
  labelOf: labelOf,
  weekStart: weekStart,
  monthStart: monthStart
};
