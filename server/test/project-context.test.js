import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectProjectContext } from '../project-context.js';

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qzz-source-context-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  async function write(relative, content) { const filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content); return filename; }
  try { await run({ directory, root, write }); }
  finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('context collects filename then content evidence only from allowed source roots and excludes credentials/generated files', async () => fixture(async ({ root, write }) => {
  await write('code/assets/Script/activity/RewardPanel.ts', 'export class RewardPanel { claim() { return "奖励领取"; } }');
  await write('src/Common.ts', 'export const hint = "活动规则：领奖后更新背包";');
  for (const name of ['code/assets/Script/.hidden/Reward.ts', 'src/node_modules/Reward.ts', 'src/cache/Reward.ts', 'src/build/Reward.ts', 'src/.env.json', 'src/password.json', 'src/AppSecret.ts', 'src/Credentials.md', 'src/RewardToken.txt', 'server/Reward.ts', 'scripts/Reward.js']) await write(name, 'DO_NOT_INCLUDE activity reward 背包');
  await write('src/RewardConfig.json', '{"apiKey":"DO_NOT_INCLUDE-key"}');
  const context = await collectProjectContext(root, [{ text: '活动奖励领取后更新背包。' }]);
  assert.equal(context.projectName, '点点消');
  assert.deepEqual(context.files.map((file) => file.path), ['code/assets/Script/activity/RewardPanel.ts', 'src/Common.ts']);
  assert.ok(!JSON.stringify(context.files).includes('DO_NOT_INCLUDE'));
  assert.ok(!context.candidatePaths.some((name) => /hidden|node_modules|cache|build|password|secret|credential/i.test(name)));
  assert.ok(context.keywords.includes('奖励')); assert.ok(context.keywords.includes('activity'));
  assert.ok(context.files.every((file) => !path.isAbsolute(file.path)));
}));

test('context caps individual and total snippets and reports truncation without claiming complete reads', async () => fixture(async ({ root, write }) => {
  for (let index = 0; index < 15; index++) await write(`src/ActivityReward${String(index).padStart(2, '0')}.ts`, 'reward活动'.repeat(6000));
  const context = await collectProjectContext(root, [{ text: 'activity reward 活动奖励' }]);
  assert.ok(context.files.length <= 12);
  assert.ok(context.files.every((file) => file.content.length <= 16000 && file.truncated));
  assert.equal(context.totalChars, 100000);
  assert.equal(context.files.reduce((sum, file) => sum + file.content.length, 0), 100000);
  assert.equal(context.truncated, true); assert.ok(context.warnings.some((warning) => /片段/.test(warning)));
  assert.ok(context.candidatePaths.length > 0);
  await fs.rm(path.join(root, 'src'), { recursive: true });
  for (let index = 0; index < 20; index++) await write(`src/Reward${index}.js`, 'export const reward = 1;');
  assert.equal((await collectProjectContext(root, [{ text: 'reward' }])).files.length, 12);
}));

test('context rejects symlink and realpath escapes without reading external files', async () => fixture(async ({ root, directory, write }) => {
  await write('src/Reward.ts', 'export const reward = 1;');
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'RewardOutside.ts'), 'OUTSIDE_PRIVATE reward');
  await fs.symlink(outside, path.join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const context = await collectProjectContext(root, [{ text: 'reward' }]);
  assert.equal(context.files.length, 1);
  assert.ok(!JSON.stringify(context).includes('OUTSIDE_PRIVATE'));
  assert.ok(!context.candidatePaths.some((name) => name.includes('linked')));
  const other = path.join(directory, 'linked-project');
  await fs.symlink(root, other, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectProjectContext(other, [{ text: 'reward' }]), /不可读取/);
}));

test('unrelated, empty and absent source contexts expose candidate paths as unevaluated evidence and allow cancellation', async () => fixture(async ({ root, write }) => {
  await write('src/Other.ts', 'export const unrelated = 42;');
  await write('src/ActivityReward.ts', 'export const activityReward = "领取活动奖励后进入背包";');
  const unrelated = await collectProjectContext(root, [{ text: '公会庆典联赛排名。' }]);
  assert.deepEqual(unrelated.files, []); assert.deepEqual(unrelated.candidatePaths, ['src/ActivityReward.ts', 'src/Other.ts']);
  assert.ok(!unrelated.keywords.includes('activity')); assert.ok(!unrelated.keywords.includes('reward'));
  assert.ok(unrelated.warnings.some((warning) => /不代表/.test(warning)));
  const empty = await collectProjectContext(root, []);
  assert.deepEqual(empty.files, []); assert.ok(empty.warnings.some((warning) => /未提供/.test(warning)));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collectProjectContext(root, [{ text: 'reward' }], { signal: controller.signal }), (error) => error.name === 'AbortError');
  await fs.rm(path.join(root, 'src'), { recursive: true });
  const absent = await collectProjectContext(root, [{ text: 'reward' }]);
  assert.deepEqual(absent.files, []); assert.ok(absent.warnings.some((warning) => /白名单/.test(warning)));
}));
