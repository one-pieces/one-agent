import { z } from "zod";
import { readdir } from "node:fs/promises";
import { defineTool } from "../define.ts";

export const listLocalDirTool = defineTool({
  name: "list_local_dir",
  description: "列出目录下的文件和子目录（目录名带 / 后缀）。",
  schema: z.object({ path: z.string().min(1) }),
  async execute(_ctx, { path }) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return {
        ok: true,
        output: entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
      };
    } catch (err) {
      return { ok: false, output: null, error: `列出失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
