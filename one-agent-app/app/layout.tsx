import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "one-agent",
  description: "one-agent 应用层（Next.js 16）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, sans-serif" }}>{children}</body>
    </html>
  );
}
