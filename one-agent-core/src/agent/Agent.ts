import type { AgentConfig, LLMMessage, StreamChunk } from "../types.ts";
import { createProvider, type LanguageProvider } from "../providers/index.ts";
import { ToolRegistry } from "../tools/index.ts";
import { validateAgentConfig } from "./config.ts";
import { agentLoop, type RunOptions } from "./AgentLoop.ts";
import {
  InMemorySessionStore,
  type Message,
  type Session,
  type SessionStore,
  toLLMMessage,
  toMessageWithStableId,
} from "../session/index.ts";

/**
 * Agent 实例：动态配置的一等公民。
 * - new Agent(config) / updateConfig(patch) → 运行时热更新
 * - run(input) → AsyncIterable<StreamChunk>，多轮工具调用循环
 * - 会话持久化走 SessionStore（默认内存，可换 SQLite/Postgres → 重启可恢复）
 */
export class Agent {
  private _config: AgentConfig;
  /** Provider 实例（无状态，可随时按 config 重建/替换） */
  provider: LanguageProvider;
  readonly tools: ToolRegistry;
  readonly sessionStore: SessionStore;

  constructor(
    config: AgentConfig,
    deps?: {
      provider?: LanguageProvider;
      tools?: ToolRegistry;
      sessionStore?: SessionStore;
      /** 注入自定义 fetch（日志/代理），缺省用全局 fetch */
      fetchFn?: typeof fetch;
    },
  ) {
    this._config = validateAgentConfig(config);
    this.provider =
      deps?.provider ?? createProvider(config.model.provider, deps?.fetchFn ? { fetch: deps.fetchFn } : undefined);
    this.tools = deps?.tools ?? new ToolRegistry();
    this.sessionStore = deps?.sessionStore ?? new InMemorySessionStore();
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
   * - input 为 string：从 SessionStore 加载历史，追加用户消息后运行
   * - input 为 LLMMessage[]：作为完整上下文直接运行（不合并历史，测试/定制用）
   * 运行完成后（含 done）自动持久化会话。
   */
  run(input: string | LLMMessage[], opts: RunOptions = {}): AsyncIterable<StreamChunk> {
    const agent = this;
    const sessionId = opts.sessionId ?? "default";
    const now = () => new Date().toISOString();

    return (async function* () {
      const existing = await agent.sessionStore.getSession(sessionId);
      const history: Message[] = existing?.messages ?? [];

      const messages: LLMMessage[] =
        typeof input === "string"
          ? [...history.map(toLLMMessage), { role: "user", content: input }]
          : input.map((m) => ({ ...m }));

      const loop = agentLoop(agent, messages, opts);
      for await (const chunk of loop) yield chunk;

      // 正常完成 → 持久化（含 system 指令、工具调用、摘要）
      const timestamp = now();
      const existingMeta = (existing?.meta ?? {}) as Record<string, unknown>;
      // 会话标题：首条用户消息前 60 字符（一次性生成）
      if (!existingMeta.title) {
        const firstUser = messages.find((m) => m.role === "user");
        if (firstUser?.content.trim()) existingMeta.title = firstUser.content.trim().slice(0, 60);
      }
      const session: Session = {
        id: sessionId,
        agentId: agent.getConfig().id,
        messages: messages.map((m) => toMessageWithStableId(m, history, timestamp)),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        meta: existingMeta,
      };
      await agent.sessionStore.saveSession(session);
    })();
  }

  /** 读取会话历史（持久化消息） */
  async getHistory(sessionId = "default"): Promise<Message[]> {
    const s = await this.sessionStore.getSession(sessionId);
    return s?.messages ?? [];
  }

  async clearSession(sessionId = "default"): Promise<void> {
    await this.sessionStore.deleteSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    return this.sessionStore.listSessions(this._config.id);
  }
}
