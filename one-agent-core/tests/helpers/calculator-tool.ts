import { z } from "zod";
import { defineTool } from "../../src/tools/define.ts";

/**
 * 测试专用计算工具（替代已移除的内置 calculator，仅用于验证 AgentLoop/Session 行为）。
 * - "(1+2)*3" → 9
 * - "1/0" → ok:false（除以零）
 */
export const testCalculatorTool = defineTool({
  name: "calculator",
  description: "计算表达式",
  schema: z.object({ expression: z.string() }),
  async execute(_ctx, { expression }) {
    try {
      const value = Function(`"use strict"; return (${expression});`)() as number;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, output: null, error: "计算失败: 除以零" };
      }
      return { ok: true, output: value };
    } catch (err) {
      return { ok: false, output: null, error: `计算失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
