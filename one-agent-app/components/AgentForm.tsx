"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AgentConfig } from "@one-agent/core";
import type { KnowledgeBase } from "@/lib/db";
import Select from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";

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
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
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
    fetch("/api/knowledge")
      .then((r) => r.json())
      .then((list: KnowledgeBase[]) => setKnowledgeBases(list))
      .catch(() => setKnowledgeBases([]));
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

  /** 勾选知识库：增删 knowledgeBaseIds；关联后自动启用 knowledge_search 工具，全部取消则移除 */
  const toggleKnowledgeBase = (kbId: string) =>
    setForm((f) => {
      const has = (f.knowledgeBaseIds ?? []).includes(kbId);
      const knowledgeBaseIds = has
        ? (f.knowledgeBaseIds ?? []).filter((x) => x !== kbId)
        : [...(f.knowledgeBaseIds ?? []), kbId];
      let tools = f.tools;
      if (knowledgeBaseIds.length > 0 && !tools.some((t) => t.name === "knowledge_search")) {
        tools = [...tools, { name: "knowledge_search", enabled: true }];
      } else if (knowledgeBaseIds.length === 0) {
        tools = tools.filter((t) => t.name !== "knowledge_search");
      }
      return { ...f, knowledgeBaseIds, tools };
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
              <div key={t.name} className="tool-item tool-item-switch">
                <div className="tool-item-info">
                  <div className="tool-item-name">
                    <code>{t.name}</code>
                    {t.dangerous && <em className="danger-tag">危险</em>}
                  </div>
                  <small>{t.description}</small>
                </div>
                <Switch checked={enabled} onCheckedChange={(c) => toggleTool(t.name, c)} />
              </div>
            );
          })}
        </div>
      )}

      <h3>知识库（关联后对话可检索）</h3>
      {knowledgeBases.length === 0 ? (
        <p className="muted">
          还没有知识库。{" "}
          <Link href="/knowledge" className="muted" style={{ textDecoration: "underline" }}>
            去创建 →
          </Link>
        </p>
      ) : (
        <div className="tool-list">
          {knowledgeBases.map((kb) => {
            const enabled = (form.knowledgeBaseIds ?? []).includes(kb.id);
            return (
              <div key={kb.id} className="tool-item tool-item-switch">
                <div className="tool-item-info">
                  <div className="tool-item-name">
                    <code>{kb.name}</code>
                  </div>
                  <small>{kb.description || kb.id}</small>
                </div>
                <Switch checked={enabled} onCheckedChange={() => toggleKnowledgeBase(kb.id)} />
              </div>
            );
          })}
        </div>
      )}
      {(form.knowledgeBaseIds?.length ?? 0) > 0 && (
        <p className="muted">已自动启用 knowledge_search 工具，对话时模型会按需检索知识库。</p>
      )}

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
