/**
 * 沙箱 worker：在独立线程里执行内置工具（崩溃/超时不影响主进程）。
 * 协议：workerData = { name, input, cwd }；结果通过 parentPort.postMessage 返回 ToolResult。
 * 注意：仅线程级隔离（进程不共享内存状态、崩溃/超时隔离），不限制文件系统访问。
 */
import { parentPort, workerData } from "node:worker_threads";
import { builtinTools } from "./builtin/index.ts";

const { name, input, cwd } = workerData as { name: string; input: unknown; cwd?: string };

const tool = builtinTools.find((t) => t.name === name);
if (!tool) {
  parentPort!.postMessage({ ok: false, output: null, error: `沙箱中找不到工具: ${name}` });
} else {
  const ctx = { cwd };
  try {
    let validated = input;
    if (tool.validateInput) {
      const v = tool.validateInput(input);
      if (!v.ok) {
        parentPort!.postMessage({ ok: false, output: null, error: v.error });
      } else {
        validated = v.value;
        const result = await tool.execute(ctx, validated);
        parentPort!.postMessage(result);
      }
    } else {
      const result = await tool.execute(ctx, validated);
      parentPort!.postMessage(result);
    }
  } catch (err) {
    parentPort!.postMessage({
      ok: false,
      output: null,
      error: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
