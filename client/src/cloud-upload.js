function fromFiles(files) {
  return {
    folders: [],
    files: Array.from(files || [], (file) => ({ file, relativePath: file.webkitRelativePath || file.name })),
  };
}

async function visitEntry(entry, parent, result) {
  const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    result.folders.push(relativePath);
    const reader = entry.createReader();
    for (;;) {
      const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!children.length) break;
      for (const child of children) await visitEntry(child, relativePath, result);
    }
  } else if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    result.files.push({ file, relativePath });
  }
}

export async function collectDroppedItems(dataTransfer) {
  // Capture entries synchronously: DataTransferItemList is cleared after the drop event returns.
  const entries = Array.from(dataTransfer.items || [], (item) =>
    item.kind === 'file' ? item.webkitGetAsEntry?.() : null).filter(Boolean);
  if (!entries.length) return fromFiles(dataTransfer.files);
  const result = { files: [], folders: [] };
  for (const entry of entries) await visitEntry(entry, '', result);
  return result;
}

export function collectSelectedItems(files) {
  return fromFiles(files);
}

export function uploadFolderPaths(items) {
  const paths = new Set();
  for (const path of [
    ...items.folders,
    ...items.files.map(({ relativePath }) => relativePath.split('/').slice(0, -1).join('/')),
  ]) {
    const segments = path.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index += 1) paths.add(segments.slice(0, index).join('/'));
  }
  return [...paths].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
}
