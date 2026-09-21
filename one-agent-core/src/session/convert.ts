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
  };
}

/** 消息内容指纹（用于跨轮次稳定 id：内容没变就复用原 id） */
export function messageKey(m: LLMMessage): string {
  return `${m.role}\u0000${m.content}\u0000${JSON.stringify(m.toolCalls ?? null)}\u0000${m.toolCallId ?? ""}\u0000${m.synthetic ?? ""}`;
}

/** 内核 LLMMessage → 持久化 Message，尽量复用已有消息的 id/createdAt */
export function toMessageWithStableId(m: LLMMessage, existing: Message[], now: string): Message {
  const key = messageKey(m);
  const used = new Set<string>();
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
    createdAt: match?.createdAt ?? now,
  };
}
