import { getRequestLogs } from "@/lib/observability";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  const logs = getRequestLogs();
  return (
    <div className="page">
      <h1>请求日志（最近 {logs.length} 条）</h1>
      {logs.length === 0 ? (
        <p className="muted">暂无请求。发起一次对话后这里会出现 LLM 请求记录。</p>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i}>
                <td>{new Date(l.ts).toLocaleTimeString("zh-CN")}</td>
                <td>{l.model ?? "-"}</td>
                <td>{l.status}</td>
                <td>{l.durationMs}ms</td>
                <td className="muted" style={{ wordBreak: "break-all" }}>
                  {l.url}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
