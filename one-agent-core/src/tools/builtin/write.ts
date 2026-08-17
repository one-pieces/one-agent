import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

export const writeTool = defineTool({
  name: "write",
  description: "创建或覆盖文件（UTF-8）。自动创建父目录。相对路径以会话工作目录为基准。",
  schema: z.object({
    path: z.string().min(1),
    content: z.string().max(200_000),
  }),
  async execute(ctx, { path, content }) {
    try {
      const resolved = resolveToolPath(path, ctx.cwd);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return { ok: true, output: { path: resolved, bytes: Buffer.byteLength(content, "utf-8") } };
    } catch (err) {
      return { ok: false, output: null, error: `写入失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
