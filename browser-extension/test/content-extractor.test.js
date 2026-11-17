import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import '../content-extractor.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function fixture(body, options = {}) {
  const { document } = parseHTML(`<!doctype html><html><head><title>活动策划 - 飞书云文档</title></head><body><nav>菜单 分享 评论 raina</nav><div id="scroll"><article class="docx-root-block">${body}</article></div></body></html>`);
  const scroll = document.querySelector('#scroll'); let position = 0; let clock = 0;
  Object.defineProperties(scroll, {
    scrollTop: { get: () => position, set: (value) => { position = value; options.onScroll?.(value, document.querySelector('article')); } },
    scrollHeight: { get: () => options.height || 300 }, clientHeight: { get: () => 300 },
  });
  scroll.scrollTo = ({ top }) => { scroll.scrollTop = top; };
  document.scrollingElement = scroll;
  const environment = {
    document, location: new URL(options.url || 'https://team.feishu.cn/docx/ValidDoc123'),
    getComputedStyle: (node) => ({ display: node.style?.display || 'block', visibility: 'visible', overflowY: node === scroll ? 'auto' : 'visible' }),
    wait: async (ms) => { clock += ms; }, now: () => clock,
    fetch: options.fetch,
  };
  return { document, scroll, reader: globalThis.QzzFeishuContent.createReader(environment) };
}

test('reads document headings, paragraphs, intentional repeats, lists, tables and images without page chrome', async () => {
  const { reader } = fixture(`
    <div data-block-id="heading"><h2>活动入口</h2></div>
    <div data-block-id="one"><p>活动开启时展示入口。</p></div>
    <div data-block-id="repeat1"><p>同一段落。</p></div><div data-block-id="repeat2"><p>同一段落。</p></div>
    <div data-block-id="list"><li>点击进入详情页。</li></div>
    <div data-block-id="table"><table><tr><th>等级</th><th>结果</th></tr><tr><td>10</td><td>显示入口</td></tr><tr><td>9</td><td>隐藏入口</td></tr></table></div>
    <div data-block-id="image"><p>布局参考<img src="https://img.feishucdn.com/sample.png"></p></div>
    <div class="watermark">raina 水印</div><div role="toolbar">评论 分享</div>
  `);
  const result = await reader.extractDocument({ maxMs: 6000, scrollWaitMs: 100 });
  assert.equal(result.title, '活动策划'); assert.equal(result.completeness, 'complete');
  assert.match(result.text, /^## 活动入口/); assert.equal(result.text.match(/同一段落/g).length, 2);
  assert.match(result.text, /\| 等级 \| 结果 \|/); assert.match(result.text, /\| 9 \| 隐藏入口 \|/);
  assert.match(result.text, /\[file#1\]/); assert.equal(result.imageCount, 1); assert.equal(result.loadedBlocks, 7);
  assert.doesNotMatch(result.text, /菜单|分享|评论|raina|水印/);
});

test('scrolls virtualized blocks in order and deduplicates overlapping stable IDs', async () => {
  const pages = [
    '<p data-block-id="a">场景甲。</p><p data-block-id="b">场景乙。</p>',
    '<p data-block-id="b">场景乙。</p><p data-block-id="c">场景丙。</p>',
    '<p data-block-id="c">场景丙。</p><p data-block-id="d">场景丁。</p>',
  ];
  const { reader, scroll } = fixture(pages[0], { height: 900, onScroll(position, root) { const index = position < 200 ? 0 : position < 400 ? 1 : 2; root.innerHTML = pages[index]; } });
  const result = await reader.extractDocument({ maxMs: 6000, scrollWaitMs: 100 });
  assert.equal(result.text, '场景甲。\n\n场景乙。\n\n场景丙。\n\n场景丁。');
  assert.equal(result.loadedBlocks, 4); assert.equal(result.completeness, 'complete'); assert.equal(scroll.scrollTop, 0);
});

test('does not bypass login, access or explicit copying restrictions; never falls back to the body', async () => {
  for (const [body, code, url] of [
    ['<p data-block-id="a">正文</p>', 'LOGIN_REQUIRED', 'https://accounts.feishu.cn/login'],
    ['<div role="alert">没有阅读权限，请申请阅读权限</div>', 'ACCESS_DENIED'],
    ['<div data-copy-disabled="true"><p>禁止复制</p></div>', 'ACCESS_DENIED'],
    ['<div role="alert">网络异常，请稍后重试</div>', 'NETWORK_ERROR'],
  ]) await assert.rejects(fixture(body, { url }).reader.extractDocument({ maxMs: 1000 }), (error) => error.code === code);
  const { reader, document } = fixture('<p>内部正文</p>'); document.querySelector('article').className = 'unknown-reader';
  await assert.rejects(reader.extractDocument({ maxMs: 100 }), (error) => error.code === 'UNSUPPORTED');
});

test('reports canvas, folded or unloaded blocks, unknown totals and text-budget limits explicitly', async () => {
  const { reader, document } = fixture('<p data-block-id="a">正文。</p><canvas></canvas><div data-collapsed="true"></div><p data-block-id="image"><img src=""></p>');
  document.querySelector('article').setAttribute('data-total-block-count', '30');
  const result = await reader.extractDocument({ maxMs: 6000, scrollWaitMs: 100 });
  assert.equal(result.completeness, 'partial'); assert.match(result.warnings.join('\n'), /画板|折叠|只读到|图片/);
  const oversized = fixture(`<p data-block-id="a">开头。</p><p data-block-id="b">${'正文'.repeat(50001)}</p>`);
  const bounded = await oversized.reader.extractDocument({ maxMs: 6000, scrollWaitMs: 100 });
  assert.equal(bounded.text, '开头。'); assert.equal(bounded.completeness, 'partial'); assert.match(bounded.warnings.join(''), /10 万字/);
});

test('caches Blob/data images once and does not read a 65th image on later snapshots', async () => {
  let fetches = 0;
  const body = `<p data-block-id="a">正文。</p>` + Array.from({ length: 65 }, (_, index) => `<div data-block-id="image${index}"><img src="blob:https://team.feishu.cn/image-${index}"></div>`).join('');
  const { reader } = fixture(body, { fetch: async () => { fetches += 1; return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }); } });
  const result = await reader.extractDocument({ maxMs: 6000, scrollWaitMs: 100 });
  assert.equal(fetches, 64); assert.equal(result.images.length, 65); assert.equal(result.images.filter((entry) => entry.data).length, 64);
  assert.equal(result.images[64].loaded, false); assert.equal(result.completeness, 'partial');
  assert.equal(result.images[0].data, png);
});

test('changing an image source cannot reuse old inline image bytes', async () => {
  const { reader, document } = fixture(`<p data-block-id="image"><img src="data:image/png;base64,${png}"></p>`);
  const root = document.querySelector('article');
  await reader.snapshot(root);
  assert.equal([...reader.images.values()][0].data, png);
  document.querySelector('img').setAttribute('src', 'https://img.feishucdn.com/new-image.png');
  await reader.snapshot(root);
  let entry = [...reader.images.values()][0];
  assert.equal(Object.hasOwn(entry, 'data'), false); assert.equal(Object.hasOwn(entry, 'byteLength'), false);
  assert.equal(entry.src, 'https://img.feishucdn.com/new-image.png');
  const newer = Buffer.from('different inline image fixture').toString('base64');
  document.querySelector('img').setAttribute('src', `data:image/png;base64,${newer}`);
  await reader.snapshot(root); entry = [...reader.images.values()][0];
  assert.equal(entry.data, newer); assert.equal(entry.byteLength, Buffer.from(newer, 'base64').length);
});
