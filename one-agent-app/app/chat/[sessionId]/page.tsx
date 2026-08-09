import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { kernel } from "@/lib/kernel";
import Chat from "@/components/Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await kernel.getSession(sessionId);
  if (!session) notFound();
  const config = db.getAgent(session.agentId);
  if (!config) notFound();

  return <Chat sessionId={sessionId} agentId={config.id} agentName={config.name} />;
}
