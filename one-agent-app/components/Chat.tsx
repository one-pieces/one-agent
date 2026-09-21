"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckCircle2Icon,
  ClockIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { consumeSSE } from "@/lib/sse-client";
import SessionSettings from "@/components/SessionSettings";
import { codePlugin } from "@/lib/code-theme";
import {
  applyChunk,
  toUiMessages,
  uid,
  type ToolStatus,
  type UiMessage,
  type UiToolCall,
} from "@/lib/chat-messages";
import type { AgentConfig, Message as PersistedMessage } from "@one-agent/core";

/** 代码块插件：cjk（中文断行）+ code（shiki 高亮，配色对齐 streamdown 文档站，见 lib/code-theme.ts） */
const markdownPlugins = { cjk, code: codePlugin };
/** 代码块控制项/文案：只留复制（去掉下载），按钮文案随本项目中文界面 */
const codeBlockControls = { code: { copy: true, download: false } };
const codeBlockTranslations = { copyCode: "复制", copied: "已复制" };

export type { ToolStatus, UiMessage, UiToolCall };

/** 方案文档（会话工作区 .oneagent/plans/ 里最新的一份） */
interface PlanInfo {
  path: string;
  content: string;
  updatedAt: string;
}

/** 入参/结果最大展示长度（超出部分截断，避免长文件读取撑爆卡片） */
const TOOL_TEXT_LIMIT = 1800;

/**
 * 工具调用代码块的最大高度（px）—— 用 streamdown 内置的 codeBlockMaxHeight（2.6.0+，
 * 默认 400px），超出部分在块内纵向滚动；消息气泡里传 0 表示不限高。
 */
const TOOL_CODE_MAX_HEIGHT = 420;

/** 任意值 → 展示文本（对象按 2 空格缩进 JSON 化，便于阅读） */
function stringifyToolValue(o: unknown): string {
  if (typeof o === "string") return o;
  try {
    const s = JSON.stringify(o, null, 2);
    return s === undefined ? String(o) : s;
  } catch {
    return String(o);
  }
}

function toToolText(o: unknown): { text: string; truncated: boolean; language: string } {
  const raw = stringifyToolValue(o);
  const truncated = raw.length > TOOL_TEXT_LIMIT;
  return {
    text: truncated ? raw.slice(0, TOOL_TEXT_LIMIT) : raw,
    truncated,
    language: sniffLanguage(raw, truncated),
  };
}

/** 内容像 JSON（对象/数组字面量）→ 标为 json；截断后无法整体解析时按首字符判断 */
function sniffLanguage(raw: string, truncated: boolean): string {
  const t = raw.trim();
  if (!/^[[{]/.test(t)) return "text";
  if (truncated) return "json";
  try {
    JSON.parse(t);
    return "json";
  } catch {
    return "text";
  }
}

/** 内容包成 Markdown 围栏代码块；围栏长度取「内容里最长反引号串 + 1」，避免内容自带 ``` 提前闭合 */
function fenced(text: string, language: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** 工具调用的入参/结果：Markdown 围栏代码块 → Streamdown（@streamdown/code 高亮 + 复制按钮） */
function ToolContent({ value, error }: { value: unknown; error?: boolean }) {
  const { text, truncated, language } = useMemo(() => toToolText(value), [value]);
  return (
    <div className={error ? "tool-code tool-code-error" : "tool-code"}>
      <Streamdown
        plugins={markdownPlugins}
        controls={codeBlockControls}
        translations={codeBlockTranslations}
        /* 内联 max-height 由 streamdown 自己加；纵向滚动仍靠 globals.css 的 overflow-y（它的 overflow-y-auto 是 tailwind 类，本项目不生效） */
        codeBlockMaxHeight={TOOL_CODE_MAX_HEIGHT}
      >
        {fenced(text, language)}
      </Streamdown>
      {truncated && <div className="tool-code-note">已截断，仅显示前 {TOOL_TEXT_LIMIT} 字符</div>}
    </div>
  );
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
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /** 拉取最新方案文档（agent 用 plan 工具写出后会出现） */
  const loadPlan = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/plan`);
      if (!res.ok) return;
      const data = (await res.json()) as { plan?: PlanInfo | null };
      setPlan(data.plan ?? null);
    } catch {
      /* 面板是可选增强，失败静默 */
    }
  }, [sessionId]);

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

  // 加载方案文档（与历史并行）
  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

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
        setMessages(toUiMessages(session.messages));

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
        // usage / error 是独立的 setState，不能放在 setMessages updater 内：
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
        if (chunk.type === "error") setErrorBanner(chunk.message);
        setMessages((ms) => applyChunk(ms, chunk));
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
      // 本轮可能刚写入方案文档（plan 工具）→ 刷新面板
      void loadPlan();
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

      {plan && (
        <details className="plan-panel">
          <summary>
            <span className="plan-panel-title">📋 方案文档</span>
            <code className="plan-panel-path">{plan.path}</code>
            <span className="muted plan-panel-time">{new Date(plan.updatedAt).toLocaleString()}</span>
          </summary>
          <div className="plan-panel-body">
            <div className="bubble">
              <Streamdown
                plugins={markdownPlugins}
                controls={codeBlockControls}
                translations={codeBlockTranslations}
                codeBlockMaxHeight={0}
              >
                {plan.content}
              </Streamdown>
            </div>
          </div>
        </details>
      )}

      <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
        {loadingHistory && <p className="muted">加载历史…</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="msg-content">
              {(m.content || m.streaming) && (
                <div className="bubble">
                  <Streamdown
                    plugins={markdownPlugins}
                    controls={codeBlockControls}
                    translations={codeBlockTranslations}
                    /* 消息里的代码块不限高（0 = 关闭内置的 400px 默认限高），保持原有阅读体验 */
                    codeBlockMaxHeight={0}
                  >
                    {m.content || (m.streaming ? "…" : "")}
                  </Streamdown>
                  {m.streaming && <span className="cursor">▍</span>}
                </div>
              )}
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
                        <ToolContent value={tc.input} />
                      </div>
                      {tc.status !== "running" && (
                        <div className="tool-output">
                          <div className="label">结果</div>
                          {tc.status === "denied" ? (
                            <p className="tool-denied-note">
                              危险操作未获批准（可在右上角会话覆盖中开启「允许危险工具」后重试）
                            </p>
                          ) : (
                            <ToolContent value={tc.output} error={tc.status === "error"} />
                          )}
                        </div>
                      )}
                    </details>
                  ))}
                </div>
              )}
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
        <div className="chat-footer-inner">
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
        </div>
      </footer>
    </div>
  );
}
