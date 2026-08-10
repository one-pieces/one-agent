"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  BotIcon,
  CheckCircle2Icon,
  ClockIcon,
  ShieldAlertIcon,
  Trash2Icon,
  UserIcon,
  XCircleIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { consumeSSE } from "@/lib/sse-client";
import SessionSettings from "@/components/SessionSettings";
import type { AgentConfig, Message as PersistedMessage } from "@one-agent/core";

const markdownPlugins = { cjk };

export type ToolStatus = "running" | "done" | "error" | "denied";

export interface UiToolCall {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: UiToolCall[];
  streaming?: boolean;
}

function uid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatOutput(o: unknown): string {
  if (typeof o === "string") return o.slice(0, 600);
  try {
    return JSON.stringify(o, null, 1).slice(0, 600);
  } catch {
    return String(o).slice(0, 600);
  }
}

const DENIED_TEXT = "已拒绝";

function toolStatusFromResult(ok: boolean, output: unknown): ToolStatus {
  if (!ok && String(output).includes(DENIED_TEXT)) return "denied";
  return ok ? "done" : "error";
}

const toolStatusMeta: Record<ToolStatus, { label: string; icon: typeof ClockIcon; cls: string }> = {
  running: { label: "执行中", icon: ClockIcon, cls: "tool-running" },
  done: { label: "完成", icon: CheckCircle2Icon, cls: "tool-done" },
  error: { label: "失败", icon: XCircleIcon, cls: "tool-error" },
  denied: { label: "已拒绝", icon: ShieldAlertIcon, cls: "tool-denied" },
};

function ToolStatusBadge({ status }: { status: ToolStatus }) {
  const meta = toolStatusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`tool-status ${meta.cls}`}>
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

export default function Chat({ sessionId, agent }: { sessionId: string; agent: AgentConfig }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [errorBanner, setErrorBanner] = useState("");
  const [tokenUsage, setTokenUsage] = useState({ input: 0, output: 0, cached: 0, cacheCreation: 0 });
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (streaming) scrollToBottom();
  }, [messages, streaming, scrollToBottom]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBtn(dist > 120);
  };

  // 加载会话历史（含工具调用结果重建）
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    setMessages([]);
    setTokenUsage({ input: 0, output: 0, cached: 0, cacheCreation: 0 });
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((session: { messages?: PersistedMessage[]; meta?: Record<string, unknown> }) => {
        if (cancelled || !session?.messages) return;
        const toolResults = new Map<string, { ok: boolean; output: unknown }>();
        for (const m of session.messages) {
          if (m.role === "tool" && m.toolCallId) {
            let parsed: unknown = m.content;
            try {
              parsed = JSON.parse(m.content);
            } catch {
              /* 保持原文 */
            }
            const isErr = typeof parsed === "object" && parsed !== null && "error" in (parsed as object);
            toolResults.set(m.toolCallId, { ok: !isErr, output: parsed });
          }
        }
        const ui: UiMessage[] = session.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            toolCalls: (m.toolCalls ?? []).map((tc) => {
              const r = toolResults.get(tc.id);
              return {
                id: tc.id,
                name: tc.name,
                input: tc.input,
                status: r ? toolStatusFromResult(r.ok, r.output) : "running",
                output: r?.output,
              };
            }),
          }));
        setMessages(ui);

        // 恢复已持久化的 token 统计：优先会话级累计（meta.tokenUsage，窗口裁剪/压缩后依然准确）；
        // 旧会话无 meta 时回退到消息级 usage 求和
        const metaUsage = session.meta?.tokenUsage as
          | { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheCreationTokens?: number }
          | undefined;
        const msgUsage = session.messages.reduce(
          (acc, m) => {
            if (m.usage) {
              acc.input += m.usage.inputTokens;
              acc.output += m.usage.outputTokens;
              acc.cached += m.usage.cachedTokens ?? 0;
              acc.cacheCreation += m.usage.cacheCreationTokens ?? 0;
            }
            return acc;
          },
          { input: 0, output: 0, cached: 0, cacheCreation: 0 },
        );
        setTokenUsage({
          input: metaUsage?.inputTokens ?? msgUsage.input,
          output: metaUsage?.outputTokens ?? msgUsage.output,
          cached: metaUsage?.cachedTokens ?? msgUsage.cached,
          cacheCreation: metaUsage?.cacheCreationTokens ?? msgUsage.cacheCreation,
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setStreaming(true);
    setErrorBanner("");

    const userMsg: UiMessage = { id: uid(), role: "user", content: text, toolCalls: [] };
    const assistantMsg: UiMessage = { id: uid(), role: "assistant", content: "", toolCalls: [], streaming: true };
    setMessages((ms) => [...ms, userMsg, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, sessionId, message: text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      await consumeSSE(res, (chunk) => {
        // usage 是独立的 setState，不能放在 setMessages updater 内：
        // React StrictMode 会 double-invoke updater，导致嵌套副作用执行两次（token 累加 2 倍）
        if (chunk.type === "usage") {
          setTokenUsage((u) => ({
            input: u.input + chunk.inputTokens,
            output: u.output + chunk.outputTokens,
            cached: u.cached + (chunk.cachedTokens ?? 0),
            cacheCreation: u.cacheCreation + (chunk.cacheCreationTokens ?? 0),
          }));
          return;
        }
        setMessages((ms) => {
          const next = [...ms];
          const i = next.length - 1;
          const last = next[i]!;
          if (chunk.type === "text") {
            next[i] = { ...last, content: last.content + chunk.delta };
          } else if (chunk.type === "tool_call") {
            next[i] = {
              ...last,
              toolCalls: [...last.toolCalls, { id: chunk.id, name: chunk.name, input: chunk.input, status: "running" }],
            };
          } else if (chunk.type === "tool_result") {
            next[i] = {
              ...last,
              toolCalls: last.toolCalls.map((tc) =>
                tc.id === chunk.id
                  ? { ...tc, status: toolStatusFromResult(chunk.ok, chunk.output), output: chunk.output }
                  : tc,
              ),
            };
          } else if (chunk.type === "error") {
            setErrorBanner(chunk.message);
            next[i] = { ...last, streaming: false };
          } else if (chunk.type === "done") {
            next[i] = { ...last, streaming: false };
          }
          return next;
        });
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setErrorBanner((err as Error).message);
        setMessages((ms) => {
          const next = [...ms];
          const i = next.length - 1;
          const last = next[i]!;
          next[i] = { ...last, streaming: false };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      window.dispatchEvent(new Event("one-agent:sessions-changed"));
    }
  };

  const stop = () => abortRef.current?.abort();

  const handleDeleteMessage = async (messageId: string) => {
    setMessages((ms) => ms.filter((m) => m.id !== messageId));
    try {
      await fetch(`/api/sessions/${sessionId}/messages/${messageId}`, { method: "DELETE" });
    } catch {
      /* 本地已移除，忽略远端失败 */
    }
  };

  return (
    <div className="chat-root">
      <header className="chat-header">
        <div className="chat-header-info">
          <strong>{agent.name}</strong>
          <span className="muted">
            {agent.model.modelId}
            {streaming && <span className="status-dot" title="生成中" />}
          </span>
        </div>
        <div className="chat-header-right">
          {(tokenUsage.input > 0 || tokenUsage.output > 0) && (
            <span className="token-badge" title="本会话累计 token 用量（◎ 缓存命中 / ＋ 缓存写入）">
              ↑{tokenUsage.input.toLocaleString()} ↓{tokenUsage.output.toLocaleString()}
              {tokenUsage.cached > 0 && <> ◎{tokenUsage.cached.toLocaleString()}</>}
              {tokenUsage.cacheCreation > 0 && <> ＋{tokenUsage.cacheCreation.toLocaleString()}</>}
            </span>
          )}
          <SessionSettings sessionId={sessionId} agent={agent} />
        </div>
      </header>

      {errorBanner && (
        <div className="error-banner">
          <AlertCircleIcon size={16} />
          <span>{errorBanner}</span>
          <button className="sidebar-icon-btn" onClick={() => setErrorBanner("")} title="关闭">
            ✕
          </button>
        </div>
      )}

      <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
        {loadingHistory && <p className="muted">加载历史…</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-avatar">{m.role === "user" ? <UserIcon size={14} /> : <BotIcon size={14} />}</div>
            <div className="msg-content">
              {m.role === "assistant" && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((tc) => (
                    <details key={tc.id} className="tool-card" open={tc.status === "running"}>
                      <summary>
                        <span className="tool-name">🔧 {tc.name}</span>
                        <ToolStatusBadge status={tc.status} />
                      </summary>
                      <div className="tool-input">
                        <div className="label">入参</div>
                        <pre>{formatOutput(tc.input)}</pre>
                      </div>
                      {tc.status !== "running" && (
                        <div className="tool-output">
                          <div className="label">结果</div>
                          <pre className={tc.status === "error" || tc.status === "denied" ? "tool-output-error" : ""}>
                            {tc.status === "denied"
                              ? "危险操作未获批准（可在右上角会话覆盖中开启「允许危险工具」后重试）"
                              : formatOutput(tc.output)}
                          </pre>
                        </div>
                      )}
                    </details>
                  ))}
                </div>
              )}
              <div className="bubble">
                <Streamdown plugins={markdownPlugins}>{m.content || (m.streaming ? "…" : "")}</Streamdown>
                {m.streaming && <span className="cursor">▍</span>}
              </div>
              {!m.streaming && (
                <button
                  className="msg-delete"
                  onClick={() => void handleDeleteMessage(m.id)}
                  title="删除消息"
                >
                  <Trash2Icon size={13} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showScrollBtn && (
        <button className="scroll-bottom-btn" onClick={scrollToBottom} title="滚动到底部">
          <ArrowDownIcon size={18} />
        </button>
      )}

      <footer className="chat-footer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          rows={2}
        />
        {streaming ? (
          <button className="btn danger" onClick={stop}>
            停止
          </button>
        ) : (
          <button className="btn primary" onClick={() => void send()} disabled={!input.trim()}>
            发送
          </button>
        )}
      </footer>
    </div>
  );
}
