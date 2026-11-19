import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const PLATFORM_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40,64}$/i;
const LIMITS = { entries: 30000, paths: 5000, changedPaths: 1000, files: 12,
  charsPerFile: 16000, totalChars: 100000, fileBytes: 256000, metaFiles: 2000,
  resourceChecks: 120, referenceChecks: 120, metaIndexBytes: 10 * 1024 * 1024, findings: 30 };
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cs', '.json', '.md', '.prefab', '.fire', '.anim', '.unity', '.asset']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.cs', '.json']);
const RESOURCE_EXT = new Set(['.prefab', '.fire', '.anim', '.unity', '.asset']);
const META_ASSET_EXT = new Set(['.ts', '.js', '.json', '.prefab', '.fire', '.anim', '.unity', '.asset', '.cs']);
const IGNORED = new Set(['.git', '.codex', '.ssh', '.idea', '.vscode', 'node_modules', 'cache', 'caches',
  'build', 'dist', 'temp', 'tmp', 'coverage', 'library', 'logs', 'log', 'obj', 'bin', 'packages', 'docs', 'reports']);
const SENSITIVE_NAME = /(?:^\.env(?:\.|$)|secret|credential|password|passwd|private[_-]?key|api[_-]?key|access[_-]?token|^auth\.)/i;
const SENSITIVE_CONTENT = /["']?(?:api[_-]?key|app[_-]?secret|access[_-]?token|password|private[_-]?key)["']?\s*[:=]\s*["'][^"'\r\n]{4,}/i;
const CASE_ALIASES = [['活动', 'activity', 'event'], ['界面', 'ui', 'view', 'panel'], ['图标', 'icon'], ['资源', 'asset', 'resource']];
const sourceLocks = new Map();

function fail(message) { const error = new Error(message); error.status = 400; error.publicMessage = message; throw error; }
function within(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
      value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..' ||
        part.startsWith('.') || IGNORED.has(part.toLowerCase()) || SENSITIVE_NAME.test(part))) return false;
  return true;
}
function auditablePath(relative, engine) {
  const extension = path.posix.extname(relative).toLowerCase();
  if (engine === 'cocos') return relative.startsWith('code/assets/') &&
      (extension === '.meta' || RESOURCE_EXT.has(extension) || relative.startsWith('code/assets/Script/') && CODE_EXT.has(extension)) ||
      (relative.startsWith('src/') || relative.startsWith('code_sub/src/')) && CODE_EXT.has(extension);
  if (engine === 'unity') return relative.startsWith('Assets/') &&
    (extension === '.meta' || CODE_EXT.has(extension) || RESOURCE_EXT.has(extension));
  return ['src/', 'app/', 'lib/', 'code/', 'code_sub/src/', 'Assets/'].some((prefix) => relative.startsWith(prefix)) &&
    (CODE_EXT.has(extension) || RESOURCE_EXT.has(extension));
}
function safeLocalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) ||
      (process.platform === 'win32' && /^\\\\/.test(value)) || path.resolve(value) === path.parse(value).root) fail('本地代码目录路径不安全');
  return path.resolve(value);
}

export function validateCodeSourceSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !UUID.test(input.id || '')) fail('代码源标识无效');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 100 || /[\x00-\x1f]/.test(input.label)) fail('代码源名称无效');
  if (input.kind === 'local') {
    safeLocalPath(input.location);
  } else if (input.kind === 'git') {
    let url;
    try { url = new URL(input.location); } catch { fail('Git 仓库地址无效'); }
    const hosts = new Set(['github.com', ...(process.env.QZZ_CODE_AUDIT_GIT_HOSTS || '').split(',')
      .map((host) => host.trim().toLowerCase()).filter((host) => /^[a-z0-9.-]+$/.test(host) && !/^\d+(?:\.\d+){3}$/.test(host))]);
    const segments = url.pathname.split('/').slice(1);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password ||
        url.port && url.port !== '443' || url.search || url.hash || segments.length < 2 || segments.length > 5 ||
        segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..') ||
        /%|\s|[\x00-\x1f]/.test(input.location)) fail('Git 仓库地址或主机不允许');
  } else fail('代码源类型无效');
  return { id: input.id, kind: input.kind, location: input.location, label: input.label.trim() };
}

function gitEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|SSH_)/i.test(key)));
  return { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LFS_SKIP_SMUDGE: '1' };
}
async function runGit(cwd, args, signal, { remote = false, maxBuffer = 8 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  const common = ['-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'http.followRedirects=false',
    '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : os.devNull}`,
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'submodule.recurse=false'];
  const { stdout } = await exec('git', [...common, ...args], { cwd, env: gitEnvironment(), windowsHide: true,
    timeout: remote ? 120000 : 12000, maxBuffer, encoding: 'utf8', signal });
  return stdout;
}
async function tryGit(cwd, args, signal) {
  try { return await runGit(cwd, args, signal); }
  catch (error) { if (signal?.aborted) throw error; return null; }
}
async function localRoot(location, dataDir) {
  const resolved = safeLocalPath(location);
  let stat; let real;
  try { stat = await fs.lstat(resolved); real = await fs.realpath(resolved); }
  catch { fail('本地代码目录不可读取'); }
  const base = path.basename(real).toLowerCase();
  const privateRoot = ['appdata', 'windows', 'program files', 'program files (x86)', '$recycle.bin'].includes(base) ||
    base.startsWith('.') || SENSITIVE_NAME.test(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(real).toLowerCase() !== resolved.toLowerCase() ||
      within(PLATFORM_ROOT, real) || within(dataDir, real) || within(real, PLATFORM_ROOT) || within(real, dataDir) ||
      privateRoot ||
      real.toLowerCase() === os.homedir().toLowerCase()) fail('本地代码目录不能是链接、平台或敏感目录');
  return real;
}

async function remoteRoot(source, dataDir, signal) {
  const parent = path.join(dataDir, 'code-audit-repos');
  await fs.mkdir(parent, { recursive: true });
  const parentStat = await fs.lstat(parent);
  const parentReal = await fs.realpath(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !within(dataDir, parentReal) ||
      parentReal.toLowerCase() !== parent.toLowerCase()) fail('隔离仓库管理目录无效');
  const root = path.join(parent, source.id);
  let exists = false;
  try { const stat = await fs.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('隔离仓库目录无效'); exists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    const temporary = path.join(parent, `${source.id}-${crypto.randomUUID()}.tmp`);
    try {
      await runGit(parent, ['clone', '--bare', '--single-branch', '--depth=2', '--filter=blob:none', '--no-tags',
        '--no-checkout', '--', source.location, temporary], signal, { remote: true });
      await fs.rename(temporary, root);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  } else {
    const origin = (await runGit(root, ['remote', 'get-url', 'origin'], signal)).trim();
    if (origin !== source.location) fail('隔离仓库与当前代码源不匹配');
  }
  await runGit(root, ['fetch', '--no-tags', '--depth=2', 'origin', '+HEAD:refs/heads/qzz-audit'], signal, { remote: true });
  return root;
}

async function listFiles(root, signal, terms) {
  const paths = new Map(); const queue = []; const visited = new Set(); let entries = 0; let truncated = false;
  for (const relative of ['code/assets/Script', 'code_sub/src', 'src', 'Assets/Scripts', 'Assets']) {
    const directory = path.join(root, relative);
    try {
      const stat = await fs.lstat(directory);
      const real = await fs.realpath(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink() && real.toLowerCase() === directory.toLowerCase() && within(root, real)) {
        queue.push(directory);
      }
    } catch { /* Optional source roots can be absent. */ }
  }
  queue.push(root);
  while (queue.length) {
    signal?.throwIfAborted();
    const folder = queue.shift();
    if (visited.has(folder.toLowerCase())) continue;
    visited.add(folder.toLowerCase());
    let children;
    try { children = await fs.readdir(folder, { withFileTypes: true }); }
    catch { continue; }
    children.sort((left, right) => {
      const prefix = path.relative(root, folder).split(path.sep).join('/');
      return score(`${prefix}/${right.name}`, terms) - score(`${prefix}/${left.name}`, terms) ||
        left.name.localeCompare(right.name);
    });
    for (const child of children) {
      if (++entries > LIMITS.entries || paths.size >= LIMITS.paths) { truncated = true; break; }
      const absolute = path.join(folder, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (!safePath(relative) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) queue.push(absolute);
      else if (child.isFile()) paths.set(relative, { relative, absolute });
    }
    if (truncated) break;
  }
  return { paths, truncated };
}

async function listTree(root, revision, signal) {
  const output = await runGit(root, ['ls-tree', '-r', '-z', revision], signal, { maxBuffer: 8 * 1024 * 1024 });
  const paths = new Map(); let truncated = false;
  for (const item of output.split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = item.slice(0, tab).split(' ');
    const relative = item.slice(tab + 1);
    if (!safePath(relative) || mode === '120000' || type !== 'blob' || !SHA.test(oid)) continue;
    if (paths.size >= LIMITS.paths) { truncated = true; break; }
    paths.set(relative, { relative, oid });
  }
  return { paths, truncated };
}

async function readLocal(root, entry, signal) {
  let handle;
  try {
    signal?.throwIfAborted();
    const before = await fs.lstat(entry.absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size > LIMITS.fileBytes) return null;
    const real = await fs.realpath(entry.absolute);
    if (!within(root, real)) return null;
    handle = await fs.open(real, 'r');
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) return null;
    const bytes = Buffer.alloc(Math.min(after.size, LIMITS.fileBytes));
    const result = await handle.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, result.bytesRead), originalBytes: after.size };
  } catch (error) { if (signal?.aborted) throw error; return null; }
  finally { await handle?.close().catch(() => {}); }
}
async function readBlob(root, entry, signal) {
  try {
    const size = Number((await runGit(root, ['cat-file', '-s', entry.oid], signal)).trim());
    if (!Number.isSafeInteger(size) || size > LIMITS.fileBytes) return null;
    const bytes = await runGit(root, ['cat-file', 'blob', entry.oid], signal, { maxBuffer: LIMITS.fileBytes + 1024 });
    return { bytes: Buffer.from(bytes, 'utf8'), originalBytes: size };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}
function textOf(result) {
  if (!result) return null;
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
    if (/\0/.test(content) || SENSITIVE_CONTENT.test(content)) return null;
    return { content, originalBytes: result.originalBytes };
  } catch { return null; }
}
function termsFor(rows) {
  const text = (Array.isArray(rows) ? rows.slice(0, 100) : []).map((row) =>
    [row.title, row.preconditions, row.steps, row.expected].filter((value) => typeof value === 'string').join(' ')).join(' ').slice(0, 30000);
  const words = [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9_]{1,39}|[\u4e00-\u9fff]{2,}/g)].flatMap(([word]) =>
    /^[A-Za-z0-9]/.test(word) ? [word.toLowerCase()] : word.length <= 4 ? [word] :
      [word.slice(0, 16), ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))]);
  const aliases = CASE_ALIASES.filter((group) => group.some((term) => text.toLowerCase().includes(term))).flat();
  return [...new Set([...words, ...aliases])].slice(0, 70);
}
function score(relative, terms) {
  const lower = relative.toLowerCase();
  return terms.reduce((total, term) => total + (lower.includes(term) ? Math.min(term.length, 8) : 0), 0);
}
function matchingCase(relative, rows) {
  const lower = relative.toLowerCase();
  const basename = path.posix.basename(relative).toLowerCase();
  const scored = (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.id === 'string').map((row) => {
    const text = [row.title, row.preconditions, row.steps, row.expected]
      .filter((value) => typeof value === 'string').join(' ').toLowerCase();
    const ascii = [...text.matchAll(/[a-z][a-z0-9_]{2,39}/g)].map(([word]) => word);
    const chinese = [...text.matchAll(/[\u4e00-\u9fff]{2,}/g)]
      .flatMap(([word]) => word.length <= 4 ? [word] : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)));
    const aliases = CASE_ALIASES.filter((group) => group.some((term) => text.includes(term))).flat();
    const tokens = [...new Set([...ascii, ...chinese, ...aliases])];
    const value = tokens.reduce((total, term) => total + (lower.includes(term) ? Math.min(8, term.length) : 0), 0) +
      (typeof row.title === 'string' && basename.includes(row.title.toLowerCase().trim()) ? 12 : 0);
    return { id: row.id, value };
  }).sort((left, right) => right.value - left.value);
  return scored[0]?.value > 0 && scored[0].value !== scored[1]?.value ? scored[0].id : null;
}
function parseChanges(output) {
  const changed = new Map();
  const values = output.split('\0');
  for (let index = 0; index + 1 < values.length; index += 2) {
    const [status, relative] = values.slice(index, index + 2);
    if (status && safePath(relative)) changed.set(relative, status[0]);
  }
  return changed;
}

function waitForTurn(previous, signal) {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
  });
}

export async function withCodeSourceLock(key, work, signal) {
  const previous = sourceLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  sourceLocks.set(key, tail);
  let acquired = false;
  try {
    await waitForTurn(previous, signal);
    acquired = true;
    signal?.throwIfAborted();
    return await work();
  } finally {
    if (acquired) release();
    else void previous.then(release);
    if (sourceLocks.get(key) === tail) void tail.then(() => {
      if (sourceLocks.get(key) === tail) sourceLocks.delete(key);
    });
  }
}

async function identifyEngine(inventory, read, signal) {
  for (const filename of ['code/project.json', 'project.json']) {
    if (!inventory.has(filename)) continue;
    signal?.throwIfAborted();
    const source = await read(filename);
    try { if (/cocos/i.test(JSON.parse(source?.content || '{}').engine || '')) return 'cocos'; }
    catch { /* A malformed project manifest is not proof of the engine. */ }
  }
  return inventory.has('ProjectSettings/ProjectVersion.txt') ? 'unity' : 'unknown';
}

function metaIdentifiers(content, engine) {
  if (engine === 'unity') {
    const ids = [...content.matchAll(/^guid:\s*([0-9a-f]{32})\s*$/gmi)].map((match) => match[1].toLowerCase());
    return ids.length ? ids : null;
  }
  try {
    const meta = JSON.parse(content);
    const ids = [meta.uuid, meta.rawTextureUuid, ...Object.values(meta.subMetas || {}).flatMap((item) => [item?.uuid, item?.rawTextureUuid])]
      .filter((value) => typeof value === 'string' && /^[0-9a-f-]{20,40}$/i.test(value)).map((value) => value.toLowerCase());
    return ids.length ? ids : null;
  } catch { return null; }
}

async function oldMeta(root, revision, relative, signal) {
  if (!revision || !SHA.test(revision) || !safePath(relative)) return null;
  try {
    const content = await runGit(root, ['show', `${revision}:${relative}`], signal, { maxBuffer: LIMITS.fileBytes + 1024 });
    return content.length <= LIMITS.fileBytes ? content : null;
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

export async function inspectCodeSource(input, options = {}) {
  const source = validateCodeSourceSpec(input);
  if (source.kind !== 'git') return inspectValidatedSource(source, options);
  return withCodeSourceLock(`${path.resolve(options.dataDir || '')}|${source.id}`,
    () => inspectValidatedSource(source, options), options.signal);
}

async function inspectValidatedSource(input, { dataDir, previousRevision, caseRows = [], signal } = {}) {
  signal?.throwIfAborted();
  const source = validateCodeSourceSpec(input);
  const dataRoot = safeLocalPath(dataDir);
  const dataStat = await fs.lstat(dataRoot).catch(() => null);
  if (!dataStat?.isDirectory() || dataStat.isSymbolicLink()) fail('平台数据目录无效');
  const warnings = [];
  const remote = source.kind === 'git';
  const root = remote ? await remoteRoot(source, dataRoot, signal) : await localRoot(source.location, dataRoot);
  const head = remote ? (await runGit(root, ['rev-parse', 'refs/heads/qzz-audit'], signal)).trim()
    : (await tryGit(root, ['rev-parse', '--verify', 'HEAD'], signal))?.trim() || null;
  const terms = termsFor(caseRows);
  const listed = remote ? await listTree(root, 'refs/heads/qzz-audit', signal) : await listFiles(root, signal, terms);
  const inventory = listed.paths;
  const read = async (relative) => {
    const entry = inventory.get(relative);
    if (!entry || !safePath(relative)) return null;
    return textOf(remote ? await readBlob(root, entry, signal) : await readLocal(root, entry, signal));
  };
  const engine = await identifyEngine(inventory, read, signal);
  const previousHead = typeof previousRevision === 'string' ? previousRevision.match(/^([0-9a-f]{40,64})(?::[0-9a-f]{16})?$/i)?.[1] : null;
  const changes = new Map();
  if (head && previousHead && previousHead !== head) {
    const diff = await tryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z',
      `${previousHead}..${head}`, '--'], signal);
    if (diff === null) warnings.push('上次版本不在当前仓库历史中，已按当前文件全量取样；无法可靠判断被删资源。');
    else for (const [relative, status] of parseChanges(diff)) changes.set(relative, status);
  }
  if (!remote && head) {
    const dirty = await tryGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', 'HEAD', '--'], signal);
    if (dirty === null) warnings.push('未能读取本地 Git 变更，结果仅基于当前可访问文件。');
    else for (const [relative, status] of parseChanges(dirty)) changes.set(relative, status);
    const untracked = await tryGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], signal);
    if (untracked) for (const relative of untracked.split('\0')) if (safePath(relative)) changes.set(relative, 'A');
  }
  if (!head) warnings.push('本地目录不是可读取的 Git 提交，无法精确区分提交间变更。');
  if (!previousRevision || previousHead && previousHead !== head && !changes.size || !head && previousRevision) {
    if (!changes.size) for (const relative of inventory.keys()) changes.set(relative, 'A');
  }
  for (const relative of changes.keys()) if (!auditablePath(relative, engine)) changes.delete(relative);
  const dirtySignature = [];
  if (!remote) for (const [relative, status] of changes) {
    const entry = inventory.get(relative);
    const stat = entry ? await fs.stat(entry.absolute).catch(() => null) : null;
    dirtySignature.push([relative, status, stat?.size || 0, Math.floor(stat?.mtimeMs || 0)]);
  }
  const unversionedSignature = [];
  if (!head) for (const [relative, entry] of inventory) {
    if (!auditablePath(relative, engine)) continue;
    signal?.throwIfAborted();
    const stat = await fs.stat(entry.absolute).catch(() => null);
    unversionedSignature.push([relative, stat?.size || 0, stat?.mtimeMs || 0]);
  }
  const revision = remote ? head : head ? `${head}:${digest(JSON.stringify(dirtySignature)).slice(0, 16)}`
    : `tree:${digest(JSON.stringify(unversionedSignature)).slice(0, 16)}`;
  if (previousRevision === revision) changes.clear();
  if (!head && previousRevision && previousRevision !== revision) {
    changes.clear();
    for (const relative of inventory.keys()) if (auditablePath(relative, engine)) changes.set(relative, 'M');
  }

  const changedPaths = [...changes.keys()].sort().slice(0, LIMITS.changedPaths);
  const changedSet = new Set(changedPaths);
  const truncatedPaths = changes.size > LIMITS.changedPaths;
  const files = []; const included = new Set(); let totalChars = 0; let truncatedFiles = 0;
  async function include(relative) {
    if (included.has(relative) || files.length >= LIMITS.files || totalChars >= LIMITS.totalChars ||
        !SOURCE_EXT.has(path.posix.extname(relative).toLowerCase())) return null;
    const sourceFile = await read(relative);
    if (!sourceFile?.content.trim()) return null;
    const remaining = Math.min(LIMITS.charsPerFile, LIMITS.totalChars - totalChars);
    let content = sourceFile.content.slice(0, remaining);
    if (/[\uD800-\uDBFF]/.test(content.at(-1))) content = content.slice(0, -1);
    const truncated = content.length < sourceFile.content.length;
    if (truncated) truncatedFiles++;
    files.push({ path: relative, content, truncated }); included.add(relative); totalChars += content.length;
    return files.at(-1);
  }

  const verifiedFindings = []; let unlinkedFindings = 0; let resourceTruncated = false;
  async function finding(rule, relative, identifier, title, expected, actual, line, excerpt) {
    if (verifiedFindings.length >= LIMITS.findings) return;
    const caseId = matchingCase(relative, caseRows);
    if (!caseId) {
      unlinkedFindings++;
      if (unlinkedFindings <= 5) warnings.push(`${relative} 有资源异常，但未能唯一关联所选用例；请人工复核，不自动建单。`);
      return;
    }
    const file = await include(relative);
    if (!file) return;
    const lines = file.content.split(/\r?\n/);
    if (line < 1 || line > lines.length || !lines[line - 1].includes(excerpt)) return;
    verifiedFindings.push({ id: digest(`${source.id}|${rule}|${relative}|${identifier}`).slice(0, 24),
      caseId, title, expected, actual, rule, evidence: [{ path: relative, line, excerpt: lines[line - 1].slice(0, 220) }] });
  }

  if (engine === 'cocos' || engine === 'unity') {
    const assetRoot = engine === 'cocos' ? 'code/assets/' : 'Assets/';
    const currentMeta = [...inventory.keys()].filter((relative) => relative.startsWith(assetRoot) && relative.endsWith('.meta'));
    const completeIndex = !listed.truncated && currentMeta.length <= LIMITS.metaFiles;
    resourceTruncated ||= !completeIndex;
    const textAssets = [...inventory.keys()].filter((relative) => changedSet.has(relative) && relative.startsWith(assetRoot) &&
      META_ASSET_EXT.has(path.posix.extname(relative).toLowerCase()) && !relative.endsWith('.meta'));
    if (!completeIndex) warnings.push('资源元数据索引超出扫描预算，未把缺少 .meta 或 UUID/GUID 当作已证实缺陷。');
    if (completeIndex && textAssets.length > LIMITS.resourceChecks) {
      resourceTruncated = true;
      warnings.push('变更资源超出配套元数据检查预算，未扫描部分不能判定为通过。');
    }
    for (const relative of completeIndex ? textAssets.slice(0, LIMITS.resourceChecks) : []) {
      signal?.throwIfAborted();
      if (verifiedFindings.length >= LIMITS.findings) break;
      if (inventory.has(`${relative}.meta`)) continue;
      const sourceFile = await read(relative);
      const excerpt = sourceFile?.content.split(/\r?\n/)[0]?.slice(0, 100) || '';
      if (!excerpt) continue;
      await finding(`${engine}-missing-meta`, relative, 'meta', `${path.posix.basename(relative)} 缺少资源元数据`,
        '资源文件应有同名 .meta 并随工程保留', `${relative}.meta 不存在`, 1, excerpt);
    }

    const removed = [...changes].filter(([relative, status]) => status === 'D' && relative.startsWith(assetRoot) && relative.endsWith('.meta'));
    const prior = new Map();
    for (const [relative] of removed.slice(0, LIMITS.metaFiles)) {
      signal?.throwIfAborted();
      const content = await oldMeta(root, previousHead || head, relative, signal);
      if (content) for (const identifier of metaIdentifiers(content, engine) || []) prior.set(identifier, relative);
    }
    if (prior.size && completeIndex && removed.length <= LIMITS.metaFiles) {
      let readableIndex = true; let indexBytes = 0;
      for (const relative of currentMeta) {
        signal?.throwIfAborted();
        const content = await read(relative);
        const identifiers = content && metaIdentifiers(content.content, engine);
        if (!identifiers) { readableIndex = false; break; }
        indexBytes += content.originalBytes;
        if (indexBytes > LIMITS.metaIndexBytes) { readableIndex = false; break; }
        for (const identifier of identifiers) prior.delete(identifier);
      }
      if (!readableIndex) {
        resourceTruncated = true;
        warnings.push('资源元数据有不可读取文件，未把 UUID/GUID 引用缺失当作已证实缺陷。');
      }
      const references = readableIndex ? [...inventory.keys()].filter((relative) => relative.startsWith(assetRoot) &&
        (engine === 'unity' ? /\.(?:unity|prefab|asset)$/.test(relative) : /\.(?:prefab|fire|anim)$/.test(relative))) : [];
      for (const relative of references.slice(0, LIMITS.referenceChecks)) {
        signal?.throwIfAborted();
        if (verifiedFindings.length >= LIMITS.findings) break;
        const sourceFile = await read(relative);
        if (!sourceFile) continue;
        const lines = sourceFile.content.slice(0, LIMITS.charsPerFile).split(/\r?\n/);
        for (const [index, text] of lines.entries()) {
          const refs = engine === 'unity' ? [...text.matchAll(/\bguid:\s*([0-9a-f]{32})\b/gi)]
            : [...text.matchAll(/"__uuid__"\s*:\s*"([0-9a-f-]{20,40})"/gi)];
          for (const match of refs) {
            const oldPath = prior.get(match[1].toLowerCase());
            if (!oldPath) continue;
            await finding(`${engine}-removed-${engine === 'unity' ? 'guid' : 'uuid'}`, relative, match[1].toLowerCase(),
              `${path.posix.basename(relative)} 引用了已删除资源`, '引用的资源标识应在当前工程元数据中存在',
              `${match[1]} 原属于已删除的 ${oldPath}，当前元数据未找到同一标识`, index + 1, match[0]);
          }
        }
      }
      if (references.length > LIMITS.referenceChecks) {
        resourceTruncated = true;
        warnings.push('资源引用文件超过预算，未覆盖的引用不作缺失判断。');
      }
    } else if (prior.size) warnings.push('资源元数据索引不完整，本次不对 UUID/GUID 引用下确定性结论。');
  }

  const candidates = [...inventory.keys()].filter((relative) => auditablePath(relative, engine) && SOURCE_EXT.has(path.posix.extname(relative).toLowerCase()) &&
    !relative.endsWith('.meta') && !included.has(relative));
  candidates.sort((left, right) => Number(changedSet.has(right)) - Number(changedSet.has(left)) ||
    score(right, terms) - score(left, terms) || left.localeCompare(right));
  let contentScans = 0;
  for (const relative of candidates) {
    signal?.throwIfAborted();
    if (files.length >= LIMITS.files || totalChars >= LIMITS.totalChars) break;
    if (!changedSet.has(relative) && score(relative, terms) === 0 && terms.length) {
      if (contentScans >= 120) continue;
      contentScans++;
      const sourceFile = await read(relative);
      const lower = sourceFile?.content.toLowerCase() || '';
      if (!terms.some((term) => lower.includes(term))) continue;
    }
    await include(relative);
  }
  const coverage = { engine, scannedPaths: inventory.size, changedPathCount: changes.size, sampledFiles: files.length,
    caseCount: Array.isArray(caseRows) ? caseRows.length : 0, contentScans, truncatedFiles,
    truncated: listed.truncated || resourceTruncated || truncatedPaths || truncatedFiles > 0 ||
      candidates.length + included.size > LIMITS.files || unlinkedFindings > 5,
    limits: { ...LIMITS } };
  if (unlinkedFindings > 5) warnings.push(`另有 ${unlinkedFindings - 5} 项资源异常未能唯一关联用例，已省略详细提示。`);
  if (coverage.truncated) warnings.push('代码巡检只读取了预算内的文件或片段，未覆盖的代码和资源不能判定为通过。');
  if (files.length === 0) warnings.push('没有可供本轮 AI 分析的相关源码；请检查用例关键词和代码源目录。');
  return { revision, changedPaths, files, verifiedFindings, warnings, coverage };
}
