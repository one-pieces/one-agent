import type { Agent } from "./Agent.ts";
import type { AgentConfig, LLMMessage, ProviderConfig, StreamChunk, ToolCall, ToolSpec } from "../types.ts";
import { compactMessages, estimateMessagesTokens, trimMessages } from "../memory/index.ts";

export interface RunOptions {
  /** 每轮会话/请求级模型覆盖 → 动态切换模型的核心入口 */
  modelOverride?: Partial<ProviderConfig>;
  /** 每轮工具启用开关覆盖 */
  toolOverrides?: Array<{ name: string; enabled: boolean }>;
  sessionId?: string;
  signal?: AbortSignal;
  /** 可观测/审计 hook：每次工具调用前触发 */
  onToolCall?: (call: ToolCall) => void | Promise<void>;
  /**
   * 危险工具审批 hook：工具标记 meta.dangerous 时调用。
   * 返回 false → 拒绝执行（tool_result ok:false "已拒绝"）。
   * 不提供则危险工具直接执行（默认放行）。
   */
  onApproval?: (call: ToolCall, tool: ToolSpec) => boolean | Promise<boolean>;
}

/**
 * ReAct 风格 Agent 循环（自研）：
 *   模型调用 → 流式回传 text → 若返回 tool_call 则执行工具 → 结果回填 → 再调模型
 * 直到无工具调用（输出最终回答）或达到 maxIterations。
 *
 * 输出契约（contracts/stream-protocol.md）：
 *   text 实时；tool_call/tool_result 成对；usage 聚合一次；done 永远最后。
 */
export async function* agentLoop(
  agent: Agent,
  messages: LLMMessage[],
  opts: RunOptions = {},
): AsyncIterable<StreamChunk> {
  const config = agent.getConfig();
  const maxIter = config.maxIterations ?? 10;

  // 注入 system 指令（messages 里还没有 system 时），保证 persona/指令始终生效
  if (config.instructions && !messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: config.instructions });
  }

  const modelConfig: ProviderConfig = {
    ...config.model,
    ...(config.temperature !== undefined && config.model.temperature === undefined
      ? { temperature: config.temperature }
      : {}),
    ...opts.modelOverride,
  };

  // 整轮累计（供最终 usage chunk）；turnUsage 为单次 LLM 调用用量（随 assistant 消息持久化）
  const usageTotal = { input: 0, output: 0, cached: 0, cacheCreation: 0 };
  let turnUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };

  for (let i = 0; i < maxIter; i++) {
    // 记忆：compaction 触发检查（基于估算 token 数；首轮也有数据时同样生效）
    if (config.memory?.strategy === "compaction") {
      const windowTokens = config.memory.contextWindowTokens ?? 32_000;
      const threshold = Math.max(100, (config.memory.thresholdPercent ?? 0.75) * windowTokens);
      if (estimateMessagesTokens(messages) > threshold) {
        await compactMessages({ provider: agent.provider, modelConfig, messages });
        // 摘要失败则跳过本次压缩，继续正常调用
      }
    }

    const tools = resolveEnabledTools(agent, config, opts.toolOverrides);
    const stream = agent.provider.chat({ messages, tools, config: modelConfig, signal: opts.signal });

    let text = "";
    const toolCalls: ToolCall[] = [];

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text":
          text += chunk.delta;
          yield chunk;
          break;
        case "tool_call":
          toolCalls.push({ id: chunk.id, name: chunk.name, input: chunk.input });
          break;
        case "usage":
          usageTotal.input += chunk.inputTokens;
          usageTotal.output += chunk.outputTokens;
          usageTotal.cached += chunk.cachedTokens ?? 0;
          usageTotal.cacheCreation += chunk.cacheCreationTokens ?? 0;
          turnUsage.inputTokens += chunk.inputTokens;
          turnUsage.outputTokens += chunk.outputTokens;
          turnUsage.cachedTokens += chunk.cachedTokens ?? 0;
          turnUsage.cacheCreationTokens += chunk.cacheCreationTokens ?? 0;
          break;
        case "error":
          yield chunk;
          return;
        case "done":
        case "tool_result":
          break; // provider 单次调用结束标记/不应出现，loop 统一处理
      }
    }

    // assistant 消息（含工具调用）入历史 —— 无论是否带工具调用，保证多轮连续性；
    // 附带本轮 LLM 调用用量 → 随会话持久化（前端刷新后恢复统计）
    messages.push({
      role: "assistant",
      content: text,
      toolCalls,
      ...(turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0 ? { usage: { ...turnUsage } } : {}),
    });
    turnUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };

    // 无工具调用 → 回答完成
    if (toolCalls.length === 0) {
      yield {
        type: "usage",
        inputTokens: usageTotal.input,
        outputTokens: usageTotal.output,
        cachedTokens: usageTotal.cached,
        cacheCreationTokens: usageTotal.cacheCreation,
      };
      yield { type: "done" };
      return;
    }

    // 执行工具（当前串行；可后续并行化）
    for (const tc of toolCalls) {
      yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
      if (opts.onToolCall) await opts.onToolCall(tc);

      const tool = agent.tools.get(tc.name);
      const isDangerous = tool?.meta?.dangerous ?? false;
      if (isDangerous && opts.onApproval) {
        const approved = await opts.onApproval(tc, tool!);
        if (!approved) {
          const reason = "已拒绝：危险操作未获批准";
          yield { type: "tool_result", id: tc.id, ok: false, output: reason };
          messages.push({ role: "tool", content: JSON.stringify({ error: reason }), toolCallId: tc.id });
          continue;
        }
      }

      const result = await agent.tools.execute({}, tc);
      yield {
        type: "tool_result",
        id: tc.id,
        ok: result.ok,
        output: result.ok ? result.output : result.error,
      };
      messages.push({
        role: "tool",
        content: JSON.stringify(result.ok ? result.output : { error: result.error }),
        toolCallId: tc.id,
      });
    }

    // 记忆：窗口裁剪（window 策略）
    trimMessages(messages, config);
  }

  yield { type: "error", message: `max iterations reached (${maxIter})` };
}

function resolveEnabledTools(
  agent: Agent,
  config: AgentConfig,
  overrides?: RunOptions["toolOverrides"],
): ToolSpec[] {
  const overrideMap = new Map((overrides ?? []).map((o) => [o.name, o.enabled]));
  return config.tools
    .filter((t) => overrideMap.get(t.name) ?? t.enabled)
    .map((t) => agent.tools.get(t.name))
    .filter((t): t is ToolSpec => t !== undefined);
}
