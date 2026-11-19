import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFeishuAssistant, FEISHU_REPLY_SCHEMA } from '../feishu-assistant.js';
import { loadFeishuBotCredentials, saveFeishuBotCredentials, startFeishuBot } from '../feishu-bot.js';

const botOpenId = 'ou_bot123';
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function event(id, text, { group = false, senderType = 'user', mentionBot = true, userId = 'ou_user1' } = {}) {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: userId } },
    message: {
      message_id: id, chat_id: group ? 'oc_group' : 'oc_private', chat_type: group ? 'group' : 'p2p',
      message_type: 'text', content: JSON.stringify({ text: group ? `@_user_1 ${text}` : text }),
      mentions: group ? [{ key: '@_user_1', id: { open_id: mentionBot ? botOpenId : 'ou_other' } }] : undefined,
    },
  };
}

test('Feishu assistant only answers user text in DMs or group mentions of this bot', async () => {
  const prompts = []; const replies = [];
  const assistant = createFeishuAssistant({ botOpenId, generate: async (prompt) => { prompts.push(prompt); return { reply: '收到' }; }, reply: async (...args) => { replies.push(args); } });
  assert.equal(await assistant.receive(event('m1', '单聊问题')), true);
  assert.equal(await assistant.receive(event('m1', '重复')), false);
  assert.equal(await assistant.receive(event('m2', '群聊问题', { group: true })), true);
  assert.equal(await assistant.receive(event('m3', '其他人', { group: true, mentionBot: false })), false);
  assert.equal(await assistant.receive(event('m4', '机器人', { senderType: 'app' })), false);
  const image = event('m5', '图片'); image.message.message_type = 'image';
  assert.equal(await assistant.receive(image), false);
  assert.deepEqual(replies, [['m1', '收到'], ['m2', '收到']]);
  assert.ok(prompts[1].includes('群聊问题'));
  assert.ok(!prompts[1].includes('@_user_1'));
  assert.equal(FEISHU_REPLY_SCHEMA.additionalProperties, false);
});

test('conversations are isolated by sender and chat, serialized, and bounded to eight turns', async () => {
  const prompts = []; let active = 0; let highest = 0;
  const assistant = createFeishuAssistant({ botOpenId,
    generate: async (prompt) => { prompts.push(prompt); active += 1; highest = Math.max(highest, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return { reply: '回答' }; },
    reply: async () => {},
  });
  await Promise.all(Array.from({ length: 3 }, (_, index) => assistant.receive(event(`m${index}`, `问题${index}`))));
  for (let index = 3; index < 10; index++) await assistant.receive(event(`m${index}`, `问题${index}`));
  assert.equal(highest, 1);
  assert.ok(prompts[9].includes('问题8'));
  assert.ok(!prompts[9].includes('问题0'));
  await assistant.receive(event('other', '不同用户', { userId: 'ou_user2' }));
  assert.ok(!prompts.at(-1).includes('问题9'));
});

test('generation failure sends a safe response without exposing the error', async () => {
  const replies = [];
  const assistant = createFeishuAssistant({ botOpenId, logger: { warn() {} },
    generate: async () => { throw new Error('private gateway details'); },
    reply: async (...args) => { replies.push(args); },
  });
  await assistant.receive(event('m1', '测试'));
  await assistant.receive(event('m2', 'a'.repeat(4001)));
  assert.equal(replies.length, 2);
  assert.ok(replies.every(([, text]) => !text.includes('private gateway details')));
});

test('bursty messages never grow an unlimited model queue', async () => {
  let release; let calls = 0; const replies = [];
  const blocked = new Promise((resolve) => { release = resolve; });
  const assistant = createFeishuAssistant({ botOpenId, generate: async () => { calls += 1; await blocked; return { reply: '完成' }; },
    reply: async (id, text) => { replies.push([id, text]); },
  });
  const firstThree = Array.from({ length: 3 }, (_, index) => assistant.receive(event(`m${index}`, `问题${index}`)));
  const rejected = await Promise.all(Array.from({ length: 50 }, (_, index) => assistant.receive(event(`overflow${index}`, '再问'))));
  assert.equal(rejected.filter(Boolean).length, 0);
  assert.equal(calls, 1);
  assert.equal(replies.filter(([, text]) => text.includes('稍后')).length, 1);
  release();
  await Promise.all(firstThree);
  assert.equal(calls, 3);
});

test('Feishu credentials use the local password key and never persist plaintext', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-bot-'));
  try {
    assert.equal(loadFeishuBotCredentials(directory, {}), null);
    const credentials = { appId: 'cli_1234567890abcdef', appSecret: 'private-feishu-secret' };
    saveFeishuBotCredentials(directory, credentials);
    const stored = fs.readFileSync(path.join(directory, 'feishu-bot.json'), 'utf8');
    assert.ok(!stored.includes(credentials.appSecret));
    assert.deepEqual(loadFeishuBotCredentials(directory, {}), credentials);
    fs.unlinkSync(path.join(directory, 'password-key'));
    assert.throws(() => loadFeishuBotCredentials(directory, {}), /password-key/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('configuration CLI accepts secret on stdin without printing it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-setup-'));
  try {
    const secret = 'non-production-test-secret';
    const child = spawnSync(process.execPath, [path.join(serverDir, 'configure-feishu-bot.js'), 'cli_1234567890abcdef'], {
      cwd: serverDir, env: { ...process.env, QZZ_DATA_DIR: directory }, input: `${secret}\n`, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(!child.stdout.includes(secret));
    assert.deepEqual(loadFeishuBotCredentials(directory, {}), { appId: 'cli_1234567890abcdef', appSecret: secret });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bot starts a long connection and acknowledges events without waiting for generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qzz-feishu-ws-'));
  let handler; let finish; let sent;
  class Client {
    constructor() { this.im = { v1: { message: { reply: async (request) => { sent = request; return { code: 0 }; } } } }; }
    async request() { return { bot: { open_id: botOpenId } }; }
  }
  class EventDispatcher {
    register(handlers) { handler = handlers['im.message.receive_v1']; return this; }
  }
  class WSClient {
    async start({ eventDispatcher }) { assert.ok(eventDispatcher); }
    close() {}
  }
  try {
    saveFeishuBotCredentials(directory, { appId: 'cli_1234567890abcdef', appSecret: 'test-only-secret' });
    const sdk = { Client, WSClient, EventDispatcher, LoggerLevel: { error: 'error' } };
    const bot = await startFeishuBot(directory, { sdk, loadProvider: () => ({ mode: 'codex', apiKey: 'fake' }),
      runModel: () => new Promise((resolve) => { finish = resolve; }), logger: { info() {}, warn() {} }, });
    assert.ok(bot instanceof WSClient);
    assert.equal(handler(event('m1', '你好')), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent, undefined);
    finish({ reply: '你好，QA' });
    for (let i = 0; i < 10 && !sent; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.path.message_id, 'm1');
    assert.deepEqual(JSON.parse(sent.data.content), { text: '你好，QA' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
