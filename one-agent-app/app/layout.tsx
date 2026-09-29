import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "one-agent",
  description: "one-agent 应用层（Next.js 16）",
};

/**
 * 根布局：只放 html/body、主题恢复脚本与全局样式（body 无内边距/无外壳）。
 * - 后台外壳（侧栏 + main）在 `(app)/layout.tsx`
 * - 访客侧页面（/embed/chat，跑在客户网站的 iframe 里）不带任何后台外壳
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("one-agent:theme")==="light"){document.documentElement.setAttribute("data-theme","light")}}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
