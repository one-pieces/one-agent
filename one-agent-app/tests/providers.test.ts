import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "@one-agent/core";
import { applyProviderModel, autoProviderName, providerOf, providerSummary, resolveAgentModel, snapshotAgentModel, validateProviderInput } from "../lib/providers";
import type { Provider } from "../lib/db";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "a1",
    name: "A",
    instructions: "",
    model: { provider: "openai-compatible", modelId: "m1", baseUrl: "https://old.example/v1", apiKey: "old-key" },
    tools: [],
    ...overrides,
  } as AgentConfig;
}

const provider: Provider = {
  id: "provider-1",
  name: "DeepSeek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  apiKey: "new-key",
  models: ["deepseek-chat", "deepseek-reasoner"],
  notes: "",
  createdAt: "",
  updatedAt: "",
};

describe("provider 摘要", () => {
  it("列表摘要不带明文密钥，只给 hasApiKey", () => {
    const s = providerSummary(provider);
    expect(s).not.toHaveProperty("apiKey");
    expect(s.hasApiKey).toBe(true);
    expect(providerSummary({ ...provider, apiKey: "" }).hasApiKey).toBe(false);
    expect(providerSummary(provider).name).toBe("DeepSeek");
  });
});

describe("agent ↔ provider 解析", () => {
  it("没有 providerId 时不改动配置（老 agent 行为不变）", () => {
    const before = agent();
    expect(snapshotAgentModel(before)).toEqual(before);
    expect(resolveAgentModel(before)).toEqual(before);
    expect(providerOf(before)).toBeNull();
  });

  it("providerId 指向不存在的供应商时按原配置运行（不炸、不改）", () => {
    const before = { ...agent(), providerId: "provider-does-not-exist" } as AgentConfig;
    expect(resolveAgentModel(before)).toEqual(before);
  });

  it("快照：把供应商的 kind/baseUrl/apiKey 写进 model，agent 自己的 modelId 保留", () => {
    const out = applyProviderModel(agent(), provider);
    expect(out.model).toMatchObject({ provider: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "new-key", modelId: "m1" });
  });

  it("快照：modelId 为空时用供应商登记的默认模型", () => {
    const out = applyProviderModel(agent({ model: { provider: "openai-compatible", modelId: "" } }), provider);
    expect(out.model.modelId).toBe("deepseek-chat");
  });

  it("运行时解析：供应商改地址/密钥立即生效（不用改 agent）", () => {
    const out = applyProviderModel(agent(), provider);
    expect(out.model.baseUrl).toBe("https://api.deepseek.com");
    expect(out.model.apiKey).toBe("new-key");
  });

  it("供应商没填密钥/地址时保留 agent 里已有的值（不清空可用配置）", () => {
    const out = applyProviderModel(agent(), { ...provider, apiKey: "", baseUrl: "" });
    expect(out.model.apiKey).toBe("old-key");
    expect(out.model.baseUrl).toBe("https://old.example/v1");
  });
});

describe("provider 输入校验", () => {
  it("必填与 URL 合法性", () => {
    expect(validateProviderInput({})).toMatchObject({ ok: false });
    expect(validateProviderInput({ name: "  " })).toMatchObject({ ok: false, error: "name 不能为空" });
    expect(validateProviderInput({ name: "X", baseUrl: "not a url" })).toMatchObject({ ok: false });
    expect(validateProviderInput({ name: "X", baseUrl: "https://api.deepseek.com" })).toMatchObject({ ok: true });
  });

  it("kind 白名单；partial 模式允许缺字段", () => {
    expect(validateProviderInput({ name: "X", baseUrl: "https://x.y", kind: "gemini" })).toMatchObject({ ok: false });
    expect(validateProviderInput({}, { partial: true })).toMatchObject({ ok: true });
    expect(validateProviderInput({ kind: "anthropic" }, { partial: true })).toMatchObject({ ok: true, value: { kind: "anthropic" } });
  });

  it("模型清单接受数组与多分隔符文本，去空去重保序", () => {
    const out = validateProviderInput({ models: "a, b\nc; a" }, { partial: true });
    expect(out).toMatchObject({ ok: true, value: { models: ["a", "b", "c"] } });
  });
});

describe("迁移自动命名", () => {
  it("本地端点与云端域名分别命名", () => {
    expect(autoProviderName("http://localhost:11434/v1", "openai-compatible")).toBe("本地模型（localhost:11434）");
    expect(autoProviderName("https://api.deepseek.com", "openai-compatible")).toBe("Deepseek（api.deepseek.com）");
    expect(autoProviderName("", "anthropic")).toBe("anthropic");
  });
});
