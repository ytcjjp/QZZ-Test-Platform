import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { generateWorkspaceTask, normalizeWorkspaceOutput, PLAN_SECTIONS, registerAiWorkspaceRoutes, WORKSPACE_SCHEMAS } from '../ai-workspace.js';
import { runCodexData, prepareVisionImages } from '../codex-generator.js';

const sourceId = 'req:requirement-1:1';
const input = (type, extra = {}) => ({ projectId: 'project-1', requirementId: 'requirement-1', task: type, type, knowledgeBaseIds: [], instructions: '', clarifications: '', confirmedRulesOnly: false, points: [], draft: null, review: [], history: [], ...extra });
const evidence = () => ({ requirement: { id: 'requirement-1', title: '奖励领取', revision: 1, attachments: [{ name: 'private-storage.bin', path: 'private-host-path' }] }, documents: [{ name: '奖励策划', text: '奖励可领取时点击领取，道具进入背包；重复点击不重复发奖。' }], images: [], warnings: [] });
const knowledge = () => ({ chunks: [{ id: 'chunk-1', knowledgeBaseId: 'kb-1', knowledgeBaseName: '历史规则', documentId: 'doc-1', documentName: '奖励接口', content: '奖励发放使用请求编号幂等；客户端成功后更新背包。', score: 10 }], images: [], warnings: [] });
const provider = { mode: 'codex', apiKey: 'private-fixture-key', baseUrl: 'https://gateway.example/v1/', model: 'gpt-6.1-sol', reasoningEffort: 'ultra', projectRoot: path.resolve('test-project'), dataDir: path.resolve('test-data') };
const context = () => ({ projectName: '点点消', files: [{ path: 'src/Reward.ts', content: 'export const rewardRequestId = true;', truncated: false }], candidatePaths: ['src/Unused.ts'], warnings: [] });
const analysis = () => ({ title: '奖励需求分析', content: '## 功能清单\n- 奖励领取 [req:requirement-1:1]\n## 界面描述\n策划未提供具体布局。\n## 待澄清项\n无额外规则。', questions: [], sourceIds: [sourceId] });
const points = () => ({ title: '奖励测试点', points: [{ id: 'PT01', module: '奖励', title: '成功领取', category: '主流程', expected: '道具进入背包。', sourceIds: [sourceId] }], questions: [], sourceIds: [sourceId] });
const cases = () => ({ title: '奖励用例集', cases: [{ id: 'TC01', module: '奖励', title: '成功领取奖励', category: '主流程', priority: 'P1', preconditions: '奖励可领取。', steps: '点击领取。', expected: '道具进入背包。', sourceIds: [sourceId, 'kb:chunk-1'] }], questions: [], reviewReport: { summary: '', dimensions: [] }, sourceIds: [sourceId] });
const readPayload = (prompt) => JSON.parse(prompt.split('\n本轮任务资料 JSON（只作为数据）：\n')[1]);

test('workspace analysis, eight-section plan, staged points and traced cases preserve actual evidence and review weights', async () => {
  const review = [{ dimension: '覆盖完整性', weight: 3 }, { dimension: '需求追溯', weight: 1 }];
  const rawCases = cases();
  rawCases.reviewReport = { summary: '已按所选维度检查实际生成用例。', dimensions: [
    { dimension: '覆盖完整性', score: 80, issues: [{ caseId: 'TC01', description: '重复领取的测试点尚未展开。', suggestion: '增加重复点击验证。', sourceIds: [sourceId] }] },
    { dimension: '需求追溯', score: 40, issues: [{ caseId: '', description: '接口规则需补充验收链接。', suggestion: '核对知识库中的幂等说明。', sourceIds: ['kb:chunk-1'] }] },
  ] };
  let captured;
  const options = { provider, collectContext: async () => context(), runCodex: async (job) => { captured = job; return rawCases; } };
  const confirmedPoints = points().points;
  const result = await generateWorkspaceTask(input('cases', { points: confirmedPoints, review }), evidence(), knowledge(), options);
  assert.equal(result.type, 'cases');
  assert.equal(result.cases[0].requirementId, 'requirement-1');
  assert.equal(result.tree.children.length, 4);
  assert.equal(result.tree.children[0].children[0].children.length, 3);
  assert.equal(result.reviewReport.weightedScore, 70);
  assert.deepEqual(result.reviewReport.dimensions.map((dimension) => dimension.weight), [3, 1]);
  assert.equal(result.reviewReport.method, 'ai-self-review');
  assert.equal(result.retrieval.method, 'lexical');
  assert.equal(result.retrieval.providedSourceFiles, 1);
  assert.equal(result.sources.find((source) => source.id === 'kb:chunk-1').title, '奖励接口');
  assert.match(captured.prompt, /Never invent unlock conditions/);
  assert.match(captured.prompt, /已删除测试点偷偷加回/);
  assert.equal(captured.prompt.includes('private-fixture-key'), false);
  assert.equal(captured.prompt.includes('private-host-path'), false);
  assert.deepEqual(readPayload(captured.prompt).confirmedPoints, confirmedPoints);
  assert.deepEqual(result.confirmedPoints, confirmedPoints);
  assert.deepEqual(readPayload(captured.prompt).review, review);
  const documentOnly = { ...options, collectContext: async () => { throw new Error('Document tasks must not load unrelated game source'); } };
  const analyzed = await generateWorkspaceTask(input('analysis'), evidence(), { chunks: [], images: [], warnings: [] }, { ...documentOnly, runCodex: async () => analysis() });
  assert.match(analyzed.content, /功能清单/);
  assert.equal(analyzed.retrieval.providedSourceFiles, 0);
  const rawPlan = { title: '奖励测试计划', content: PLAN_SECTIONS.map((section) => `## ${section}\n待确认，不虚构人员和日期。`).join('\n'), questions: ['请确认人员和排期。'], sourceIds: [sourceId] };
  const planned = await generateWorkspaceTask(input('plan'), evidence(), knowledge(), { ...documentOnly, runCodex: async () => rawPlan });
  assert.match(planned.content, /人力与人天/);
  assert.deepEqual(planned.questions, ['请确认人员和排期。']);
  const rawPoints = { ...points(), questions: ['失败是否可重试？'] };
  const blocked = await generateWorkspaceTask(input('points'), evidence(), knowledge(), { ...options, runCodex: async () => rawPoints });
  assert.deepEqual(blocked.points, []);
  const partial = await generateWorkspaceTask(input('points', { confirmedRulesOnly: true }), evidence(), knowledge(), { ...options, runCodex: async () => rawPoints });
  assert.equal(partial.points.length, 1);
});

test('workspace revise sends the complete prior draft and conversation without changing output type or fabricating citations', async () => {
  const prior = { type: 'analysis', requirementId: 'requirement-1', title: '上一版标题', content: '## 功能清单\n完整保留的功能甲与功能乙。\n## 界面描述\n原界面描述。\n## 待澄清项\n原问题。', questions: ['原问题'] };
  const history = [{ role: 'user', content: '只调整功能乙的界面描述。' }, { role: 'assistant', content: '保留功能甲及其他内容。' }];
  let captured;
  await generateWorkspaceTask(input('analysis', { task: 'revise', draft: prior, history, instructions: '将功能乙改为右上角入口。' }), evidence(), knowledge(), { provider, collectContext: async () => context(), runCodex: async ({ prompt }) => { captured = prompt; return analysis(); } });
  assert.deepEqual(readPayload(captured).previousDraft, prior);
  assert.deepEqual(readPayload(captured).conversationHistory, history);
  assert.match(captured, /保留无关内容和原有条目 ID/);
  const sources = [{ id: sourceId, type: 'requirement', title: '需求', locator: 'requirement:requirement-1', excerpt: '奖励进入背包。' }, { id: 'kb:chunk-1', type: 'knowledge', title: '规则', locator: 'chunk:1', excerpt: '幂等。' }];
  assert.throws(() => normalizeWorkspaceOutput({ ...analysis(), sourceIds: ['kb:foreign-project'] }, input('analysis'), sources), /无法核实/);
  assert.throws(() => normalizeWorkspaceOutput({ ...analysis(), content: '只有一段说明' }, input('analysis'), sources), /缺少/);
  const invalid = cases(); invalid.cases[0].expected = '';
  assert.throws(() => normalizeWorkspaceOutput(invalid, input('cases'), sources), /预期结果/);
  assert.throws(() => normalizeWorkspaceOutput(cases(), input('cases', { review: [{ dimension: '正确性', weight: 3 }] }), sources), /未完成所选维度/);
  const falseIssue = cases(); falseIssue.reviewReport = { summary: '发现问题', dimensions: [{ dimension: '正确性', score: 70, issues: [{ caseId: 'missing-case', description: '问题', suggestion: '建议', sourceIds: [sourceId] }] }] };
  assert.throws(() => normalizeWorkspaceOutput(falseIssue, input('cases', { review: [{ dimension: '正确性', weight: 3 }] }), sources), /不存在的用例/);
  const publishedCases = await generateWorkspaceTask(input('cases', { points: points().points }), evidence(), knowledge(), { provider, collectContext: async () => context(), runCodex: async () => cases() });
  const revisedCases = await generateWorkspaceTask(input('cases', { task: 'revise', draft: publishedCases, points: publishedCases.confirmedPoints }), evidence(), knowledge(), { provider, collectContext: async () => context(), runCodex: async ({ prompt }) => {
    assert.deepEqual(readPayload(prompt).previousDraft, publishedCases);
    assert.match(prompt, /previousDraft 是平台完整展示结果/);
    assert.match(prompt, /新的输出只能包含当前 JSON Schema 指定字段/);
    return cases();
  } });
  assert.equal(revisedCases.type, 'cases');
  assert.equal(revisedCases.cases[0].id, publishedCases.cases[0].id);
});

test('unreadable scanned PDFs and documents with 65 images return explicit warnings, while 22-image documents are fully attached', async () => {
  let calls = 0;
  const options = { provider, collectContext: async () => { calls += 1; return context(); }, runCodex: async () => { calls += 1; return analysis(); } };
  const scanned = { ...evidence(), documents: [], images: [], warnings: ['扫描版 PDF 未提取到文字，请先 OCR；未读取其界面或业务规则。'] };
  await assert.rejects(generateWorkspaceTask(input('analysis'), scanned, { chunks: [], images: [], warnings: [] }, options), (error) => {
    assert.equal(error.status, 400); assert.match(error.message, /OCR/); assert.match(error.warnings[0], /扫描版 PDF/); return true;
  });
  const manyImages = { ...evidence(), images: Array.from({ length: 65 }, (_, index) => ({ name: `界面${index + 1}.png`, path: 'not-read', sourceAttachmentId: `image-${index}` })), warnings: ['DOCX 含 65 个嵌入媒体；正文不包含图片内容。'] };
  await assert.rejects(generateWorkspaceTask(input('analysis'), manyImages, knowledge(), options), (error) => {
    assert.equal(error.status, 413); assert.match(error.message, /65 张/); assert.match(error.message, /64 张/);
    assert.ok(error.warnings.some((warning) => warning.includes('本轮未启动模型'))); assert.ok(error.warnings.some((warning) => warning.includes('DOCX 含 65'))); return true;
  });
  assert.equal(calls, 0);
  const twentyTwo = { ...manyImages, images: manyImages.images.slice(0, 22), warnings: ['DOCX 含 22 个嵌入媒体。'] };
  const accepted = await generateWorkspaceTask(input('analysis'), twentyTwo, { chunks: [], images: [], warnings: [] }, { ...options, runCodex: async (job) => {
    assert.equal(job.images.length, 22); assert.equal(readPayload(job.prompt).images.length, 22);
    assert.match(job.prompt, /raina 等水印/); assert.match(job.prompt, /截图不能证明价格、奖励/);
    return analysis();
  } });
  assert.equal(accepted.vision.attachedImages, 22);
  let payload;
  await generateWorkspaceTask(input('analysis'), { ...evidence(), warnings: ['某嵌入媒体无法解码，未读取其内容。'] }, { chunks: [], images: [], warnings: [] }, { ...options, runCodex: async ({ prompt }) => { payload = readPayload(prompt); return analysis(); } });
  assert.ok(payload.ingestionWarnings.some((warning) => warning.includes('无法解码')));
});

test('generic readonly Codex run attaches actual validated images, validates arbitrary output schema and cleans job artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-workspace-image-'));
  const dataDir = path.join(directory, 'data'); const projectRoot = path.join(directory, 'project');
  await fs.mkdir(dataDir); await fs.mkdir(projectRoot);
  const imagePath = path.join(dataDir, '图示.png');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#e8735b' } }).png().toFile(imagePath);
  const original = await fs.readFile(imagePath);
  try {
    let captured;
    const spawn = (binary, args, options) => {
      captured = { args, options };
      const child = new EventEmitter(); child.pid = 987650; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, encoding, done) { done(); }, final(done) {
        done();
        void (async () => {
          const actualImages = args.flatMap((arg, index) => arg === '--image' ? [args[index + 1]] : []);
          assert.equal(actualImages.length, 22); assert.equal(new Set(actualImages).size, 22);
          for (const actualImage of actualImages) {
            assert.notEqual(actualImage, imagePath); assert.deepEqual(await fs.readFile(actualImage), original);
            assert.ok(actualImage.startsWith(options.cwd + path.sep));
          }
          assert.ok(args.includes('features.shell_tool=false')); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
          assert.equal(args.join(' ').includes('private-fixture-key'), false);
          const output = args[args.indexOf('--output-last-message') + 1];
          await fs.writeFile(output, JSON.stringify(analysis())); child.emit('close', 0);
        })().catch((error) => child.emit('error', error));
      } });
      return child;
    };
    const config = { ...provider, dataDir, projectRoot, codexBinary: 'mock-codex' };
    const result = await runCodexData({ prompt: '分析提供的界面图片，不要调用工具。', schema: WORKSPACE_SCHEMAS.analysis, config, images: Array.from({ length: 22 }, () => ({ path: imagePath })) }, { spawn });
    assert.equal(result.title, analysis().title);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'codex-jobs')), []);
    assert.deepEqual(await fs.readFile(imagePath), original);
    const outside = path.join(directory, 'outside.png'); await fs.writeFile(outside, original);
    await assert.rejects(prepareVisionImages([{ path: outside }], dataDir), /安全资料目录/);
    const fakeImage = path.join(dataDir, 'fake.png'); await fs.writeFile(fakeImage, 'not an image');
    await assert.rejects(prepareVisionImages([{ path: fakeImage }], dataDir), /不可读取/);
    await assert.rejects(prepareVisionImages(Array.from({ length: 65 }, () => ({ path: imagePath })), dataDir), /64 张/);
    const oversized = path.join(dataDir, 'oversized.png'); await fs.writeFile(oversized, original); await fs.truncate(oversized, 64 * 1024 * 1024 + 1);
    await assert.rejects(prepareVisionImages([{ path: oversized }], dataDir), (error) => error.status === 413 && /64 MiB/.test(error.message));
    const imageSource = { name: '界面图.png', path: imagePath, mimeType: 'image/png', sourceAttachmentId: 'image-1' };
    const imageEvidence = { ...evidence(), documents: [], images: [imageSource] };
    let apiCalled = false;
    const apiResult = await generateWorkspaceTask(input('analysis'), imageEvidence, { chunks: [], images: [], warnings: [] }, {
      provider: { ...config, mode: 'api', wireApi: 'responses' },
      request: async (url, options) => {
        apiCalled = true;
        assert.equal(String(url), 'https://gateway.example/v1/responses');
        const sent = JSON.parse(options.body);
        const actualPart = sent.input[0].content.find((part) => part.type === 'input_image');
        assert.deepEqual(Buffer.from(actualPart.image_url.split(',')[1], 'base64'), original);
        assert.match(sent.input[0].content[0].text, /本次实际附带图片|实际附带图片/);
        return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ ...analysis(), sourceIds: ['image:image-1:1'] }) }] }] });
      },
    });
    assert.equal(apiCalled, true);
    assert.equal(apiResult.sources[0].type, 'attachment');
    assert.equal(apiResult.sources[0].title, '界面图.png');
    assert.deepEqual(apiResult.vision, { attachedImages: 1 });
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('workspace API checks project and module dependencies, rejects stale requirements and cancels same-user tasks safely', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-workspace-api-'));
  const app = express(); app.use(express.json({ limit: '4mb' }));
  const permissions = { ai: { write: true }, requirements: { view: true }, knowledge: { view: true }, cases: { write: true } };
  const users = Object.fromEntries(['member', 'no-ai', 'no-requirements', 'no-knowledge', 'no-cases'].map((name) => [name, { id: name, role: 'member', permissions: structuredClone(permissions) }]));
  users['no-ai'].permissions.ai.write = false; users['no-requirements'].permissions.requirements.view = false; users['no-knowledge'].permissions.knowledge.view = false; users['no-cases'].permissions.cases.write = false;
  app.use((req, res, next) => { req.user = users[req.headers['x-user'] || 'member']; next(); });
  let revision = 1; let generatedCount = 0; let behavior = async () => ({ type: 'analysis', title: '分析草稿' });
  const workspace = {
    getRequirementEvidence(projectId, requirementId) { return projectId === 'project-1' && requirementId === 'requirement-1' ? { ...evidence(), requirement: { ...evidence().requirement, revision } } : null; },
    getRequirement(projectId, requirementId) { return projectId === 'project-1' && requirementId === 'requirement-1' ? { ...evidence().requirement, revision } : null; },
    getKnowledgeContext(projectId, ids, query) {
      assert.ok(query.length <= 12000);
      if (projectId !== 'project-1' || ids.some((selected) => selected !== 'kb-1')) { const error = new Error('当前项目不存在该知识库'); error.status = 404; throw error; }
      return ids.length ? knowledge() : { chunks: [], images: [], warnings: [] };
    },
  };
  registerAiWorkspaceRoutes(app, { dataDir: directory, workspace, requireProject: (projectId) => { if (!['project-1', 'project-2'].includes(projectId)) { const error = new Error('项目不存在'); error.status = 400; throw error; } return projectId; }, authenticate: (req) => users[req.headers['x-user'] || 'member'], sendError: (res, status, error, message) => res.status(status).json({ error, message }), loadProvider: () => ({ ...provider, dataDir: directory }), generateTask: (...args) => { generatedCount += 1; return behavior(...args); } });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { projectId: 'project-1', requirementId: 'requirement-1', task: 'analysis' };
  async function post(values = {}, user = 'member', signal) {
    const response = await fetch(base + '/api/workspace/ai', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify({ ...body, ...values }), signal });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await post({}, 'no-ai')).status, 403);
    assert.equal((await post({}, 'no-requirements')).status, 403);
    assert.equal((await post({ knowledgeBaseIds: ['kb-1'] }, 'no-knowledge')).status, 403);
    assert.equal((await post({ task: 'cases' }, 'no-cases')).status, 403);
    assert.equal((await post({ requirementId: 'other-project-requirement' })).status, 404);
    assert.equal((await post({ projectId: 'project-2' })).status, 404);
    assert.equal((await post({ knowledgeBaseIds: ['other-project-kb'] })).status, 404);
    assert.equal((await post({ task: 'revise' })).status, 400);
    assert.equal((await post({ review: [{ dimension: '正确性', weight: 6 }] })).status, 400);
    assert.equal(generatedCount, 0);
    assert.equal((await post({}, 'no-cases')).status, 200, 'analysis drafts do not require case-save permission');
    const prior = { type: 'plan', title: '旧计划', content: '完整旧计划', requirementId: 'requirement-1' };
    behavior = async (values) => { assert.equal(values.type, 'plan'); assert.deepEqual(values.draft, prior); return { type: 'plan', title: '修订计划' }; };
    assert.equal((await post({ task: 'revise', draft: prior, history: [{ role: 'user', content: '只调整交付物' }] })).status, 200);
    behavior = async () => { revision += 1; return { type: 'analysis' }; };
    assert.equal((await post()).status, 409);
    let started; let interrupted;
    const began = new Promise((resolve) => { started = resolve; });
    const stopped = new Promise((resolve) => { interrupted = resolve; });
    behavior = async (values, sources, kb, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { reject(new DOMException('closed', 'AbortError')); interrupted(); }, { once: true }); started();
    });
    const controller = new AbortController();
    const first = post({}, 'member', controller.signal);
    const canceled = assert.rejects(first, (error) => error.name === 'AbortError');
    await began;
    assert.equal((await post()).status, 429);
    controller.abort(); await canceled; await stopped;
    await new Promise((resolve) => setImmediate(resolve));
    behavior = async () => ({ type: 'analysis', title: '可再次生成' });
    assert.equal((await post()).status, 200);
    assert.equal((await post({ task: 'analysis', instructions: 'x'.repeat(12001) })).status, 400);
    behavior = (values) => generateWorkspaceTask(values, { ...evidence(), documents: [], images: [], warnings: ['扫描 PDF 未提取文字，请先 OCR。'] }, { chunks: [], images: [], warnings: [] }, { provider });
    const unreadable = await post();
    assert.equal(unreadable.status, 400); assert.match(unreadable.body.warnings[0], /扫描 PDF/);
    const published = { type: 'cases', confirmedPoints: points().points };
    behavior = async (values) => { assert.deepEqual(values.points, points().points); return { type: 'cases' }; };
    assert.equal((await post({ task: 'revise', draft: published, points: [] })).status, 200);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
});

test('AI draft cache is durable per user, project and requirement with permission checks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-ai-drafts-'));
  const db = new Database(path.join(directory, 'drafts.db'));
  const app = express(); app.use(express.json({ limit: '4mb' }));
  const full = { ai: { write: true }, requirements: { view: true }, knowledge: { view: true }, cases: { write: true } };
  const users = {
    alice: { id: 'alice', role: 'member', permissions: structuredClone(full) },
    bob: { id: 'bob', role: 'member', permissions: structuredClone(full) },
    restricted: { id: 'restricted', role: 'member', permissions: structuredClone(full) },
  };
  users.restricted.permissions.ai.write = false;
  app.use((req, res, next) => { req.user = users[req.headers['x-user'] || 'alice']; next(); });
  const deleted = new Set();
  const workspace = { getRequirement: (projectId, id) => projectId === 'project-1' && ['requirement-1', 'requirement-2'].includes(id) && !deleted.has(id) ? { id } : null };
  registerAiWorkspaceRoutes(app, { db, dataDir: directory, workspace, requireProject: (id) => { if (!['project-1', 'project-2'].includes(id)) throw Object.assign(new Error('项目不存在'), { status: 400 }); }, authenticate: () => users.alice, sendError: (res, status, code, message) => res.status(status).json({ error: code, message }) });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = { mode: 'staged', history: [{ role: 'assistant', content: '测试点已生成' }], knowledgeBaseIds: [], draft: { type: 'points', requirementId: 'requirement-1', points: [{ id: 'point-1', title: '登录' }] }, answers: { question: '已确认' }, written: [] };
  async function call(method, projectId, requirementId, user = 'alice', payload = state, baseUpdatedAt) {
    const query = new URLSearchParams({ projectId, ...(requirementId ? { requirementId } : {}) });
    const response = await fetch(`${base}/api/workspace/ai-draft${method === 'GET' ? `?${query}` : ''}`, { method, headers: { 'content-type': 'application/json', 'x-user': user }, ...(method === 'PUT' ? { body: JSON.stringify({ projectId, requirementId, state: payload, ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}) }) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', state, null)).status, 200);
    const original = (await call('GET', 'project-1', 'requirement-1')).body.saved;
    assert.deepEqual(original.state, state);
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', { ...state, instructions: '旧窗口覆盖' }, original.updatedAt - 1)).status, 409);
    assert.deepEqual((await call('GET', 'project-1', 'requirement-1')).body.saved.state, state);
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', state, original.updatedAt)).status, 200);
    assert.equal((await call('GET', 'project-1', 'requirement-1', 'bob')).body.saved, null);
    assert.equal((await call('GET', 'project-2')).body.saved, null);
    assert.equal((await call('GET', 'project-1', 'requirement-1', 'restricted')).status, 403);
    assert.equal((await call('PUT', 'project-1', 'missing')).status, 404);
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'restricted')).status, 403);
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', { ...state, draft: { ...state.draft, requirementId: 'requirement-2' } })).status, 400);
    assert.equal((await call('PUT', 'project-1', 'requirement-2', 'alice', { ...state, draft: null })).status, 200);
    assert.equal((await call('GET', 'project-1')).body.saved.requirementId, 'requirement-2');
    deleted.add('requirement-2');
    assert.equal((await call('GET', 'project-1')).body.saved.requirementId, 'requirement-1');
    users.alice.permissions.knowledge.view = false;
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', { ...state, knowledgeBaseIds: ['kb-1'] })).status, 403);
    users.alice.permissions.knowledge.view = true;
    users.alice.permissions.cases.write = false;
    assert.equal((await call('PUT', 'project-1', 'requirement-1', 'alice', { ...state, draft: { type: 'cases', requirementId: 'requirement-1' } })).status, 403);
    assert.equal(db.prepare('SELECT count(*) count FROM ai_workspace_drafts').get().count, 2);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    db.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
