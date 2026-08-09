import { z } from "zod";
import type { AgentConfig } from "../types.js";

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
  memory: z
    .object({
      strategy: z.enum(["none", "window", "compaction"]),
      maxMessages: z.number().int().positive().optional(),
      thresholdPercent: z.number().min(0).max(1).optional(),
    })
    .optional(),
  maxIterations: z.number().int().min(1).optional(),
  temperature: z.number().optional(),
});

/** 校验并返回规范化配置；非法配置直接抛错（编程/配置错误） */
export function validateAgentConfig(input: unknown): AgentConfig {
  return agentConfigSchema.parse(input);
}
