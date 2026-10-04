"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AgentConfig } from "@one-agent/core";
import type { AgentConfigWithProvider, ProviderSummary } from "@/lib/providers";
import Select from "@/components/ui/Select";

interface ToolInfo {
  name: string;
  description: string;
  dangerous?: boolean;
}

const DEFAULT_MODEL: AgentConfig["model"] = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  modelId: "qwen2.5-7b-64k",
  apiKey: "not-needed",
  temperature: 0.5,
};

export default function AgentForm({
  mode,
  initial,
}: {
  mode: "new" | "edit";
  initial?: AgentConfig;
}) {
  const router = useRouter();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<AgentConfig>(
    initial ?? {
      id: "",
      name: "",
      instructions: "你是一个乐于助人的助手。需要时使用工具并简洁总结结果。",
      model: { ...DEFAULT_MODEL },
      tools: [],
      maxIterations: 24,
      memory: { strategy: "compaction", contextWindowTokens: 32000, thresholdPercent: 0.75 },
    },
  );

  useEffect(() => {
    // 新建时给一套默认工具（危险工具默认关）；编辑时工具在「工具」子页里改
    fetch("/api/tools")
      .then((r) => r.json())
      .then((list: ToolInfo[]) => {
        if (!initial) {
          setForm((f) => ({
            ...f,
            tools: list.map((t) => ({ name: t.name, enabled: !t.dangerous })),
          }));
        }
      })
      .catch(() => undefined);
    fetch("/api/providers")
      .then((r) => r.json())
      .then((list: ProviderSummary[]) => setProviders(list))
      .catch(() => setProviders([]));
  }, [initial]);

  /** 「自定义」选项的哨兵值（不引用任何 provider） */
  const CUSTOM_PROVIDER = "__custom__";
  const providerId = (form as AgentConfigWithProvider).providerId;
  const selectedProvider = providers.find((p) => p.id === providerId);

  /** 切换供应商：写 providerId；模型 ID 为空时用该供应商登记的默认模型填充 */
  const onPickProvider = (value: string) => {
    if (value === CUSTOM_PROVIDER) {
      setForm((f) => {
        const next = { ...(f as AgentConfigWithProvider) };
        delete next.providerId;
        return next as AgentConfig;
      });
      return;
    }
    const provider = providers.find((p) => p.id === value);
    setForm((f) => ({
      ...f,
      providerId: value,
      model: { ...f.model, modelId: f.model.modelId || provider?.models[0] || "" },
    }) as AgentConfig);
  };

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setModel = <K extends keyof AgentConfig["model"]>(key: K, value: AgentConfig["model"][K]) =>
    setForm((f) => ({ ...f, model: { ...f.model, [key]: value } }));
  const submit = async () => {
    setError("");
    if (!form.name.trim()) return setError("名称必填");
    if (!form.model.modelId.trim()) return setError("模型 ID 必填");
    setSaving(true);
    try {
      const res =
        mode === "new"
          ? await fetch("/api/agents", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(form),
            })
          : await fetch(`/api/agents/${initial!.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(form),
            });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      router.push(`/agents/${data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form">
      <div className="field">
        <label>ID（新建时留空自动生成）</label>
        <input
          value={form.id}
          onChange={(e) => set("id", e.target.value)}
          disabled={mode === "edit"}
          placeholder="agent-demo"
        />
      </div>

      <div className="field">
        <label>名称 *</label>
        <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="演示助手" />
      </div>

      <div className="field">
        <label>系统指令（instructions）</label>
        <textarea
          value={form.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          rows={4}
        />
      </div>

      <h3>模型（由供应商提供连接配置）</h3>
      <div className="grid2">
        <div className="field">
          <label>供应商 *</label>
          <Select
            value={(form as AgentConfigWithProvider).providerId ?? CUSTOM_PROVIDER}
            onChange={onPickProvider}
            options={[
              ...providers.map((p) => ({
                value: p.id,
                label: `${p.name}（${p.kind === "anthropic" ? "Anthropic" : "OpenAI 兼容"}${p.hasApiKey ? " · 已配密钥" : ""}）`,
              })),
              { value: CUSTOM_PROVIDER, label: "自定义（本 agent 自己保存连接配置）" },
            ]}
            placeholder="选择供应商"
          />
          <span className="field-hint">
            {selectedProvider
              ? `Base URL: ${selectedProvider.baseUrl}${selectedProvider.hasApiKey ? " · 密钥由供应商统一管理" : " · 该供应商未配置密钥"}`
              : "自定义：kind / Base URL / API Key 存在本 agent 里（旧行为）"}
            {providers.length === 0 && (
              <>
                {" "}
                · 还没有供应商，先去 <Link href="/settings/providers">设置 · 供应商</Link> 里建一个
              </>
            )}
          </span>
        </div>
        <div className="field">
          <label>模型 ID *</label>
          <input
            list="agent-model-options"
            value={form.model.modelId}
            onChange={(e) => setModel("modelId", e.target.value)}
            placeholder={selectedProvider?.models[0] ?? "deepseek-chat / qwen2.5-7b-64k"}
          />
          <datalist id="agent-model-options">
            {(selectedProvider?.models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {selectedProvider && selectedProvider.models.length > 0 && (
            <span className="field-hint">该供应商登记的模型：{selectedProvider.models.join("、")}</span>
          )}
        </div>
        <div className="field">
          <label>Temperature</label>
          <input
            type="number"
            step={0.1}
            value={form.model.temperature ?? 0.5}
            onChange={(e) => setModel("temperature", Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>Max Tokens（可选）</label>
          <input
            type="number"
            value={form.model.maxTokens ?? ""}
            onChange={(e) => setModel("maxTokens", e.target.value ? Number(e.target.value) : undefined)}
          />
        </div>
      </div>
      {!selectedProvider && (
        <div className="grid2">
          <div className="field">
            <label>Provider 类型</label>
            <Select
              value={form.model.provider}
              onChange={(v) => setModel("provider", v as AgentConfig["model"]["provider"])}
              options={[
                { value: "openai-compatible", label: "OpenAI 兼容（DeepSeek/Ollama/LM Studio…）" },
                { value: "anthropic", label: "Anthropic 原生" },
              ]}
            />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input
              value={form.model.baseUrl ?? ""}
              onChange={(e) => setModel("baseUrl", e.target.value)}
              placeholder="http://localhost:11434/v1"
            />
          </div>
          <div className="field">
            <label>API Key（Ollama 可填 not-needed）</label>
            <input
              type="password"
              value={form.model.apiKey ?? ""}
              onChange={(e) => setModel("apiKey", e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </div>
      )}

      <p className="muted">
        工具、知识库、客服组件已分到左侧的「工具 / 知识库 / 客服组件」子页，这里只管基础配置。
        {form.tools.filter((t) => t.enabled).length > 0 && (
          <> 当前启用 {form.tools.filter((t) => t.enabled).length} 个工具。</>
        )}
      </p>

      <h3>记忆与限制</h3>
      <div className="grid2">
        <div className="field">
          <label>记忆策略</label>
          <Select
            value={form.memory?.strategy ?? "none"}
            onChange={(v) =>
              set("memory", {
                strategy: v as "none" | "window" | "compaction",
                maxMessages: form.memory?.maxMessages,
                thresholdPercent: form.memory?.thresholdPercent,
                contextWindowTokens: form.memory?.contextWindowTokens,
              })
            }
            options={[
              { value: "none", label: "none" },
              { value: "window", label: "window（裁剪）" },
              { value: "compaction", label: "compaction（摘要）" },
            ]}
          />
        </div>
        <div className="field">
          <label>Max Iterations</label>
          <input
            type="number"
            value={form.maxIterations ?? 6}
            onChange={(e) => set("maxIterations", Number(e.target.value))}
          />
        </div>
        {form.memory?.strategy === "window" && (
          <div className="field">
            <label>Max Messages（窗口大小）</label>
            <input
              type="number"
              value={form.memory.maxMessages ?? 20}
              onChange={(e) => set("memory", { ...form.memory!, maxMessages: Number(e.target.value) })}
            />
          </div>
        )}
        {form.memory?.strategy === "compaction" && (
          <div className="field">
            <label>上下文窗口 tokens（触发阈值）</label>
            <input
              type="number"
              value={form.memory.contextWindowTokens ?? 32000}
              onChange={(e) =>
                set("memory", { ...form.memory!, contextWindowTokens: Number(e.target.value) })
              }
            />
          </div>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="btn primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : mode === "new" ? "创建 Agent" : "保存修改"}
        </button>
        <button className="btn" onClick={() => router.back()}>
          取消
        </button>
      </div>
    </div>
  );
}
