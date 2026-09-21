import { describe, it, expect } from "vitest";
import {
  ToolGuardrailController,
  DEFAULT_IDEMPOTENT_TOOLS,
  DEFAULT_FAILURE_TOLERANT_TOOLS,
} from "../../src/agent/toolGuardrails.ts";

/** 用默认配置的控制器；warnAfter=2 / blockAfter=3 / haltAfterBlocks=3 */
function ctrl(cfg = {}) {
  return new ToolGuardrailController(cfg);
}

describe("toolGuardrails 默认表", () => {
  it("只读工具与失败容忍工具有默认值", () => {
    expect(DEFAULT_IDEMPOTENT_TOOLS).toContain("read");
    expect(DEFAULT_IDEMPOTENT_TOOLS).not.toContain("bash");
    expect(DEFAULT_FAILURE_TOLERANT_TOOLS).toContain("bash");
  });
});

describe("幂等工具：同参数同结果重复 → 提示 → 拦下", () => {
  it("连续相同结果第 2 次给提示，第 3 次拦下，第 3 次拦下后停轮", () => {
    const g = ctrl();
    const args = { path: "a.txt" };
    const out = { content: "same" };
    expect(g.afterCall("read", args, out, true)).toBeNull();          // 第 1 次：无
    const warn = g.afterCall("read", args, out, true);
    expect(warn?.action).toBe("warn");                                 // 第 2 次：提示
    expect(warn?.code).toBe("idempotent_no_progress");
    expect(g.afterCall("read", args, out, true)?.action).toBe("warn"); // 第 3 次：仍是提示（拦下发生在执行前）

    // 执行前：同参数第 4 次 → 拦下（不执行）
    const block = g.beforeCall("read", args);
    expect(block?.action).toBe("block");
    expect(block?.count).toBeGreaterThanOrEqual(3);
    expect(g.blockedCount).toBe(1);
    expect(g.shouldHalt).toBe(false);
  });

  it("结果不同就不再算重复（有进展）", () => {
    const g = ctrl();
    const args = { path: "a.txt" };
    g.afterCall("read", args, { content: "one" }, true);
    expect(g.afterCall("read", args, { content: "two" }, true)).toBeNull();
    expect(g.afterCall("read", args, { content: "three" }, true)).toBeNull();
    expect(g.beforeCall("read", args)).toBeNull();
  });

  it("参数不同就不算重复", () => {
    const g = ctrl();
    const out = { content: "same" };
    g.afterCall("read", { path: "a.txt" }, out, true);
    expect(g.afterCall("read", { path: "b.txt" }, out, true)).toBeNull();
  });
});

describe("失败路径", () => {
  it("同参数同结果连续失败 → 精确重试提示", () => {
    const g = ctrl();
    const args = { path: "missing.txt" };
    const out = { error: "ENOENT" };
    g.afterCall("read", args, out, false);
    const d = g.afterCall("read", args, out, false);
    expect(d?.action).toBe("warn");
    expect(d?.code).toBe("repeated_exact_failure");
    expect(d?.message).toContain("重试循环");
  });

  it("同工具不同参数反复失败（非失败容忍工具）→ 给「换个做法」建议", () => {
    const g = ctrl();
    g.afterCall("read", { path: "a" }, { error: "E1" }, false);
    g.afterCall("read", { path: "b" }, { error: "E2" }, false);
    const d = g.afterCall("read", { path: "c" }, { error: "E3" }, false);
    expect(d?.code).toBe("same_tool_failure");
    expect(d?.message).toContain("改变做法");
  });

  it("bash 属于失败容忍工具：只提示、不被拦下（拦截只发生在 beforeCall）", () => {
    const g = ctrl();
    g.afterCall("bash", { command: "ls nope" }, { error: "not found" }, false);
    g.afterCall("bash", { command: "ls nope2" }, { error: "not found" }, false);
    // 第 3 次不同命令失败 → 给提示，且是 bash 专属恢复建议
    const d = g.afterCall("bash", { command: "ls nope3" }, { error: "not found" }, false);
    expect(d?.code).toBe("same_tool_failure");
    expect(d?.message).toContain("pwd && ls -la");
    // 但拦截不会因此发生（不同参数 → beforeCall 不拦，也不计入停轮）
    expect(g.beforeCall("bash", { command: "ls nope4" })).toBeNull();
    expect(g.blockedCount).toBe(0);
    expect(g.shouldHalt).toBe(false);
  });

  it("同一条命令反复失败 → 精确重试提示（容忍工具也一样）", () => {
    const g = ctrl();
    g.afterCall("bash", { command: "ls nope" }, { error: "not found" }, false);
    const d = g.afterCall("bash", { command: "ls nope" }, { error: "not found" }, false);
    expect(d?.code).toBe("repeated_exact_failure");
  });
});

describe("周期重放（A,B,A,B…）", () => {
  it("两圈相同批次的调用 + 相同结果 → 提示", () => {
    const g = ctrl();
    const A = ["write", { path: "f.txt", content: "x" }, { ok: true }] as const;
    const B = ["read", { path: "f.txt" }, { content: "old" }] as const;
    const round = () => {
      g.afterCall(A[0], A[1], A[2], true);
      return g.afterCall(B[0], B[1], B[2], true);
    };
    round();
    const d = round();
    expect(d?.code).toBe("identical_call_cycle");
    expect(d?.count).toBeGreaterThanOrEqual(2);
  });

  it("结果变化时不判定为周期", () => {
    const g = ctrl();
    g.afterCall("write", { path: "f", content: "1" }, { ok: true }, true);
    g.afterCall("read", { path: "f" }, { content: "1" }, true);
    g.afterCall("write", { path: "f", content: "2" }, { ok: true }, true);
    expect(g.afterCall("read", { path: "f" }, { content: "2" }, true)).toBeNull();
  });
});

describe("批内去重（模型一次要了多个完全相同的只读调用）", () => {
  it("同一批次里同参数的第二个只读调用被抑制，且不计入停轮计数", () => {
    const g = ctrl();
    g.beginBatch();
    expect(g.beforeCall("read", { path: "a.txt" })).toBeNull();
    const dup = g.beforeCall("read", { path: "a.txt" });
    expect(dup?.code).toBe("duplicate_same_batch");
    expect(dup?.action).toBe("block");
    // 机械去重不算"死循环"，不推动停轮
    expect(g.blockedCount).toBe(0);
    expect(g.shouldHalt).toBe(false);
    // 参数不同、工具不同都不算重复
    expect(g.beforeCall("read", { path: "b.txt" })).toBeNull();
    expect(g.beforeCall("grep", { path: "a.txt" })).toBeNull();
  });

  it("换一个批次后重置（上一批的同名调用不影响新批次）", () => {
    const g = ctrl();
    g.beginBatch();
    expect(g.beforeCall("read", { path: "a.txt" })).toBeNull();
    g.beginBatch();
    expect(g.beforeCall("read", { path: "a.txt" })).toBeNull();
  });

  it("写类工具不做批内去重（两次写同一文件是模型的真实意图）", () => {
    const g = ctrl();
    g.beginBatch();
    expect(g.beforeCall("write", { path: "a.txt", content: "x" })).toBeNull();
    expect(g.beforeCall("write", { path: "a.txt", content: "x" })).toBeNull();
  });
});

describe("预算与停轮", () => {
  it("web_search 超过每轮上限 → 拦下；累计拦下到上限 → 应停轮", () => {
    const g = ctrl({ maxWebSearches: 2, haltAfterBlocks: 2 });
    expect(g.beforeCall("web_search", { query: "a" })).toBeNull();
    expect(g.beforeCall("web_search", { query: "b" })).toBeNull();
    const d = g.beforeCall("web_search", { query: "c" });
    expect(d?.code).toBe("web_search_cap");
    expect(d?.action).toBe("block"); // 第 1 次拦下还没到停轮线
    const d2 = g.beforeCall("web_search", { query: "d" });
    expect(d2?.action).toBe("halt"); // 达到 haltAfterBlocks
    expect(g.shouldHalt).toBe(true);
  });

  it("enabled:false 时完全不介入", () => {
    const g = ctrl({ enabled: false });
    const args = { path: "a" };
    const out = { content: "same" };
    for (let i = 0; i < 5; i++) expect(g.afterCall("read", args, out, true)).toBeNull();
    expect(g.beforeCall("read", args)).toBeNull();
  });
});
