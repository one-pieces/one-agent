import type { AgentConfig } from "../types.ts";

/**
 * 规划规程（P1-a）：把"先规划后动手"的倾向作为**配置数据**注入 system 前缀。
 *
 * 设计要点（见 docs/self-planning-design.md）：
 * - Hermes 把同类规程硬编码在 `agent/plan_prompt.py`；one-agent 把它做成 `AgentConfig.planning`，
 *   可 UI 编辑、可按会话 override、可 A/B；
 * - 规程只随**首轮**的 system 消息注入一次（`AgentLoop` 仅在 history 里没有 system 时插入），
 *   因此会话内 system 字节稳定 —— 满足 prompt cache 不变量（P0-6）。
 */

/** 内置规划规程（mode = "prompt" 且未提供自定义 guidance 时使用） */
export const PLANNING_GUIDANCE = `规划规程（多步任务遵循；单步任务不要规划，直接做）：
1. 先探查再动手：用 read/grep/find/tree 了解现状，不要凭猜测修改文件。
2. 需要规划的信号：任务超过 3 个步骤、涉及多个文件、或必须先探索才能决定怎么做。
   命中信号时先用 todo 工具写出任务清单——顺序即优先级，同一时刻只保持一个 in_progress，
   每一步要具体到「哪份文件、做什么动作」。
3. 执行中维护清单：完成一步就更新状态；计划有变就重写整份清单（或 merge 更新）。
4. 完成后验证：能跑测试/检查就真跑（bash 执行、read 回读），验证通过才标记 completed。
5. 收尾：基于已获取的信息给结论；不确定就说明不确定，不要编造结果或假装已验证。`;

/** 取出该配置下生效的规划规程文本（mode 为 off / 未配置时返回 null） */
export function resolvePlanningGuidance(config: AgentConfig): string | null {
  const planning = config.planning;
  if (!planning || planning.mode !== "prompt") return null;
  const custom = planning.guidance?.trim();
  return custom && custom.length > 0 ? custom : PLANNING_GUIDANCE;
}

/**
 * 组装会话首轮的 system 消息内容：instructions + 可选规划规程。
 * 纯函数（只依赖 config）→ 同一 config 每次得到同一字符串，system 前缀稳定。
 */
export function buildSystemPrompt(config: AgentConfig): string {
  const parts: string[] = [];
  const instructions = config.instructions?.trim();
  if (instructions) parts.push(config.instructions);
  const guidance = resolvePlanningGuidance(config);
  if (guidance) parts.push(guidance);
  return parts.join("\n\n");
}
