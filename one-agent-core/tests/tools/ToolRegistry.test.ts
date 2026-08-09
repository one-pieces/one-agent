import { describe, it, expect } from "vitest";
import { ToolRegistry, ToolRegistryError, defineTool } from "../../src/tools/index.ts";
import { z } from "zod";

const addTool = defineTool({
  name: "add",
  description: "两数相加",
  schema: z.object({ a: z.number(), b: z.number() }),
  execute(_ctx, { a, b }) {
    return { ok: true, output: a + b };
  },
});

const boomTool = defineTool({
  name: "boom",
  description: "总是抛异常",
  schema: z.object({}),
  async execute() {
    throw new Error("kaboom");
  },
});

describe("ToolRegistry", () => {
  it("add / get / list / has", () => {
    const r = new ToolRegistry();
    r.add(addTool);
    expect(r.has("add")).toBe(true);
    expect(r.get("add")?.name).toBe("add");
    expect(r.list().map((t) => t.name)).toEqual(["add"]);
  });

  it("remove 注销", () => {
    const r = new ToolRegistry();
    r.add(addTool);
    expect(r.remove("add")).toBe(true);
    expect(r.remove("add")).toBe(false);
    expect(r.has("add")).toBe(false);
  });

  it("update 热更新（替换 description）", () => {
    const r = new ToolRegistry();
    r.add(addTool);
    r.update("add", { description: "两数相加 v2" });
    expect(r.get("add")?.description).toBe("两数相加 v2");
  });

  it("update 不存在的工具抛错", () => {
    const r = new ToolRegistry();
    expect(() => r.update("nope", { description: "x" })).toThrow(ToolRegistryError);
  });

  it("execute：合法入参返回结果", async () => {
    const r = new ToolRegistry();
    r.add(addTool);
    const res = await r.execute({}, { id: "c1", name: "add", input: { a: 2, b: 3 } });
    expect(res).toEqual({ ok: true, output: 5 });
  });

  it("execute：zod 校验失败 → ok:false + 错误信息", async () => {
    const r = new ToolRegistry();
    r.add(addTool);
    const res = await r.execute({}, { id: "c1", name: "add", input: { a: "x", b: 3 } });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("参数校验失败");
  });

  it("execute：工具抛异常 → ok:false（不向上抛）", async () => {
    const r = new ToolRegistry();
    r.add(boomTool);
    const res = await r.execute({}, { id: "c1", name: "boom", input: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("kaboom");
  });

  it("execute：未注册工具抛 ToolRegistryError", async () => {
    const r = new ToolRegistry();
    await expect(r.execute({}, { id: "c1", name: "ghost", input: {} })).rejects.toThrow(ToolRegistryError);
  });

  it("defineTool 生成 JSON Schema（z.toJSONSchema）", () => {
    expect(addTool.inputSchema).toMatchObject({
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    });
  });
});
