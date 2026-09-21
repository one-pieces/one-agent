import { z } from "zod";
import type { AgentConfig } from "../types.ts";

/** AgentConfig 的 zod schema（与 contracts/agent-config.schema.json 对应） */
export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string(),
  model: z.object({
    provider: z.enum(["openai-compatible", "anthropic"]),
    baseUrl: z.string().optional(),
    modelId: z.string().min(1),
    apiKey: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    extraHeaders: z.record(z.string(), z.string()).optional(),
  }),
  tools: z.array(z.object({ name: z.string().min(1), enabled: z.boolean() })),
  knowledgeBaseIds: z.array(z.string().min(1)).optional(),
  memory: z
    .object({
      strategy: z.enum(["none", "window", "compaction"]),
      maxMessages: z.number().int().positive().optional(),
      thresholdPercent: z.number().min(0).max(1).optional(),
      contextWindowTokens: z.number().int().positive().optional(),
    })
    .optional(),
  maxIterations: z.number().int().min(1).optional(),
  temperature: z.number().optional(),
  planning: z
    .object({
      mode: z.enum(["off", "prompt"]),
      guidance: z.string().optional(),
    })
    .optional(),
  emptyResponseRetries: z.number().int().min(0).max(5).optional(),
  toolGuardrails: z
    .object({
      enabled: z.boolean().optional(),
      warnAfter: z.number().int().min(1).max(10).optional(),
      blockAfter: z.number().int().min(1).max(10).optional(),
      haltAfterBlocks: z.number().int().min(1).max(10).optional(),
      maxWebSearches: z.number().int().min(1).max(1000).optional(),
      idempotentTools: z.array(z.string()).optional(),
      failureTolerantTools: z.array(z.string()).optional(),
    })
    .optional(),
});

/** 校验并返回规范化配置；非法配置直接抛错（编程/配置错误） */
export function validateAgentConfig(input: unknown): AgentConfig {
  return agentConfigSchema.parse(input);
}
