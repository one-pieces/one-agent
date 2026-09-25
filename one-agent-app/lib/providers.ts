import type { AgentConfig } from "@one-agent/core";
import { db, newProviderId, type Provider } from "./db.ts";

/**
 * Provider 与 Agent 的关系（应用层语义，核心契约里的 `model` 仍是运行时真相）：
 *
 *   providers 表          agent.config.providerId（可选引用）
 *     ├─ kind          →     model.provider
 *     ├─ baseUrl       →     model.baseUrl
 *     ├─ apiKey        →     model.apiKey
 *     └─ models[]      →     只是 UI 候选清单；agent 自己的 model.modelId 才是选择
 *
 * - 保存 agent 时做一次**快照**（把 provider 的 kind/baseUrl/apiKey 写进 model）：
 *   这样其它直接读 agent 配置的路径（会话模型覆盖、脚本、导出）拿到的仍是完整配置。
 * - 运行时再**解析**一次（[`resolveAgentModel`]）：provider 改了密钥/地址，所有引用它的
 *   agent 立即生效，不用逐个改 agent。
 * - 不引用 provider 的老 agent（providerId 为空）行为完全不变。
 */

/** 应用层扩展字段：agent 引用的 provider id（核心运行时忽略，由应用解析成 model.*） */
export type AgentConfigWithProvider = AgentConfig & { providerId?: string };

/** 取 agent 引用的 provider（不存在则 null） */
export function providerOf(config: AgentConfig): Provider | null {
  const id = (config as AgentConfigWithProvider).providerId;
  if (!id) return null;
  return db.getProvider(id);
}

/**
 * 纯函数：把供应商的连接信息套到 agent 配置上（**保存快照**与**运行时解析**共用同一规则，
 * 两条路径行为一致，不会出现"存进去的"和"跑起来的"不一样）。
 * - kind / baseUrl / apiKey 以供应商为准
 * - provider 的 baseUrl 或密钥为空 → 保留 agent 里的旧值（"只是没填"不该把能用的配置清空）
 * - modelId 是 agent 自己的选择（为空时回落到供应商登记的默认模型）
 */
export function applyProviderModel(config: AgentConfig, provider: Provider): AgentConfigWithProvider {
  const model = { ...config.model };
  model.provider = provider.kind;
  if (provider.baseUrl) model.baseUrl = provider.baseUrl;
  if (provider.apiKey) model.apiKey = provider.apiKey;
  if (!model.modelId && provider.models[0]) model.modelId = provider.models[0];
  return { ...config, model } as AgentConfigWithProvider;
}

/** 保存前快照：有 providerId 时把供应商配置写进 model（其它读取路径拿到的仍是完整配置） */
export function snapshotAgentModel(config: AgentConfig): AgentConfigWithProvider {
  const provider = providerOf(config);
  return provider ? applyProviderModel(config, provider) : (config as AgentConfigWithProvider);
}

/** 运行前解析：供应商改了密钥/地址，引用它的 agent 立即生效（不用逐个改 agent） */
export function resolveAgentModel(config: AgentConfig): AgentConfig {
  return snapshotAgentModel(config);
}

/** 迁移时按端点起个能认出来的名字（用户可随时改） */
export function autoProviderName(baseUrl: string, kind: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
  }
  if (!host) return kind;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|$)/.test(host)) return `本地模型（${host}）`;
  const label = host.replace(/^api\./, "").split(".")[0];
  return `${label.charAt(0).toUpperCase() + label.slice(1)}（${host}）`;
}

let migrated = false;

/**
 * 一次性迁移（幂等）：为没有 providerId 的老 agent 按 (kind, baseUrl) 建/找 provider 并写回。
 * 同一个端点只建一个 provider，多个 agent 自动合并到同一条记录。
 */
export function ensureProviderMigration(): { created: number; linked: number } {
  if (migrated) return { created: 0, linked: 0 };
  migrated = true;
  let created = 0;
  let linked = 0;
  for (const config of db.listAgents()) {
    const agent = config as AgentConfigWithProvider;
    if (agent.providerId) continue;
    const { provider: kind, baseUrl, apiKey } = config.model;
    let provider = db.findProviderByEndpoint(kind, baseUrl ?? "");
    if (!provider) {
      const id = newProviderId();
      db.createProvider(id, {
        name: autoProviderName(baseUrl ?? "", kind),
        kind,
        baseUrl: baseUrl ?? "",
        apiKey: apiKey ?? "",
        models: config.model.modelId ? [config.model.modelId] : [],
      });
      provider = db.getProvider(id)!;
      created++;
    }
    db.updateAgent({ ...config, providerId: provider.id } as AgentConfig);
    linked++;
  }
  if (created || linked) {
    console.log(`[providers] 迁移完成：新建 ${created} 个 provider，关联 ${linked} 个 agent`);
  }
  return { created, linked };
}

/** 列表接口返回的供应商：不带明文密钥，只给"配没配" */
export type ProviderSummary = Omit<Provider, "apiKey"> & { hasApiKey: boolean };

export function providerSummary(provider: Provider): ProviderSummary {
  const { apiKey, ...rest } = provider;
  return { ...rest, hasApiKey: apiKey.length > 0 };
}

/** 校验 provider 输入（API 与 UI 共用） */
export function validateProviderInput(
  input: Partial<{ name: unknown; kind: unknown; baseUrl: unknown; models: unknown; notes: unknown }>,
  { partial = false }: { partial?: boolean } = {},
): { ok: true; value: { name?: string; kind?: Provider["kind"]; baseUrl?: string; models?: string[]; notes?: string } } | { ok: false; error: string } {
  const out: { name?: string; kind?: Provider["kind"]; baseUrl?: string; models?: string[]; notes?: string } = {};

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) return { ok: false, error: "name 不能为空" };
    if (name.length > 60) return { ok: false, error: "name 过长（≤60 字符）" };
    out.name = name;
  } else if (!partial) {
    return { ok: false, error: "name 必填" };
  }

  if (input.baseUrl !== undefined) {
    const baseUrl = String(input.baseUrl).trim();
    if (!baseUrl) return { ok: false, error: "baseUrl 不能为空" };
    try {
      new URL(baseUrl);
    } catch {
      return { ok: false, error: "baseUrl 不是合法 URL（例：https://api.deepseek.com）" };
    }
    out.baseUrl = baseUrl;
  } else if (!partial) {
    return { ok: false, error: "baseUrl 必填" };
  }

  if (input.kind !== undefined) {
    const kind = String(input.kind);
    if (kind !== "openai-compatible" && kind !== "anthropic") {
      return { ok: false, error: "kind 只支持 openai-compatible / anthropic" };
    }
    out.kind = kind;
  }

  if (input.models !== undefined) {
    const parts = Array.isArray(input.models) ? input.models : String(input.models).split(/[\n,;]+/);
    // 去空、去重、保序（与 db 层写库时的归一化保持一致）
    const models: string[] = [];
    for (const part of parts) {
      const m = String(part).trim();
      if (m && !models.includes(m)) models.push(m);
    }
    out.models = models;
  }

  if (input.notes !== undefined) out.notes = String(input.notes).slice(0, 400);

  return { ok: true, value: out };
}
