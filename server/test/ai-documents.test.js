import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { strToU8, zipSync } from 'fflate';
import { documentName, extractDocument, generateDocumentCases, normalizeAiResult, parseFeishuUrl, readFeishuDocument, registerAiRoutes } from '../ai-documents.js';

function fakeDocx(text) {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
  }));
}

function fakePdf(text = 'Reward rules confirmed.') {
  const stream = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function generated(questions = []) {
  return { title: '奖励测试用例', questions, branches: [
    { title: '主流程', cases: [{ title: '领取奖励', preconditions: '活动奖励可领取。', steps: '点击领取奖励。', expected: '奖励正确入账。' }] },
    { title: 'UI', cases: [] }, { title: '异常与边界', cases: [] },
    { title: '受影响模块', modules: [{ name: '背包', cases: [{ title: '奖励进入背包', preconditions: '完成奖励领取。', steps: '打开背包。', expected: '显示领取的道具。' }] }] },
  ] };
}

test('planner extraction preserves Markdown, reads actual docx/PDF, and rejects malformed, empty and oversized documents', async () => {
  const markdown = '# 活动\n\n领取奖励后道具进入背包。';
  assert.equal(await extractDocument({ originalname: '策划.md', buffer: Buffer.from(markdown) }), markdown);
  assert.equal(await extractDocument({ originalname: '策划.docx', buffer: fakeDocx('活动奖励正确入账。') }), '活动奖励正确入账。');
  assert.match(await extractDocument({ originalname: 'planner.pdf', buffer: fakePdf() }), /Reward rules confirmed/);
  await assert.rejects(extractDocument({ originalname: 'empty.txt', buffer: Buffer.from(' ') }), /未提取到可读文字/);
  await assert.rejects(extractDocument({ originalname: 'binary.txt', buffer: Buffer.from([0xff, 0xfe]) }), /UTF-8/);
  await assert.rejects(extractDocument({ originalname: 'bad.docx', buffer: Buffer.from('not a zip') }), /读取失败/);
  await assert.rejects(extractDocument({ originalname: 'fake.pdf', buffer: Buffer.from('not a pdf') }), /不是有效的 PDF/);
  await assert.rejects(extractDocument({ originalname: 'fake.doc', buffer: Buffer.from('not a doc') }), /不是有效的 Word/);
  await assert.rejects(extractDocument({ originalname: 'large.md', buffer: Buffer.from('x'.repeat(100001)) }), /超过 10 万字/);
});

test('document names repair multipart UTF-8 decoded as Latin-1 while preserving native Unicode and Western names', () => {
  const chinese = '活动策划-smoke.md';
  assert.equal(documentName(Buffer.from(chinese, 'utf8').toString('latin1')), chinese);
  assert.equal(documentName(chinese), chinese);
  assert.equal(documentName('café.md'), 'café.md');
  assert.equal(documentName('résumé.md'), 'résumé.md');
  assert.equal(documentName('planner-ASCII.md'), 'planner-ASCII.md');
});

test('Feishu links use only fixed official API hosts and resolve knowledge-base nodes with authenticated raw content', async () => {
  for (const url of ['http://tenant.feishu.cn/docx/token', 'https://tenant.feishu.cn.evil.test/docx/token', 'https://127.0.0.1/docx/token', 'https://tenant.feishu.cn:123/docx/token', 'https://u:p@tenant.feishu.cn/docx/token']) {
    assert.throws(() => parseFeishuUrl(url));
  }
  assert.equal(parseFeishuUrl('https://tenant.larksuite.com/docx/Token?from=share').host, 'https://open.larksuite.com');
  await assert.rejects(readFeishuDocument('https://tenant.feishu.cn/docx/token'), /管理员先配置/);
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/internal')) return Response.json({ code: 0, tenant_access_token: 'test-token' });
    assert.equal(options.headers.authorization, 'Bearer test-token');
    if (url.includes('get_node')) return Response.json({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'ActualDocument' } } });
    return Response.json({ code: 0, data: { content: '活动奖励规则。' } });
  };
  const result = await readFeishuDocument('https://tenant.feishu.cn/wiki/WikiToken', { appId: 'cli_test', appSecret: 'test-secret', request });
  assert.equal(result.text, '活动奖励规则。');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url.startsWith('https://open.feishu.cn/open-apis/')));
  assert.match(calls[2].url, /docx\/v1\/documents\/ActualDocument\/raw_content$/);
  await assert.rejects(readFeishuDocument('https://tenant.feishu.cn/docx/token', { appId: 'cli_test', appSecret: 'test', request: async () => Response.json({ code: 99991663 }, { status: 403 }) }), /共享给应用/);
});

test('AI generation loads the actual skill, keeps open questions outside the tree, validates three-field cases and sends only source documents', async () => {
  let sent;
  const request = async (url, options) => {
    sent = JSON.parse(options.body);
    assert.equal(String(url), 'http://127.0.0.1:9876/v1/chat/completions');
    return Response.json({ choices: [{ message: { content: JSON.stringify(generated(['奖励过期后如何处理？'])) } }] });
  };
  const options = { env: { AI_BASE_URL: 'http://127.0.0.1:9876/v1/', AI_MODEL: 'test', AI_API_KEY: 'secret' }, request };
  const sources = [{ name: '活动.md', text: '点击领取奖励后道具进入背包。' }];
  const waiting = await generateDocumentCases(sources, options);
  assert.equal(waiting.tree, null);
  assert.deepEqual(waiting.questions, ['奖励过期后如何处理？']);
  assert.match(sent.messages[0].content, /Never invent unlock conditions/);
  assert.match(sent.messages[0].content, /主流程/);
  assert.equal(JSON.parse(sent.messages[1].content).documents[0].text, sources[0].text);
  const result = await generateDocumentCases(sources, { ...options, confirmed: true, clarifications: '只覆盖领取成功。' });
  assert.deepEqual(result.tree.children.map((node) => node.title), ['主流程', 'UI', '异常与边界', '受影响模块']);
  assert.equal(result.tree.children[0].children[0].children.length, 3);
  assert.match(result.tree.children[0].children[0].children[0].title, /^前置条件：/);
  assert.equal(result.tree.children[3].children[0].title, '背包');
  const invalid = generated(); delete invalid.branches[0].cases[0].expected;
  assert.throws(() => normalizeAiResult(invalid), /预期结果/);
  const oversized = generated();
  oversized.branches[0].cases = Array.from({ length: 100 }, (_, index) => ({ title: `TC-${index}`, preconditions: '条'.repeat(1800), steps: '步'.repeat(1800), expected: '果'.repeat(1800) }));
  assert.ok(JSON.stringify(oversized).length < 1000000);
  assert.throws(() => normalizeAiResult(oversized), /超出用例集容量/);
  await assert.rejects(generateDocumentCases(sources, { env: {} }), /尚未配置/);
});

test('document routes isolate users, deny raw requirements, and keep admin Feishu secrets encrypted and out of responses', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-ai-documents-'));
  const db = new Database(':memory:');
  const app = express(); app.use(express.json());
  const users = {
    admin: { id: 'admin', role: 'admin' },
    one: { id: 'one', role: 'member', permissions: { ai: { view: true, write: true } } },
    two: { id: 'two', role: 'member', permissions: { ai: { view: true, write: true } } },
  };
  app.use((req, res, next) => { req.user = users[req.headers['x-user'] || 'one']; next(); });
  registerAiRoutes(app, {
    db, dataDir: directory, authenticate: (req) => users[req.headers['x-user'] || 'one'],
    inputError: (message) => new Error(message), sendError: (res, status, error, message) => res.status(status).json({ error, message }),
  });
  app.use((error, req, res, next) => res.status(400).json({ message: error.message }));
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalKey = process.env.AI_API_KEY; const originalModel = process.env.AI_MODEL;
  try {
    assert.equal((await fetch(base + '/api/ai/feishu-config')).status, 403);
    const configResponse = await fetch(base + '/api/ai/feishu-config', { method: 'PUT', headers: { 'x-user': 'admin', 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'cli_example', appSecret: 'sensitive-app-secret' }) });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.deepEqual(config, { appId: 'cli_example', configured: true });
    const persisted = await fs.readFile(path.join(directory, 'feishu-config.json'), 'utf8');
    assert.equal(persisted.includes('sensitive-app-secret'), false);
    const getConfig = await fetch(base + '/api/ai/feishu-config', { headers: { 'x-user': 'admin' } });
    assert.deepEqual(await getConfig.json(), config);
    const form = new FormData(); form.append('file', new Blob(['# 活动\n奖励领取后进入背包。']), '活动策划-smoke.md');
    const imported = await fetch(base + '/api/ai/documents', { method: 'POST', body: form });
    assert.equal(imported.status, 201);
    const { document } = await imported.json();
    assert.equal(document.name, '活动策划-smoke.md');
    assert.match(document.text, /进入背包/);
    db.prepare('UPDATE ai_documents SET name = ? WHERE id = ?').run(Buffer.from('活动策划-smoke.md', 'utf8').toString('latin1'), document.id);
    const restoredDocuments = (await (await fetch(base + '/api/ai/documents')).json()).documents;
    assert.equal(restoredDocuments[0].id, document.id);
    assert.equal(restoredDocuments[0].name, '活动策划-smoke.md');
    assert.deepEqual((await (await fetch(base + '/api/ai/documents', { headers: { 'x-user': 'two' } })).json()).documents, []);
    const largeText = '# 大文件策划\n奖励领取后进入背包。';
    const largeBuffer = Buffer.concat([Buffer.alloc(21 * 1024 * 1024, 0x20), Buffer.from(largeText)]);
    assert.ok(largeBuffer.length > 20 * 1024 * 1024);
    assert.equal(await extractDocument({ originalname: '超过旧上限.md', buffer: largeBuffer }), largeText);
    const largeForm = new FormData(); largeForm.append('file', new Blob([largeBuffer]), '超过旧上限.md');
    const largeImported = await fetch(base + '/api/ai/documents', { method: 'POST', body: largeForm });
    assert.equal(largeImported.status, 201, 'multipart document uploads above the old 20 MiB cap must be accepted');
    const largeDocument = (await largeImported.json()).document;
    assert.equal(largeDocument.name, '超过旧上限.md');
    assert.equal(largeDocument.text, largeText);
    assert.equal(largeDocument.chars, largeText.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_documents').get().count, 2);
    const cleanupLarge = await fetch(base + '/api/ai/documents/' + largeDocument.id, { method: 'DELETE' });
    assert.equal(cleanupLarge.status, 200);
    assert.deepEqual(await cleanupLarge.json(), { ok: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_documents WHERE id = ?').get(largeDocument.id).count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_documents').get().count, 1);
    process.env.AI_API_KEY = 'test'; process.env.AI_MODEL = 'test';
    const other = await fetch(base + '/api/ai/generate', { method: 'POST', headers: { 'x-user': 'two', 'content-type': 'application/json' }, body: JSON.stringify({ documentIds: [document.id] }) });
    assert.equal(other.status, 404);
    const oldInput = await fetch(base + '/api/ai/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documentIds: [document.id], requirements: 'manual input' }) });
    assert.equal(oldInput.status, 400);
    await fetch(base + '/api/ai/documents/' + document.id, { method: 'DELETE', headers: { 'x-user': 'two' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_documents').get().count, 1);
    await fetch(base + '/api/ai/documents/' + document.id, { method: 'DELETE' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ai_documents').get().count, 0);
  } finally {
    if (originalKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = originalModel;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
