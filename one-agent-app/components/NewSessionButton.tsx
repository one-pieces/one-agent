"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** 为指定 Agent 新建会话并跳转到对话页 */
export default function NewSessionButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const session = await res.json();
      if (!res.ok) throw new Error(session.error ?? "创建失败");
      router.push(`/chat/session/${session.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="btn primary" onClick={() => void create()} disabled={busy}>
      {busy ? "创建中…" : "＋ 新建对话"}
    </button>
  );
}
