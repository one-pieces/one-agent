import { z } from "zod";
import { readdir } from "node:fs/promises";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

export const lsTool = defineTool({
  name: "ls",
  description: "列出目录下的文件和子目录（目录名带 / 后缀）。相对路径以会话工作目录为基准。",
  schema: z.object({ path: z.string().min(1) }),
  async execute(ctx, { path }) {
    try {
      const resolved = resolveToolPath(path, ctx.cwd);
      const entries = await readdir(resolved, { withFileTypes: true });
      return {
        ok: true,
        output: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
      };
    } catch (err) {
      return { ok: false, output: null, error: `列出失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
