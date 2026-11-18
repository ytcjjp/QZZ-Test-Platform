import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDroppedItems, collectSelectedItems, uploadFolderPaths } from '../src/cloud-upload.js';

function fileEntry(name) {
  return { name, isFile: true, file: (resolve) => resolve({ name }) };
}

function directoryEntry(name, children) {
  let offset = 0;
  return {
    name, isDirectory: true,
    createReader: () => ({ readEntries: (resolve) => {
      const batch = children.slice(offset, offset + 2);
      offset += batch.length;
      resolve(batch);
    } }),
  };
}

test('folder drops read every directory batch, nested file and empty folder', async () => {
  const root = directoryEntry('工具包', [
    fileEntry('a.txt'), fileEntry('b.txt'), directoryEntry('安装包', [fileEntry('c.exe')]), directoryEntry('空目录', []),
  ]);
  const dataTransfer = { items: [{ kind: 'file', webkitGetAsEntry: () => root }], files: [] };
  const items = await collectDroppedItems(dataTransfer);
  assert.deepEqual(items.folders, ['工具包', '工具包/安装包', '工具包/空目录']);
  assert.deepEqual(items.files.map(({ relativePath }) => relativePath), ['工具包/a.txt', '工具包/b.txt', '工具包/安装包/c.exe']);
  assert.deepEqual(uploadFolderPaths(items), ['工具包', '工具包/安装包', '工具包/空目录']);
});

test('multi-select and folder selection retain every file and relative directory', async () => {
  const files = [{ name: 'a.txt' }, { name: 'b.txt' }, { name: 'c.txt', webkitRelativePath: '导入/子目录/c.txt' }];
  const items = collectSelectedItems(files);
  assert.deepEqual(items.files.map(({ relativePath }) => relativePath), ['a.txt', 'b.txt', '导入/子目录/c.txt']);
  assert.deepEqual(uploadFolderPaths(items), ['导入', '导入/子目录']);
  const fallback = await collectDroppedItems({ files, items: [] });
  assert.equal(fallback.files.length, 3);
});
