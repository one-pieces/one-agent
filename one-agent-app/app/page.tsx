export default function Home() {
  return (
    <main style={{ padding: "2rem" }}>
      <h1>one-agent</h1>
      <p>应用层骨架（M0）。对话与 Agent 管理 UI 将在 M3 实现。</p>
      <p>
        内核层（one-agent-core）M0 已完成：Provider 层已可用，运行{" "}
        <code>npm run demo</code>（根目录）可体验流式对话。
      </p>
    </main>
  );
}
