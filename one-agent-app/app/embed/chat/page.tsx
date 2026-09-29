import type { Metadata } from "next";
import WidgetChat from "@/components/widget/WidgetChat";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "在线客服",
  // 嵌入页不参与搜索引擎收录
  robots: { index: false, follow: false },
};

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * /embed/chat?agentId=&key=&color=&theme=position=
 *
 * 访客侧对话页：跑在客户网站的 iframe 里（由 widget.js 注入），
 * 不带后台外壳（根布局只有 html/body），只认公开的 agentId + embedKey。
 */
export default async function EmbedChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  return (
    <WidgetChat
      agentId={one(sp.agentId)}
      embedKey={one(sp.key)}
      colorOverride={one(sp.color) || undefined}
      theme={one(sp.theme) || undefined}
    />
  );
}
