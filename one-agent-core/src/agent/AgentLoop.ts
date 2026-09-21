import type { Agent } from "./Agent.ts";
import type { AgentConfig, LLMMessage, ProviderConfig, StreamChunk, ToolCall, ToolContext, ToolResult, ToolSpec } from "../types.ts";
import { buildContextMessages, compactMessages, estimateMessagesTokens, trimMessages } from "../memory/index.ts";
import { buildSystemPrompt } from "./planning.ts";
import { findLatestPlan } from "../plan/planFiles.ts";
import { scheduleToolBatch } from "./toolBatchScheduler.ts";
import { createToolGuardrails, type GuardrailDecision } from "./toolGuardrails.ts";

export interface RunOptions {
  /** 每轮会话/请求级模型覆盖 → 动态切换模型的核心入口 */
  modelOverride?: Partial<ProviderConfig>;
  /** 每轮工具启用开关覆盖 */
  toolOverrides?: Array<{ name: string; enabled: boolean }>;
  sessionId?: string;
  signal?: AbortSignal;
  /**
   * 工具执行上下文的工作目录（文件类工具的相对路径基准）。
   * 不传时回落 process.cwd() —— 应用层应显式传入会话工作区（如 data/workspace/{sessionId}）
   */
  cwd?: string;
  /** 可观测/审计 hook：每次工具调用前触发 */
  onToolCall?: (call: ToolCall) => void | Promise<void>;
  /**
   * 危险工具审批 hook：工具标记 meta.dangerous 时调用。
   * 返回 false → 拒绝执行（tool_result ok:false "已拒绝"）。
   * 不提供则危险工具直接执行（默认放行）。
   */
  onApproval?: (call: ToolCall, tool: ToolSpec) => boolean | Promise<boolean>;
  /**
   * 上下文压缩的摘要持有者（由 Agent.run 从 meta.compaction.summaries 载入并回写）。
   * 摘要属于「发给模型的上下文」，不属于会话记录 —— 原文消息不会被删除。
   */
  compaction?: { summaries: string[] };
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
  // 工具调用守卫：一轮一个控制器（纯观察 + 决策，无副作用），配置来自 config.toolGuardrails
  const guardrails = createToolGuardrails(config.toolGuardrails);

  // 注入 system 指令（messages 里还没有 system 时），保证 persona/指令/规划规程始终生效
  const systemContent = buildSystemPrompt(config);
  if (systemContent && !messages.some((m) => m.role === "system")) {
    messages.unshift({ role: "system", content: systemContent });
  }

  const modelConfig: ProviderConfig = {
    ...config.model,
    ...(config.temperature !== undefined && config.model.temperature === undefined
      ? { temperature: config.temperature }
      : {}),
    ...opts.modelOverride,
  };

  // 空响应守卫计数（连续空响应次数；一旦有产出即归零）
  let emptyRetries = 0;
  // 整轮累计（供最终 usage chunk）；turnUsage 为单次 LLM 调用用量（随 assistant 消息持久化）
  const usageTotal = { input: 0, output: 0, cached: 0, cacheCreation: 0 };
  let turnUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 };

  // 历史摘要（压缩产物的载体）：只影响发给模型的上下文，会话记录里的原文不动
  const compaction = opts.compaction ?? { summaries: [] };

  for (let i = 0; i < maxIter; i++) {
    // 记忆：compaction 触发检查（基于「发给模型的上下文视图」估算 token；首轮也有数据时同样生效）
    if (config.memory?.strategy === "compaction") {
      const windowTokens = config.memory.contextWindowTokens ?? 32_000;
      const threshold = Math.max(100, (config.memory.thresholdPercent ?? 0.75) * windowTokens);
      if (estimateMessagesTokens(buildContextMessages(messages, compaction.summaries)) > threshold) {
        const result = await compactMessages({ provider: agent.provider, modelConfig, messages });
        // P1-c：压缩成功后把「任务清单（未完成项）+ 方案文档路径」重新注入 —— 否则模型会忘记进度、重做已完成的工作。
        // 以 user 角色（不改 system，保住 prompt cache 前缀）+ 合成标记（压缩时丢弃、前端隐藏）
        if (result) {
          compaction.summaries.push(result.summary);
          await injectContextSnapshot(agent, messages, opts);
        }
      }
    }

    const tools = resolveEnabledTools(agent, config, opts.toolOverrides);
    // 请求用的是压缩后的上下文视图（原文被标记 compacted 的消息由摘要代表）
    const stream = agent.provider.chat({
      messages: buildContextMessages(messages, compaction.summaries),
      tools,
      config: modelConfig,
      signal: opts.signal,
    });

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
    const isEmptyResponse = text.trim() === "" && toolCalls.length === 0;
    if (isEmptyResponse) {
      // 空响应守卫：模型既没输出文本、也没发起工具调用（本地小模型常见）。
      // 绝不能把空回答当成"最终答案"静默落库 —— 那会让整个会话看起来"没反应"。
      // 处理：追加一条催促消息重试（合成标记，压缩时丢弃、前端隐藏），超过上限则明确报错。
      const maxRetries = config.emptyResponseRetries ?? 2;
      if (emptyRetries < maxRetries) {
        emptyRetries++;
        messages.push({
          role: "user",
          content:
            "[系统] 你上一条回复是空的（既没有文字也没有工具调用）。请直接给出回答；" +
            "如果需要工具，请发起工具调用，不要只输出空白或仅思考。",
          synthetic: "emptyRetryNudge",
        });
        continue;
      }
      yield {
        type: "error",
        message: `模型连续 ${maxRetries + 1} 次返回空响应（既无文本也无工具调用），已停止本轮。可重试或更换模型。`,
      };
      return;
    }
    // 有产出了 → 清掉本轮的重试催促（它是脚手架，不该留在历史里：下一轮再看到
    // "[系统] 你上一条回复是空的" 会指向一个已经不空的轮次）
    if (emptyRetries > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.synthetic === "emptyRetryNudge") messages.splice(i, 1);
      }
    }
    emptyRetries = 0;

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

    // 距离上限还剩 1 轮时，提示模型停止探索、基于已有信息收尾（避免"读一半被掐断"）
    if (i >= maxIter - 2) {
      messages.push({
        role: "system",
        content:
          "[系统提示] 本轮之后迭代次数将耗尽。如果还有未完成的探索，请停止继续调用工具，直接基于已获取的信息给出总结或最终回答。",
      });
    }

    // 执行工具：调度器按路径重叠把批次切成有序段（段内并行、段间串行），结果按原始调用顺序回填。
    // 目的：同轮「读同一文件 + 写同一文件」「两次写同一文件」不再竞态；纯读批次仍保持并行。
    // 有状态工具（todo 等）通过 ctx.sessionId 拿到会话归属；Agent 实例是跨会话共享的
    const toolCtx: ToolContext = { cwd: opts.cwd, sessionId: opts.sessionId };
    // 先发出 tool_call 事件（保持顺序稳定），再执行
    for (const tc of toolCalls) {
      yield { type: "tool_call", id: tc.id, name: tc.name, input: tc.input };
      if (opts.onToolCall) await opts.onToolCall(tc);
    }

    const outcomes = new Array<ToolOutcome | undefined>(toolCalls.length);
    const indexOf = new Map<ToolCall, number>(toolCalls.map((tc, i) => [tc, i]));

    // 工具调用守卫（端口自 Hermes tool_guardrails）：执行前判定是否拦下这次调用。
    // 拦下 = 不执行，合成 ok:false 结果把原因交给模型（避免它沿同一条失败路径反复撞）。
    const blocked = new Map<ToolCall, GuardrailDecision>();
    let lastBlock: GuardrailDecision | null = null;
    guardrails.beginBatch();
    for (const tc of toolCalls) {
      const decision = guardrails.beforeCall(tc.name, tc.input);
      if (decision) {
        blocked.set(tc, decision);
        lastBlock = decision;
      }
    }

    const runToolCall = async (tc: ToolCall): Promise<void> => {
      const index = indexOf.get(tc);
      if (index === undefined) return;
      const decision = blocked.get(tc);
      if (decision) {
        outcomes[index] = guardrailOutcome(tc, decision);
        return;
      }
      outcomes[index] = await runSingleToolCall(agent, toolCtx, tc, opts);
    };

    for (const segment of scheduleToolBatch(toolCalls, { cwd: opts.cwd })) {
      if (segment.kind === "parallel") await Promise.all(segment.calls.map(runToolCall));
      else for (const tc of segment.calls) await runToolCall(tc);
    }

    for (const outcome of outcomes) {
      if (!outcome) continue;
      yield outcome.result;
      messages.push(outcome.message);
    }

    // 执行后观察（按原始调用顺序，保证并行段内计数稳定）：需要时注入引导文本。
    // 引导以合成消息追加（前端隐藏、压缩时丢弃），模型在下一轮看到「别重试」。
    const guidances: string[] = [];
    let haltReason: string | null = null;
    for (let index = 0; index < toolCalls.length; index++) {
      const tc = toolCalls[index]!;
      if (blocked.has(tc)) continue; // 被拦下的不参与"结果"统计（它没有结果）
      const outcome = outcomes[index];
      if (!outcome) continue;
      const result = outcome.result as Extract<StreamChunk, { type: "tool_result" }>;
      const decision = guardrails.afterCall(tc.name, tc.input, result.output, result.ok);
      if (!decision) continue;
      if (decision.action === "halt") haltReason = haltReason ?? decision.message;
      else guidances.push(decision.message);
    }
    if (guidances.length > 0) {
      messages.push({
        role: "user",
        content: `[系统] ${guidances.join("\n")}`,
        synthetic: "guardrailGuidance",
      });
    }
    if (haltReason === null && guardrails.shouldHalt) {
      haltReason = lastBlock?.message ?? "本轮重复无效调用过多，已停止。";
    }
    if (haltReason !== null) {
      yield { type: "text", delta: `\n\n[已停止] ${haltReason}` };
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

/** 单个工具调用的执行结果（按原始调用顺序回填） */
interface ToolOutcome {
  result: StreamChunk;
  message: LLMMessage;
}

/**
 * 压缩后重新注入上下文快照（P1-c）：把「未完成的任务清单」+「方案文档路径」作为合成 user 消息追加到尾部。
 * - 幂等：先移除旧快照再追加，避免多次压缩堆积多份；
 * - 二者都无（没有活动清单、也没有方案）→ 不注入；
 * - 全部完成/未启用 todo 时旧快照已被 compactMessages 丢弃，不会再回到上下文。
 */
async function injectContextSnapshot(agent: Agent, messages: LLMMessage[], opts: RunOptions): Promise<void> {
  const parts: string[] = [];

  if (opts.sessionId) {
    const todos = await agent.todos.formatForInjection(opts.sessionId);
    if (todos) parts.push(todos);
  }
  if (opts.cwd) {
    const plan = await findLatestPlan(opts.cwd);
    if (plan) parts.push(`[方案文档] ${plan.path}\n（这是更早写的方案；需要回顾时用 read 读取，不要再从零重写一份。）`);
  }
  if (parts.length === 0) return;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.synthetic) messages.splice(i, 1);
  }
  messages.push({ role: "user", content: parts.join("\n\n"), synthetic: "contextSnapshot" });
}

/**
 * 执行单个工具调用：危险工具审批 → 执行 → 组装 tool_result / tool 消息。
 * 工具未注册、审批拒绝、执行抛错都转成 ok:false 的结果（不抛出），
 * 否则一个坏调用会让整轮 Promise.all 失败、进而中断对话。
 */
async function runSingleToolCall(
  agent: Agent,
  toolCtx: ToolContext,
  tc: ToolCall,
  opts: RunOptions,
): Promise<ToolOutcome> {
  const tool = agent.tools.get(tc.name);
  if (!tool) return failureOutcome(tc, `工具未注册：${tc.name}`);

  if (tool.meta?.dangerous && opts.onApproval) {
    const approved = await opts.onApproval(tc, tool);
    if (!approved) return failureOutcome(tc, "已拒绝：危险操作未获批准");
  }

  let result: ToolResult;
  try {
    result = await agent.tools.execute(toolCtx, tc);
  } catch (err) {
    return failureOutcome(tc, `工具 ${tc.name} 执行异常：${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    result: {
      type: "tool_result",
      id: tc.id,
      ok: result.ok,
      output: result.ok ? result.output : result.error,
    },
    message: {
      role: "tool",
      content: JSON.stringify(result.ok ? result.output : { error: result.error }),
      toolCallId: tc.id,
    },
  };
}

function failureOutcome(tc: ToolCall, reason: string): ToolOutcome {
  return {
    result: { type: "tool_result", id: tc.id, ok: false, output: reason },
    message: { role: "tool", content: JSON.stringify({ error: reason }), toolCallId: tc.id },
  };
}

/**
 * 守卫拦下某次调用时的合成结果：工具**没有执行**，把拦截原因交给模型。
 * output 里带 `guardrail` 标记 → 前端工具卡片能看到"被守卫拦下"而不是普通失败，
 * 也便于日后按决策码统计「哪类误用最多」。
 */
function guardrailOutcome(tc: ToolCall, decision: { code: string; count: number; message: string }): ToolOutcome {
  const output = { error: decision.message, guardrail: { code: decision.code, count: decision.count } };
  return {
    result: { type: "tool_result", id: tc.id, ok: false, output },
    message: { role: "tool", content: JSON.stringify(output), toolCallId: tc.id },
  };
}
