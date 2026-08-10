import type { LLMRole, ToolCall, TokenUsage } from "../types.ts";

/** 会话中的一条消息（带 id/时间戳，可持久化） */
export interface Message {
  id: string;
  role: LLMRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: string;
  /** 该条消息消耗的 token 用量（assistant 消息由 AgentLoop 写入，随会话持久化） */
  usage?: TokenUsage;
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
