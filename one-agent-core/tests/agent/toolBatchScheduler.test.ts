import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scheduleToolBatch,
  isFullyParallel,
  pathsOverlap,
  canonicalToolPath,
  type SchedulableToolCall,
} from "../../src/agent/index.ts";

/** 虚拟 cwd：路径无需真实存在（realpath 失败会回落到 resolve 结果，行为确定） */
const CWD = "/work";

function call(name: string, input: unknown, id = `${name}-${Math.random().toString(36).slice(2, 6)}`): SchedulableToolCall {
  return { id, name, input };
}

/** 展平段列表 → 原始调用顺序（用于断言保序） */
function flatten(segments: Array<{ calls: SchedulableToolCall[] }>): string[] {
  return segments.flatMap((s) => s.calls.map((c) => c.id));
}

describe("scheduleToolBatch", () => {
  it("三个只读工具读不同文件 → 单个并行段", () => {
    const calls = [
      call("read", { path: "a.txt" }, "c1"),
      call("read", { path: "b.txt" }, "c2"),
      call("grep", { pattern: "x", path: "src" }, "c3"),
    ];
    const segments = scheduleToolBatch(calls, { cwd: CWD });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("parallel");
    expect(flatten(segments)).toEqual(["c1", "c2", "c3"]);
    expect(isFullyParallel(calls, { cwd: CWD })).toBe(true);
  });

  it("同轮读 + 写同一文件 → 串行且保序（读先于写）", () => {
    const calls = [call("read", { path: "a.txt" }, "c1"), call("edit", { path: "a.txt" }, "c2")];
    const segments = scheduleToolBatch(calls, { cwd: CWD });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("sequential");
    expect(flatten(segments)).toEqual(["c1", "c2"]);
    expect(isFullyParallel(calls, { cwd: CWD })).toBe(false);
  });

  it("写与读交错：涉及写的重叠关闭当前段，后续无冲突的调用再从新段开始", () => {
    const calls = [
      call("read", { path: "a.txt" }, "c1"),
      call("read", { path: "b.txt" }, "c2"),
      call("edit", { path: "a.txt" }, "c3"),
      call("read", { path: "c.txt" }, "c4"),
      call("read", { path: "a.txt" }, "c5"),
    ];
    const segments = scheduleToolBatch(calls, { cwd: CWD });
    // edit a 关闭了 [c1,c2]；c4 与 edit 无冲突并入同一段；c5 又撞上 edit a → 再开新段
    expect(segments.map((s) => s.kind)).toEqual(["parallel", "parallel", "sequential"]);
    expect(segments[0]!.calls.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(segments[1]!.calls.map((c) => c.id)).toEqual(["c3", "c4"]);
    expect(segments[2]!.calls.map((c) => c.id)).toEqual(["c5"]);
    expect(flatten(segments)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("读 a + 写 b（路径不相干）→ 仍可并行", () => {
    const segments = scheduleToolBatch(
      [call("read", { path: "a.txt" }, "c1"), call("write", { path: "b.txt" }, "c2")],
      { cwd: CWD },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("parallel");
  });

  it("两次写同一文件 → 串行（避免读-改-写丢更新）", () => {
    const segments = scheduleToolBatch(
      [call("edit", { path: "a.txt" }, "c1"), call("edit", { path: "a.txt" }, "c2")],
      { cwd: CWD },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("sequential");
  });

  it("父子目录视为重叠（写父目录与读子文件冲突）", () => {
    const segments = scheduleToolBatch(
      [call("read", { path: "src/app.ts" }, "c1"), call("write", { path: "src" }, "c2")],
      { cwd: CWD },
    );
    expect(segments[0]!.kind).toBe("sequential");
    expect(flatten(segments)).toEqual(["c1", "c2"]);
  });

  it("未登记的工具（bash 等）一律是屏障", () => {
    const calls = [
      call("bash", { command: "rm -rf build" }, "c1"),
      call("read", { path: "a.txt" }, "c2"),
      call("read", { path: "b.txt" }, "c3"),
      call("edit", { path: "c.txt" }, "c4"),
    ];
    const segments = scheduleToolBatch(calls, { cwd: CWD });
    // bash 独占一段；其后的读/写无相互冲突 → 合成一个并行段
    expect(segments.map((s) => s.kind)).toEqual(["sequential", "parallel"]);
    expect(segments[0]!.calls.map((c) => c.id)).toEqual(["c1"]);
    expect(segments[1]!.calls.map((c) => c.id)).toEqual(["c2", "c3", "c4"]);
    // bash 之后的调用不会越过它 → 展平仍是原始顺序
    expect(flatten(segments)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("相邻的顺序调用合并成一个 sequential 段", () => {
    const segments = scheduleToolBatch(
      [call("bash", { command: "ls" }, "c1"), call("read", { path: "a.txt" }, "c2")],
      { cwd: CWD },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("sequential");
    expect(segments[0]!.calls.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("grep 缺省 path='.' → 与同轮读重叠但读读并行；与写则冲突", () => {
    const parallel = scheduleToolBatch(
      [call("read", { path: "a.txt" }, "c1"), call("grep", { pattern: "x" }, "c2")],
      { cwd: CWD },
    );
    expect(parallel).toHaveLength(1);
    expect(parallel[0]!.kind).toBe("parallel");

    const conflicting = scheduleToolBatch(
      [call("grep", { pattern: "x" }, "c1"), call("write", { path: "a.txt" }, "c2")],
      { cwd: CWD },
    );
    expect(conflicting[0]!.kind).toBe("sequential");
  });

  it("参数不可信（非对象 / null / 数组 / 缺少 path）→ 屏障", () => {
    const bad = [
      call("read", "a.txt", "c1"),
      call("edit", null, "c2"),
      call("write", ["a.txt"], "c3"),
      call("ls", {}, "c4"), // 无默认 path，路径未知
    ];
    const segments = scheduleToolBatch(bad, { cwd: CWD });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("sequential");
    expect(flatten(segments)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("read 支持 paths 批量（全部路径参与重叠判定）", () => {
    const segments = scheduleToolBatch(
      [
        call("read", { paths: ["a.txt", "b.txt"] }, "c1"),
        call("edit", { path: "b.txt" }, "c2"),
      ],
      { cwd: CWD },
    );
    expect(segments[0]!.kind).toBe("sequential");
  });

  it("todo 属于 parallelSafe：与只读工具同轮并行，不与写路径互相阻塞", () => {
    const calls = [
      call("todo", { todos: [{ content: "步骤" }] }, "c1"),
      call("read", { path: "a.txt" }, "c2"),
    ];
    const segments = scheduleToolBatch(calls, { cwd: CWD });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("parallel");
  });

  it("自定义表面：MCP 工具通过 tables.parallelSafe 显式 opt-in", () => {
    const calls = [
      call("mcp_fetch", { url: "u1" }, "c1"),
      call("mcp_fetch", { url: "u2" }, "c2"),
    ];
    // 默认：未登记 → 屏障 → 合并成一个 sequential 段
    const byDefault = scheduleToolBatch(calls, { cwd: CWD });
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0]!.kind).toBe("sequential");

    const optedIn = scheduleToolBatch(calls, {
      cwd: CWD,
      tables: { parallelSafe: new Set(["mcp_fetch"]) },
    });
    expect(optedIn).toHaveLength(1);
    expect(optedIn[0]!.kind).toBe("parallel");
  });

  it("单调用不规划（降级为顺序）", () => {
    expect(scheduleToolBatch([call("read", { path: "a.txt" })], { cwd: CWD })[0]!.kind).toBe("sequential");
    expect(isFullyParallel([call("read", { path: "a.txt" })], { cwd: CWD })).toBe(false);
  });

  it("任意组合下展平顺序 == 原始调用顺序", () => {
    const calls = [
      call("read", { path: "a.txt" }, "c1"),
      call("bash", { command: "ls" }, "c2"),
      call("edit", { path: "a.txt" }, "c3"),
      call("edit", { path: "a.txt" }, "c4"),
      call("read", { path: "b.txt" }, "c5"),
      call("web_search", { query: "q" }, "c6"),
      call("read", { path: "b.txt" }, "c7"),
    ];
    expect(flatten(scheduleToolBatch(calls, { cwd: CWD }))).toEqual(calls.map((c) => c.id));
  });
});

describe("路径归一与重叠", () => {
  it("相对路径按 cwd 解析，与绝对路径等价", () => {
    expect(canonicalToolPath("a.txt", CWD)).toBe(canonicalToolPath("/work/a.txt", CWD));
    expect(canonicalToolPath("./sub/../a.txt", CWD)).toBe(canonicalToolPath("/work/a.txt", CWD));
  });

  it("symlink 归一：软链接与其目标视为同一路径", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-scheduler-"));
    try {
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "link"));
      expect(canonicalToolPath(join(dir, "link"), CWD)).toBe(canonicalToolPath(join(dir, "real"), CWD));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pathsOverlap：父子算重叠，兄弟不算", () => {
    expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true);
    expect(pathsOverlap("/a/b", "/a/c")).toBe(false);
    expect(pathsOverlap("", "/a")).toBe(false);
    expect(pathsOverlap("/a/b", "/a/b")).toBe(true);
  });
});
