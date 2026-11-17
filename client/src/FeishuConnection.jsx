import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CircleHelp,
  ExternalLink,
  Link2,
  LoaderCircle,
  Save,
  X,
} from "lucide-react";
import "./feishu-connection.css";

const FEISHU_CONSOLE = "https://open.feishu.cn/app";
const DOC_PERMISSION_HELP =
  "https://www.feishu.cn/hc/zh-CN/articles/360044508113-云文档权限常见问题";
const DOC_API_HELP =
  "https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content";

export function FeishuConnectionHelp({
  isAdmin = false,
  onConfigure,
  open = false,
}) {
  return (
    <details className="feishu-connection-help" open={open || undefined}>
      <summary>
        <CircleHelp size={16} />
        如何开通飞书文档权限
      </summary>
      <div className="feishu-help-body">
        <p>
          QZZ
          管理员和飞书企业管理员是不同的角色。配置应用凭据后，还需要飞书授权和目标文档的访问权限。
        </p>
        <ol>
          <li>
            <strong>创建并发布应用。</strong>在
            <a href={FEISHU_CONSOLE} target="_blank" rel="noopener noreferrer">
              飞书开放平台
              <ExternalLink size={12} />
            </a>
            创建或选择企业自建应用，在“凭证与基础信息”获取 App ID 和 App
            Secret。在“权限管理”按接口要求开通新版文档只读权限，例如{" "}
            <code>docx:document:readonly</code>；读取 wiki
            地址还需知识库读取权限，例如 <code>wiki:wiki:readonly</code>
            。创建版本并发布；组织要求审批时，请飞书企业管理员审批。具体权限以
            <a href={DOC_API_HELP} target="_blank" rel="noopener noreferrer">
              接口官方说明
            </a>
            为准。
          </li>
          <li>
            <strong>将目标文档授权给应用。</strong>
            请文档所有者或有管理权的协作者，在文档右上角“··· → ···更多 →
            添加文档应用”中搜索刚才的应用，授予可阅读权限。wiki
            文档还需相应知识库访问权限。
          </li>
          <li>
            <strong>在 QZZ 保存应用凭据。</strong>使用 QZZ 的 admin
            账号打开“飞书文档连接”，填写 App ID、App Secret
            并保存，再重新导入文档地址。
          </li>
        </ol>
        <div className="feishu-help-footer">
          <a
            href={DOC_PERMISSION_HELP}
            target="_blank"
            rel="noopener noreferrer"
          >
            飞书官方权限帮助
            <ExternalLink size={12} />
          </a>
          {isAdmin && onConfigure ? (
            <button type="button" className="text-button" onClick={onConfigure}>
              <Link2 size={14} />
              配置飞书文档连接
            </button>
          ) : (
            <span>无法开通应用权限时，可将文档导出为 Word / PDF 后上传。</span>
          )}
        </div>
      </div>
    </details>
  );
}

export default function FeishuConnection({ onClose, onSaved }) {
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const [originalAppId, setOriginalAppId] = useState("");
  const [busy, setBusy] = useState("load");
  const [error, setError] = useState("");
  const active = useRef(true);
  const epoch = useRef(0);
  const pending = useRef(new Set());
  const needsSecret = !configured || appId.trim() !== originalAppId;
  useEffect(() => {
    active.current = true;
    const token = ++epoch.current;
    const controller = new AbortController();
    pending.current.add(controller);
    fetch("/api/ai/feishu-config", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(data.message || "无法读取飞书应用配置");
        if (active.current && epoch.current === token) {
          setAppId(data.appId || "");
          setOriginalAppId(data.appId || "");
          setConfigured(Boolean(data.configured));
        }
      })
      .catch((failure) => {
        if (
          active.current &&
          epoch.current === token &&
          failure.name !== "AbortError"
        )
          setError(failure.message);
      })
      .finally(() => {
        pending.current.delete(controller);
        if (active.current && epoch.current === token) setBusy("");
      });
    return () => {
      active.current = false;
      epoch.current += 1;
      pending.current.forEach((controller) => controller.abort());
      pending.current.clear();
    };
  }, []);
  async function save(event) {
    event.preventDefault();
    if (busy || !appId.trim() || (needsSecret && !secret)) return;
    setBusy("save");
    setError("");
    const controller = new AbortController();
    const token = epoch.current;
    pending.current.add(controller);
    try {
      const response = await fetch("/api/ai/feishu-config", {
        method: "PUT",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: appId.trim(), appSecret: secret }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || "飞书配置保存失败");
      if (active.current && epoch.current === token) {
        setSecret("");
        onSaved?.(data);
        onClose();
      }
    } catch (failure) {
      if (
        active.current &&
        epoch.current === token &&
        failure.name !== "AbortError"
      )
        setError(failure.message);
    } finally {
      pending.current.delete(controller);
      if (active.current && epoch.current === token) setBusy("");
    }
  }
  return (
    <div className="modal-backdrop feishu-connection-backdrop">
      <section
        className="modal feishu-connection-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-connection-title"
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">DOCUMENT CONNECTION</span>
            <h2 id="feishu-connection-title">飞书文档连接</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="关闭飞书配置"
            aria-label="关闭飞书配置"
            disabled={busy === "save"}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="feishu-connection-content">
          <div className="feishu-configuration-state">
            {configured ? <Check size={15} /> : <Link2 size={15} />}
            <span>
              {busy === "load"
                ? "正在读取配置"
                : configured
                  ? "已配置应用"
                  : "尚未配置应用"}
            </span>
          </div>
          <form className="feishu-configuration-form" onSubmit={save}>
            <label className="field">
              <span>App ID</span>
              <input
                aria-label="飞书 App ID"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="cli_…"
                maxLength={125}
                required
                disabled={Boolean(busy)}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>App Secret</span>
              <input
                aria-label="飞书 App Secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={
                  needsSecret
                    ? "输入此应用的 App Secret"
                    : "已保存，留空保留现有凭据"
                }
                maxLength={500}
                required={needsSecret}
                disabled={Boolean(busy)}
                autoComplete="new-password"
              />
            </label>
            <p className="feishu-credential-note">
              已保存的 Secret 不会回显；更换 App ID 时需重新填写
              Secret。保存配置后，请完成飞书侧授权再导入文档。
            </p>
            <ErrorMessage error={error} />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={onClose}
                disabled={busy === "save"}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={
                  Boolean(busy) || !appId.trim() || (needsSecret && !secret)
                }
              >
                {busy === "save" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Save size={16} />
                )}
                保存配置
              </button>
            </div>
          </form>
          <FeishuConnectionHelp open />
        </div>
      </section>
    </div>
  );
}

function ErrorMessage({ error }) {
  return error ? (
    <div className="inline-error" role="alert">
      <AlertCircle size={16} />
      <span>{error}</span>
    </div>
  ) : null;
}
