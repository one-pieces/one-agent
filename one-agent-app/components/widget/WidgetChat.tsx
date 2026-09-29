"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 访客侧客服对话界面（跑在客户网站嵌入的 iframe 里）。
 *
 * 与 SDK 的分工：SDK 负责宿主页面上的按钮/面板与 postMessage；这里只管对话本身。
 * 数据来源只有三个公开接口：/api/widget/{config,session,messages,chat}，
 * 全部需要 agentId + embedKey（+ 访客 token），拿不到任何后台数据。
 */

interface WidgetConfig {
  agentId: string;
  title: string;
  subtitle: string;
  welcome: string;
  placeholder: string;
  primaryColor: string;
  position: "left" | "right";
  agentName?: string;
  error?: string;
}

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

const STORAGE_PREFIX = "oa:widget:";

export default function WidgetChat({
  agentId,
  embedKey,
  colorOverride,
  theme,
}: {
  agentId: string;
  embedKey: string;
  colorOverride?: string;
  theme?: string;
}) {
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [fatal, setFatal] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [session, setSession] = useState<{ sessionId: string; visitorToken: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 宿主页面最后一次告知的可见性（面板关闭时收到回复要通知宿主显示未读） */
  const visibleRef = useRef(true);
  const primary = colorOverride || config?.primaryColor || "#2f6bff";

  const post = useCallback(
    (type: string, payload?: Record<string, unknown>) => {
      const msg = { type: `oa:${type}`, ...(payload ?? {}) };
      // 只发给父窗口（宿主页面），且不指定 targetOrigin 之外的通道
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
    },
    [],
  );

  // ── 配置 + 会话初始化 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfgRes = await fetch(`/api/widget/config?agentId=${encodeURIComponent(agentId)}&key=${encodeURIComponent(embedKey)}`);
        const cfg = (await cfgRes.json()) as WidgetConfig;
        if (cancelled) return;
        if (!cfgRes.ok) {
          setFatal(cfg.error ?? `加载失败（HTTP ${cfgRes.status}）`);
          post("ready", { ok: false });
          return;
        }
        setConfig(cfg);
        document.title = cfg.title;
        post("ready", { ok: true, title: cfg.title });

        const stored = readStored(agentId);
        const sesRes = await fetch("/api/widget/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId, key: embedKey, ...stored }),
        });
        const ses = (await sesRes.json()) as { sessionId?: string; visitorToken?: string; resumed?: boolean; error?: string };
        if (cancelled) return;
        if (!sesRes.ok || !ses.sessionId || !ses.visitorToken) {
          setFatal(ses.error ?? "建立会话失败");
          return;
        }
        writeStored(agentId, { sessionId: ses.sessionId, visitorToken: ses.visitorToken });
        setSession({ sessionId: ses.sessionId, visitorToken: ses.visitorToken });

        if (ses.resumed) {
          const hisRes = await fetch(
            `/api/widget/messages?agentId=${encodeURIComponent(agentId)}&key=${encodeURIComponent(embedKey)}` +
              `&sessionId=${encodeURIComponent(ses.sessionId)}&visitorToken=${encodeURIComponent(ses.visitorToken)}`,
          );
          if (hisRes.ok) {
            const his = (await hisRes.json()) as { messages?: Msg[] };
            if (!cancelled && his.messages?.length) setMessages(his.messages);
          }
        }
      } catch (err) {
        if (!cancelled) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, embedKey, post]);

  // ── 与 SDK 的消息协议 ──
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = (event.data ?? {}) as { type?: string; open?: boolean };
      if (data.type === "oa:visibility") visibleRef.current = data.open !== false;
      if (data.type === "oa:open" || data.type === "oa:focus") inputRef.current?.focus();
      if (data.type === "oa:close") visibleRef.current = false;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!config) return;
    const isDark = theme === "dark" || (theme !== "light" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-oa-theme", isDark ? "dark" : "light");
  }, [config, theme]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !session) return;
    setInput("");
    setBusy(true);
    setStatus("");
    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [...prev, { id: userId, role: "user", content: text }, { id: assistantId, role: "assistant", content: "", streaming: true }]);

    try {
      const res = await fetch("/api/widget/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, key: embedKey, sessionId: session.sessionId, visitorToken: session.visitorToken, message: text }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMessages((prev) => replace(prev, assistantId, { content: err.error ?? `发送失败（HTTP ${res.status}）`, streaming: false }));
        return;
      }
      if (!res.body) throw new Error("响应无内容");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let chunk: { type?: string; delta?: string; label?: string; message?: string };
          try {
            chunk = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (chunk.type === "text" && chunk.delta) {
            setStatus("");
            setMessages((prev) => appendText(prev, assistantId, chunk.delta!));
          } else if (chunk.type === "status" && chunk.label) {
            setStatus(chunk.label);
          } else if (chunk.type === "error") {
            setMessages((prev) => replace(prev, assistantId, { content: chunk.message ?? "服务异常", streaming: false }));
          }
        }
      }
      setMessages((prev) => replace(prev, assistantId, { streaming: false }));
      if (!visibleRef.current) post("unread", { count: 1 });
      post("event", { name: "message", payload: { role: "assistant" } });
    } catch (err) {
      setMessages((prev) =>
        replace(prev, assistantId, { content: `网络异常：${err instanceof Error ? err.message : String(err)}`, streaming: false }),
      );
    } finally {
      setBusy(false);
      setStatus("");
    }
  }, [agentId, embedKey, input, busy, session, post]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const styleVars = useMemo(() => ({ ["--oa-primary" as string]: primary }), [primary]);

  return (
    <div className="oa-widget-root" style={styleVars}>
      <style dangerouslySetInnerHTML={{ __html: WIDGET_CSS }} />
      <header className="oa-widget-head">
        <div className="oa-widget-head-text">
          <strong>{config?.title ?? "在线客服"}</strong>
          {config?.subtitle && <span>{config.subtitle}</span>}
        </div>
        <button type="button" className="oa-widget-close" aria-label="关闭" onClick={() => post("close")}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="oa-widget-body" ref={listRef}>
        {fatal && (
          <div className="oa-widget-error" role="alert">
            <strong>暂时无法使用在线客服</strong>
            <p>{fatal}</p>
          </div>
        )}
        {!fatal && config?.welcome && messages.length === 0 && (
          <div className="oa-widget-row assistant">
            <div className="oa-widget-bubble">{config.welcome}</div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`oa-widget-row ${m.role}`}>
            <div className="oa-widget-bubble">
              {m.content}
              {m.streaming && <span className="oa-widget-caret" aria-hidden="true" />}
            </div>
          </div>
        ))}
        {status && (
          <div className="oa-widget-status" aria-live="polite">
            <span className="oa-widget-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {status}
          </div>
        )}
        {!fatal && !config && <div className="oa-widget-status">正在连接…</div>}
      </div>

      {!fatal && (
        <footer className="oa-widget-foot">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, 2000))}
            onKeyDown={onKeyDown}
            placeholder={config?.placeholder ?? "输入你的问题…"}
            aria-label="消息输入框"
            disabled={busy || !session}
          />
          <button type="button" className="oa-widget-send" onClick={() => void send()} disabled={busy || !input.trim() || !session} aria-label="发送">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </footer>
      )}
      <div className="oa-widget-brand">
        <a href="https://github.com/" target="_blank" rel="noreferrer noopener" tabIndex={-1}>
          one-agent
        </a>
      </div>
    </div>
  );
}

function replace(list: Msg[], id: string, patch: Partial<Msg>): Msg[] {
  return list.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

function appendText(list: Msg[], id: string, delta: string): Msg[] {
  return list.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m));
}

function readStored(agentId: string): { sessionId?: string; visitorToken?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + agentId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { sessionId?: string; visitorToken?: string };
    return parsed.sessionId && parsed.visitorToken ? parsed : {};
  } catch {
    return {};
  }
}

function writeStored(agentId: string, value: { sessionId: string; visitorToken: string }): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + agentId, JSON.stringify(value));
  } catch {
    // 隐私模式下不可写 —— 忽略（会话只在当前页有效）
  }
}

/** 组件样式（自带作用域，不依赖后台 globals.css） */
const WIDGET_CSS = `
.oa-widget-root{--oa-primary:#2f6bff;--oa-bg:#ffffff;--oa-fg:#14161c;--oa-muted:#6b7280;--oa-line:#e6e8ee;--oa-bubble:#f1f3f7;
  position:fixed;inset:0;display:flex;flex-direction:column;background:var(--oa-bg);color:var(--oa-fg);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;overflow:hidden}
html[data-oa-theme="dark"] .oa-widget-root{--oa-bg:#16181d;--oa-fg:#e8eaf0;--oa-muted:#9aa1b1;--oa-line:#2a2f3a;--oa-bubble:#232733}
.oa-widget-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;
  background:var(--oa-primary);color:#fff;flex-shrink:0}
.oa-widget-head-text{display:flex;flex-direction:column;min-width:0}
.oa-widget-head-text strong{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oa-widget-head-text span{font-size:12px;opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oa-widget-close{background:transparent;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;
  display:flex;align-items:center;justify-content:center;opacity:.9}
.oa-widget-close:hover{background:rgba(255,255,255,.16);opacity:1}
.oa-widget-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.oa-widget-body::-webkit-scrollbar{width:8px}
.oa-widget-body::-webkit-scrollbar-thumb{background:var(--oa-line);border-radius:4px}
.oa-widget-row{display:flex}
.oa-widget-row.user{justify-content:flex-end}
.oa-widget-bubble{max-width:82%;padding:9px 13px;border-radius:14px;background:var(--oa-bubble);
  white-space:pre-wrap;word-break:break-word;font-size:14px}
.oa-widget-row.user .oa-widget-bubble{background:var(--oa-primary);color:#fff;border-bottom-right-radius:4px}
.oa-widget-row.assistant .oa-widget-bubble{border-bottom-left-radius:4px}
.oa-widget-caret{display:inline-block;width:2px;height:14px;background:currentColor;margin-left:2px;
  vertical-align:-2px;animation:oa-blink 1s steps(2,start) infinite}
@keyframes oa-blink{to{visibility:hidden}}
.oa-widget-status{display:flex;align-items:center;gap:8px;color:var(--oa-muted);font-size:12.5px}
.oa-widget-dots{display:inline-flex;gap:3px}
.oa-widget-dots i{width:5px;height:5px;border-radius:50%;background:var(--oa-muted);animation:oa-bounce 1.2s infinite}
.oa-widget-dots i:nth-child(2){animation-delay:.15s}
.oa-widget-dots i:nth-child(3){animation-delay:.3s}
@keyframes oa-bounce{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.oa-widget-caret,.oa-widget-dots i{animation:none}}
.oa-widget-error{background:color-mix(in srgb,#e5484d 12%,transparent);border:1px solid color-mix(in srgb,#e5484d 32%,transparent);
  border-radius:12px;padding:12px 14px;font-size:13px}
.oa-widget-error strong{display:block;margin-bottom:4px}
.oa-widget-error p{margin:0;color:var(--oa-muted);word-break:break-word}
.oa-widget-foot{display:flex;align-items:flex-end;gap:8px;padding:12px;border-top:1px solid var(--oa-line);flex-shrink:0}
.oa-widget-foot textarea{flex:1;resize:none;max-height:120px;min-height:40px;padding:10px 12px;border-radius:12px;
  border:1px solid var(--oa-line);background:var(--oa-bg);color:var(--oa-fg);font:inherit;font-size:14px;outline:none}
.oa-widget-foot textarea:focus{border-color:var(--oa-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--oa-primary) 16%,transparent)}
.oa-widget-foot textarea:disabled{opacity:.6}
.oa-widget-send{width:40px;height:40px;flex-shrink:0;border:none;border-radius:12px;background:var(--oa-primary);color:#fff;
  cursor:pointer;display:flex;align-items:center;justify-content:center}
.oa-widget-send:disabled{opacity:.45;cursor:not-allowed}
.oa-widget-brand{flex-shrink:0;text-align:center;font-size:10.5px;color:var(--oa-muted);padding:0 0 8px}
.oa-widget-brand a{color:inherit;text-decoration:none}
`;
