import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { runCodexData } from '../codex-generator.js';
import { WORKSPACE_SCHEMAS } from '../ai-workspace.js';

// Opt-in integration: the installed CLI talks only to this loopback fixture.
// No platform configuration, production credentials, or real model are read.
const enabled = process.env.QZZ_TEST_REAL_CODEX === '1';
const sourceIds = ['req:protocol-fixture:1'];
const analysis = { title: '协议分析', content: '## 功能清单\n活动入口。\n## 界面描述\n主界面入口。\n## 待澄清项\n无。', questions: [], sourceIds };
const cases = {
  title: '协议用例', questions: [], sourceIds,
  cases: [{ id: 'TC_entry', module: '活动入口', title: '打开入口', category: '主流程', priority: 'P1', preconditions: '活动开放。', steps: '点击入口。', expected: '打开活动页。', sourceIds }],
  reviewReport: { summary: '', dimensions: [] },
};

function streamResult(response, value) {
  const text = JSON.stringify(value);
  const message = { id: 'msg_local_protocol', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const completed = {
    id: 'resp_local_protocol', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null,
    model: 'gpt-6.1-sol', output: [message], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let sequenceNumber = 0;
  const event = (type, values) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber++, ...values })}\n\n`);
  event('response.created', { response: { ...completed, status: 'in_progress', output: [], usage: null } });
  event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] });
  event('response.output_text.done', { item_id: message.id, output_index: 0, content_index: 0, text, logprobs: [] });
  event('response.content_part.done', { item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
  event('response.output_item.done', { output_index: 0, item: message });
  event('response.completed', { response: completed });
  response.end();
}

test('real readonly CLI submits analysis and cases schemas through the same Responses protocol', { skip: !enabled, timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-codex-protocol-'));
  const requests = [];
  let mode = 'analysis';
  const gateway = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const decoded = request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes;
      const body = JSON.parse(decoded.toString('utf8'));
      requests.push({ path: request.url, body });
      if (mode === 'schema-error') {
        response.writeHead(400, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_json_schema', message: 'Schema parameter rejected by local fixture' } }));
      }
      streamResult(response, mode === 'analysis' ? analysis : cases);
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'fixture_invalid_request' } }));
    }
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const config = {
    apiKey: 'local-protocol-fixture-key', baseUrl: `http://127.0.0.1:${gateway.address().port}/v1/`,
    model: 'gpt-6.1-sol', reasoningEffort: 'ultra', projectRoot: directory, dataDir: directory,
    codexBinary: process.env.QZZ_TEST_CODEX_BINARY || 'codex', timeoutMs: 15000,
  };
  try {
    for (const type of ['analysis', 'cases']) {
      mode = type;
      const before = requests.length;
      const result = await runCodexData({ prompt: '只返回指定 schema 的本地协议测试 JSON，不调用工具。', schema: WORKSPACE_SCHEMAS[type], config });
      assert.deepEqual(result, type === 'analysis' ? analysis : cases);
      assert.equal(requests.length, before + 1);
      const sent = requests.at(-1);
      assert.equal(sent.path, '/v1/responses');
      assert.equal(sent.body.stream, true);
      // This installed CLI normalizes ultra to the wire-level xhigh value.
      assert.ok(['ultra', 'xhigh'].includes(sent.body.reasoning.effort));
      assert.equal(sent.body.text.format.type, 'json_schema');
      assert.equal(sent.body.text.format.strict, true);
      assert.deepEqual(sent.body.text.format.schema, WORKSPACE_SCHEMAS[type]);
      assert.equal((sent.body.tools || []).some((tool) => tool.type === 'web_search' || ['shell', 'exec_command', 'write_stdin'].includes(tool.name)), false);
      assert.equal(JSON.stringify(sent.body).includes(config.apiKey), false);
      assert.deepEqual(await fs.readdir(path.join(directory, 'codex-jobs')), []);
    }
    mode = 'schema-error';
    await assert.rejects(runCodexData({ prompt: '本地 schema 拒绝测试。', schema: WORKSPACE_SCHEMAS.analysis, config }), (error) => {
      assert.equal(error.code, 'CODEX_SCHEMA');
      assert.equal(error.status, 502);
      assert.match(error.publicMessage, /^AI 服务拒绝了结构化输出协议/);
      assert.match(error.publicMessage, /诊断编号：[a-f0-9]{8}/);
      assert.equal(error.message.includes(config.apiKey), false);
      return true;
    });
    assert.deepEqual(await fs.readdir(path.join(directory, 'codex-jobs')), []);
  } finally {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
