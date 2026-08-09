/**
 * 内核统一类型（语言无关契约的 TS 侧表达，见 contracts/）
 * 注意：此文件只含类型，零运行时依赖。
 */

/** 统一 LLM 消息角色 */
export type LLMRole = "system" | "user" | "assistant" | "tool";

/** 统一 LLM 消息（屏蔽 OpenAI / Anthropic 协议差异） */
export interface LLMMessage {
  role: LLMRole;
  content: string;
  /** assistant 消息发起的工具调用（M1 起使用） */
  toolCalls?: ToolCall[];
  /** tool 消息回执对应哪个工具调用 */
  toolCallId?: string;
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  /** 解析后的参数对象 */
  input: unknown;
}

/**
 * 统一流式 chunk（内核 → 上层 / 前端，契约见 contracts/stream-protocol.md）
 * 顺序约定：text / tool_call 实时；tool_call 在 provider 流结束后聚合发出；
 * usage 在 done 前；done 永远最后。
 */
export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; output: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "done" };

/** 工具定义（M1 会扩展 execute / meta 等字段） */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（发给 LLM 的格式） */
  inputSchema: Record<string, unknown>;
}

/** Provider 运行时配置 —— 每次 chat 调用可传不同值，天然支持动态配置 */
export interface ProviderConfig {
  provider: "openai-compatible" | "anthropic";
  /** 默认：openai-compatible → https://api.openai.com/v1；anthropic → https://api.anthropic.com */
  baseUrl?: string;
  modelId: string;
  /** 缺省时 openai-compatible 用占位符 "not-needed"（Ollama/LM Studio）；anthropic 必填 */
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** 附加请求头（透传） */
  extraHeaders?: Record<string, string>;
}
