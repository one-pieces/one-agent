"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteAgentButton({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const del = async () => {
    if (!confirm(`确定删除 Agent ${agentId}？其会话仍保留在数据库中。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.push("/agents");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <button className="btn danger" onClick={() => void del()} disabled={busy}>
      删除
    </button>
  );
}
