import type { LLMRole, ToolCall } from "../types.ts";

/** 会话中的一条消息（带 id/时间戳，可持久化） */
export interface Message {
  id: string;
  role: LLMRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 会话（持久化单位） */
export interface Session {
  id: string;
  agentId: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  meta?: Record<string, unknown>;
}
