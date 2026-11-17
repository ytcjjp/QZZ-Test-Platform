import { BridgeError, LIMITS, documentURL, platformPort, prepareImage, publicError } from './shared.js';

export class FeishuBridge {
  constructor({ chrome, WebSocket, fetcher = fetch, imageOptions = {}, timers = globalThis }) {
    this.chrome = chrome; this.WebSocket = WebSocket; this.fetcher = fetcher; this.imageOptions = imageOptions; this.timers = timers;
    this.socket = null; this.config = { port: 3210, token: '', enabled: false }; this.jobs = new Map();
    this.status = { state: 'unpaired', port: 3210, active: 0, message: '请在平台生成配对码，再连接此 Chrome。' };
    this.generation = 0; this.retry = 0;
  }

  async initialize() {
    await this.chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    const stored = (await this.chrome.storage.local.get('qzzFeishuBridge')).qzzFeishuBridge;
    try {
      if (stored) this.config = { port: platformPort(stored.port), token: typeof stored.token === 'string' ? stored.token : '', enabled: stored.enabled === true };
    } catch { /* Invalid local configuration starts unpaired. */ }
    this.status.port = this.config.port;
    await this.chrome.alarms.create('qzz-feishu-reconnect', { periodInMinutes: 0.5 });
    if (this.config.enabled && this.config.token) this.connect();
    else if (this.config.token) this.update('disconnected', '已配对，点击「重新连接」恢复连接。');
    return this;
  }

  update(state, message) {
    this.status = { state, message, port: this.config.port, active: this.jobs.size };
    this.chrome.runtime.sendMessage({ type: 'bridgeStatus', status: this.status }).catch(() => {});
    this.chrome.action?.setBadgeText({ text: state === 'ready' ? '✓' : state === 'reading' ? String(this.jobs.size) : '' }).catch(() => {});
  }

  async persist() {
    const config = { ...this.config };
    const queued = (this.storageQueue || Promise.resolve()).catch(() => {}).then(() => this.chrome.storage.local.set({ qzzFeishuBridge: config }));
    this.storageQueue = queued; await queued;
  }
  send(value) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value)); }

  clearConnection() {
    this.generation += 1;
    this.authenticated = false;
    this.timers.clearTimeout(this.reconnectTimer); this.timers.clearInterval(this.heartbeat); this.timers.clearTimeout(this.authTimer);
    const socket = this.socket; this.socket = null; socket?.close();
    for (const job of this.jobs.values()) job.controller.abort();
    this.pairing?.reject(new BridgeError('CONNECTION_FAILED')); this.pairing = null;
  }

  async pair(port, code) {
    port = platformPort(port);
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-F0-9]{12}$/.test(code)) throw new BridgeError('PAIRING_INVALID');
    this.clearConnection(); this.config = { port, token: '', enabled: true }; await this.persist();
    return new Promise((resolve, reject) => { this.pairing = { code, resolve, reject }; this.connect(); });
  }

  async disconnect() {
    this.config.enabled = false; this.clearConnection(); await this.persist();
    this.update('disconnected', '已断开。配对信息保留在此 Chrome，可重新连接。');
  }

  async reconnect() {
    if (!this.config.token) throw new BridgeError('AUTH_REQUIRED');
    this.config.enabled = true; await this.persist(); this.connect();
  }

  connect() {
    if (!this.config.enabled || this.socket?.readyState === 0 || this.socket?.readyState === 1) return;
    const generation = ++this.generation;
    this.update('connecting', '正在连接本机平台…');
    let socket;
    try { socket = new this.WebSocket(`ws://127.0.0.1:${this.config.port}/api/feishu-browser/events`); }
    catch { this.failedConnection(generation); return; }
    this.socket = socket;
    this.authTimer = this.timers.setTimeout(() => { if (generation === this.generation) socket.close(); }, 10000);
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.send(this.pairing ? { type: 'pair', code: this.pairing.code, client: { name: 'QZZ Feishu Browser', version: '1.0.0' } } : { type: 'auth', token: this.config.token });
      this.heartbeat = this.timers.setInterval(() => this.send({ type: 'ping' }), 20000);
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation || typeof event.data !== 'string' || event.data.length > 65536) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      void this.onServer(message, generation).catch(() => { if (generation === this.generation) { this.update('error', '平台连接异常，请重新配对。'); socket.close(); } });
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.socket = null; this.timers.clearInterval(this.heartbeat); this.timers.clearTimeout(this.authTimer);
      this.authenticated = false;
      for (const job of this.jobs.values()) job.controller.abort();
      this.failedConnection(generation);
    };
  }

  failedConnection(generation) {
    this.pairing?.reject(new BridgeError('CONNECTION_FAILED')); this.pairing = null;
    if (!this.config.enabled || generation !== this.generation) return;
    if (!this.config.token) { this.config.enabled = false; void this.persist().catch(() => {}); this.update('error', new BridgeError('CONNECTION_FAILED').message); return; }
    this.update('connecting', '无法连接本机平台，将自动重试；请确认平台已启动。');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(5, this.retry++));
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  async onServer(message, generation = this.generation) {
    if (generation !== this.generation || !message || typeof message !== 'object') return;
    if (message.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (message.type === 'pong') return;
    if (message.type === 'paired' || message.type === 'ready') {
      if (message.type === 'paired') {
        if (typeof message.token !== 'string' || message.token.length < 20 || message.token.length > 1024 || !this.pairing) throw new BridgeError('PROTOCOL_ERROR');
        const pairing = this.pairing;
        this.config.token = message.token; await this.persist();
        if (generation !== this.generation || pairing !== this.pairing) return;
        pairing.resolve({ ok: true }); this.pairing = null;
      }
      this.timers.clearTimeout(this.authTimer); this.retry = 0; this.authenticated = true;
      this.update('ready', '已连接。可在平台中粘贴飞书文档地址导入。'); return;
    }
    if (message.type === 'error') {
      const error = new BridgeError(message.code);
      this.pairing?.reject(error); this.pairing = null;
      if (['PAIRING_INVALID', 'AUTH_INVALID', 'AUTH_REQUIRED', 'PROTOCOL_ERROR'].includes(message.code)) {
        this.config.enabled = false;
        if (message.code === 'AUTH_INVALID') this.config.token = '';
        await this.persist(); if (generation === this.generation) this.update('error', error.message);
      }
      return;
    }
    if (message.type === 'cancel') { this.jobs.get(message.taskId)?.controller.abort(); return; }
    if (message.type === 'import' && this.authenticated) void this.runJob(message);
  }

  waitForTab(tabId, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.chrome.tabs.onUpdated.removeListener(updated); this.chrome.tabs.onRemoved.removeListener(removed); signal.removeEventListener('abort', aborted); this.timers.clearTimeout(timer); };
      const done = (error) => { cleanup(); error ? reject(error) : resolve(); };
      const updated = (id, change) => { if (id === tabId && change.status === 'complete') done(); };
      const removed = (id) => { if (id === tabId) done(new BridgeError('TAB_CLOSED')); };
      const aborted = () => done(new BridgeError('CANCELLED'));
      const timer = this.timers.setTimeout(() => done(new BridgeError('TIMEOUT')), 25000);
      this.chrome.tabs.onUpdated.addListener(updated); this.chrome.tabs.onRemoved.addListener(removed); signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else this.chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(() => done(new BridgeError('TAB_CLOSED')));
    });
  }

  async runJob(message) {
    const { taskId } = message;
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(taskId) || this.jobs.has(taskId)) return;
    if (this.jobs.size >= 2) { this.send({ type: 'result', taskId, ok: false, error: publicError(new BridgeError('TIMEOUT')) }); return; }
    const generation = this.generation;
    const current = () => generation === this.generation && this.authenticated;
    const job = { controller: new AbortController(), tabId: null, timedOut: false, closing: false, tabClosed: false };
    this.jobs.set(taskId, job); this.update('reading', '正在后台读取飞书文档…');
    const timeout = this.timers.setTimeout(() => { job.timedOut = true; job.controller.abort(); }, LIMITS.jobMs);
    const closeTab = () => { if (job.tabId != null) { job.closing = true; void this.chrome.tabs.remove(job.tabId).catch(() => {}); } };
    const tabRemoved = (id) => { if (id === job.tabId && !job.closing) { job.tabClosed = true; job.controller.abort(); } };
    this.chrome.tabs.onRemoved.addListener(tabRemoved);
    job.controller.signal.addEventListener('abort', closeTab, { once: true });
    try {
      const requested = documentURL(message.url);
      const tab = await this.chrome.tabs.create({ url: requested.url, active: false }); job.tabId = tab.id;
      if (job.controller.signal.aborted) throw new BridgeError('CANCELLED');
      await this.waitForTab(tab.id, job.controller.signal);
      const loaded = await this.chrome.tabs.get(tab.id);
      if (/\/login\b|\/accounts?\b|\/passport\b/.test(new URL(loaded.url).pathname) || /^(?:accounts|passport)\./.test(new URL(loaded.url).hostname)) throw new BridgeError('LOGIN_REQUIRED');
      if (documentURL(loaded.url).family !== requested.family) throw new BridgeError('UNSUPPORTED');
      await this.chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-extractor.js'], world: 'ISOLATED' });
      const results = await this.chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: (options) => globalThis.QzzFeishuContent.extractDocument(options).catch((error) => ({ error: { code: error.code || 'UNSUPPORTED' } })), args: [{ maxMs: 115000 }] });
      const extracted = results[0]?.result;
      if (job.controller.signal.aborted) throw new BridgeError(job.timedOut ? 'TIMEOUT' : 'CANCELLED');
      if (!extracted || extracted.error) throw new BridgeError(extracted?.error?.code || 'UNSUPPORTED');
      const final = documentURL(extracted.url);
      if (final.family !== requested.family || typeof extracted.text !== 'string' || extracted.text.length > LIMITS.text) throw new BridgeError('UNSUPPORTED');
      const warnings = [...new Set((extracted.warnings || []).filter((item) => typeof item === 'string').map((item) => item.slice(0, 1000)))];
      const images = []; let usedBytes = 0;
      const entries = Array.isArray(extracted.images) ? extracted.images : [];
      for (let index = 0; index < Math.min(entries.length, LIMITS.images); index++) {
        if (job.controller.signal.aborted) throw new BridgeError(job.timedOut ? 'TIMEOUT' : 'CANCELLED');
        if (!entries[index].loaded) { warnings.push(`[file#${index + 1}] 未加载，未视为已读取；请补充图片。`); continue; }
        try {
          const prepared = await prepareImage(entries[index], LIMITS.imageBytes - usedBytes, { fetcher: this.fetcher, ...this.imageOptions, signal: AbortSignal.any([job.controller.signal, AbortSignal.timeout(15000)]) });
          images.push({ ...prepared.image, name: `file-${index + 1}.${prepared.image.mimeType.split('/')[1]}` }); usedBytes += prepared.bytes;
          if (prepared.animated) warnings.push(`[file#${index + 1}] 为动图，仅导入可见首帧；动画过程请补充原件。`);
        } catch { warnings.push(`[file#${index + 1}] 无法正常下载或校验，未读取图片内容；请补充附件。`); }
      }
      if (entries.length > LIMITS.images) warnings.push(`文档含 ${entries.length} 张图片，本次图片输入最多 64 张，剩余图片请补充或拆分导入。`);
      if (usedBytes >= LIMITS.imageBytes) warnings.push('本次图片达到 64 MiB 输入预算，请补充未导入的图片。');
      if (extracted.completeness !== 'complete' && !warnings.length) warnings.push('页面未确认完整读取，请补充原始文档核对。');
      if (!extracted.text.trim() && !images.length) throw new BridgeError('UNSUPPORTED');
      if (job.controller.signal.aborted) throw new BridgeError(job.timedOut ? 'TIMEOUT' : 'CANCELLED');
      if (current()) {
        this.send({ type: 'result', taskId, ok: true, document: { url: final.url, title: String(extracted.title || '飞书文档').slice(0, 200), text: extracted.text, completeness: warnings.length ? 'partial' : 'complete', warnings: [...new Set(warnings)].slice(0, 80), loadedBlocks: Number.isInteger(extracted.loadedBlocks) ? extracted.loadedBlocks : 0, imagesDetected: entries.length, imagesIncluded: images.length, images } });
        this.update(this.jobs.size > 1 ? 'reading' : 'ready', this.jobs.size > 1 ? '文档已导入，仍在读取其他文档…' : warnings.length ? '文档已导入，部分内容需按平台提示补充。' : '文档已完整导入。');
      }
    } catch (error) {
      const failure = publicError(job.timedOut ? new BridgeError('TIMEOUT') : job.tabClosed ? new BridgeError('TAB_CLOSED') : job.controller.signal.aborted ? new BridgeError('CANCELLED') : error);
      if (current()) { this.send({ type: 'result', taskId, ok: false, error: failure }); this.update('error', failure.message); }
    } finally {
      this.timers.clearTimeout(timeout); job.controller.signal.removeEventListener('abort', closeTab); this.chrome.tabs.onRemoved.removeListener(tabRemoved); closeTab(); this.jobs.delete(taskId);
      this.status.active = this.jobs.size;
    }
  }
}

if (globalThis.chrome?.runtime?.id) {
  const bridge = new FeishuBridge({ chrome, WebSocket });
  const initialized = bridge.initialize();
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'qzz-feishu-reconnect') void initialized.then(() => { if (bridge.config.enabled) bridge.connect(); }); });
  chrome.runtime.onStartup.addListener(() => { void initialized.then(() => bridge.connect()); });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    void initialized.then(async () => {
      if (message.type === 'getStatus') return { ok: true, status: bridge.status };
      if (message.type === 'pair') return bridge.pair(message.port, message.code);
      if (message.type === 'disconnect') { await bridge.disconnect(); return { ok: true }; }
      if (message.type === 'reconnect') { await bridge.reconnect(); return { ok: true }; }
      throw new BridgeError('PROTOCOL_ERROR');
    }).then(sendResponse, (error) => sendResponse({ ok: false, error: publicError(error) }));
    return true;
  });
}
