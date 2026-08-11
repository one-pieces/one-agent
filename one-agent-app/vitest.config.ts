import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * app 测试专用配置：
 * 将 @one-agent/core 解析到真实源码（../one-agent-core/src），而不是 node_modules/.pnpm 里的
 * file: 副本。原因：core 的 sandbox worker 用 `new Worker(new URL("./sandbox-worker.ts", import.meta.url))`
 * 加载 TS 源码，Node 26 的原生 type-stripping 拒绝 node_modules 下的 .ts；
 * 解析到真实路径后 worker 文件不在 node_modules 下，可正常加载。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@one-agent/core": fileURLToPath(new URL("../one-agent-core/src/index.ts", import.meta.url)),
    },
  },
});
