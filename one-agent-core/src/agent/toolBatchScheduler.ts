import { isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * 工具批调度器（tool batch scheduler）：把一个 assistant 轮里的多个 tool_call 切成**有序的并行/串行段**。
 *
 * 命名澄清：本模块只决定“已发出的调用按什么次序安全执行”，**不产生任何计划**
 * （不决定做什么、不拆解任务、不排序优先级）。Hermes 内部把这段逻辑叫 `_plan_tool_batch_segments`，
 * 但它是 dispatch 调度器，与“方案规划”（plan mode / todo / goal）无关 —— 详见 docs/planner-deep-dive.md §0。
 *
 * 动机（正确性，而非性能）：整批 `Promise.all` 在同轮出现「读同一个文件 + 写同一个文件」
 * 或「两次写同一个文件」时，执行顺序不确定 → edit 的「读-改-写」会丢更新、read 可能看到
 * 写了一半的内容。做法与 Hermes 的 `_plan_tool_batch_segments` 同构：
 *
 *   1. 准入（admit）：每个调用归类为「屏障」/「路径受限（带 isWriter）」/「无路径并行安全」；
 *   2. 路径受限的调用按归一化路径与当前段的预留路径做**重叠判定**：读读可同段，
 *      任一侧是 writer 的重叠 → 关闭当前段，让该调用从新段开始（因此批量读永远看不到半写状态）；
 *   3. 段内并行、段间串行，**保序**：后来者永不跨越先到的屏障，所以「分段执行」与「全串行执行」
 *      的副作用边界完全一致，结果按原始调用顺序回填。
 *
 * 纯函数：无 I/O 副作用（仅路径 realpath 解析）、无全局状态，可直接单测。
 */

/** 调度器需要的最小调用形状（与 types.ts 的 ToolCall 结构兼容，便于测试传普通对象） */
export interface SchedulableToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ToolCallSegmentKind = "parallel" | "sequential";

export interface ToolCallSegment<T extends SchedulableToolCall = SchedulableToolCall> {
  kind: ToolCallSegmentKind;
  calls: T[];
}

/**
 * 准入面板（全部按工具**名字**判定，与 Hermes 一致；未登记名字一律当屏障 → 保守正确）。
 * 自定义工具/MCP 工具要参与并行，通过 `ScheduleToolBatchOptions.tables` 显式 opt-in。
 */
export interface SchedulerTables {
  /** 交互类工具：必须独占，出现即屏障（当前内置工具无此类，留作扩展点） */
  neverParallel: ReadonlySet<string>;
  /** 路径受限的只读工具：与同段内其他调用做重叠判定 */
  pathScopedReaders: ReadonlySet<string>;
  /** 路径受限的写工具：与**任何**重叠路径都冲突（含与只读的重叠） */
  pathScopedWriters: ReadonlySet<string>;
  /** 无共享可变状态、无路径作用域的只读工具：可无条件并入并行段 */
  parallelSafe: ReadonlySet<string>;
}

export const DEFAULT_SCHEDULER_TABLES: SchedulerTables = {
  neverParallel: new Set<string>(),
  pathScopedReaders: new Set(["read", "grep", "find", "ls", "tree"]),
  pathScopedWriters: new Set(["write", "edit", "plan"]),
  parallelSafe: new Set(["web_search", "knowledge_search", "todo"]),
};

/** 只读工具的 path 参数缺省值（与各工具 schema 的 default 保持一致；默认指向会话工作区根） */
const READER_DEFAULT_PATHS: Record<string, string> = {
  grep: ".",
  find: ".",
  tree: ".",
};

/**
 * 写工具**派生**的作用域（参数里没有路径，写在固定位置）：plan 落在 `<cwd>/.oneagent/plans/`。
 * 用目录而不是具体文件：两次 plan 调用会因同目录重叠被串行化，而 plan 与工作区其它文件的读写互不影响。
 */
const WRITER_DEFAULT_PATHS: Record<string, string> = {
  plan: ".oneagent/plans",
};

/** 从调用参数里取出的原始路径字段名（内置工具统一用 path / paths） */
const PATH_ARGS = ["path", "paths"] as const;

export interface ScheduleToolBatchOptions {
  /** 工具相对路径的基准目录（与 ToolContext.cwd 同一个值）；缺省回落到进程 cwd */
  cwd?: string;
  /** 覆盖准入面板（浅合并到 DEFAULT_SCHEDULER_TABLES） */
  tables?: Partial<SchedulerTables>;
}

interface Admission {
  name: string;
  /** 归一化后的路径；空数组 = 无路径作用域 */
  paths: string[];
  isWriter: boolean;
}

/**
 * 调度一个工具批次 → 有序段列表。
 * 示例：`[read a, read b, edit a]` → `[{parallel:[read a, read b]}, {sequential:[edit a]}]`
 */
export function scheduleToolBatch<T extends SchedulableToolCall>(
  calls: readonly T[],
  opts: ScheduleToolBatchOptions = {},
): Array<ToolCallSegment<T>> {
  const tables: SchedulerTables = { ...DEFAULT_SCHEDULER_TABLES, ...opts.tables };
  const segments: Array<ToolCallSegment<T>> = [];
  let current: T[] = [];
  let reserved: Array<{ path: string; isWriter: boolean }> = [];

  /** 追加到 sequential 段；相邻 sequential 段自动合并（避免 [seq][seq] 碎片） */
  const extendSequential = (items: readonly T[]): void => {
    const last = segments.at(-1);
    if (last?.kind === "sequential") last.calls.push(...items);
    else segments.push({ kind: "sequential", calls: [...items] });
  };

  /** 关闭当前并行候选段：长度 >= 2 才真的并行，否则降级为顺序（单调用走顺序路径更简单） */
  const closeParallel = (): void => {
    if (current.length >= 2) segments.push({ kind: "parallel", calls: current });
    else if (current.length > 0) extendSequential(current);
    current = [];
    reserved = [];
  };

  for (const call of calls) {
    const admission = admit(call, tables, opts.cwd);
    if (admission === null) {
      // 屏障：关闭当前段并把该调用并入顺序段（后来的调用也不会越过它）
      closeParallel();
      extendSequential([call]);
      continue;
    }

    const conflicts = admission.paths.some((path) =>
      reserved.some(
        (r) => (admission.isWriter || r.isWriter) && pathsOverlap(path, r.path),
      ),
    );
    if (conflicts) closeParallel();

    for (const path of admission.paths) reserved.push({ path, isWriter: admission.isWriter });
    current.push(call);
  }

  closeParallel();
  return segments;
}

/** 整批可以一次性全并行吗？（规划结果恰好是单个 parallel 段） */
export function isFullyParallel<T extends SchedulableToolCall>(
  calls: readonly T[],
  opts: ScheduleToolBatchOptions = {},
): boolean {
  if (calls.length <= 1) return false;
  const segments = scheduleToolBatch(calls, opts);
  return segments.length === 1 && segments[0]!.kind === "parallel";
}

/** 单个调用的准入判定：null = 屏障（顺序执行），否则给出名字/路径作用域/是否写 */
function admit(
  call: SchedulableToolCall,
  tables: SchedulerTables,
  cwd?: string,
): Admission | null {
  const name = call.name;
  if (!name || tables.neverParallel.has(name)) return null;

  // 参数必须是对象（解析失败/非对象 → 路径不可信 → 屏障）
  const input = call.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const args = input as Record<string, unknown>;

  const isReader = tables.pathScopedReaders.has(name);
  const isWriter = tables.pathScopedWriters.has(name);
  if (isReader || isWriter) {
    const rawPaths = extractRawPaths(name, args, isReader);
    if (rawPaths.length === 0) return null; // 路径未知 → 不能证明安全 → 屏障
    const paths = [...new Set(rawPaths.map((p) => canonicalToolPath(p, cwd)))];
    return paths.length > 0 ? { name, paths, isWriter } : null;
  }

  // 无路径作用域的并行安全工具
  if (tables.parallelSafe.has(name)) return { name, paths: [], isWriter: false };

  // 未登记（含 bash/terminal 等作用域不可静态判定的工具、MCP 工具）：屏障
  return null;
}

/** 取调用声明的原始路径列表（path / paths 两个字段；只读工具缺省时用 schema 默认值） */
function extractRawPaths(name: string, args: Record<string, unknown>, isReader: boolean): string[] {
  const out: string[] = [];
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) out.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
  }
  if (out.length === 0) {
    const fallback = isReader ? READER_DEFAULT_PATHS[name] : WRITER_DEFAULT_PATHS[name];
    if (fallback) out.push(fallback);
  }
  return out;
}

/**
 * 归一化为可比较的绝对路径：`~` 展开 → 相对 cwd 解析 → realpath（解 symlink，不存在则保留解析结果）
 * → 去掉尾斜杠 → Windows 下小写（大小写不敏感文件系统）。
 */
export function canonicalToolPath(raw: string, cwd?: string): string {
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded);
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // 目标不存在（新建文件的 write/edit）：保留 resolve 结果即可，路径仍可比较
  }
  const trimmed = real.length > 1 ? real.replace(/[/\\]+$/, "") : real;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** 路径段前缀比较：父子目录算重叠（写父目录会影响子目录），空路径不重叠 */
export function pathsOverlap(left: string, right: string): boolean {
  const a = splitPath(left);
  const b = splitPath(right);
  const n = Math.min(a.length, b.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function splitPath(value: string): string[] {
  return value.split(sep === "\\" ? /[\\/]+/ : /\//).filter(Boolean);
}
