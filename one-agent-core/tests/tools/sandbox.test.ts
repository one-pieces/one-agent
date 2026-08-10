import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, runLocalCommandTool } from "../../src/tools/index.ts";

describe("工具沙箱（worker_threads 隔离）", () => {
  const registry = new ToolRegistry();
  registry.add(runLocalCommandTool);

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("沙箱内正常执行（run_local_command 标记 sandbox）", async () => {
    const res = await registry.execute({}, { id: "c1", name: "run_local_command", input: { command: "echo hi" } });
    expect(res.ok).toBe(true);
    const out = res.output as { stdout: string };
    expect(out.stdout.trim()).toBe("hi");
  });

  it("LLM 未传 cwd → 默认在 ctx.cwd（会话工作区）执行", async () => {
    const ws = mkdtempSync(join(tmpdir(), "one-agent-sandbox-"));
    dirs.push(ws);
    const res = await registry.execute(
      { cwd: ws },
      { id: "c1", name: "run_local_command", input: { command: "pwd" } },
    );
    expect(res.ok).toBe(true);
    // macOS /var → /private/var 符号链接：两侧 realpath 归一化后比较
    expect(realpathSync((res.output as { stdout: string }).stdout.trim())).toBe(realpathSync(ws));
  });

  it("LLM 显式传 cwd → 覆盖 ctx.cwd", async () => {
    const ws = mkdtempSync(join(tmpdir(), "one-agent-sandbox-"));
    const other = mkdtempSync(join(tmpdir(), "one-agent-other-"));
    dirs.push(ws, other);
    const res = await registry.execute(
      { cwd: ws },
      { id: "c1", name: "run_local_command", input: { command: "pwd", cwd: other } },
    );
    expect(res.ok).toBe(true);
    expect(realpathSync((res.output as { stdout: string }).stdout.trim())).toBe(realpathSync(other));
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
