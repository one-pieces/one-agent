import { describe, expect, it, beforeEach } from "vitest";
import type { StreamChunk } from "@one-agent/core";
import {
  WIDGET_DEFAULTS,
  checkOrigin,
  checkRateLimit,
  corsHeaders,
  defaultWidgetSettings,
  embedSnippet,
  genericCors,
  normalizeOrigin,
  originAllowed,
  publicWidgetConfig,
  requestOrigin,
  resetRateLimits,
  sanitizeVisitorChunk,
  widgetMetaOf,
} from "../lib/widget";
import type { WidgetSettings } from "../lib/db";

function settings(overrides: Partial<WidgetSettings> = {}): WidgetSettings {
  return { ...defaultWidgetSettings("agent-1"), enabled: true, embedKey: "wk_test", ...overrides };
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/widget/config", { headers });
}

describe("来源白名单", () => {
  it("白名单为空 → 允许任何来源（公开可嵌入）", () => {
    expect(originAllowed("https://any.site", [])).toBe(true);
    expect(originAllowed(null, [])).toBe(true);
  });

  it("带协议的精确匹配（大小写与尾斜杠归一化）", () => {
    const list = ["https://shop.example.com"];
    expect(originAllowed("https://shop.example.com", list)).toBe(true);
    expect(originAllowed("HTTPS://SHOP.EXAMPLE.COM/", list)).toBe(true);
    expect(originAllowed("http://shop.example.com", list)).toBe(false); // 协议不同
    expect(originAllowed("https://evil.com", list)).toBe(false);
  });

  it("不带协议 → 忽略协议匹配；含端口需一致", () => {
    expect(originAllowed("http://localhost:3000", ["localhost:3000"])).toBe(true);
    expect(originAllowed("https://localhost:3000", ["localhost:3000"])).toBe(true);
    expect(originAllowed("http://localhost:4000", ["localhost:3000"])).toBe(false);
  });

  it("通配子域 *.example.com：匹配子域、不匹配主域与伪装域", () => {
    const list = ["*.example.com"];
    expect(originAllowed("https://a.example.com", list)).toBe(true);
    expect(originAllowed("https://a.b.example.com", list)).toBe(true);
    expect(originAllowed("https://example.com", list)).toBe(false);
    expect(originAllowed("https://evilexample.com", list)).toBe(false);
    expect(originAllowed("https://example.com.evil.net", list)).toBe(false);
  });

  it("配了白名单但没有 Origin 的请求（curl/服务端）→ 拒绝", () => {
    expect(originAllowed(null, ["https://shop.example.com"])).toBe(false);
  });

  it("requestOrigin：优先 Origin，其次 Referer", () => {
    expect(requestOrigin(req({ origin: "https://a.com" }))).toBe("https://a.com");
    expect(requestOrigin(req({ referer: "https://b.com/page?x=1" }))).toBe("https://b.com");
    expect(requestOrigin(req())).toBeNull();
    expect(normalizeOrigin("HTTPS://C.com/")).toBe("https://c.com");
  });

  it("checkOrigin：命中返回 ok，未命中给出可操作的中文提示", () => {
    const blocked = checkOrigin(req({ origin: "https://evil.com" }), settings({ origins: ["https://shop.example.com"] }));
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("来源未授权");
    expect(blocked.error).toContain("白名单");
    expect(checkOrigin(req({ origin: "https://shop.example.com" }), settings({ origins: ["shop.example.com"] })).ok).toBe(true);
  });
});

describe("CORS", () => {
  it("白名单为空 → 回显来源（便于跨域直接调用）", () => {
    const h = corsHeaders(req({ origin: "https://any.site" }), settings());
    expect(h["access-control-allow-origin"]).toBe("https://any.site");
    expect(h.vary).toBe("Origin");
    expect(h["access-control-allow-methods"]).toContain("POST");
  });

  it("白名单非空：命中回显、未命中不给 AC-Allow-Origin", () => {
    const s = settings({ origins: ["https://shop.example.com"] });
    expect(corsHeaders(req({ origin: "https://shop.example.com" }), s)["access-control-allow-origin"]).toBe("https://shop.example.com");
    expect(corsHeaders(req({ origin: "https://evil.com" }), s)["access-control-allow-origin"]).toBeUndefined();
  });

  it("预解析前报错也用兜底 CORS（否则浏览器只看到 Failed to fetch）", () => {
    expect(genericCors(req({ origin: "https://x.com" }))["access-control-allow-origin"]).toBe("https://x.com");
    expect(genericCors(req())["access-control-allow-origin"]).toBe("*");
  });
});

describe("访客事件过滤（工具内部信息不外泄）", () => {
  it("text / usage / done 原样透出（用量只留 token 数）", () => {
    expect(sanitizeVisitorChunk({ type: "text", delta: "你好" })).toEqual({ type: "text", delta: "你好" });
    expect(sanitizeVisitorChunk({ type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 5 })).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(sanitizeVisitorChunk({ type: "done" })).toEqual({ type: "done" });
  });

  it("tool_call → 友好状态文案，不暴露工具名与参数", () => {
    const out = sanitizeVisitorChunk({ type: "tool_call", id: "c1", name: "knowledge_search", input: { query: "内部资料" } });
    expect(out).toEqual({ type: "status", label: "正在查资料…" });
    expect(JSON.stringify(out)).not.toContain("knowledge_search");
    expect(JSON.stringify(out)).not.toContain("内部资料");
    expect(sanitizeVisitorChunk({ type: "tool_call", id: "c2", name: "bash", input: { command: "rm -rf /" } })).toEqual({
      type: "status",
      label: "正在处理…",
    });
  });

  it("tool_result 完全丢弃；error 换成对访客友好的文案", () => {
    expect(sanitizeVisitorChunk({ type: "tool_result", id: "c1", ok: true, output: { secret: "内部数据" } })).toBeNull();
    const err = sanitizeVisitorChunk({ type: "error", message: "401 invalid api key sk-xxx" }) as { message: string };
    expect(err.message).not.toContain("sk-xxx");
    expect(err.message).toContain("请稍后再试");
  });
});

describe("限流", () => {
  beforeEach(() => resetRateLimits());

  it("窗口内超过阈值 → 拒绝并给出重试秒数", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(checkRateLimit("s1", 3, t0 + i).ok).toBe(true);
    const blocked = checkRateLimit("s1", 3, t0 + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    // 窗口滑过后恢复
    expect(checkRateLimit("s1", 3, t0 + 61_000).ok).toBe(true);
  });

  it("按 key 隔离；0 表示不限流", () => {
    const t0 = 2_000_000;
    expect(checkRateLimit("a", 1, t0).ok).toBe(true);
    expect(checkRateLimit("a", 1, t0).ok).toBe(false);
    expect(checkRateLimit("b", 1, t0).ok).toBe(true);
    for (let i = 0; i < 50; i++) expect(checkRateLimit("c", 0, t0).ok).toBe(true);
  });
});

describe("嵌入代码与公开配置", () => {
  it("snippet 含脚本地址、agentId、公开 key 与可选样式属性", () => {
    const s = embedSnippet("http://localhost:3000/", "agent-1", "wk_abc", { position: "left", color: "#123456" });
    expect(s).toContain('src="http://localhost:3000/widget.js"');
    expect(s).toContain('data-agent="agent-1"');
    expect(s).toContain('data-key="wk_abc"');
    expect(s).toContain('data-position="left"');
    expect(s).toContain('data-color="#123456"');
    expect(s).toContain("async");
  });

  it("公开配置只暴露访客需要的字段", () => {
    const cfg = publicWidgetConfig(
      {
        id: "agent-1",
        name: "客服",
        instructions: "内部提示词",
        model: { provider: "openai-compatible", modelId: "m", apiKey: "sk-secret" },
        tools: [{ name: "bash", enabled: true }],
        knowledgeBaseIds: ["kb-1"],
      } as never,
      settings({ title: "标题", welcome: "欢迎" }),
    );
    expect(cfg).toMatchObject({ agentId: "agent-1", title: "标题", welcome: "欢迎", enabled: true });
    const json = JSON.stringify(cfg);
    for (const leak of ["sk-secret", "内部提示词", "bash", "kb-1", "modelId"]) expect(json).not.toContain(leak);
  });

  it("默认配置可用（未配置时也有合理标题与欢迎语）", () => {
    const d = defaultWidgetSettings("agent-1");
    expect(d.title).toBe(WIDGET_DEFAULTS.title);
    expect(d.enabled).toBe(false);
    expect(d.embedKey).toBe("");
    expect(d.position).toBe("right");
  });
});

describe("访客会话标记", () => {
  it("识别客服会话 meta；非客服会话返回 null", () => {
    const meta = { widget: { visitorToken: "t", origin: "https://a.com", createdAt: "now" } };
    expect(widgetMetaOf({ meta })?.visitorToken).toBe("t");
    expect(widgetMetaOf({ meta: {} })).toBeNull();
    expect(widgetMetaOf(null)).toBeNull();
  });
});
