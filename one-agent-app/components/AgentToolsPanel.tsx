"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentConfig } from "@one-agent/core";
import { Switch } from "@/components/ui/Switch";

interface ToolInfo {
  name: string;
  description: string;
  dangerous?: boolean;
}

/**
 * Agent 详情 · 工具页：运行时动态启停工具 + 规划规程开关。
 * 只 PATCH 自己这两段字段（`/api/agents/[id]` 是 merge 语义，不会动别的配置）。
 * 规划开启时连带启用 todo（与内核自动启用逻辑一致，否则规程会让模型去用一个没启用的工具）。
 */
export default function AgentToolsPanel({ agentId, initial }: { agentId: string; initial: AgentConfig }) {
  const router = useRouter();
  const [available, setAvailable] = useState<ToolInfo[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initial.tools.map((t) => [t.name, t.enabled])),
  );
  const [planning, setPlanning] = useState(initial.planning?.mode === "prompt");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((list: ToolInfo[]) => setAvailable(list))
      .catch(() => setAvailable([]));
  }, []);

  /** 当前内核未提供、但配置里存在的旧工具名（保留其开关状态，不静默丢弃） */
  const extraNames = initial.tools.map((t) => t.name).filter((n) => !available.some((a) => a.name === n));

  const toggle = (name: string, on: boolean) => {
    setEnabled((prev) => ({ ...prev, [name]: on }));
    setSaved("");
  };

  const submit = async () => {
    setError("");
    setSaved("");
    setSaving(true);
    try {
      const names = [...available.map((t) => t.name), ...extraNames];
      const tools = names.map((name) => ({ name, enabled: enabled[name] ?? false }));
      if (planning) {
        const i = tools.findIndex((t) => t.name === "todo");
        if (i >= 0) tools[i] = { name: "todo", enabled: true };
        else tools.push({ name: "todo", enabled: true });
      }
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tools, planning: { mode: planning ? "prompt" : "off" } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const savedTools = (data.tools ?? []) as AgentConfig["tools"];
      setEnabled(Object.fromEntries(savedTools.map((t) => [t.name, t.enabled])));
      setPlanning((data.planning as { mode?: string } | undefined)?.mode === "prompt");
      setSaved(`已保存（${new Date().toLocaleTimeString("zh-CN")}）· 下一次对话生效`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const row = (name: string, description: string, dangerous?: boolean) => (
    <div key={name} className="tool-item tool-item-switch">
      <div className="tool-item-info">
        <div className="tool-item-name">
          <code>{name}</code>
          {dangerous && <em className="danger-tag">危险</em>}
          {extraNames.includes(name) && <em className="muted">（当前内核未提供）</em>}
        </div>
        <small>{description}</small>
      </div>
      <Switch checked={enabled[name] ?? false} onCheckedChange={(c) => toggle(name, c)} />
    </div>
  );

  return (
    <div className="form">
      <p className="muted" style={{ marginTop: 0 }}>
        工具的运行时可启停状态；关掉某个工具后模型就看不到它了。危险工具（<em className="danger-tag">危险</em>
        ）在网页对话里默认不会执行。
      </p>

      {available.length === 0 ? (
        <p className="muted">加载工具列表…</p>
      ) : (
        <div className="tool-list">
          {available.map((t) => row(t.name, t.description, t.dangerous))}
          {extraNames.map((n) => row(n, "配置里保留的旧工具（当前内核未注册同名工具）"))}
        </div>
      )}

      <h3>规划（自规划规程）</h3>
      <div className="tool-list">
        <div className="tool-item tool-item-switch">
          <div className="tool-item-info">
            <div className="tool-item-name">
              <code>planning</code>
            </div>
            <small>
              开启后把「先规划后动手」的规程注入系统提示（仅会话首轮，缓存安全）：多步任务先写 todo 计划再执行、
              复杂任务可写方案文档（plan 工具 → 工作区 .oneagent/plans/）。会自动启用 <code>todo</code>。
            </small>
          </div>
          <Switch
            checked={planning}
            onCheckedChange={(c) => {
              setPlanning(c);
              setSaved("");
            }}
          />
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {saved && <p className="muted">{saved}</p>}
      <div className="actions">
        <button className="btn primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : "保存工具配置"}
        </button>
      </div>
    </div>
  );
}
