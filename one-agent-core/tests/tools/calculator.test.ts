import { describe, it, expect } from "vitest";
import { evaluate, calculatorTool } from "../../src/tools/index.ts";

describe("evaluate（安全表达式求值）", () => {
  it("四则运算与优先级", () => {
    expect(evaluate("1+2*3")).toBe(7);
    expect(evaluate("(1+2)*3")).toBe(9);
    expect(evaluate("100/7")).toBeCloseTo(14.2857, 4);
  });
  it("幂与取模", () => {
    expect(evaluate("2^10")).toBe(1024);
    expect(evaluate("10%3")).toBe(1);
  });
  it("小数", () => {
    expect(evaluate("0.5+0.25")).toBe(0.75);
    expect(evaluate(".5*2")).toBe(1);
  });
  it("一元负号", () => {
    expect(evaluate("-5+3")).toBe(-2);
    expect(evaluate("2^-3")).toBeCloseTo(0.125, 6);
  });
  it("非法输入抛错", () => {
    expect(() => evaluate("abc")).toThrow();
    expect(() => evaluate("1/0")).toThrow(/除以零/);
    expect(() => evaluate("(1+2")).toThrow(/括号/);
  });
});

describe("calculatorTool", () => {
  it("正常返回结果", async () => {
    const res = await calculatorTool.execute({}, { expression: "(1+2)*3" });
    expect(res).toEqual({ ok: true, output: 9 });
  });
  it("非法表达式 → ok:false", async () => {
    const res = await calculatorTool.execute({}, { expression: "abc" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("表达式无效");
  });
});
