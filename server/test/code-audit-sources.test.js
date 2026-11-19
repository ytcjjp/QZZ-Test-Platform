import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inspectCodeSource, validateCodeSourceSpec, withCodeSourceLock } from '../code-audit-sources.js';

const id = '11111111-2222-4333-8444-555555555555';

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-audit-source-'));
  const root = path.join(directory, 'game');
  const dataDir = path.join(directory, 'data');
  await fs.mkdir(root);
  await fs.mkdir(dataDir);
  async function write(name, content) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  }
  const source = { id, kind: 'local', label: '甜点项目代码', location: root };
  try { await callback({ directory, root, dataDir, source, write }); }
  finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('source specs reject unsafe local paths and remote URLs', async () => fixture(async ({ root, dataDir, directory, source }) => {
  assert.deepEqual(validateCodeSourceSpec(source), source);
  for (const location of ['relative/game', path.parse(root).root, dataDir, path.join(dataDir, 'code-audit-repos')]) {
    await assert.rejects(inspectCodeSource({ ...source, location }, { dataDir, caseRows: [] }), /目录|路径|数据/);
  }
  const alias = path.join(directory, 'alias');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCodeSource({ ...source, location: alias }, { dataDir, caseRows: [] }), /链接|目录|路径/);
  const privateRoot = path.join(directory, '.ssh');
  await fs.mkdir(privateRoot);
  await assert.rejects(inspectCodeSource({ ...source, location: privateRoot }, { dataDir, caseRows: [] }), /敏感目录/);
  await assert.rejects(inspectCodeSource({ ...source, location: directory }, { dataDir, caseRows: [] }), /数据|敏感目录/);
  await assert.rejects(inspectCodeSource({ ...source, location: path.resolve('server', '..') }, { dataDir, caseRows: [] }), /平台|敏感目录/);
  assert.throws(() => validateCodeSourceSpec({ ...source, id: '../escape' }), /标识/);
  const remote = (location) => ({ id, kind: 'git', label: '远端仓库', location });
  assert.equal(validateCodeSourceSpec(remote('https://github.com/example/project.git')).location,
    'https://github.com/example/project.git');
  for (const url of ['http://github.com/a/b', 'https://user:pass@github.com/a/b',
    'https://github.com:444/a/b', 'https://github.com/a/b?token=abc', 'https://github.com/a/b#frag',
    'https://127.0.0.1/a/b', 'https://github.com.evil.test/a/b', 'https://github.com/%2e%2e/b',
    'file:///tmp/repo', 'git@github.com:a/b.git']) {
    assert.throws(() => validateCodeSourceSpec(remote(url)), /仓库|地址|主机/);
  }
}));

test('a linked managed repository is rejected before any remote request', async () => fixture(async ({ root, dataDir }) => {
  const managed = path.join(dataDir, 'code-audit-repos');
  await fs.mkdir(managed);
  await fs.symlink(root, path.join(managed, id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCodeSource({ id, kind: 'git', label: '远端仓库',
    location: 'https://github.com/example/project.git' }, { dataDir, caseRows: [] }), /隔离仓库目录无效/);
}));

test('a linked repository parent cannot redirect clones outside platform data', async () => fixture(async ({ root, dataDir }) => {
  await fs.symlink(root, path.join(dataDir, 'code-audit-repos'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspectCodeSource({ id, kind: 'git', label: '远端仓库',
    location: 'https://github.com/example/project.git' }, { dataDir, caseRows: [] }), /隔离仓库管理目录无效/);
}));

test('same-source remote tasks serialize, including cancellation while queued', async () => {
  let releaseFirst;
  const firstWait = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = [];
  const first = withCodeSourceLock('same-remote', async () => { entered.push('first'); await firstWait; });
  const controller = new AbortController();
  const cancelled = withCodeSourceLock('same-remote', async () => { entered.push('cancelled'); }, controller.signal);
  const third = withCodeSourceLock('same-remote', async () => { entered.push('third'); });
  const independent = withCodeSourceLock('other-remote', async () => { entered.push('independent'); });
  await independent;
  controller.abort();
  await assert.rejects(cancelled, (error) => error.name === 'AbortError');
  assert.deepEqual(entered, ['first', 'independent']);
  releaseFirst();
  await Promise.all([first, third]);
  assert.deepEqual(entered, ['first', 'independent', 'third']);
});

test('local git scans matching files and reports HEAD changes plus uncommitted edits without modifying the repository', async () => fixture(async ({ root, dataDir, source, write }) => {
  git(root, 'init', '-q');
  await write('src/EventPanel.ts', 'export const panel = "旧活动";\n');
  await write('src/Other.ts', 'export const other = true;\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
  const first = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'c1', title: '活动面板', steps: '检查面板', expected: '显示活动' }] });
  assert.ok(first.revision);
  assert.ok(first.files.some((file) => file.path === 'src/EventPanel.ts'));
  await write('src/EventPanel.ts', 'export const panel = "新活动";\n');
  const second = await inspectCodeSource(source, { dataDir, previousRevision: first.revision,
    caseRows: [{ id: 'c1', title: '活动面板', expected: '显示活动' }] });
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(second.changedPaths, ['src/EventPanel.ts']);
  assert.ok(second.files.some((file) => file.content.includes('新活动')));
  assert.equal(git(root, 'status', '--porcelain').split('\n').filter(Boolean).length, 1);
  git(root, 'add', 'src/EventPanel.ts');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'update');
  const committed = await inspectCodeSource(source, { dataDir, previousRevision: first.revision, caseRows: [] });
  assert.deepEqual(committed.changedPaths, ['src/EventPanel.ts']);
  assert.equal(git(root, 'status', '--porcelain'), '');
}));

test('source scan excludes secrets, links and generated directories, and reports truncated coverage', async () => fixture(async ({ root, dataDir, source, directory, write }) => {
  await write('src/Feature.ts', 'export const activity = 1;\n');
  await write('src/password.ts', 'SECRET_1');
  await write('src/key.ts', 'const apiKey = "SECRET_2";');
  await write('node_modules/Activity.ts', 'SECRET_3');
  await write('.codex/Activity.ts', 'SECRET_4');
  await write('src/LargeActivity.ts', 'activity'.repeat(8000));
  const outside = path.join(directory, 'private.ts');
  await fs.writeFile(outside, 'SECRET_5');
  try { await fs.symlink(outside, path.join(root, 'src', 'LinkedActivity.ts')); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  const result = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'c1', title: 'Activity' }] });
  assert.ok(result.files.some((file) => file.path === 'src/Feature.ts'));
  assert.ok(result.files.some((file) => file.path === 'src/LargeActivity.ts' && file.truncated));
  assert.ok(!JSON.stringify(result).includes('SECRET_'));
  assert.ok(result.coverage.truncated);
  assert.ok(result.warnings.some((warning) => /片段|覆盖/.test(warning)));
}));

test('plain local folders change revision after edits without claiming a Git commit diff', async () => fixture(async ({ dataDir, source, write }) => {
  await write('src/Event.ts', 'export const event = 1;\n');
  const first = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'c1', title: 'Event' }] });
  await write('src/Event.ts', 'export const event = 1234;\n');
  const second = await inspectCodeSource(source, { dataDir, previousRevision: first.revision,
    caseRows: [{ id: 'c1', title: 'Event' }] });
  assert.notEqual(first.revision, second.revision);
  assert.deepEqual(second.changedPaths, ['src/Event.ts']);
  assert.ok(second.warnings.some((warning) => /不是可读取的 Git/.test(warning)));
}));

test('case terms can select relevant source content even when its filename does not match', async () => fixture(async ({ root, dataDir, source, write }) => {
  git(root, 'init', '-q');
  await write('src/Alpha.ts', 'export const unrelated = 1;\n');
  await write('src/Deep.ts', 'export const description = "活动奖励状态";\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
  const first = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'reward', title: '活动奖励' }] });
  const result = await inspectCodeSource(source, { dataDir, previousRevision: first.revision,
    caseRows: [{ id: 'reward', title: '活动奖励' }] });
  assert.ok(result.files.some((file) => file.path === 'src/Deep.ts'));
  assert.ok(result.coverage.contentScans >= 1);
}));

test('Cocos textual assets without a companion .meta produce stable evidence-backed findings; paired assets do not', async () => fixture(async ({ root, dataDir, source, write }) => {
  await write('code/project.json', JSON.stringify({ engine: 'cocos-creator-js', version: '2.4.12' }));
  await write('code/assets/Event/NewView.prefab', '[{"__type__":"cc.Node","_name":"Root"}]\n');
  await write('code/assets/Event/Ready.prefab', '[{"__type__":"cc.Node","_name":"Ready"}]\n');
  await write('code/assets/Event/Ready.prefab.meta', JSON.stringify({ uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
  const first = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'ui', title: '活动资源 UI' }] });
  const finding = first.verifiedFindings.find((item) => item.rule === 'cocos-missing-meta');
  assert.ok(finding);
  assert.equal(finding.evidence[0].path, 'code/assets/Event/NewView.prefab');
  assert.equal(finding.evidence[0].line, 1);
  assert.ok(first.files.some((file) => file.path === finding.evidence[0].path));
  assert.ok(!first.verifiedFindings.some((item) => item.evidence[0].path.endsWith('Ready.prefab')));
  await write('code/assets/Event/NewView.prefab', '[{"__type__":"cc.Node","_name":"ChangedRoot"}]\n');
  const second = await inspectCodeSource(source, { dataDir, previousRevision: first.revision,
    caseRows: [{ id: 'ui', title: '活动资源 UI' }] });
  assert.equal(second.verifiedFindings.find((item) => item.rule === 'cocos-missing-meta')?.id, finding.id);
  const unrelated = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'other', title: '登录校验' }] });
  assert.ok(!unrelated.verifiedFindings.some((item) => item.rule === 'cocos-missing-meta'));
  assert.ok(unrelated.warnings.some((warning) => /未能唯一关联/.test(warning)));
}));

test('Unity GUID reference is reported only when a previously indexed GUID was removed and remains unresolved', async () => fixture(async ({ root, dataDir, source, write }) => {
  git(root, 'init', '-q');
  await write('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.0f1\n');
  await write('Assets/Icon.png', Buffer.from([137, 80, 78, 71]));
  await write('Assets/Icon.png.meta', 'fileFormatVersion: 2\nguid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
  await write('Assets/Scene.unity', '--- !u!1 &1\nm_Icon: {fileID: 1, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}\n');
  await write('Assets/Scene.unity.meta', 'fileFormatVersion: 2\nguid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
  const first = await inspectCodeSource(source, { dataDir, caseRows: [{ id: 'scene', title: 'Scene Icon' }] });
  assert.ok(!first.verifiedFindings.some((item) => item.rule === 'unity-removed-guid'));
  await fs.rm(path.join(root, 'Assets/Icon.png'));
  await fs.rm(path.join(root, 'Assets/Icon.png.meta'));
  const second = await inspectCodeSource(source, { dataDir, previousRevision: first.revision,
    caseRows: [{ id: 'scene', title: 'Scene Icon' }] });
  const finding = second.verifiedFindings.find((item) => item.rule === 'unity-removed-guid');
  assert.ok(finding);
  assert.equal(finding.evidence[0].path, 'Assets/Scene.unity');
  assert.equal(finding.evidence[0].line, 2);
  assert.equal(finding.caseId, 'scene');
  assert.ok(second.files.some((file) => file.path === 'Assets/Scene.unity'));
}));

test('an already-aborted scan never reads the source', async () => fixture(async ({ source, dataDir }) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectCodeSource(source, { dataDir, signal: controller.signal, caseRows: [] }),
    (error) => error.name === 'AbortError');
}));
