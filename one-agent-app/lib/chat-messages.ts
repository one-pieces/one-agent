import type { Message as PersistedMessage, StreamChunk } from "@one-agent/core";

/**
 * 对话流的 UI 数据模型与纯函数归约器（无 React 依赖，可单测）。
 *
 * 顺序约定（与内核 AgentLoop / 落库结构一致）：
 *   一次 LLM 调用 = 一条 assistant 消息 = 「文本」在前、「本次调用的工具卡片」在后；
 *   上一轮工具全部返回后到来的增量属于下一轮调用 → 另起一条消息。
 * 这样文本与工具卡按真实发生顺序交替，而不是把整轮的工具卡都堆在消息开头
 * （历史回放与实时流式渲染结果一致）。
 */

export type ToolStatus = "running" | "done" | "error" | "denied" | "blocked";

export interface UiToolCall {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
  /** 被工具调用守卫拦下（工具未执行）时的决策信息 → 卡片显示"被拦下 + 原因" */
  guardrail?: { code: string; count: number };
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: UiToolCall[];
  streaming?: boolean;
  /** 已被上下文压缩覆盖（原文仍在，模型看到的是摘要）→ 界面在其后画一条分隔提示 */
  compacted?: true;
}

export const DENIED_TEXT = "已拒绝";

/**
 * 从工具结果里取出守卫标记（内核在拦下某次调用时写入 `{ error, guardrail: { code, count } }`）。
 * 结果可能是对象（正常路径）或 JSON 字符串（历史回放）。
 */
export function guardrailOf(output: unknown): { code: string; count: number } | undefined {
  let value: unknown = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const g = (value as { guardrail?: unknown }).guardrail;
  if (!g || typeof g !== "object") return undefined;
  const code = (g as { code?: unknown }).code;
  const count = (g as { count?: unknown }).count;
  if (typeof code !== "string") return undefined;
  return { code, count: typeof count === "number" ? count : 0 };
}

/** 工具结果里给人看的错误文本（守卫拦下时就是拦截原因） */
export function toolErrorText(output: unknown): string {
  let value: unknown = output;
  if (typeof output === "string") {
    try {
      value = JSON.parse(output);
    } catch {
      return output; // 不是 JSON 就直接把原文当错误文本
    }
  }
  if (value && typeof value === "object") {
    const err = (value as { error?: unknown }).error;
    if (typeof err === "string") return err;
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return typeof output === "string" ? output : "";
}

export function uid(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 工具结果 → 展示状态（"已拒绝" = 审批被拒；"blocked" = 被工具调用守卫拦下） */
export function toolStatusFromResult(ok: boolean, output: unknown): ToolStatus {
  if (!ok && carriesDeniedText(output)) return "denied";
  if (!ok && guardrailOf(output)) return "blocked";
  return ok ? "done" : "error";
}

/**
 * 输出里是否带"已拒绝"标记。
 * 工具结果是**对象**（如 `{ error: "已拒绝：危险操作未获批准" }`），直接 String()
 * 会得到 "[object Object]" → 判定永远不成立，所以这里先序列化再匹配。
 */
function carriesDeniedText(output: unknown): boolean {
  if (typeof output === "string") return output.includes(DENIED_TEXT);
  try {
    return (JSON.stringify(output) ?? "").includes(DENIED_TEXT);
  } catch {
    return String(output).includes(DENIED_TEXT);
  }
}

/**
 * 上一轮 LLM 调用是否已结束（有工具调用且全部拿到结果）。
 * AgentLoop 只在单次模型调用结束后发出 tool_call / tool_result，
 * 所以「工具全部返回」= 该轮结束；之后到来的 text/tool_call 属于下一轮调用。
 */
export function iterationFinished(m: UiMessage | undefined): boolean {
  return !!m && m.toolCalls.length > 0 && m.toolCalls.every((tc) => tc.status !== "running");
}

/** 把单个流事件应用到消息列表（纯函数：同样输入 → 同样输出） */
export function applyChunk(ms: UiMessage[], chunk: StreamChunk): UiMessage[] {
  const next = [...ms];
  const last = next[next.length - 1];
  if (!last) return next;

  // 新一轮调用的起始事件 → 另起一条 assistant 消息（上一轮置为非流式）
  if ((chunk.type === "text" || chunk.type === "tool_call") && iterationFinished(last)) {
    next[next.length - 1] = { ...last, streaming: false };
    next.push({ id: uid(), role: "assistant", content: "", toolCalls: [], streaming: true });
  }

  const i = next.length - 1;
  const cur = next[i]!;
  if (chunk.type === "text") {
    next[i] = { ...cur, content: cur.content + chunk.delta };
  } else if (chunk.type === "tool_call") {
    next[i] = {
      ...cur,
      toolCalls: [...cur.toolCalls, { id: chunk.id, name: chunk.name, input: chunk.input, status: "running" }],
    };
  } else if (chunk.type === "tool_result") {
    // 结果归属持有该 tool_call 的那条消息（通常就是最后一条）
    const owner = next.findIndex((m) => m.toolCalls.some((tc) => tc.id === chunk.id));
    const k = owner >= 0 ? owner : i;
    const msg = next[k]!;
    next[k] = {
      ...msg,
      toolCalls: msg.toolCalls.map((tc) =>
        tc.id === chunk.id
          ? {
              ...tc,
              status: toolStatusFromResult(chunk.ok, chunk.output),
              output: chunk.output,
              ...(guardrailOf(chunk.output) ? { guardrail: guardrailOf(chunk.output)! } : {}),
            }
          : tc,
      ),
    };
  } else if (chunk.type === "done") {
    next[i] = { ...cur, streaming: false };
  }
  return next;
}

/**
 * 落库消息 → UI 消息（历史回放）。
 * 过滤 system/tool 消息与**合成消息**（如压缩后注入的 todo 快照 —— 内核产物，不代表用户输入）；
 * 工具结果按 toolCallId 回填到发起它的那条 assistant 消息。
 */
export function toUiMessages(messages: PersistedMessage[]): UiMessage[] {
  const toolResults = new Map<string, { ok: boolean; output: unknown }>();
  for (const m of messages) {
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
  return messages
    .filter((m) => !m.synthetic && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      ...(m.compacted ? { compacted: true as const } : {}),
      toolCalls: (m.toolCalls ?? []).map((tc) => {
        const r = toolResults.get(tc.id);
        const guardrail = r ? guardrailOf(r.output) : undefined;
        return {
          id: tc.id,
          name: tc.name,
          input: tc.input,
          status: r ? toolStatusFromResult(r.ok, r.output) : "running",
          output: r?.output,
          ...(guardrail ? { guardrail } : {}),
        };
      }),
    }));
}
