import type { ToolCall, ToolContext, ToolResult, ToolSpec } from "../types.ts";

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

/**
 * 工具注册表：运行时动态增删改查 —— 这是相对 eve「tools/*.ts 静态文件」的核心差异。
 * 每个 Agent 实例持有独立 registry。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 运行时动态注册（覆盖同名） */
  add(spec: ToolSpec): void {
    if (!spec.name) throw new ToolRegistryError("tool name is required");
    this.tools.set(spec.name, spec);
  }

  /** 运行时动态注销 */
  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 运行时动态更新（浅合并，不替换 execute/validateInput 可传 undefined 保留） */
  update(name: string, patch: Partial<Omit<ToolSpec, "name">>): void {
    const cur = this.tools.get(name);
    if (!cur) throw new ToolRegistryError(`tool not found: ${name}`);
    this.tools.set(name, { ...cur, ...patch, name });
  }

  /**
   * 执行工具调用：
   * 1) 校验入参（zod validateInput，若有）
   * 2) 执行工具
   * 3) 异常 → ok:false（不抛出，保证 loop 可继续）
   */
  async execute(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) throw new ToolRegistryError(`tool not registered: ${call.name}`);

    let input = call.input;
    if (tool.validateInput) {
      const v = tool.validateInput(call.input);
      if (!v.ok) return { ok: false, output: null, error: v.error };
      input = v.value;
    }

    try {
      const result = await tool.execute(ctx, input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: null, error: `工具 ${call.name} 执行异常：${message}` };
    }
  }
}
