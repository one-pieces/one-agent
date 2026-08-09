"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentConfig } from "@one-agent/core";

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
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<AgentConfig>(
    initial ?? {
      id: "",
      name: "",
      instructions: "你是一个乐于助人的助手。需要时使用工具并简洁总结结果。",
      model: { ...DEFAULT_MODEL },
      tools: [],
      maxIterations: 6,
    },
  );

  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((list: ToolInfo[]) => {
        setTools(list);
        if (!initial) {
          setForm((f) => ({
            ...f,
            tools: list.map((t) => ({ name: t.name, enabled: !t.dangerous })),
          }));
        }
      })
      .catch(() => setTools([]));
  }, [initial]);

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setModel = <K extends keyof AgentConfig["model"]>(key: K, value: AgentConfig["model"][K]) =>
    setForm((f) => ({ ...f, model: { ...f.model, [key]: value } }));
  const toggleTool = (name: string, enabled: boolean) =>
    setForm((f) => {
      const exists = f.tools.some((t) => t.name === name);
      const tools = exists
        ? f.tools.map((t) => (t.name === name ? { ...t, enabled } : t))
        : [...f.tools, { name, enabled }];
      return { ...f, tools };
    });

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

      <h3>模型（动态配置）</h3>
      <div className="grid2">
        <div className="field">
          <label>Provider</label>
          <select
            value={form.model.provider}
            onChange={(e) => setModel("provider", e.target.value as AgentConfig["model"]["provider"])}
          >
            <option value="openai-compatible">OpenAI 兼容（DeepSeek/Ollama/LM Studio…）</option>
            <option value="anthropic">Anthropic 原生</option>
          </select>
        </div>
        <div className="field">
          <label>Base URL</label>
          <input value={form.model.baseUrl ?? ""} onChange={(e) => setModel("baseUrl", e.target.value)} placeholder="http://localhost:11434/v1" />
        </div>
        <div className="field">
          <label>模型 ID *</label>
          <input value={form.model.modelId} onChange={(e) => setModel("modelId", e.target.value)} placeholder="qwen2.5-7b-64k / deepseek-chat" />
        </div>
        <div className="field">
          <label>API Key（Ollama 可填 not-needed）</label>
          <input type="password" value={form.model.apiKey ?? ""} onChange={(e) => setModel("apiKey", e.target.value)} placeholder="sk-..." />
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

      <h3>工具（运行时动态启停）</h3>
      {tools.length === 0 ? (
        <p className="muted">加载工具列表…</p>
      ) : (
        <div className="tool-list">
          {tools.map((t) => {
            const enabled = form.tools.find((x) => x.name === t.name)?.enabled ?? false;
            return (
              <label key={t.name} className="tool-item">
                <input type="checkbox" checked={enabled} onChange={(e) => toggleTool(t.name, e.target.checked)} />
                <span>
                  <code>{t.name}</code>
                  {t.dangerous && <em className="danger-tag">危险</em>}
                  <small>{t.description}</small>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <h3>记忆与限制</h3>
      <div className="grid2">
        <div className="field">
          <label>记忆策略</label>
          <select
            value={form.memory?.strategy ?? "none"}
            onChange={(e) =>
              set("memory", {
                strategy: e.target.value as "none" | "window" | "compaction",
                maxMessages: form.memory?.maxMessages,
                thresholdPercent: form.memory?.thresholdPercent,
                contextWindowTokens: form.memory?.contextWindowTokens,
              })
            }
          >
            <option value="none">none</option>
            <option value="window">window（裁剪）</option>
            <option value="compaction">compaction（摘要）</option>
          </select>
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
