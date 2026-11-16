import fs from 'node:fs/promises';
import path from 'node:path';

const LIMITS = { maxFiles: 12, maxCharsPerFile: 16000, maxTotalChars: 100000, maxCandidates: 5000, maxScanFiles: 120, maxEntries: 30000 };
const EXTENSIONS = new Set(['.ts', '.js', '.json', '.md']);
const IGNORED = new Set(['node_modules', 'cache', 'caches', 'build', 'dist', 'temp', 'tmp', 'coverage', 'library']);
const SENSITIVE_NAME = /\.env|secret|credential|password|passwd|private[_-]?key|api[_-]?key|access[_-]?token|^auth\./i;
const SENSITIVE_CONTENT = /["']?(?:api[_-]?key|app[_-]?secret|access[_-]?token|password|private[_-]?key)["']?\s*[:=]\s*["'][^"'\r\n]{4,}/i;
const ALIASES = [['活动', 'activity', 'event'], ['奖励', 'reward'], ['道具', 'item'], ['背包', 'pack', 'bag', 'inventory'], ['界面', 'ui', 'view']];
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'into', 'then', 'when', 'true', 'false', 'null', 'undefined', 'http', 'https', 'markdown', 'document', 'test', 'case', '前置', '条件', '执行', '步骤', '预期', '结果', '测试', '用例', '策划', '规则', '功能', '可以', '需要', '进行']);

function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function keywordsFor(documents) {
  let source = '';
  for (const document of Array.isArray(documents) ? documents.slice(0, 5) : []) {
    if (typeof document?.text === 'string') source += document.text.slice(0, Math.max(0, 100000 - source.length));
    if (source.length >= 100000) break;
  }
  const frequencies = new Map();
  const add = (term) => { const lower = term.toLowerCase(); if (!STOP_WORDS.has(lower)) frequencies.set(lower, (frequencies.get(lower) || 0) + 1); };
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9_]{2,39}/g)) add(match[0]);
  for (const match of source.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const span = match[0];
    if (span.length <= 12) add(span);
    for (let index = 0; index < span.length - 1; index++) {
      add(span.slice(index, index + 2));
      if (index + 2 < span.length) add(span.slice(index, index + 3));
    }
  }
  const derived = [...frequencies].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])).slice(0, 48).map(([term]) => term);
  const lower = source.toLowerCase();
  const aliases = ALIASES.filter((group) => group.some((term) => /^[a-z]+$/.test(term) ? new RegExp(`\\b${term}\\b`, 'i').test(lower) : lower.includes(term))).flat();
  return { sourcePresent: Boolean(source.trim()), terms: [...new Set([...derived, ...aliases])] };
}

function score(value, terms) {
  const lower = value.toLowerCase();
  return terms.reduce((total, term) => total + (lower.includes(term) ? Math.min(8, term.length) : 0), 0);
}

async function readSource(filename, allowedRoots, signal) {
  let handle;
  try {
    signal?.throwIfAborted();
    const original = await fs.lstat(filename);
    if (original.isSymbolicLink() || !original.isFile()) return null;
    const real = await fs.realpath(filename);
    if (!allowedRoots.some((root) => within(root, real))) return null;
    handle = await fs.open(real, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino) return null;
    const buffer = Buffer.alloc(4 * LIMITS.maxCharsPerFile);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: bytesRead < stat.size }); }
    catch { return null; }
    if (SENSITIVE_CONTENT.test(content)) return null;
    const truncated = bytesRead < stat.size || content.length > LIMITS.maxCharsPerFile;
    content = content.slice(0, LIMITS.maxCharsPerFile);
    if (content && /[\uD800-\uDBFF]/.test(content.at(-1))) content = content.slice(0, -1);
    return { content, truncated, originalBytes: stat.size };
  } catch (error) { if (signal?.aborted) throw error; return null; }
  finally { await handle?.close().catch(() => {}); }
}

export async function collectProjectContext(projectRoot, documents, { signal } = {}) {
  signal?.throwIfAborted();
  const context = { projectName: '点点消', files: [], candidatePaths: [], keywords: [], totalChars: 0, truncated: false, warnings: [], limits: { ...LIMITS } };
  let root;
  try {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new Error();
    const stat = await fs.lstat(projectRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    root = await fs.realpath(projectRoot);
  } catch (failure) {
    if (signal?.aborted) throw failure;
    const error = new Error('点点消工程目录不可读取，请检查平台的项目路径配置。');
    error.status = 503; error.publicMessage = error.message; throw error;
  }
  const allowedRoots = [];
  for (const relative of [path.join('code', 'assets', 'Script'), 'src']) {
    signal?.throwIfAborted();
    const directory = path.join(root, relative);
    try {
      const stat = await fs.lstat(directory);
      const real = await fs.realpath(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink() && within(root, real)) allowedRoots.push(real);
    } catch { /* Optional source roots can be absent. */ }
  }
  if (!allowedRoots.length) { context.warnings.push('未发现白名单源码目录 code/assets/Script 或 src；本次没有提供游戏源码证据。'); return context; }
  const { sourcePresent, terms } = keywordsFor(documents);
  context.keywords = terms;
  const candidates = [];
  const queue = allowedRoots.map((directory) => ({ directory, depth: 0 }));
  const visited = new Set();
  let entries = 0;
  while (queue.length && entries < LIMITS.maxEntries && candidates.length < LIMITS.maxCandidates) {
    signal?.throwIfAborted();
    const { directory, depth } = queue.shift();
    let real;
    let listing;
    try {
      const stat = await fs.lstat(directory);
      real = await fs.realpath(directory);
      if (stat.isSymbolicLink() || !allowedRoots.some((allowed) => within(allowed, real)) || visited.has(real)) continue;
      visited.add(real);
      listing = await fs.readdir(real, { withFileTypes: true });
    } catch { continue; }
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of listing) {
      signal?.throwIfAborted();
      if (++entries > LIMITS.maxEntries || candidates.length >= LIMITS.maxCandidates) break;
      if (item.name.startsWith('.') || SENSITIVE_NAME.test(item.name) || item.isSymbolicLink()) continue;
      const filename = path.join(real, item.name);
      if (item.isDirectory()) {
        if (depth < 32 && !IGNORED.has(item.name.toLowerCase())) queue.push({ directory: filename, depth: depth + 1 });
      } else if (item.isFile() && EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
        const relative = path.relative(root, filename).split(path.sep).join('/');
        candidates.push({ filename, relative, filenameScore: score(relative, terms) });
      }
    }
  }
  context.truncated = Boolean(queue.length || entries >= LIMITS.maxEntries || candidates.length >= LIMITS.maxCandidates);
  candidates.sort((a, b) => b.filenameScore - a.filenameScore || a.relative.localeCompare(b.relative));
  if (!sourcePresent) {
    context.candidatePaths = candidates.slice(0, 40).map((candidate) => candidate.relative);
    context.warnings.push('未提供可用于匹配的策划正文，仅列出候选路径；未提供这些文件的内容。');
    return context;
  }
  let scanned = 0;
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (context.files.length >= LIMITS.maxFiles || context.totalChars >= LIMITS.maxTotalChars || scanned >= LIMITS.maxScanFiles) { context.truncated = true; break; }
    const source = await readSource(candidate.filename, allowedRoots, signal);
    scanned += 1;
    if (!source || !source.content.trim() || !candidate.filenameScore && !score(source.content, terms)) continue;
    const remaining = LIMITS.maxTotalChars - context.totalChars;
    const content = source.content.slice(0, remaining);
    const truncated = source.truncated || content.length < source.content.length;
    context.files.push({ path: candidate.relative, content, truncated, originalBytes: source.originalBytes });
    context.totalChars += content.length;
    context.truncated ||= truncated;
  }
  const included = new Set(context.files.map((file) => file.path));
  context.candidatePaths = candidates.filter((candidate) => !included.has(candidate.relative)).slice(0, 40).map((candidate) => candidate.relative);
  if (!context.files.length) context.warnings.push('在本次匹配范围内未发现相关源码；候选路径不代表已向模型提供文件内容。');
  if (context.truncated) context.warnings.push('源码上下文受文件数、读取长度或扫描预算限制；仅可依据已提供片段下结论。');
  return context;
}
