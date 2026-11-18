import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { loadPasswordKey, encryptPassword, decryptPassword } from './passwords.js';

export const COMPANY_AI_DEFAULTS = {
  mode: 'codex', baseUrl: 'https://m3-ai-middle.miaoziz.com/v1/',
  model: 'gpt-6.1-sol', reasoningEffort: 'ultra', wireApi: 'responses',
  projectRoot: 'D:\\merge_happy.git',
};
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export function validAiModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value);
}

function localCodexModels(filename, reasoningEffort) {
  try {
    const catalog = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(catalog.models)) return null;
    return new Set(catalog.models.filter((entry) => validAiModelId(entry?.slug) &&
      entry.visibility !== 'hide' &&
      (!Array.isArray(entry.supported_reasoning_levels) || entry.supported_reasoning_levels.some((level) => level.effort === reasoningEffort)))
      .map((entry) => entry.slug));
  } catch { return null; }
}

export async function discoverAiModels(provider, { request = fetch, catalogFile = path.join(os.homedir(), '.codex', 'models_cache.json') } = {}) {
  const defaultModel = provider.model;
  const configured = { models: [{ id: defaultModel, label: defaultModel }], defaultModel, source: 'configured' };
  if (!provider.apiKey || !validAiModelId(defaultModel)) return configured;
  try {
    const response = await request(new URL('models', provider.baseUrl), {
      headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return configured;
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || payload.data.length > 500) return configured;
    const gateway = [...new Set(payload.data.map((entry) => entry?.id).filter(validAiModelId))];
    if (!gateway.length) return configured;
    const local = provider.mode === 'codex' ? localCodexModels(catalogFile, provider.reasoningEffort) : null;
    const available = gateway.filter((id) => !local || local.has(id));
    if (!available.includes(defaultModel)) available.unshift(defaultModel);
    available.sort((left, right) => left === defaultModel ? -1 : right === defaultModel ? 1 : left.localeCompare(right, 'en', { numeric: true }));
    return { models: available.map((id) => ({ id, label: id })), defaultModel, source: local ? 'gateway+local' : 'gateway' };
  } catch { return configured; }
}

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
