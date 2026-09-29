"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import type { WidgetSettings } from "@/lib/db";
import Select from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";

/**
 * Agent 详情页的「客服组件（嵌入网站）」卡片。
 * 配置存 widget_settings 表；嵌入代码由后端生成（含 agentId + 公开 embedKey）。
 */
export default function WidgetSettingsCard({ agentId }: { agentId: string }) {
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [snippet, setSnippet] = useState("");
  const [demoUrl, setDemoUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 重置 key 后常驻提醒：旧嵌入代码已失效，必须更新网站上的代码 */
  const [keyRotated, setKeyRotated] = useState(false);
  /** 允许的来源：用文本编辑，提交时按行拆分 */
  const [originsText, setOriginsText] = useState("");

  const apply = useCallback((data: { settings: WidgetSettings; configured: boolean; snippet: string; demoUrl: string }) => {
    setSettings(data.settings);
    setConfigured(data.configured);
    setSnippet(data.snippet);
    setDemoUrl(data.demoUrl);
    setOriginsText(data.settings.origins.join("\n"));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/widget`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apply((await res.json()) as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // 回到这个标签页时重新拉一遍：如果 key 在别处被重置过，卡片里的嵌入代码不会停留在旧的
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const save = useCallback(
    async (patch: Record<string, unknown>, successNotice = "已保存") => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const res = await fetch(`/api/agents/${agentId}/widget`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        apply(data as never);
        setNotice(successNotice);
        setTimeout(() => setNotice(""), 2500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentId, apply],
  );

  const set = (patch: Partial<WidgetSettings>) => setSettings((s) => (s ? { ...s, ...patch } : s));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选中代码复制");
    }
  };

  if (!settings) {
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>客服组件（嵌入网站）</h3>
        <p className="muted">{error ? `加载失败：${error}` : "加载中…"}</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>客服组件（嵌入网站）</h3>
          <span className="field-hint">
            开启后，把下面的代码粘到任意网页，右下角会出现客服按钮 —— 访客点开即可与该 agent 对话（无需登录）。
          </span>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(checked) => void save({ enabled: checked }, checked ? "已开启" : "已关闭")}
          aria-label="启用客服组件"
        />
      </div>

      {(error || notice) && (
        <div className={error ? "error-banner" : "notice-banner"} style={{ margin: "10px 0" }}>
          <span>{error || notice}</span>
        </div>
      )}

      {!settings.enabled && !configured && (
        <p className="muted" style={{ marginTop: 8 }}>
          还没开启。开启后可配置标题、欢迎语、主题色与来源白名单。
        </p>
      )}

      {settings.enabled && (
        <>
          <div className="grid2" style={{ marginTop: 12 }}>
            <div className="field">
              <label>面板标题</label>
              <input value={settings.title} onChange={(e) => set({ title: e.target.value })} placeholder="在线客服" />
            </div>
            <div className="field">
              <label>副标题</label>
              <input value={settings.subtitle} onChange={(e) => set({ subtitle: e.target.value })} placeholder="通常几分钟内回复" />
            </div>
            <div className="field">
              <label>欢迎语（对话为空时显示）</label>
              <input value={settings.welcome} onChange={(e) => set({ welcome: e.target.value })} />
            </div>
            <div className="field">
              <label>输入框占位提示</label>
              <input value={settings.placeholder} onChange={(e) => set({ placeholder: e.target.value })} />
            </div>
            <div className="field">
              <label>主题色</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="color"
                  value={settings.primaryColor}
                  onChange={(e) => set({ primaryColor: e.target.value })}
                  style={{ width: 44, height: 34, padding: 2, cursor: "pointer" }}
                />
                <input value={settings.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} placeholder="#2f6bff" />
              </div>
            </div>
            <div className="field">
              <label>按钮位置</label>
              <Select
                value={settings.position}
                onChange={(v) => set({ position: v === "left" ? "left" : "right" })}
                options={[
                  { value: "right", label: "右下角" },
                  { value: "left", label: "左下角" },
                ]}
              />
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>允许的来源白名单（每行一个；留空 = 不限制来源）</label>
              <textarea
                rows={2}
                value={originsText}
                onChange={(e) => setOriginsText(e.target.value)}
                placeholder={"https://www.example.com\n*.example.com"}
              />
              <span className="field-hint">支持完整 origin（含端口）与通配子域 <code>*.example.com</code>；留空表示允许任何网站嵌入（key 仍是凭据）。</span>
            </div>
            <div className="field">
              <label>限流（每个访客每分钟消息数，0 = 不限）</label>
              <input
                type="number"
                min={0}
                max={600}
                value={settings.rateLimit}
                onChange={(e) => set({ rateLimit: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="actions">
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void save(
                  {
                    title: settings.title,
                    subtitle: settings.subtitle,
                    welcome: settings.welcome,
                    placeholder: settings.placeholder,
                    primaryColor: settings.primaryColor,
                    position: settings.position,
                    rateLimit: settings.rateLimit,
                    origins: originsText,
                  },
                  "配置已保存",
                )
              }
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
            <a className="btn" href={demoUrl} target="_blank" rel="noreferrer">
              预览效果 <ExternalLinkIcon size={13} />
            </a>
          </div>

          {keyRotated && (
            <div className="error-banner" style={{ marginTop: 12 }}>
              <span>
                嵌入 key 已重置：网站上的旧嵌入代码<strong>已失效</strong>，请用下面的新代码替换。
              </span>
            </div>
          )}

          <h4 style={{ marginBottom: 6, marginTop: 18 }}>嵌入代码</h4>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea readOnly rows={2} value={snippet} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void copy()}>
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {copied ? "已复制" : "复制"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <span className="field-hint" style={{ margin: 0 }}>
              嵌入 key：<code>{settings.embedKey}</code>
              {settings.updatedAt && <> · 配置更新于 {new Date(settings.updatedAt).toLocaleString("zh-CN", { hour12: false })}</>}
              <button
                className="btn"
                style={{ marginLeft: 8, padding: "2px 8px" }}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(settings.embedKey);
                    setNotice("嵌入 key 已复制");
                    setTimeout(() => setNotice(""), 2000);
                  } catch {
                    setError("复制失败，请手动选中复制");
                  }
                }}
              >
                复制 key
              </button>
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                if (!window.confirm("重置后，旧嵌入代码会立即失效（需要重新粘贴新代码）。确定重置？")) return;
                setKeyRotated(true);
                void save({ resetKey: true }, "嵌入 key 已重置");
              }}
            >
              <RefreshCwIcon size={13} /> 重置 key
            </button>
          </div>
        </>
      )}
    </div>
  );
}
