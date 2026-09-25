"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import type { Provider } from "@/lib/db";
import type { ProviderSummary } from "@/lib/providers";
import Select from "@/components/ui/Select";

/** 表单初始值（新建） */
const EMPTY_FORM = {
  id: "",
  name: "",
  kind: "openai-compatible" as Provider["kind"],
  baseUrl: "",
  apiKey: "",
  models: "",
  notes: "",
};

type FormState = typeof EMPTY_FORM;

/**
 * 供应商管理页：集中管理模型连接（kind / Base URL / API Key / 模型清单）。
 * agent 侧只引用 providerId → 换密钥、改地址一次生效，不用逐个改 agent。
 */
export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 已保存密钥的占位提示：编辑时留空 = 不修改 */
  const [keyLoaded, setKeyLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      setProviders(res.ok ? ((await res.json()) as ProviderSummary[]) : []);
    } catch {
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setEditing(false);
    setKeyLoaded(false);
    setError("");
    setOpen(true);
  };

  const startEdit = async (id: string) => {
    const res = await fetch(`/api/providers/${id}`);
    if (!res.ok) {
      setError(`加载失败：HTTP ${res.status}`);
      return;
    }
    const p = (await res.json()) as Provider;
    setForm({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      // 密钥不回填到表单（避免在页面上暴露）；留空提交 = 不改
      apiKey: "",
      models: p.models.join("\n"),
      notes: p.notes,
    });
    setKeyLoaded(p.apiKey.length > 0);
    setEditing(true);
    setError("");
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        models: form.models,
        notes: form.notes,
      };
      // 编辑时留空 = 不改密钥（避免"看着是空的就把密钥清了"）
      if (!editing || form.apiKey) payload.apiKey = form.apiKey;
      const res = await fetch(editing ? `/api/providers/${form.id}` : "/api/providers", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      setError(data.error ?? `HTTP ${res.status}`);
      return;
    }
    await refresh();
  };

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>供应商</h1>
        <button className="btn primary" onClick={startCreate}>
          ＋ 新建供应商
        </button>
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        集中管理模型连接（类型 / Base URL / API Key / 模型清单）。Agent 只引用供应商，
        改密钥或换地址一次生效；不引用供应商的 Agent 仍按自己保存的配置运行。
      </p>

      {error && (
        <div className="error-banner" style={{ margin: "10px 0" }}>
          <span>{error}</span>
        </div>
      )}

      {open && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>{editing ? `编辑：${form.name || form.id}` : "新建供应商"}</h3>
          <div className="grid2">
            <div className="field">
              <label>名称 *</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="DeepSeek 生产" />
            </div>
            <div className="field">
              <label>类型</label>
              <Select
                value={form.kind}
                onChange={(v) => set("kind", v)}
                options={[
                  { value: "openai-compatible", label: "OpenAI 兼容（DeepSeek / Ollama / LM Studio…）" },
                  { value: "anthropic", label: "Anthropic 原生" },
                ]}
              />
            </div>
            <div className="field">
              <label>Base URL *</label>
              <input
                value={form.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://api.deepseek.com"
              />
            </div>
            <div className="field">
              <label>API Key{editing ? "（留空 = 不修改）" : ""}</label>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder={keyLoaded ? "已保存（留空保持不变）" : "sk-..."}
              />
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>模型清单（每行一个，第一行为默认）</label>
              <textarea
                rows={3}
                value={form.models}
                onChange={(e) => set("models", e.target.value)}
                placeholder={"deepseek-v4-flash\ndeepseek-chat"}
              />
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>备注（可选）</label>
              <input value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="限速 60 rpm / 走公司代理" />
            </div>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy || !form.name.trim() || !form.baseUrl.trim()} onClick={() => void save()}>
              {busy ? "保存中…" : "保存"}
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      )}

      {providers.length === 0 && !open ? (
        <p className="muted">还没有供应商。点击「新建供应商」添加一个（已有的 Agent 会在首次打开时自动迁移成供应商引用）。</p>
      ) : (
        providers.map((p) => (
          <div key={p.id} className="card">
            <div className="card-main">
              <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <ServerIcon size={16} />
                {p.name}
              </h2>
              <div className="card-sub">
                <code>{p.id}</code> · {p.kind} · {p.baseUrl} ·{" "}
                {p.hasApiKey ? "已配密钥" : "未配密钥"} · 模型 {p.models.length} 个
                {p.models.length > 0 && <>（默认 {p.models[0]}）</>}
              </div>
              {p.notes && <div className="card-sub">{p.notes}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button className="btn" onClick={() => void startEdit(p.id)}>
                编辑
              </button>
              <button className="btn danger" title="删除（被 Agent 引用时会被拒绝）" onClick={() => void remove(p.id)}>
                <Trash2Icon size={13} />
              </button>
            </div>
          </div>
        ))
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        在 <Link href="/agents">Agents</Link> 里选供应商 · <PlusIcon size={12} /> 新建后可随时改密钥（引用它的 Agent 即时生效）
      </p>
    </div>
  );
}
