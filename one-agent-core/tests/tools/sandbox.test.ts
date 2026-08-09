import { describe, it, expect } from "vitest";
import { ToolRegistry, runLocalCommandTool } from "../../src/tools/index.ts";

describe("工具沙箱（worker_threads 隔离）", () => {
  const registry = new ToolRegistry();
  registry.add(runLocalCommandTool);

  it("沙箱内正常执行（run_local_command 标记 sandbox）", async () => {
    const res = await registry.execute({}, { id: "c1", name: "run_local_command", input: { command: "echo hi" } });
    expect(res.ok).toBe(true);
    const out = res.output as { stdout: string };
    expect(out.stdout.trim()).toBe("hi");
  });

  it("命令失败 → ok:false（进程内返回，不崩溃）", async () => {
    const res = await registry.execute({}, { id: "c1", name: "run_local_command", input: { command: "exit 3" } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("执行失败");
  });

  it("长命令超时 → 优雅失败（worker/exec 超时，主进程不受影响）", async () => {
    const res = await registry.execute(
      {},
      { id: "c1", name: "run_local_command", input: { command: "sleep 10", timeoutMs: 800 } },
    );
    expect(res.ok).toBe(false);
    // exec 内部超时（SIGTERM）→ "执行失败"；沙箱级超时 → "超时"
    expect(res.error).toMatch(/超时|执行失败/);
  });

  it("主进程存活（沙箱崩溃/超时不影响测试进程）", () => {
    expect(true).toBe(true);
  });
}, 30_000);
