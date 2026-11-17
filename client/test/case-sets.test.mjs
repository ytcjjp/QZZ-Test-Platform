import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import MindElixir from 'mind-elixir';

const filename = fileURLToPath(new URL('../src/CaseSetsPage.jsx', import.meta.url));
const compiled = await build({ entryPoints: [filename], bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, external: ['react', 'react-dom'], logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(filename), module, module.exports);
const { collectCaseRows, normalizeNodeStatuses, fetchCaseNodeStatuses, persistCaseNodeStatus, fitMindMap, zoomMindMap } = module.exports;
const node = (id, title, children = []) => ({ id, title, children });

test('lists executable case nodes once with original IDs, hierarchy and multiline fields', () => {
  const tree = node('root', '测试用例集', [
    node('main', '主流程', [node('case-a', '领取奖励', [node('a-pre', '前置条件：活动已开启。'), node('a-step', '执行步骤', [node('step-1', '进入奖励页面。'), node('step-2', '点击领取。')]), node('a-expected', '预期结果：奖励进入背包。')])]),
    node('ui', 'UI', [node('case-b', '领取奖励', [node('b-pre', '前置条件：未领取。'), node('b-step', '操作步骤：查看按钮。'), node('b-expected', '预期表现：显示领取按钮。')])]),
    node('affected', '受影响模块', [node('bag', '背包', [node('custom', '背包数量同步')])]),
  ]);
  const rows = collectCaseRows(tree);
  assert.deepEqual(rows.map(({ id }) => id), ['case-a', 'case-b', 'custom']);
  assert.equal(rows[0].steps, '进入奖励页面。\n点击领取。'); assert.equal(rows[0].expected, '奖励进入背包。');
  assert.equal(rows[0].path, '主流程'); assert.equal(rows[2].path, '受影响模块 / 背包');
  assert.equal(rows[0].title, rows[1].title, 'distinct cases with the same title are preserved');
  assert.equal(rows.some((row) => row.id === 'a-pre'), false);
  assert.deepEqual(collectCaseRows(node('empty', '空白用例集')), []);
  assert.deepEqual(collectCaseRows(node('empty', '空白用例集', [node('main', '主流程'), node('ui', 'UI')])), []);
  assert.deepEqual(collectCaseRows(node('root', '集合', [node('main', '主流程', [node('prefix', '前置条件变化时入口刷新')])])).map(({ id }) => id), ['prefix']);
  const multiline = collectCaseRows(node('root', '集合', [node('actual-case', '多行用例', [node('p', '前置条件：已开启\n已登录'), node('s', '执行步骤：进入页面\n点击领取'), node('e', '预期结果：奖励到账\n数量正确')])]));
  assert.equal(multiline.length, 1); assert.equal(multiline[0].id, 'actual-case');
  assert.equal(multiline[0].preconditions, '已开启\n已登录'); assert.equal(multiline[0].steps, '进入页面\n点击领取'); assert.equal(multiline[0].expected, '奖励到账\n数量正确');
});

function geometry(alignment = 'root') {
  const root = { offsetTop: 1980, offsetLeft: 0, offsetWidth: 200, offsetHeight: 40 };
  return {
    alignment, scaleVal: 1, scaleMin: 0.2, scaleMax: 2, currentNodes: [],
    container: { offsetWidth: 1000, offsetHeight: 600, getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }) },
    nodes: { offsetWidth: 20000, offsetHeight: 4000 }, map: { style: { transform: 'translate3d(0px, 0px, 0) scale(1)' }, querySelector: () => root },
    bus: { fire() {} }, scale: MindElixir.prototype.scale, scaleFit: MindElixir.prototype.scaleFit,
  };
}
function bounds(instance) {
  const [x, y] = [...instance.map.style.transform.matchAll(/(-?[\d.]+)px/g)].slice(0, 2).map((match) => Number(match[1]));
  const [originX, originY] = instance.map.style.transformOrigin.split(' ').map((value, index) => value.endsWith('%') ? parseFloat(value) / 100 * (index ? instance.nodes.offsetHeight : instance.nodes.offsetWidth) : parseFloat(value));
  const left = x + originX * (1 - instance.scaleVal); const top = y + originY * (1 - instance.scaleVal);
  return { left, top, right: left + instance.nodes.offsetWidth * instance.scaleVal, bottom: top + instance.nodes.offsetHeight * instance.scaleVal };
}

test('real MindElixir zoom stays on canvas after fitting a large graph and does not change origin', () => {
  const original = geometry(); original.scaleFit(); original.scale(0.2);
  assert.ok(bounds(original).right < 0, 'reproduces the default root-origin blank-canvas bug');
  const corrected = geometry(); assert.equal(fitMindMap(corrected), true);
  for (const delta of [0.1, 0.1, 0.5, -0.1, -0.1, 0.5, -0.1]) {
    assert.equal(zoomMindMap(corrected, delta), true);
    const actual = bounds(corrected);
    assert.equal(corrected.map.style.transformOrigin, '50% 50%');
    assert.ok(actual.right > 0 && actual.left < 1000 && actual.bottom > 0 && actual.top < 600);
    assert.ok(Math.abs((actual.left + actual.right) / 2 - 500) < 0.0001);
  }
  const fitted = geometry(); fitMindMap(fitted); const scale = fitted.scaleVal;
  zoomMindMap(fitted, -0.1); assert.equal(fitted.scaleVal, scale, 'zoom out below 20% must not unexpectedly enlarge a fitted graph');
  const transform = fitted.map.style.transform; fitted.container.offsetWidth = 0;
  assert.equal(fitMindMap(fitted), false); assert.equal(zoomMindMap(fitted, 0.1), false); assert.equal(fitted.map.style.transform, transform);
  fitted.container.offsetWidth = 1000; assert.equal(fitMindMap(fitted), true);
});

test('status API preserves node IDs, project scope and independent CAS revisions across refresh', async () => {
  const originalFetch = globalThis.fetch;
  const caseId = 'set/one'; const projectId = '项目 甲'; const id = 'case/node'; let stored = null;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'same-origin');
    if (options.method === 'PUT') {
      assert.equal(url, '/api/cases/set%2Fone/node-statuses/case%2Fnode');
      const body = JSON.parse(options.body); assert.equal(body.projectId, projectId);
      if (body.revision !== (stored?.revision || 0)) return Response.json({ message: '节点状态已更新', nodeStatus: stored }, { status: 409 });
      stored = { nodeId: id, status: body.status, revision: (stored?.revision || 0) + 1 };
      return Response.json({ caseId, projectId, caseRevision: 7, nodeStatus: stored });
    }
    assert.equal(url, `/api/cases/set%2Fone/node-statuses?projectId=${encodeURIComponent(projectId)}`);
    return Response.json({ caseId, projectId, caseRevision: 7, statuses: stored ? [stored] : [] });
  };
  try {
    assert.deepEqual(normalizeNodeStatuses((await fetchCaseNodeStatuses(caseId, projectId)).statuses), {});
    const saved = await persistCaseNodeStatus(caseId, projectId, id, '测试通过', 0);
    assert.equal(saved.caseRevision, 7); assert.equal(saved.nodeStatus.revision, 1);
    assert.equal(normalizeNodeStatuses((await fetchCaseNodeStatuses(caseId, projectId)).statuses)[id].status, '测试通过');
    await assert.rejects(persistCaseNodeStatus(caseId, projectId, id, '跳过', 0), (error) => error.status === 409 && error.nodeStatus.status === '测试通过');
    await persistCaseNodeStatus(caseId, projectId, id, '跳过', 1);
    assert.equal(normalizeNodeStatuses((await fetchCaseNodeStatuses(caseId, projectId)).statuses)[id].status, '跳过');
    assert.equal(calls.filter((call) => call.options.method === 'PUT').some((call) => JSON.parse(call.options.body).tree), false);
    assert.deepEqual(normalizeNodeStatuses([{ nodeId: id, status: '失败', revision: 2 }, { nodeId: 'bad', status: '待测试', revision: -1 }]), {});
  } finally { globalThis.fetch = originalFetch; }
});
