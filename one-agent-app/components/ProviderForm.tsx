"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Provider } from "@/lib/db";
import Select from "@/components/ui/Select";

/** 表单初值（新建）。编辑态由页面传入的 initial 覆盖（**不含密钥**，只带 hasApiKey 标记） */
const EMPTY_FORM = {
  name: "",
  kind: "openai-compatible" as Provider["kind"],
  baseUrl: "",
  apiKey: "",
  models: "",
  notes: "",
};

type FormState = typeof EMPTY_FORM;

export interface ProviderFormInitial {
  id: string;
  name: string;
  kind: Provider["kind"];
  baseUrl: string;
  models: string[];
  notes: string;
  hasApiKey: boolean;
}

/**
 * 供应商表单（新建 / 编辑共用）。整页表单而不是弹窗：字段多、还要填模型清单，页面空间更从容。
 * 密钥安全：编辑时**不会**把已保存的密钥下发到前端（只有 hasApiKey 标记），留空提交 = 不修改。
 */
export default function ProviderForm({ mode, initial }: { mode: "create" | "edit"; initial?: ProviderFormInitial }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(
    initial
      ? {
          name: initial.name,
          kind: initial.kind,
          baseUrl: initial.baseUrl,
          apiKey: "",
          models: initial.models.join("\n"),
          notes: initial.notes,
        }
      : EMPTY_FORM,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const canSave = form.name.trim().length > 0 && form.baseUrl.trim().length > 0 && !busy;

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        models: form.models,
        notes: form.notes,
      };
      // 编辑时留空 = 不改密钥（避免"看着是空的就把密钥清了"）
      if (mode === "create" || form.apiKey) payload.apiKey = form.apiKey;
      const res = await fetch(mode === "edit" ? `/api/providers/${initial!.id}` : "/api/providers", {
        method: mode === "edit" ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice("已保存，正在返回列表…");
      // 引用它的 agent 立即生效（后端会 invalidate），这里只需回列表
      setTimeout(() => router.push("/settings/providers"), 500);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(error || notice) && (
        <div className={error ? "error-banner" : "notice-banner"} style={{ margin: "10px 0" }}>
          <span>{error || notice}</span>
        </div>
      )}

      <div className="grid2">
        <div className="field">
          <label>名称 *</label>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="DeepSeek 生产" autoFocus />
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
          <span className="field-hint">含协议与端口，例：https://api.deepseek.com 或 http://localhost:11434/v1</span>
        </div>
        <div className="field">
          <label>API Key{mode === "edit" ? "（留空 = 不修改）" : ""}</label>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
            placeholder={initial?.hasApiKey ? "已保存（留空保持不变）" : "sk-...（本地 Ollama 可填 not-needed）"}
          />
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>模型清单（每行一个，第一行为默认）</label>
          <textarea
            rows={3}
            value={form.models}
            onChange={(e) => set("models", e.target.value)}
            placeholder={"deepseek-flash\ndeepseek-chat"}
          />
          <span className="field-hint">填在 Agent 配置的「模型 ID」下拉候选里；agent 自己选择用哪个</span>
        </div>
        <div className="field" style={{ gridColumn: "1 / -1" }}>
          <label>备注（可选）</label>
          <input value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="限速 60 rpm / 走公司代理" />
        </div>
      </div>

      <div className="actions">
        <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? "保存中…" : mode === "edit" ? "保存修改" : "创建供应商"}
        </button>
        <button className="btn" onClick={() => router.push("/settings/providers")}>
          取消
        </button>
      </div>
    </>
  );
}
