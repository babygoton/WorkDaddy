'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function helpers() {
  const start = source.indexOf('    function usagePieData(');
  assert.ok(start >= 0, 'shared chart helper exists');
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ctx = { esc: escape, escAttr: escape, formatTokenCount: String, usageTrendColors: () => Array.from({length:12}, (_,i) => 'var(--wbs-trend-series-'+(i+1)+')') };
  vm.runInNewContext(source.slice(start, source.indexOf('    function usageTrendGroups(', start)), ctx);
  return ctx;
}
test('pie includes the whole distribution and preserves all grouped detail rows', () => {
  const h = helpers();
  const rows = Array.from({length:15}, (_,i) => ({label:'Model '+i,value:i+1,calls:2}));
  const data = h.usagePieData(rows);
  assert.equal(data.total, 120);
  assert.equal(data.segments.length, 8);
  assert.equal(data.segments.at(-1).value, 36);
  assert.equal(data.segments.at(-1).children.length, 8);
  assert.equal(data.segments.reduce((sum,r)=>sum+r.value,0), data.total);
  const html = h.usagePieHtml(rows, '模型用量', 'Token', String, '暂无模型数据');
  for (const row of rows) assert.ok(html.includes('>'+row.label+'<'));
  assert.match(html, /<details/);
  assert.match(html, /30\.0%/);
});
test('pie handles empty, invalid and single values without invalid SVG and escapes labels', () => {
  const h = helpers();
  assert.equal(h.usagePieData([{value:0},{value:-2},{value:Infinity},{value:NaN}]).total, 0);
  const empty = h.usagePieHtml([], '模型用量', 'Token', String, '暂无模型数据');
  assert.match(empty, /暂无模型数据/);
  assert.doesNotMatch(empty, /<svg|NaN|Infinity/);
  const html = h.usagePieHtml([{label:'<img src=x onerror="bad">',value:100,calls:2}], '模型用量', 'Token', String, '暂无模型数据');
  assert.match(html, /100\.0%/);
  assert.match(html, /<circle cx="64" cy="64" r="58"/);
  assert.doesNotMatch(html, /stroke-dasharray|wbs-pie-total/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
test('both usage tabs chart accounts and models without truncating token model totals', () => {
  const modal = source.slice(source.indexOf('    function onTokenStats()'),source.indexOf('    // ===== Tab 切换'));
  assert.equal((modal.match(/usagePieHtml\(/g)||[]).length,4);
  assert.doesNotMatch(modal, /stats\.models \|\| \[\]\)\.slice\(0, 12\)/);
});

test('pie hover and keyboard focus preview the selected slice and matching row, then clear on exit', () => {
  const h = helpers();
  h.window = { innerWidth: 360, innerHeight: 700 };
  function item(index, attrs = {}) {
    const classes = new Set();
    return { classes, classList: { add: x => classes.add(x), remove: x => classes.delete(x), toggle: (x,on) => on ? classes.add(x) : classes.delete(x) },
      getAttribute: k => k === 'data-pie-index' ? String(index) : attrs[k],
      closest() { return this; }, getBoundingClientRect: () => ({left:320,bottom:680,width:20}) };
  }
  const slices = [0,1].map(i => item(i, { 'data-pie-label':'Model '+i,'data-pie-value':'20 Token','data-pie-percent':'25.0%','data-pie-calls':'3' }));
  const rows = [item(0), item(1)];
  const labels = { strong:{}, '[data-pie-tip-value]':{}, '[data-pie-tip-detail]':{} };
  const tip = {hidden:true,style:{},querySelector:key=>labels[key],getBoundingClientRect:()=>({width:180,height:80})};
  const handlers = {}, section = item(-1);
  section.querySelector = selector => selector === '.wbs-pie-tooltip' ? tip : slices[Number(selector.match(/index="(\d+)"/)[1])];
  section.querySelectorAll = () => [...slices,...rows];
  section.addEventListener = (type, callback) => {handlers[type]=callback;};
  h.wireUsagePies({querySelectorAll:()=>[section]});
  handlers.pointermove({target:slices[1],clientX:350,clientY:690});
  assert.equal(tip.hidden,false);
  assert.equal(labels.strong.textContent,'Model 1');
  assert.equal(labels['[data-pie-tip-detail]'].textContent,'25.0% · 3 次');
  assert.equal(rows[1].classes.has('is-preview'),true);
  assert.equal(rows[0].classes.has('is-preview'),false);
  assert.ok(parseFloat(tip.style.left)+180<=352);
  assert.ok(parseFloat(tip.style.top)+80<=700);
  handlers.pointerleave();
  assert.equal(tip.hidden,true);
  handlers.focusin({target:slices[0]});
  assert.equal(tip.hidden,false);
  let stopped=false;
  handlers.keydown({key:'Escape',stopPropagation(){stopped=true;}});
  assert.equal(stopped,true);
  assert.equal(tip.hidden,true);
});
