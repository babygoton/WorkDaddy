import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const bundle = fs.readFileSync(new URL('../../scripts/markdown-preview.js', import.meta.url), 'utf8');
function setup() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  dom.window.eval(bundle);
  return dom;
}
test('bundled component renders headings, nested lists, fenced code, tables and task lists', () => {
  const dom = setup();
  try {
    const body = dom.window.document.body;
    body.append(dom.window.__wbsMarkdownPreview.render('# 标题\n\n**重点**和`inline`\n\n- 第一项\n  - 子项\n\n```js\nconst a = "<tag>";\n```\n\n| 名称 | 值 |\n| --- | --- |\n| 数据 | 1 |\n\n- [x] 完成\n- [ ] 待处理'));
    assert.equal(body.querySelector('h1').textContent, '标题');
    assert.equal(body.querySelector('strong').textContent, '重点');
    assert.ok(body.querySelector('ul ul li'));
    assert.match(body.querySelector('pre code').textContent, /const a = "<tag>";/);
    assert.equal(body.querySelectorAll('tbody td').length, 2);
    const boxes = [...body.querySelectorAll('input')];
    assert.equal(boxes.length, 2);
    assert.ok(boxes.every(box => box.disabled && box.type === 'checkbox'));
    assert.equal(boxes[0].checked, true);
  } finally { dom.window.close(); }
});
test('untrusted replies cannot add scripts, event handlers, remote images or navigation URLs', () => {
  const dom = setup();
  try {
    const body = dom.window.document.body;
    body.append(dom.window.__wbsMarkdownPreview.render('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n![图片](https://example.com/private.png)\n\n[危险](javascript:alert%281%29) [网页](https://example.com)\n\n<svg onload=alert(3)></svg>'));
    assert.equal(body.querySelectorAll('script,img,svg,iframe,[href],[src],[onerror],[onload]').length, 0);
    assert.match(body.textContent, /图片/);
    assert.equal(body.querySelectorAll('a').length, 2);
    // Reinjection replaces the stateless component instead of mounting extra roots.
    dom.window.eval(bundle);
    assert.equal(body.querySelectorAll('a').length, 2);
  } finally { dom.window.close(); }
});
