import type { SessionStore } from "../session/interfaces.ts";

/**
 * 任务清单（计划工件）——让计划跨轮、跨压缩、跨重启存活。
 *
 * 设计与 Hermes `tools/todo_tool.py` 的 TodoStore 对齐，关键差别是**持久化策略**：
 * - Hermes：per-AIAgent 内存 + 压缩后注入；
 * - one-agent：**轮内内存 + 收尾合并**（工具不直接写 session 记录）。
 *   原因（实施前复核结论）：首轮会话记录在 `Agent.run` 结尾才创建，工具若自建会写出空 agentId 的行；
 *   且直接写盘会与 `Agent.run` 结尾的整体保存形成读-改-写竞态。
 *   代价：中断的轮次其清单与它的消息一样不落盘（语义一致、可预测）。
 *
 * 并发：`todo` 允许与其他只读工具同批并行执行（进了调度器的 parallelSafe 表），
 * 因此同一 sessionId 的写入必须串行化（内部 promise 队列）。
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  /** 指向父项 id（可嵌套子任务）；指向不存在的父项会被丢弃 */
  parent?: string;
}

export interface TodoState {
  items: TodoItem[];
  /** 每次写入 +1（供前端/注入判断是否变化） */
  revision: number;
  updatedAt: string;
}

export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_CONTENT_CHARS = 200;
export const ACTIVE_STATUSES: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress"]);
const VALID_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"]);
const _TRUNCATION_MARKER = "…[已截断]";

export interface TodoInputItem {
  id?: string;
  content: string;
  status?: string;
  parent?: string;
}

const STATUS_MARKERS: Record<TodoStatus, string> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  cancelled: "[~]",
};

export class TodoStore {
  /** sessionId → 当前状态（轮内权威副本） */
  private cache = new Map<string, TodoState>();
  /** 本轮真正**写过**的会话（只读不产快照，避免把空清单写进 meta） */
  private dirty = new Set<string>();
  /** sessionId → 写队列（同会话写入串行化） */
  private queues = new Map<string, Promise<unknown>>();
  private readonly sessions: SessionStore;

  constructor(sessions: SessionStore) {
    this.sessions = sessions;
  }

  /** 读取当前清单（缓存命中则不查库）；不存在时返回空清单 */
  async load(sessionId: string): Promise<TodoState> {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const session = await this.sessions.getSession(sessionId);
    const raw = (session?.meta as { todos?: unknown } | undefined)?.todos;
    const state = normalizeState(raw);
    this.cache.set(sessionId, state);
    return state;
  }

  /** 读取（返回副本，调用方改不动内部状态） */
  async read(sessionId: string): Promise<TodoState> {
    return cloneState(await this.load(sessionId));
  }

  /** 写入：整表替换（默认）或按 id 合并；返回写入后的清单 */
  async write(sessionId: string, items: TodoInputItem[], opts: { merge?: boolean } = {}): Promise<TodoState> {
    return this.enqueue(sessionId, async () => {
      const current = await this.load(sessionId);
      const next = opts.merge ? mergeItems(current.items, items) : items;
      const state = normalizeState({ items: next, revision: current.revision + 1, updatedAt: new Date().toISOString() });
      this.cache.set(sessionId, state);
      this.dirty.add(sessionId);
      return cloneState(state);
    });
  }

  /**
   * 收尾快照：供 `Agent.run` 合并进 `session.meta.todos`。
   * 只有本轮**真正写过**才返回（仅读取过 → undefined），否则每个读过清单的会话都会多写一份空 todos。
   */
  snapshotForMeta(sessionId: string): TodoState | undefined {
    if (!this.dirty.has(sessionId)) return undefined;
    const cached = this.cache.get(sessionId);
    return cached ? cloneState(cached) : undefined;
  }

  /** 清空某会话的缓存（如会话被删除时） */
  forget(sessionId: string): void {
    this.cache.delete(sessionId);
    this.dirty.delete(sessionId);
    this.queues.delete(sessionId);
  }

  /**
   * 压缩后注入文本：仅未完成项（pending/in_progress），无则 null。
   * 已完成的项不注入 —— 否则模型会重做已完成的工作（Hermes 同此语义）。
   */
  async formatForInjection(sessionId: string): Promise<string | null> {
    const state = await this.load(sessionId);
    const active = state.items.filter((i) => ACTIVE_STATUSES.has(i.status));
    if (active.length === 0) return null;
    const lines = ["[你的任务清单在上下文压缩后被保留]"];
    for (const item of active) {
      lines.push(`${STATUS_MARKERS[item.status]} ${item.content}`);
    }
    return lines.join("\n");
  }

  /** 把同一会话的写入排成队列（避免并行工具调用下的读-改-写竞态） */
  private enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // 队列本身不抛错（task 的错误由调用方处理），否则后续写入会被链式拒绝
    this.queues.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

// ─── 归一：把任意输入/存量数据收敛到合法状态（对应 docs/todo-list-design.md §5） ───

export function normalizeState(raw: unknown): TodoState {
  const obj = (raw ?? {}) as { items?: unknown; revision?: unknown; updatedAt?: unknown };
  const items = Array.isArray(obj.items) ? obj.items : [];
  const normalized = normalizeItems(items as TodoInputItem[]);
  return {
    items: normalized,
    revision: typeof obj.revision === "number" && Number.isFinite(obj.revision) ? obj.revision : 0,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
  };
}

/** 合并更新：按 id 覆盖已有项，新项按输入顺序追加 */
function mergeItems(current: TodoItem[], patch: TodoInputItem[]): TodoInputItem[] {
  const byId = new Map(current.map((i) => [i.id, i]));
  const out: TodoInputItem[] = [];
  const seen = new Set<string>();
  for (const item of patch) {
    if (typeof item.id === "string" && item.id && byId.has(item.id)) {
      const prev = byId.get(item.id)!;
      out.push({ ...prev, ...item, id: prev.id } as TodoInputItem);
      seen.add(prev.id);
    } else {
      out.push(item);
    }
  }
  // merge 语义：patch 未提及的旧项保持不动（追加在后）
  for (const prev of current) if (!seen.has(prev.id)) out.push({ ...prev });
  return out;
}

function normalizeItems(items: TodoInputItem[]): TodoItem[] {
  const out: TodoItem[] = [];
  const ids = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) continue;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `todo-${out.length + 1}-${randomSuffix()}`;
    if (ids.has(id)) continue; // 同 id 后者忽略（首个为准）
    ids.add(id);
    const status = typeof raw.status === "string" && VALID_STATUSES.has(raw.status) ? (raw.status as TodoStatus) : "pending";
    const item: TodoItem = { id, content: capContent(content), status };
    if (typeof raw.parent === "string" && raw.parent.trim()) item.parent = raw.parent.trim();
    out.push(item);
  }

  // parent 完整性：悬空父项 → 丢弃 parent
  const byId = new Set(out.map((i) => i.id));
  for (const item of out) if (item.parent && !byId.has(item.parent)) delete item.parent;
  // parent 成环 → 打断成根
  breakCycles(out);

  // 单 in_progress：保留顺序最靠后的一个（最近推进），其余降级 pending；并把当前项提前到 pending 之前
  const inProgress = out.filter((i) => i.status === "in_progress");
  if (inProgress.length > 1) {
    const keep = inProgress[inProgress.length - 1]!;
    for (const item of out) if (item.status === "in_progress" && item !== keep) item.status = "pending";
  }
  sortActiveFirst(out);

  return out.slice(0, MAX_TODO_ITEMS);
}

function breakCycles(items: TodoItem[]): void {
  const parentOf = new Map(items.map((i) => [i.id, i.parent]));
  for (const item of items) {
    const seen = new Set<string>([item.id]);
    let cur = item.parent;
    while (cur) {
      if (seen.has(cur)) {
        delete item.parent; // 环 → 打断成根
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
}

/** 当前进行中的项排到所有 pending 之前（注入后模型看到的第一项就是当前步骤） */
function sortActiveFirst(items: TodoItem[]): void {
  const idx = items.findIndex((i) => i.status === "in_progress");
  if (idx <= 0) return;
  const firstPending = items.findIndex((i) => i.status === "pending");
  if (firstPending === -1 || idx < firstPending) return;
  const [active] = items.splice(idx, 1);
  items.splice(firstPending, 0, active!);
}

function capContent(content: string): string {
  if (content.length <= MAX_TODO_CONTENT_CHARS) return content;
  return content.slice(0, MAX_TODO_CONTENT_CHARS - _TRUNCATION_MARKER.length) + _TRUNCATION_MARKER;
}

function cloneState(state: TodoState): TodoState {
  return { items: state.items.map((i) => ({ ...i })), revision: state.revision, updatedAt: state.updatedAt };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
