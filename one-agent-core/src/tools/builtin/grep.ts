import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);
const MAX_DEPTH = 10;

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

async function listFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await listFiles(p, depth + 1)));
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** 在文件/目录中搜索文本（正则）。返回 文件:行号:内容 列表 */
export const grepTool = defineTool({
  name: "grep",
  description:
    "在文件或目录中搜索文本（支持正则表达式）。返回 文件:行号:内容 列表。相对路径以会话工作目录为基准；默认跳过 node_modules/.git 等目录。",
  schema: z.object({
    pattern: z.string().min(1).max(500),
    path: z.string().optional().default("."),
    limit: z.number().int().positive().max(1000).optional().default(100),
  }),
  async execute(ctx, { pattern, path = ".", limit = 100 }) {
    try {
      const re = new RegExp(pattern);
      const root = resolveToolPath(path, ctx.cwd);
      const st = await stat(root);
      const files = st.isDirectory() ? await listFiles(root, 0) : [root];
      const isDir = st.isDirectory();

      const matches: GrepMatch[] = [];
      for (const f of files) {
        if (matches.length >= limit) break;
        let text: string;
        try {
          text = await readFile(f, "utf-8");
        } catch {
          continue; // 二进制/无权限 → 跳过
        }
        if (text.includes("\u0000")) continue; // 二进制
        const rel = isDir ? relative(root, f) : f;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          if (re.test(lines[i]!)) {
            matches.push({ file: rel, line: i + 1, text: lines[i]!.slice(0, 200) });
          }
        }
      }

      if (matches.length === 0) {
        return { ok: true, output: { matches: [], total: 0, message: `未找到匹配: ${pattern}` } };
      }
      return { ok: true, output: { matches, total: matches.length, truncated: matches.length >= limit } };
    } catch (err) {
      return { ok: false, output: null, error: `grep 失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
