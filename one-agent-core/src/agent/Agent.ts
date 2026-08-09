import type { AgentConfig, LLMMessage, StreamChunk } from "../types.js";
import { createProvider, type LanguageProvider } from "../providers/index.js";
import { ToolRegistry } from "../tools/index.js";
import { validateAgentConfig } from "./config.js";
import { agentLoop, type RunOptions } from "./AgentLoop.js";

/**
 * Agent 实例：动态配置的一等公民。
 * - new Agent(config) / updateConfig(patch) → 运行时热更新
 * - run(input) → AsyncIterable<StreamChunk>，多轮工具调用循环
 * - 每个实例持有独立 ToolRegistry + Provider
 */
export class Agent {
  private _config: AgentConfig;
  /** Provider 实例（无状态，可随时按 config 重建/替换） */
  provider: LanguageProvider;
  readonly tools: ToolRegistry;
  /** 临时内存会话（M1 用；M2 将替换为 SessionStore） */
  private conversations = new Map<string, LLMMessage[]>();

  constructor(
    config: AgentConfig,
    deps?: { provider?: LanguageProvider; tools?: ToolRegistry },
  ) {
    this._config = validateAgentConfig(config);
    this.provider = deps?.provider ?? createProvider(config.model.provider);
    this.tools = deps?.tools ?? new ToolRegistry();
  }

  getConfig(): AgentConfig {
    return structuredClone(this._config);
  }

  /** 运行时热更新配置（model/tools/instructions 均可动态改） */
  updateConfig(patch: Partial<AgentConfig>): void {
    const merged: AgentConfig = {
      ...this._config,
      ...patch,
      model: { ...this._config.model, ...patch.model },
      tools: patch.tools ?? this._config.tools,
    };
    this._config = validateAgentConfig(merged);
    // provider 类型变化 → 重建 provider 实例（无状态，安全）
    if (patch.model?.provider && patch.model.provider !== this.provider.kind) {
      this.provider = createProvider(this._config.model.provider);
    }
  }

  /**
   * 运行一轮对话。
   * - input 为 string：追加到当前会话（sessionId 默认 "default"）历史后运行
   * - input 为 LLMMessage[]：作为完整上下文直接运行（不合并历史，测试/定制用）
   */
  run(input: string | LLMMessage[], opts: RunOptions = {}): AsyncIterable<StreamChunk> {
    const sessionId = opts.sessionId ?? "default";
    const history = this.conversations.get(sessionId) ?? [];
    const messages: LLMMessage[] =
      typeof input === "string" ? [...history, { role: "user", content: input }] : input.map((m) => ({ ...m }));

    const loop = agentLoop(this, messages, opts);
    const agent = this;
    return (async function* () {
      for await (const chunk of loop) yield chunk;
      // 正常跑完（含 done）→ 保存会话；error/maxIterations 中断则不保存
      agent.conversations.set(sessionId, messages);
    })();
  }

  /** 查看某会话当前历史（临时内存会话，M2 会换 SessionStore） */
  getHistory(sessionId = "default"): LLMMessage[] {
    return structuredClone(this.conversations.get(sessionId) ?? []);
  }

  clearSession(sessionId = "default"): void {
    this.conversations.delete(sessionId);
  }
}
