import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, X } from 'lucide-react';
import { CURRENT_VERSION, VERSION_HISTORY } from './version-history';
import './version-history.css';

export default function VersionHistory() {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const openedOnce = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) openedOnce.current = true;
    else if (openedOnce.current) trigger.current?.focus();
  }, [open]);

  return <>
    <button ref={trigger} type="button" className="version-trigger" title={`版本 v${CURRENT_VERSION} · 查看更新记录`} aria-label={`版本 v${CURRENT_VERSION}，查看更新记录`} onClick={() => setOpen(true)}>
      <History size={17} strokeWidth={1.8} />
      <span>版本 v{CURRENT_VERSION}</span>
    </button>
    {open && createPortal(<div className="version-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="version-dialog" role="dialog" aria-modal="true" aria-labelledby="version-dialog-title">
        <div className="version-dialog-head"><div><span className="eyebrow">RELEASE NOTES</span><h2 id="version-dialog-title">版本更新</h2></div><button className="icon-button" type="button" aria-label="关闭版本更新" title="关闭" autoFocus onClick={() => setOpen(false)}><X size={18} /></button></div>
        <ol className="version-list">{VERSION_HISTORY.map(({ version, date, summary }) => <li key={version}>
          <div><strong>v{version}</strong><time dateTime={date}>{date}</time></div><p>{summary}</p>
        </li>)}</ol>
        <p className="version-note">0.1.x 历史条目依据 Git 迭代补记，早期未单独发布版本标签。</p>
      </div>
    </div>, document.body)}
  </>;
}
