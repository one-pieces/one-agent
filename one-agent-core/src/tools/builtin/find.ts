import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache"]);
const MAX_DEPTH = 10;

/** 简单 glob（* ?）→ 正则 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** 按文件名查找（支持 * ? 通配符），目录带 / 后缀 */
export const findTool = defineTool({
  name: "find",
  description:
    "按文件名查找文件或目录（支持 * ? 通配符，如 *.md、report?.txt）。返回匹配的相对路径，目录带 / 后缀。相对路径以会话工作目录为基准；默认跳过 node_modules/.git 等目录。",
  schema: z.object({
    pattern: z.string().min(1).max(300),
    path: z.string().optional().default("."),
    limit: z.number().int().positive().max(1000).optional().default(100),
  }),
  async execute(ctx, { pattern, path = ".", limit = 100 }) {
    try {
      const re = globToRegExp(pattern);
      const root = resolveToolPath(path, ctx.cwd);
      const st = await stat(root);

      const out: string[] = [];
      if (!st.isDirectory()) {
        if (re.test(basename(root))) out.push(root);
      } else {
        const walk = async (dir: string, depth: number): Promise<void> => {
          if (depth > MAX_DEPTH || out.length >= limit) return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (out.length >= limit) return;
            const p = join(dir, entry.name);
            const rel = relative(root, p) || entry.name;
            if (entry.isDirectory()) {
              if (SKIP_DIRS.has(entry.name)) continue;
              if (re.test(entry.name)) out.push(rel + "/");
              await walk(p, depth + 1);
            } else if (entry.isFile() && re.test(entry.name)) {
              out.push(rel);
            }
          }
        };
        await walk(root, 0);
      }

      if (out.length === 0) {
        return { ok: true, output: { matches: [], total: 0, message: `未找到匹配: ${pattern}` } };
      }
      return { ok: true, output: { matches: out, total: out.length, truncated: out.length >= limit } };
    } catch (err) {
      return { ok: false, output: null, error: `find 失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
