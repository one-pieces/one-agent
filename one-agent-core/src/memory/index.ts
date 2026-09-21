import type { AgentConfig, LLMMessage, ProviderConfig, StreamChunk } from "../types.ts";
import type { LanguageProvider } from "../providers/index.ts";

/**
 * 粗略 token 估算：中文约 1 token/字，英文约 1 token/4 字符。
 * 用于 compaction 触发判断（provider 返回真实 usage 时更准，但首轮前无数据）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

export function estimateMessagesTokens(messages: LLMMessage[]): number {
  return estimateTokens(messages.map((m) => m.content).join("\n"));
}

/** 窗口裁剪：保留 system（开头）+ 最近 maxMessages 条 */
export function trimMessages(messages: LLMMessage[], config: AgentConfig): void {
  if (config.memory?.strategy !== "window" || !config.memory.maxMessages) return;
  const max = config.memory.maxMessages;
  if (messages.length <= max) return;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system").slice(-(max - system.length));
  messages.splice(0, messages.length, ...system, ...rest);
}

/** 摘要消息前缀（构建上下文时插在 system 之后） */
export const SUMMARY_PREFIX = "[历史对话摘要]";

/**
 * 构建**发给模型**的上下文视图：
 *   开头 system（instructions / 规划规程）+ 历史摘要（来自 meta.compaction.summaries）+ 未被压缩覆盖的消息
 *
 * 与 messages 的区别：会话记录（messages）保留全部原文（用户在消息列表里能看到完整对话），
 * 压缩只影响这里 —— 被摘要覆盖的消息以 `compacted` 标记跳过，由摘要代表。
 */
export function buildContextMessages(messages: LLMMessage[], summaries: readonly string[] = []): LLMMessage[] {
  const out: LLMMessage[] = [];
  let i = 0;
  // 开头的 system 逐条保留（instructions / 规划规程；含旧版本留下的摘要消息）
  while (i < messages.length && messages[i]!.role === "system") out.push(messages[i++]!);
  for (const summary of summaries) out.push({ role: "system", content: `${SUMMARY_PREFIX}\n${summary}` });
  for (; i < messages.length; i++) {
    const m = messages[i]!;
    if (!m.compacted) out.push(m);
  }
  return out;
}

/**
 * Compaction：把「system 之后、最近 keepRecent 条之前」的历史消息交给模型压缩成一段摘要。
 *
 * **不删除原文**：只在被覆盖的消息上打 `compacted` 标记，摘要返回给调用方存进
 * `meta.compaction.summaries`，构建请求时由 buildContextMessages 用摘要替换那一段。
 * 这样长对话的早期记录仍然留在会话里（前端可见），但送进模型窗口的上下文是有界的。
 *
 * 返回 null：摘要失败 / 可压缩内容不足（调用方跳过本次压缩，消息数组不被修改）。
 */
export async function compactMessages(opts: {
  provider: LanguageProvider;
  modelConfig: ProviderConfig;
  messages: LLMMessage[];
  keepRecent?: number;
}): Promise<{ summary: string } | null> {
  const { provider, modelConfig, messages, keepRecent = 6 } = opts;

  // 开头连续的 system 保留（instructions / 已有摘要）
  let prefix = 0;
  while (prefix < messages.length && messages[prefix]!.role === "system") prefix++;
  const cutEnd = Math.max(prefix, messages.length - keepRecent);
  // 派生消息（如压缩后注入的 todo 快照）不参与历史摘要：它们本身就是压缩的产物；
  // 已被上一轮摘要覆盖的部分也不再重复摘要
  const toSummarize = messages.slice(prefix, cutEnd).filter((m) => !m.synthetic && !m.compacted);
  if (toSummarize.length < 3) return null;

  const summaryPrompt: LLMMessage = {
    role: "system",
    content:
      "请把下面的对话历史压缩成简洁的中文摘要，保留关键信息：用户目标、已确认的事实、工具操作与结果、未完成的事项、重要约束。直接输出摘要，不要客套。",
  };
  const text = await collectText(provider.chat({ messages: [summaryPrompt, ...toSummarize], config: modelConfig }));
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 确认摘要可用后才打标记（原文保留）
  for (let i = prefix; i < cutEnd; i++) messages[i]!.compacted = true;
  // 尾部若残留旧的派生消息（压缩前位于 keepRecent 窗口内）也一并丢弃：
  // AgentLoop 会在压缩成功后按最新状态重新注入（见 planning/todo 的 P1-c）
  dropSyntheticMessages(messages, prefix + 1);
  return { summary: trimmed };
}

/** 移除 index >= from 的全部合成消息（派生数据，重写历史时一并丢弃）；返回移除条数 */
export function dropSyntheticMessages(messages: LLMMessage[], from = 0): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= from; i--) {
    if (messages[i]!.synthetic) {
      messages.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/** 消费流式响应，拼接文本（用于摘要等一次性调用）；忽略 usage/done */
async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === "text") text += chunk.delta;
    else if (chunk.type === "error") return "";
  }
  return text;
}
