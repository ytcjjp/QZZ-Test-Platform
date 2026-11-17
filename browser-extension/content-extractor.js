(() => {
  const ROOTS = ['.docx-root-block', '[data-testid="docx-content"]', '[data-testid="doc-content"]', '.docx-content', '.docx-page-block', '.doc-content', '.doc-body', '.bear-web-x-container', '[role="document"]'];
  const OMIT = 'script,style,nav,aside,button,[role="toolbar"],[role="navigation"],[role="menu"],[aria-hidden="true"],.watermark,.watermark-wrapper,[class*="watermark"],.avatar,.docx-comment,.comment-panel';
  const BLOCKS = '[data-block-id],h1,h2,h3,h4,h5,h6,p,li,pre,table,[role="heading"],[role="table"],.docx-text-block,.text-block,.docx-table-block';
  const MAX_TEXT = 100000;
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const fault = (code) => Object.assign(new Error(code), { code });

  function createReader(environment = {}) {
    const doc = environment.document || document;
    const location = environment.location || globalThis.location;
    const style = environment.getComputedStyle || globalThis.getComputedStyle;
    const wait = environment.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = environment.now || Date.now;
    const fetcher = environment.fetch || globalThis.fetch;
    const images = new Map();
    const records = new Map();
    const identities = new WeakMap();
    const warnings = new Set();
    let sequence = 0; let textBudget = false; let unstableVirtualization = false; let localImageBytes = 0;

    function shown(element) {
      if (!element || element.closest(OMIT)) return false;
      for (let current = element; current && current !== doc.body; current = current.parentElement) {
        const css = style?.(current);
        if (current.hidden || css?.display === 'none' || css?.visibility === 'hidden') return false;
      }
      return true;
    }

    function checkAccess(root) {
      if (/\/login\b|\/accounts?\b|\/passport\b/.test(location.pathname || '') || /^(?:accounts|passport)\./.test(location.hostname || '')) throw fault('LOGIN_REQUIRED');
      const banners = [...doc.querySelectorAll('[role="alert"],[role="dialog"],.permission-denied,.access-denied,.login-panel,.error-state,.copy-forbidden,.copy-disabled')].filter(shown).map((node) => clean(node.textContent)).join('\n');
      if (/无(?:法访问|权(?:限)?访问|阅读权限)|没有(?:访问|阅读)权限|申请(?:访问|阅读)权限|禁止复制|不允许复制|无复制权限|permission denied|access denied|copying is disabled/i.test(banners) || root?.matches('[data-copy-disabled="true"],[data-can-copy="false"]') || root?.querySelector('[data-copy-disabled="true"],[data-can-copy="false"]')) throw fault('ACCESS_DENIED');
      if (/登录后(?:查看|访问)|登录飞书|sign in to (?:view|continue)/i.test(banners)) throw fault('LOGIN_REQUIRED');
      if (/网络(?:异常|错误)|网络连接失败|加载失败.*重试|network error|connection failed/i.test(banners)) throw fault('NETWORK_ERROR');
    }

    function findRoot() {
      checkAccess();
      for (const selector of ROOTS) {
        const candidates = [...doc.querySelectorAll(selector)].filter(shown);
        if (candidates.length) return candidates.sort((a, b) => b.querySelectorAll(BLOCKS).length - a.querySelectorAll(BLOCKS).length)[0];
      }
      return null;
    }

    function imageKey(image) {
      const owner = image.closest('[data-block-id]');
      if (owner) return `${owner.getAttribute('data-block-id')}:image:${[...owner.querySelectorAll('img')].indexOf(image)}`;
      return image.getAttribute('data-file-token') || image.getAttribute('data-image-id') || image.currentSrc || image.getAttribute('src') || `unloaded-${images.size}`;
    }

    async function recordImages(root) {
      for (const element of root.querySelectorAll('img')) {
        if (!shown(element)) continue;
        const key = imageKey(element);
        const existing = images.get(key);
        if (existing?.overBudget) continue;
        const src = element.currentSrc || element.getAttribute('src') || '';
        if (existing?.loaded && existing.originalSource === src) continue;
        const entry = existing || { id: `file-${images.size + 1}`, reference: `[file#${images.size + 1}]` };
        if (existing && existing.originalSource !== src) {
          localImageBytes = Math.max(0, localImageBytes - (existing.byteLength || 0));
          delete entry.data; delete entry.byteLength;
        }
        entry.loaded = element.complete !== false && element.naturalWidth !== 0 && Boolean(src);
        entry.src = src; entry.originalSource = src;
        if (!existing && images.size >= 64) { entry.loaded = false; entry.overBudget = true; images.set(key, entry); continue; }
        if (entry.loaded && src.startsWith('blob:')) {
          try {
            if (new URL(src).origin !== location.origin) throw new Error();
            const response = await fetcher(src, { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error();
            const chunks = []; let length = 0;
            const stream = response.body?.getReader(); if (!stream) throw new Error();
            try {
              while (true) {
                const { done, value: chunk } = await stream.read(); if (done) break;
                length += chunk.length;
                if (length + localImageBytes > 64 * 1024 * 1024) { await stream.cancel().catch(() => {}); throw new Error(); }
                chunks.push(chunk);
              }
            } finally { stream.releaseLock(); }
            const buffer = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
            if (!buffer.length) throw new Error();
            localImageBytes += buffer.length;
            entry.byteLength = buffer.length;
            let binary = ''; for (let start = 0; start < buffer.length; start += 32768) binary += String.fromCharCode(...buffer.subarray(start, start + 32768));
            entry.data = btoa(binary); delete entry.src;
          } catch { entry.loaded = false; }
        } else if (entry.loaded && src.startsWith('data:')) {
          const matched = src.match(/^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i);
          const byteLength = matched ? matched[1].length * 3 / 4 - (matched[1].endsWith('==') ? 2 : matched[1].endsWith('=') ? 1 : 0) : 0;
          if (matched && byteLength + localImageBytes <= 64 * 1024 * 1024) { entry.data = matched[1]; entry.byteLength = byteLength; localImageBytes += byteLength; delete entry.src; } else entry.loaded = false;
        }
        images.set(key, entry);
      }
    }

    function tableText(node) {
      const table = node.matches('table,[role="table"]') ? node : node.querySelector('table,[role="table"]');
      if (!table) return '';
      const rows = [...table.querySelectorAll('tr,[role="row"]')].filter(shown).map((row) => [...row.querySelectorAll('th,td,[role="cell"],[role="columnheader"]')].filter(shown).map((cell) => clean(cell.textContent).replace(/\|/g, '\\|').replace(/\n/g, ' / '))).filter((row) => row.length);
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      if (!table.querySelector('th,[role="columnheader"]')) rows.unshift(Array.from({ length: width }, (_, index) => `列${index + 1}`));
      const line = (row) => `| ${Array.from({ length: width }, (_, index) => row[index] || '').join(' | ')} |`;
      return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
    }

    function blockText(node) {
      if (node.matches('table,[role="table"],.docx-table-block')) return tableText(node);
      const clone = node.cloneNode(true);
      for (const omitted of clone.querySelectorAll(OMIT)) omitted.remove();
      for (const child of clone.querySelectorAll('[data-block-id],table,[role="table"]')) child.remove();
      const originals = [...node.querySelectorAll('img')].filter(shown);
      const copied = [...clone.querySelectorAll('img')];
      for (let index = 0; index < copied.length; index++) {
        const reference = images.get(imageKey(originals[index] || copied[index]))?.reference;
        copied[index].replaceWith(doc.createTextNode(reference || '[未读取图片]'));
      }
      for (const br of clone.querySelectorAll('br')) br.replaceWith(doc.createTextNode('\n'));
      let value = clean(clone.textContent);
      if (!value) return '';
      const headingNode = node.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') ? node : node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      const heading = headingNode && (/^H([1-6])$/.exec(headingNode.tagName)?.[1] || headingNode.getAttribute('aria-level') || 2);
      if (heading) value = `${'#'.repeat(Math.min(6, Number(heading) || 2))} ${value}`;
      else if (node.tagName === 'LI') value = `- ${value}`;
      else if (node.tagName === 'PRE') value = `\`\`\`\n${value}\n\`\`\``;
      return value;
    }

    async function snapshot(root) {
      checkAccess(root);
      await recordImages(root);
      const nodes = [...root.querySelectorAll(BLOCKS)].filter((node) => {
        if (!shown(node)) return false;
        const table = node.closest('table,[role="table"],.docx-table-block');
        if (table && table !== node) return false;
        if (node.matches('table,[role="table"]')) return !node.parentElement?.closest('.docx-table-block');
        const ancestor = node.parentElement?.closest('[data-block-id]');
        const semantic = node.parentElement?.closest(BLOCKS);
        return node.hasAttribute('data-block-id') || ((!ancestor || ancestor === root) && (!semantic || semantic === root));
      });
      if (!nodes.length && clean(root.textContent)) warnings.add('未识别稳定的正文段落结构，请补充原始文件核对内容。');
      for (const node of nodes) {
        const value = blockText(node);
        if (!value) continue;
        const ownerId = node.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id');
        const blockId = node.getAttribute('data-block-id') || node.getAttribute('data-node-id') || (node.matches('table,[role="table"]') && ownerId && `${ownerId}:table`);
        if (!identities.has(node)) identities.set(node, `node-${++sequence}`);
        const key = blockId ? `block:${blockId}` : identities.get(node);
        const prior = records.get(key);
        const size = [...records.values()].reduce((sum, entry) => sum + entry.text.length + 2, 0) - (prior?.text.length || 0) + value.length;
        if (size > MAX_TEXT) { textBudget = true; warnings.add('正文超过平台单份 10 万字范围，已保留目前读到的完整段落；请拆分或补充文件。'); break; }
        records.set(key, { text: value, stable: Boolean(blockId), node });
      }
      if (root.querySelector('canvas,iframe,embed,object,video,audio,[data-block-type="whiteboard"],.docx-board-block,.docx-diagram-block')) warnings.add('文档含画板、图表或其他嵌入内容，未将其视为已读取，请补充截图或原件。');
      if (root.querySelector('[data-collapsed="true"],.folded-block,button[aria-label*="展开"]')) warnings.add('文档存在折叠内容，未自动展开，请补充完整文档。');
      return nodes;
    }

    function scrollContainer(root) {
      for (let node = root; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 10 && node.clientHeight > 0) {
          const overflow = style?.(node)?.overflowY || '';
          if (/auto|scroll/.test(overflow) || node === doc.scrollingElement || node === doc.documentElement) return node;
        }
      }
      return doc.scrollingElement || doc.documentElement;
    }

    async function extractDocument(options = {}) {
      const started = now();
      const budget = Math.min(120000, Math.max(100, options.maxMs || 115000));
      let root;
      while (!(root = findRoot())) { if (now() - started > Math.min(20000, budget)) throw fault('UNSUPPORTED'); await wait(400); }
      const container = scrollContainer(root);
      const initialScroll = container.scrollTop || 0;
      container.scrollTo?.({ top: 0, behavior: 'instant' }); container.scrollTop = 0;
      await wait(400);
      let bottomStable = 0; let previousSignature = ''; let completed = false;
      try {
        for (let iteration = 0; iteration < 240 && now() - started < budget; iteration++) {
          const before = new Set(records.keys());
          const nodes = await snapshot(root);
          const changed = [...records.keys()].some((key) => !before.has(key));
          if ([...records.values()].some((entry) => !entry.stable && !entry.node.isConnected)) unstableVirtualization = true;
          const signature = `${container.scrollHeight}:${records.size}:${images.size}`;
          const bottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
          const loading = [...root.querySelectorAll('[aria-busy="true"],.loading,.docx-loading')].some(shown);
          bottomStable = bottom && !loading && signature === previousSignature && !changed ? bottomStable + 1 : 0;
          if (bottomStable >= 3) { completed = true; break; }
          if (textBudget) break;
          previousSignature = signature;
          const next = Math.min(Math.max(0, container.scrollHeight - container.clientHeight), (container.scrollTop || 0) + Math.max(200, container.clientHeight * 0.7));
          container.scrollTo?.({ top: next, behavior: 'instant' }); container.scrollTop = next;
          await wait(Math.min(1000, Math.max(100, options.scrollWaitMs || 650)));
          if (!root.isConnected) { root = findRoot(); if (!root) throw fault('UNSUPPORTED'); }
          if (!nodes.length && now() - started > 10000) throw fault('UNSUPPORTED');
        }
      } finally { container.scrollTo?.({ top: initialScroll, behavior: 'instant' }); container.scrollTop = initialScroll; }
      if (!completed) warnings.add('在读取时限内未能确认文档底部已完整加载，请补充文件核对剩余内容。');
      if (unstableVirtualization) warnings.add('页面采用虚拟滚动且部分段落无稳定标识，内容可能重复或遗漏，请补充原件核对。');
      const expected = Number(root.getAttribute('data-total-block-count') || root.getAttribute('data-block-count'));
      if (expected > records.size) warnings.add(`页面标记共 ${expected} 个正文块，本次只读到 ${records.size} 个，请补充原件。`);
      const imageEntries = [...images.values()];
      if (imageEntries.some((image) => !image.loaded)) warnings.add('部分图片尚未加载或 Blob 图片无法读取，请补充图片附件。');
      const text = [...records.values()].map((entry) => entry.text).join('\n\n');
      if (!text && !imageEntries.some((image) => image.loaded)) throw fault('UNSUPPORTED');
      const titleElement = doc.querySelector('[data-testid="doc-title"],.docx-title,.doc-title,.doc-title-input');
      const title = clean(titleElement?.value || titleElement?.textContent || doc.title.replace(/\s*[-–|]\s*(?:飞书云文档|飞书|Lark).*$/, '')).slice(0, 200) || '飞书文档';
      return { title, text, url: location.href, loadedBlocks: records.size, imageCount: imageEntries.length, images: imageEntries, completeness: warnings.size ? 'partial' : 'complete', warnings: [...warnings] };
    }
    return { findRoot, snapshot, extractDocument, records, images };
  }
  globalThis.QzzFeishuContent = { createReader, extractDocument: (options) => createReader().extractDocument(options) };
})();
