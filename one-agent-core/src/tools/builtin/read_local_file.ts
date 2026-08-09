import { z } from "zod";
import { readFile } from "node:fs/promises";
import { defineTool } from "../define.js";

export const readLocalFileTool = defineTool({
  name: "read_local_file",
  description: "读取本地文件内容（UTF-8）。path 为绝对路径或相对当前工作目录。大文件会自动截断。",
  schema: z.object({
    path: z.string().min(1),
    maxChars: z.number().int().positive().max(100_000).optional(),
  }),
  async execute(_ctx, { path, maxChars = 20_000 }) {
    try {
      const content = await readFile(path, "utf-8");
      const truncated =
        content.length > maxChars ? content.slice(0, maxChars) + `\n...[已截断，总长度 ${content.length}]` : content;
      return { ok: true, output: truncated };
    } catch (err) {
      return { ok: false, output: null, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
