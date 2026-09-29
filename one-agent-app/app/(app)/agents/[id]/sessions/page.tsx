import type { Message } from "@one-agent/core";
import AgentSessionsList, { type AgentSessionRow } from "@/components/AgentSessionsList";
import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import { widgetMetaOf } from "@/lib/widget";

export const dynamic = "force-dynamic";

/** 会话里可读的标题：meta.title（自动生成）→ 第一条用户消息 → 会话 id */
function sessionTitle(messages: Message[], fallback: string, metaTitle?: string): string {
  if (metaTitle?.trim()) return metaTitle.trim();
  const firstUser = messages.find((m) => m.role === "user" && !m.synthetic && (m.content ?? "").trim());
  const text = firstUser?.content?.trim();
  if (text) return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return fallback;
}

/**
 * 对话记录（/agents/[id]/sessions）
 * 列出该 agent 的每个会话 = 每个"用户"与它的对话：内部会话（你在后台聊的）与客服会话
 * （网站访客通过嵌入组件聊的，带来源域名）。
 */
export default async function AgentSessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = db.getAgent(id);
  const sessions = await kernel.listSessions(id);
  const widget = db.getWidgetSettings(id);

  const rows: AgentSessionRow[] = sessions
    .map((s) => {
      const meta = (s.meta ?? {}) as { title?: string; tokenUsage?: { inputTokens?: number; outputTokens?: number } };
      const visitor = widgetMetaOf(s);
      const visible = s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && !m.synthetic);
      const last = visible[visible.length - 1];
      return {
        id: s.id,
        title: sessionTitle(s.messages, s.id, meta.title),
        kind: visitor ? ("visitor" as const) : ("internal" as const),
        origin: visitor?.origin ?? null,
        userAgent: visitor?.userAgent ?? null,
        messageCount: visible.length,
        userMessageCount: visible.filter((m) => m.role === "user").length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastSnippet: (last?.content ?? "").trim().slice(0, 120),
        inputTokens: meta.tokenUsage?.inputTokens ?? 0,
        outputTokens: meta.tokenUsage?.outputTokens ?? 0,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const visitorCount = rows.filter((r) => r.kind === "visitor").length;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ marginTop: 0 }}>对话记录</h3>
        <span className="field-hint" style={{ margin: 0 }}>
          共 {rows.length} 段对话 · 客服访客 {visitorCount} 段
          {widget?.enabled ? "" : "（客服组件当前未开启）"}
        </span>
      </div>
      <AgentSessionsList agentId={id} rows={rows} />
    </>
  );
}
