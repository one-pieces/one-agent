import { z } from "zod";
import { defineTool } from "../define.ts";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = "Mozilla/5.0 (compatible; one-agent/0.1; +https://github.com/one-pieces/one-agent)";

/**
 * 免 key 网页搜索：抓取 DuckDuckGo HTML 版结果页（无官方 API key 需求的务实方案）。
 * 结果上限 5 条。网络异常/无结果 → ok:false（loop 可继续）。
 */
export const webSearchTool = defineTool({
  name: "web_search",
  description:
    "在互联网上搜索（DuckDuckGo），返回前 5 条结果（标题、链接、摘要）。适合查询实时信息、新闻、事实核对。",
  schema: z.object({ query: z.string().min(1).max(300) }),
  async execute(_ctx, { query }) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, output: null, error: `搜索失败 HTTP ${res.status}` };
      const html = await res.text();
      const results = parseResults(html);
      if (results.length === 0) return { ok: false, output: null, error: "没有找到结果" };
      return { ok: true, output: results };
    } catch (err) {
      return { ok: false, output: null, error: `搜索异常: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

function parseResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 5) {
    out.push({
      title: clean(m[2] ?? ""),
      url: decodeUrl(m[1] ?? ""),
      snippet: clean(m[4] ?? ""),
    });
  }
  return out;
}

function decodeUrl(href: string): string {
  try {
    if (href.includes("uddg=")) {
      const q = href.split("?")[1] ?? "";
      const uddg = new URLSearchParams(q).get("uddg");
      if (uddg) return uddg;
    }
    return href.startsWith("//") ? `https:${href}` : href;
  } catch {
    return href;
  }
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
