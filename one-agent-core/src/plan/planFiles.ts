import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * 方案文档（plan）文件操作 —— 与 todo（执行清单）配对：
 *   todo  = 给模型自己看的检查表（短、状态化、随会话 meta 持久化）
 *   plan  = 给人 review 的 markdown 方案（长、结构化、落在会话工作区里）
 * 位置：`<会话工作区>/.oneagent/plans/<YYYY-MM-DD_HHMMSS>-<slug>.md`
 * （与 Hermes 的 `.hermes/plans/` 同思路：文件即真相，重启/压缩都不丢）
 */

export const PLANS_DIR = join(".oneagent", "plans");
export const MAX_PLAN_CHARS = 200_000;

export interface PlanFile {
  /** 相对会话工作区的路径（模型用 read 直接可读） */
  path: string;
  absolutePath: string;
  updatedAt: string;
  content: string;
}

export interface WrittenPlan {
  path: string;
  absolutePath: string;
  bytes: number;
  title: string;
}

/** 生成文件名：时间戳 + 标题 slug（CJK 保留，路径不安全字符折叠为 -） */
export function planFileName(title: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ts}-${slugify(title)}.md`;
}

/** 标题 → 文件名 slug（去 markdown 标记；空白与路径不安全字符折叠为 -；上限 40 字符） */
export function slugify(title: string): string {
  const cleaned = title
    .replace(/^#+\s*/, "")
    .replace(/[*_`~[\]]/g, "")
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "plan").slice(0, 40);
}

/** 从计划正文推断标题：第一个 markdown 标题 → 第一行非空文本 → "plan" */
export function inferPlanTitle(content: string): string {
  const lines = content.split("\n").map((l) => l.trim());
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading) return heading.replace(/^#+\s*/, "").trim();
  const first = lines.find((l) => l.length > 0);
  return first ? first.slice(0, 60) : "plan";
}

/** 写入方案文档；返回相对路径（模型可 read 的路径）与字节数 */
export async function writePlanFile(
  workspaceDir: string,
  content: string,
  opts: { title?: string; now?: Date } = {},
): Promise<WrittenPlan> {
  const dir = resolve(workspaceDir, PLANS_DIR);
  await mkdir(dir, { recursive: true });
  const title = (opts.title?.trim() || inferPlanTitle(content)).slice(0, 120);
  const fileName = planFileName(title, opts.now ?? new Date());
  const absolutePath = join(dir, fileName);
  await writeFile(absolutePath, content, "utf-8");
  return {
    path: join(PLANS_DIR, fileName),
    absolutePath,
    bytes: Buffer.byteLength(content, "utf-8"),
    title,
  };
}

/** 列出方案文档（按修改时间倒序，新的在前） */
export async function listPlanFiles(workspaceDir: string): Promise<PlanFile[]> {
  const dir = resolve(workspaceDir, PLANS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // 目录不存在 = 还没有方案
  }
  const out: PlanFile[] = [];
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".md"))) {
    const absolutePath = join(dir, name);
    try {
      const [info, content] = await Promise.all([stat(absolutePath), readFile(absolutePath, "utf-8")]);
      out.push({
        path: join(PLANS_DIR, name),
        absolutePath,
        updatedAt: info.mtime.toISOString(),
        content: content.length > MAX_PLAN_CHARS ? content.slice(0, MAX_PLAN_CHARS) : content,
      });
    } catch {
      // 读不到就跳过（权限/竞态），不影响其它文件
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 最新的方案文档（无则 null）—— 压缩后注入方案路径、前端面板都用它 */
export async function findLatestPlan(workspaceDir: string): Promise<PlanFile | null> {
  return (await listPlanFiles(workspaceDir))[0] ?? null;
}

/** 防御：把绝对路径收敛到工作区内（越界返回 null） */
export function toWorkspaceRelative(workspaceDir: string, target: string): string | null {
  const root = resolve(workspaceDir);
  const abs = resolve(target);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return relative(root, abs) || ".";
}
