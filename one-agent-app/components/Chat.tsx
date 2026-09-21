"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  LibraryIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  NotebookPenIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { consumeSSE } from "@/lib/sse-client";
import SessionSettings from "@/components/SessionSettings";
import { codePlugin } from "@/lib/code-theme";
import {
  applyChunk,
  toUiMessages,
  toolErrorText,
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
function ToolContent({
  value,
  error,
  name,
  kind,
}: {
  value: unknown;
  error?: boolean;
  /** 工具名（用于按工具定制展示形式，如 bash 的终端行） */
  name?: string;
  kind?: "input" | "output";
}) {
  const { text, truncated, language } = useMemo(() => {
    // bash 的输入就是一条命令 → 渲染成 `$ ls -la` 的终端行（Devin 那种 shell 观感），
    // JSON 只在参数确实是结构化的场景下才更可读
    if (kind === "input" && name === "bash" && value && typeof value === "object") {
      const cmd = (value as Record<string, unknown>).command;
      if (typeof cmd === "string" && cmd.trim()) {
        return { text: `$ ${cmd.trim()}`, truncated: false, language: "bash" };
      }
    }
    // bash 的输出是 { stdout, stderr } 信封 → 还原成终端文本（否则展开看到的是转义过的 JSON）
    if (kind === "output" && name === "bash" && value && typeof value === "object") {
      const { stdout, stderr } = value as { stdout?: unknown; stderr?: unknown };
      const out = [typeof stdout === "string" ? stdout : "", typeof stderr === "string" ? stderr : ""]
        .filter((s) => s.trim())
        .join("\n");
      if (out.trim()) {
        const truncated = out.length > TOOL_TEXT_LIMIT;
        return { text: truncated ? out.slice(0, TOOL_TEXT_LIMIT) : out, truncated, language: "bash" };
      }
    }
    return toToolText(value);
  }, [value, name, kind]);
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

/**
 * 工具行图标：按动作语义选图标。折叠态一行一个动作、不显示工具名以外的装饰文字，
 * 靠图标表达"读了文件 / 跑了命令 / 搜了什么"（对齐 Devin 的动作流）。
 */
/**
 * 流式期间「正在做什么」（空串 = 不显示）。
 * 工具在执行 → 报工具名；还没有任何正文 → 表示在等模型（此刻消息区原本只有一个闪烁光标）。
 * 正文已经在流式输出时不显示（文末的光标已经够表达「还在写」）。
 */
function activityLabel(m: UiMessage): string {
  if (!m.streaming) return "";
  const running = m.toolCalls.filter((tc) => tc.status === "running").map((tc) => tc.name);
  if (running.length > 0) return `正在执行 ${running.join("、")}…`;
  return m.content ? "" : "正在思考…";
}

/** 耗时文案：<60s 显示 12s；≥60s 显示 1m20s */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * 流式 loading 行：旋转图标 + 文案 + 已用时长。
 * 计时以「阶段」为单位 —— label 一变（等模型 → 执行某个工具 → 下一个工具）即从 0 重新计，
 * 所以 12s 表示"这个阶段已经跑了 12 秒"，而不是整轮的总时长。
 */
function AgentWorking({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [label]);

  return (
    <div className="agent-working">
      <LoaderCircleIcon className="agent-working-icon" size={14} aria-hidden />
      <span>{label}</span>
      {/* 不足 1 秒不显示，避免刚发出就闪一个 0s */}
      {seconds >= 1 && <span className="agent-working-elapsed">{formatElapsed(seconds)}</span>}
    </div>
  );
}

const toolGlyphs: Record<string, typeof WrenchIcon> = {
  read: FileTextIcon,
  write: FilePenIcon,
  edit: FileDiffIcon,
  bash: TerminalIcon,
  grep: SearchIcon,
  find: SearchIcon,
  ls: FolderIcon,
  tree: FolderIcon,
  web_search: GlobeIcon,
  knowledge_search: LibraryIcon,
  todo: ListTodoIcon,
  plan: NotebookPenIcon,
};

/** 摘要取值的字段优先级：先看主参数（路径/命令/查询），再兜底任意字符串字段 */
const SUMMARY_KEYS = ["path", "paths", "command", "query", "pattern", "title", "url", "name", "action"];

/**
 * 折叠行的参数摘要：挑一个最有信息量的字段单行展示（超长由 CSS 省略号截断）。
 * bash 是命令行工具 → 加 `$ ` 前缀，读起来就是一条终端命令。
 */
function summarizeToolInput(name: string, input: unknown): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!obj) return typeof input === "string" ? input.replace(/\s+/g, " ").slice(0, 160) : "";
  let picked = "";
  for (const key of SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      picked = v.trim();
      break;
    }
    if (Array.isArray(v)) {
      const joined = v.filter((x): x is string => typeof x === "string").join(" ");
      if (joined) {
        picked = joined;
        break;
      }
    }
  }
  if (!picked) {
    const first = Object.values(obj).find((v) => typeof v === "string" && v.trim());
    picked = typeof first === "string" ? first.trim() : "";
  }
  if (!picked) return "";
  return (name === "bash" ? `$ ${picked}` : picked).replace(/\s+/g, " ").slice(0, 160);
}

/** 行尾状态：只留一个图标（文字进 title/aria-label），保持整行安静 */
const toolStatusMeta: Record<ToolStatus, { label: string; icon: typeof WrenchIcon }> = {
  running: { label: "执行中", icon: LoaderCircleIcon },
  done: { label: "完成", icon: CheckIcon },
  error: { label: "失败", icon: XIcon },
  denied: { label: "已拒绝", icon: ShieldAlertIcon },
  blocked: { label: "被守卫拦下（未执行）", icon: BanIcon },
};

function ToolState({ status }: { status: ToolStatus }) {
  const { label, icon: Icon } = toolStatusMeta[status];
  return (
    <span className={`tool-state tool-state-${status}`} title={label} aria-label={label}>
      <Icon size={13} />
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
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {/* 压缩边界：以上是被摘要覆盖的早期对话（原文保留、只是模型看到的是摘要） */}
            {!m.compacted && messages[i - 1]?.compacted && (
              <div className="history-divider" title="模型上下文里这部分已被摘要取代，原始记录仍保留在会话中">
                <span>早期对话已压缩为摘要（{messages.filter((x) => x.compacted).length} 条）</span>
              </div>
            )}
            <div className={`msg ${m.role}`}>
            <div className="msg-content">
              {m.content && (
                <div className="bubble">
                  <Streamdown
                    plugins={markdownPlugins}
                    controls={codeBlockControls}
                    translations={codeBlockTranslations}
                    /* 消息里的代码块不限高（0 = 关闭内置的 400px 默认限高），保持原有阅读体验 */
                    codeBlockMaxHeight={0}
                  >
                    {m.content}
                  </Streamdown>
                  {m.streaming && <span className="cursor">▍</span>}
                </div>
              )}
              {m.role === "assistant" && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((tc) => {
                    const Glyph = toolGlyphs[tc.name] ?? WrenchIcon;
                    const target = summarizeToolInput(tc.name, tc.input);
                    return (
                      <details key={tc.id} className="tool-card" open={tc.status === "running"}>
                        <summary>
                          <ChevronRightIcon className="tool-chevron" size={15} aria-hidden />
                          <Glyph className="tool-glyph" size={14} aria-hidden />
                          <span className="tool-verb">{tc.name}</span>
                          {target && <span className="tool-target">{target}</span>}
                          <ToolState status={tc.status} />
                        </summary>
                        <div className="tool-body">
                          <div className="tool-section">
                            <div className="tool-label">INPUT</div>
                            <ToolContent value={tc.input} name={tc.name} kind="input" />
                          </div>
                          {tc.status !== "running" && (
                            <div className="tool-section">
                              <div className="tool-label">OUTPUT</div>
                              {tc.status === "denied" ? (
                                <p className="tool-denied-note">
                                  危险操作未获批准（可在右上角会话覆盖中开启「允许危险工具」后重试）
                                </p>
                              ) : tc.status === "blocked" ? (
                                /* 被工具调用守卫拦下：工具没有执行，显示原因而不是一坨 JSON */
                                <p className="tool-guardrail-note">
                                  <ShieldAlertIcon size={12} aria-hidden />
                                  <span>{toolErrorText(tc.output)}</span>
                                  {tc.guardrail && <code>{`${tc.guardrail.code} ×${tc.guardrail.count}`}</code>}
                                </p>
                              ) : (
                                <ToolContent value={tc.output} error={tc.status === "error"} name={tc.name} kind="output" />
                              )}
                            </div>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}

              {/* 流式 loading：跟在正文/工具行之后（等模型 → 正在思考；执行工具 → 正在执行 xxx + 已用时长） */}
              {(() => {
                const label = activityLabel(m);
                return label ? <AgentWorking label={label} /> : null;
              })()}
            </div>
            </div>
          </Fragment>
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
        {/* 输入框下方：靠左的会话信息行（token 用量）。这一行始终占位，统计出现时不会顶动布局 */}
        <div className="chat-footer-meta">
          {(tokenUsage.input > 0 || tokenUsage.output > 0) && (
            <span className="token-badge" title="本会话累计 token 用量（◎ 缓存命中 / ＋ 缓存写入）">
              <span className="token-stat">↑{tokenUsage.input.toLocaleString()}</span>
              <span className="token-stat">↓{tokenUsage.output.toLocaleString()}</span>
              {tokenUsage.cached > 0 && <span className="token-stat">◎{tokenUsage.cached.toLocaleString()}</span>}
              {tokenUsage.cacheCreation > 0 && (
                <span className="token-stat">＋{tokenUsage.cacheCreation.toLocaleString()}</span>
              )}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
