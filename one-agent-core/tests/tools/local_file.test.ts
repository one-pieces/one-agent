import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import { writeLocalFileTool } from "../../src/tools/builtin/write_local_file.ts";
import { readLocalFileTool } from "../../src/tools/builtin/read_local_file.ts";
import { listLocalDirTool } from "../../src/tools/builtin/list_local_dir.ts";
import { Agent } from "../../src/agent/index.ts";
import { ScriptedProvider } from "../helpers/scripted-provider.ts";
import type { ToolContext, ToolResult, ToolSpec } from "../../src/types.ts";

const dirs: string[] = [];

async function makeWs(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "one-agent-ws-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("本地文件工具：相对路径以 ctx.cwd 为基准", () => {
  it("write_local_file 相对路径写入 ctx.cwd 下（自动建父目录），返回绝对路径", async () => {
    const ws = await makeWs();
    const registry = new ToolRegistry();
    registry.add(writeLocalFileTool);

    const r = (await registry.execute({ cwd: ws }, { id: "c1", name: "write_local_file", input: { path: "notes/报告.md", content: "你好" } })) as ToolResult;
    expect(r.ok).toBe(true);
    const out = r.output as { path: string; bytes: number };
    expect(out.path).toBe(join(ws, "notes", "报告.md"));
    expect(out.bytes).toBe(6); // "你好" UTF-8 6 字节
    expect(await readFile(join(ws, "notes", "报告.md"), "utf-8")).toBe("你好");
  });

  it("write_local_file 绝对路径原样写入，不受 ctx.cwd 影响", async () => {
    const ws = await makeWs();
    const registry = new ToolRegistry();
    registry.add(writeLocalFileTool);

    const target = join(ws, "abs.txt");
    const r = (await registry.execute({ cwd: ws }, { id: "c1", name: "write_local_file", input: { path: target, content: "x" } })) as ToolResult;
    expect(r.ok).toBe(true);
    expect((r.output as { path: string }).path).toBe(target);
  });

  it("read_local_file / list_local_dir 相对路径同样解析到 ctx.cwd", async () => {
    const ws = await makeWs();
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "a.txt"), "hello", "utf-8");

    const registry = new ToolRegistry();
    registry.add(readLocalFileTool);
    registry.add(listLocalDirTool);

    const readR = (await registry.execute({ cwd: ws }, { id: "c1", name: "read_local_file", input: { path: "sub/a.txt" } })) as ToolResult;
    expect(readR.ok).toBe(true);
    expect(readR.output).toBe("hello");

    const listR = (await registry.execute({ cwd: ws }, { id: "c2", name: "list_local_dir", input: { path: "." } })) as ToolResult;
    expect(listR.ok).toBe(true);
    expect(listR.output).toContain("sub/");
  });

  it("Agent 运行把 RunOptions.cwd 透传给工具上下文", async () => {
    const ws = await makeWs();
    let seenCwd: string | undefined;
    const probeTool: ToolSpec = {
      name: "probe_cwd",
      description: "记录 ctx.cwd",
      inputSchema: {},
      async execute(ctx: ToolContext) {
        seenCwd = ctx.cwd;
        return { ok: true, output: null };
      },
      meta: {},
    };
    const registry = new ToolRegistry();
    registry.add(probeTool);
    const agent = new Agent(
      {
        id: "t",
        name: "测试",
        instructions: "你是测试助手。",
        model: { provider: "openai-compatible", modelId: "mock", baseUrl: "http://localhost:1/v1", apiKey: "x" },
        tools: [{ name: "probe_cwd", enabled: true }],
        maxIterations: 2,
      },
      {
        provider: new ScriptedProvider([
          () => [{ type: "tool_call", id: "c1", name: "probe_cwd", input: {} }, { type: "done" }],
          () => [{ type: "text", delta: "完成" }, { type: "done" }],
        ]),
        tools: registry,
      },
    );
    for await (const _ of agent.run("执行", { sessionId: "s1", cwd: ws })) {
      // drain
    }
    expect(seenCwd).toBe(ws);
  });
});
