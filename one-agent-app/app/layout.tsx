import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "one-agent",
  description: "one-agent 应用层（Next.js 16）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <nav className="nav">
          <Link href="/agents" className="brand">
            ⚡ one-agent
          </Link>
          <div className="nav-links">
            <Link href="/agents">Agents</Link>
            <Link href="/agents/new">新建 Agent</Link>
            <Link href="/logs">请求日志</Link>
          </div>
        </nav>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
