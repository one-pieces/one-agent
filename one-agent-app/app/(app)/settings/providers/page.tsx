"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ServerIcon, Trash2Icon } from "lucide-react";
import type { ProviderSummary } from "@/lib/providers";

/**
 * 供应商列表页。新建 / 编辑各自进入独立页面（/providers/new、/providers/[id]）。
 * 集中管理模型连接（kind / Base URL / API Key / 模型清单），agent 侧只引用 providerId。
 */
export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const remove = async (id: string) => {
    setError("");
    setBusyId(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
        <Link href="/settings/providers/new" className="btn primary">
          新建供应商
        </Link>
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

      {providers.length === 0 ? (
        <p className="muted">还没有供应商。点右上角「新建供应商」添加一个（已有的 Agent 会在首次打开时自动迁移成供应商引用）。</p>
      ) : (
        providers.map((p) => (
          <div key={p.id} className="card">
            <div className="card-main">
              <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <ServerIcon size={16} />
                {p.name}
              </h2>
              <div
                className="card-sub card-sub-wrap"
                title={`${p.id} · ${p.kind} · ${p.baseUrl} · ${p.hasApiKey ? "已配密钥" : "未配密钥"} · 模型 ${p.models.length} 个${p.models.length > 0 ? `（默认 ${p.models[0]}）` : ""}`}
              >
                <code>{p.id}</code> · {p.kind} · {p.baseUrl} ·{" "}
                {p.hasApiKey ? "已配密钥" : "未配密钥"} · 模型 {p.models.length} 个
                {p.models.length > 0 && <>（默认 {p.models[0]}）</>}
              </div>
              {p.notes && <div className="card-sub">{p.notes}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <Link href={`/settings/providers/${p.id}`} className="btn">
                编辑
              </Link>
              <button
                className="btn danger"
                disabled={busyId === p.id}
                title="删除（被 Agent 引用时会被拒绝）"
                onClick={() => void remove(p.id)}
              >
                <Trash2Icon size={13} />
              </button>
            </div>
          </div>
        ))
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        在 <Link href="/agents">Agents</Link> 里选供应商 · 改完密钥/地址即时生效（引用它的 Agent 无需改动）
      </p>
    </>
  );
}
