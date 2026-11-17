import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Chrome, CircleHelp, Copy, Download, Link2, LoaderCircle, RefreshCw, Unplug, X } from 'lucide-react';
import './feishu-connection.css';

const EXTENSION_URL = '/api/feishu-browser/extension.zip';
const EXTENSIONS_PAGE = 'chrome://extensions';
const POLL_MS = 2500;
const STATUS_CHANGED = 'qzz-feishu-browser-status';

export function FeishuBrowserStatus({ isAdmin = false, onConfigure, disabled = false }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let timer;
    let controller;
    let requesting = false;
    async function refresh() {
      if (!alive || requesting) return;
      requesting = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/api/feishu-browser/status', { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || '无法获取服务器浏览器状态');
        if (alive) { setStatus(data); setError(''); }
      } catch (failure) {
        if (alive) { setStatus(null); setError(failure.name === 'AbortError' ? '连接状态查询超时' : failure.message); }
      } finally { clearTimeout(timeout); requesting = false; }
    }
    async function tick() { await refresh(); if (alive) timer = setTimeout(tick, 10000); }
    tick();
    window.addEventListener(STATUS_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => { alive = false; clearTimeout(timer); controller?.abort(); window.removeEventListener(STATUS_CHANGED, refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const text = error ? '服务器浏览器状态暂不可用' : !status ? '正在检查服务器浏览器…' : status.connected ? '服务器 Chrome 已连接' : status.paired ? '服务器 Chrome 已配对，当前离线' : '服务器 Chrome 未连接';
  return <div className={`feishu-import-status ${status?.connected ? 'connected' : ''}`}>
    <div className="feishu-import-status-heading"><Chrome size={16} /><strong>{text}</strong>{onConfigure && <button type="button" className="text-button" disabled={disabled} onClick={onConfigure}>{isAdmin ? '管理连接' : '查看连接'}</button>}</div>
    <p>{error || '通过服务器电脑的 Chrome 读取；该 Chrome 中的飞书账号须能打开并复制目标文档。'}</p>
    {!error && status && !status.connected && <p>{isAdmin ? '请先在服务器 Chrome 安装扩展并配对，保持 Chrome 运行。' : '请联系平台 admin 连接服务器 Chrome。你电脑上的飞书登录状态不用于导入。'}</p>}
  </div>;
}

export function FeishuConnectionHelp({ isAdmin = false, onConfigure, open = false }) {
  return <details className="feishu-connection-help" open={open || undefined}>
    <summary><CircleHelp size={16} />如何导入飞书文档</summary>
    <div className="feishu-help-body">
      <p>平台通过服务器这台电脑上已登录飞书的 Chrome 读取文档。其他成员电脑上的登录状态不参与导入。</p>
      {isAdmin ? <ol>
        <li><strong>下载并解压扩展。</strong>在“飞书浏览器连接”中下载 Chrome 扩展 ZIP，解压后保留 <code>browser-extension</code> 文件夹。</li>
        <li><strong>在服务器 Chrome 中加载扩展。</strong>在地址栏输入 <code>{EXTENSIONS_PAGE}</code>，开启“开发者模式”，点击“加载已解压的扩展”，选择解压后的 <code>browser-extension</code> 文件夹。</li>
        <li><strong>配对后导入。</strong>生成一次性配对码，打开服务器 Chrome 的扩展，填写平台端口和配对码。该 Chrome 登录飞书且能够打开目标文档后，回平台粘贴文档链接导入。</li>
      </ol> : <p>请联系平台 admin 在服务器电脑上完成浏览器连接，并确认该浏览器账号能够打开目标文档。</p>}
      <div className="feishu-help-footer">{onConfigure && <button type="button" className="text-button" onClick={onConfigure}><Link2 size={14} />{isAdmin ? '管理飞书浏览器连接' : '查看服务器浏览器状态'}</button>}<span>无法读取时，可将文档导出为 Word / PDF 后上传。</span></div>
    </div>
  </details>;
}

function timestamp(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
}

export default function FeishuConnection({ isAdmin = false, onClose, onSaved }) {
  const [status, setStatus] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(new Set());
  const locked = useRef(false);
  const statusInFlight = useRef(false);
  const statusRevision = useRef(0);
  const poll = useRef(null);
  const codeInput = useRef(null);
  const extensionsInput = useRef(null);
  const modal = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const refreshRef = useRef(null);
  const admin = useRef(isAdmin);
  admin.current = isAdmin;
  const port = window.location.port || '3210';
  const remaining = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  const countdown = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;

  useEffect(() => {
    const previous = document.activeElement;
    modal.current?.querySelector('button')?.focus();
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current?.(); }
      if (event.key !== 'Tab') return;
      const items = [...(modal.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), summary') || [])].filter((item) => item.getClientRects().length);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    active.current = true;
    const token = ++epoch.current;
    locked.current = false; statusInFlight.current = false;
    setPairing(null); setBusy(''); setError(''); setStatusError(''); setNotice('');
    async function refresh() {
      if (!active.current || epoch.current !== token || locked.current || statusInFlight.current) return;
      statusInFlight.current = true;
      const readRevision = statusRevision.current;
      const controller = new AbortController(); pending.current.add(controller);
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/api/feishu-browser/status', { credentials: 'same-origin', signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || '无法读取服务器浏览器状态');
        if (active.current && epoch.current === token && readRevision === statusRevision.current && !locked.current) { setStatus(data); setStatusError(''); }
      } catch (failure) {
        if (active.current && epoch.current === token && readRevision === statusRevision.current && !locked.current) { setStatus(null); setStatusError(failure.name === 'AbortError' ? '读取浏览器状态超时，请稍后重试' : failure.message); }
      } finally {
        clearTimeout(timeout); pending.current.delete(controller);
        if (epoch.current === token) statusInFlight.current = false;
      }
    }
    refreshRef.current = refresh;
    async function tick() {
      await refresh();
      if (active.current && epoch.current === token) poll.current = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => {
      active.current = false; epoch.current += 1;
      clearTimeout(poll.current); refreshRef.current = null;
      pending.current.forEach((controller) => controller.abort()); pending.current.clear();
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!pairing) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (status?.connected && pairing) {
      setPairing(null); setNotice('服务器 Chrome 扩展已连接'); window.dispatchEvent(new Event(STATUS_CHANGED)); onSaved?.(status);
    }
  }, [status?.connected, pairing, onSaved]);

  async function mutate(action) {
    if (!admin.current || locked.current) return;
    if (action === 'pair' && (status?.paired || status?.connected || status?.pairingPending || pairing) && !window.confirm('重新配对将断开当前浏览器连接，并取消正在进行的文档导入。确定继续吗？')) return;
    if (action === 'disconnect' && !window.confirm('断开服务器浏览器连接会取消正在进行的文档导入。确定继续吗？')) return;
    statusRevision.current += 1;
    locked.current = true; setBusy(action); setError(''); setNotice('');
    const token = epoch.current;
    const controller = new AbortController(); pending.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/feishu-browser/${action}`, { method: action === 'pair' ? 'POST' : 'DELETE', credentials: 'same-origin', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || (action === 'pair' ? '生成配对码失败' : '断开连接失败'));
      if (!active.current || epoch.current !== token || !admin.current) return;
      if (action === 'pair') {
        if (typeof data.pairingCode !== 'string' || !/^[A-F0-9]{12}$/.test(data.pairingCode) || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('配对码响应不完整，请重新生成');
        setPairing({ pairingCode: data.pairingCode, expiresAt: data.expiresAt });
        setNow(Date.now()); setStatus((previous) => ({ ...previous, paired: false, connected: false, pairingPending: true, pending: 0 }));
        setNotice('请在服务器 Chrome 扩展中输入此一次性配对码');
      } else { setPairing(null); setStatus(data); setNotice('服务器浏览器已断开'); onSaved?.(data); }
      window.dispatchEvent(new Event(STATUS_CHANGED));
    } catch (failure) {
      if (active.current && epoch.current === token) setError(failure.name === 'AbortError' ? '操作超时，请刷新连接状态后重试' : failure.message);
    } finally {
      clearTimeout(timeout);
      pending.current.delete(controller);
      if (active.current && epoch.current === token) { locked.current = false; setBusy(''); refreshRef.current?.(); }
    }
  }

  async function downloadExtension() {
    if (!admin.current || locked.current) return;
    locked.current = true; setBusy('download'); setError(''); setNotice('');
    const token = epoch.current;
    const controller = new AbortController(); pending.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(EXTENSION_URL, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || '下载扩展失败，请稍后重试'); }
      const blob = await response.blob();
      if (!active.current || epoch.current !== token || !admin.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'QZZ-Feishu-Browser.zip';
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      setNotice('扩展下载已开始。解压后，在服务器 Chrome 中加载 browser-extension 文件夹。');
    } catch (failure) {
      if (active.current && epoch.current === token) setError(failure.name === 'AbortError' ? '下载扩展超时，请重试' : failure.message);
    } finally {
      clearTimeout(timeout); pending.current.delete(controller);
      if (active.current && epoch.current === token) { locked.current = false; setBusy(''); }
    }
  }

  async function copy(value, input) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        input.current?.focus(); input.current?.select();
        if (!document.execCommand('copy')) throw new Error('copy unavailable');
      }
      if (active.current) setNotice('已复制');
    } catch {
      input.current?.focus(); input.current?.select();
      if (active.current) setNotice('内容已选中，请复制后粘贴到服务器 Chrome');
    }
  }

  return <div className="modal-backdrop feishu-connection-backdrop"><section ref={modal} className="modal feishu-connection-modal" role="dialog" aria-modal="true" aria-labelledby="feishu-connection-title">
    <header className="modal-head"><div><span className="eyebrow">SERVER BROWSER</span><h2 id="feishu-connection-title">飞书浏览器连接</h2></div><button type="button" className="icon-button" title="关闭浏览器连接" aria-label="关闭浏览器连接" onClick={onClose}><X size={18} /></button></header>
    <div className="feishu-connection-content">
      <div className={`feishu-browser-state ${status?.connected ? 'connected' : ''}`}><Chrome size={25} /><div><strong>{!status ? statusError ? '服务器浏览器状态暂不可用' : '正在获取服务器浏览器状态' : status.connected ? '服务器 Chrome 已连接' : status.paired ? '浏览器已配对，当前不在线' : '服务器浏览器未连接'}</strong><span>连接状态只表示扩展与服务器连通；登录状态和文档访问权限以导入结果为准。</span></div>{status?.connected && <Check size={18} />}</div>
      {status && <dl className="feishu-browser-facts"><div><dt>浏览器</dt><dd>{status.browser || 'Chrome'}</dd></div><div><dt>平台端口</dt><dd>{port}</dd></div><div><dt>最近在线</dt><dd>{timestamp(status.lastSeen)}</dd></div><div><dt>正在导入</dt><dd>{status.pending || 0}</dd></div></dl>}
      {status?.configError && <ErrorMessage error="服务器浏览器连接信息无法读取，请联系平台 admin 重新配对" />}
      {(error || statusError) && <ErrorMessage error={error || statusError} />}
      {notice && <p className="feishu-browser-notice" role="status">{notice}</p>}
      {isAdmin ? <>
        <div className="feishu-browser-admin-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={downloadExtension}>{busy === 'download' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{busy === 'download' ? '下载中…' : '下载 Chrome 扩展'}</button><button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => mutate('pair')}>{busy === 'pair' ? <LoaderCircle size={16} className="spin" /> : <Link2 size={16} />}{pairing || status?.paired || status?.pairingPending ? '重新生成配对码' : '生成一次性配对码'}</button>{(status?.paired || status?.connected || status?.pairingPending) && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => mutate('disconnect')}><Unplug size={16} />断开连接</button>}</div>
        {pairing && <div className={`feishu-pairing ${remaining ? '' : 'expired'}`}><div><strong>一次性配对码</strong><span>{remaining ? `${countdown} 后过期` : '已过期，请重新生成'}</span></div><div className="feishu-copy-field"><input ref={codeInput} aria-label="一次性配对码" readOnly value={remaining ? pairing.pairingCode : '已过期'} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" title="复制配对码" aria-label="复制配对码" disabled={!remaining} onClick={() => copy(pairing.pairingCode, codeInput)}><Copy size={17} /></button></div><p>仅在服务器这台电脑的 Chrome 扩展中输入。重新生成会使旧配对码失效并断开旧连接。</p></div>}
        <div className="feishu-chrome-address"><label htmlFor="chrome-extension-address">服务器 Chrome 的扩展页面</label><div className="feishu-copy-field"><input id="chrome-extension-address" ref={extensionsInput} readOnly value={EXTENSIONS_PAGE} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" title="复制扩展页面地址" aria-label="复制扩展页面地址" onClick={() => copy(EXTENSIONS_PAGE, extensionsInput)}><Copy size={17} /></button></div><p>复制后粘贴到服务器 Chrome 地址栏；普通网页无法直接打开此地址。</p></div>
        <FeishuConnectionHelp isAdmin open />
      </> : <p className="feishu-browser-reader-note">请联系平台 admin 在服务器这台电脑上完成扩展安装和配对，并使用能够访问目标文档的飞书账号登录该 Chrome。</p>}
      <div className="feishu-browser-footer"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => refreshRef.current?.()}><RefreshCw size={15} />刷新状态</button><button type="button" className="button secondary" onClick={onClose}>关闭</button></div>
    </div>
  </section></div>;
}

function ErrorMessage({ error }) { return <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>; }
