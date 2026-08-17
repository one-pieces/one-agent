import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "../define.ts";
import { resolveToolPath } from "../../utils.ts";

/**
 * 补丁式局部编辑：查找 old_string → 替换为 new_string。
 * - old_string 需唯一；多处匹配时提示补充上下文或使用 replace_all
 * - 未找到时返回错误并附文件开头附近内容，帮助模型修正
 */
export const editTool = defineTool({
  name: "edit",
  description:
    "对文件进行局部修改（补丁式）：查找 old_string 并替换为 new_string。old_string 需唯一；多处匹配时返回错误，可用 replace_all 或更长的上下文。未找到时返回错误并附附近内容。相对路径以会话工作目录为基准。",
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string().max(200_000).default(""),
    replace_all: z.boolean().optional().default(false),
  }),
  async execute(ctx, { path, old_string, new_string, replace_all }) {
    try {
      const resolved = resolveToolPath(path, ctx.cwd);
      const content = await readFile(resolved, "utf-8");
      const count = content.split(old_string).length - 1;
      if (count === 0) {
        const near = content.slice(0, 200) + (content.length > 200 ? "…" : "");
        return {
          ok: false,
          output: null,
          error: `未找到 old_string（出现 0 次）。文件开头附近：\n"""\n${near}\n"""`,
        };
      }
      if (count > 1 && !replace_all) {
        return {
          ok: false,
          output: null,
          error: `old_string 出现 ${count} 次，请补充更多上下文使匹配唯一，或设置 replace_all: true`,
        };
      }
      const next = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, next, "utf-8");
      return { ok: true, output: { path: resolved, replacements: replace_all ? count : 1 } };
    } catch (err) {
      return { ok: false, output: null, error: `编辑失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
