import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadAiProvider } from './ai-provider.js';
import { runCodexData } from './codex-generator.js';
import { createFeishuAssistant, FEISHU_REPLY_SCHEMA } from './feishu-assistant.js';
import { decryptPassword, encryptPassword, loadPasswordKey } from './passwords.js';

const APP_ID = /^cli_[0-9a-f]{16}$/i;

function validateCredentials({ appId, appSecret }) {
  if (!APP_ID.test(appId || '') || typeof appSecret !== 'string' || !appSecret.trim()) {
    throw new Error('飞书应用凭据不完整');
  }
  return { appId, appSecret };
}

export function loadFeishuBotCredentials(dataDir, env = process.env) {
  if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET) {
    return validateCredentials({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET });
  }
  const filename = path.join(dataDir, 'feishu-bot.json');
  if (!fs.existsSync(filename)) return null;
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!config.encryptedAppSecret || config.appSecret) throw new Error('飞书应用配置无效');
  return validateCredentials({
    appId: config.appId,
    appSecret: decryptPassword(config.encryptedAppSecret, loadPasswordKey(dataDir, true)),
  });
}

export function saveFeishuBotCredentials(dataDir, value) {
  const { appId, appSecret } = validateCredentials(value);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'feishu-bot.json');
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    const encryptedAppSecret = encryptPassword(appSecret, loadPasswordKey(dataDir));
    fs.writeFileSync(temporary, JSON.stringify({ appId, encryptedAppSecret }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function startFeishuBot(dataDir, { sdk, loadProvider = loadAiProvider, runModel = runCodexData, logger = console } = {}) {
  const credentials = loadFeishuBotCredentials(dataDir);
  if (!credentials) return null;
  const provider = loadProvider(dataDir);
  if (provider.mode !== 'codex' || !provider.apiKey) throw new Error('飞书助手需要已配置的本机 Codex 模型');
  const Lark = sdk || await import('@larksuiteoapi/node-sdk');
  const baseConfig = { ...credentials, loggerLevel: Lark.LoggerLevel.error };
  const client = new Lark.Client(baseConfig);
  const info = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
  const botOpenId = info?.bot?.open_id || info?.data?.bot?.open_id;
  if (!/^ou_[A-Za-z0-9]+$/.test(botOpenId || '')) throw new Error('无法确认飞书机器人身份');
  const assistant = createFeishuAssistant({
    botOpenId,
    logger,
    generate: async (prompt) => runModel({ prompt, schema: FEISHU_REPLY_SCHEMA, config: provider }),
    reply: async (messageId, text) => {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) },
      });
      if (response?.code !== 0) throw new Error('Feishu reply failed');
    },
  });
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    onReady: () => logger.info('飞书助手长连接已就绪'),
    onError: () => logger.warn('飞书助手长连接中断，请检查网络与应用配置'),
  });
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (event) => { void assistant.receive(event); },
  });
  await wsClient.start({ eventDispatcher });
  return wsClient;
}
