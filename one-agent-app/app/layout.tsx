import type { Metadata } from "next";
import AppNavbar from "@/components/AppNavbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "one-agent",
  description: "one-agent 应用层（Next.js 16）",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="app-shell">
          <AppNavbar />
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
