import { z } from "zod";
import type { ToolSpec } from "../types.ts";

/**
 * 用 zod 定义工具：schema 用于「校验 + 生成 JSON Schema 发给 LLM」。
 * 与 eve 的 defineTool 同模式，但完全自研、零框架依赖。
 */
export function defineTool<TSchema extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: TSchema;
  execute: (ctx: Parameters<ToolSpec["execute"]>[0], input: z.infer<TSchema>) => ReturnType<ToolSpec["execute"]>;
  meta?: ToolSpec["meta"];
}): ToolSpec {
  return {
    name: def.name,
    description: def.description,
    inputSchema: z.toJSONSchema(def.schema),
    execute: def.execute as ToolSpec["execute"],
    meta: def.meta,
    validateInput(input: unknown) {
      const r = def.schema.safeParse(input);
      if (r.success) return { ok: true, value: r.data };
      const detail = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { ok: false, error: `参数校验失败：${detail}` };
    },
  };
}
