import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/ToolRegistry.ts";
import { writeTool } from "../../src/tools/builtin/write.ts";
import { readTool } from "../../src/tools/builtin/read.ts";
import { lsTool } from "../../src/tools/builtin/ls.ts";
import { editTool } from "../../src/tools/builtin/edit.ts";
import { grepTool } from "../../src/tools/builtin/grep.ts";
import { findTool } from "../../src/tools/builtin/find.ts";
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
  it("write 相对路径写入 ctx.cwd 下（自动建父目录），返回绝对路径", async () => {
    const ws = await makeWs();
    const registry = new ToolRegistry();
    registry.add(writeTool);

    const r = (await registry.execute({ cwd: ws }, { id: "c1", name: "write", input: { path: "notes/报告.md", content: "你好" } })) as ToolResult;
    expect(r.ok).toBe(true);
    const out = r.output as { path: string; bytes: number };
    expect(out.path).toBe(join(ws, "notes", "报告.md"));
    expect(out.bytes).toBe(6); // "你好" UTF-8 6 字节
    expect(await readFile(join(ws, "notes", "报告.md"), "utf-8")).toBe("你好");
  });

  it("write 绝对路径原样写入，不受 ctx.cwd 影响", async () => {
    const ws = await makeWs();
    const registry = new ToolRegistry();
    registry.add(writeTool);

    const target = join(ws, "abs.txt");
    const r = (await registry.execute({ cwd: ws }, { id: "c1", name: "write", input: { path: target, content: "x" } })) as ToolResult;
    expect(r.ok).toBe(true);
    expect((r.output as { path: string }).path).toBe(target);
  });

  it("read / ls 相对路径同样解析到 ctx.cwd", async () => {
    const ws = await makeWs();
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "a.txt"), "hello", "utf-8");

    const registry = new ToolRegistry();
    registry.add(readTool);
    registry.add(lsTool);

    const readR = (await registry.execute({ cwd: ws }, { id: "c1", name: "read", input: { path: "sub/a.txt" } })) as ToolResult;
    expect(readR.ok).toBe(true);
    expect(readR.output).toBe("hello");

    const listR = (await registry.execute({ cwd: ws }, { id: "c2", name: "ls", input: { path: "." } })) as ToolResult;
    expect(listR.ok).toBe(true);
    expect(listR.output).toContain("sub/");
  });

  it("read 读取图像 → 返回大小/尺寸元信息（PNG 头解析）", async () => {
    const ws = await makeWs();
    // 最小 PNG 头：签名(8B) + IHDR 尺寸（宽 100 高 50）
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(50, 20);
    await writeFile(join(ws, "pic.png"), png);

    const registry = new ToolRegistry();
    registry.add(readTool);
    const r = (await registry.execute({ cwd: ws }, { id: "c1", name: "read", input: { path: "pic.png" } })) as ToolResult;
    expect(r.ok).toBe(true);
    expect(r.output).toMatchObject({ type: "image", width: 100, height: 50, sizeBytes: 24 });
  });

  it("edit 补丁式替换：唯一匹配成功 / 多处匹配报错 / replace_all / 未找到报错", async () => {
    const ws = await makeWs();
    await writeFile(join(ws, "doc.txt"), "第一行 alpha\n第二行 beta\n", "utf-8");

    const registry = new ToolRegistry();
    registry.add(editTool);

    // 唯一匹配替换
    const r1 = (await registry.execute({ cwd: ws }, { id: "c1", name: "edit", input: { path: "doc.txt", old_string: "beta", new_string: "BETA" } })) as ToolResult;
    expect(r1.ok).toBe(true);
    expect((r1.output as { replacements: number }).replacements).toBe(1);
    expect(await readFile(join(ws, "doc.txt"), "utf-8")).toBe("第一行 alpha\n第二行 BETA\n");

    // 未找到 → 报错并附附近内容
    const r2 = (await registry.execute({ cwd: ws }, { id: "c2", name: "edit", input: { path: "doc.txt", old_string: "不存在", new_string: "x" } })) as ToolResult;
    expect(r2.ok).toBe(false);
    expect(String(r2.error)).toContain("未找到 old_string");

    // 多处匹配且未指定 replace_all → 报错
    await writeFile(join(ws, "dup.txt"), "aa\nbb\naa\n", "utf-8");
    const r3 = (await registry.execute({ cwd: ws }, { id: "c3", name: "edit", input: { path: "dup.txt", old_string: "aa", new_string: "zz" } })) as ToolResult;
    expect(r3.ok).toBe(false);
    expect(String(r3.error)).toContain("出现 2 次");

    // replace_all 全部替换
    const r4 = (await registry.execute({ cwd: ws }, { id: "c4", name: "edit", input: { path: "dup.txt", old_string: "aa", new_string: "zz", replace_all: true } })) as ToolResult;
    expect(r4.ok).toBe(true);
    expect((r4.output as { replacements: number }).replacements).toBe(2);
    expect(await readFile(join(ws, "dup.txt"), "utf-8")).toBe("zz\nbb\nzz\n");
  });

  it("grep 正则搜索文件内容，返回 文件:行号:内容；find 按通配符找文件名", async () => {
    const ws = await makeWs();
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "a.ts"), "const x = 1;\n// TODO fix\n", "utf-8");
    await writeFile(join(ws, "src", "b.md"), "# 标题\nTODO 事项\n", "utf-8");
    await writeFile(join(ws, "README.md"), "说明\n", "utf-8");

    const registry = new ToolRegistry();
    registry.add(grepTool);
    registry.add(findTool);

    const g = (await registry.execute({ cwd: ws }, { id: "c1", name: "grep", input: { pattern: "TODO" } })) as ToolResult;
    expect(g.ok).toBe(true);
    const gm = (g.output as { matches: Array<{ file: string; line: number }> }).matches;
    expect(gm.length).toBe(2);
    expect(gm.map((m) => m.file).sort()).toEqual(["src/a.ts", "src/b.md"].sort());
    expect(gm.find((m) => m.file === "src/b.md")!.line).toBe(2);

    const f = (await registry.execute({ cwd: ws }, { id: "c2", name: "find", input: { pattern: "*.md" } })) as ToolResult;
    expect(f.ok).toBe(true);
    const fm = (f.output as { matches: string[] }).matches;
    expect(fm.sort()).toEqual(["README.md", "src/b.md"].sort());

    // 无匹配 → ok:true + 空列表 + message
    const g2 = (await registry.execute({ cwd: ws }, { id: "c3", name: "grep", input: { pattern: "不存在的词" } })) as ToolResult;
    expect(g2.ok).toBe(true);
    expect((g2.output as { total: number }).total).toBe(0);
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
