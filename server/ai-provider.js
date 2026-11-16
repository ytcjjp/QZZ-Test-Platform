import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadPasswordKey, encryptPassword, decryptPassword } from './passwords.js';

export const COMPANY_AI_DEFAULTS = {
  mode: 'codex', baseUrl: 'https://m3-ai-middle.miaoziz.com/v1/',
  model: 'gpt-6.1-sol', reasoningEffort: 'ultra', wireApi: 'responses',
  projectRoot: 'D:\\merge_happy.git',
};

function validateProvider(value) {
  const provider = { ...COMPANY_AI_DEFAULTS, ...value };
  if (!['api', 'codex'].includes(provider.mode)) throw new Error('AI 调用模式配置不正确');
  const base = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('AI 服务地址配置不正确');
  provider.baseUrl = base.href.replace(/\/?$/, '/');
  if (typeof provider.model !== 'string' || !provider.model.trim() || provider.model.length > 120) throw new Error('AI 模型配置不正确');
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(provider.reasoningEffort)) throw new Error('AI 推理强度配置不正确');
  if (!['responses', 'chat'].includes(provider.wireApi)) throw new Error('AI 接口类型配置不正确');
  if (typeof provider.apiKey !== 'string') throw new Error('AI 密钥配置不正确');
  if (provider.mode === 'codex' && (typeof provider.projectRoot !== 'string' || !path.isAbsolute(provider.projectRoot))) throw new Error('Codex 项目路径配置不正确');
  return provider;
}

export function loadAiProvider(dataDir, env = process.env) {
  const filename = path.join(dataDir, 'ai-provider.json');
  if (fs.existsSync(filename)) {
    const { encryptedApiKey, ...stored } = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const apiKey = encryptedApiKey ? decryptPassword(encryptedApiKey, loadPasswordKey(dataDir, true)) : '';
    return { ...validateProvider({ ...stored, apiKey }), dataDir };
  }
  return { ...validateProvider({
    mode: env.AI_MODE || 'api',
    baseUrl: env.AI_BASE_URL || COMPANY_AI_DEFAULTS.baseUrl,
    model: env.AI_MODEL || COMPANY_AI_DEFAULTS.model,
    reasoningEffort: env.AI_REASONING_EFFORT || COMPANY_AI_DEFAULTS.reasoningEffort,
    wireApi: env.AI_WIRE_API || 'chat',
    apiKey: env.AI_API_KEY || env.OPENAI_API_KEY || '',
    projectRoot: env.AI_PROJECT_ROOT || COMPANY_AI_DEFAULTS.projectRoot,
    codexBinary: env.CODEX_BINARY || undefined,
  }), dataDir };
}

export function saveAiProvider(dataDir, value) {
  const provider = validateProvider(value);
  fs.mkdirSync(dataDir, { recursive: true });
  const { apiKey, dataDir: ignoredDataDir, ...stored } = provider;
  const encryptedApiKey = apiKey ? encryptPassword(apiKey, loadPasswordKey(dataDir)) : '';
  const filename = path.join(dataDir, 'ai-provider.json');
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ ...stored, encryptedApiKey }, null, 2), { mode: 0o600 }); fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return publicAiProvider(provider);
}

export function publicAiProvider(provider) {
  return {
    aiConfigured: Boolean(provider.apiKey && provider.model),
    aiModel: provider.model, aiReasoningEffort: provider.reasoningEffort,
    aiMode: provider.mode, aiProjectName: provider.mode === 'codex' ? '点点消' : undefined,
  };
}
