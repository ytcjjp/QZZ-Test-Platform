import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import sharp from 'sharp';
import { strToU8, zipSync } from 'fflate';
import { initializeWorkspaceDocuments, registerWorkspaceDocumentRoutes, splitKnowledgeText } from '../workspace-documents.js';

function docxWithImage(png, imageCount = 1) {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>活动奖励进入背包。</w:t></w:r></w:p></w:body></w:document>'),
    ...Object.fromEntries(Array.from({ length: imageCount }, (_, index) => [`word/media/image${index + 1}.png`, png])),
  });
}

async function fixture(run, routeOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-workspace-documents-'));
  const db = new Database(path.join(directory, 'platform.db'));
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT); INSERT INTO users VALUES('admin','admin'),('writer','writer'),('reader','reader'),('denied','denied');
    CREATE TABLE projects(id TEXT PRIMARY KEY,deleted_at TEXT); INSERT INTO projects VALUES('a',NULL),('b',NULL),('deleted','2026-01-01');
    CREATE TABLE cases(id TEXT PRIMARY KEY,requirement_id TEXT,project_id TEXT);`);
  const app = express(); app.use(express.json({ limit: '4mb' }));
  const users = {
    admin: { id: 'admin', role: 'admin', permissions: {} },
    writer: { id: 'writer', role: 'member', permissions: { requirements: { view: true, write: true }, knowledge: { view: true, write: true } } },
    reader: { id: 'reader', role: 'member', permissions: { requirements: { view: true, write: false }, knowledge: { view: true, write: false } } },
    denied: { id: 'denied', role: 'member', permissions: { requirements: { view: false, write: false }, knowledge: { view: false, write: false } } },
  };
  app.use((req, res, next) => { req.user = users[req.headers['x-user'] || 'writer']; next(); });
  const events = [];
  const service = registerWorkspaceDocumentRoutes(app, { db, dataDir: directory, authenticate: (req) => users[req.headers['x-user'] || 'writer'], broadcast: (type, details) => events.push({ type, ...details }), ...routeOptions });
  app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(url, body, method = 'POST', user = 'writer') {
    const response = await fetch(base + url, { method, headers: { 'x-user': user, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const contentType = response.headers.get('content-type') || '';
    return { status: response.status, body: contentType.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), response };
  }
  try { await run({ db, directory, service, call, users, events }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('requirements and linked test plans persist revisions, project boundaries, analysis and read/write permissions', async () => fixture(async ({ db, directory, service, call, events }) => {
  assert.equal((await call('/api/requirements', { projectId: 'a', title: '空正文' })).status, 400);
  const created = await call('/api/requirements', { projectId: 'a', title: '活动需求', body: '# 奖励\n领取奖励进入背包。', priority: 'P1', sourceUrl: 'https://example.test/planner' });
  assert.equal(created.status, 201); let requirement = created.body.requirement;
  assert.equal(requirement.status, '草稿');
  assert.equal((await call('/api/requirements?projectId=a&q=奖励', undefined, 'GET', 'reader')).body.requirements.length, 1);
  assert.equal((await call('/api/requirements?projectId=a', undefined, 'GET', 'denied')).status, 403);
  assert.equal((await call('/api/requirements/' + requirement.id + '?projectId=b', undefined, 'GET')).status, 404);
  assert.equal((await call('/api/requirements', { projectId: 'deleted', title: '坏项目', body: 'text' })).status, 400);
  assert.equal((await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: 1, body: '不允许' }, 'PUT', 'reader')).status, 403);
  const edited = await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: requirement.revision, analysis: '# 功能清单\n奖励领取', status: '已确认' }, 'PUT');
  assert.equal(edited.status, 200); requirement = edited.body.requirement;
  assert.match(requirement.analysis, /功能清单/); assert.match(requirement.body, /进入背包/);
  assert.equal((await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: 1, body: '过期' }, 'PUT')).status, 409);
  assert.equal((await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: requirement.revision, priority: 'urgent' }, 'PUT')).status, 400);
  assert.equal((await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: requirement.revision, sourceUrl: 'javascript:alert(1)' }, 'PUT')).status, 400);
  const createdPlan = await call('/api/test-plans', { projectId: 'a', requirementId: requirement.id, title: '活动测试计划', version: '1.1', iteration: '迭代一', content: '# 范围\n活动奖励与背包。' });
  assert.equal(createdPlan.status, 201); let plan = createdPlan.body.plan;
  assert.equal((await call('/api/test-plans', { projectId: 'b', requirementId: requirement.id, title: '跨项目' })).status, 404);
  assert.equal((await call('/api/test-plans?projectId=a&requirementId=' + requirement.id, undefined, 'GET', 'reader')).body.plans.length, 1);
  const updated = await call('/api/test-plans/' + plan.id, { projectId: 'a', revision: plan.revision, content: '# 范围\n修改后范围。' }, 'PUT');
  assert.equal(updated.status, 200); plan = updated.body.plan;
  assert.equal((await call('/api/test-plans/' + plan.id, { projectId: 'a', revision: 1 }, 'DELETE')).status, 409);
  assert.equal(service.getRequirement('a', requirement.id).analysis, requirement.analysis);
  const reopened = new Database(path.join(directory, 'platform.db'));
  try { assert.equal(initializeWorkspaceDocuments(reopened, directory).getRequirement('a', requirement.id).title, requirement.title); }
  finally { reopened.close(); }
  db.prepare('INSERT INTO cases VALUES(?,?,?)').run('case-retained', requirement.id, 'a');
  assert.equal((await call('/api/requirements/' + requirement.id, { projectId: 'a', revision: requirement.revision }, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT requirement_id FROM cases WHERE id=?').get('case-retained').requirement_id, null);
  assert.equal((await call('/api/test-plans/' + plan.id + '?projectId=a', undefined, 'GET')).body.plan.title, plan.title);
  assert.equal(service.getRequirement('a', requirement.id), null);
  assert.ok(events.some((event) => event.type === 'requirement.deleted' && event.projectId === 'a'));
}));

test('requirements retain image originals and DOCX embedded images as real vision evidence with safe downloads', async () => fixture(async ({ service, call, directory }) => {
  const png = await sharp({ create: { width: 18, height: 10, channels: 3, background: '#dd3311' } }).png().toBuffer();
  const form = new FormData(); form.append('projectId', 'a'); form.append('title', '图片需求'); form.append('file', new Blob([png], { type: 'image/png' }), '界面.png');
  const created = await call('/api/requirements', form);
  assert.equal(created.status, 201); let requirement = created.body.requirement;
  assert.equal(requirement.body, ''); assert.equal(requirement.attachments[0].name, '界面.png');
  assert.ok(requirement.attachments[0].previewUrl);
  const evidence = service.getRequirementEvidence('a', requirement.id);
  assert.equal(evidence.images.length, 1); assert.equal(evidence.images[0].mimeType, 'image/png');
  assert.equal((await sharp(evidence.images[0].path).metadata()).width, 18);
  assert.ok(!JSON.stringify(requirement).includes(directory));
  assert.equal((await call(requirement.attachments[0].downloadUrl, undefined, 'GET', 'reader')).body.length, png.length);
  assert.equal((await call(requirement.attachments[0].previewUrl, undefined, 'GET', 'denied')).status, 403);
  assert.equal((await call(requirement.attachments[0].downloadUrl.replace('projectId=a', 'projectId=b'), undefined, 'GET')).status, 404);
  assert.equal((await call('/api/requirements/' + requirement.id + '/attachments/' + requirement.attachments[0].id, { projectId: 'a', revision: requirement.revision }, 'DELETE')).status, 400);
  const docxForm = new FormData(); docxForm.append('projectId', 'a'); docxForm.append('revision', String(requirement.revision)); docxForm.append('file', new Blob([docxWithImage(png)]), '带图策划.docx');
  const withDocx = await call('/api/requirements/' + requirement.id + '/attachments', docxForm);
  assert.equal(withDocx.status, 200); requirement = withDocx.body.requirement;
  const word = requirement.attachments.find((attachment) => attachment.name.endsWith('.docx'));
  assert.match(word.extractedText, /活动奖励进入背包/);
  assert.equal(word.imageCount, 1); assert.equal(word.images.length, 1); assert.ok(word.images[0].previewUrl);
  assert.equal(service.getRequirementEvidence('a', requirement.id).images.length, 2);
  assert.ok(service.getRequirementEvidence('a', requirement.id).warnings.some((message) => /嵌入媒体/.test(message)));
  const before = await fs.readdir(service.fileDir);
  const bad = new FormData(); bad.append('projectId', 'a'); bad.append('revision', '1'); bad.append('file', new Blob(['invalid']), 'bad.exe');
  assert.equal((await call('/api/requirements/' + requirement.id + '/attachments', bad)).status, 409);
  assert.deepEqual(await fs.readdir(service.fileDir), before);
}));

test('workspace attachment uploads have no 20 MB cap and preserve unreadable originals with explicit extraction errors', async () => fixture(async ({ call }) => {
  const content = Buffer.alloc(21 * 1024 * 1024, 97);
  const form = new FormData(); form.append('projectId', 'a'); form.append('title', '大型来源原件'); form.append('file', new Blob([content]), 'large.txt');
  const response = await call('/api/requirements', form);
  assert.equal(response.status, 201);
  const attachment = response.body.requirement.attachments[0];
  assert.equal(attachment.size, content.length); assert.match(attachment.extractionError, /10 万字/);
  const downloaded = await call(attachment.downloadUrl, undefined, 'GET');
  assert.equal(downloaded.body.length, content.length);
}));

test('DOCX vision evidence keeps all 22 or 60 images and refuses excess rather than silently analyzing a prefix', async () => fixture(async ({ service, call }) => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#445566' } }).png().toBuffer();
  for (const imageCount of [22, 60, 66]) {
    const bytes = docxWithImage(png, imageCount);
    const form = new FormData(); form.append('projectId', 'a'); form.append('title', `含${imageCount}图`); form.append('file', new Blob([bytes]), '图文.docx');
    const response = await call('/api/requirements', form);
    assert.equal(response.status, 201);
    const requirement = response.body.requirement;
    assert.equal(requirement.attachments[0].imageCount, imageCount);
    assert.equal(requirement.attachments[0].images.length, Math.min(65, imageCount));
    if (imageCount <= 64) assert.equal(service.getRequirementEvidence('a', requirement.id).images.length, imageCount);
    else assert.throws(() => service.getRequirementEvidence('a', requirement.id), (error) => error.status === 413 && /不会截取/.test(error.message));
    assert.equal((await call(requirement.attachments[0].downloadUrl, undefined, 'GET')).body.length, bytes.length);
  }
  const kb = (await call('/api/knowledge-bases', { projectId: 'a', name: '图文知识' })).body.knowledgeBase;
  const form = new FormData(); form.append('projectId', 'a'); form.append('file', new Blob([docxWithImage(png, 13)]), '13图知识.docx');
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents', form)).status, 201);
  assert.equal(service.getKnowledgeContext('a', [kb.id], '奖励').images.length, 13);
}));

test('knowledge file documents preserve originals, expose real image evidence and serve PDFs inline under permissions', async () => fixture(async ({ service, call }) => {
  const kb = (await call('/api/knowledge-bases', { projectId: 'a', name: '来源文档' })).body.knowledgeBase;
  const form = new FormData(); form.append('projectId', 'a'); form.append('category', '接口'); form.append('file', new Blob(['# 奖励\n原始技术说明：活动结束后奖励写入背包。']), '中文技术文档.md');
  const uploaded = await call('/api/knowledge-bases/' + kb.id + '/documents', form);
  assert.equal(uploaded.status, 201); const document = uploaded.body.document;
  assert.equal(document.title, '中文技术文档.md'); assert.ok(document.chunkCount > 0);
  assert.match((await call(document.attachments[0].downloadUrl, undefined, 'GET', 'reader')).body.toString('utf8'), /原始技术说明/);
  const search = service.getKnowledgeContext('a', [kb.id], '奖励'); assert.equal(search.chunks[0].documentId, document.id);
  const corrected = await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id, { projectId: 'a', revision: document.revision, body: '修订后唯一规则：排行榜按照服务器时间结算。' }, 'PUT');
  assert.equal(corrected.status, 200);
  assert.deepEqual(service.getKnowledgeContext('a', [kb.id], '奖励').chunks, []);
  assert.match(service.getKnowledgeContext('a', [kb.id], '服务器时间').chunks[0].content, /修订后唯一规则/);
  const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#3388ff' } }).png().toBuffer();
  const imageForm = new FormData(); imageForm.append('projectId', 'a'); imageForm.append('file', new Blob([png]), '界面.png');
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents', imageForm)).status, 201);
  assert.equal(service.getKnowledgeContext('a', [kb.id], '奖励').images.length, 1);
  assert.deepEqual(service.getKnowledgeContext('a', [], '奖励').warnings, []);
  const pdf = new FormData(); pdf.append('projectId', 'a'); pdf.append('title', 'PDF原件'); pdf.append('file', new Blob(['%PDF-1.4 invalid'], { type: 'application/pdf' }), 'demo.pdf');
  const requirement = (await call('/api/requirements', pdf)).body.requirement;
  assert.ok(requirement.attachments[0].previewUrl);
  const preview = await call(requirement.attachments[0].previewUrl, undefined, 'GET', 'reader');
  assert.equal(preview.response.headers.get('content-type'), 'application/pdf');
  assert.equal(preview.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(preview.response.headers.get('content-disposition'), null);
  const tiff = await sharp(png).tiff().toBuffer();
  const tiffForm = new FormData(); tiffForm.append('projectId', 'a'); tiffForm.append('title', 'TIFF图片'); tiffForm.append('file', new Blob([tiff]), 'source.tiff');
  const tiffRequirement = (await call('/api/requirements', tiffForm)).body.requirement;
  const tiffAttachment = tiffRequirement.attachments[0];
  assert.equal(tiffAttachment.mimeType, 'image/tiff');
  const tiffPreview = await call(tiffAttachment.previewUrl, undefined, 'GET');
  assert.equal(tiffPreview.response.headers.get('content-type'), 'image/png');
  assert.equal((await sharp(tiffPreview.body).metadata()).format, 'png');
  assert.deepEqual((await call(tiffAttachment.downloadUrl, undefined, 'GET')).body, tiff);
}));

test('knowledge bases index actual chunks, retrieve Chinese keywords, persist config, and guard all project/revision operations', async () => fixture(async ({ service, call }) => {
  const created = await call('/api/knowledge-bases', { projectId: 'a', name: '活动知识', description: '历史活动与背包规则', category: '游戏规则' });
  assert.equal(created.status, 201); let kb = created.body.knowledgeBase;
  assert.equal(kb.chunkSize, 400); assert.equal(kb.chunkOverlap, 80);
  const createDoc = await call('/api/knowledge-bases/' + kb.id + '/documents', { projectId: 'a', title: '背包接口', body: '# 奖励入账\n领取活动奖励后写入背包，背包道具数量正确增加。\n# 异常\n重试领取不会重复发奖。', category: '接口' });
  assert.equal(createDoc.status, 201); let document = createDoc.body.document;
  assert.ok(document.chunkCount > 0); assert.equal(document.indexOutdated, false);
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents?projectId=a&category=接口', undefined, 'GET', 'reader')).body.documents.length, 1);
  const query = await call('/api/knowledge-bases/' + kb.id + '/search', { projectId: 'a', query: '奖励进入背包' }, 'POST', 'reader');
  assert.equal(query.status, 200); assert.ok(query.body.chunks.length > 0); assert.match(query.body.chunks[0].content, /写入背包/);
  assert.equal(query.body.retrieval, 'local-keyword'); assert.ok(!('images' in query.body));
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/search', { projectId: 'b', query: '背包' })).status, 404);
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id + '/chunks?projectId=b', undefined, 'GET')).status, 404);
  const configured = await call('/api/knowledge-bases/' + kb.id, { projectId: 'a', revision: kb.revision, preset: 'heading', chunkSize: 100, chunkOverlap: 20 }, 'PUT');
  assert.equal(configured.status, 200); kb = configured.body.knowledgeBase; assert.equal(kb.indexPending, 1);
  assert.equal((await call('/api/knowledge-bases/' + kb.id, { projectId: 'a', revision: 1, name: 'stale' }, 'PUT')).status, 409);
  const reindexed = await call('/api/knowledge-bases/' + kb.id + '/reindex', { projectId: 'a', revision: kb.revision });
  assert.equal(reindexed.status, 200); kb = reindexed.body.knowledgeBase; assert.equal(kb.indexPending, 0); assert.equal(reindexed.body.indexedChunks, 2);
  const chunks = (await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id + '/chunks?projectId=a', undefined, 'GET')).body.chunks;
  assert.equal(chunks[0].heading, '奖励入账'); assert.equal(chunks[1].heading, '异常');
  const helper = service.getKnowledgeContext('a', [kb.id], '重复发奖');
  assert.ok(helper.chunks.length > 0); assert.ok(helper.chunks[0].documentId === document.id);
  assert.equal(service.retrieveKnowledge('a', [kb.id], '背包')[0].title, '背包接口');
  assert.throws(() => service.getKnowledgeContext('b', [kb.id], '背包'), /不存在/);
  const edited = await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id, { projectId: 'a', revision: document.revision, body: '专属检索内容：挂机状态恢复后应继续活动。' }, 'PUT');
  assert.equal(edited.status, 200); document = edited.body.document;
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id, { projectId: 'a', revision: 1 }, 'DELETE')).status, 409);
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id + '/reindex', { projectId: 'a', revision: document.revision })).status, 200);
  assert.equal((await call('/api/knowledge-bases/' + kb.id + '/documents/' + document.id, { projectId: 'a', revision: document.revision }, 'DELETE')).status, 200);
  assert.deepEqual(service.getKnowledgeContext('a', [kb.id], '挂机状态').chunks, []);
  assert.equal((await call('/api/knowledge-bases/' + kb.id, { projectId: 'a', revision: kb.revision }, 'DELETE', 'reader')).status, 403);
  assert.equal((await call('/api/knowledge-bases/' + kb.id, { projectId: 'a', revision: kb.revision }, 'DELETE')).status, 200);
}));

test('chunk windows overlap predictably and heading mode respects sections without fake vector indexing', () => {
  const source = '0123456789'.repeat(35);
  const chunks = splitKnowledgeText(source, { chunkMode: 'window', chunkSize: 100, chunkOverlap: 20 });
  assert.equal(chunks.length, 5); assert.equal(chunks[0].content.slice(-20), chunks[1].content.slice(0, 20));
  const headings = splitKnowledgeText('# A\nalpha\n# B\nbeta', { chunkMode: 'heading', chunkSize: 400, chunkOverlap: 80 });
  assert.equal(headings.length, 2); assert.equal(headings[1].heading, 'B');
  assert.throws(() => splitKnowledgeText('x', { chunkSize: 100, chunkOverlap: 100 }), /重叠/);
  assert.throws(() => splitKnowledgeText('x'.repeat(20000), { chunkSize: 100, chunkOverlap: 99 }), /10000/);
});

test('Feishu imports use mocked official APIs, retain source text, and recheck permission/project after asynchronous reads', async () => {
  let mode = 'ok'; let afterRead = () => {};
  const calls = [];
  const config = { appId: 'cli_mock', appSecret: 'mock-secret', request: async (url, options) => {
    calls.push(url);
    assert.ok(url.startsWith('https://open.feishu.cn/open-apis/'));
    if (mode === 'network') throw new TypeError('private upstream network diagnostic');
    if (mode === 'timeout') throw new DOMException('private timeout diagnostic', 'TimeoutError');
    if (url.includes('/auth/')) return Response.json({ code: 0, tenant_access_token: 'mock-token' });
    assert.equal(options.headers.authorization, 'Bearer mock-token');
    if (mode === 'denied') return Response.json({ code: 99991663 }, { status: 403 });
    if (url.includes('get_node')) return Response.json({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'ResolvedDocument' } } });
    afterRead();
    return Response.json({ code: 0, data: { content: '# 飞书需求\n领取奖励后更新背包。' } });
  } };
  await fixture(async ({ call, db, users, service }) => {
    const sourceUrl = 'https://team.feishu.cn/wiki/MockNode';
    const created = await call('/api/requirements', { projectId: 'a', title: '飞书来源', sourceUrl });
    assert.equal(created.status, 201);
    assert.equal(created.body.requirement.sourceUrl, sourceUrl);
    assert.match(created.body.requirement.body, /更新背包/);
    assert.ok(service.getRequirementEvidence('a', created.body.requirement.id).warnings.some((warning) => /文字接口/.test(warning)));
    assert.ok(calls.some((url) => url.includes('wiki/v2/spaces/get_node')));
    const kb = (await call('/api/knowledge-bases', { projectId: 'a', name: '飞书知识' })).body.knowledgeBase;
    assert.equal((await call(`/api/knowledge-bases/${kb.id}/documents`, { projectId: 'a', title: '飞书技术资料', sourceUrl: 'https://team.feishu.cn/docx/Source' })).status, 201);
    assert.ok(service.getKnowledgeContext('a', [kb.id], '背包').chunks.length > 0);
    const count = db.prepare('SELECT count(*) n FROM requirements').get().n;
    mode = 'denied';
    assert.equal((await call('/api/requirements', { projectId: 'a', title: '不可读取', sourceUrl })).status, 422);
    mode = 'network';
    const network = await call('/api/requirements', { projectId: 'a', title: '网络断开', sourceUrl });
    assert.equal(network.status, 502); assert.ok(!network.body.message.includes('private'));
    mode = 'timeout';
    assert.equal((await call('/api/requirements', { projectId: 'a', title: '读取超时', sourceUrl })).status, 504);
    mode = 'ok';
    afterRead = () => { users.writer.permissions.requirements.write = false; };
    assert.equal((await call('/api/requirements', { projectId: 'a', title: '权限已撤销', sourceUrl })).status, 403);
    users.writer.permissions.requirements.write = true;
    afterRead = () => { db.prepare('UPDATE projects SET deleted_at=? WHERE id=?').run('2026-11-17', 'a'); };
    assert.equal((await call('/api/requirements', { projectId: 'a', title: '项目已删除', sourceUrl })).status, 400);
    assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, count);
  }, { readFeishuConfig: () => config });
});
