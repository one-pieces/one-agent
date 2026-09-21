import { z } from "zod";
import { defineTool } from "../define.ts";
import { findLatestPlan, listPlanFiles, writePlanFile } from "../../plan/planFiles.ts";

/**
 * plan 工具：写/读**方案文档**（给人看的 markdown 方案）。
 * - 传 content → 写入 `<会话工作区>/.oneagent/plans/<ts>-<slug>.md`，返回相对路径
 * - 无参数   → 读取最新方案（内容 + 路径）；没有则明确告知"还没有方案"
 *
 * 与 todo 的分工：todo 是执行清单（状态、短），plan 是方案文档（结构、长、可 review）。
 * 写操作只落在工作区内的 `.oneagent/plans/`（调度器按该目录做路径重叠判定）。
 */
export const planTool = defineTool({
  name: "plan",
  description:
    "写或读方案文档（markdown）。需要让人 review 的多步方案、或任务复杂到值得先写清楚再看时使用：传 content 写入工作区 .oneagent/plans/，返回可 read 的相对路径；无参数调用读取最新方案。只做方案不做执行——写完应征询是否开始执行。执行中的进度用 todo 工具记录，不要写进方案文档。",
  schema: z.object({
    content: z.string().min(1).max(200_000).optional(),
    title: z.string().min(1).max(120).optional(),
  }),
  async execute(ctx, { content, title }) {
    const cwd = ctx.cwd;
    if (!cwd) return { ok: false, output: null, error: "plan 需要工作目录（ctx.cwd 缺失）" };

    if (content === undefined && title !== undefined) {
      // 只给 title 不给 content：模型常见的误用（以为标题就能建方案）。明确纠正，别静默走"读"。
      return {
        ok: false,
        output: null,
        error: "plan: 写方案必须提供 content（markdown 正文）；只想读取当前方案请不要传任何参数。",
      };
    }

    if (content === undefined) {
      const latest = await findLatestPlan(cwd);
      if (!latest) {
        return { ok: true, output: { plan: null, note: "还没有方案文档；需要时用 plan 工具写入一份。" } };
      }
      return {
        ok: true,
        output: { plan: { path: latest.path, updatedAt: latest.updatedAt, content: latest.content } },
      };
    }

    try {
      const written = await writePlanFile(cwd, content, title ? { title } : {});
      const plans = await listPlanFiles(cwd);
      return {
        ok: true,
        output: {
          path: written.path,
          title: written.title,
          bytes: written.bytes,
          planCount: plans.length,
          note: "方案已保存。请简要说明方案要点并征询是否按它执行；本轮不要直接开始执行。",
        },
      };
    } catch (err) {
      return { ok: false, output: null, error: `写入方案失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
