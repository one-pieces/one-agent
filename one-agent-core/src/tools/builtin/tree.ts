import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", ".turbo", "coverage"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 500;

/**
 * tree：一次返回目录树（探索型任务的高信息密度工具）。
 * 自动跳过 node_modules/.git 等噪音目录，避免模型逐层 ls 消耗迭代轮次。
 * 输出为缩进树文本，目录带 / 后缀；超过上限时标记 truncated 并附被截断目录提示。
 */
export const treeTool = defineTool({
  name: "tree",
  description:
    "一次性返回目录树（缩进格式，目录带 / 后缀）。自动跳过 node_modules/.git/.next/dist 等噪音目录；支持 depth 限制。适合先看项目整体结构，再决定深入哪些目录。path 为绝对路径或相对会话工作目录。",
  schema: z.object({
    path: z.string().min(1).default("."),
    depth: z.number().int().min(1).max(8).optional().default(3),
  }),
  async execute(ctx, { path = ".", depth = 3 }) {
    try {
      const root = resolveToolPath(path, ctx.cwd);
      const st = await stat(root);
      if (!st.isDirectory()) {
        return { ok: false, output: null, error: `tree: 不是目录: ${path}` };
      }

      const lines: string[] = [];
      let truncatedDirs = 0;
      let count = 0;

      const walk = async (dir: string, prefix: string, remaining: number): Promise<void> => {
        if (count >= MAX_ENTRIES) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          lines.push(`${prefix}[无法读取]`);
          return;
        }
        // 目录排前、各自按名字排序，输出稳定
        const sorted = entries.sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          return ad - bd || a.name.localeCompare(b.name);
        });
        const visible = sorted.filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)));
        for (let i = 0; i < visible.length; i++) {
          if (count >= MAX_ENTRIES) {
            truncatedDirs++;
            return;
          }
          const e = visible[i]!;
          const last = i === visible.length - 1;
          const branch = last ? "└── " : "├── ";
          const childPrefix = prefix + (last ? "    " : "│   ");
          if (e.isDirectory()) {
            lines.push(`${prefix}${branch}${e.name}/`);
            count++;
            if (remaining > 0) {
              await walk(join(dir, e.name), childPrefix, remaining - 1);
            } else {
              truncatedDirs++;
            }
          } else {
            lines.push(`${prefix}${branch}${e.name}`);
            count++;
          }
        }
      };

      lines.push(root);
      await walk(root, "", depth - 1);

      const out: string[] = [lines.join("\n")];
      if (count >= MAX_ENTRIES) {
        out.push(`\n[已截断] 条目超过上限 ${MAX_ENTRIES}。可用 find 或针对性 tree 继续深入。`);
      } else if (truncatedDirs > 0) {
        out.push(`\n[已截断] 达到 depth=${depth} 深度限制，未展开目录约 ${truncatedDirs} 个。可增大 depth 或针对子目录再调 tree。`);
      }
      return { ok: true, output: out.join("\n") };
    } catch (err) {
      return { ok: false, output: null, error: `tree 失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
