import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planTool } from "../../src/tools/builtin/plan.ts";
import { findLatestPlan, listPlanFiles, planFileName, slugify, inferPlanTitle, PLANS_DIR } from "../../src/plan/index.ts";
import { scheduleToolBatch } from "../../src/agent/index.ts";

const tmp: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oa-plan-"));
  tmp.push(dir);
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("plan 文件名与标题推断", () => {
  it("slug：CJK 保留，路径不安全字符与空白折叠为 -", () => {
    expect(slugify("重构 parser 模块")).toBe("重构-parser-模块");
    expect(slugify("## 带 标题 / 斜杠: 冒号")).toBe("带-标题-斜杠-冒号");
    expect(slugify("   ")).toBe("plan");
    expect(slugify("x".repeat(100)).length).toBe(40);
  });

  it("文件名：时间戳 + slug(.md)", () => {
    const name = planFileName("重构 parser", new Date(2026, 8, 21, 10, 20, 30));
    expect(name).toBe("2026-09-21_102030-重构-parser.md");
  });

  it("标题推断：优先第一个 markdown 标题，其次首个非空行", () => {
    expect(inferPlanTitle("# 方案 A\n\n正文")).toBe("方案 A");
    expect(inferPlanTitle("没有标题\n第二行")).toBe("没有标题");
    expect(inferPlanTitle("\n\n")).toBe("plan");
  });
});

describe("plan 工具", () => {
  it("写入 → 落到 .oneagent/plans/，返回可 read 的相对路径", async () => {
    const cwd = workspace();
    const r = await planTool.execute!({ cwd }, { content: "# 重构方案\n\n1. 改 tokenize\n2. 补测试\n" });
    expect(r.ok).toBe(true);
    const out = r.output as { path: string; title: string; bytes: number };
    expect(out.path.startsWith(PLANS_DIR)).toBe(true);
    expect(out.path.endsWith(".md")).toBe(true);
    expect(out.title).toBe("重构方案");
    expect(out.bytes).toBeGreaterThan(0);
    // 文件真的写进去了，且内容一致
    expect(existsSync(join(cwd, out.path))).toBe(true);
    expect(readFileSync(join(cwd, out.path), "utf-8")).toContain("改 tokenize");
  });

  it("无参数 = 读取最新方案；没有方案时明确告知", async () => {
    const cwd = workspace();
    const empty = await planTool.execute!({ cwd }, {});
    expect(empty.ok).toBe(true);
    expect((empty.output as { plan: unknown }).plan).toBeNull();

    await planTool.execute!({ cwd }, { content: "# 方案一\n内容一" });
    await sleep(12); // 让 mtime 拉开
    const second = await planTool.execute!({ cwd }, { content: "# 方案二\n内容二" });
    const secondPath = (second.output as { path: string }).path;

    const read = await planTool.execute!({ cwd }, {});
    const plan = (read.output as { plan: { path: string; content: string } }).plan;
    expect(plan.path).toBe(secondPath);
    expect(plan.content).toContain("方案二");
  });

  it("title 显式指定时用它命名，而不是正文首行", async () => {
    const cwd = workspace();
    const r = await planTool.execute!({ cwd }, { content: "# 正文标题", title: "显式标题" });
    expect((r.output as { path: string }).path).toContain("显式标题");
  });

  it("只给 title 不给 content → 明确报错（不静默走读分支）", async () => {
    const cwd = workspace();
    const r = await planTool.execute!({ cwd }, { title: "只有标题" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("content");
    expect(await findLatestPlan(cwd)).toBeNull(); // 没有产生文件
  });

  it("缺少工作目录（ctx.cwd）→ ok:false，不抛错", async () => {
    const r = await planTool.execute!({}, { content: "# x" });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("cwd");
  });

  it("内容超过上限 → 入参校验拒绝（zod 层）", async () => {
    const cwd = workspace();
    const validate = planTool.validateInput!({ content: "x".repeat(200_001) });
    expect(validate.ok).toBe(false);
  });

  it("listPlanFiles/findLatestPlan：只认 .md，按更新时间倒序", async () => {
    const cwd = workspace();
    const dir = join(cwd, PLANS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-01-01_000000-old.md"), "# old", "utf-8");
    await writeFile(join(dir, "notes.txt"), "忽略我", "utf-8");
    await sleep(12);
    await writeFile(join(dir, "2026-01-02_000000-new.md"), "# new", "utf-8");

    const files = await listPlanFiles(cwd);
    expect(files.map((f) => f.path.endsWith("new.md"))).toEqual([true, false]);
    expect((await findLatestPlan(cwd))!.content).toContain("new");
    expect(await listPlanFiles(join(cwd, "不存在的目录"))).toEqual([]);
  });
});

describe("调度器对 plan 的作用域判定", () => {
  const CWD = "/work";
  const call = (name: string, input: unknown, id = name) => ({ id, name, input });

  it("plan 派生作用域 = .oneagent/plans：两次 plan 串行、plan 与无关文件读并行", () => {
    const twoPlans = scheduleToolBatch(
      [call("plan", { content: "A" }, "c1"), call("plan", { content: "B" }, "c2")],
      { cwd: CWD },
    );
    expect(twoPlans[0]!.kind).toBe("sequential");

    const planPlusRead = scheduleToolBatch(
      [call("plan", { content: "A" }, "c1"), call("read", { path: "src/a.ts" }, "c2")],
      { cwd: CWD },
    );
    expect(planPlusRead[0]!.kind).toBe("parallel");
  });

  it("plan 与工作区根的读（grep 缺省 path=.）冲突 → 串行", () => {
    const segments = scheduleToolBatch(
      [call("grep", { pattern: "x" }, "c1"), call("plan", { content: "A" }, "c2")],
      { cwd: CWD },
    );
    expect(segments[0]!.kind).toBe("sequential");
  });
});

process.on("exit", () => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});
