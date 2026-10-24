// ==========================================================================
// components/search-picker — 可搜索的食材下拉弹窗（替换微信 picker 弹层）
// 老板 2026-09-12：默认 picker 弹层里字号太小、不便选择；自定义弹窗 32rpx 大字号 + 搜索框。
// ==========================================================================
var fmt = require('../../utils/format');

Component({
  properties: {
    options: { type: Array, value: [] },         // [{ _id, label, ... }]
    value: { type: String, value: '', optionalTypes: [null] },   // 当前选中的 _id（未选时容许 null）
    placeholder: { type: String, value: '请选择 ▾' },
    disabled: { type: Boolean, value: false }
  },

  data: {
    open: false,
    keyword: '',
    filtered: [],
    currentLabel: ''
  },

  observers: {
    'options, value': function (opts, val) {
      var hit = opts.filter(function (o) { return o._id === val; })[0];
      this.setData({ currentLabel: hit ? (hit.label || hit.name || '') : '' });
    }
  },

  methods: {
    /** 点主输入框 → 打开弹窗 */
    onOpen: function () {
      if (this.data.disabled) { return; }
      var kw = this.data.keyword || '';
      this.setData({ open: true, keyword: kw, filtered: this.applyFilter(opts(this), kw) });
    },

    /** 关弹窗 */
    onClose: function () { this.setData({ open: false }); },

    /** 搜索框输入 → 实时过滤 */
    onSearchInput: function (e) {
      var kw = e.detail.value || '';
      this.setData({ keyword: kw, filtered: this.applyFilter(opts(this), kw) });
    },

    /** 清空搜索 */
    onClearSearch: function () {
      this.setData({ keyword: '', filtered: opts(this) });
    },

    /** 点某行 → 触发外部 change（透传外层 data-i / dataset） */
    onPick: function (e) {
      var id = e.currentTarget.dataset.id;
      var detail = { value: id };
      // 透传 trigger 上其它 dataset（如 data-i）
      var keys = Object.keys(e.currentTarget.dataset || {});
      keys.forEach(function (k) { if (k !== 'id') { detail[k] = e.currentTarget.dataset[k]; } });
      this.triggerEvent('change', detail);
      this.setData({ open: false, keyword: '' });
    },

    /** 阻止冒泡（点遮罩外面空白区不关） */
    noop: function () {},

    /** 内部过滤（label 优先，缺 label 兜底 name——采购/详情等页选项字段不统一） */
    applyFilter: function (list, kw) {
      kw = String(kw || '').trim().toLowerCase();
      if (!kw) { return list.slice(); }
      return list.filter(function (o) {
        var text = String(o.label || o.name || '');
        return text.toLowerCase().indexOf(kw) >= 0;
      });
    }
  }
});

// 内部 helper：组件的 properties/options 通过 this.data 拿
function opts(self) { return self.data.options || []; }
