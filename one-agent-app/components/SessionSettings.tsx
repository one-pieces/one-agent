"use client";

import { useEffect, useState } from "react";
import type { AgentConfig, ProviderConfig } from "@one-agent/core";

interface ToolInfo {
  name: string;
  description: string;
  dangerous?: boolean;
}

/**
 * 会话级配置覆盖：只影响当前会话（存 session.meta），不改变 Agent 本体。
 * 多会话模型/工具隔离的核心 UI。
 */
export default function SessionSettings({ sessionId, agent }: { sessionId: string; agent: AgentConfig }) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [model, setModel] = useState<Partial<ProviderConfig>>({ ...agent.model });
  const [toolFlags, setToolFlags] = useState<Record<string, boolean>>(
    Object.fromEntries(agent.tools.map((t) => [t.name, t.enabled])),
  );
  const [active, setActive] = useState(false);
  const [msg, setMsg] = useState("");
  const [allowDangerous, setAllowDangerous] = useState(false);

  // 加载工具目录 + 会话已有覆盖
  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then(setTools)
      .catch(() => setTools([]));
    fetch(`/api/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((s) => {
        const meta = (s?.meta ?? {}) as {
          modelOverride?: Partial<ProviderConfig>;
          toolOverrides?: Array<{ name: string; enabled: boolean }>;
          allowDangerous?: boolean;
        };
        let has = false;
        if (meta.modelOverride) {
          setModel((m) => ({ ...m, ...meta.modelOverride }));
          has = true;
        }
        if (meta.toolOverrides) {
          setToolFlags(Object.fromEntries(meta.toolOverrides.map((t) => [t.name, t.enabled])));
          has = true;
        }
        if (meta.allowDangerous) {
          setAllowDangerous(true);
          has = true;
        }
        setActive(has);
      })
      .catch(() => {});
  }, [sessionId]);

  const apply = async () => {
    setMsg("");
    const modelOverride = { ...model };
    const toolOverrides = tools.map((t) => ({ name: t.name, enabled: toolFlags[t.name] ?? false }));
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelOverride, toolOverrides, allowDangerous }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActive(true);
      setMsg("✅ 已应用：本会话（仅本会话）将使用覆盖配置");
    } catch (err) {
      setMsg(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const reset = async () => {
    setMsg("");
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelOverride: null, toolOverrides: null, allowDangerous: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setModel({ ...agent.model });
      setToolFlags(Object.fromEntries(agent.tools.map((t) => [t.name, t.enabled])));
      setAllowDangerous(false);
      setActive(false);
      setMsg("✅ 已重置为 Agent 默认配置");
    } catch (err) {
      setMsg(`重置失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <details className="session-settings">
      <summary>{active ? "⚙️ 会话覆盖（生效中）" : "⚙️ 会话覆盖"}</summary>
      <div className="settings-body">
        <h4>模型（仅本会话）</h4>
        <div className="grid2">
          <label className="field-inline">
            模型 ID
            <input value={model.modelId ?? ""} onChange={(e) => setModel((m) => ({ ...m, modelId: e.target.value }))} />
          </label>
          <label className="field-inline">
            Base URL
            <input value={model.baseUrl ?? ""} onChange={(e) => setModel((m) => ({ ...m, baseUrl: e.target.value }))} />
          </label>
          <label className="field-inline">
            Temperature
            <input
              type="number"
              step={0.1}
              value={model.temperature ?? 0.5}
              onChange={(e) => setModel((m) => ({ ...m, temperature: Number(e.target.value) }))}
            />
          </label>
          <label className="field-inline">
            API Key（留空继承 Agent）
            <input
              type="password"
              value={model.apiKey ?? ""}
              onChange={(e) => setModel((m) => ({ ...m, apiKey: e.target.value }))}
            />
          </label>
        </div>

        <h4>工具（仅本会话）</h4>
        {tools.length === 0 ? (
          <p className="muted">加载工具目录…</p>
        ) : (
          <div className="tool-list">
            {tools.map((t) => (
              <label key={t.name} className="tool-item">
                <input
                  type="checkbox"
                  checked={toolFlags[t.name] ?? false}
                  onChange={(e) => setToolFlags((f) => ({ ...f, [t.name]: e.target.checked }))}
                />
                <span>
                  <code>{t.name}</code>
                  {t.dangerous && <em className="danger-tag">危险</em>}
                </span>
              </label>
            ))}
          </div>
        )}

        <label className="danger-toggle">
          <input type="checkbox" checked={allowDangerous} onChange={(e) => setAllowDangerous(e.target.checked)} />
          <span>
            允许执行危险工具（run_local_command 等）
            <small>默认拒绝；开启后本会话的模型可直接调用危险工具</small>
          </span>
        </label>

        <div className="actions">
          <button className="btn primary" onClick={() => void apply()}>
            应用到本会话
          </button>
          <button className="btn" onClick={() => void reset()}>
            重置为默认
          </button>
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </details>
  );
}
