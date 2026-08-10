import { isAbsolute, resolve } from "node:path";

/** 安全解析 JSON 片段（工具参数分片拼接后可能不完整），失败返回 {} */
export function safeParseJSON(text: string): unknown {
  if (!text || text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 去尾部斜杠，保证 baseUrl 拼接正确 */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 解析本地文件工具的相对路径：
 * - 绝对路径原样返回
 * - 相对路径以 `cwd`（工具执行上下文的工作目录）为基准 resolve；无 cwd 时回落到进程工作目录
 * 保证 agent 写文件落在会话工作区（one-agent-app/data/workspace/{sessionId}），而不是服务进程 cwd
 */
export function resolveToolPath(path: string, cwd?: string): string {
  if (isAbsolute(path)) return path;
  return resolve(cwd ?? process.cwd(), path);
}
