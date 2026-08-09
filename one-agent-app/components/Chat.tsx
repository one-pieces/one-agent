"use client";

import { useEffect, useRef, useState } from "react";
import { consumeSSE } from "@/lib/sse-client";
import SessionSettings from "@/components/SessionSettings";
import type { AgentConfig, Message as PersistedMessage } from "@one-agent/core";

export interface UiToolCall {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
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
  if (typeof o === "string") return o.slice(0, 500);
  try {
    return JSON.stringify(o, null, 1).slice(0, 500);
  } catch {
    return String(o).slice(0, 500);
  }
}

export default function Chat({
  sessionId,
  agent,
}: {
  sessionId: string;
  agent: AgentConfig;
}) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 加载会话历史（含工具调用结果重建）
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((session: { messages?: PersistedMessage[] }) => {
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
            toolResults.set(m.toolCallId, { ok: true, output: parsed });
          }
        }
        const ui: UiMessage[] = session.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            toolCalls: (m.toolCalls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
              ...(toolResults.get(tc.id) ?? {}),
            })),
          }));
        setMessages(ui);
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
      await consumeSSE(res, (chunk) => {
        setMessages((ms) => {
          const next = [...ms];
          const i = next.length - 1;
          const last = next[i]!;
          if (chunk.type === "text") {
            next[i] = { ...last, content: last.content + chunk.delta };
          } else if (chunk.type === "tool_call") {
            next[i] = {
              ...last,
              toolCalls: [...last.toolCalls, { id: chunk.id, name: chunk.name, input: chunk.input }],
            };
          } else if (chunk.type === "tool_result") {
            next[i] = {
              ...last,
              toolCalls: last.toolCalls.map((tc) =>
                tc.id === chunk.id ? { ...tc, ok: chunk.ok, output: chunk.output } : tc,
              ),
            };
          } else if (chunk.type === "error") {
            next[i] = { ...last, content: last.content + `\n[错误] ${chunk.message}`, streaming: false };
          } else if (chunk.type === "done") {
            next[i] = { ...last, streaming: false };
          }
          return next;
        });
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((ms) => {
          const next = [...ms];
          const i = next.length - 1;
          const last = next[i]!;
          next[i] = { ...last, content: last.content + `\n[请求失败] ${(err as Error).message}`, streaming: false };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <div className="chat-root">
      <header className="chat-header">
        <strong>{agent.name}</strong>
        <span className="muted">会话 {sessionId}</span>
        <SessionSettings sessionId={sessionId} agent={agent} />
      </header>

      <div className="chat-body">
        {loadingHistory && <p className="muted">加载历史…</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" && m.toolCalls.length > 0 && (
              <div className="tool-calls">
                {m.toolCalls.map((tc) => (
                  <details key={tc.id} className="tool-card">
                    <summary>
                      🔧 {tc.name}{" "}
                      {tc.ok !== undefined && <span className={tc.ok ? "ok" : "fail"}>{tc.ok ? "✓" : "✗"}</span>}
                    </summary>
                    <div className="tool-input">
                      <div className="label">入参</div>
                      <pre>{formatOutput(tc.input)}</pre>
                    </div>
                    {tc.ok !== undefined && (
                      <div className="tool-output">
                        <div className="label">结果</div>
                        <pre>{tc.ok ? formatOutput(tc.output) : `失败: ${formatOutput(tc.output)}`}</pre>
                      </div>
                    )}
                  </details>
                ))}
              </div>
            )}
            <div className="bubble">{m.content || (m.streaming ? "…" : "")}</div>
            {m.streaming && <span className="cursor">▍</span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

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
