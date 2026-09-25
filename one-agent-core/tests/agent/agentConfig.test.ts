import { describe, it, expect } from "vitest";
import { validateAgentConfig } from "../../src/index.ts";

function baseConfig(extra?: Record<string, unknown>) {
  return {
    id: "cfg-agent",
    name: "契约测试",
    instructions: "你是测试助手。",
    model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1" },
    tools: [],
    ...extra,
  };
}

describe("AgentConfig 契约（zod）", () => {
  it("保留应用层扩展字段 providerId —— 宿主用它解析 model 连接，不能被子 schema strip 掉", () => {
    const validated = validateAgentConfig(baseConfig({ providerId: "provider-abc" })) as { providerId?: string };
    expect(validated.providerId).toBe("provider-abc");
  });

  it("providerId 可选：老配置（无该字段）依然合法", () => {
    expect(() => validateAgentConfig(baseConfig())).not.toThrow();
  });

  it("planning / toolGuardrails 可选；类型非法时明确报错", () => {
    expect(() => validateAgentConfig(baseConfig({ planning: { mode: "prompt" } }))).not.toThrow();
    expect(() => validateAgentConfig(baseConfig({ toolGuardrails: { enabled: true, warnAfter: 1, blockAfter: 3 } }))).not.toThrow();
    expect(() => validateAgentConfig(baseConfig({ planning: { mode: "不存在的模式" } }))).toThrow();
    expect(() => validateAgentConfig(baseConfig({ toolGuardrails: { enabled: true, warnAfter: -1 } }))).toThrow();
  });

  it("emptyResponseRetries 范围校验（0–5）", () => {
    expect(() => validateAgentConfig(baseConfig({ emptyResponseRetries: 2 }))).not.toThrow();
    expect(() => validateAgentConfig(baseConfig({ emptyResponseRetries: 9 }))).toThrow();
  });

  it("未知字段被忽略（前向兼容），已知字段不受影响", () => {
    const validated = validateAgentConfig(baseConfig({ 未来字段: 1 })) as Record<string, unknown>;
    expect(validated["未来字段"]).toBeUndefined();
    expect((validated.model as { modelId: string }).modelId).toBe("mock");
  });
});
