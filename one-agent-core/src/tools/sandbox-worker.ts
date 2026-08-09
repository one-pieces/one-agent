/**
 * 沙箱 worker：在独立线程里执行内置工具（崩溃/超时不影响主进程）。
 * 协议：workerData = { name, input }；结果通过 parentPort.postMessage 返回 ToolResult。
 */
import { parentPort, workerData } from "node:worker_threads";
import { builtinTools } from "./builtin/index.ts";

const { name, input } = workerData as { name: string; input: unknown };

const tool = builtinTools.find((t) => t.name === name);
if (!tool) {
  parentPort!.postMessage({ ok: false, output: null, error: `沙箱中找不到工具: ${name}` });
} else {
  try {
    let validated = input;
    if (tool.validateInput) {
      const v = tool.validateInput(input);
      if (!v.ok) {
        parentPort!.postMessage({ ok: false, output: null, error: v.error });
      } else {
        validated = v.value;
        const result = await tool.execute({}, validated);
        parentPort!.postMessage(result);
      }
    } else {
      const result = await tool.execute({}, validated);
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
