import type { ToolSpec } from "../../types.js";
import { calculatorTool } from "./calculator.js";
import { readLocalFileTool } from "./read_local_file.js";
import { writeLocalFileTool } from "./write_local_file.js";
import { listLocalDirTool } from "./list_local_dir.js";
import { webSearchTool } from "./web_search.js";
import { runLocalCommandTool } from "./run_local_command.js";

/** 内置工具全集（按需注册进 ToolRegistry） */
export const builtinTools: ToolSpec[] = [
  calculatorTool,
  readLocalFileTool,
  writeLocalFileTool,
  listLocalDirTool,
  webSearchTool,
  runLocalCommandTool,
];

export { calculatorTool, evaluate } from "./calculator.js";
export { readLocalFileTool } from "./read_local_file.js";
export { writeLocalFileTool } from "./write_local_file.js";
export { listLocalDirTool } from "./list_local_dir.js";
export { webSearchTool } from "./web_search.js";
export { runLocalCommandTool } from "./run_local_command.js";
