import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../define.ts";

const execAsync = promisify(exec);

/**
 * 危险工具：在终端运行 shell 命令。
 * 默认不启用（AgentForm 中 dangerous 默认关闭）；启用前需确认安全策略。
 */
export const bashTool = defineTool({
  name: "bash",
  description: "在终端运行 Shell 命令。仅返回前 5000 字符。危险操作请谨慎。",
  schema: z.object({
    command: z.string().min(1).max(2000),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  }),
  meta: { dangerous: true, sandbox: true, timeoutMs: 60_000 },
  async execute(ctx, { command, cwd, timeoutMs = 30_000 }) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        // LLM 未显式传 cwd 时，默认在会话工作区（ctx.cwd）执行，与文件类工具保持同一基准
        cwd: cwd ?? ctx.cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        ok: true,
        output: {
          stdout: stdout.slice(0, 5000),
          stderr: stderr.slice(0, 2000),
        },
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        output: null,
        error: `执行失败: ${e?.message ?? String(err)}${e?.stderr ? ` stderr: ${e.stderr.slice(0, 1000)}` : ""}`,
      };
    }
  },
});
