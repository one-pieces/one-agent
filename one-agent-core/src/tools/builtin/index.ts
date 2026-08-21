import type { ToolSpec } from "../../types.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { grepTool } from "./grep.ts";
import { findTool } from "./find.ts";
import { lsTool } from "./ls.ts";
import { treeTool } from "./tree.ts";
import { webSearchTool } from "./web_search.ts";

/**
 * 内置工具全集（按需注册进 ToolRegistry）。
 * 工具目录：read / write / edit / bash / grep / find / ls / tree / web_search
 * （bash 标记 dangerous，AgentForm 默认关闭；knowledge_search 为应用层动态工具）
 */
export const builtinTools: ToolSpec[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  findTool,
  lsTool,
  treeTool,
  webSearchTool,
];

export { readTool } from "./read.ts";
export { writeTool } from "./write.ts";
export { editTool } from "./edit.ts";
export { bashTool } from "./bash.ts";
export { grepTool } from "./grep.ts";
export { findTool } from "./find.ts";
export { lsTool } from "./ls.ts";
export { treeTool } from "./tree.ts";
export { webSearchTool } from "./web_search.ts";
