import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetURL, documentURL, platformPort, prepareImage, imageMime } from '../shared.js';
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const decode = async () => ({ width: 1, height: 1, close() {} });

test('limits documents, asset hosts, ports and protocols without accepting hostname suffix tricks', () => {
  assert.equal(documentURL('https://team.feishu.cn/wiki/Token123?from=share#x').url, 'https://team.feishu.cn/wiki/Token123');
  assert.equal(documentURL('https://team.larksuite.com/docs/Token123').family, 'larksuite.com');
  assert.equal(assetURL('https://img.feishucdn.com/a?signature=test'), 'https://img.feishucdn.com/a?signature=test');
  for (const url of ['http://team.feishu.cn/docx/a', 'https://feishu.cn.evil.test/docx/a', 'https://user:pass@team.feishu.cn/docx/a', 'https://team.feishu.cn:444/docx/a', 'https://127.0.0.1/docx/a', 'https://team.feishu.cn/base/a', 'javascript:alert(1)']) assert.throws(() => documentURL(url));
  for (const url of ['https://evil.test/a', 'https://img.feishucdn.com.evil.test/a', 'http://img.feishucdn.com/a', 'blob:https://team.feishu.cn/a']) assert.throws(() => assetURL(url));
  assert.equal(platformPort('3210'), 3210); for (const value of [0, 65536, 'abc', 1.1]) assert.throws(() => platformPort(value));
});

test('fetches only approved DOM image URLs with normal session credentials and validates actual image bytes', async () => {
  let request;
  const output = await prepareImage({ id: 'file-1', src: 'https://img.feishucdn.com/a?signature=private' }, 1024, {
    decode, fetcher: async (url, options) => { request = { url, options }; return new Response(bytes, { headers: { 'content-type': 'image/png' } }); },
  });
  assert.equal(request.options.credentials, 'include'); assert.equal(request.options.redirect, 'error'); assert.equal(Object.hasOwn(request.options, 'headers'), false);
  assert.deepEqual(Buffer.from(output.image.data, 'base64'), bytes); assert.equal(output.image.mimeType, 'image/png');
  assert.equal(JSON.stringify(output).includes('signature'), false);
  await assert.rejects(prepareImage({ src: 'https://evil.test/a' }, 1024, { decode, fetcher: () => { throw new Error('must not fetch'); } }));
  await assert.rejects(prepareImage({ src: 'https://img.feishucdn.com/a' }, 1024, { decode, fetcher: async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) }));
  await assert.rejects(prepareImage({ data: bytes.toString('base64') }, 3, { decode }));
  await assert.rejects(prepareImage({ data: bytes.toString('base64') }, 1024, { decode: async () => ({ width: 10000, height: 10000, close() {} }) }));
  assert.throws(() => imageMime(Buffer.from('<svg>not a supported image</svg>')));
});

test('GIF imports a decoded first-frame PNG and excessive streaming input is cancelled', async () => {
  let drawn = false;
  const gif = Buffer.from('GIF89a' + 'local-fixture');
  const result = await prepareImage({ data: gif.toString('base64') }, 1024, {
    decode, canvas: () => ({ getContext: () => ({ drawImage() { drawn = true; } }), convertToBlob: async () => new Blob([bytes], { type: 'image/png' }) }),
  });
  assert.equal(drawn, true); assert.equal(result.animated, true); assert.equal(result.image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(result.image.data, 'base64'), bytes);
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } });
  await assert.rejects(prepareImage({ src: 'https://img.feishucdn.com/too-large' }, 10, { decode: () => { assert.fail('oversize image must not decode'); }, fetcher: async () => new Response(body, { headers: { 'content-type': 'image/png' } }) }));
  assert.equal(cancelled, true);
});
