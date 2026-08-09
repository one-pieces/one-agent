import type { ToolSpec } from "../../types.ts";
import { calculatorTool } from "./calculator.ts";
import { readLocalFileTool } from "./read_local_file.ts";
import { writeLocalFileTool } from "./write_local_file.ts";
import { listLocalDirTool } from "./list_local_dir.ts";
import { webSearchTool } from "./web_search.ts";
import { runLocalCommandTool } from "./run_local_command.ts";

/** 内置工具全集（按需注册进 ToolRegistry） */
export const builtinTools: ToolSpec[] = [
  calculatorTool,
  readLocalFileTool,
  writeLocalFileTool,
  listLocalDirTool,
  webSearchTool,
  runLocalCommandTool,
];

export { calculatorTool, evaluate } from "./calculator.ts";
export { readLocalFileTool } from "./read_local_file.ts";
export { writeLocalFileTool } from "./write_local_file.ts";
export { listLocalDirTool } from "./list_local_dir.ts";
export { webSearchTool } from "./web_search.ts";
export { runLocalCommandTool } from "./run_local_command.ts";
