import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "../define.js";

export const writeLocalFileTool = defineTool({
  name: "write_local_file",
  description: "写入/覆盖本地文件（UTF-8）。自动创建父目录。",
  schema: z.object({
    path: z.string().min(1),
    content: z.string().max(200_000),
  }),
  async execute(_ctx, { path, content }) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return { ok: true, output: { path, bytes: Buffer.byteLength(content, "utf-8") } };
    } catch (err) {
      return { ok: false, output: null, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
