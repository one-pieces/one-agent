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

/**
 * Compaction：把「system 之后、最近 keepRecent 条之前」的历史消息
 * 用模型压缩成一条摘要（system 角色），替换原文。
 * 成功返回 true；摘要失败/无足够内容返回 false（调用方跳过本次压缩）。
 */
export async function compactMessages(opts: {
  provider: LanguageProvider;
  modelConfig: ProviderConfig;
  messages: LLMMessage[];
  keepRecent?: number;
}): Promise<boolean> {
  const { provider, modelConfig, messages, keepRecent = 6 } = opts;

  // 开头连续的 system 保留（instructions / 已有摘要）
  let prefix = 0;
  while (prefix < messages.length && messages[prefix]!.role === "system") prefix++;
  const cutEnd = Math.max(prefix, messages.length - keepRecent);
  // 派生消息（如压缩后注入的 todo 快照）不参与历史摘要：它们本身就是压缩的产物
  const toSummarize = messages.slice(prefix, cutEnd).filter((m) => !m.synthetic);
  if (toSummarize.length < 3) return false;

  const summaryPrompt: LLMMessage = {
    role: "system",
    content:
      "请把下面的对话历史压缩成简洁的中文摘要，保留关键信息：用户目标、已确认的事实、工具操作与结果、未完成的事项、重要约束。直接输出摘要，不要客套。",
  };
  const text = await collectText(provider.chat({ messages: [summaryPrompt, ...toSummarize], config: modelConfig }));
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 确认摘要可用后才改写历史：整段替换为摘要，并清掉范围内的派生消息
  messages.splice(prefix, cutEnd - prefix, {
    role: "system",
    content: `[历史对话摘要]\n${trimmed}`,
  });
  // 尾部若残留旧的派生消息（压缩前位于 keepRecent 窗口内）也一并丢弃：
  // AgentLoop 会在压缩成功后按最新状态重新注入（见 planning/todo 的 P1-c）
  dropSyntheticMessages(messages, prefix + 1);
  return true;
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
