import { randomUUID } from "node:crypto";
import { db, newEmbedKey, type WidgetSettings } from "./db.ts";
import { kernel } from "./kernel.ts";
import type { AgentConfig, StreamChunk } from "@one-agent/core";

/**
 * 客服组件（Widget）服务端逻辑：嵌入配置、来源校验、CORS、访客会话、限流、嵌入代码生成。
 *
 * 安全边界（面向公网访客，比后台接口严格）：
 * - 公开接口只认 `agentId + embedKey`（key 是"允许被嵌入"的凭据，可重置）
 * - 来源白名单非空时校验 `Origin`；空则不限制来源（但访客仍拿不到任何后台数据）
 * - 访客会话用一次性 token 绑定（sessionId 单独泄露也不能读别人的对话记录）
 * - 访客**一律不能**触发需要审批的工具（onApproval 恒 false）
 * - 限流：每访客/每条会话每分钟消息条数上限
 */

/** 未配置时的默认值（title/subtitle 会回落到 agent 名） */
export const WIDGET_DEFAULTS = {
  title: "在线客服",
  subtitle: "通常几分钟内回复",
  welcome: "你好！有什么可以帮你的？",
  placeholder: "输入你的问题…",
  primaryColor: "#2f6bff",
  position: "right" as const,
  rateLimit: 20,
};

/** 配置缺失时的默认位（不落库，读时补） */
export function defaultWidgetSettings(agentId: string): WidgetSettings {
  const now = new Date().toISOString();
  return {
    agentId,
    enabled: false,
    embedKey: "",
    title: WIDGET_DEFAULTS.title,
    subtitle: WIDGET_DEFAULTS.subtitle,
    welcome: WIDGET_DEFAULTS.welcome,
    placeholder: WIDGET_DEFAULTS.placeholder,
    primaryColor: WIDGET_DEFAULTS.primaryColor,
    position: WIDGET_DEFAULTS.position,
    origins: [],
    rateLimit: WIDGET_DEFAULTS.rateLimit,
    createdAt: now,
    updatedAt: now,
  };
}

/** 读配置并补齐缺省项（title 回落到 agent 名） */
export function effectiveWidgetSettings(agent: { id: string; name?: string }): WidgetSettings {
  const stored = db.getWidgetSettings(agent.id);
  const base = stored ?? defaultWidgetSettings(agent.id);
  return {
    ...base,
    title: base.title || agent.name || WIDGET_DEFAULTS.title,
    subtitle: base.subtitle || WIDGET_DEFAULTS.subtitle,
    welcome: base.welcome || WIDGET_DEFAULTS.welcome,
    placeholder: base.placeholder || WIDGET_DEFAULTS.placeholder,
    primaryColor: base.primaryColor || WIDGET_DEFAULTS.primaryColor,
    rateLimit: base.rateLimit || WIDGET_DEFAULTS.rateLimit,
  };
}

// ── 来源校验 ──

/** 从请求推断来源：优先 Origin，其次 Referer；都没有则为 null（服务端调用/curl） */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return normalizeOrigin(origin);
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return normalizeOrigin(new URL(referer).origin);
  } catch {
    return null;
  }
}

/** 日志里只留前 10 位（key 是公开凭据，但仍不必整串进日志） */
export function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 10)}…${key.slice(-4)}` : "(空/短)";
}

export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "").toLowerCase();
}

/** 白名单匹配：支持 `example.com`（等价 https?）、`*.example.com`（子域）、带端口的完整 origin */
export function originAllowed(origin: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!origin) return false;
  // 传入的 origin 也要归一化（大小写/尾斜杠）——浏览器发的是小写，但脚本与代理可能不是
  const normalized = normalizeOrigin(origin);
  const host = normalized.replace(/^https?:\/\//, "");
  return allowlist.some((raw) => {
    const pattern = normalizeOrigin(raw);
    const bare = pattern.replace(/^https?:\/\//, "");
    if (bare.startsWith("*.")) {
      const suffix = bare.slice(1); // .example.com
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    // 带协议 = 完整精确匹配（http/https 不互相放行）；不带协议 = 只比 host（忽略协议）
    if (/^https?:\/\//.test(pattern)) return pattern === normalized;
    return bare === host;
  });
}

export interface OriginCheck {
  ok: boolean;
  origin: string | null;
  error?: string;
}

export function checkOrigin(request: Request, settings: WidgetSettings): OriginCheck {
  const origin = requestOrigin(request);
  if (!originAllowed(origin, settings.origins)) {
    return {
      ok: false,
      origin,
      error: `来源未授权：${origin ?? "(无 Origin)"}。请把该域名加入 agent 的客服组件「允许的来源」白名单。`,
    };
  }
  return { ok: true, origin };
}

// ── CORS ──

export function corsHeaders(request: Request, settings: WidgetSettings): Record<string, string> {
  const origin = requestOrigin(request);
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  // 白名单为空 → 允许任意来源（公开可嵌入）；非空 → 回显校验通过的来源
  if (settings.origins.length === 0) headers["access-control-allow-origin"] = origin ?? "*";
  else if (origin && originAllowed(origin, settings.origins)) headers["access-control-allow-origin"] = origin;
  return headers;
}

/** preflight（跨域 POST content-type: application/json 会先发 OPTIONS） */
export function preflightResponse(request: Request, settings: WidgetSettings, check: OriginCheck): Response {
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: 403, headers: corsHeaders(request, settings) });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request, settings) });
}

/** 统一的公开接口 JSON 响应（带 CORS） */
export function widgetJson(
  request: Request,
  settings: WidgetSettings,
  body: unknown,
  status = 200,
): Response {
  return Response.json(body, { status, headers: corsHeaders(request, settings) });
}

// ── 访客会话 ──

export interface WidgetSessionInfo {
  sessionId: string;
  visitorToken: string;
}

/** 会话 meta 里的客服标记（后台可据此区分访客会话） */
export interface WidgetSessionMeta {
  widget: {
    visitorToken: string;
    origin: string | null;
    userAgent?: string;
    createdAt: string;
  };
}

export function widgetMetaOf(session: { meta?: Record<string, unknown> } | null | undefined): WidgetSessionMeta["widget"] | null {
  const meta = session?.meta as Partial<WidgetSessionMeta> | undefined;
  return meta?.widget ?? null;
}

/** 新建访客会话：普通 kernel 会话 + meta.widget 标记，token 用于后续读写校验 */
export async function createVisitorSession(
  agentId: string,
  origin: string | null,
  userAgent: string | null,
): Promise<WidgetSessionInfo> {
  const session = kernel.createSession(agentId);
  const visitorToken = randomUUID().replace(/-/g, "");
  const meta = (session.meta ?? {}) as Record<string, unknown>;
  meta.widget = {
    visitorToken,
    origin,
    userAgent: userAgent ?? undefined,
    createdAt: new Date().toISOString(),
  } satisfies WidgetSessionMeta["widget"];
  session.meta = meta;
  await kernel.store.saveSession(session);
  return { sessionId: session.id, visitorToken };
}

/** 校验访客 token：会话存在、属于该 agent、且是客服会话 */
export async function verifyVisitorSession(
  agentId: string,
  sessionId: string,
  visitorToken: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const session = await kernel.getSession(sessionId);
  if (!session) return { ok: false, error: "会话不存在或已过期", status: 404 };
  if (session.agentId !== agentId) return { ok: false, error: "会话不属于该 agent", status: 403 };
  const widget = widgetMetaOf(session);
  if (!widget) return { ok: false, error: "不是客服会话", status: 403 };
  if (!visitorToken || visitorToken !== widget.visitorToken) {
    return { ok: false, error: "访客凭证无效", status: 403 };
  }
  return { ok: true };
}

// ── 限流（进程内滑动窗口；单实例部署够用） ──

const buckets = new Map<string, number[]>();

export function checkRateLimit(key: string, limitPerMinute: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  if (limitPerMinute <= 0) return { ok: true, retryAfterSec: 0 };
  const windowMs = 60_000;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limitPerMinute) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
    buckets.set(key, hits);
    return { ok: false, retryAfterSec };
  }
  hits.push(now);
  buckets.set(key, hits);
  // 顺手清理过期条目，避免无界增长
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
  return { ok: true, retryAfterSec: 0 };
}

/** 测试用：清空限流计数 */
export function resetRateLimits(): void {
  buckets.clear();
}

// ── 嵌入代码 ──

/**
 * 生成客户网站要粘贴的嵌入代码。
 * `snippet` 里 agentId/key 都是公开信息（key 可重置），不含任何秘密。
 */
export function embedSnippet(baseUrl: string, agentId: string, embedKey: string, extra?: { position?: string; color?: string }): string {
  const attrs = [
    `src="${baseUrl.replace(/\/+$/, "")}/widget.js"`,
    `data-agent="${agentId}"`,
    `data-key="${embedKey}"`,
  ];
  if (extra?.position) attrs.push(`data-position="${extra.position}"`);
  if (extra?.color) attrs.push(`data-color="${extra.color}"`);
  attrs.push("async");
  return `<script ${attrs.join(" ")}></script>`;
}

/** 解析前的兜底 CORS（还不知道 settings 时，报错响应也要能被浏览器读到） */
export function genericCors(request: Request): Record<string, string> {
  return {
    "access-control-allow-origin": requestOrigin(request) ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export type PublicResolve =
  | { ok: true; agent: AgentConfig; settings: WidgetSettings; origin: string | null }
  | { ok: false; response: Response };

/**
 * 公开接口统一入口校验：agent 存在 → 嵌入 key 匹配 → 组件已启用 → 来源白名单。
 * 任何一步失败都返回**带 CORS 的 JSON 错误**（否则浏览器只会看到 "Failed to fetch"）。
 */
export function resolvePublicWidget(request: Request, agentId: string, key: string): PublicResolve {
  const fail = (status: number, error: string, settings?: WidgetSettings) =>
    ({
      ok: false,
      response: Response.json(
        { error },
        { status, headers: settings ? corsHeaders(request, settings) : genericCors(request) },
      ),
    }) as const;

  const agent = db.getAgent(agentId);
  if (!agent) return fail(404, `agent 不存在：${agentId}`);

  const stored = db.getWidgetSettings(agentId);
  if (!stored || !stored.embedKey) {
    return fail(403, "该 agent 还没有配置客服组件，请先在后台「客服组件」里开启");
  }
  if (!key || key !== stored.embedKey) {
    // 站点上粘的是旧嵌入代码（key 被重置过）是最常见的接入问题 → 日志留痕 + 可操作提示
    console.warn(
      `[widget] 嵌入 key 校验失败 agent=${agentId} 收到=${maskKey(key)} 当前=${maskKey(stored.embedKey)}（页面上的嵌入代码可能已过期）`,
    );
    return fail(
      403,
      "嵌入 key 无效或已重置：网页上的嵌入代码可能已过期。站长请在 one-agent 后台该 Agent 的「客服组件」里重新复制嵌入代码。",
    );
  }

  const settings = effectiveWidgetSettings(agent);
  if (!settings.enabled) return fail(403, "客服组件已关闭", settings);

  const check = checkOrigin(request, settings);
  if (!check.ok) return fail(403, check.error ?? "来源未授权", settings);

  return { ok: true, agent, settings, origin: check.origin };
}

/** 把嵌入配置里可公开的部分给 SDK/iframe（绝不包含 provider、工具等内部信息） */
export function publicWidgetConfig(agent: AgentConfig, settings: WidgetSettings) {
  return {
    agentId: agent.id,
    enabled: settings.enabled,
    title: settings.title,
    subtitle: settings.subtitle,
    welcome: settings.welcome,
    placeholder: settings.placeholder,
    primaryColor: settings.primaryColor,
    position: settings.position,
    rateLimit: settings.rateLimit,
  };
}
/** 工具名 → 访客可读的进行中文案（不暴露工具名、参数与结果） */
export const TOOL_LABELS: Record<string, string> = {
  knowledge_search: "正在查资料…",
  web_search: "正在搜索…",
  read: "正在查看文件…",
  grep: "正在检索…",
  find: "正在查找…",
  ls: "正在浏览…",
  tree: "正在浏览目录…",
  calculator: "正在计算…",
};

/** 访客可见的事件白名单：文本/用量/结束/错误 + 工具进行中状态（不含工具名与结果） */
export function sanitizeVisitorChunk(chunk: StreamChunk): Record<string, unknown> | null {
  switch (chunk.type) {
    case "text":
      return { type: "text", delta: chunk.delta };
    case "usage":
      return { type: "usage", inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
    case "tool_call":
      return { type: "status", label: TOOL_LABELS[chunk.name] ?? "正在处理…" };
    case "tool_result":
      // 工具结果不进访客视野（可能含内部数据）
      return null;
    case "error":
      return { type: "error", message: "抱歉，服务暂时不可用，请稍后再试。" };
    case "done":
      return { type: "done" };
    default:
      return null;
  }
}
