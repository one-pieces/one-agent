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
  /** assistant 消息发起的工具调用 */
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
 * 顺序约定：text 实时；tool_call / tool_result 成对；usage 在 done 前；done 永远最后。
 */
export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; output: unknown }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /** 缓存命中的输入 token 数（OpenAI prompt_tokens_details.cached_tokens / Anthropic cache_read_input_tokens） */
      cachedTokens?: number;
      /** 写入缓存的 token 数（Anthropic cache_creation_input_tokens，OpenAI 兼容一般无此值） */
      cacheCreationTokens?: number;
    }
  | { type: "error"; message: string }
  | { type: "done" };

/** 工具执行上下文 */
export interface ToolContext {
  cwd?: string;
  signal?: AbortSignal;
  /** 后续扩展：agentId / sessionId / 审批句柄 */
}

/** 工具执行结果 */
export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

/** 工具定义 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（发给 LLM 的格式） */
  inputSchema: Record<string, unknown>;
  execute(ctx: ToolContext, input: unknown): ToolResult | Promise<ToolResult>;
  meta?: {
    dangerous?: boolean;
    timeoutMs?: number;
    sandbox?: boolean;
  };
  /** 运行时入参校验器（由 defineTool 从 zod 生成），缺省则跳过校验 */
  validateInput?: (input: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
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

/** Agent 配置 —— 一等数据（JSON），可存 DB、可 UI 编辑、可运行时热更新 */
export interface AgentConfig {
  id: string;
  name: string;
  instructions: string;
  model: ProviderConfig;
  /** 工具启用开关（工具本体注册在 ToolRegistry） */
  tools: Array<{ name: string; enabled: boolean }>;
  memory?: {
    strategy: "none" | "window" | "compaction";
    maxMessages?: number;
    thresholdPercent?: number;
    contextWindowTokens?: number;
  };
  maxIterations?: number;
  /** 顶层温度，覆盖 model.temperature（model 未显式设置时生效） */
  temperature?: number;
}
