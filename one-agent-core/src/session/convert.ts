import { randomUUID } from "node:crypto";
import type { LLMMessage } from "../types.ts";
import type { Message } from "./types.ts";

/** 持久化 Message → 内核 LLMMessage（去掉 id/时间戳） */
export function toLLMMessage(m: Message): LLMMessage {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    ...(m.synthetic ? { synthetic: m.synthetic } : {}),
    ...(m.compacted ? { compacted: true } : {}),
  };
}

/** 消息内容指纹（用于跨轮次稳定 id：内容没变就复用原 id） */
export function messageKey(m: LLMMessage): string {
  return `${m.role}\u0000${m.content}\u0000${JSON.stringify(m.toolCalls ?? null)}\u0000${m.toolCallId ?? ""}\u0000${m.synthetic ?? ""}`;
}

/**
 * 内核 LLMMessage → 持久化 Message，尽量复用已有消息的 id/createdAt（跨轮次 id 稳定 → prompt cache 命中）。
 *
 * `usedIds`：**同一次落库的整批消息共用一个集合**，用来避免"同一批里两条内容相同的消息复用到同一个 id"
 * （例如用户在同一会话重复发同一句话）—— 那会导致前端 React key 冲突、按 id 删消息一次删两条。
 */
export function toMessageWithStableId(m: LLMMessage, existing: Message[], now: string, usedIds?: Set<string>): Message {
  const key = messageKey(m);
  const used = usedIds ?? new Set<string>();
  const match = existing.find((e) => {
    if (used.has(e.id)) return false;
    if (messageKey(toLLMMessage(e)) === key) {
      used.add(e.id);
      return true;
    }
    return false;
  });
  return {
    id: match?.id ?? randomUUID(),
    role: m.role,
    content: m.content,
    ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.synthetic ? { synthetic: m.synthetic } : {}),
    ...(m.compacted ? { compacted: true } : {}),
    createdAt: match?.createdAt ?? now,
  };
}
